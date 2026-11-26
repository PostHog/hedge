import { closeSync, writeSync } from "node:fs";
import { discoverTargets, discoverTargetsLinux, discoverTargetsSync, drainControlFd, emptySpared, enableChildSubreaper, graceMs, interruptGraceMs, killDeadSession, mergeSpared, ownTag, type OwnGroupChild, probeGraceEnvVar, readFdChunk, redirectStdioOutputsToNull, reportSpared, setCloexec, shieldGroupSignals, signalTargets, spareEnvVar, spawnInOwnGroup, startSpareServer, type StopSignal, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartConfig = { argv: string[]; env?: Record<string, string>; envEntries?: Array<[string, string]> };

enableChildSubreaper();
shieldGroupSignals();

const inlineConfigRaw = process.env.HEDGE_CAPTURE_CONFIG;
delete process.env.HEDGE_CAPTURE_CONFIG;

const runTag = ownTag(process.env[tagEnvVar]);
const inProbe = (process.env[tagEnvVar] ?? "").split(",").some((part) => part.trim().startsWith("probe-"));
const inheritedSpare = process.env[spareEnvVar] || undefined;
const stopSignalsSet = new Set<StopSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const rawProbeGrace = Number(process.env[probeGraceEnvVar]);
const probeGraceMs = Number.isFinite(rawProbeGrace) && rawProbeGrace >= 0 ? rawProbeGrace : graceMs;
const localSpared = emptySpared();
let target: OwnGroupChild | ReturnType<typeof Bun.spawn> | undefined;
let targetPid: number | undefined;
let targetDetached = false;
let targetReaped = false;
let targetCode: number | undefined;
let confirmedDone = false;
let exitingDone = false;
let killing = false;
let lockCount = 0;
let gracefulSignal: StopSignal | undefined;
let interruptTimer: ReturnType<typeof setTimeout> | undefined;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
const receivedSignals = new Set<StopSignal>();

const clearGraceTimers = () => {
  if (interruptTimer) {
    clearTimeout(interruptTimer);
    interruptTimer = undefined;
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
};

const closeQuiet = (fd: number) => {
  try {
    closeSync(fd);
  } catch {}
};

const writeResult = (
  fd: number,
  payload: { spare: { pids: number[]; sids: number[] } } | { code: number } | { error: string; code?: string } | { saved: true } | { spareError: string; code?: string },
) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload) + "\n");
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {}
};

const parseFd = (raw: string | undefined, min: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : undefined;
};

const parsedLockCount = parseFd(Bun.argv[2], 0);
const ipcFd = parseFd(Bun.argv[3], 3);
const configFd = Bun.argv[4] && Bun.argv[4] !== "-" ? parseFd(Bun.argv[4], 3) : undefined;
if (parsedLockCount === undefined || ipcFd === undefined) {
  process.exit(127);
}
lockCount = parsedLockCount;

const spareServer = startSpareServer(async (pids, sids) => {
  mergeSpared(localSpared, pids, sids);
  writeResult(ipcFd, { spare: { pids, sids } });
  if (inheritedSpare) {
    const fwd = await reportSpared(inheritedSpare, pids, sids);
    return fwd.ok;
  }
  return true;
});

const discoverAllSync = () => {
  const pids = new Set<number>();
  const sids = new Set<number>();
  const selfFound = discoverTargetsSync(process.pid, runTag, undefined, localSpared);
  if (selfFound) {
    for (const p of selfFound.pids) pids.add(p);
    for (const s of selfFound.sids ?? []) sids.add(s);
    if (selfFound.hasSessionGroup || selfFound.pids.length > 0) sids.add(process.pid);
  }
  if (targetDetached && targetPid !== undefined) {
    const targetFound = discoverTargetsSync(targetPid, undefined, targetReaped ? true : undefined, localSpared);
    if (targetFound) {
      for (const p of targetFound.pids) pids.add(p);
      for (const s of targetFound.sids ?? []) sids.add(s);
      if (targetFound.hasSessionGroup) sids.add(targetPid);
    }
  }
  return { pids: [...pids], sids: [...sids] };
};

const hasSurvivingTarget = async (): Promise<boolean> => {
  const selfTargets = await discoverTargets(process.pid, runTag, localSpared, false);
  if (!selfTargets || selfTargets.pids.length > 0) return true;
  if (targetDetached && targetPid !== undefined) {
    const tTargets = await discoverTargets(targetPid, undefined, localSpared, false);
    if (!tTargets || tTargets.pids.length > 0) return true;
  }
  return false;
};

