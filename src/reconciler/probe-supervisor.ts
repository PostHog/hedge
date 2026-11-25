export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;

export type SupervisorHost = {
  spawn: (command: string[]) => { exited: Promise<number> };
  killGroup: (signal: NodeJS.Signals) => void;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  exit: (code: number) => void;
};

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export async function supervise(command: string[], host: SupervisorHost): Promise<void> {
  if (!command.length) return host.exit(127);

  let stop: StopSignal | undefined;
  let target: { exited: Promise<number> } | undefined;
  let leaderDone = false;
  let finished = false;
  let cancelInterrupt: (() => void) | undefined;
  let cancelHard: (() => void) | undefined;

  const finishGroup = () => {
    if (finished) return;
    finished = true;
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    cancelHard?.();
    cancelHard = undefined;
    host.killGroup("SIGKILL");
    host.exit(143);
  };

  const armHard = () => {
    if (finished || cancelHard) return;
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    cancelHard = host.timer(graceMs, finishGroup);
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
        host.killGroup("SIGTERM");
      });
    }
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    host.onSignal(sig, () => {
      if (!stop) stop = sig;
      if (!target) return host.exit(128);
      if (leaderDone) return;
      arm(sig);
    });
  }

  try {
    target = host.spawn(command);
  } catch {
    return host.exit(127);
  }

  if (stop) arm(stop);

  const code = await target.exited;
  leaderDone = true;
  if (finished) return;
  if (!stop) {
    cancelInterrupt?.();
    cancelHard?.();
    return host.exit(code);
  }
  if (!cancelHard) {
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    armHard();
    host.killGroup("SIGTERM");
  }
}

if (import.meta.main) {
  await supervise(Bun.argv.slice(2), {
    spawn: (command) => Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal) => {
      try {
        process.kill(-process.pid, signal);
      } catch {}
    },
    timer: realTimer,
    onSignal: (signal, handler) => void process.on(signal, handler),
    exit: (code) => process.exit(code),
  });
}
