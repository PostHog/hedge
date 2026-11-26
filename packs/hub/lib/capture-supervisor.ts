import { closeSync, writeSync } from "node:fs";
import { bunScript } from "../../../src/runner/bun.ts";
import { createPipe, discoverTargets, discoverTargetsLinux, discoverTargetsSync, drainControlFd, emptySpared, enableChildSubreaper, graceMs, interruptGraceMs, killDeadSession, killDeadSessionSync, killTargetSessionSync, mergeSpared, ownTag, type PidIdentity, pidIdentityNow, probeGraceEnvVar, probeResultReported, type ProcTargets, readFdChunk, redirectAllStdioToNull, redirectStdioOutputsToNull, reportSpared, setCloexec, shieldGroupSignals, signalDeadTargets, signalTargets, spareEnvVar, startSpareServer, type StopSignal, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartConfig = {
  argv: string[];
  env?: Record<string, string>;
  envEntries?: Array<[string, string]>;
  injectedTag?: string;
  injectedSpare?: string;
  preserveEmptyEnv?: boolean;
  callerTag?: string;
  callerSpare?: string;
};

enableChildSubreaper();
shieldGroupSignals();

const closeQuiet = (fd: number) => {
  try {
    closeSync(fd);
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

const runTag = ownTag(process.env[tagEnvVar]);

if (process.platform === "linux" && Bun.argv[5] !== "inner") {
  const holderAlive = createPipe();
  const innerDone = createPipe();
  const innerMeta = createPipe();
  if (holderAlive && innerDone && innerMeta) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, () => {});
    setCloexec(holderAlive.writeFd, true);
    setCloexec(innerDone.readFd, true);
    setCloexec(innerMeta.readFd, true);
    const lockFds = Array.from({ length: parsedLockCount }, (_, index) => index + 3);
    const extraStdio: number[] = [...lockFds, ipcFd, ...(configFd !== undefined ? [configFd] : [])];
    const holderAliveIdx = 3 + extraStdio.length;
    extraStdio.push(holderAlive.readFd);
    const innerDoneIdx = 3 + extraStdio.length;
    extraStdio.push(innerDone.writeFd);
    const innerMetaIdx = 3 + extraStdio.length;
    extraStdio.push(innerMeta.writeFd);
    for (const fd of extraStdio) setCloexec(fd, false);
    let inner: ReturnType<typeof Bun.spawn> | undefined;
    try {
      inner = Bun.spawn(
        bunScript(
          import.meta.filename,
          String(parsedLockCount),
          String(ipcFd),
          configFd !== undefined ? String(configFd) : "-",
          "inner",
          String(holderAliveIdx),
          String(innerDoneIdx),
          String(innerMetaIdx),
        ),
        { stdio: [0, 1, 2, ...extraStdio], env: process.env, detached: true },
      );
    } catch {
      closeQuiet(holderAlive.readFd);
      closeQuiet(holderAlive.writeFd);
      closeQuiet(innerDone.readFd);
      closeQuiet(innerDone.writeFd);
      closeQuiet(innerMeta.readFd);
      closeQuiet(innerMeta.writeFd);
    }
    if (inner) {
      for (const fd of [...lockFds, ipcFd, ...(configFd !== undefined ? [configFd] : []), holderAlive.readFd, innerDone.writeFd, innerMeta.writeFd]) {
        closeQuiet(fd);
      }
      redirectAllStdioToNull();
      const holderSpared = emptySpared();
      let holderTargetPid: number | undefined;
      let holderTargetStartTime: string | undefined;
      const metaPump = (async () => {
        const reader = Bun.file(innerMeta.readFd).stream().getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const handleLine = (line: string) => {
          if (!line) return;
          try {
            const msg = JSON.parse(line) as {
              spare?: { pids?: unknown; sids?: unknown };
              targetPid?: unknown;
              targetStartTime?: unknown;
            };
            if (msg.spare) {
              const pids = Array.isArray(msg.spare.pids) ? msg.spare.pids.filter((v): v is number => typeof v === "number") : [];
              const sids = Array.isArray(msg.spare.sids) ? msg.spare.sids.filter((v): v is number => typeof v === "number") : [];
              mergeSpared(holderSpared, pids, sids);
            }
            if (typeof msg.targetPid === "number" && msg.targetPid > 0) {
              holderTargetPid = msg.targetPid;
              if (typeof msg.targetStartTime === "string" && msg.targetStartTime) holderTargetStartTime = msg.targetStartTime;
            }
          } catch {}
        };
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buf += decoder.decode(value, { stream: true });
            for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
              handleLine(buf.slice(0, nl).trim());
              buf = buf.slice(nl + 1);
            }
          }
          if (buf.trim()) handleLine(buf.trim());
        } catch {
        } finally {
          await reader.cancel().catch(() => {});
        }
      })();
      const code = await inner.exited;
      await metaPump;
      const reported = probeResultReported(innerDone.readFd) === "reported";
      closeQuiet(innerDone.readFd);
      closeQuiet(innerMeta.readFd);
      closeQuiet(holderAlive.writeFd);
      if (reported) {
        process.exit(inner.signalCode ? 137 : code);
      }
      killDeadSessionSync(inner.pid, runTag, true, holderSpared);
      if (holderTargetPid !== undefined) {
        killTargetSessionSync(holderTargetPid, holderTargetStartTime, runTag, holderSpared);
      }
      const adopted = discoverTargetsLinux(process.pid, runTag, undefined, holderSpared);
      signalDeadTargets(adopted, process.pid, undefined, runTag, holderSpared);
      process.exit(inner.signalCode ? 137 : code);
    }
  } else {
    if (holderAlive) {
      closeQuiet(holderAlive.readFd);
      closeQuiet(holderAlive.writeFd);
    }
    if (innerDone) {
      closeQuiet(innerDone.readFd);
      closeQuiet(innerDone.writeFd);
    }
    if (innerMeta) {
      closeQuiet(innerMeta.readFd);
      closeQuiet(innerMeta.writeFd);
    }
  }
}

