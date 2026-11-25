import { closeSync, writeSync } from "node:fs";

type StartMessage = { argv: string[]; lockCount: number };

let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let holdFd: number | undefined;
let ownPgidActive = false;
let parentGone = false;
let killing = false;

const anchorAlive = () => {
  if (holdFd === undefined) return false;
  try {
    writeSync(holdFd, "\n");
    return true;
  } catch {
    return false;
  }
};

const killAll = () => {
  if (killing) return;
  killing = true;
  if (target && (!targetReaped || anchorAlive() || ownPgidActive)) {
    try {
      process.kill(-target.pid, "SIGKILL");
    } catch {}
    if (!targetReaped) {
      try {
        target.kill("SIGKILL");
      } catch {}
    }
  }
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {}
  process.exit(137);
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(sig, killAll);
}

process.on("disconnect", () => {
  parentGone = true;
  if (targetCode !== undefined) process.exit(targetCode);
  if (!target) process.exit(0);
});

process.on("message", async (message: unknown) => {
  if (killing) return;
  if (message === "done") {
    process.exit(targetCode ?? 0);
  }
  if (!message || typeof message !== "object" || !Array.isArray((message as StartMessage).argv)) return;
  const { argv, lockCount } = message as StartMessage;
  const locked = lockCount > 0;
  const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
  const stdio: [number, number, number, ...(number | "pipe")[]] = locked ? [0, 1, 2, ...lockFds, "pipe"] : [0, 1, 2];
  try {
    target = Bun.spawn(argv, { stdio });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    try {
      process.send?.({ error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    } catch {}
    process.exit(127);
  }
  if (locked && typeof target.stdio[lockCount + 3] === "number") {
    holdFd = target.stdio[lockCount + 3] as number;
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
  if (!locked && target.pid !== process.pid) {
    try {
      process.kill(-target.pid, 0);
      ownPgidActive = true;
    } catch {
      ownPgidActive = false;
    }
  }
  targetCode = code;
  if (parentGone) process.exit(code);
  try {
    process.send?.({ code, pgidActive: locked ? anchorAlive() : ownPgidActive });
  } catch {
    process.exit(code);
  }
});
