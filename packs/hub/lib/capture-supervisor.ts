import { closeSync, writeSync } from "node:fs";
import { discoverTargetsSync, drainControlFd, enableChildSubreaper, killSession, ownTag, recordSparedProcess, redirectStdioOutputsToNull, removeSpareFile, setCloexec, shieldGroupSignals, spareEnvVar, spareFilePath, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartConfig = { argv: string[]; env?: Record<string, string>; envEntries?: Array<[string, string]>; spareTag?: string; spareHome?: string };

enableChildSubreaper();
shieldGroupSignals();

const runTag = ownTag(process.env[tagEnvVar]);
const hasParentTag = (process.env[tagEnvVar] ?? "").includes(",");
const inheritedSpare = Boolean(process.env[spareEnvVar]);
let sparePath = process.env[spareEnvVar];
let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let confirmedDone = false;
let killing = false;
let lockCount = 0;

const exitDone = () => {
  if (inheritedSpare && sparePath) {
    const found = discoverTargetsSync(process.pid, runTag, undefined, sparePath);
    if (found) {
      const sids = [...(found.sids ?? []), ...(found.hasSessionGroup ? [process.pid] : [])];
      if (found.pids.length || sids.length) recordSparedProcess(sparePath, found.pids, sids);
    }
  } else if (!inheritedSpare && sparePath) {
    removeSpareFile(sparePath);
  }
  process.exit(targetCode ?? 0);
};

const killAll = () => {
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
  const done = killSession(process.pid, "SIGKILL", runTag, undefined, sparePath);
  if (done && typeof (done as Promise<void>).then === "function") {
    void (done as Promise<void>).finally(finish);
    return;
  }
  finish();
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => {});
}

const closeQuiet = (fd: number) => {
  try {
    closeSync(fd);
  } catch {}
};

const writeResult = (fd: number, payload: { code: number } | { error: string; code?: string }) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload) + "\n");
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {}
  closeQuiet(fd);
};

let readingControl = false;

const watchControl = (fd: number, initialBuf = "") => {
  if (readingControl) return;
  readingControl = true;
  void (async () => {
    try {
      const reader = Bun.file(fd).stream().getReader();
      const decoder = new TextDecoder();
      let buf = initialBuf;
      const handleLine = (line: string): boolean => {
        if (line === "kill") {
          killAll();
          return true;
        }
        if (line === "done") {
          confirmedDone = true;
          exitDone();
        }
        return false;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          if (handleLine(buf.slice(0, nl).trim())) return;
          buf = buf.slice(nl + 1);
        }
      }
      if (handleLine(buf.trim())) return;
    } catch {}
    if (!killing) {
      if (confirmedDone) exitDone();
      if (lockCount > 0 && !targetReaped && !hasParentTag) process.exit(0);
      killAll();
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

setCloexec(controlFd, true);
setCloexec(resultFd, true);
setCloexec(configFd, true);
if (spareFd !== undefined) setCloexec(spareFd, true);

const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
const drained = drainControlFd(controlFd);
if (drained.closed || drained.lines.includes("kill")) {
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

if (!parsed || killing) {
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
        writeSync(spareFd, `${sparePath}\n`);
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
    writeResult(resultFd, { error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
  }
  if (target) {
    for (const fd of lockFds) closeQuiet(fd);
    redirectStdioOutputsToNull();
    const code = await target.exited;
    targetReaped = true;
    targetCode = code;
    writeResult(resultFd, { code });
  }
}
