import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, existsSync, readdirSync, readFileSync, readSync, writeSync } from "node:fs";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;
export const tagEnvVar = "HEDGE_SUPERVISOR_TAG";

export function appendTag(existing: string | undefined, tag: string): string {
  return existing ? `${existing},${tag}` : tag;
}

export function ownTag(value: string | undefined): string | undefined {
  const last = value?.split(",").at(-1)?.trim();
  return last || undefined;
}

export function watchdogEnv(): Record<string, string> {
  const clean: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "BUN_OPTIONS" || value === undefined) continue;
    clean[key] = value;
  }
  return clean;
}

export function supervisorEnv(fullTag: string): Record<string, string> {
  const clean = watchdogEnv();
  clean[tagEnvVar] = fullTag;
  return clean;
}

export type SupervisorHost = {
  spawn: (command: string[]) => { pid?: number; exited: Promise<number>; kill?: (signal?: NodeJS.Signals) => void };
  killGroup: (signal: NodeJS.Signals, includeTagged?: boolean) => void | Promise<void>;
  hasGroupMembers?: (targetPid?: number) => Promise<boolean> | boolean;
  timer: Timer;
  onSignal: (signal: StopSignal, handler: () => void) => void;
  reportTarget?: (pid: number) => void;
  reportStop?: () => void;
  reportResult: (code: number) => void;
  reportCleanup: () => void;
  exit: (code: number) => void;
};

type ProcTargets = { pids: number[]; groups: number[]; orphanPids: number[]; hasSessionGroup?: boolean; leaderSeenLive?: boolean };

function envMatchesTag(value: string, tag: string): boolean {
  return value.split(",").includes(tag);
}

function envMatchesAnyTag(value: string, tags: Set<string>): boolean {
  for (const part of value.split(",")) {
    if (tags.has(part)) return true;
  }
  return false;
}

function readEnvTagLinux(pid: number): string | undefined {
  const prefix = `${tagEnvVar}=`;
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length) || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

let linuxPrctl: ((option: number, arg2: number, arg3: number, arg4: number, arg5: number) => number) | null | undefined;

export function enableChildSubreaper(): void {
  if (process.platform !== "linux") return;
  if (linuxPrctl === undefined) {
    try {
      const lib = dlopen("libc.so.6", {
        prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      });
      linuxPrctl = (option, a2, a3, a4, a5) => lib.symbols.prctl(option, a2, a3, a4, a5);
    } catch {
      linuxPrctl = null;
    }
  }
  try {
    linuxPrctl?.(36, 1, 0, 0, 0);
  } catch {}
}

type PosixLib = {
  poll: (fds: ReturnType<typeof ptr>, nfds: number, timeout: number) => number;
  pipe: (fds: ReturnType<typeof ptr>) => number;
  fcntl: (fd: number, cmd: number, arg: number) => number;
};

let posixLib: PosixLib | null | undefined;