const holderAliveFd = Bun.argv[5] === "inner" ? parseFd(Bun.argv[6], 3) : undefined;
const innerDoneFd = Bun.argv[5] === "inner" ? parseFd(Bun.argv[7], 3) : undefined;
const innerMetaFd = Bun.argv[5] === "inner" ? parseFd(Bun.argv[8], 3) : undefined;
if (holderAliveFd !== undefined) setCloexec(holderAliveFd, true);
if (innerDoneFd !== undefined) setCloexec(innerDoneFd, true);
if (innerMetaFd !== undefined) setCloexec(innerMetaFd, true);

let innerDoneMarked = false;
const markInnerDone = () => {
  if (innerDoneMarked) return;
  innerDoneMarked = true;
  if (innerDoneFd !== undefined) {
    try {
      writeSync(innerDoneFd, "1\n");
    } catch {}
    closeQuiet(innerDoneFd);
  }
  if (innerMetaFd !== undefined) closeQuiet(innerMetaFd);
};

const inlineConfigRaw = process.env.HEDGE_CAPTURE_CONFIG;
delete process.env.HEDGE_CAPTURE_CONFIG;

const inProbe = (process.env[tagEnvVar] ?? "").split(",").some((part) => part.trim().startsWith("probe-")) || Boolean(process.env[probeGraceEnvVar]);
const inheritedSpare = process.env[spareEnvVar] || undefined;
const stopSignalsSet = new Set<StopSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const rawProbeGrace = Number(process.env[probeGraceEnvVar]);
const probeGraceMs = Number.isFinite(rawProbeGrace) && rawProbeGrace >= 0 ? rawProbeGrace : graceMs;
const localSpared = emptySpared();
let target: ReturnType<typeof Bun.spawn> | undefined;
let targetPid: number | undefined;
let targetIdentity: PidIdentity | undefined;
let targetDetached = true;
let targetReaped = false;
let targetCode: number | undefined;
let confirmedDone = false;
let exitingDone = false;
let killing = false;
let lockCount = parsedLockCount;
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

