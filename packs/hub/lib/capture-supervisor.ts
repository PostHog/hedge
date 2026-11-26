import { closeSync, writeSync } from "node:fs";
import { discoverTargets, discoverTargetsLinux, discoverTargetsSync, drainControlFd, enableChildSubreaper, graceMs, interruptGraceMs, killDeadSession, ownTag, type OwnGroupChild, probeGraceEnvVar, readFdChunk, recordSparedProcess, redirectStdioOutputsToNull, removeSpareFile, setCloexec, shieldGroupSignals, signalTargets, spareEnvVar, spareFilePath, spawnInOwnGroup, type StopSignal, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartConfig = { argv: string[]; env?: Record<string, string>; envEntries?: Array<[string, string]>; spareTag?: string; spareHome?: string };

enableChildSubreaper();
shieldGroupSignals();

const inlineConfigRaw = process.env.HEDGE_CAPTURE_CONFIG;
delete process.env.HEDGE_CAPTURE_CONFIG;

const runTag = ownTag(process.env[tagEnvVar]);
const inProbe = (process.env[tagEnvVar] ?? "").split(",").some((part) => part.trim().startsWith("probe-"));
const inheritedSpare = Boolean(process.env[spareEnvVar]);
const stopSignalsSet = new Set<StopSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const rawProbeGrace = Number(process.env[probeGraceEnvVar]);
const probeGraceMs = Number.isFinite(rawProbeGrace) && rawProbeGrace >= 0 ? rawProbeGrace : graceMs;
let sparePath = process.env[spareEnvVar];
let target: OwnGroupChild | ReturnType<typeof Bun.spawn> | undefined;
let targetPid: number | undefined;
let targetDetached = false;
let targetReaped = false;
let targetCode: number | undefined;
let confirmedDone = false;
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

const discoverAllSync = () => {
  const pids = new Set<number>();
  const sids = new Set<number>();
  const selfFound = discoverTargetsSync(process.pid, runTag, undefined, sparePath);
  if (selfFound) {
    for (const p of selfFound.pids) pids.add(p);
    for (const s of selfFound.sids ?? []) sids.add(s);
    if (selfFound.hasSessionGroup || selfFound.pids.length > 0) sids.add(process.pid);
  }
  if (targetDetached && targetPid !== undefined) {
    const targetFound = discoverTargetsSync(targetPid, undefined, targetReaped ? true : undefined, sparePath);
    if (targetFound) {
      for (const p of targetFound.pids) pids.add(p);
      for (const s of targetFound.sids ?? []) sids.add(s);
      if (targetFound.hasSessionGroup) sids.add(targetPid);
    }
  }
  return { pids: [...pids], sids: [...sids] };
};

const hasSurvivingTarget = async (): Promise<boolean> => {
  const selfTargets = await discoverTargets(process.pid, runTag, sparePath, false);
  if (!selfTargets || selfTargets.pids.length > 0) return true;
  if (targetDetached && targetPid !== undefined) {
    const tTargets = await discoverTargets(targetPid, undefined, sparePath, false);
    if (!tTargets || tTargets.pids.length > 0) return true;
  }
  return false;
};

const applyMergedSignal = (
  selfTargets: { pids: number[]; groups: number[]; orphanPids: number[] } | undefined,
  targetTargets: { pids: number[]; groups: number[]; orphanPids: number[]; hasSessionGroup?: boolean; leaderSeenLive?: boolean } | undefined,
  sig: NodeJS.Signals,
  removeOwnSpare: boolean,
) => {
  if (removeOwnSpare && !inheritedSpare && sparePath) removeSpareFile(sparePath);
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

const signalBoth = (sig: NodeJS.Signals, removeOwnSpare = false): void | Promise<void> => {
  if (process.platform === "linux") {
    const selfTargets = discoverTargetsLinux(process.pid, runTag, undefined, sparePath);
    const targetTargets = targetDetached && targetPid !== undefined && !targetReaped ? discoverTargetsLinux(targetPid, undefined, undefined, sparePath) : undefined;
    applyMergedSignal(selfTargets, targetTargets, sig, removeOwnSpare);
    if (targetDetached && targetPid !== undefined && targetReaped && sig === "SIGKILL") {
      killDeadSession(targetPid, undefined, true, sparePath);
    }
    return;
  }
  return Promise.all([
    discoverTargets(process.pid, runTag, sparePath),
    targetDetached && targetPid !== undefined && !targetReaped ? discoverTargets(targetPid, undefined, sparePath) : Promise.resolve(undefined),
  ]).then(async ([selfTargets, targetTargets]) => {
    applyMergedSignal(selfTargets, targetTargets, sig, removeOwnSpare);
    if (targetDetached && targetPid !== undefined && targetReaped && sig === "SIGKILL") {
      await killDeadSession(targetPid, undefined, true, sparePath);
    }
  });
};

const exitDone = () => {
  clearGraceTimers();
  if (inheritedSpare && sparePath) {
    const found = discoverAllSync();
    if (found.pids.length || found.sids.length) {
      const saved = recordSparedProcess(sparePath, found.pids, found.sids);
      if (!saved.ok) {
        if (ipcFd !== undefined) writeResult(ipcFd, { spareError: saved.error, ...(saved.code ? { code: saved.code } : {}) });
        process.exit(1);
      }
    }
    if (ipcFd !== undefined) writeResult(ipcFd, { saved: true });
  } else if (!inheritedSpare && sparePath) {
    removeSpareFile(sparePath);
  }
  process.exit(targetCode ?? 0);
};

const killAll = (removeOwnSpare = false) => {
  clearGraceTimers();
  if (killing) return;
  killing = true;
  const finish = () => {
    if (target && !targetReaped) {
      try {
        target.kill("SIGKILL");
      } catch {}
    }
    process.exit(137);
  };
  const done = signalBoth("SIGKILL", removeOwnSpare);
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
        killAll(false);
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
          killAll(false);
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

const closeQuiet = (fd: number) => {
  try {
    closeSync(fd);
  } catch {}
};

const writeResult = (
  fd: number,
  payload: { spareFile: string } | { code: number } | { error: string; code?: string } | { saved: true } | { spareError: string; code?: string },
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
          killAll(false);
          return true;
        }
        if (line === "done") {
          confirmedDone = true;
          exitDone();
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
      if (confirmedDone) exitDone();
      if (gracefulSignal) {
        if (targetReaped) {
          void hasSurvivingTarget().then((alive) => {
            if (!killing && !alive) {
              clearGraceTimers();
              process.exit(targetCode ?? 0);
            }
          });
        }
        return;
      }
      if (lockCount > 0 && !targetReaped && !inProbe) {
        if (!inheritedSpare && sparePath) removeSpareFile(sparePath);
        process.exit(0);
      }
      killAll(true);
    }
  })();
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
if (lockCount > 0 && !inProbe && inheritedSpare && sparePath) {
  recordSparedProcess(sparePath, [process.pid], [process.pid]);
}

setCloexec(ipcFd, true);
if (configFd !== undefined) setCloexec(configFd, true);

const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
const drained = drainControlFd(ipcFd);
if (drained.closed || drained.lines.includes("kill") || drained.lines.some((line) => line.startsWith("grace:") || line.startsWith("sig:"))) {
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  process.exit(137);
}
if (drained.lines.includes("done")) {
  confirmedDone = true;
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
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
  const { argv, env, envEntries, spareTag, spareHome } = parsed;
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
  if (!sparePath && typeof spareTag === "string" && spareTag) {
    sparePath = spareFilePath(spareTag, typeof spareHome === "string" && spareHome ? spareHome : undefined);
    writeResult(ipcFd, { spareFile: sparePath });
    if (!targetEnv) {
      targetEnv = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) targetEnv[k] = v;
    }
    targetEnv[spareEnvVar] = sparePath;
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
        process.exit(code);
      }
    } else {
      writeResult(ipcFd, { code });
    }
  }
}