function getPosixLib(): PosixLib | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (posixLib === undefined) {
    try {
      const libName = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
      const nfdsType = process.platform === "darwin" ? FFIType.u32 : FFIType.u64;
      const lib = dlopen(libName, {
        poll: { args: [FFIType.pointer, nfdsType, FFIType.i32], returns: FFIType.i32 },
        pipe: { args: [FFIType.pointer], returns: FFIType.i32 },
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      posixLib = {
        poll: (fds, nfds, timeout) => lib.symbols.poll(fds, nfds, timeout),
        pipe: (fds) => lib.symbols.pipe(fds),
        fcntl: (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg),
      };
    } catch {
      posixLib = null;
    }
  }
  return posixLib;
}

export function createPipe(): { readFd: number; writeFd: number } | undefined {
  const lib = getPosixLib();
  if (!lib) return undefined;
  const fds = new Int32Array(2);
  if (lib.pipe(ptr(fds)) !== 0) return undefined;
  return { readFd: fds[0]!, writeFd: fds[1]! };
}

export function setCloexec(fd: number, enabled: boolean): void {
  const lib = getPosixLib();
  if (!lib) return;
  try {
    lib.fcntl(fd, 2, enabled ? 1 : 0);
  } catch {}
}

function pollFd(fd: number): number | undefined {
  const lib = getPosixLib();
  if (!lib) return undefined;
  const raw = new Uint8Array(8);
  const view = new DataView(raw.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, 0x0001, true);
  view.setInt16(6, 0, true);
  const ready = lib.poll(ptr(raw), 1, 0);
  if (ready < 0) return undefined;
  return ready === 0 ? 0 : view.getInt16(6, true);
}

export function probeResultReported(fd: number): "reported" | "closed" | "pending" {
  const drained = drainControlFd(fd);
  if (drained.lines.includes("1") || drained.rest.includes("1")) return "reported";
  if (drained.closed) return "closed";
  return "pending";
}

const groupShieldSignals: NodeJS.Signals[] = [
  "SIGUSR1",
  "SIGUSR2",
  "SIGALRM",
  "SIGPIPE",
  "SIGVTALRM",
  "SIGPROF",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGWINCH",
  "SIGURG",
  "SIGIO",
  "SIGPWR",
  "SIGSYS",
  "SIGTRAP",
  "SIGABRT",
];

export function shieldGroupSignals(): void {
  for (const sig of groupShieldSignals) {
    try {
      process.on(sig, () => {});
    } catch {}
  }
}

export function drainControlFd(fd: number): { lines: string[]; rest: string; closed: boolean } {
  const lines: string[] = [];
  let rest = "";
  let closed = false;
  const chunk = Buffer.allocUnsafe(256);
  const decoder = new TextDecoder();
  for (;;) {
    const revents = pollFd(fd);
    if (revents === undefined || revents === 0) break;
    if (revents & 0x0001) {
      let n = 0;
      try {
        n = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        closed = true;
        break;
      }
      if (n <= 0) {
        closed = true;
        break;
      }
      rest += decoder.decode(chunk.subarray(0, n), { stream: true });
      for (let nl = rest.indexOf("\n"); nl !== -1; nl = rest.indexOf("\n")) {
        lines.push(rest.slice(0, nl).trim());
        rest = rest.slice(nl + 1);
      }
    } else if (revents & (0x0010 | 0x0008 | 0x0020)) {
      closed = true;
      break;
    } else {
      break;
    }
  }
  if (closed && rest.trim()) {
    lines.push(rest.trim());
    rest = "";
  }
  return { lines, rest, closed };
}

export function discoverTargetsLinux(sessionId?: number, tag?: string, deadLeaderReaped?: boolean): ProcTargets {
  const self = process.pid;
  const includeDetached = Boolean(tag);
  const rows: Array<{ pid: number; ppid: number; pgrp: number; sid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  const activeTags = new Set<string>(tag ? [tag] : []);
  let leaderSeenLive = false;
  if (sessionId !== undefined) matched.add(sessionId);
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
      const state = fields[0];
      if (deadLeaderReaped !== undefined && sessionId !== undefined && pid === sessionId) {
        if (deadLeaderReaped || (state !== "Z" && state !== "X" && state !== "x")) leaderSeenLive = true;
      }
      if (!includeDetached && state === "Z" && Number(fields[17]) <= 1) continue;
      const ppid = Number(fields[1]);
      const pgrp = Number(fields[2]);
      const sid = Number(fields[3]);
      const envTag = tag && pid !== self ? readEnvTagLinux(pid) : undefined;
      rows.push({ pid, ppid, pgrp, sid, ...(envTag ? { envTag } : {}) });
      if (sessionId !== undefined && (sid === sessionId || pgrp === sessionId)) {
        matched.add(pid);
      } else if (tag && envTag && envMatchesTag(envTag, tag)) {
        matched.add(pid);
      }
    }
  } catch {}
  if (includeDetached || sessionId === undefined) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (matched.has(row.pid) && row.envTag) {
          const nested = ownTag(row.envTag);
          if (nested && !activeTags.has(nested)) {
            activeTags.add(nested);
            grew = true;
          }
        }
      }
      for (const row of rows) {
        if (matched.has(row.pid)) continue;
        if (row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        } else if (matched.has(row.ppid)) {
          const foreignCompleted = Boolean(tag && row.envTag && !envMatchesAnyTag(row.envTag, activeTags));
          if (!foreignCompleted) {
            matched.add(row.pid);
            grew = true;
          }
        }
      }
    }
  }
  const pids: number[] = [];
  const groups = new Set<number>();
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const row of rows) {
    if (!matched.has(row.pid) || row.pid === self || row.pid === sessionId) continue;
    pids.push(row.pid);
    if (sessionId === undefined) {
      orphanPids.push(row.pid);
    } else if (row.pgrp > 0 && row.pgrp !== sessionId && row.pgrp !== self) {
      groups.add(row.pgrp);
    } else if (row.pgrp === sessionId) {
      hasSessionGroup = true;
    } else {
      orphanPids.push(row.pid);
    }
  }
  return { pids, groups: [...groups], orphanPids, hasSessionGroup, leaderSeenLive };
}

