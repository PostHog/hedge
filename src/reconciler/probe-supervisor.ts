import { closeSync, readdirSync, readFileSync, writeSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;
export const tagEnvVar = "HEDGE_SUPERVISOR_TAG";

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

type ProcTargets = { pids: number[]; groups: number[]; orphanPids: number[] };

function hasEnvTagLinux(pid: number, marker: string): boolean {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    return raw === marker || raw.startsWith(`${marker}\0`) || raw.includes(`\0${marker}\0`) || raw.endsWith(`\0${marker}`);
  } catch {
    return false;
  }
}

export function discoverTargetsLinux(sessionId?: number, tag?: string): ProcTargets {
  const self = process.pid;
  const rows: Array<{ pid: number; ppid: number; pgrp: number; sid: number }> = [];
  const matched = new Set<number>();
  if (sessionId !== undefined) matched.add(sessionId);
  const marker = tag ? `${tagEnvVar}=${tag}` : undefined;
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
      } catch {
        continue;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen === -1) continue;
      const fields = stat.slice(closeParen + 2).split(" ");
      const ppid = Number(fields[1]);
      const pgrp = Number(fields[2]);
      const sid = Number(fields[3]);
      rows.push({ pid, ppid, pgrp, sid });
      if (sessionId !== undefined && (sid === sessionId || pgrp === sessionId)) {
        matched.add(pid);
      } else if (marker && pid !== self && hasEnvTagLinux(pid, marker)) {
        matched.add(pid);
      }
    }
  } catch {}
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!matched.has(row.pid) && matched.has(row.ppid)) {
        matched.add(row.pid);
        grew = true;
      }
    }
  }
  const pids: number[] = [];
  const groups = new Set<number>();
  const orphanPids: number[] = [];
  for (const row of rows) {
    if (!matched.has(row.pid) || row.pid === self || row.pid === sessionId) continue;
    pids.push(row.pid);
    if (sessionId === undefined) {
      orphanPids.push(row.pid);
    } else if (row.pgrp > 0 && row.pgrp !== sessionId && row.pgrp !== self) {
      groups.add(row.pgrp);
    } else if (row.pgrp !== sessionId) {
      orphanPids.push(row.pid);
    }
  }
  return { pids, groups: [...groups], orphanPids };
}

const psLookupLimitMs = 200;

async function runBoundedPs(args: string[]): Promise<{ pid: number; text: string } | undefined> {
  let ps: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    ps = Bun.spawn(["ps", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: psLookupLimitMs, killSignal: "SIGKILL" });
    const stream = ps.stdout as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let timedOut = false;
    const readAll = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch {}
    })();
    const finished = await Promise.race([
      Promise.all([readAll, ps.exited]).then(([, code]) => code === 0),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            ps?.kill("SIGKILL");
          } catch {}
          void reader.cancel().catch(() => {});
          resolve(false);
        }, psLookupLimitMs + 50);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut || !finished) return undefined;
    return { pid: ps.pid, text };
  } catch {
    if (timer) clearTimeout(timer);
    try {
      ps?.kill("SIGKILL");
    } catch {}
    return undefined;
  }
}

