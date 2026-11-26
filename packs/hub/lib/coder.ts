import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, write, writeSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { boxPrefix } from "../../../src/hub/names.ts";
import { appendTag, createPipe, createSocketPair, killDeadSessionSync, killSessionSync, readFdChunk, setCloexec, spareEnvVar, supervisorEnv, tagEnvVar, watchdogEnv } from "../../../src/reconciler/probe-supervisor.ts";
import { bunScript } from "../../../src/runner/bun.ts";
import { heldLocks } from "./box-lock.ts";

const idleStopMs = 2 * 3_600_000;
const idleStatuses = new Set(["stopped", "failed", "canceled"]);
const tokenLifetime = "720h";
const tokenRenewWithinMs = 7 * 86_400_000;
const tokenScopes = ["coder:workspaces.create", "coder:workspaces.operate", "coder:workspaces.access", "coder:workspaces.delete", "user:read"];

export type Env = Record<string, string | undefined>;
export type Result = { code: number; stdout: string; stderr: string };
export type Box = { name: string; id: string; template: string; status: string; lastUsedAt: string };
export type Capture = (argv: string[], options: { env?: Env; stdin?: string; timeoutMs: number; inherit?: boolean }) => Promise<Result>;
export type Timer = (ms: number, fire: () => void) => () => void;
export type CoderOptions = { home: string; env: Env; coderUrl: string; template: string; capture?: Capture; fetch?: typeof fetch };
export type SessionSource = "environment" | "hedge" | "cli" | "none";
export type SessionKey = { rejected: true } | { rejected: false; expiresAt: number; lifetimeMs: number };

const sessionFiles = [["hedge", ".config/hedge/coder-session", ".config/hedge/coder-url"], ["cli", ".config/coderv2/session", ".config/coderv2/url"]] as const;
const sessionLimitMs = 10_000;

