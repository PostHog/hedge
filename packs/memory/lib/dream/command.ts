import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env, Result } from "../../../hub/lib/coder.ts";
import { quote, readRole, remoteHedge } from "../../../hub/lib/machine.ts";
import { analyze, render, type Analyst } from "./analyze.ts";
import { audit, type Checker } from "./audit.ts";
import { budget, homeCheckouts, memoryRootIn } from "./budget.ts";
import { commitChange, commitUsage, parseChange } from "./commit.ts";
import { publish } from "./publish.ts";
import { searchSessions } from "./search.ts";
import { collect, collectedDir, dateOf, type DreamBoxes } from "./collect.ts";
import { digestLines, dreamIsOn, dreamPromptStart, dreamSessionsKey, localDigests, memoryCheckout, parseSince, redactDigest, sessionKeepDays, stateDir } from "./digest.ts";
import { scorecardText } from "./scorecard.ts";

export { dreamPeers } from "./collect.ts";

export type DreamIo = {
  home: string; env: Env; self: string; cwd: string; now(): number;
  print(text: string): void; say(line: string): void;
  peers(): string[];
  onPeer(alias: string, command: string): Promise<Result>;
  boxes(): DreamBoxes | undefined;
  git(args: string[]): Promise<Result>;
  analyst(): Analyst;
  checker(): Checker;
  launch(title: string, prompt: string): Promise<string>;
};

const usage = `Usage:
  hedge dream digest [--since <2d | 36h | ISO time>]   Print this machine's condensed sessions as JSON lines
  hedge dream collect [--since 2d]                      On the hub: gather the digests of every machine and running box
  hedge dream analyze [<run>] [--limit n] [--jobs 6]    Ask one analyst per collected session for findings
  hedge dream audit [<run>] [--limit 40]                Check each note the sync wrote since the last audit against its session
  hedge dream prepare [--since 2d]                      collect, analyze, then audit; prints the run directory
  hedge dream run                                       On the hub: prepare, then start the T3 thread that follows the dream skill
  hedge dream budget [<memory checkout>] [--json]       Check the memory size limits; exit 1 when one fails
  hedge dream scorecard [<memory checkout>]             On the hub: print the memory scorecard
  hedge dream logs [--since 7d]                         Print this machine's Dream sessions, for the deep dream
  hedge dream commit "<Verb>: <name>" --why <text> --prevalence <text> --evidence <text> --topics <text> [--co-author <who>] <path>...
                                                        Commit the named memories and their index lines in the Dream's format
  hedge dream publish <worktree>                        Push a Dream worktree's commits to main, with the memory sync's guards
  hedge dream search <word>...
                                                        Find the sessions of the last 30 days that name every word`;
const searchUsage = "Usage: hedge dream search <word>...";
const publishUsage = "Usage: hedge dream publish <worktree>";

const memoryRefusal = "Dream needs the Memory pack: turn it on, then run hedge apply";
const dreamOff = "Dream is off: turn it on with hedge packs --workflows dream=on, then run hedge apply";
const hubOnly = ["collect", "prepare", "run"];
const spending = ["analyze", "audit", "prepare", "run"];

const option = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const positional = (args: string[]) => (args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined);
const settingsOf = (env: Env): Record<string, unknown> => JSON.parse(env.HEDGE_SETTINGS ?? "{}");

function collectNow(args: string[], io: DreamIo): Promise<string> {
  return collect(option(args, "--since") ?? "2d", { ...io, peers: io.peers() });
}

function analyzeRun(run: string, args: string[], io: DreamIo): Promise<string> {
  const limit = Number(option(args, "--limit") ?? settingsOf(io.env)[dreamSessionsKey]);
  return analyze(run, { home: io.home, env: io.env, limit, jobs: Number(option(args, "--jobs") ?? 6), analyst: io.analyst(), say: io.say });
}

function auditRun(run: string, args: string[], io: DreamIo): Promise<string> {
  return audit(run, { home: io.home, env: io.env, now: io.now, limit: Number(option(args, "--limit") ?? 40), git: io.git, checker: io.checker(), say: io.say });
}

async function prepareRun(args: string[], io: DreamIo): Promise<string> {
  const run = await analyzeRun(await collectNow(args, io), args, io);
  try {
    await auditRun(run, [], io);
  } catch (error) {
    io.say(`Hedge dream: audit failed: ${(error as Error).message}`);
  }
  rmSync(collectedDir(run), { recursive: true, force: true });
  return run;
}

function logs(args: string[], io: DreamIo): number {
  const items = localDigests(io.home, io.self, parseSince(option(args, "--since") ?? "7d", io.now()), io.env, true).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!items.length) return io.print("No Dream session in that time on this machine. Run it on the hub."), 0;
  io.print(items.map((item) => `${render(redactDigest(item))}\n\n---\n`).join("\n"));
  return 0;
}

