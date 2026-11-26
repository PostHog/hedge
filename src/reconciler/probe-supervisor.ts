import { dlopen, FFIType, ptr } from "bun:ffi";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, read, readdirSync, readFileSync, readSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunScript } from "../runner/bun.ts";

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT";
export type Timer = (ms: number, fire: () => void) => () => void;

export const graceMs = 150;
export const interruptGraceMs = 300;
export const tagEnvVar = "HEDGE_SUPERVISOR_TAG";
export const spareEnvVar = "HEDGE_SUPERVISOR_SPARE";
export const probeGraceEnvVar = "HEDGE_PROBE_GRACE_MS";

export function encodeSpareLine(filePath: string): string {
  return `${JSON.stringify(filePath)}\n`;
}

export function parseSpareLine(line: string): string | undefined {
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readFdChunk(fd: number, buf: Uint8Array): Promise<number> {
  return new Promise((resolve) => {
    read(fd, buf, 0, buf.byteLength, null, (error, bytesRead) => {
      resolve(error ? 0 : bytesRead);
    });
  });
}

function canUseSpareDir(dir: string): boolean {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
  }
  let current = dirname(dir);
  for (;;) {
    try {
      const info = statSync(current);
      if (!info.isDirectory()) return false;
      accessSync(current, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function spareFilePath(tag: string, home?: string): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "u";
  const dirName = `hedge-sup-${uid}`;
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (dir: string) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      candidates.push(dir);
    }
  };
  add(join(tmpdir(), dirName));
  if (home) add(join(home, ".local", "state", "hedge", `sup-${uid}`));
  if (process.env.HOME && process.env.HOME !== home) add(join(process.env.HOME, ".local", "state", "hedge", `sup-${uid}`));
  add(join("/tmp", dirName));
  add(join("/var/tmp", dirName));
  if (process.platform === "linux") add(join("/dev/shm", dirName));
  for (const dir of candidates) {
    if (canUseSpareDir(dir)) return join(dir, `${tag}.spare`);
  }
  return join(tmpdir(), dirName, `${tag}.spare`);
}

function isOwnedDirectory(dir: string): boolean {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

export type SpareRecordResult = { ok: true } | { ok: false; error: string; code?: string };

export function recordSparedProcess(filePath: string, pids: number[], sids: number[]): SpareRecordResult {
  if (!pids.length && !sids.length) return { ok: true };
  const dir = dirname(filePath);
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const lines: string[] = [];
  for (const pid of new Set(pids)) if (Number.isInteger(pid) && pid > 0) lines.push(`pid:${pid}`);
  for (const sid of new Set(sids)) if (Number.isInteger(sid) && sid > 0) lines.push(`sid:${sid}`);
  if (!lines.length) return { ok: true };
  const payload = new TextEncoder().encode(lines.join("\n") + "\n");
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!isOwnedDirectory(dir)) return { ok: false, error: `spare directory ${dir} is not owned by the current user`, code: "EPERM" };
      const fd = openSync(filePath, flags, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return { ok: false, error: `spare path ${filePath} is not a regular file`, code: "EPERM" };
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          return { ok: false, error: `spare file ${filePath} is not owned by the current user`, code: "EPERM" };
        }
        let offset = 0;
        while (offset < payload.byteLength) {
          const written = writeSync(fd, payload, offset, payload.byteLength - offset);
          if (written <= 0) return { ok: false, error: `short write to spare file ${filePath}`, code: "EIO" };
          offset += written;
        }
        return { ok: true };
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT" && attempt < 3) continue;
      return { ok: false, error: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) };
    }
  }
  return { ok: false, error: `could not record spared processes in ${filePath}`, code: "ENOENT" };
}

export type SparedSet = { pids: Set<number>; sids: Set<number> };
export type SpareInput = string | SparedSet | undefined;
export type SpareReadResult = { ok: true; spared: SparedSet } | { ok: false };

const emptySparedSet = (): SparedSet => ({ pids: new Set<number>(), sids: new Set<number>() });

