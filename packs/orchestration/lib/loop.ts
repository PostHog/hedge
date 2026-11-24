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

const known = ["--ledger", "--kind"];

function option(args: string[], name: string): string | undefined {
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

function ledgerDir(args: string[], io: LoopIo): string {
  const dir = option(args, "--ledger") ?? io.ledger();
  if (!dir?.trim()) throw new Error(`name the loop ledger directory with --ledger <dir>, or set ${loopLedgerSetting}`);
  return expandHome(dir.trim(), io.home);
}

const pauseLine = /^[ \t>*_-]*Paused[*_]*:[*_]*[ \t]*(.*)$/gim;

/** Whether the loop ledger's limits.md pauses the loops. Only one or more Paused lines that all say no let them run: a
 * file that cannot be read, has no Paused line, says something other than yes or no, or says both, pauses them too, so a
 * broken ledger starts no lane. */
export function pauseState(ledger: string): PauseState {
  const file = join(ledger, "limits.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { state: "unreadable", why: `${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  const values = new Set([...text.matchAll(pauseLine)].map((match) => match[1]!.replace(/[*_`]/g, "").trim().toLowerCase().split(/[\s(,.;:]/)[0]!));
  if (values.size === 0) return { state: "unreadable", why: `${file} has no Paused line` };
  if (values.size > 1) return { state: "unreadable", why: `${file} has Paused lines that disagree (${[...values].join(", ")})` };
  const [value] = values;
  if (value === "no") return { state: "runs" };
  return value === "yes" ? { state: "paused", why: `${file} says Paused: yes` } : { state: "unreadable", why: `${file} says Paused: ${value}, which is neither yes nor no` };
}

export const pausedReason = (why: string) => `The loops are paused: ${why}. `
  + "Settle the lanes that ended, keep every watch and post-deploy check, record a no-op run, and start no lane.";

function checkPause(args: string[], io: LoopIo): number {
  const pause = pauseState(ledgerDir(args, io));
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

function ledgerIdentity(ledger: string): string {
  const real = realpathSync(ledger);
  const top = git(real, "rev-parse", "--show-toplevel");
  const remote = top && git(real, "config", "--get", "remote.origin.url");
  return remote ? `${remote.replace(/\.git$/, "")}#${relative(realpathSync(top), real)}` : real;
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

/** The next lane or signal id of a loop ledger: the first id past its rows' highest that this machine has not
 * reserved yet. Each id is reserved with an exclusive create, keyed by the ledger repository's origin and the ledger's
 * place in it, so parallel callers on one machine never get the same id, from one checkout or several. */
export function nextId(ledger: string, kind: Kind, home: string): string {
  const { prefix } = kinds[kind];
  const dir = reservations(home, ledger);
  let number = highestRecorded(ledger, kind) + 1;
  while (!reserve(dir, idOf(prefix, number))) number++;
  return idOf(prefix, number);
}

function printNextId(args: string[], io: LoopIo): number {
  const kind = option(args, "--kind");
  if (kind !== "lane" && kind !== "signal") throw new Error(`name the id with --kind lane or --kind signal. ${usage}`);
  io.print(nextId(ledgerDir(args, io), kind, io.home));
  return 0;
}

export async function runLoop(args: string[], io: LoopIo): Promise<number> {
  const [step, ...rest] = args;
  if (step === "check-pause") return checkPause(rest, io);
  if (step === "next-id") return printNextId(rest, io);
  throw new Error(usage);
}
