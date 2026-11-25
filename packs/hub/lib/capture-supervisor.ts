import { closeSync } from "node:fs";

type StartMessage = { argv: string[]; lockCount: number };

let target: ReturnType<typeof Bun.spawn> | undefined;
let targetReaped = false;
let targetCode: number | undefined;
let parentGone = false;
let killing = false;

const killAll = () => {
  if (killing) return;
  killing = true;
  if (target && !targetReaped) {
    try {
      process.kill(-target.pid, "SIGKILL");
    } catch {}
    try {
      target.kill("SIGKILL");
    } catch {}
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
  const lockFds = Array.from({ length: lockCount }, (_, index) => index + 3);
  try {
    target = Bun.spawn(argv, { stdio: [0, 1, 2, ...lockFds] });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    try {
      process.send?.({ error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) });
    } catch {}
    process.exit(127);
  }
  for (const fd of [1, 2, ...lockFds]) {
    try {
      closeSync(fd);
    } catch {}
  }
  const code = await target.exited;
  targetReaped = true;
  targetCode = code;
  if (parentGone) process.exit(code);
  try {
    process.send?.({ code });
  } catch {
    process.exit(code);
  }
});