export function readSparedChecked(filePath: string | undefined): SpareReadResult {
  if (!filePath) return { ok: true, spared: emptySparedSet() };
  const dir = dirname(filePath);
  try {
    const dirInfo = lstatSync(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return { ok: true, spared: emptySparedSet() };
    if (typeof process.getuid === "function" && dirInfo.uid !== process.getuid()) return { ok: true, spared: emptySparedSet() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? { ok: true, spared: emptySparedSet() } : { ok: false };
  }
  const pids = new Set<number>();
  const sids = new Set<number>();
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(filePath, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: true, spared: { pids, sids } };
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return { ok: true, spared: { pids, sids } };
    const raw = readFileSync(fd, "utf8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("pid:")) {
        const n = Number(line.slice(4));
        if (Number.isInteger(n) && n > 0) pids.add(n);
      } else if (line.startsWith("sid:")) {
        const n = Number(line.slice(4));
        if (Number.isInteger(n) && n > 0) sids.add(n);
      }
    }
    return { ok: true, spared: { pids, sids } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ELOOP") return { ok: true, spared: { pids, sids } };
    return { ok: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function readSpared(filePath: SpareInput): SparedSet {
  if (filePath && typeof filePath !== "string") return filePath;
  const res = readSparedChecked(filePath);
  return res.ok ? res.spared : emptySparedSet();
}

function resolveSpareInput(sparePath: SpareInput): { spared: SparedSet; unreadable: boolean } {
  if (sparePath && typeof sparePath !== "string") return { spared: sparePath, unreadable: false };
  const res = readSparedChecked(sparePath);
  return res.ok ? { spared: res.spared, unreadable: false } : { spared: emptySparedSet(), unreadable: true };
}

export function removeSpareFile(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    rmSync(filePath, { force: true });
  } catch {}
  try {
    rmdirSync(dirname(filePath));
  } catch {}
}

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

type ProcTargets = { pids: number[]; groups: number[]; orphanPids: number[]; sids?: number[]; hasSessionGroup?: boolean; leaderSeenLive?: boolean };

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
  socketpair: (domain: number, type: number, protocol: number, fds: ReturnType<typeof ptr>) => number;
  fcntl: (fd: number, cmd: number, arg: number) => number;
  dup2: (oldfd: number, newfd: number) => number;
  posix_spawn: (
    pid: ReturnType<typeof ptr>,
    path: ReturnType<typeof ptr>,
    fileActions: null,
    attr: ReturnType<typeof ptr>,
    argv: ReturnType<typeof ptr>,
    envp: ReturnType<typeof ptr>,
  ) => number;
  posix_spawnattr_init: (attr: ReturnType<typeof ptr>) => number;
  posix_spawnattr_destroy: (attr: ReturnType<typeof ptr>) => number;
  posix_spawnattr_setflags: (attr: ReturnType<typeof ptr>, flags: number) => number;
  posix_spawnattr_setpgroup: (attr: ReturnType<typeof ptr>, pgroup: number) => number;
  posix_spawnattr_setsigmask: (attr: ReturnType<typeof ptr>, mask: ReturnType<typeof ptr>) => number;
  posix_spawnattr_setsigdefault: (attr: ReturnType<typeof ptr>, mask: ReturnType<typeof ptr>) => number;
  waitpid: (pid: number, status: ReturnType<typeof ptr>, options: number) => number;
  strerror: (errnum: number) => string;
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
        socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.pointer], returns: FFIType.i32 },
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        posix_spawn: {
          args: [FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer],
          returns: FFIType.i32,
        },
        posix_spawnattr_init: { args: [FFIType.pointer], returns: FFIType.i32 },
        posix_spawnattr_destroy: { args: [FFIType.pointer], returns: FFIType.i32 },
        posix_spawnattr_setflags: { args: [FFIType.pointer, FFIType.i16], returns: FFIType.i32 },
        posix_spawnattr_setpgroup: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
        posix_spawnattr_setsigmask: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
        posix_spawnattr_setsigdefault: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
        waitpid: { args: [FFIType.i32, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
        strerror: { args: [FFIType.i32], returns: FFIType.cstring },
      });
      posixLib = {
        poll: (fds, nfds, timeout) => lib.symbols.poll(fds, nfds, timeout),
        pipe: (fds) => lib.symbols.pipe(fds),
        socketpair: (domain, type, protocol, fds) => lib.symbols.socketpair(domain, type, protocol, fds),
        fcntl: (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg),
        dup2: (oldfd, newfd) => lib.symbols.dup2(oldfd, newfd),
        posix_spawn: (pid, path, fileActions, attr, argv, envp) => lib.symbols.posix_spawn(pid, path, fileActions, attr, argv, envp),
        posix_spawnattr_init: (attr) => lib.symbols.posix_spawnattr_init(attr),
        posix_spawnattr_destroy: (attr) => lib.symbols.posix_spawnattr_destroy(attr),
        posix_spawnattr_setflags: (attr, flags) => lib.symbols.posix_spawnattr_setflags(attr, flags),
        posix_spawnattr_setpgroup: (attr, pgroup) => lib.symbols.posix_spawnattr_setpgroup(attr, pgroup),
        posix_spawnattr_setsigmask: (attr, mask) => lib.symbols.posix_spawnattr_setsigmask(attr, mask),
        posix_spawnattr_setsigdefault: (attr, mask) => lib.symbols.posix_spawnattr_setsigdefault(attr, mask),
        waitpid: (pid, status, options) => lib.symbols.waitpid(pid, status, options),
        strerror: (errnum) => String(lib.symbols.strerror(errnum) ?? ""),
      };
    } catch {
      posixLib = null;
    }
  }
  return posixLib;
}

const commonErrnoCodes: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  7: "E2BIG",
  8: "ENOEXEC",
  12: "ENOMEM",
  13: "EACCES",
  20: "ENOTDIR",
  21: "EISDIR",
  23: "ENFILE",
  24: "EMFILE",
  26: "ETXTBSY",
};

const platformErrnoCodes: Record<number, string> =
  process.platform === "darwin" ? { 35: "EAGAIN", 62: "ELOOP", 63: "ENAMETOOLONG" } : { 11: "EAGAIN", 36: "ENAMETOOLONG", 40: "ELOOP" };

export type OwnGroupChild = {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
};

