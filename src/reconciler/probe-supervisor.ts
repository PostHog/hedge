import { closeSync, readdirSync, readFileSync, writeSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;

export type SupervisorHost = {
  spawn: (command: string[]) => { pid?: number; exited: Promise<number>; kill?: (signal?: NodeJS.Signals) => void };
  killGroup: (signal: NodeJS.Signals) => void | Promise<void>;
  hasGroupMembers?: (targetPid?: number) => Promise<boolean> | boolean;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  reportTarget?: (pid: number) => void;
  reportResult: (code: number) => void;
  reportCleanup: () => void;
  exit: (code: number) => void;
};

export function sessionGroupsLinux(sessionId: number): number[] {
  const groups = new Set<number>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
      } catch {
        continue;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen === -1) continue;
      const fields = stat.slice(closeParen + 2).split(" ");
      if (Number(fields[3]) === sessionId) {
        const pgrp = Number(fields[2]);
        if (pgrp > 0) groups.add(pgrp);
      }
    }
  } catch {}
  return [...groups];
}

export async function sessionGroups(sessionId: number): Promise<number[]> {
  if (process.platform === "linux") return sessionGroupsLinux(sessionId);
  const groups = new Set<number>([sessionId]);
  try {
    const ps = Bun.spawn(["ps", "-Ao", "pid=,pgid=,sess="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (code !== 0) return [...groups];
    const rows: Array<{ pid: number; pgid: number; sess: string }> = [];
    let targetSess: string | undefined;
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const pgid = Number(parts[1]);
      const sess = parts[2]!;
      if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue;
      rows.push({ pid, pgid, sess });
      if (pid === sessionId) targetSess = sess;
    }
    if (targetSess && targetSess !== "0") {
      for (const row of rows) {
        if (row.sess === targetSess && row.pgid > 0) groups.add(row.pgid);
      }
    }
  } catch {}
  return [...groups];
}

function signalGroups(sessionId: number, groups: number[], signal: NodeJS.Signals): void {
  for (const pgrp of groups) {
    if (pgrp === sessionId) continue;
    if (signal !== "SIGKILL" && signal !== "SIGCONT") {
      try {
        process.kill(-pgrp, "SIGCONT");
      } catch {}
    }
    try {
      process.kill(-pgrp, signal);
    } catch {}
  }
  if (signal !== "SIGKILL" && signal !== "SIGCONT") {
    try {
      process.kill(-sessionId, "SIGCONT");
    } catch {}
  }
  try {
    process.kill(-sessionId, signal);
  } catch {}
}

export function killSessionSync(sessionId: number, signal: NodeJS.Signals, activeTargetPgid?: number): void {
  if (process.platform === "linux") {
    signalGroups(sessionId, sessionGroupsLinux(sessionId), signal);
    return;
  }
  signalGroups(sessionId, activeTargetPgid !== undefined && activeTargetPgid !== sessionId ? [activeTargetPgid] : [], signal);
}

export function killSession(sessionId: number, signal: NodeJS.Signals): void | Promise<void> {
  if (process.platform === "linux") {
    signalGroups(sessionId, sessionGroupsLinux(sessionId), signal);
    return;
  }
  return sessionGroups(sessionId).then((groups) => signalGroups(sessionId, groups, signal));
}

export async function hasOtherGroupMember(): Promise<boolean> {
  const self = process.pid;
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
        if (Number(fields[3]) === self || Number(fields[2]) === self) return true;
      }
      return false;
    } catch {
      return true;
    }
  }
  try {
    const ps = Bun.spawn(["ps", "-Ao", "pid=,pgid=,sess="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (code !== 0) return true;
    const rows: Array<{ pid: number; pgid: number; sess: string }> = [];
    let selfSess: string | undefined;
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const pgid = Number(parts[1]);
      const sess = parts[2]!;
      if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue;
      rows.push({ pid, pgid, sess });
      if (pid === self) selfSess = sess;
    }
    for (const row of rows) {
      if (row.pid === self || row.pid === ps.pid) continue;
      if (row.pgid === self || (selfSess && selfSess !== "0" && row.sess === selfSess)) return true;
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
  let normalCleanupStarted = false;
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
    const killed = host.killGroup("SIGKILL");
    if (killed && typeof (killed as Promise<void>).then === "function") {
      void (killed as Promise<void>).finally(() => exit(143));
      return;
    }
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
      if (leaderDone && normalCleanupStarted) {
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
      if (finished || stop) return settled;
      if (!hasMembers) {
        exit(code);
        return settled;
      }
    }
    if (stop) return settled;
    normalCleanupStarted = true;
    armHard();
    forwardGroup("SIGTERM");
    host.reportCleanup();
  }
  return settled;
}

if (import.meta.main) {
  const handlers = new Map<StopSignal, () => void>();
  const pendingStops: StopSignal[] = [];
  const stopSet = new Set<StopSignal>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
  const dispatchStop = (sig: StopSignal) => {
    const fn = handlers.get(sig);
    if (fn) fn();
    else pendingStops.push(sig);
  };
  let command: string[] = [];
  let cleanupGraceMs = graceMs;
  let controlFd: number | undefined;
  try {
    const raw = Bun.argv[2] ?? (await Bun.stdin.text());
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) {
      command = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { command?: unknown }).command)) {
      const record = parsed as { command: unknown[]; graceMs?: unknown; controlFd?: unknown };
      if (record.command.every((arg) => typeof arg === "string")) command = record.command as string[];
      if (typeof record.graceMs === "number" && record.graceMs >= 0) cleanupGraceMs = record.graceMs;
      if (typeof record.controlFd === "number" && Number.isInteger(record.controlFd) && record.controlFd >= 3) controlFd = record.controlFd;
    }
  } catch {}
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      if (controlFd !== undefined) return;
      const fn = handlers.get(sig);
      if (fn) fn();
      else process.exit(128);
    });
  }
  if (controlFd !== undefined) {
    void (async () => {
      try {
        const reader = Bun.file(controlFd).stream().getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl).trim() as StopSignal;
            buf = buf.slice(nl + 1);
            if (stopSet.has(line)) dispatchStop(line);
          }
        }
      } catch {}
    })();
  }
  await supervise(command, {
    spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal) => killSession(process.pid, signal),
    hasGroupMembers: hasOtherGroupMember,
    timer: realTimer,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      for (let i = pendingStops.length - 1; i >= 0; i--) {
        if (pendingStops[i] === signal) {
          pendingStops.splice(i, 1);
          handler();
        }
      }
    },
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
