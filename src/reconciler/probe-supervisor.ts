import { closeSync, readdirSync, readFileSync, writeSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;

export type SupervisorHost = {
  spawn: (command: string[]) => { pid?: number; exited: Promise<number>; kill?: (signal?: NodeJS.Signals) => void };
  killGroup: (signal: NodeJS.Signals) => void;
  hasGroupMembers?: (targetPid?: number) => Promise<boolean> | boolean;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  reportTarget?: (pid: number) => void;
  reportResult: (code: number) => void;
  reportCleanup: () => void;
  exit: (code: number) => void;
};

async function hasOtherGroupMember(targetPid?: number): Promise<boolean> {
  const self = process.pid;
  const groups = new Set<number>([self]);
  if (targetPid !== undefined && targetPid !== self) groups.add(targetPid);
  if (process.platform === "linux") {
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === self) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${name}/stat`, "utf8");
        } catch {
          continue;
        }
        const closeParen = stat.lastIndexOf(")");
        if (closeParen === -1) continue;
        const fields = stat.slice(closeParen + 2).split(" ");
        if (groups.has(Number(fields[2]))) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
  try {
    const ps = Bun.spawn(["ps", "-eo", "pid=,pgid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (code !== 0) return true;
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const pgid = Number(parts[1]);
      if (groups.has(pgid) && pid !== self && pid !== ps.pid) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export async function supervise(command: string[], host: SupervisorHost, cleanupGraceMs = graceMs): Promise<number> {
  let resolveDone!: (code: number) => void;
  const settled = new Promise<number>((resolve) => (resolveDone = resolve));

  let stop: StopSignal | undefined;
  let target: { pid?: number; exited: Promise<number>; kill?: (signal?: NodeJS.Signals) => void } | undefined;
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
  if (target.pid !== undefined) host.reportTarget?.(target.pid);

  if (stop) {
    arm(stop);
    forwardGroup(stop);
  }

  const code = await target.exited;
  leaderDone = true;
  if (finished) return settled;
  if (!stop) {
    host.reportResult(code);
    if (host.hasGroupMembers) {
      const hasMembers = await host.hasGroupMembers(target.pid);
      if (finished) return settled;
      if (!stop && !hasMembers) {
        exit(code);
        return settled;
      }
    }
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
  let spawnedTarget: ReturnType<typeof Bun.spawn> | undefined;
  let targetReaped = false;
  let ownPgidActive = false;
  await supervise(command, {
    spawn: (argv) => {
      const proc = Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] });
      spawnedTarget = proc;
      void proc.exited.finally(() => {
        targetReaped = true;
        if (proc.pid !== process.pid) {
          try {
            process.kill(-proc.pid, 0);
            ownPgidActive = true;
          } catch {
            ownPgidActive = false;
          }
        }
      });
      return proc;
    },
    killGroup: (signal) => {
      if (spawnedTarget && (!targetReaped || ownPgidActive)) {
        try {
          process.kill(-spawnedTarget.pid, signal);
        } catch {}
      }
      try {
        process.kill(-process.pid, signal);
      } catch {}
    },
    hasGroupMembers: hasOtherGroupMember,
    timer: realTimer,
    onSignal: (signal, handler) => void handlers.set(signal, handler),
    reportTarget: (pid) => {
      try {
        writeSync(1, `target:${pid}\n`);
      } catch {}
    },
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