const writeResult = (
  fd: number,
  payload:
    | { spare: { pids: number[]; sids: number[] } }
    | { targetPid: number; targetStartTime?: string }
    | { code: number }
    | { error: string; code?: string }
    | { killed: true }
    | { saved: true }
    | { spareError: string; code?: string },
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

const spareServer = startSpareServer(async (pids, sids) => {
  mergeSpared(localSpared, pids, sids);
  writeResult(ipcFd, { spare: { pids, sids } });
  if (innerMetaFd !== undefined && !innerDoneMarked) writeResult(innerMetaFd, { spare: { pids, sids } });
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
  selfTargets: ProcTargets | undefined,
  targetTargets: ProcTargets | undefined,
  sig: NodeJS.Signals,
) => {
  const groups = new Set<number>();
  const orphanPids = new Set<number>();
  const groupMembers = new Map<number, PidIdentity[]>();
  const pidIdentities = new Map<number, PidIdentity>();
  const addTargets = (found: ProcTargets | undefined) => {
    if (!found) return;
    for (const g of found.groups) if (g !== process.pid) groups.add(g);
    for (const p of found.orphanPids) if (p !== process.pid) orphanPids.add(p);
    if (found.groupMembers) {
      for (const [g, members] of found.groupMembers) {
        if (g === process.pid) continue;
        const list = groupMembers.get(g);
        if (list) list.push(...members);
        else groupMembers.set(g, [...members]);
      }
    }
    if (found.pidIdentities) {
      for (const [p, identity] of found.pidIdentities) {
        if (p !== process.pid) pidIdentities.set(p, identity);
      }
    }
  };
  addTargets(targetTargets);
  addTargets(selfTargets);
  if (targetPid !== undefined && !targetReaped) {
    groups.add(targetPid);
    const id = targetIdentity ?? pidIdentityNow(targetPid);
    if (id) {
      const list = groupMembers.get(targetPid);
      const entry = { pid: targetPid, startTime: id.startTime, pgid: targetPid };
      if (list) list.push(entry);
      else groupMembers.set(targetPid, [entry]);
    }
  }
  signalTargets({ pids: [], groups: [...groups], orphanPids: [...orphanPids], groupMembers, pidIdentities }, sig, undefined, runTag, localSpared);
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
        markInnerDone();
        process.exit(1);
      }
    }
    writeResult(ipcFd, { saved: true });
  }
  markInnerDone();
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
    writeResult(ipcFd, { killed: true });
    markInnerDone();
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
              markInnerDone();
              process.exit(targetCode ?? 0);
            }
          });
        }
        return;
      }
      if (lockCount > 0 && !targetReaped && !inProbe) {
        spareServer?.close();
        markInnerDone();
        process.exit(0);
      }
      killAll();
    }
  })();
};

if (holderAliveFd !== undefined) {
  const drainedHolder = drainControlFd(holderAliveFd);
  if (drainedHolder.closed) {
    killAll();
  } else {
    void (async () => {
      const reader = Bun.file(holderAliveFd).stream().getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!confirmedDone && !exitingDone && !killing) killAll();
    })();
  }
}

if (lockCount > 0 && !inProbe && inheritedSpare) {
  const sparePids = holderAliveFd !== undefined ? [process.pid, process.ppid] : [process.pid];
  const spareSids = holderAliveFd !== undefined ? [process.pid, process.ppid] : [process.pid];
  await reportSpared(inheritedSpare, sparePids, spareSids);
}

setCloexec(ipcFd, true);
if (configFd !== undefined) setCloexec(configFd, true);