const psLookupLimitMs = 200;
const psBin = existsSync("/bin/ps") ? "/bin/ps" : existsSync("/usr/bin/ps") ? "/usr/bin/ps" : "ps";

const tagPrefixBytes = new TextEncoder().encode(`${tagEnvVar}=`);

function procArgs2EnvTag(buf: Uint8Array): string | undefined {
  if (buf.byteLength < 4) return undefined;
  const argc = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(0, true);
  if (argc < 0) return undefined;
  let pos = 4;
  while (pos < buf.byteLength && buf[pos] !== 0) pos++;
  while (pos < buf.byteLength && buf[pos] === 0) pos++;
  for (let i = 0; i < argc; i++) {
    if (pos >= buf.byteLength) return undefined;
    while (pos < buf.byteLength && buf[pos] !== 0) pos++;
    pos++;
  }
  const decoder = new TextDecoder();
  while (pos < buf.byteLength) {
    if (buf[pos] === 0) {
      pos++;
      continue;
    }
    const start = pos;
    while (pos < buf.byteLength && buf[pos] !== 0) pos++;
    if (pos - start > tagPrefixBytes.byteLength) {
      let match = true;
      for (let j = 0; j < tagPrefixBytes.byteLength; j++) {
        if (buf[start + j] !== tagPrefixBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) return decoder.decode(buf.subarray(start + tagPrefixBytes.byteLength, pos)) || undefined;
    }
    pos++;
  }
  return undefined;
}

type DarwinLib = {
  getsid: (pid: number) => number;
  getpgid: (pid: number) => number;
  proc_listallpids: (buf: ReturnType<typeof ptr> | null, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buf: ReturnType<typeof ptr>, size: number) => number;
  sysctl: (
    name: ReturnType<typeof ptr>,
    namelen: number,
    oldp: ReturnType<typeof ptr> | null,
    oldlenp: ReturnType<typeof ptr>,
    newp: ReturnType<typeof ptr> | null,
    newlen: number,
  ) => number;
};

let darwinLib: DarwinLib | null | undefined;
let darwinProcArgsBuf: Uint8Array | undefined;

function getDarwinLib(): DarwinLib | null {
  if (process.platform !== "darwin") return null;
  if (darwinLib === undefined) {
    try {
      const lib = dlopen("libSystem.B.dylib", {
        getsid: { args: [FFIType.i32], returns: FFIType.i32 },
        getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
        proc_listallpids: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
        sysctl: {
          args: [FFIType.pointer, FFIType.u32, FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.u64],
          returns: FFIType.i32,
        },
      });
      darwinLib = {
        getsid: (pid) => lib.symbols.getsid(pid),
        getpgid: (pid) => lib.symbols.getpgid(pid),
        proc_listallpids: (buf, size) => lib.symbols.proc_listallpids(buf, size),
        proc_pidinfo: (pid, flavor, arg, buf, size) => lib.symbols.proc_pidinfo(pid, flavor, arg, buf, size),
        sysctl: (name, namelen, oldp, oldlenp, newp, newlen) => lib.symbols.sysctl(name, namelen, oldp, oldlenp, newp, newlen),
      };
    } catch {
      darwinLib = null;
    }
  }
  return darwinLib;
}

function getDarwinProcArgsBuf(lib: DarwinLib): Uint8Array {
  if (!darwinProcArgsBuf) {
    let size = 1024 * 1024;
    const mib = new Int32Array([1, 8]);
    const argMax = new Int32Array(1);
    const len = new BigUint64Array([4n]);
    if (lib.sysctl(ptr(mib), 2, ptr(argMax), ptr(len), null, 0) === 0 && argMax[0]! > 0) {
      size = Math.min(4 * 1024 * 1024, Math.max(65536, argMax[0]!));
    }
    darwinProcArgsBuf = new Uint8Array(size);
  }
  return darwinProcArgsBuf;
}

function readEnvTagDarwin(pid: number): string | undefined {
  const lib = getDarwinLib();
  if (!lib) return undefined;
  const buf = getDarwinProcArgsBuf(lib);
  const mib = new Int32Array([1, 49, pid]);
  const sizeBuf = new BigUint64Array(1);
  sizeBuf[0] = BigInt(buf.byteLength);
  if (lib.sysctl(ptr(mib), 3, ptr(buf), ptr(sizeBuf), null, 0) === 0) {
    const written = Number(sizeBuf[0]);
    if (written > 0 && written < buf.byteLength) {
      return procArgs2EnvTag(buf.subarray(0, written));
    }
  }
  sizeBuf[0] = 0n;
  if (lib.sysctl(ptr(mib), 3, null, ptr(sizeBuf), null, 0) !== 0) return undefined;
  const needed = Number(sizeBuf[0]);
  if (needed <= 0 || needed > 4 * 1024 * 1024) return undefined;
  const big = new Uint8Array(needed);
  sizeBuf[0] = BigInt(needed);
  if (lib.sysctl(ptr(mib), 3, ptr(big), ptr(sizeBuf), null, 0) !== 0) return undefined;
  return procArgs2EnvTag(big.subarray(0, Number(sizeBuf[0])));
}

function sessionIdDarwin(pid: number): number | undefined {
  const lib = getDarwinLib();
  if (!lib) return undefined;
  const sid = lib.getsid(pid);
  return sid > 0 ? sid : undefined;
}

function buildTargetsFromPs(
  self: number,
  sessionId: number | undefined,
  tag: string | undefined,
  treeText: string | undefined,
  excludePids: Set<number>,
): ProcTargets {
  const includeDetached = Boolean(tag);
  const rows: Array<{ pid: number; ppid: number; pgid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  const activeTags = new Set<string>(tag ? [tag] : []);
  if (sessionId !== undefined) matched.add(sessionId);
  if (treeText) {
    for (const line of treeText.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgid = Number(parts[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
      if (excludePids.has(pid)) continue;
      const envTag = tag && pid !== self ? readEnvTagDarwin(pid) : undefined;
      rows.push({ pid, ppid, pgid, ...(envTag ? { envTag } : {}) });
      if (sessionId !== undefined && (pgid === sessionId || sessionIdDarwin(pid) === sessionId)) {
        matched.add(pid);
      } else if (tag && envTag && envMatchesTag(envTag, tag)) {
        matched.add(pid);
      }
    }
  }
  if (includeDetached || sessionId === undefined) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (matched.has(row.pid) && row.envTag) {
          const nested = ownTag(row.envTag);
          if (nested && !activeTags.has(nested)) {
            activeTags.add(nested);
            grew = true;
          }
        }
      }
      for (const row of rows) {
        if (matched.has(row.pid)) continue;
        if (row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        } else if (matched.has(row.ppid)) {
          const foreignCompleted = Boolean(tag && row.envTag && !envMatchesAnyTag(row.envTag, activeTags));
          if (!foreignCompleted) {
            matched.add(row.pid);
            grew = true;
          }
        }
      }
    }
  }
  const pids = [...matched].filter((pid) => pid !== self && pid !== sessionId);
  const groups = new Set<number>();
  const pgidByPid = new Map<number, number>();
  for (const row of rows) pgidByPid.set(row.pid, row.pgid);
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const pid of pids) {
    const pgid = pgidByPid.get(pid);
    if (sessionId === undefined) {
      orphanPids.push(pid);
    } else if (pgid !== undefined && pgid > 0 && pgid !== sessionId && pgid !== self) {
      groups.add(pgid);
    } else if (pgid === sessionId) {
      hasSessionGroup = true;
    } else {
      orphanPids.push(pid);
    }
  }
  return { pids, groups: [...groups], orphanPids, hasSessionGroup };
}