export function spawnInOwnGroup(argv: string[], env?: Record<string, string>): OwnGroupChild | undefined {
  const lib = getPosixLib();
  if (!lib) return undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.includes("\0")) {
      const err = new TypeError(`The argument 'args[${i}]' must be a string without null bytes.`) as NodeJS.ErrnoException;
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
  }
  const envPairs = env
    ? Object.entries(env)
    : Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [k, v] of envPairs) {
    if (k.includes("\0") || v.includes("\0")) {
      const err = new TypeError(`The property 'options.env[${JSON.stringify(k)}]' must be a string without null bytes.`) as NodeJS.ErrnoException;
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
  }
  const cmd = argv[0];
  if (!cmd) {
    const err = new Error(`Executable not found: ${JSON.stringify(cmd ?? "")}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  let execPath: string;
  if (cmd.includes("/")) {
    execPath = cmd;
  } else {
    const searchPath = env?.PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    const found = Bun.which(cmd, { PATH: searchPath });
    if (!found) {
      const err = new Error(`Executable not found in $PATH: "${cmd}"`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    execPath = found;
  }
  const enc = new TextEncoder();
  const keep: Uint8Array[] = [];
  const toCString = (value: string): bigint => {
    const buf = enc.encode(`${value}\0`);
    keep.push(buf);
    return BigInt(ptr(buf));
  };
  const pathBuf = enc.encode(`${execPath}\0`);
  keep.push(pathBuf);
  const argvPtrs = new BigUint64Array(argv.length + 1);
  for (let i = 0; i < argv.length; i++) argvPtrs[i] = toCString(argv[i]!);
  argvPtrs[argv.length] = 0n;
  const envPtrs = new BigUint64Array(envPairs.length + 1);
  for (let i = 0; i < envPairs.length; i++) envPtrs[i] = toCString(`${envPairs[i]![0]}=${envPairs[i]![1]}`);
  envPtrs[envPairs.length] = 0n;

  const attr = new Uint8Array(512);
  const sigsetSize = process.platform === "darwin" ? 4 : 128;
  const emptyMask = new Uint8Array(sigsetSize);
  const fullMask = new Uint8Array(sigsetSize).fill(0xff);
  const pidOut = new Int32Array(1);
  const statusBuf = new Int32Array(1);
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let done = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let spawnedPid = 0;
  const tryReap = () => {
    if (done || spawnedPid <= 0) return;
    const w = lib.waitpid(spawnedPid, ptr(statusBuf), 1);
    if (w === spawnedPid || w < 0) {
      done = true;
      process.off("SIGCHLD", onChld);
      if (poll) {
        clearInterval(poll);
        poll = undefined;
      }
      if (w < 0) {
        resolveExit(128);
        return;
      }
      const st = statusBuf[0]!;
      const sig = st & 0x7f;
      resolveExit(sig === 0 ? (st >> 8) & 0xff : 128 + sig);
    }
  };
  const onChld = () => tryReap();
  process.on("SIGCHLD", onChld);

  let rc = -1;
  if (lib.posix_spawnattr_init(ptr(attr)) !== 0) {
    process.off("SIGCHLD", onChld);
    return undefined;
  }
  try {
    lib.posix_spawnattr_setflags(ptr(attr), 0x02 | 0x04 | 0x08);
    lib.posix_spawnattr_setpgroup(ptr(attr), 0);
    lib.posix_spawnattr_setsigmask(ptr(attr), ptr(emptyMask));
    lib.posix_spawnattr_setsigdefault(ptr(attr), ptr(fullMask));
    rc = lib.posix_spawn(ptr(pidOut), ptr(pathBuf), null, ptr(attr), ptr(argvPtrs), ptr(envPtrs));
  } finally {
    lib.posix_spawnattr_destroy(ptr(attr));
  }
  void keep.length;
  if (rc !== 0) {
    process.off("SIGCHLD", onChld);
    const err = new Error(lib.strerror(rc) || `posix_spawn failed (${rc})`) as NodeJS.ErrnoException;
    const code = commonErrnoCodes[rc] ?? platformErrnoCodes[rc];
    if (code) err.code = code;
    throw err;
  }
  spawnedPid = pidOut[0]!;
  tryReap();
  if (!done) poll = setInterval(tryReap, 25);
  return {
    pid: spawnedPid,
    exited,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (done) return;
      try {
        process.kill(spawnedPid, signal);
      } catch {}
    },
  };
}

export function redirectStdioOutputsToNull(): void {
  const lib = getPosixLib();
  if (lib) {
    let devNull: number | undefined;
    try {
      devNull = openSync("/dev/null", "w");
      lib.dup2(devNull, 1);
      lib.dup2(devNull, 2);
      return;
    } catch {
    } finally {
      if (devNull !== undefined) {
        try {
          closeSync(devNull);
        } catch {}
      }
    }
  }
  try {
    closeSync(1);
  } catch {}
  try {
    closeSync(2);
  } catch {}
}

export function createPipe(): { readFd: number; writeFd: number } | undefined {
  const lib = getPosixLib();
  if (!lib) return undefined;
  const fds = new Int32Array(2);
  if (lib.pipe(ptr(fds)) !== 0) return undefined;
  return { readFd: fds[0]!, writeFd: fds[1]! };
}

export function createSocketPair(): { parentFd: number; childFd: number } | undefined {
  const lib = getPosixLib();
  if (!lib) return undefined;
  const fds = new Int32Array(2);
  if (lib.socketpair(1, 1, 0, ptr(fds)) !== 0) return undefined;
  return { parentFd: fds[0]!, childFd: fds[1]! };
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

export async function waitForFdClosed(fd: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (drainControlFd(fd).closed) return;
    await Bun.sleep(5);
  }
}

export function discoverTargetsLinux(
  sessionId?: number,
  tag?: string,
  deadLeaderReaped?: boolean,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): ProcTargets {
  const self = process.pid;
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  const includeDetached = Boolean(effectiveTag);
  const rows: Array<{ pid: number; ppid: number; pgrp: number; sid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  const activeTags = new Set<string>(effectiveTag ? [effectiveTag] : []);
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
      const envTag = effectiveTag && pid !== self ? readEnvTagLinux(pid) : undefined;
      rows.push({ pid, ppid, pgrp, sid, ...(envTag ? { envTag } : {}) });
      const isSpared = spared.pids.has(pid) || (sid !== sessionId && sid !== self && spared.sids.has(sid));
      const inScope = sessionId !== undefined && (ownGroupOnly ? pgrp === sessionId : sid === sessionId || pgrp === sessionId);
      if (!isSpared && inScope) {
        matched.add(pid);
      } else if (!isSpared && effectiveTag && envTag && envMatchesTag(envTag, effectiveTag)) {
        matched.add(pid);
      }
    }
  } catch {}
  if (includeDetached || (!blockDetached && sessionId === undefined)) {
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
        const isSpared = spared.pids.has(row.pid) || (row.sid !== sessionId && row.sid !== self && spared.sids.has(row.sid));
        if (isSpared) continue;
        if (row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        } else if (matched.has(row.ppid)) {
          const foreignCompleted = Boolean(
            effectiveTag && row.envTag && row.sid !== sessionId && row.sid !== self && !envMatchesAnyTag(row.envTag, activeTags),
          );
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
  const sids = new Set<number>();
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const row of rows) {
    if (!matched.has(row.pid) || row.pid === self || row.pid === sessionId) continue;
    pids.push(row.pid);
    if (row.sid > 0 && row.sid !== sessionId && row.sid !== self) sids.add(row.sid);
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
  return { pids, groups: [...groups], orphanPids, sids: [...sids], hasSessionGroup, leaderSeenLive };
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
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): ProcTargets {
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  const includeDetached = Boolean(effectiveTag);
  const rows: Array<{ pid: number; ppid: number; pgid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  const activeTags = new Set<string>(effectiveTag ? [effectiveTag] : []);
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
      const envTag = effectiveTag && pid !== self ? readEnvTagDarwin(pid) : undefined;
      rows.push({ pid, ppid, pgid, ...(envTag ? { envTag } : {}) });
      const sid = sessionIdDarwin(pid);
      const isSpared = spared.pids.has(pid) || (sid !== undefined && sid > 0 && sid !== sessionId && sid !== self && spared.sids.has(sid));
      const inScope = sessionId !== undefined && (ownGroupOnly ? pgid === sessionId : pgid === sessionId || sid === sessionId);
      if (!isSpared && inScope) {
        matched.add(pid);
      } else if (!isSpared && effectiveTag && envTag && envMatchesTag(envTag, effectiveTag)) {
        matched.add(pid);
      }
    }
  }
  if (includeDetached || (!blockDetached && sessionId === undefined)) {
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
        const sid = sessionIdDarwin(row.pid);
        const isSpared = spared.pids.has(row.pid) || (sid !== undefined && sid > 0 && sid !== sessionId && sid !== self && spared.sids.has(sid));
        if (isSpared) continue;
        if (row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        } else if (matched.has(row.ppid)) {
          const foreignCompleted = Boolean(
            effectiveTag && row.envTag && sid !== undefined && sid > 0 && sid !== sessionId && sid !== self && !envMatchesAnyTag(row.envTag, activeTags),
          );
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
  const sids = new Set<number>();
  const pgidByPid = new Map<number, number>();
  for (const row of rows) pgidByPid.set(row.pid, row.pgid);
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const pid of pids) {
    const sid = sessionIdDarwin(pid);
    if (sid !== undefined && sid > 0 && sid !== sessionId && sid !== self) sids.add(sid);
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
  return { pids, groups: [...groups], orphanPids, sids: [...sids], hasSessionGroup };
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

function ppidDarwin(lib: DarwinLib, pid: number): number {
  const buf = new Uint8Array(136);
  const n = lib.proc_pidinfo(pid, 3, 0n, ptr(buf), 136);
  return n >= 20 ? new DataView(buf.buffer).getUint32(16, true) : 0;
}

export function discoverTargetsSync(
  sessionId?: number,
  tag?: string,
  deadLeaderReaped?: boolean,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): ProcTargets | undefined {
  if (process.platform === "linux") return discoverTargetsLinux(sessionId, tag, deadLeaderReaped, sparePath, ownGroupOnly, skipDetached);
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  if (sessionId === undefined && !effectiveTag) return undefined;
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
    if (effectiveSessionId === undefined && !effectiveTag) return { pids: [], groups: [], orphanPids: [], sids: [], hasSessionGroup: false };
  }
  const activeTags = new Set<string>(effectiveTag ? [effectiveTag] : []);
  const rows: Array<{ pid: number; ppid: number; sid: number; pgid: number; envTag?: string }> = [];
  const matched = new Set<number>();
  if (effectiveSessionId !== undefined) matched.add(effectiveSessionId);
  for (let i = 0; i < limit; i++) {
    const pid = buf[i]!;
    if (pid <= 0 || pid === self || pid === effectiveSessionId) continue;
    const ppid = effectiveTag || (!blockDetached && effectiveSessionId === undefined) ? ppidDarwin(lib, pid) : 0;
    const sid = lib.getsid(pid);
    const pgid = lib.getpgid(pid);
    const envTag = effectiveTag ? readEnvTagDarwin(pid) : undefined;
    rows.push({ pid, ppid, sid, pgid, ...(envTag ? { envTag } : {}) });
    const isSpared = spared.pids.has(pid) || (sid > 0 && sid !== effectiveSessionId && sid !== self && spared.sids.has(sid));
    const inSession = effectiveSessionId !== undefined && (ownGroupOnly ? pgid === effectiveSessionId : sid === effectiveSessionId || pgid === effectiveSessionId);
    if (!isSpared && (inSession || (effectiveTag && envTag && envMatchesTag(envTag, effectiveTag)))) {
      matched.add(pid);
    }
  }
  if (effectiveTag || (!blockDetached && effectiveSessionId === undefined)) {
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
        const isSpared = spared.pids.has(row.pid) || (row.sid > 0 && row.sid !== effectiveSessionId && row.sid !== self && spared.sids.has(row.sid));
        if (isSpared) continue;
        if (row.envTag && envMatchesAnyTag(row.envTag, activeTags)) {
          matched.add(row.pid);
          grew = true;
        } else if (row.ppid > 0 && matched.has(row.ppid)) {
          const foreignCompleted = Boolean(
            effectiveTag && row.envTag && row.sid > 0 && row.sid !== effectiveSessionId && row.sid !== self && !envMatchesAnyTag(row.envTag, activeTags),
          );
          if (!foreignCompleted) {
            matched.add(row.pid);
            grew = true;
          }
        }
      }
    }
  }
  if (deadLeaderReaped !== undefined && effectiveSessionId !== undefined && isDeadLeaderRecycledDarwin(lib, effectiveSessionId, deadLeaderReaped)) {
    return effectiveTag ? discoverTargetsSync(undefined, effectiveTag, undefined, sparePath) : { pids: [], groups: [], orphanPids: [], sids: [], hasSessionGroup: false };
  }
  const pids: number[] = [];
  const groups = new Set<number>();
  const sids = new Set<number>();
  const orphanPids: number[] = [];
  let hasSessionGroup = false;
  for (const row of rows) {
    if (!matched.has(row.pid)) continue;
    pids.push(row.pid);
    if (row.sid > 0 && row.sid !== effectiveSessionId && row.sid !== self) sids.add(row.sid);
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
  return { pids, groups: [...groups], orphanPids, sids: [...sids], hasSessionGroup };
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

export async function discoverTargets(
  sessionId?: number,
  tag?: string,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): Promise<ProcTargets | undefined> {
  if (process.platform === "linux") return discoverTargetsLinux(sessionId, tag, undefined, sparePath, ownGroupOnly, skipDetached);
  const treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid="]);
  if (!treeRes) return discoverTargetsSync(sessionId, tag, undefined, sparePath, ownGroupOnly, skipDetached);
  return buildTargetsFromPs(process.pid, sessionId, tag, treeRes.text, new Set([treeRes.pid]), sparePath, ownGroupOnly, skipDetached);
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
  for (const pid of targets.orphanPids) {
    if (pid === deadSessionId || pid === process.pid) continue;
    if (guard && !guard()) return;
    signalOnePid(pid, "SIGKILL");
  }
  if (deadSessionId !== undefined && targets.hasSessionGroup) {
    if (guard && !guard()) return;
    signalOneGroup(deadSessionId, "SIGKILL");
  }
}

function sweepDeadLinux(
  deadSessionId: number,
  tag: string | undefined,
  reaped: boolean,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): void {
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  if (isDeadLeaderRecycledLinux(deadSessionId, reaped)) {
    if (effectiveTag) signalDeadTargets(discoverTargetsLinux(undefined, effectiveTag, undefined, spared), undefined);
    return;
  }
  const targets = discoverTargetsLinux(deadSessionId, effectiveTag, reaped, spared, ownGroupOnly, blockDetached);
  if (targets.leaderSeenLive || isDeadLeaderRecycledLinux(deadSessionId, reaped)) {
    if (effectiveTag) signalDeadTargets(discoverTargetsLinux(undefined, effectiveTag, undefined, spared), undefined);
    return;
  }
  signalDeadTargets(targets, deadSessionId, () => !isDeadLeaderRecycledLinux(deadSessionId, reaped));
}

export function killDeadSessionSync(
  deadSessionId: number,
  tag?: string,
  reaped = false,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): void {
  if (process.platform === "linux") {
    sweepDeadLinux(deadSessionId, tag, reaped, sparePath, ownGroupOnly, skipDetached);
    return;
  }
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  const found = discoverTargetsSync(deadSessionId, effectiveTag, reaped, spared, ownGroupOnly, blockDetached);
  if (!found) return;
  const lib = getDarwinLib();
  if (lib && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped)) {
    const tagged = effectiveTag ? discoverTargetsSync(undefined, effectiveTag, undefined, spared) : undefined;
    if (tagged) signalDeadTargets(tagged, undefined);
    return;
  }
  signalDeadTargets(found, deadSessionId, lib ? () => !isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped) : undefined);
}

export function killDeadSession(
  deadSessionId: number,
  tag?: string,
  reaped = false,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): void | Promise<void> {
  if (process.platform === "linux") {
    if (!reaped && isDeadLeaderRecycledLinux(deadSessionId, false)) {
      return Bun.sleep(15).then(() => sweepDeadLinux(deadSessionId, tag, reaped, sparePath, ownGroupOnly, skipDetached));
    }
    sweepDeadLinux(deadSessionId, tag, reaped, sparePath, ownGroupOnly, skipDetached);
    return;
  }
  const { spared, unreadable } = resolveSpareInput(sparePath);
  const blockDetached = ownGroupOnly || skipDetached || unreadable;
  const effectiveTag = blockDetached ? undefined : tag;
  return (async () => {
    let treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid=,stat="]);
    if (!treeRes) {
      killDeadSessionSync(deadSessionId, effectiveTag, reaped, spared, ownGroupOnly, blockDetached);
      return;
    }
    let stat = psPidStat(treeRes.text, deadSessionId);
    if (!reaped && stat !== undefined && !stat.includes("Z")) {
      await Bun.sleep(15);
      treeRes = await runBoundedPs(["-Ao", "pid=,ppid=,pgid=,stat="]);
      if (!treeRes) {
        killDeadSessionSync(deadSessionId, effectiveTag, reaped, spared, ownGroupOnly, blockDetached);
        return;
      }
      stat = psPidStat(treeRes.text, deadSessionId);
    }
    const lib = getDarwinLib();
    const recycled = (stat !== undefined && (reaped || !stat.includes("Z"))) || (lib !== null && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped));
    const sid = recycled ? undefined : deadSessionId;
    if (sid === undefined && !effectiveTag) return;
    const targets = buildTargetsFromPs(process.pid, sid, effectiveTag, treeRes.text, new Set([treeRes.pid]), spared, ownGroupOnly, blockDetached);
    if (sid !== undefined && lib && isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped)) {
      if (effectiveTag) signalDeadTargets(buildTargetsFromPs(process.pid, undefined, effectiveTag, treeRes.text, new Set([treeRes.pid]), spared), undefined);
      return;
    }
    signalDeadTargets(targets, sid, sid !== undefined && lib ? () => !isDeadLeaderRecycledDarwin(lib, deadSessionId, reaped) : undefined);
  })();
}

export function killSessionSync(
  sessionId: number | undefined,
  signal: NodeJS.Signals,
  tag?: string,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): void {
  signalTargets(discoverTargetsSync(sessionId, tag, undefined, sparePath, ownGroupOnly, skipDetached) ?? { pids: [], groups: [], orphanPids: [] }, signal, sessionId);
}

export function killSession(
  sessionId: number | undefined,
  signal: NodeJS.Signals,
  tag?: string,
  remembered?: Map<number, number>,
  sparePath?: SpareInput,
  ownGroupOnly = false,
  skipDetached = false,
): void | Promise<void> {
  if (process.platform === "linux") {
    signalTargets(discoverTargetsLinux(sessionId, tag, undefined, sparePath, ownGroupOnly, skipDetached), signal, sessionId);
    return;
  }
  return discoverTargets(sessionId, tag, sparePath, ownGroupOnly, skipDetached).then((found) => {
    const targets: ProcTargets = found
      ? { pids: [...found.pids], groups: [...found.groups], orphanPids: [...found.orphanPids] }
      : { pids: [], groups: [], orphanPids: [] };
    const lib = getDarwinLib();
    if (!ownGroupOnly && !skipDetached && remembered && lib) {
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

export async function hasOtherGroupMember(tag?: string, ownGroupOnly = !tag): Promise<boolean> {
  const targets = await discoverTargets(process.pid, tag, undefined, ownGroupOnly);
  return targets === undefined ? true : targets.pids.length > 0;
}

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export async function supervise(
  command: string[],
  host: SupervisorHost,
  cleanupGraceMs = graceMs,
  stopInterruptGraceMs = interruptGraceMs,
): Promise<number> {
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
      cancelInterrupt = host.timer(stopInterruptGraceMs, () => {
        cancelInterrupt = undefined;
        forwardGroup("SIGTERM", armHard);
      });
    }
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    host.onSignal(sig, () => {
      if (forwarded.has(sig) || (leaderDone && resultReported)) return;
      if (!stop) {
        stop = sig;
        if (!leaderDone) host.reportStop?.();
      }
      if (!target) return exit(128);
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
    exit(code);
    return settled;
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
  let stopInterruptGraceMs = interruptGraceMs;
  let controlFd: number | undefined;
  let resultFd: number | undefined;
  let spareFile: string | undefined;
  let spareFd: number | undefined;
  let spareTag: string | undefined;
  let spareHome: string | undefined;
  let holder = false;
  let guardFd: number | undefined;
  let holderFd: number | undefined;
  let holderExitFd: number | undefined;
  let innerResultFd: number | undefined;
  let clockFd: number | undefined;
  try {
    const raw = Bun.argv[2] ?? (await Bun.stdin.text());
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) {
      command = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { command?: unknown }).command)) {
      const record = parsed as {
        command: unknown[];
        env?: unknown;
        graceMs?: unknown;
        interruptGraceMs?: unknown;
        controlFd?: unknown;
        resultFd?: unknown;
        spareFile?: unknown;
        spareFd?: unknown;
        spareTag?: unknown;
        spareHome?: unknown;
        holder?: unknown;
        guardFd?: unknown;
        holderFd?: unknown;
        holderExitFd?: unknown;
        innerResultFd?: unknown;
        clockFd?: unknown;
      };
      if (record.command.every((arg) => typeof arg === "string")) command = record.command as string[];
      if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
        const cleanEnv: Record<string, string> = Object.create(null);
        for (const [k, v] of Object.entries(record.env as Record<string, unknown>)) {
          if (typeof v === "string") cleanEnv[k] = v;
        }
        targetEnv = cleanEnv;
      }
      if (typeof record.graceMs === "number" && record.graceMs >= 0) cleanupGraceMs = record.graceMs;
      if (typeof record.interruptGraceMs === "number" && record.interruptGraceMs >= 0) stopInterruptGraceMs = record.interruptGraceMs;
      if (typeof record.controlFd === "number" && Number.isInteger(record.controlFd) && record.controlFd >= 3) controlFd = record.controlFd;
      if (typeof record.resultFd === "number" && Number.isInteger(record.resultFd) && record.resultFd >= 3) resultFd = record.resultFd;
      if (typeof record.spareFile === "string" && record.spareFile) spareFile = record.spareFile;
      if (typeof record.spareFd === "number" && Number.isInteger(record.spareFd) && record.spareFd >= 3) spareFd = record.spareFd;
      if (typeof record.spareTag === "string" && record.spareTag) spareTag = record.spareTag;
      if (typeof record.spareHome === "string" && record.spareHome) spareHome = record.spareHome;
      if (record.holder === true) holder = true;
      if (typeof record.guardFd === "number" && Number.isInteger(record.guardFd) && record.guardFd >= 3) guardFd = record.guardFd;
      if (typeof record.holderFd === "number" && Number.isInteger(record.holderFd) && record.holderFd >= 3) holderFd = record.holderFd;
      if (typeof record.holderExitFd === "number" && Number.isInteger(record.holderExitFd) && record.holderExitFd >= 3) holderExitFd = record.holderExitFd;
      if (typeof record.innerResultFd === "number" && Number.isInteger(record.innerResultFd) && record.innerResultFd >= 3) innerResultFd = record.innerResultFd;
      if (typeof record.clockFd === "number" && Number.isInteger(record.clockFd) && record.clockFd >= 3) clockFd = record.clockFd;
    }
  } catch {}
  if (spareFd !== undefined) setCloexec(spareFd, true);
  if (!spareFile && spareTag) {
    spareFile = spareFilePath(spareTag, spareHome);
    if (spareFd !== undefined) {
      try {
        writeSync(spareFd, encodeSpareLine(spareFile));
      } catch {}
      try {
        closeSync(spareFd);
      } catch {}
      spareFd = undefined;
    }
    const envObj: Record<string, string | undefined> = targetEnv ?? Object.create(null);
    if (!targetEnv) {
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) envObj[k] = v;
      targetEnv = envObj;
    }
    envObj[spareEnvVar] = spareFile;
  }
  if (spareFd !== undefined) {
    try {
      closeSync(spareFd);
    } catch {}
    spareFd = undefined;
  }
  if (!holder) {
    const envObj: Record<string, string | undefined> = targetEnv ?? Object.create(null);
    if (!targetEnv) {
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) envObj[k] = v;
      targetEnv = envObj;
    }
    envObj[probeGraceEnvVar] = String(cleanupGraceMs);
  }
  if (process.platform === "linux" && holder) {
    enableChildSubreaper();
    shieldGroupSignals();
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, () => {});
    if (holderExitFd !== undefined) setCloexec(holderExitFd, true);
    const closeFd = (fd: number | undefined) => {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {}
    };
    const holderAlive = createPipe();
    const innerResult = createPipe();
    if (holderAlive) setCloexec(holderAlive.writeFd, true);
    if (innerResult) setCloexec(innerResult.readFd, true);
    const extraFds: number[] = [];
    const addFd = (fd: number | undefined): number | undefined => {
      if (fd === undefined) return undefined;
      const index = 3 + extraFds.length;
      extraFds.push(fd);
      setCloexec(fd, false);
      return index;
    };
    const childControlFd = addFd(controlFd);
    const childResultFd = addFd(resultFd);
    const childGuardFd = addFd(guardFd);
    const childHolderFd = addFd(holderAlive?.readFd);
    const childInnerResultFd = addFd(innerResult?.writeFd);
    const childClockFd = addFd(clockFd);
    const innerPayload = {
      command,
      ...(targetEnv ? { env: targetEnv } : {}),
      graceMs: cleanupGraceMs,
      interruptGraceMs: stopInterruptGraceMs,
      ...(spareFile ? { spareFile } : {}),
      ...(childControlFd !== undefined ? { controlFd: childControlFd } : {}),
      ...(childResultFd !== undefined ? { resultFd: childResultFd } : {}),
      ...(childGuardFd !== undefined ? { guardFd: childGuardFd } : {}),
      ...(childHolderFd !== undefined ? { holderFd: childHolderFd } : {}),
      ...(childInnerResultFd !== undefined ? { innerResultFd: childInnerResultFd } : {}),
      ...(childClockFd !== undefined ? { clockFd: childClockFd } : {}),
    };
    const runTag = spareTag ?? ownTag(process.env[tagEnvVar]);
    const innerEnv = runTag ? supervisorEnv(appendTag(process.env[tagEnvVar], runTag)) : watchdogEnv();
    let inner: ReturnType<typeof Bun.spawn> | undefined;
    try {
      inner = Bun.spawn(bunScript(import.meta.filename), {
        stdio: [new TextEncoder().encode(JSON.stringify(innerPayload)), 1, 2, ...extraFds],
        env: innerEnv,
        detached: true,
      });
    } catch {
      closeFd(holderAlive?.readFd);
      closeFd(holderAlive?.writeFd);
      closeFd(innerResult?.readFd);
      closeFd(innerResult?.writeFd);
      closeFd(controlFd);
      closeFd(resultFd);
      closeFd(guardFd);
      closeFd(clockFd);
      removeSpareFile(spareFile);
      process.exit(127);
    }
    closeFd(holderAlive?.readFd);
    closeFd(innerResult?.writeFd);
    closeFd(controlFd);
    closeFd(resultFd);
    closeFd(guardFd);
    closeFd(clockFd);
    redirectStdioOutputsToNull();
    const code = await inner.exited;
    const reported = innerResult ? probeResultReported(innerResult.readFd) === "reported" : false;
    closeFd(innerResult?.readFd);
    closeFd(holderAlive?.writeFd);
    if (reported) {
      removeSpareFile(spareFile);
      process.exit(inner.signalCode ? 137 : code);
    }
    killDeadSessionSync(inner.pid, runTag, true, spareFile);
    const adopted = discoverTargetsLinux(process.pid, runTag, undefined, spareFile);
    signalDeadTargets(adopted, process.pid);
    process.exit(inner.signalCode ? 137 : code);
  }
  if (controlFd !== undefined) setCloexec(controlFd, true);
  if (resultFd !== undefined) setCloexec(resultFd, true);
  if (guardFd !== undefined) setCloexec(guardFd, true);
  if (holderFd !== undefined) setCloexec(holderFd, true);
  if (innerResultFd !== undefined) setCloexec(innerResultFd, true);
  if (clockFd !== undefined) setCloexec(clockFd, true);
  const fdTimer = (fd: number): Timer => {
    const queue: Array<() => void> = [];
    let pendingTicks = 0;
    let closed = false;
    const drain = () => {
      while ((closed || pendingTicks > 0) && queue.length > 0) {
        if (pendingTicks > 0) pendingTicks--;
        const next = queue.shift();
        if (next) next();
      }
    };
    void (async () => {
      const chunk = new Uint8Array(64);
      for (;;) {
        const n = await readFdChunk(fd, chunk);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) {
          if (chunk[i] === 0x0a) pendingTicks++;
        }
        drain();
      }
      closed = true;
      drain();
    })();
    return (_ms, fire) => {
      let cancelled = false;
      const run = () => {
        if (!cancelled) fire();
      };
      if (closed || pendingTicks > 0) {
        if (pendingTicks > 0) pendingTicks--;
        queueMicrotask(run);
        return () => {
          cancelled = true;
        };
      }
      queue.push(run);
      return () => {
        cancelled = true;
        const idx = queue.indexOf(run);
        if (idx !== -1) queue.splice(idx, 1);
      };
    };
  };
  let reported = false;
  let targetHandle: { kill?: (signal?: NodeJS.Signals) => void } | undefined;
  const markResultFd = () => {
    reported = true;
    for (const fd of [resultFd, innerResultFd]) {
      if (fd === undefined) continue;
      try {
        writeSync(fd, "1\n");
      } catch {}
      try {
        closeSync(fd);
      } catch {}
    }
    resultFd = undefined;
    innerResultFd = undefined;
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
  enableChildSubreaper();
  const runTag = ownTag(process.env[tagEnvVar]);
  const onHolderDead = () => {
    if (reported) process.exit(0);
    const targets = discoverTargetsLinux(process.pid, runTag, undefined, spareFile, false);
    signalDeadTargets(targets, process.pid);
    if (targetHandle) {
      try {
        targetHandle.kill?.("SIGKILL");
      } catch {}
    }
    process.exit(137);
  };
  if (holderFd !== undefined) {
    try {
      writeSync(1, `runner:${process.pid}\n`);
    } catch {}
    const drainedHolder = drainControlFd(holderFd);
    if (drainedHolder.closed) onHolderDead();
    const watchHolderFd = holderFd;
    void (async () => {
      try {
        const chunk = new Uint8Array(64);
        while ((await readFdChunk(watchHolderFd, chunk)) > 0) {}
      } catch {}
      onHolderDead();
    })();
  }
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
    removeSpareFile(spareFile);
    process.exit(128);
  }
  if (controlFd !== undefined) {
    const watchControlFd = controlFd;
    void (async () => {
      try {
        const decoder = new TextDecoder();
        const chunk = new Uint8Array(256);
        let buf = controlInitialBuf;
        for (;;) {
          const n = await readFdChunk(watchControlFd, chunk);
          if (n <= 0) break;
          buf += decoder.decode(chunk.subarray(0, n), { stream: true });
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
  const rememberedDetached = new Map<number, number>();
  let stopReported = false;
  await supervise(command, {
    spawn: (argv) => {
      const child = Bun.spawn(argv, { ...(targetEnv ? { env: targetEnv } : {}), stdio: ["ignore", "ignore", "ignore"] });
      targetHandle = child;
      return child;
    },
    killGroup: (signal, includeTagged) =>
      killSession(process.pid, signal, includeTagged ? runTag : undefined, includeTagged ? rememberedDetached : undefined, spareFile, !includeTagged),
    hasGroupMembers: () => hasOtherGroupMember(),
    timer: clockFd !== undefined ? fdTimer(clockFd) : realTimer,
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
      stopReported = true;
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
      redirectStdioOutputsToNull();
    },
    exit: (code) => {
      if (holderFd === undefined && reported && !stopReported) removeSpareFile(spareFile);
      process.exit(code);
    },
  }, cleanupGraceMs, stopInterruptGraceMs);
}
