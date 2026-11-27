import { optionalStringSetting } from "../../base/lib/settings.ts";
import { matchThread, t3CliRunner, withT3Session, type ShellThread } from "../../base/lib/t3/index.ts";
import { sameThread, type Env, type LedgerEvent, type ModeGrant } from "./decision-ledger.ts";
import { normalized } from "./proof-answers.ts";

export const modes = ["supervised", "auto", "full"] as const;
export type Mode = (typeof modes)[number];
export type ResolvedMode = { mode: Mode; from: string };

export const isMode = (value: unknown): value is Mode => (modes as readonly unknown[]).includes(value);
export const modeName = (mode: Mode) => `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
export const modeLine = (mode: Mode) => `Mode: ${modeName(mode)}`;
export const modeLabel = (mode: Mode) => `mode:${mode}`;

export const threadModeKey = "pull-requests.threadMode";
const legacyAutonomy = "pull-requests.autonomy";

const negation = /\b(not|no|never|don'?t|doesn'?t|won'?t|without|instead of|stop|leave|drop|end)\b/;
const hypothetical = /\b(if|when|whenever|unless|would|could|should|might|maybe|once|after|before|until|later)\b/;
const sentences = (text: string) => [...normalized(text).matchAll(/[^.!?;\n]+[.!?;\n]*/g)].map((match) => match[0].trim()).filter(Boolean);
const named = (mode: Mode) => `(?:mode[\\s:=]+${mode}|${mode} mode)(?!/)`;
const work = "(?: (?:this|it|this task|this thread|the task|the work|everything|all of it))?";
const ask = `(?:(?:run|do|work|continue|keep going|go|switch|switch over|move|change|put|set|use)${work}(?: (?:in|to|into|on|with))?(?: the)? )?`;
const grantForm = (mode: Mode) => new RegExp(`^(?:please |ok,? |okay,? |now,? )?${ask}${named(mode)}(?: (?:for|on) (?:this|it|this task|this thread|the task|the work|everything))?(?:,? please)?(?: \\(recommended\\))?[.!]*$`);
const mentions = (sentence: string) => modes.filter((mode) => new RegExp(`\\b${named(mode)}`).test(sentence));
const unsure = (sentence: string) => sentence.endsWith("?") || negation.test(sentence) || hypothetical.test(sentence);

export function grantedBy(text: string): Mode | undefined {
  const all = sentences(text.replace(/^\s*\d{4}-\d{2}-\d{2}\s+/, ""));
  if (all.some((sentence) => mentions(sentence).length && unsure(sentence))) return undefined;
  const granted = new Set(all.flatMap((sentence) => modes.filter((mode) => grantForm(mode).test(sentence))));
  return granted.size === 1 ? [...granted][0] : undefined;
}

function parsedMode(value: string, from: string): Mode {
  const mode = value.trim().toLowerCase();
  if (!isMode(mode)) throw new Error(`${from} is ${value}, not one of ${modes.join(", ")}`);
  return mode;
}

export function repositoryModes(env: Env): [string, Mode][] {
  const pairs = (optionalStringSetting("pull-requests.repoModes", env) ?? "").split(/[\s,]+/).filter(Boolean);
  return pairs.map((pair) => {
    const split = pair.indexOf("=");
    if (split <= 0) throw new Error(`pull-requests.repoModes takes owner/name=mode pairs, not ${pair}`);
    return [pair.slice(0, split).toLowerCase(), parsedMode(pair.slice(split + 1), `the mode of ${pair.slice(0, split)} in pull-requests.repoModes`)];
  });
}

const covers = (entry: string, repository: string) => entry === repository.toLowerCase() || (entry.endsWith("/*") && repository.toLowerCase().startsWith(entry.slice(0, -1)));

export function configuredMode(env: Env, repository?: string): ResolvedMode {
  const granted = optionalStringSetting(threadModeKey, env);
  if (granted) return { mode: parsedMode(granted, threadModeKey), from: "this thread's grant" };
  const repo = repository ? repositoryModes(env).find(([entry]) => covers(entry, repository)) : undefined;
  if (repo) return { mode: repo[1], from: `the default of ${repository}` };
  const mode = optionalStringSetting("pull-requests.mode", env);
  if (mode) return { mode: parsedMode(mode, "pull-requests.mode"), from: "the profile default" };
  return { mode: optionalStringSetting(legacyAutonomy, env) === "end" ? "auto" : "supervised", from: "the profile default" };
}

export const decidesAlone = (env: Env, repository?: string) => configuredMode(env, repository).mode !== "supervised";

export type Lineage = { threads: string[]; complete: boolean };

export function lineage(threads: ShellThread[], thread: string): Lineage {
  const chain: string[] = [];
  let current: ShellThread | undefined = matchThread(threads, thread, (item) => item.id);
  if (!current) return { threads: [thread], complete: false };
  while (current) {
    if (chain.includes(current.id)) return { threads: chain, complete: false };
    chain.push(current.id);
    const parent: string | null | undefined = current.lineage?.parentThreadId;
    if (!parent) return { threads: chain, complete: true };
    current = matchThread(threads, parent, (item) => item.id);
  }
  return { threads: chain, complete: false };
}

const isGrant = (event: LedgerEvent): event is ModeGrant => event.type === "mode" && grantedBy(event.words) === event.mode;

export function grantFor(events: LedgerEvent[], chain: string[]): (ModeGrant & { inherited: boolean }) | undefined {
  const grants = events.filter(isGrant);
  for (const [index, thread] of chain.entries()) {
    const latest = grants.filter((grant) => sameThread(grant.for, thread)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
    if (latest) return { ...latest, inherited: index > 0 };
  }
  return undefined;
}

export function resolveMode(env: Env, events: LedgerEvent[], chain: Lineage, repository?: string): ResolvedMode {
  const grant = grantFor(events, chain.threads);
  if (!grant) {
    const configured = configuredMode({ ...env, HEDGE_SETTINGS: withoutThreadMode(env) }, repository);
    return chain.complete || configured.mode !== "full" ? configured : { mode: "auto", from: `${configured.from}, held at auto: the thread's lineage could not be read in full, so a grant on a thread above it may be missing` };
  }
  const said = `${grant.at.slice(0, 10)} in thread ${grant.thread}`;
  return { mode: grant.mode, from: grant.inherited ? `inherited from thread ${grant.for}, granted ${said}` : `granted ${said}` };
}

