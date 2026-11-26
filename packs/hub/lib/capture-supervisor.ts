import { closeSync, writeSync } from "node:fs";
import { discoverTargets, discoverTargetsLinux, discoverTargetsSync, drainControlFd, enableChildSubreaper, encodeSpareLine, graceMs, interruptGraceMs, killSession, ownTag, probeGraceEnvVar, readFdChunk, recordSparedProcess, redirectStdioOutputsToNull, removeSpareFile, setCloexec, shieldGroupSignals, signalTargets, spareEnvVar, spareFilePath, type StopSignal, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartConfig = { argv: string[]; env?: Record<string, string>; envEntries?: Array<[string, string]>; spareTag?: string; spareHome?: string };

enableChildSubreaper();
shieldGroupSignals();

const runTag = ownTag(process.env[tagEnvVar]);
const inProbe = (process.env[tagEnvVar] ?? "").split(",").some((part) => part.trim().startsWith("probe-"));
const inheritedSpare = Boolean(process.env[spareEnvVar]);
const stopSignalsSet = new Set<StopSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const rawProbeGrace = Number(process.env[probeGraceEnvVar]);
const probeGraceMs = Number.isFinite(rawProbeGrace) && rawProbeGrace >= 0 ? rawProbeGrace : graceMs;
let sparePath = process.env[spareEnvVar];
let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let confirmedDone = false;
let killing = false;
let lockCount = 0;
let gracefulSignal: StopSignal | undefined;
let interruptTimer: ReturnType<typeof setTimeout> | undefined;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
let resultFdClosed = false;
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

const exitDone = () => {
  clearGraceTimers();
  if (inheritedSpare && sparePath) {
    const found = discoverTargetsSync(process.pid, runTag, undefined, sparePath);
    if (found) {
      const sids = [...(found.sids ?? []), ...(found.hasSessionGroup ? [process.pid] : [])];
      if (found.pids.length || sids.length) {
        const saved = recordSparedProcess(sparePath, found.pids, sids);
        if (!saved.ok) {
          if (!resultFdClosed && resultFd !== undefined) {
            writeResult(resultFd, { spareError: saved.error, ...(saved.code ? { code: saved.code } : {}) }, true);
          }
          process.exit(1);
        }
      }
    }
    if (!resultFdClosed && resultFd !== undefined) writeResult(resultFd, { saved: true }, true);
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
  if (removeOwnSpare && !inheritedSpare && sparePath) {
    if (process.platform === "linux") {
      const targets = discoverTargetsLinux(process.pid, runTag, undefined, sparePath);
      removeSpareFile(sparePath);
      signalTargets(targets, "SIGKILL", process.pid);
      finish();
      return;
    }
    void discoverTargets(process.pid, runTag, sparePath)
      .then((targets) => {
        removeSpareFile(sparePath);
        signalTargets(targets ?? { pids: [], groups: [], orphanPids: [] }, "SIGKILL", process.pid);
      })
      .finally(finish);
    return;
  }
  const done = killSession(process.pid, "SIGKILL", runTag, undefined, sparePath);
  if (done && typeof (done as Promise<void>).then === "function") {
    void (done as Promise<void>).finally(finish);
    return;
  }
  finish();
};

const forwardGraceful = (sig: StopSignal) => {
  if (killing || confirmedDone) return;
  gracefulSignal = sig;
  if (!receivedSignals.has(sig)) {
    receivedSignals.add(sig);
    void killSession(process.pid, sig, runTag, undefined, sparePath);
  }
  if (sig === "SIGTERM" || sig === "SIGHUP") {
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      interruptTimer = undefined;
    }
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        killAll(false);
      }, probeGraceMs);
    }
    return;
  }
  if (!interruptTimer && !graceTimer) {
    interruptTimer = setTimeout(() => {
      interruptTimer = undefined;
      if (killing || confirmedDone) return;
      if (!receivedSignals.has("SIGTERM")) {
        receivedSignals.add("SIGTERM");
        void killSession(process.pid, "SIGTERM", runTag, undefined, sparePath);
      }
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          killAll(false);
        }, probeGraceMs);
      }
    }, interruptGraceMs);
  }
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => {
    receivedSignals.add(sig);
  });
}

