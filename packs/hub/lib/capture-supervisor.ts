import { closeSync } from "node:fs";
import { killSession } from "../../../src/reconciler/probe-supervisor.ts";

type StartMessage = { argv: string[]; lockCount: number; controlFd?: number };

let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let killing = false;

const killAll = () => {
  if (killing) return;
  killing = true;
  if (target && !targetReaped) {
    try {
      target.kill("SIGKILL");
    } catch {}
  }
  const done = killSession(process.pid, "SIGKILL");
  if (done && typeof (done as Promise<void>).then === "function") {
    void (done as Promise<void>).finally(() => process.exit(137));
    return;
  }
  process.exit(137);
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, () => {});
}

let readingControl = false;

const watchControl = (fd: number) => {
  if (readingControl) return;
  readingControl = true;
  void (async () => {
    let sawKill = false;
    try {
      const reader = Bun.file(fd).stream().getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
      process.exit(targetCode ?? 0);
    }
  })();
};

process.on("disconnect", () => {
  if (!readingControl) process.exit(targetCode ?? 0);
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
  const { argv, lockCount, controlFd } = message as StartMessage;
  if (typeof controlFd === "number" && Number.isInteger(controlFd) && controlFd >= 3) watchControl(controlFd);
  const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
  const stdio: [number, number, number, ...number[]] = [0, 1, 2, ...lockFds];
  try {
    target = Bun.spawn(argv, { stdio });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    try {
      process.send?.({ error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    } catch {}
    process.exit(127);
  }
  for (const fd of lockFds) {
    try {
      closeSync(fd);
    } catch {}
  }
  try {
    process.send?.({ pgid: target.pid });
  } catch {}
  for (const fd of [1, 2]) {
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