function psPidStat(treeText: string, targetPid: number): string | undefined {
  for (const line of treeText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (Number(parts[0]) === targetPid) return parts[3];
  }
  return undefined;
}

function pidExistsByKill(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function pidStateLinux(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return undefined;
    return stat.slice(closeParen + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

function isDeadLeaderRecycledLinux(pid: number, reaped: boolean): boolean {
  const state = pidStateLinux(pid);
  if (state === undefined) return pidExistsByKill(pid);
  if (reaped) return true;
  return state !== "Z" && state !== "X" && state !== "x";
}

function isDeadLeaderRecycledDarwin(lib: DarwinLib, pid: number, reaped: boolean, inPidList?: boolean): boolean {
  if (inPidList === false) return false;
  if (inPidList === undefined && !pidExistsByKill(pid)) return false;
  if (reaped) return true;
  const buf = new Uint8Array(136);
  const n = lib.proc_pidinfo(pid, 3, 0n, ptr(buf), 136);
  if (n < 8) return pidExistsByKill(pid);
  const status = new DataView(buf.buffer).getUint32(4, true);
  return status !== 5;
}

function discoverTargetsSync(sessionId?: number, tag?: string, deadLeaderReaped?: boolean): ProcTargets | undefined {
  if (process.platform === "linux") return discoverTargetsLinux(sessionId, tag, deadLeaderReaped);
  if (sessionId === undefined && !tag) return undefined;
  const lib = getDarwinLib();
  if (!lib) return undefined;
  const count = lib.proc_listallpids(null, 0);
  if (count <= 0) return undefined;
  const capacity = Math.max(count + 256, count * 2);
  const buf = new Int32Array(capacity);
  const actual = lib.proc_listallpids(ptr(buf), buf.byteLength);
  if (actual <= 0) return undefined;
  const self = process.pid;
  const limit = Math.min(actual, capacity);
  let effectiveSessionId = sessionId;
  if (deadLeaderReaped !== undefined && sessionId !== undefined) {
    let leaderPresent = false;
    for (let i = 0; i < limit; i++) {
      if (buf[i] === sessionId) {
        leaderPresent = true;
        break;
      }
    }
    if (isDeadLeaderRecycledDarwin(lib, sessionId, deadLeaderReaped, leaderPresent)) {
      effectiveSessionId = undefined;
    }
    if (effectiveSessionId === undefined && !tag) return { pids: [], groups: [], orphanPids: [], hasSessionGroup: false };
  }
  const activeTags = new Set<string>(tag ? [tag] : []);
  const rows: Array<{ pid: number; sid: number; pgid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  for (let i = 0; i < limit; i++) {
    const pid = buf[i]!;
    if (pid <= 0 || pid === self || pid === effectiveSessionId) continue;
    const sid = lib.getsid(pid);
    const pgid = lib.getpgid(pid);
    const envTag = tag ? readEnvTagDarwin(pid) : undefined;
    rows.push({ pid, sid, pgid, ...(envTag ? { envTag } : {}) });
    const inSession = effectiveSessionId !== undefined && (sid === effectiveSessionId || pgid === effectiveSessionId);
    if (inSession || (tag && envTag && envMatchesTag(envTag, tag))) {
      matched.add(pid);
    }
  }
  if (tag) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (matched.has(row.pid) && row.envTag) {
          const nested = ownTag(row.envTag);
          if (nested && !activeTags.has(nested)) {
            activeTags.add(nested);
            grew = true;
          }
        }
      }
      for (const row of rows) {
        if (!matched.has(row.pid) && row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        }
      }
    }
  }
  if (deadLeaderReaped !== undefined && effectiveSessionId !== undefined && isDeadLeaderRecycledDarwin(lib, effectiveSessionId, deadLeaderReaped)) {
    return tag ? discoverTargetsSync(undefined, tag) : { pids: [], groups: [], orphanPids: [], hasSessionGroup: false };
  }
  const pids: number[] = [];
  const groups = new Set<number>();
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const row of rows) {
    if (!matched.has(row.pid)) continue;
    pids.push(row.pid);
    if (effectiveSessionId === undefined) {
      orphanPids.push(row.pid);
    } else if (row.pgid > 0 && row.pgid !== effectiveSessionId && row.pgid !== self) {
      groups.add(row.pgid);
    } else if (row.pgid === effectiveSessionId) {
      hasSessionGroup = true;
    } else {
      orphanPids.push(row.pid);
    }
  }
  return { pids, groups: [...groups], orphanPids, hasSessionGroup };
}