export function slugFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Cannot make a box name from '${name}'.`);
  if (slug.length <= 24) return slug;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 4);
  return `${slug.slice(0, 19).replace(/-+$/, "")}-${hash}`;
}

export const timedOut = 124;
export const coderLimitMs = 10 * 60_000;
const timeoutResult = (timeoutMs: number, stdout = ""): Result => ({ code: timedOut, stdout, stderr: `timed out after ${timeoutMs} ms` });

const realTimer: Timer = (ms, fire) => {
  const timeout = setTimeout(fire, Math.max(1, Math.ceil(ms)));
  return () => clearTimeout(timeout);
};

export const orphanGraceSeconds = 10;

function holdingLocks(argv: string[], locks: number[], timeoutMs: number, pathEnv = process.env.PATH ?? ""): string[] {
  if (!locks.length) return argv;
  const closed = locks.map((_, index) => `${index + 3}>&-`).join(" ");
  const needsMultiDigit = locks.length + 2 >= 10;
  const which = (name: string) => Bun.which(name, { PATH: pathEnv });
  const shell = needsMultiDigit ? (which("bash") ?? which("zsh") ?? which("ksh")) : "/bin/sh";
  if (!shell) {
    throw new Error(`cannot close ${locks.length} box lock descriptors without bash, zsh, or ksh`);
  }
  return [
    "timeout",
    "-s",
    "KILL",
    String(Math.ceil(timeoutMs / 1000) + orphanGraceSeconds),
    shell,
    "-c",
    `exec "$@" ${closed}`,
    "hedge-box-lock",
    ...argv,
  ];
}

const captureSupervisor = join(import.meta.dir, "capture-supervisor.ts");
const probeWatchdog = join(import.meta.dir, "../../../src/reconciler/probe-watchdog.ts");

async function readText(stream: ReadableStream<Uint8Array> | number | undefined, stop: AbortSignal): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  const reader = stream.getReader();
  const onStop = () => void reader.cancel().catch(() => {});
  stop.addEventListener("abort", onStop, { once: true });
  if (stop.aborted) onStop();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } catch (error) {
    if (!stop.aborted) throw error;
  } finally {
    stop.removeEventListener("abort", onStop);
  }
  return out;
}

const defaultSupervisorGraceMs = process.platform === "linux" ? 150 : 350;

const writeFd = (fd: number, data: Uint8Array, offset: number): Promise<number> =>
  new Promise((resolve, reject) => {
    write(fd, data, offset, data.byteLength - offset, null, (error, written) => {
      if (error) reject(error);
      else resolve(written);
    });
  });

function removeSpareAsync(filePath: string | undefined): void {
  if (!filePath) return;
  void rm(filePath, { force: true })
    .catch(() => {})
    .then(() => rmdir(dirname(filePath)).catch(() => {}));
}

function createResultReader(fd: number, stop: AbortSignal) {
  const decoder = new TextDecoder("utf-8");
  const chunk = new Uint8Array(1024);
  let buf = "";
  let eof = false;
  let active = false;
  let activeRead: Promise<void> = Promise.resolve();
  const nextLine = (): Promise<string> => {
    const readNext = (async () => {
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          return line;
        }
        if (eof) {
          const rest = buf + decoder.decode();
          buf = "";
          return rest;
        }
        active = true;
        let n = 0;
        try {
          n = await readFdChunk(fd, chunk);
        } finally {
          active = false;
        }
        if (n <= 0) {
          eof = true;
          const rest = buf + decoder.decode();
          buf = "";
          return rest;
        }
        buf += decoder.decode(chunk.subarray(0, n), { stream: true });
      }
    })();
    activeRead = readNext.then(
      () => {},
      () => {},
    );
    const aborted = new Promise<string>((resolve) => {
      if (stop.aborted) {
        resolve("");
        return;
      }
      stop.addEventListener("abort", () => resolve(""), { once: true });
    });
    return Promise.race([readNext, aborted]);
  };
  return {
    nextLine,
    get reading() {
      return active;
    },
    get done() {
      return activeRead;
    },
  };
}

const minimalSupEnvKeys = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "COMSPEC",
]);

function minimalSupervisorEnv(fullTag: string, inheritedSpare?: string): Record<string, string> {
  const clean: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "BUN_OPTIONS" || key === "HEDGE_CAPTURE_CONFIG" || key === tagEnvVar || key === spareEnvVar) continue;
    if (minimalSupEnvKeys.has(key) || key.startsWith("LC_") || key.startsWith("LD_") || key.startsWith("DYLD_") || key.startsWith("HEDGE_")) {
      clean[key] = value;
    }
  }
  clean[tagEnvVar] = fullTag;
  if (inheritedSpare) clean[spareEnvVar] = inheritedSpare;
  return clean;
}

function envByteSize(env: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(env)) {
    total += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
  }
  return total;
}

async function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function captureWith(timer: Timer, supervisorGraceMs = defaultSupervisorGraceMs): Capture {
  return async (argv, { env, stdin, timeoutMs, inherit = false }) => {
    const output = inherit ? "inherit" : "pipe";
    const locks = heldLocks();
    const input = stdin === undefined ? "ignore" : new TextEncoder().encode(stdin);
    const ipcPair = createSocketPair();
    if (!ipcPair) throw new Error("could not create supervisor socket");
    setCloexec(ipcPair.parentFd, true);
    let ipcParentClosed = false;
    let ipcChildClosed = false;
    const closeIpcParent = () => {
      if (ipcParentClosed) return;
      ipcParentClosed = true;
      try { closeSync(ipcPair.parentFd); } catch {}
    };
    const closeIpcChild = () => {
      if (ipcChildClosed) return;
      ipcChildClosed = true;
      try { closeSync(ipcPair.childFd); } catch {}
    };
    let configPipe: { readFd: number; writeFd: number } | undefined;
    let configReadClosed = false;
    let configWriteClosed = false;
    const closeConfigRead = () => {
      if (!configPipe || configReadClosed) return;
      configReadClosed = true;
      try { closeSync(configPipe.readFd); } catch {}
    };
    const closeConfigWrite = () => {
      if (!configPipe || configWriteClosed) return;
      configWriteClosed = true;
      try { closeSync(configPipe.writeFd); } catch {}
    };
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const parentTag = env?.[tagEnvVar] ?? process.env[tagEnvVar];
    const inProbe = (parentTag ?? "").split(",").some((part) => part.trim().startsWith("probe-"));
    const keepAliveOnSignal = locks.length > 0 && !inProbe;
    const tag = inProbe ? `probe-${crypto.randomUUID()}` : crypto.randomUUID();
    const inheritedSpare = env?.[spareEnvVar] || process.env[spareEnvVar] || undefined;
    let spareFile: string | undefined = inheritedSpare;
    let targetPid: number | undefined;
    let spareHandedOff = Boolean(inheritedSpare);
    let stopped = false;
    let supervisorReaped = false;
    let confirmedDone = false;
    let pendingProbeInterrupt: NodeJS.Signals | undefined;
    let probeInterruptHooked = false;
    let tagSweep: Promise<void> | undefined;
    let configWrite: Promise<void> | undefined;
    let resultRead: Promise<{ code?: number; error?: string; errCode?: string } | undefined> | undefined;
    let resultReader: ReturnType<typeof createResultReader> | undefined;
    const stopStream = new AbortController();
    const runOutOfProcessSweep = async (): Promise<void> => {
      if (!child) return;
      const pid = child.pid;
      const spare = spareFile;
      const fallbackCleanup = (fallbackSpare: string | undefined) => {
        if (!child) return;
        if (!supervisorReaped) {
          killSessionSync(pid, "SIGKILL", tag, fallbackSpare);
          try {
            child.kill("SIGKILL");
          } catch {}
        } else {
          killDeadSessionSync(pid, tag, true, fallbackSpare);
        }
        if (!inheritedSpare) removeSpareAsync(fallbackSpare);
      };
      let tempPipe: { readFd: number; writeFd: number } | undefined;
      let fd: number;
      let ownsTempFd = false;
      if (!supervisorReaped && !ipcParentClosed) {
        fd = ipcPair.parentFd;
      } else {
        tempPipe = createPipe();
        if (!tempPipe) {
          fallbackCleanup(spare);
          return;
        }
        try {
          closeSync(tempPipe.readFd);
        } catch {}
        fd = tempPipe.writeFd;
        ownsTempFd = true;
      }
      setCloexec(fd, false);
      let helper: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const payload = JSON.stringify([
          {
            pid,
            tag,
            ...(targetPid !== undefined ? { targetPid } : {}),
            ...(spare ? { spareFile: spare } : {}),
            ...(inheritedSpare ? { keepSpareFile: true } : {}),
            fd: 3,
            delayMs: 0,
          },
        ]);
        helper = Bun.spawn(bunScript(probeWatchdog, payload), {
          env: watchdogEnv(),
          stdio: ["ignore", "ignore", "ignore", fd],
          detached: true,
        });
        if (spare) spareHandedOff = true;
      } catch {
        fallbackCleanup(spare);
      } finally {
        if (ownsTempFd) {
          try {
            closeSync(fd);
          } catch {}
        } else {
          setCloexec(fd, true);
        }
      }
      if (helper) {
        await waitUpTo(helper.exited, 500);
        helper.unref();
      }
    };
    const stopChild = () => {
      stopped = true;
      if (!child) return;
      if (!supervisorReaped) {
        if (!ipcParentClosed) {
          try {
            writeSync(ipcPair.parentFd, "kill\n");
          } catch {}
        }
        try {
          process.kill(-child.pid, "SIGCONT");
        } catch {}
        return;
      }
      if (!tagSweep) tagSweep = runOutOfProcessSweep();
    };
    const interrupted = (name: NodeJS.Signals) => {
      if (inProbe && child && !supervisorReaped && !ipcParentClosed) {
        pendingProbeInterrupt = name;
        try {
          writeSync(ipcPair.parentFd, `sig:${name}\n`);
        } catch {}
        if (!probeInterruptHooked) {
          probeInterruptHooked = true;
          const liveChild = child;
          void liveChild.exited.finally(() => {
            const sig = pendingProbeInterrupt;
            if (!sig) return;
            release();
            if (!process.listenerCount(sig)) {
              if (sig === "SIGQUIT") process.exit(131);
              process.kill(process.pid, sig);
            }
          });
        }
        return;
      }
      stopChild();
      const spare = spareFile;
      if (child && !supervisorReaped && !ipcParentClosed) {
        const fd = ipcPair.parentFd;
        setCloexec(fd, false);
        let handedOff = false;
        try {
          const payload = JSON.stringify([
            {
              pid: child.pid,
              tag,
              ...(targetPid !== undefined ? { targetPid } : {}),
              ...(spare ? { spareFile: spare } : {}),
              ...(inheritedSpare ? { keepSpareFile: true } : {}),
              fd: 3,
              delayMs: supervisorGraceMs,
            },
          ]);
          const watchdog = Bun.spawn(bunScript(probeWatchdog, payload), {
            env: watchdogEnv(),
            stdio: ["ignore", "ignore", "ignore", fd],
            detached: true,
          });
          watchdog.unref();
          handedOff = true;
          if (spare) spareHandedOff = true;
        } catch {
        } finally {
          setCloexec(fd, true);
          if (!handedOff) {
            killSessionSync(child.pid, "SIGKILL", tag, spare);
            try {
              child.kill("SIGKILL");
            } catch {}
            if (!inheritedSpare) removeSpareAsync(spare);
          }
        }
      } else if (child) {
        if (supervisorReaped) {
          killDeadSessionSync(child.pid, tag, true, spare);
        } else {
          killSessionSync(child.pid, "SIGKILL", tag, spare);
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        if (!inheritedSpare) removeSpareAsync(spare);
      }
      release();
      if (!process.listenerCount(name)) {
        if (name === "SIGQUIT") process.exit(131);
        process.kill(process.pid, name);
      }
    };
    const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
    const release = () => {
      for (const name of stopSignals) process.off(name, interrupted);
    };
    if (!keepAliveOnSignal) {
      for (const name of stopSignals) process.on(name, interrupted);
    }
    let expired = false;
    let cancel = () => {};
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let resolveStatus!: (status: { code?: number; error?: string; errCode?: string }) => void;
    const statusPromise = new Promise<{ code?: number; error?: string; errCode?: string }>((resolve) => (resolveStatus = resolve));
    let settled = false;
    const settle = (status: { code?: number; error?: string; errCode?: string }) => {
      if (settled) return;
      settled = true;
      resolveStatus(status);
    };
    try {
      const command = holdingLocks(argv, locks, timeoutMs, env?.PATH ?? process.env.PATH ?? "");
      const childEnv = env ?? process.env;
      const fullTag = keepAliveOnSignal ? tag : appendTag(childEnv[tagEnvVar] ?? process.env[tagEnvVar], tag);
      const envEntries: Array<[string, string]> = [];
      for (const [k, v] of Object.entries(childEnv)) {
        if (v !== undefined && k !== tagEnvVar && k !== spareEnvVar) envEntries.push([k, v]);
      }
      envEntries.push([tagEnvVar, tag]);
      if (inheritedSpare) envEntries.push([spareEnvVar, inheritedSpare]);
      const configJson = JSON.stringify({
        argv: command,
        envEntries,
        ...(!inheritedSpare ? { spareTag: tag, ...(childEnv.HOME ? { spareHome: childEnv.HOME } : {}) } : {}),
      });
      const supEnv = minimalSupervisorEnv(fullTag, inheritedSpare);
      const configBytes = new TextEncoder().encode(configJson);
      let inlineConfig = configBytes.byteLength <= 16_384 && envByteSize(supEnv) + configBytes.byteLength <= 32_768 && !configJson.includes("\0");
      const ipcFdIndex = 3 + locks.length;
      const spawnSupervisor = () => {
        if (!inlineConfig) {
          configPipe = createPipe();
          if (!configPipe) throw new Error("could not create supervisor config pipe");
          setCloexec(configPipe.writeFd, true);
          delete supEnv.HEDGE_CAPTURE_CONFIG;
        } else {
          supEnv.HEDGE_CAPTURE_CONFIG = configJson;
        }
        const configFdArg = configPipe ? String(ipcFdIndex + 1) : "-";
        const extraStdio = configPipe ? [configPipe.readFd] : [];
        return Bun.spawn(
          bunScript(captureSupervisor, String(locks.length), String(ipcFdIndex), configFdArg),
          {
            env: supEnv,
            stdio: [input, output, output, ...locks, ipcPair.childFd, ...extraStdio],
            detached: true,
          },
        );
      };
      try {
        child = spawnSupervisor();
      } catch (error) {
        if (inlineConfig && (error as NodeJS.ErrnoException)?.code === "E2BIG") {
          inlineConfig = false;
          child = spawnSupervisor();
        } else {
          throw error;
        }
      }
      closeIpcChild();
      closeConfigRead();
      const live = child;
      const reader = createResultReader(ipcPair.parentFd, stopStream.signal);
      resultReader = reader;
      resultRead = (async () => {
        for (;;) {
          const raw = await reader.nextLine();
          const line = raw.trim();
          if (!line) return undefined;
          try {
            const record = JSON.parse(line) as { spareFile?: unknown; targetPid?: unknown; code?: unknown; error?: unknown };
            if (typeof record.spareFile === "string" && record.spareFile.length > 0) {
              if (!spareFile) spareFile = record.spareFile;
              continue;
            }
            if (typeof record.targetPid === "number" && Number.isInteger(record.targetPid) && record.targetPid > 0) {
              targetPid = record.targetPid;
              continue;
            }
            if (typeof record.error === "string") {
              targetPid = undefined;
              const status = { error: record.error, ...(typeof record.code === "string" ? { errCode: record.code } : {}) };
              settle(status);
              return status;
            }
            if (typeof record.code === "number") {
              targetPid = undefined;
              const status = { code: record.code };
              settle(status);
              return status;
            }
          } catch {}
          return undefined;
        }
      })().catch(() => undefined);
      void live.exited.then(async (code) => {
        supervisorReaped = true;
        const reported = resultRead ? await resultRead : undefined;
        if (reported) settle(reported);
        if (!confirmedDone && !expired && !pendingProbeInterrupt && !tagSweep) tagSweep = runOutOfProcessSweep();
        settle({ code });
      });
      let forceExpired = false;
      cancel = timer(timeoutMs, () => {
        expired = true;
        stopChild();
        hardKill = setTimeout(() => {
          forceExpired = true;
          stopStream.abort();
          settle({ code: timedOut });
        }, supervisorGraceMs);
        void live.exited.finally(() => {
          if (hardKill) clearTimeout(hardKill);
          stopStream.abort();
        });
      });
      if (stopped || expired) {
        closeConfigWrite();
        stopChild();
      } else if (configPipe) {
        const writeFdNum = configPipe.writeFd;
        configWrite = (async () => {
          try {
            let offset = 0;
            while (offset < configBytes.byteLength) {
              const written = await writeFd(writeFdNum, configBytes, offset);
              if (written <= 0) break;
              offset += written;
            }
          } catch {
          } finally {
            closeConfigWrite();
          }
        })();
      }
      let stdout: string;
      let stderr: string;
      let status: { code?: number; error?: string; errCode?: string };
      try {
        [stdout, stderr, status] = await Promise.all([
          readText(live.stdout, stopStream.signal),
          readText(live.stderr, stopStream.signal),
          statusPromise,
        ]);
      } catch (error) {
        stopStream.abort();
        stopChild();
        throw error;
      }
      if (expired) {
        if (!supervisorReaped && !forceExpired) {
          await waitUpTo(live.exited, supervisorGraceMs);
        }
        if (tagSweep) await tagSweep;
        else await runOutOfProcessSweep();
        if (!supervisorReaped) await waitUpTo(live.exited, 50);
        return timeoutResult(timeoutMs, stdout);
      }
      cancel();
      if (pendingProbeInterrupt) {
        await live.exited;
        return { code: status.code ?? 143, stdout, stderr };
      }
      confirmedDone = true;
      if (!supervisorReaped && !ipcParentClosed) {
        try {
          writeSync(ipcPair.parentFd, "done\n");
        } catch {}
      }
      if (inheritedSpare && status.error === undefined && resultReader) {
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        const spareAck = await Promise.race([
          resultReader.nextLine().then((line) => ({ timedOut: false as const, line })),
          new Promise<{ timedOut: true; line: string }>((resolve) => {
            ackTimer = setTimeout(() => resolve({ timedOut: true, line: "" }), 2_000);
          }),
        ]);
        if (ackTimer !== undefined) clearTimeout(ackTimer);
        if (spareAck.timedOut) {
          stopStream.abort();
          if (!tagSweep) tagSweep = runOutOfProcessSweep();
          await tagSweep;
          throw new Error("timed out confirming spare-file persistence");
        }
        let parsedAck: { saved?: unknown; spareError?: unknown; code?: unknown } | undefined;
        if (spareAck.line.trim()) {
          try {
            parsedAck = JSON.parse(spareAck.line.trim()) as { saved?: unknown; spareError?: unknown; code?: unknown };
          } catch {}
        }
        if (typeof parsedAck?.spareError === "string") {
          const err = new Error(parsedAck.spareError) as NodeJS.ErrnoException;
          if (typeof parsedAck.code === "string") err.code = parsedAck.code;
          throw err;
        }
        if (parsedAck?.saved !== true) {
          throw new Error("capture supervisor exited before confirming spare-file persistence");
        }
        if (!supervisorReaped) await waitUpTo(live.exited, 500);
      }
      if (!supervisorReaped) live.unref();
      if (tagSweep) await tagSweep;
      if (status.error !== undefined) {
        const err = new Error(status.error) as NodeJS.ErrnoException;
        if (status.errCode) err.code = status.errCode;
        throw err;
      }
      return { code: status.code ?? 1, stdout, stderr };
    } finally {
      if (hardKill) clearTimeout(hardKill);
      cancel();
      closeIpcChild();
      closeConfigRead();
      if (configWrite) {
        if (expired) await waitUpTo(configWrite.catch(() => {}), 250);
        else await configWrite.catch(() => {});
      } else {
        closeConfigWrite();
      }
      stopStream.abort();
      if (resultRead) await resultRead.catch(() => {});
      if (resultReader && resultReader.reading) {
        void resultReader.done.finally(() => closeIpcParent());
      } else {
        closeIpcParent();
      }
      if (!spareHandedOff && (expired || !confirmedDone)) {
        removeSpareAsync(spareFile);
      }
      release();
    }
  };
}

export const capture = captureWith(realTimer);
const limit = (timeoutMs: number) => AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));

export class Coder {
  readonly env: Env;
  private readonly home: string;
  private readonly template: string;
  private readonly capture: Capture;
  readonly sessionFrom: SessionSource;
  private readonly fetch: typeof fetch;
  private found?: string;

  constructor(options: CoderOptions) {
    this.home = options.home;
    this.template = options.template;
    this.capture = options.capture ?? capture;
    this.fetch = options.fetch ?? fetch;
    this.env = { ...options.env };
    let from: SessionSource = this.env.CODER_SESSION_TOKEN ? "environment" : "none";
    for (const [source, token, url] of sessionFiles) {
      if (this.env.CODER_SESSION_TOKEN || !existsSync(join(options.home, token))) continue;
      this.env.CODER_SESSION_TOKEN = readFileSync(join(options.home, token), "utf8").trim();
      from = source;
      if (existsSync(join(options.home, url))) this.env.CODER_URL = readFileSync(join(options.home, url), "utf8").trim();
    }
    this.sessionFrom = this.env.CODER_SESSION_TOKEN ? from : "none";
    this.env.CODER_URL ||= options.coderUrl;
  }

  async sessionKey(timeoutMs = sessionLimitMs): Promise<SessionKey | undefined> {
    const token = this.env.CODER_SESSION_TOKEN;
    if (!token) return undefined;
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("the session token has a character that cannot go in a request, such as a line break");
    const response = await this.fetch(`${this.env.CODER_URL}/api/v2/users/me/keys/${encodeURIComponent(token.split("-")[0]!)}`, { signal: limit(timeoutMs), redirect: "manual", headers: { "Coder-Session-Token": token } });
    if (response.status === 401) return { rejected: true };
    if (response.status >= 300 && response.status < 400) throw new Error(`Coder answered ${response.status} with a redirect, so Hedge did not send the session to another address`);
    if (!response.ok) throw new Error(`Coder answered ${response.status}`);
    const key = (await response.json().catch(() => undefined)) as { expires_at?: unknown; lifetime_seconds?: unknown } | undefined;
    const expiresAt = typeof key?.expires_at === "string" ? Date.parse(key.expires_at) : NaN;
    if (!Number.isFinite(expiresAt)) throw new Error("Coder answered with something that is not an API key");
    return { rejected: false, expiresAt, lifetimeMs: typeof key?.lifetime_seconds === "number" ? key.lifetime_seconds * 1000 : 0 };
  }

  async binary(): Promise<string> {
    const found = await this.resolve(coderLimitMs);
    if (!found) throw new Error("Cannot download the coder CLI: it timed out");
    return found;
  }

  private async resolve(timeoutMs: number): Promise<string | undefined> {
    this.found ??= Bun.which("coder", { PATH: this.env.PATH ?? "" }) ?? (await this.download(timeoutMs));
    return this.found;
  }

  private async download(timeoutMs: number): Promise<string | undefined> {
    const target = join(this.home, ".local/bin/coder");
    if (existsSync(target)) return target;
    if (!this.env.CODER_URL) throw new Error("No coder CLI and no Coder address. Set hub.coderUrl with hedge set.");
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    mkdirSync(dirname(target), { recursive: true });
    const partial = join(dirname(target), `.coder.${crypto.randomUUID()}`);
    closeSync(openSync(partial, "wx", 0o600));
    const fetched = await this.capture(["curl", "-fsSL", "-o", partial, `${this.env.CODER_URL}/bin/coder-linux-${arch}`], { env: this.env, timeoutMs });
    if (fetched.code !== 0) {
      rmSync(partial, { force: true });
      if (fetched.code === timedOut) return undefined;
      throw new Error(`Cannot download the coder CLI: ${fetched.stderr.trim()}`);
    }
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return target;
  }

  private async call(args: string[], stdin?: string, timeoutMs = coderLimitMs): Promise<Result> {
    const began = Date.now();
    const binary = await this.resolve(timeoutMs);
    const left = timeoutMs - (Date.now() - began);
    if (!binary || left <= 0) return timeoutResult(timeoutMs);
    return this.capture([binary, ...args], { env: this.env, ...(stdin === undefined ? {} : { stdin }), timeoutMs: left });
  }

  private async must(args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.call(args, undefined, timeoutMs);
    if (result.code !== 0) throw new Error(`coder ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  async boxes(timeoutMs?: number): Promise<Box[]> {
    const workspaces = JSON.parse(await this.must(["list", "-o", "json"], timeoutMs)) as Array<{ id: string; name: string; template_name: string; last_used_at: string; latest_build: { status: string } }>;
    return workspaces
      .filter((workspace) => workspace.name.startsWith(boxPrefix))
      .map((workspace) => ({ name: workspace.name, id: workspace.id, template: workspace.template_name, status: workspace.latest_build.status, lastUsedAt: workspace.last_used_at }));
  }

  async create(name: string, from: string, diskGigabytes: number, timeoutMs = coderLimitMs): Promise<string> {
    const signal = limit(timeoutMs);
    const { id, parameters: known } = await this.activeTemplate(signal);
    const copied = await this.api<Array<{ name: string; value: string }>>(`/api/v2/workspacebuilds/${(await this.workspace(from, signal)).latest_build.id}/parameters`, undefined, signal);
    const parameters = new Map(copied.filter((parameter) => known.includes(parameter.name)).map((parameter) => [parameter.name, parameter.value]));
    const overrides: Record<string, string | undefined> = { disk_size: String(diskGigabytes), auto_start_app: "false", clone_source_instance_id: "", dotfiles_branch: this.env.HEDGE_BOX_DOTFILES_BRANCH };
    for (const [key, value] of Object.entries(overrides)) if (value !== undefined && known.includes(key)) parameters.set(key, value);
    const rich_parameter_values = [...parameters].map(([key, value]) => ({ name: key, value }));
    const created = await this.api<{ id: string }>("/api/v2/users/me/workspaces", { method: "POST", body: { name, template_id: id, rich_parameter_values, ttl_ms: idleStopMs } }, signal);
    return created.id;
  }

  private async activeTemplate(signal?: AbortSignal): Promise<{ id: string; versionId: string; parameters: string[] }> {
    const templates = await this.api<Array<{ id: string; name: string; active_version_id: string }>>("/api/v2/templates", undefined, signal);
    const found = templates.find((candidate) => candidate.name === this.template);
    if (!found) throw new Error(`Coder has no ${this.template} template. Set hub.boxTemplate with hedge set.`);
    const parameters = await this.api<Array<{ name: string }>>(`/api/v2/templateversions/${found.active_version_id}/rich-parameters`, undefined, signal);
    return { id: found.id, versionId: found.active_version_id, parameters: parameters.map((parameter) => parameter.name) };
  }

  private workspace(name: string, signal?: AbortSignal): Promise<{ id: string; latest_build: { id: string } }> {
    return this.api(`/api/v2/users/me/workspace/${name}`, undefined, signal);
  }

  private async api<T>(path: string, change?: { method: "POST" | "PUT"; body?: unknown }, signal?: AbortSignal): Promise<T> {
    const response = await this.fetch(`${this.env.CODER_URL}${path}`, {
      ...(change ? { method: change.method, body: JSON.stringify(change.body) } : {}),
      ...(signal ? { signal } : {}),
      headers: { "Coder-Session-Token": this.env.CODER_SESSION_TOKEN ?? "", "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Coder API ${path} returned ${response.status}: ${(await response.text()).trim()}`);
    return response.json() as Promise<T>;
  }

  async start(id: string, timeoutMs: number, { update = false } = {}): Promise<void> {
    const signal = limit(timeoutMs);
    const path = `/api/v2/workspaces/${id}/builds`;
    if (update) {
      try {
        const { versionId } = await this.activeTemplate(signal);
        await this.api(path, { method: "POST", body: { transition: "start", template_version_id: versionId } }, signal);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        console.error(`Hedge box: workspace ${id} keeps its template version: ${(error as Error).message}`);
      }
    }
    await this.api(path, { method: "POST", body: { transition: "start" } }, signal);
  }

  async stop(id: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/builds`, { method: "POST", body: { transition: "stop" } }, limit(timeoutMs));
  }

  async remove(id: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/builds`, { method: "POST", body: { transition: "delete" } }, limit(timeoutMs));
  }

  async extend(id: string, deadline: string, timeoutMs = coderLimitMs): Promise<void> {
    await this.api(`/api/v2/workspaces/${id}/extend`, { method: "PUT", body: { deadline } }, limit(timeoutMs));
  }

  private sshArgs(wait: "yes" | "no", name: string, command: string): string[] {
    return ["ssh", "--disable-autostart", `--wait=${wait}`, name, "--", command];
  }

  sshAfterStartup(name: string, command: string, timeoutMs?: number): Promise<Result> {
    return this.call(this.sshArgs("yes", name, command), undefined, timeoutMs);
  }

  async run(name: string, command: string): Promise<number> {
    return Bun.spawnSync([await this.binary(), ...this.sshArgs("no", name, command)], { env: this.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
  }

  ssh(name: string, command: string, stdin?: string, timeoutMs?: number): Promise<Result> {
    return this.call(this.sshArgs("no", name, command), stdin, timeoutMs);
  }

  token(args: string[]): Promise<string> {
    return this.must(["tokens", ...args]);
  }
}

export type ReapOptions = { days: number; dryRun: boolean; now: number; print(line: string): void };

export async function reap(coder: { boxes(): Promise<Box[]> }, options: ReapOptions, remove: (box: string, stillStale: () => Promise<boolean>) => Promise<number>): Promise<number> {
  const cutoff = options.now - options.days * 86_400_000;
  const stale = (box: Box | undefined) => !!box && idleStatuses.has(box.status) && Date.parse(box.lastUsedAt) < cutoff;
  const current = async (name: string) => (await coder.boxes()).find((candidate) => candidate.name === name);
  let failed = 0;
  for (const listed of await coder.boxes()) {
    const box = stale(listed) && !options.dryRun ? await current(listed.name) : listed;
    const doomed = stale(box);
    options.print(`${doomed ? (options.dryRun ? "would delete" : "delete") : "keep"}: ${listed.name} (${box?.status ?? "gone"}, last used ${box?.lastUsedAt ?? listed.lastUsedAt})`);
    if (!doomed || options.dryRun) continue;
    try {
      if ((await remove(listed.name, async () => stale(await current(listed.name)))) !== 0) failed = 1;
    } catch (error) {
      failed = 1;
      options.print(`${listed.name}: ${(error as Error).message}`);
    }
  }
  return failed;
}

type Token = { id: string; token_name: string; expires_at: string };
export type GrantOptions = { ifExpiring: boolean; now: number; onDevbox(target: string, command: string, stdin?: string): Promise<Result>; print(line: string): void };

export async function grant(coder: { env: Env; token(args: string[]): Promise<string> }, target: string, options: GrantOptions): Promise<number> {
  const prefix = `hedge-${target}-`;
  const ours = (token: string) => token.startsWith(prefix) && /^\d{12}-[0-9a-f]{4}$/.test(token.slice(prefix.length));
  const tokens = (JSON.parse(await coder.token(["list", "-o", "json"])) as Token[]).filter((token) => ours(token.token_name));
  if (options.ifExpiring) {
    const keyId = (await options.onDevbox(target, "cut -d- -f1 ~/.config/hedge/coder-session 2>/dev/null")).stdout.trim();
    const installed = tokens.find((token) => token.id === keyId);
    if (installed && Date.parse(installed.expires_at) - options.now > tokenRenewWithinMs) {
      options.print(`${installed.token_name}: still valid until ${installed.expires_at}`);
      return 0;
    }
  }
  const name = `${prefix}${new Date(options.now).toISOString().replace(/\D/g, "").slice(0, 12)}-${crypto.randomUUID().slice(0, 4)}`;
  const token = (await coder.token(["create", "--name", name, "--lifetime", tokenLifetime, ...tokenScopes.flatMap((scope) => ["--scope", scope])])).trim();
  const write = async (file: string, content: string) => {
    const install = `umask 077 && mkdir -p ~/.config/hedge && t=$(mktemp ~/.config/hedge/.${file}.XXXXXX) && cat > "$t" && chmod 600 "$t" && mv -f "$t" ~/.config/hedge/${file}`;
    const pushed = await options.onDevbox(target, install, `${content}\n`);
    if (pushed.code !== 0) throw new Error(`Cannot write ${file} on ${target}: ${pushed.stderr.trim()}`);
  };
  try {
    await write("coder-url", coder.env.CODER_URL ?? "");
    await write("coder-session", token);
  } catch (error) {
    await coder.token(["remove", name]);
    throw error;
  }
  for (const old of tokens) await coder.token(["remove", old.token_name]);
  options.print(`${name}: granted for ${tokenLifetime}.`);
  return 0;
}

export type SessionOptions = { now: number; print(line: string): void };

export async function checkSession(coder: Pick<Coder, "env" | "sessionFrom" | "sessionKey">, options: SessionOptions): Promise<number> {
  if (coder.sessionFrom === "none") return options.print("This machine has no Coder session, so there is no Coder session to check."), 0;
  const url = coder.env.CODER_URL ?? "";
  const login = `coder login ${url}`;
  const fix = {
    environment: `Set CODER_SESSION_TOKEN to a fresh token, or unset it and run ${login} on the hub.`,
    hedge: `Write a fresh Coder token to ~/.config/hedge/coder-session, or remove that file and run ${login} on the hub.`,
    cli: `Run ${login} on the hub to sign in again.`,
  }[coder.sessionFrom];
  let key: SessionKey | undefined;
  try {
    key = await coder.sessionKey();
  } catch (error) {
    const token = coder.env.CODER_SESSION_TOKEN ?? "";
    const message = error instanceof DOMException && error.name === "TimeoutError" ? "it timed out" : (error as Error).message;
    const reason = token ? message.split(token).join("<session token>") : message;
    return options.print(`Cannot reach Coder at ${url} to check the hub's Coder session: ${reason}. Check the address and the network, then run hedge box session again.`), 1;
  }
  if (!key || key.rejected) return options.print(`Coder rejects the hub's Coder session: it expired or was removed. ${fix}`), 1;
  const at = new Date(key.expiresAt).toISOString();
  if (key.expiresAt <= options.now) return options.print(`The hub's Coder session expired at ${at}. ${fix}`), 1;
  const warnWithin = key.lifetimeMs > 0 ? Math.min(tokenRenewWithinMs, key.lifetimeMs / 2) : tokenRenewWithinMs;
  if (key.expiresAt - options.now <= warnWithin) return options.print(`The hub's Coder session expires at ${at}. ${fix}`), 1;
  options.print(`The hub's Coder session lasts until ${at}.`);
  return 0;
}