function withoutThreadMode(env: Env) {
  if (!env.HEDGE_SETTINGS) return env.HEDGE_SETTINGS;
  const { [threadModeKey]: _, ...rest } = JSON.parse(env.HEDGE_SETTINGS) as Record<string, unknown>;
  return JSON.stringify(rest);
}

const heldAtAuto = (settings: Record<string, unknown>) => ({
  ...settings,
  ...String(settings["pull-requests.mode"]).trim().toLowerCase() === "full" ? { "pull-requests.mode": "auto" } : {},
  ...typeof settings["pull-requests.repoModes"] === "string" ? { "pull-requests.repoModes": settings["pull-requests.repoModes"].replace(/=\s*full\b/gi, "=auto") } : {},
});

export function withThreadMode(env: Env, events: LedgerEvent[], chain: Lineage): Env {
  const grant = grantFor(events, chain.threads);
  const settings = JSON.parse(withoutThreadMode(env) ?? "{}") as Record<string, unknown>;
  const scoped = grant ? { ...settings, [threadModeKey]: grant.mode } : chain.complete ? settings : heldAtAuto(settings);
  return { ...env, HEDGE_SETTINGS: JSON.stringify(scoped) };
}

export type ReadThreads = () => Promise<ShellThread[]>;

const t3CallMs = 3_000;

export const t3Threads = (home: string): ReadThreads => () =>
  withT3Session((client) => client.getShell<{ threads: ShellThread[] }>(), { home, ttl: "1m", timeoutMs: t3CallMs, runCli: t3CliRunner({ timeoutMs: t3CallMs }) }).then((shell) => shell.threads);

export async function chainOf(thread: string | undefined, threads: ReadThreads): Promise<Lineage> {
  if (!thread) return { threads: [], complete: true };
  try { return lineage(await threads(), thread); } catch { return { threads: [thread], complete: false }; }
}
