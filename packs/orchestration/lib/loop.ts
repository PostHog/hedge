import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { cannotTell } from "../../base/lib/command.ts";
import { expandHome } from "./lessons.ts";

export const loopLedgerSetting = "orchestration.loopLedger";

export type LoopIo = { home: string; ledger: () => string | undefined; print: (line: string) => void };
export type PauseState = { state: "runs" } | { state: "paused" | "unreadable"; why: string };

const usage = "usage: hedge loop check-pause [--ledger <dir>] | hedge loop next-id --kind lane|signal [--ledger <dir>]";
const kinds = { lane: { prefix: "L", file: "lanes.md" }, signal: { prefix: "S", file: "signals.md" } } as const;
type Kind = keyof typeof kinds;

function option(args: string[], name: string, known: string[]): string | undefined {
  let found: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!known.includes(flag)) throw new Error(`unknown argument ${arg}. ${usage}`);
    const value = inline ?? args[++at];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value. ${usage}`);
    if (flag === name) found = value;
  }
  return found;
}

function ledgerDir(args: string[], io: LoopIo, known: string[]): string {
  const dir = option(args, "--ledger", known) ?? io.ledger();
  if (!dir?.trim()) throw new Error(`name the loop ledger directory with --ledger <dir>, or set ${loopLedgerSetting}`);
  return expandHome(dir.trim(), io.home);
}

const pauseLine = /^[ \t>*_-]*Paused[*_]*:[*_]*[ \t]*(.*)$/gim;
const pauseValue = /^[*_`]*(yes|no)[*_`]*(?:\.|[,;]\s.*|\s*\(.*|\s+[\u2013\u2014-]\s.*)?$/i;

export function pauseState(ledger: string): PauseState {
  const file = join(ledger, "limits.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { state: "unreadable", why: `${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  const values = new Set([...text.matchAll(pauseLine)].map((match) => {
    const value = match[1]!.trim();
    return pauseValue.exec(value)?.[1]!.toLowerCase() ?? value;
  }));
  if (values.size === 0) return { state: "unreadable", why: `${file} has no Paused line` };
  if (values.size > 1) return { state: "unreadable", why: `${file} has Paused lines that disagree (${[...values].join(", ")})` };
  const [value] = values;
  if (value === "no") return { state: "runs" };
  return value === "yes" ? { state: "paused", why: `${file} says Paused: yes` } : { state: "unreadable", why: `${file} says Paused: ${value}, which is neither yes nor no` };
}

export const pausedReason = (why: string) => `The loops are paused: ${why}. `
  + "Settle the lanes that ended, keep every watch and post-deploy check, record a no-op run, and start no lane.";

function checkPause(args: string[], io: LoopIo): number {
  const pause = pauseState(ledgerDir(args, io, ["--ledger"]));
  if (pause.state === "runs") {
    io.print("The loops run: start lanes up to the WIP limits.");
    return 0;
  }
  io.print(pausedReason(pause.why));
  return pause.state === "paused" ? 1 : cannotTell;
}

const numbersIn = (names: Iterable<string>, pattern: RegExp) => [...names].flatMap((name) => [...name.matchAll(pattern)].map((match) => Number(match[1])));

function highestRecorded(ledger: string, kind: Kind): number {
  const { prefix, file } = kinds[kind];
  const rows = readFileSync(join(ledger, file), "utf8").split("\n");
  return Math.max(0, ...numbersIn(rows, new RegExp(`^\\s*\\|\\s*${prefix}(\\d+)[a-z]?\\s*\\|`, "g")));
}

function git(ledger: string, ...args: string[]): string | undefined {
  const run = spawnSync("git", ["-C", ledger, ...args], { encoding: "utf8" });
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : undefined;
}

function repositoryOf(remote: string): string {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(remote);
  let host = scp?.[1] ?? "";
  let path = scp?.[2] ?? remote;
  if (!scp && URL.canParse(remote)) {
    const url = new URL(remote);
    [host, path] = [url.host, url.pathname];
  }
  return `${host.toLowerCase()}/${path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
}

function ledgerIdentity(ledger: string): string {
  const real = realpathSync(ledger);
  const top = git(real, "rev-parse", "--show-toplevel");
  const remote = top && git(real, "config", "--get", "remote.origin.url");
  return remote ? `${repositoryOf(remote)}#${relative(realpathSync(top), real)}` : real;
}

function reservations(home: string, ledger: string): string {
  const key = createHash("sha256").update(ledgerIdentity(ledger)).digest("hex").slice(0, 16);
  const dir = join(home, ".local/state/hedge/loop-ids", key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const idOf = (prefix: string, number: number) => `${prefix}${String(number).padStart(3, "0")}`;

function reserve(dir: string, id: string): boolean {
  try {
    closeSync(openSync(join(dir, id), "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function nextId(ledger: string, kind: Kind, home: string): string {
  const { prefix } = kinds[kind];
  const dir = reservations(home, ledger);
  let number = highestRecorded(ledger, kind) + 1;
  while (!reserve(dir, idOf(prefix, number))) number++;
  return idOf(prefix, number);
}

function printNextId(args: string[], io: LoopIo): number {
  const known = ["--ledger", "--kind"];
  const kind = option(args, "--kind", known);
  if (kind !== "lane" && kind !== "signal") throw new Error(`name the id with --kind lane or --kind signal. ${usage}`);
  io.print(nextId(ledgerDir(args, io, known), kind, io.home));
  return 0;
}

export async function runLoop(args: string[], io: LoopIo): Promise<number> {
  const [step, ...rest] = args;
  if (step === "check-pause") return checkPause(rest, io);
  if (step === "next-id") return printNextId(rest, io);
  throw new Error(usage);
}
