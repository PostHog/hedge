import { closeSync, writeSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;

export type SupervisorHost = {
  spawn: (command: string[]) => { exited: Promise<number> };
  killGroup: (signal: NodeJS.Signals) => void;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  reportResult: (code: number) => void;
  reportCleanup: () => void;
  exit: (code: number) => void;
};

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export async function supervise(command: string[], host: SupervisorHost, cleanupGraceMs = graceMs): Promise<number> {
  let resolveDone!: (code: number) => void;
  const settled = new Promise<number>((resolve) => (resolveDone = resolve));

  let stop: StopSignal | undefined;
  let target: { exited: Promise<number> } | undefined;
  let leaderDone = false;
  let finished = false;
  let cancelInterrupt: (() => void) | undefined;
  let cancelHard: (() => void) | undefined;
  const forwarded = new Set<StopSignal>();

  const exit = (code: number) => {
    if (finished) return;
    finished = true;
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    cancelHard?.();
    cancelHard = undefined;
    host.exit(code);
    resolveDone(code);
  };

  if (!command.length) {
    host.reportResult(127);
    exit(127);
    return settled;
  }

  const finishGroup = () => {
    if (finished) return;
    host.killGroup("SIGKILL");
    exit(143);
  };

  const forwardGroup = (name: StopSignal) => {
    if (forwarded.has(name)) return;
    forwarded.add(name);
    host.killGroup(name);
  };

  const armHard = () => {
    if (finished || cancelHard) return;
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    cancelHard = host.timer(cleanupGraceMs, finishGroup);
  };

  const arm = (name: StopSignal) => {
    if (finished) return;
    if (name === "SIGTERM" || name === "SIGHUP") {
      armHard();
      return;
    }
    if (!cancelInterrupt && !cancelHard) {
      cancelInterrupt = host.timer(interruptGraceMs, () => {
        cancelInterrupt = undefined;
        armHard();
        forwardGroup("SIGTERM");
      });
    }
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    host.onSignal(sig, () => {
      if (forwarded.has(sig)) return;
      if (!stop) stop = sig;
      if (!target) return exit(128);
      if (leaderDone) {
        if (sig === "SIGTERM" || sig === "SIGHUP") {
          armHard();
          forwardGroup(sig);
        }
        return;
      }
      arm(sig);
      forwardGroup(sig);
    });
  }

  try {
    target = host.spawn(command);
  } catch {
    host.reportResult(127);
    exit(127);
    return settled;
  }

  if (stop) {
    arm(stop);
    forwardGroup(stop);
  }

  const code = await target.exited;
  leaderDone = true;
  if (finished) return settled;
  if (!stop) {
    host.reportResult(code);
    armHard();
    forwardGroup("SIGTERM");
    host.reportCleanup();
  }
  return settled;
}

if (import.meta.main) {
  const handlers = new Map<StopSignal, () => void>();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      const fn = handlers.get(sig);
      if (fn) fn();
      else process.exit(128);
    });
  }
  let command: string[] = [];
  let cleanupGraceMs = graceMs;
  try {
    const raw = Bun.argv[2] ?? (await Bun.stdin.text());
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) {
      command = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { command?: unknown }).command)) {
      const record = parsed as { command: unknown[]; graceMs?: unknown };
      if (record.command.every((arg) => typeof arg === "string")) command = record.command as string[];
      if (typeof record.graceMs === "number" && record.graceMs >= 0) cleanupGraceMs = record.graceMs;
    }
  } catch {}
  await supervise(command, {
    spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal) => {
      try {
        process.kill(-process.pid, signal);
      } catch {}
    },
    timer: realTimer,
    onSignal: (signal, handler) => void handlers.set(signal, handler),
    reportResult: (code) => {
      try {
        writeSync(1, `${code}\n`);
      } catch {}
    },
    reportCleanup: () => {
      try {
        writeSync(1, "cleanup\n");
      } catch {}
      try {
        closeSync(1);
      } catch {}
    },
    exit: (code) => process.exit(code),
  }, cleanupGraceMs);
}