const applyMergedSignal = (
  selfTargets: { pids: number[]; groups: number[]; orphanPids: number[] } | undefined,
  targetTargets: { pids: number[]; groups: number[]; orphanPids: number[]; hasSessionGroup?: boolean; leaderSeenLive?: boolean } | undefined,
  sig: NodeJS.Signals,
) => {
  const groups = new Set<number>();
  const orphanPids = new Set<number>();
  const addTargets = (found: { groups: number[]; orphanPids: number[] } | undefined) => {
    if (!found) return;
    for (const g of found.groups) if (g !== process.pid) groups.add(g);
    for (const p of found.orphanPids) if (p !== process.pid) orphanPids.add(p);
  };
  addTargets(targetTargets);
  addTargets(selfTargets);
  if (targetPid !== undefined && !targetReaped) groups.add(targetPid);
  signalTargets({ pids: [], groups: [...groups], orphanPids: [...orphanPids] }, sig, undefined);
};

const signalBoth = (sig: NodeJS.Signals): void | Promise<void> => {
  if (process.platform === "linux") {
    const selfTargets = discoverTargetsLinux(process.pid, runTag, undefined, localSpared);
    const targetTargets = targetDetached && targetPid !== undefined && !targetReaped ? discoverTargetsLinux(targetPid, undefined, undefined, localSpared) : undefined;
    applyMergedSignal(selfTargets, targetTargets, sig);
    if (targetDetached && targetPid !== undefined && targetReaped && sig === "SIGKILL") {
      killDeadSession(targetPid, undefined, true, localSpared);
    }
    return;
  }
  return Promise.all([
    discoverTargets(process.pid, runTag, localSpared),
    targetDetached && targetPid !== undefined && !targetReaped ? discoverTargets(targetPid, undefined, localSpared) : Promise.resolve(undefined),
  ]).then(async ([selfTargets, targetTargets]) => {
    applyMergedSignal(selfTargets, targetTargets, sig);
    if (targetDetached && targetPid !== undefined && targetReaped && sig === "SIGKILL") {
      await killDeadSession(targetPid, undefined, true, localSpared);
    }
  });
};

const exitDone = async () => {
  if (exitingDone) return;
  exitingDone = true;
  clearGraceTimers();
  spareServer?.close();
  if (inheritedSpare) {
    const found = discoverAllSync();
    if (found.pids.length || found.sids.length) {
      const saved = await reportSpared(inheritedSpare, found.pids, found.sids);
      if (!saved.ok) {
        writeResult(ipcFd, { spareError: saved.error });
        process.exit(1);
      }
    }
    writeResult(ipcFd, { saved: true });
  }
  process.exit(targetCode ?? 0);
};

const killAll = () => {
  clearGraceTimers();
  if (killing) return;
  killing = true;
  spareServer?.close();
  const finish = () => {
    if (target && !targetReaped) {
      try {
        target.kill("SIGKILL");
      } catch {}
    }
    process.exit(137);
  };
  const done = signalBoth("SIGKILL");
  if (done && typeof (done as Promise<void>).then === "function") {
    void (done as Promise<void>).finally(finish);
    return;
  }
  finish();
};

const armGraceful = (sig: StopSignal) => {
  if (killing || confirmedDone) return;
  gracefulSignal = sig;
  receivedSignals.add(sig);
  if (sig === "SIGTERM" || sig === "SIGHUP") {
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      interruptTimer = undefined;
    }
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        killAll();
      }, probeGraceMs + 100);
    }
    return;
  }
  if (!interruptTimer && !graceTimer) {
    interruptTimer = setTimeout(() => {
      interruptTimer = undefined;
      if (killing || confirmedDone) return;
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          killAll();
        }, probeGraceMs + 100);
      }
    }, interruptGraceMs);
  }
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => {
    if (inProbe) armGraceful(sig);
    else receivedSignals.add(sig);
  });
}

let readingControl = false;

