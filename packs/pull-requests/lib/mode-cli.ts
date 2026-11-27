import { appendHeard, answeredAt, heardInThread, ledgerOf, type DecisionContext } from "./decision-cli.ts";
import { sameThread, thisMachine, type Env, type LedgerEvent, type ModeGrant } from "./decision-ledger.ts";
import { chainOf, grantedBy, isMode, modeLabel, modeLine, modes, resolveMode, t3Threads, withThreadMode, type Mode, type ReadThreads } from "./mode.ts";

export type ModeContext = DecisionContext & { threads?: ReadThreads };

const usage = `hedge mode: the autonomy mode of a thread.

  hedge mode show [--thread <id>] [--repo <owner/name>]
  hedge mode set <${modes.join("|")}> --thread <id> --words '<date> "<the user's whole message>"' [--message <id>] [--for <thread>]

A thread runs in one of three modes. supervised: the agent decides nothing alone and asks the user. auto: the
agent decides review rounds, proof gaps and routine asks alone, and brings each PR to the user's merge card. full:
the agent decides everything, merges, and reports once at the end.

show prints the thread's mode and where it comes from: the thread's own grant, a grant it inherits from the thread
that started it, the default of --repo in pull-requests.repoModes, or the profile default in pull-requests.mode.
--thread defaults to this thread.

set records the user's grant. Only the user switches a mode: quote their whole message in thread --thread, typed in
the T3 app or chosen on your question tool, with the date they wrote it. One sentence of it must name the mode, as
"mode full" or "full mode", without a "not", and no other mode. --for applies it to a thread that thread --thread
started, such as a lane; it defaults to --thread. A thread that another thread started inherits its mode until a
grant of its own. A thread that starts on its own, such as a side fix, takes the defaults.`;

type Parsed = { options: Map<string, string>; positional: string[] };

function parse(args: string[], valued: string[]): Parsed {
  const parsed: Parsed = { options: new Map(), positional: [] };
  while (args.length) {
    const arg = args.shift()!;
    if (!arg.startsWith("--")) { parsed.positional.push(arg); continue; }
    if (!valued.includes(arg)) throw new Error(`Unknown option ${arg}. Run hedge mode --help`);
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value. Run hedge mode --help`);
    if (parsed.options.has(arg)) throw new Error(`${arg} given twice. Pass it once. Run hedge mode --help`);
    parsed.options.set(arg, value);
  }
  return parsed;
}

const threadsOf = (context: ModeContext) => context.threads ?? t3Threads(context.home);

async function show(parsed: Parsed, context: ModeContext) {
  if (parsed.positional.length) throw new Error(`Unknown argument ${parsed.positional[0]}. Run hedge mode --help`);
  const thread = parsed.options.get("--thread") ?? context.env.T3CODE_THREAD_ID;
  const events = await ledgerOf(context).read().catch(() => [] as LedgerEvent[]);
  const resolved = resolveMode(context.env, events, await chainOf(thread, threadsOf(context)), parsed.options.get("--repo"));
  context.print(`${modeLine(resolved.mode)}\nfrom: ${resolved.from}\nlabel: ${modeLabel(resolved.mode)}`);
  return 0;
}

async function set(parsed: Parsed, context: ModeContext) {
  const [mode, ...rest] = parsed.positional;
  if (!isMode(mode) || rest.length) throw new Error(`Name one mode: ${modes.join(", ")}. Run hedge mode --help`);
  const words = parsed.options.get("--words");
  const thread = parsed.options.get("--thread");
  if (!words || !thread) throw new Error("Pass --thread and --words: only the user's words switch a mode. Run hedge mode --help");
  const target = parsed.options.get("--for") ?? thread;
  const heard = await heardInThread(thread, words, parsed.options.get("--message"), context);
  const granted = grantedBy(heard.text);
  if (granted !== mode) throw new Error(`The user's message "${heard.text}" does not grant mode ${mode}${granted ? `: it grants mode ${granted}` : ""}. Only a sentence that names one mode, without a "not", switches it; ask them with your question tool, with "mode ${mode}" as an option`);
  if (!sameThread(target, thread) && !(await chainOf(target, threadsOf(context))).some((link) => sameThread(link, thread))) {
    throw new Error(`Thread ${target} was not started by thread ${thread}, so the user's words there do not reach it. Ask in thread ${target}`);
  }
  const ledger = ledgerOf(context);
  const grant: ModeGrant = { type: "mode", mode, for: target, words, thread: heard.thread, message: heard.id, machine: thisMachine(context.env), at: answeredAt(heard) };
  const events = await ledger.read();
  const same = events.find((event): event is ModeGrant => event.type === "mode" && event.message === grant.message && sameThread(event.thread, grant.thread) && sameThread(event.for, target));
  if (!same) await appendHeard(ledger, grant);
  context.print(`${modeLine(mode)} for thread ${target}${same ? ", already recorded" : ""}\nlabel: ${modeLabel(mode)}. Put it on the thread's tracking issue in place of the other mode labels.`);
  return 0;
}

export async function modeCommand(args: string[], context: ModeContext): Promise<number> {
  const name = args.shift();
  if (name === undefined || ["help", "--help", "-h"].includes(name) || args.includes("--help")) { context.print(usage); return name === undefined ? 1 : 0; }
  if (name === "show") return show(parse(args, ["--thread", "--repo"]), context);
  if (name === "set") return set(parse(args, ["--thread", "--words", "--message", "--for"]), context);
  throw new Error(`Unknown command ${name}. Run hedge mode --help`);
}

export async function threadModeEnv(home: string, env: Env, threads: ReadThreads = t3Threads(home)): Promise<Env> {
  const thread = env.T3CODE_THREAD_ID;
  if (!env.HEDGE_SETTINGS) return env;
  const events = thread ? await ledgerOf({ home, env }).read().catch(() => [] as LedgerEvent[]) : [];
  return withThreadMode(env, events, await chainOf(thread, threads));
}

export type { Mode };