export async function discoverTargets(sessionId?: number, tag?: string): Promise<ProcTargets | undefined> {
  if (process.platform === "linux") return discoverTargetsLinux(sessionId, tag);
  const self = process.pid;
  const [treeRes, envRes] = await Promise.all([
    runBoundedPs(["-Ao", "pid=,ppid=,pgid="]),
    tag ? runBoundedPs(["ewwax"]) : Promise.resolve(undefined),
  ]);
  if (!treeRes && !envRes) return undefined;
  const rows: Array<{ pid: number; ppid: number; pgid: number }> = [];
  const matched = new Set<number>();
  if (sessionId !== undefined) matched.add(sessionId);
  if (treeRes) {
    for (const line of treeRes.text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgid = Number(parts[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
      if (pid === treeRes.pid || pid === envRes?.pid) continue;
      rows.push({ pid, ppid, pgid });
      if (sessionId !== undefined && pgid === sessionId) matched.add(pid);
    }
  }
  if (tag && envRes) {
    const token = `${tagEnvVar}=${tag}`;
    for (const line of envRes.text.split("\n")) {
      const idx = line.indexOf(token);
      if (idx === -1) continue;
      const before = idx > 0 ? line[idx - 1] : " ";
      const after = idx + token.length < line.length ? line[idx + token.length] : " ";
      if (!/\s/.test(before!) || !/\s/.test(after!)) continue;
      const pidMatch = line.trimStart().match(/^(\d+)\s/);
      if (!pidMatch) continue;
      const pid = Number(pidMatch[1]);
      if (Number.isFinite(pid) && pid !== self && pid !== envRes.pid && pid !== treeRes?.pid) matched.add(pid);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!matched.has(row.pid) && matched.has(row.ppid)) {
        matched.add(row.pid);
        grew = true;
      }
    }
  }
  const pids = [...matched].filter((pid) => pid !== self && pid !== sessionId);
  const groups = new Set<number>();
  const pgidByPid = new Map<number, number>();
  for (const row of rows) pgidByPid.set(row.pid, row.pgid);
  const orphanPids: number[] = [];
  for (const pid of pids) {
    const pgid = pgidByPid.get(pid);
    if (sessionId === undefined) {
      orphanPids.push(pid);
    } else if (pgid !== undefined && pgid > 0 && pgid !== sessionId && pgid !== self) {
      groups.add(pgid);
    } else if (pgid !== sessionId) {
      orphanPids.push(pid);
    }
  }
  return { pids, groups: [...groups], orphanPids };
}

function signalOneGroup(pgrp: number, signal: NodeJS.Signals): void {
  if (signal !== "SIGKILL" && signal !== "SIGCONT") {
    try {
      process.kill(-pgrp, "SIGCONT");
    } catch {}
  }
  try {
    process.kill(-pgrp, signal);
  } catch {}
}

function signalOnePid(pid: number, signal: NodeJS.Signals): void {
  if (signal !== "SIGKILL" && signal !== "SIGCONT") {
    try {
      process.kill(pid, "SIGCONT");
    } catch {}
  }
  try {
    process.kill(pid, signal);
  } catch {}
}

export function signalTargets(targets: ProcTargets, signal: NodeJS.Signals, sessionId?: number): void {
  for (const pgrp of targets.groups) {
    if (pgrp === sessionId) continue;
    signalOneGroup(pgrp, signal);
  }
  for (const pid of targets.orphanPids) {
    if (pid === sessionId || pid === process.pid) continue;
    signalOnePid(pid, signal);
  }
  if (sessionId !== undefined) signalOneGroup(sessionId, signal);
}

export function killSessionSync(sessionId: number | undefined, signal: NodeJS.Signals, activeTargetPgid?: number, tag?: string): void {
  if (process.platform === "linux") {
    signalTargets(discoverTargetsLinux(sessionId, tag), signal, sessionId);
    return;
  }
  const groups = activeTargetPgid !== undefined && activeTargetPgid !== sessionId ? [activeTargetPgid] : [];
  signalTargets({ pids: [], groups, orphanPids: [] }, signal, sessionId);
}

export function killSession(sessionId: number | undefined, signal: NodeJS.Signals, tag?: string): void | Promise<void> {
  if (process.platform === "linux") {
    signalTargets(discoverTargetsLinux(sessionId, tag), signal, sessionId);
    return;
  }
  if (signal !== "SIGKILL" && sessionId !== undefined) {
    signalOneGroup(sessionId, signal);
    return discoverTargets(sessionId, tag).then((targets) => {
      if (targets) signalTargets(targets, signal);
    });
  }
  return discoverTargets(sessionId, tag).then((targets) => signalTargets(targets ?? { pids: [], groups: [], orphanPids: [] }, signal, sessionId));
}

export async function hasOtherGroupMember(tag?: string): Promise<boolean> {
  const targets = await discoverTargets(process.pid, tag);
  return targets === undefined ? true : targets.pids.length > 0;
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
      dispatchStop("SIGTERM");
    })();
  }
  const runTag = process.env[tagEnvVar] || undefined;
  await supervise(command, {
    spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal) => killSession(process.pid, signal, runTag),
    hasGroupMembers: () => hasOtherGroupMember(runTag),
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
