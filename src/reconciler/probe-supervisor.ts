import { existsSync, readdirSync, readFileSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;

export type SupervisorHost = {
  spawn: (command: string[]) => { exited: Promise<number> };
  killGroup: (signal: NodeJS.Signals) => void;
  otherMembers: () => number[];
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  exit: (code: number) => void;
};

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export function otherGroupMembers(pgid = process.pid): number[] {
  if (process.platform === "linux") {
    try {
      const members: number[] = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === pgid) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        } catch {
          continue;
        }
        const end = stat.lastIndexOf(")");
        if (end === -1) continue;
        const fields = stat.slice(end + 2).split(" ");
        const state = fields[0];
        const group = Number(fields[2]);
        if (group === pgid && state !== "Z" && state !== "X") members.push(pid);
      }
      return members;
    } catch {}
  }
  try {
    const ps = existsSync("/bin/ps") ? "/bin/ps" : "ps";
    const proc = Bun.spawnSync([ps, "-axo", "pid=,pgid=,ppid=,stat="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return [];
    const members: number[] = [];
    for (const line of proc.stdout.toString("utf8").split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      const group = Number(parts[1]);
      const ppid = Number(parts[2]);
      const state = parts[3]!;
      if (group === pgid && pid > 0 && pid !== pgid && ppid !== pgid && !state.startsWith("Z")) members.push(pid);
    }
    return members;
  } catch {
    return [];
  }
}

export async function supervise(command: string[], host: SupervisorHost): Promise<number> {
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
    exit(127);
    return settled;
  }

  const finishGroup = () => {
    if (finished) return;
    host.killGroup("SIGKILL");
    exit(143);
  };

  const finishPeers = (code: number) => {
    if (finished) return;
    for (let pass = 0; pass < 3; pass++) {
      const peers = host.otherMembers();
      if (!peers.length) break;
      for (const pid of peers) host.killPid(pid, "SIGKILL");
    }
    exit(code);
  };

  const forwardGroup = (name: StopSignal) => {
    if (forwarded.has(name)) return;
    forwarded.add(name);
    host.killGroup(name);
  };

  const armHard = (onExpire = finishGroup) => {
    if (finished || cancelHard) return;
    cancelInterrupt?.();
    cancelInterrupt = undefined;
    cancelHard = host.timer(graceMs, onExpire);
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
      if (leaderDone) return;
      arm(sig);
      forwardGroup(sig);
    });
  }

  try {
    target = host.spawn(command);
  } catch {
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
    if (!host.otherMembers().length) {
      exit(code);
      return settled;
    }
    armHard(() => finishPeers(code));
    forwardGroup("SIGTERM");
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
  try {
    const parsed = JSON.parse(await Bun.stdin.text()) as unknown;
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) command = parsed;
  } catch {}
  await supervise(command, {
    spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal) => {
      try {
        process.kill(-process.pid, signal);
      } catch {}
    },
    otherMembers: () => otherGroupMembers(process.pid),
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {}
    },
    timer: realTimer,
    onSignal: (signal, handler) => void handlers.set(signal, handler),
    exit: (code) => process.exit(code),
  });
}