async function runBoundedPs(args: string[]): Promise<{ pid: number; text: string } | undefined> {
  let ps: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    ps = Bun.spawn([psBin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: psLookupLimitMs, killSignal: "SIGKILL" });
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
  const treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid="]);
  if (!treeRes) return discoverTargetsSync(sessionId, tag);
  return buildTargetsFromPs(process.pid, sessionId, tag, treeRes.text, new Set([treeRes.pid]));
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

function signalDeadTargets(targets: ProcTargets, deadSessionId?: number, guard?: () => boolean): void {
  for (const pgrp of targets.groups) {
    if (pgrp === deadSessionId) continue;
    if (guard && !guard()) return;
    signalOneGroup(pgrp, "SIGKILL");
  }
  for (const pid of targets.pids) {
    if (pid === deadSessionId || pid === process.pid) continue;
    if (guard && !guard()) return;
    signalOnePid(pid, "SIGKILL");
  }
  if (deadSessionId !== undefined && targets.hasSessionGroup) {
    if (guard && !guard()) return;
    signalOneGroup(deadSessionId, "SIGKILL");
  }
}

function sweepDeadLinux(deadSessionId: number, tag: string | undefined, reaped: boolean): void {
  if (isDeadLeaderRecycledLinux(deadSessionId, reaped)) {
    if (tag) signalDeadTargets(discoverTargetsLinux(undefined, tag), undefined);
    return;
  }
  const targets = discoverTargetsLinux(deadSessionId, tag, reaped);
  if (targets.leaderSeenLive || isDeadLeaderRecycledLinux(deadSessionId, reaped)) {
    if (tag) signalDeadTargets(discoverTargetsLinux(undefined, tag), undefined);
    return;
  }
  signalDeadTargets(targets, deadSessionId, () => !isDeadLeaderRecycledLinux(deadSessionId, reaped));
}

export function killDeadSessionSync(deadSessionId: number, tag?: string, reaped = false): void {
  if (process.platform === "linux") {
    sweepDeadLinux(deadSessionId, tag, reaped);
    return;
  }
  const found = discoverTargetsSync(deadSessionId, tag, reaped);
  if (!found) return;
  const lib = getDarwinLib();
  if (lib && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped)) {
    const tagged = tag ? discoverTargetsSync(undefined, tag) : undefined;
    if (tagged) signalDeadTargets(tagged, undefined);
    return;
  }
  signalDeadTargets(found, deadSessionId, lib ? () => !isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped) : undefined);
}