const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
const drained = drainControlFd(ipcFd);
if (drained.closed || drained.lines.includes("kill") || drained.lines.some((line) => line.startsWith("grace:") || line.startsWith("sig:"))) {
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  spareServer?.close();
  writeResult(ipcFd, { killed: true });
  markInnerDone();
  process.exit(137);
}
if (drained.lines.includes("done")) {
  confirmedDone = true;
  for (const fd of [...lockFds, ...(configFd !== undefined ? [configFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  spareServer?.close();
  markInnerDone();
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
  const { argv, env, envEntries, injectedTag, injectedSpare, preserveEmptyEnv } = parsed;
  let cleanBaseEnv: Record<string, string> | undefined;
  if (Array.isArray(envEntries)) {
    cleanBaseEnv = Object.create(null) as Record<string, string>;
    for (const [k, v] of envEntries) cleanBaseEnv[k] = v;
  } else if (env && typeof env === "object") {
    cleanBaseEnv = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string" && k !== tagEnvVar && k !== spareEnvVar) cleanBaseEnv[k] = v;
    }
  }
  const effectiveInheritedSpare = injectedSpare ?? inheritedSpare;
  const childSpareEndpoint = preserveEmptyEnv
    ? undefined
    : spareServer?.endpoint && effectiveInheritedSpare
      ? `${spareServer.endpoint},${effectiveInheritedSpare}`
      : (spareServer?.endpoint ?? effectiveInheritedSpare);
  const cloneEnv = (base: Record<string, string> | undefined) => {
    const out: Record<string, string> = Object.create(null);
    if (base) {
      for (const [k, v] of Object.entries(base)) out[k] = v;
    } else {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== tagEnvVar && k !== spareEnvVar) out[k] = v;
      }
    }
    return out;
  };
  let targetEnv: Record<string, string> | undefined = cleanBaseEnv;
  if (injectedTag || childSpareEndpoint) {
    targetEnv = cloneEnv(cleanBaseEnv);
    if (injectedTag) targetEnv[tagEnvVar] = injectedTag;
    if (childSpareEndpoint) targetEnv[spareEnvVar] = childSpareEndpoint;
  }
  const stdio: [number, number, number, ...number[]] = [0, 1, 2, ...lockFds];
  try {
    try {
      target = Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio, detached: true });
    } catch (spawnError) {
      if ((spawnError as NodeJS.ErrnoException)?.code === "E2BIG" && targetEnv !== cleanBaseEnv) {
        if (injectedTag && childSpareEndpoint) {
          const spareOnlyEnv = cloneEnv(cleanBaseEnv);
          spareOnlyEnv[spareEnvVar] = childSpareEndpoint;
          try {
            target = Bun.spawn(argv, { env: spareOnlyEnv, stdio, detached: true });
          } catch (spareError) {
            if ((spareError as NodeJS.ErrnoException)?.code === "E2BIG") {
              target = Bun.spawn(argv, { ...(cleanBaseEnv ? { env: cleanBaseEnv } : {}), stdio, detached: true });
            } else {
              throw spareError;
            }
          }
        } else {
          target = Bun.spawn(argv, { ...(cleanBaseEnv ? { env: cleanBaseEnv } : {}), stdio, detached: true });
        }
      } else {
        throw spawnError;
      }
    }
    targetDetached = true;
    targetPid = target.pid;
    targetIdentity = pidIdentityNow(targetPid);
    const targetInfo = { targetPid, ...(targetIdentity ? { targetStartTime: targetIdentity.startTime } : {}) };
    writeResult(ipcFd, targetInfo);
    if (innerMetaFd !== undefined && !innerDoneMarked) writeResult(innerMetaFd, targetInfo);
  } catch (error) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    spareServer?.close();
    targetReaped = true;
    targetCode = 127;
    const err = error as NodeJS.ErrnoException;
    writeResult(ipcFd, { error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    markInnerDone();
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
        markInnerDone();
        process.exit(code);
      }
    } else {
      writeResult(ipcFd, { code });
    }
  }
}
