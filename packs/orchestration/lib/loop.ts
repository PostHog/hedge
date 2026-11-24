import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cannotTell } from "../../base/lib/command.ts";
import { expandHome } from "./lessons.ts";

export const loopLedgerSetting = "orchestration.loopLedger";

export type LoopIo = { home: string; ledger: () => string | undefined; print: (line: string) => void };
export type PauseState = { state: "runs" } | { state: "paused" | "unreadable"; why: string };

const usage = "usage: hedge loop check-pause [--ledger <dir>] | hedge loop next-id --kind lane|signal [--ledger <dir>]";
const kinds = { lane: { prefix: "L", file: "lanes.md" }, signal: { prefix: "S", file: "signals.md" } } as const;
type Kind = keyof typeof kinds;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value. ${usage}`);
  return value;
}

function ledgerDir(args: string[], io: LoopIo): string {
  const dir = option(args, "--ledger") ?? io.ledger();
  if (!dir?.trim()) throw new Error(`name the loop ledger directory with --ledger <dir>, or set ${loopLedgerSetting}`);
  return expandHome(dir.trim(), io.home);
}

/** Whether the loop ledger's limits.md pauses the loops. A file that cannot be read, or a Paused line that says neither
 * yes nor no, pauses them too, so a broken ledger starts no lane. */
export function pauseState(ledger: string): PauseState {
  const file = join(ledger, "limits.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { state: "unreadable", why: `${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  const value = /^Paused:[ \t]*(.*)$/im.exec(text)?.[1]?.trim().toLowerCase();
  if (value === undefined || value === "no") return { state: "runs" };
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
  return Math.max(0, ...numbersIn(rows, new RegExp(`^\\|\\s*${prefix}(\\d+)\\s*\\|`, "g")));
}

function reservations(home: string, ledger: string): string {
  const key = createHash("sha256").update(realpathSync(ledger)).digest("hex").slice(0, 16);
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
 * reserved yet. Each id is reserved with an exclusive create, so parallel callers on one machine never get the same id. */
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