export function killDeadSession(deadSessionId: number, tag?: string, reaped = false): void | Promise<void> {
  if (process.platform === "linux") {
    if (!reaped && isDeadLeaderRecycledLinux(deadSessionId, false)) {
      return Bun.sleep(15).then(() => sweepDeadLinux(deadSessionId, tag, reaped));
    }
    sweepDeadLinux(deadSessionId, tag, reaped);
    return;
  }
  return (async () => {
    let treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid=,stat="]);
    if (!treeRes) {
      killDeadSessionSync(deadSessionId, tag, reaped);
      return;
    }
    let stat = psPidStat(treeRes.text, deadSessionId);
    if (!reaped && stat !== undefined && !stat.includes("Z")) {
      await Bun.sleep(15);
      treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid=,stat="]);
      if (!treeRes) {
        killDeadSessionSync(deadSessionId, tag, reaped);
        return;
      }
      stat = psPidStat(treeRes.text, deadSessionId);
    }
    const lib = getDarwinLib();
    const recycled = (stat !== undefined && (reaped || !stat.includes("Z"))) || (lib !== null && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped));
    const sid = recycled ? undefined : deadSessionId;
    if (sid === undefined && !tag) return;
    const targets = buildTargetsFromPs(process.pid, sid, tag, treeRes.text, new Set([treeRes.pid]));
    if (sid !== undefined && lib && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped)) {
      if (tag) signalDeadTargets(buildTargetsFromPs(process.pid, undefined, tag, treeRes.text, new Set([treeRes.pid])), undefined);
      return;
    }
    signalDeadTargets(targets, sid, sid !== undefined && lib ? () => !isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped) : undefined);
  })();
}