const closeQuiet = (fd: number) => {
  try {
    closeSync(fd);
  } catch {}
};

const writeResult = (
  fd: number,
  payload: { code: number } | { error: string; code?: string } | { saved: true } | { spareError: string; code?: string },
  closeAfter = true,
) => {
  if (resultFdClosed) return;
  const bytes = new TextEncoder().encode(JSON.stringify(payload) + "\n");
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {}
  if (closeAfter) {
    resultFdClosed = true;
    closeQuiet(fd);
  }
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
        if (line.startsWith("sig:")) {
          const sig = line.slice(4) as StopSignal;
          if (stopSignalsSet.has(sig)) forwardGraceful(sig);
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
          void discoverTargets(process.pid, runTag, sparePath, false).then((targets) => {
            if (!killing && targets && targets.pids.length === 0) {
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
const controlFd = parseFd(Bun.argv[3], 3);
const resultFd = parseFd(Bun.argv[4], 3);
const configFd = parseFd(Bun.argv[5], 3);
let spareFd = parseFd(Bun.argv[6], 3);
if (parsedLockCount === undefined || controlFd === undefined || resultFd === undefined || configFd === undefined) {
  process.exit(127);
}
lockCount = parsedLockCount;
if (lockCount > 0 && !inProbe && inheritedSpare && sparePath) {
  recordSparedProcess(sparePath, [process.pid], [process.pid]);
}

setCloexec(controlFd, true);
setCloexec(resultFd, true);
setCloexec(configFd, true);
if (spareFd !== undefined) setCloexec(spareFd, true);

const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
const drained = drainControlFd(controlFd);
if (drained.closed || drained.lines.includes("kill") || drained.lines.some((line) => line.startsWith("sig:"))) {
  for (const fd of [...lockFds, resultFd, configFd, ...(spareFd !== undefined ? [spareFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  process.exit(137);
}
if (drained.lines.includes("done")) {
  confirmedDone = true;
  for (const fd of [...lockFds, resultFd, configFd, ...(spareFd !== undefined ? [spareFd] : [])]) closeQuiet(fd);
  redirectStdioOutputsToNull();
  process.exit(0);
}
watchControl(controlFd, drained.rest);

let parsed: StartConfig | undefined;
try {
  const rawConfig = await Bun.file(configFd).text();
  closeQuiet(configFd);
  if (rawConfig.trim()) {
    const candidate = JSON.parse(rawConfig) as StartConfig;
    if (candidate && typeof candidate === "object" && Array.isArray(candidate.argv)) parsed = candidate;
  }
} catch {
  closeQuiet(configFd);
}

if (!parsed || killing || gracefulSignal) {
  for (const fd of [...lockFds, resultFd, ...(spareFd !== undefined ? [spareFd] : [])]) closeQuiet(fd);
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
    if (spareFd !== undefined) {
      try {
        writeSync(spareFd, encodeSpareLine(sparePath));
      } catch {}
      closeQuiet(spareFd);
      spareFd = undefined;
    }
    if (!targetEnv) {
      targetEnv = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) targetEnv[k] = v;
    }
    targetEnv[spareEnvVar] = sparePath;
  }
  if (spareFd !== undefined) {
    closeQuiet(spareFd);
    spareFd = undefined;
  }
  const stdio: [number, number, number, ...number[]] = [0, 1, 2, ...lockFds];
  try {
    target = Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio });
  } catch (error) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    targetReaped = true;
    targetCode = 127;
    const err = error as NodeJS.ErrnoException;
    writeResult(resultFd, { error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) }, true);
  }
  if (target) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    const code = await target.exited;
    targetReaped = true;
    targetCode = code;
    if (gracefulSignal) {
      writeResult(resultFd, { code }, true);
      const targets = await discoverTargets(process.pid, runTag, sparePath, false);
      if (!killing && targets && targets.pids.length === 0) {
        clearGraceTimers();
        process.exit(code);
      }
    } else {
      writeResult(resultFd, { code }, !(inheritedSpare && sparePath));
    }
  }
}
