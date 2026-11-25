import { closeSync } from "node:fs";
import { drainControlFd, enableChildSubreaper, killSession, ownTag, setCloexec, shieldGroupSignals, tagEnvVar } from "../../../src/reconciler/probe-supervisor.ts";

type StartMessage = { argv: string[]; env?: Record<string, string>; envEntries?: Array<[string, string]>; lockCount: number; controlFd?: number };

enableChildSubreaper();
shieldGroupSignals();

const runTag = ownTag(process.env[tagEnvVar]);
let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let killing = false;

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
  const done = killSession(process.pid, "SIGKILL", runTag);
  if (done && typeof (done as Promise<void>).then === "function") {
    void (done as Promise<void>).finally(finish);
    return;
  }
  finish();
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => {});
}

let readingControl = false;

const watchControl = (fd: number, initialBuf = "") => {
  if (readingControl) return;
  readingControl = true;
  void (async () => {
    let sawKill = false;
    try {
      const reader = Bun.file(fd).stream().getReader();
      const decoder = new TextDecoder();
      let buf = initialBuf;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          if (buf.slice(0, nl).trim() === "kill") {
            sawKill = true;
            killAll();
            return;
          }
          buf = buf.slice(nl + 1);
        }
      }
      if (buf.trim() === "kill") {
        sawKill = true;
        killAll();
        return;
      }
    } catch {}
    if (!sawKill && !killing) {
      if (!targetReaped) {
        killAll();
        return;
      }
      process.exit(targetCode ?? 0);
    }
  })();
};

process.on("disconnect", () => {
  if (!readingControl) {
    if (!targetReaped) killAll();
    else process.exit(targetCode ?? 0);
  }
});

process.on("message", async (message: unknown) => {
  if (killing) return;
  if (message === "done") {
    process.exit(targetCode ?? 0);
  }
  if (message === "kill") {
    killAll();
    return;
  }
  if (!message || typeof message !== "object" || !Array.isArray((message as StartMessage).argv)) return;
  const { argv, env, envEntries, lockCount, controlFd } = message as StartMessage;
  const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
  if (typeof controlFd === "number" && Number.isInteger(controlFd) && controlFd >= 3) {
    setCloexec(controlFd, true);
    const drained = drainControlFd(controlFd);
    if (drained.closed || drained.lines.includes("kill")) {
      for (const fd of [...lockFds, 1, 2]) {
        try {
          closeSync(fd);
        } catch {}
      }
      process.exit(137);
    }
    watchControl(controlFd, drained.rest);
  }
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
  const stdio: [number, number, number, ...number[]] = [0, 1, 2, ...lockFds];
  try {
    target = Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio });
  } catch (error) {
    for (const fd of [...lockFds, 1, 2]) {
      try {
        closeSync(fd);
      } catch {}
    }
    targetReaped = true;
    targetCode = 127;
    const err = error as NodeJS.ErrnoException;
    try {
      process.send?.({ error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    } catch {
      process.exit(127);
    }
    return;
  }
  for (const fd of [...lockFds, 1, 2]) {
    try {
      closeSync(fd);
    } catch {}
  }
  const code = await target.exited;
  targetReaped = true;
  targetCode = code;
  try {
    process.send?.({ code });
  } catch {
    process.exit(code);
  }
});