export function killSessionSync(sessionId: number | undefined, signal: NodeJS.Signals, tag?: string): void {
  signalTargets(discoverTargetsSync(sessionId, tag) ?? { pids: [], groups: [], orphanPids: [] }, signal, sessionId);
}

export function killSession(
  sessionId: number | undefined,
  signal: NodeJS.Signals,
  tag?: string,
  remembered?: Map<number, number>,
): void | Promise<void> {
  if (process.platform === "linux") {
    signalTargets(discoverTargetsLinux(sessionId, tag), signal, sessionId);
    return;
  }
  return discoverTargets(sessionId, tag).then((found) => {
    const targets: ProcTargets = found
      ? { pids: [...found.pids], groups: [...found.groups], orphanPids: [...found.orphanPids] }
      : { pids: [], groups: [], orphanPids: [] };
    const lib = getDarwinLib();
    if (remembered && lib) {
      for (const pid of targets.pids) {
        const pgid = lib.getpgid(pid);
        if (pgid > 0 && pgid !== sessionId && pgid !== process.pid) remembered.set(pid, pgid);
      }
      const seenGroups = new Set(targets.groups);
      const seenOrphans = new Set(targets.orphanPids);
      for (const [pid, savedPgid] of remembered) {
        const currentPgid = lib.getpgid(pid);
        if (currentPgid !== savedPgid) {
          remembered.delete(pid);
          continue;
        }
        if (sessionId === undefined) {
          if (!seenOrphans.has(pid)) {
            seenOrphans.add(pid);
            targets.orphanPids.push(pid);
          }
        } else if (!seenGroups.has(savedPgid)) {
          seenGroups.add(savedPgid);
          targets.groups.push(savedPgid);
        }
      }
    }
    signalTargets(targets, signal, sessionId);
  });
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
  let resultReported = false;
  let normalCleanupStarted = false;
  let finished = false;
  let cancelInterrupt: (() => void) | undefined;
  let cancelHard: (() => void) | undefined;
  let armEpoch = 0;
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
    const killed = host.killGroup("SIGKILL", Boolean(stop) && !resultReported);
    if (killed && typeof (killed as Promise<void>).then === "function") {
      void (killed as Promise<void>).finally(() => exit(143));
      return;
    }
    exit(143);
  };

  const forwardGroup = (name: StopSignal, afterSend?: () => void) => {
    const myEpoch = armEpoch;
    const runAfter = () => {
      if (!finished && armEpoch === myEpoch) afterSend?.();
    };
    if (forwarded.has(name)) {
      runAfter();
      return;
    }
    forwarded.add(name);
    const sent = host.killGroup(name, Boolean(stop) && !resultReported);
    if (sent && typeof (sent as Promise<void>).then === "function") {
      void (sent as Promise<void>).finally(runAfter);
      return;
    }
    runAfter();
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
        forwardGroup("SIGTERM", armHard);
      });
    }
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    host.onSignal(sig, () => {
      if (forwarded.has(sig)) return;
      if (!stop) {
        stop = sig;
        if (!leaderDone) host.reportStop?.();
      }
      if (!target) return exit(128);
      if (leaderDone && resultReported) {
        if (!normalCleanupStarted) {
          normalCleanupStarted = true;
          forwardGroup(sig, () => arm(sig));
          host.reportCleanup();
        } else if (sig === "SIGTERM" || sig === "SIGHUP") {
          forwardGroup(sig, armHard);
        } else {
          armEpoch++;
          cancelHard?.();
          cancelHard = undefined;
          forwardGroup(sig, () => arm(sig));
        }
        return;
      }
      forwardGroup(sig, () => arm(sig));
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
    forwardGroup(stop, () => arm(stop!));
  }

  const code = await target.exited;
  leaderDone = true;
  if (finished) return settled;
  if (!stop) {
    resultReported = true;
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
    forwardGroup("SIGTERM", armHard);
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
  let targetEnv: Record<string, string | undefined> | undefined;
  let cleanupGraceMs = graceMs;
  let controlFd: number | undefined;
  let resultFd: number | undefined;
  try {
    const raw = Bun.argv[2] ?? (await Bun.stdin.text());
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) {
      command = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { command?: unknown }).command)) {
      const record = parsed as { command: unknown[]; env?: unknown; graceMs?: unknown; controlFd?: unknown; resultFd?: unknown };
      if (record.command.every((arg) => typeof arg === "string")) command = record.command as string[];
      if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
        const cleanEnv: Record<string, string> = Object.create(null);
        for (const [k, v] of Object.entries(record.env as Record<string, unknown>)) {
          if (typeof v === "string") cleanEnv[k] = v;
        }
        targetEnv = cleanEnv;
      }
      if (typeof record.graceMs === "number" && record.graceMs >= 0) cleanupGraceMs = record.graceMs;
      if (typeof record.controlFd === "number" && Number.isInteger(record.controlFd) && record.controlFd >= 3) controlFd = record.controlFd;
      if (typeof record.resultFd === "number" && Number.isInteger(record.resultFd) && record.resultFd >= 3) resultFd = record.resultFd;
    }
  } catch {}
  if (controlFd !== undefined) setCloexec(controlFd, true);
  if (resultFd !== undefined) setCloexec(resultFd, true);
  const markResultFd = () => {
    if (resultFd === undefined) return;
    const fd = resultFd;
    resultFd = undefined;
    try {
      writeSync(fd, "1\n");
    } catch {}
    try {
      closeSync(fd);
    } catch {}
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      if (controlFd !== undefined) return;
      const fn = handlers.get(sig);
      if (fn) fn();
      else process.exit(128);
    });
  }
  shieldGroupSignals();
  let controlInitialBuf = "";
  if (controlFd !== undefined) {
    const drained = drainControlFd(controlFd);
    controlInitialBuf = drained.rest;
    for (const line of drained.lines) {
      if (stopSet.has(line as StopSignal)) dispatchStop(line as StopSignal);
    }
    if (drained.closed && pendingStops.length === 0) dispatchStop("SIGTERM");
  }
  if (pendingStops.length > 0) {
    try {
      writeSync(1, "stopped\n");
    } catch {}
    process.exit(128);
  }
  if (controlFd !== undefined) {
    void (async () => {
      try {
        const reader = Bun.file(controlFd).stream().getReader();
        const decoder = new TextDecoder();
        let buf = controlInitialBuf;
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
  enableChildSubreaper();
  const runTag = ownTag(process.env[tagEnvVar]);
  const rememberedDetached = new Map<number, number>();
  await supervise(command, {
    spawn: (argv) => Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio: ["ignore", "ignore", "ignore"] }),
    killGroup: (signal, includeTagged) =>
      killSession(process.pid, signal, includeTagged ? runTag : undefined, includeTagged ? rememberedDetached : undefined),
    hasGroupMembers: () => hasOtherGroupMember(),
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
    reportStop: () => {
      try {
        writeSync(1, "stopped\n");
      } catch {}
    },
    reportResult: (code) => {
      markResultFd();
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