const watchControl = (fd: number, initialBuf = "") => {
  if (readingControl) return;
  readingControl = true;
  void (async () => {
    try {
      const decoder = new TextDecoder();
      const chunk = new Uint8Array(256);
      let buf = initialBuf;
      const handleLine = (line: string): boolean => {
        if (line === "kill") {
          killAll();
          return true;
        }
        if (line === "done") {
          confirmedDone = true;
          void exitDone();
          return true;
        }
        if (line.startsWith("grace:") || line.startsWith("sig:")) {
          const sig = line.slice(line.indexOf(":") + 1) as StopSignal;
          if (stopSignalsSet.has(sig)) armGraceful(sig);
        }
        return false;
      };
      for (;;) {
        const n = await readFdChunk(fd, chunk);
        if (n <= 0) break;
        buf += decoder.decode(chunk.subarray(0, n), { stream: true });
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          if (handleLine(buf.slice(0, nl).trim())) return;
          buf = buf.slice(nl + 1);
        }
      }
      if (handleLine(buf.trim())) return;
    } catch {}
    if (!killing) {
      if (confirmedDone) {
        void exitDone();
        return;
      }
      if (gracefulSignal) {
        if (targetReaped) {
          void hasSurvivingTarget().then((alive) => {
            if (!killing && !alive) {
              clearGraceTimers();
              spareServer?.close();
              process.exit(targetCode ?? 0);
            }
          });
        }
        return;
      }
      if (lockCount > 0 && !targetReaped && !inProbe) {
        spareServer?.close();
        process.exit(0);
      }
      killAll();
    }
  })();
};

if (lockCount > 0 && !inProbe && inheritedSpare) {
  await reportSpared(inheritedSpare, [process.pid], [process.pid]);
}

setCloexec(ipcFd, true);
if (configFd !== undefined) setCloexec(configFd, true);

const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
const drained = drainControlFd(ipcFd);
if (drained.closed || drained.lines.includes("kill") || drained.lines.some((line) => line.startsWith("grace:") || line.startsWith("sig:"))) {
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  spareServer?.close();
  process.exit(137);
}
if (drained.lines.includes("done")) {
  confirmedDone = true;
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  spareServer?.close();
  process.exit(0);
}
watchControl(ipcFd, drained.rest);

let parsed: StartConfig | undefined;
try {
  const rawConfig = configFd !== undefined ? await Bun.file(configFd).text() : (inlineConfigRaw ?? "");
  if (configFd !== undefined) closeQuiet(configFd);
  if (rawConfig.trim()) {
    const candidate = JSON.parse(rawConfig) as StartConfig;
    if (candidate && typeof candidate === "object" && Array.isArray(candidate.argv)) parsed = candidate;
  }
} catch {
  if (configFd !== undefined) closeQuiet(configFd);
}

if (!parsed || killing || gracefulSignal) {
  for (const fd of lockFds) closeQuiet(fd);
  redirectStdioOutputsToNull();
  killAll();
} else {
  const { argv, env, envEntries } = parsed;
  let targetEnv: Record<string, string> | undefined;
  if (Array.isArray(envEntries)) {
    targetEnv = Object.create(null) as Record<string, string>;
    for (const [k, v] of envEntries) targetEnv[k] = v;
  } else if (env && typeof env === "object") {
    targetEnv = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") targetEnv[k] = v;
    }
  }
  const childSpareEndpoint = spareServer?.endpoint ?? inheritedSpare;
  if (childSpareEndpoint) {
    if (!targetEnv) {
      targetEnv = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) targetEnv[k] = v;
    }
    targetEnv[spareEnvVar] = childSpareEndpoint;
  }
  const stdio: [number, number, number, ...number[]] = [0, 1, 2, ...lockFds];
  try {
    const grouped = spawnInOwnGroup(argv, targetEnv);
    if (grouped) {
      target = grouped;
      targetDetached = false;
    } else {
      target = Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio, detached: true });
      targetDetached = true;
    }
    targetPid = target.pid;
  } catch (error) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    spareServer?.close();
    targetReaped = true;
    targetCode = 127;
    const err = error as NodeJS.ErrnoException;
    writeResult(ipcFd, { error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    process.exit(127);
  }
  if (target) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    const code = await target.exited;
    targetReaped = true;
    targetCode = code;
    if (gracefulSignal) {
      writeResult(ipcFd, { code });
      const alive = await hasSurvivingTarget();
      if (!killing && !alive) {
        clearGraceTimers();
        spareServer?.close();
        process.exit(code);
      }
    } else {
      writeResult(ipcFd, { code });
    }
  }
}