async function search(args: string[], io: DreamIo): Promise<number> {
  if (!args.length) return io.say(searchUsage), 2;
  if (readRole(io.home) === "hub") {
    io.print(searchSessions(stateDir(io.home, io.env), args, { since: parseSince(`${sessionKeepDays}d`, io.now()) }));
    return 0;
  }
  const hub = settingsOf(io.env)["hub.alias"];
  if (typeof hub !== "string" || !hub) return io.say("Hedge dream: search reads the sessions on the hub, and hub.alias is not set"), 1;
  const answer = await io.onPeer(hub, remoteHedge(`dream search ${args.map(quote).join(" ")}`));
  io.print(answer.stdout);
  if (answer.code !== 0) io.say(answer.stderr.trim() || `Hedge dream: ${hub} did not answer.`);
  return answer.code;
}

async function publishWorktree(args: string[], io: DreamIo): Promise<number> {
  const worktree = positional(args);
  if (!worktree) return io.say(publishUsage), 2;
  const subtree = settingsOf(io.env)["memory.subtree"];
  const answer = await publish(worktree, typeof subtree === "string" ? subtree.replace(/^\/+|\/+$/g, "") : "", memoryCheckout(io.home, io.env), io.git);
  (answer.code ? io.say : io.print)(`Hedge dream: ${answer.message}`);
  return answer.code;
}

async function commitMemory(args: string[], io: DreamIo): Promise<number> {
  const change = parseChange(args);
  if (!change) return io.say(commitUsage), 2;
  try {
    const answer = await commitChange(change, io.cwd, io.git);
    if (answer.code) io.say(`Hedge dream: ${answer.message}`);
    else io.print(answer.message);
    return answer.code;
  } catch (error) {
    io.say(`Hedge dream: ${(error as Error).message}`);
    return 1;
  }
}

async function nightly(args: string[], io: DreamIo): Promise<number> {
  let run: string;
  try {
    run = await prepareRun(args, io);
  } catch (error) {
    io.say(`Hedge dream: prepare failed: ${(error as Error).message}`);
    return 1;
  }
  try {
    const thread = await io.launch(`Dream ${dateOf(io.now())}`, `${dreamPromptStart} with the run directory ${run}.`);
    io.print(`Started the dream thread ${thread} for ${run}`);
    return 0;
  } catch (error) {
    io.say(`Hedge dream: cannot start the dream thread: ${(error as Error).message}`);
    return 1;
  }
}

async function printRun(command: string, work: () => Promise<string>, io: DreamIo): Promise<number> {
  try {
    io.print(await work());
    return 0;
  } catch (error) {
    io.say(`Hedge dream: ${command} failed: ${(error as Error).message}`);
    return 1;
  }
}

function requireHub(io: DreamIo, command: string) {
  const role = readRole(io.home);
  if (role !== "hub") throw new Error(`hedge dream ${command} runs only on the hub. This machine's role is ${role ?? "not set"}.`);
}

export async function dreamCommand(args: string[], io: DreamIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "digest") {
    const since = option(rest, "--since");
    io.print(digestLines(io.home, io.self, parseSince(since, io.now()), io.now(), io.env));
    return 0;
  }
  if (!command || !["collect", "analyze", "audit", "prepare", "run", "budget", "scorecard", "logs", "commit", "publish", "search"].includes(command)) {
    io.print(`${usage}\n`);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  if (typeof settingsOf(io.env)["memory.repo"] !== "string") return io.say(memoryRefusal), 1;
  if (spending.includes(command) && !dreamIsOn(io.env)) return io.say(dreamOff), 1;
  const state = stateDir(io.home, io.env);
  if (command === "run") {
    try { requireHub(io, command); } catch (error) { return io.say(`Hedge dream: ${(error as Error).message}`), 1; }
    return nightly(rest, io);
  }
  if (hubOnly.includes(command)) requireHub(io, command);
  if (command === "collect") return io.print(await collectNow(rest, io)), 0;
  if (command === "prepare") return printRun(command, () => prepareRun(rest, io), io);
  if (command === "analyze") return printRun(command, () => analyzeRun(positional(rest) ?? join(state, dateOf(io.now())), rest, io), io);
  if (command === "audit") return printRun(command, () => auditRun(positional(rest) ?? join(state, dateOf(io.now())), rest, io), io);
  if (command === "logs") return logs(rest, io);
  if (command === "search") return search(rest, io);
  if (command === "commit") return commitMemory(rest, io);
  if (command === "publish") return publishWorktree(rest, io);
  const checkout = positional(rest) ?? memoryCheckout(io.home, io.env);
  if (command === "scorecard") {
    const git = async (gitArgs: string[]) => {
      const answer = await io.git(["-C", checkout, ...gitArgs]);
      if (answer.code !== 0) throw new Error(`git ${gitArgs[0]} failed in ${checkout}: ${answer.stderr.trim()}`);
      return answer.stdout;
    };
    io.print(await scorecardText(state, checkout, git, io.now()));
    return 0;
  }
  const root = positional(rest) ? memoryRootIn(checkout, settingsOf(io.env)["memory.subtree"]) : checkout;
  const usagePath = join(state, "usage.json");
  const problems = budget(root, existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {}, io.now(), homeCheckouts(io.home));
  if (rest.includes("--json")) io.print(JSON.stringify(problems, null, 2));
  else io.print(problems.length ? problems.map((item) => `${item.file}: ${item.problem}`).join("\n") : "Memory is within budget.");
  return problems.length ? 1 : 0;
}
