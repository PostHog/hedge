import { optionalStringSetting } from "../../base/lib/settings.ts";
import { matchThread, readThreadWords, t3CliRunner, t3UserData, withT3Session, type ShellThread } from "../../base/lib/t3/index.ts";
import { t3StatePath } from "../../base/lib/prune.ts";
import { sameThread, type Env, type LedgerEvent, type ModeGrant } from "./decision-ledger.ts";
import { type ThreadWord, type ThreadWords } from "./proof-answers.ts";
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

export const modeQuestion = (thread: string) => `Which mode should thread ${thread} run in?`;
export const modeChoices = modes.map((mode) => `mode ${mode}`);

export function grantedBy(choice: string): Mode | undefined {
  const match = /^mode (supervised|auto|full)(?: \(recommended\))?$/.exec(normalized(choice.replace(/^\s*\d{4}-\d{2}-\d{2}\s+/, "")));
  return match ? match[1] as Mode : undefined;
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

const counted = (chain: Lineage) => chain.complete ? chain.threads : chain.threads.slice(0, 1);

export function resolveMode(env: Env, events: LedgerEvent[], chain: Lineage, repository?: string): ResolvedMode {
  const grant = grantFor(events, counted(chain));
  if (!grant) {
    if (!chain.complete) return { mode: "supervised", from: "the thread's lineage could not be read in full, so it has no grant of its own to go by" };
    return configuredMode({ ...env, HEDGE_SETTINGS: withoutThreadMode(env) }, repository);
  }
  const said = `${grant.at.slice(0, 10)} in thread ${grant.thread}`;
  return { mode: grant.mode, from: grant.inherited ? `inherited from thread ${grant.for}, granted ${said}` : `granted ${said}` };
}

function withoutThreadMode(env: Env) {
  if (!env.HEDGE_SETTINGS) return env.HEDGE_SETTINGS;
  const { [threadModeKey]: _, ...rest } = JSON.parse(env.HEDGE_SETTINGS) as Record<string, unknown>;
  return JSON.stringify(rest);
}

export function fullHeldAtAuto(text: string | undefined): string {
  try {
    const settings: unknown = JSON.parse(text ?? "{}");
    return typeof settings === "object" && settings !== null && !Array.isArray(settings) ? JSON.stringify(heldAtAuto(settings as Record<string, unknown>)) : "{}";
  } catch { return "{}"; }
}

const strictness = (mode: Mode) => modes.indexOf(mode);
export const stricter = (a: Mode, b: Mode) => strictness(a) <= strictness(b) ? a : b;

const sameGrant = (a: ModeGrant, b: ModeGrant) => a.message === b.message && sameThread(a.thread, b.thread) && sameThread(a.for, b.for);

const askedAbove = (grant: ModeGrant, chain: Lineage) => {
  const from = chain.threads.findIndex((link) => sameThread(link, grant.for));
  return from >= 0 && chain.threads.slice(from).some((link) => sameThread(link, grant.thread));
};

export async function heardGrant(grant: ModeGrant, chain: Lineage, words: ThreadWords): Promise<boolean> {
  if (!askedAbove(grant, chain)) return false;
  const answers = await words(grant.thread).catch(() => []);
  return answers.some((answer) => answer.id === grant.message && answer.source === "question" && Date.parse(answer.at) === Date.parse(grant.at)
    && sameThread(askedFor(answer.answered) ?? "", grant.for) && grantedBy(answer.text) === grant.mode);
}

export async function withHeardFull(events: LedgerEvent[], chain: Lineage, words: ThreadWords): Promise<LedgerEvent[]> {
  let kept = events;
  for (let grant = grantFor(kept, counted(chain)); grant?.mode === "full" && !(await heardGrant(grant, chain, words)); grant = grantFor(kept, counted(chain))) {
    const unheard = grant;
    kept = kept.filter((event) => event.type !== "mode" || event.mode !== "full" || !sameGrant(event, unheard));
  }
  return kept;
}

export type ThreadReads = { threads: ReadThreads; words: ThreadWords };
export type T3Reader = <T>(run: (reads: ThreadReads) => Promise<T>) => Promise<T>;
export type HeardLedger = { lineage: Lineage; events: LedgerEvent[] };

export const givenReader = (reads: ThreadReads): T3Reader => (run) => run(reads);

export const t3Reader = (home: string): T3Reader => (run) => withT3Session((client) => {
  const read = new Map<string, Promise<ThreadWord[]>>();
  const words = (thread: string) => read.get(thread) ?? read.set(thread, readThreadWords(client, thread, t3StatePath(t3UserData(home)))).get(thread)!;
  return run({ threads: () => client.getShell<{ threads: ShellThread[] }>().then((shell) => shell.threads), words });
}, { home, ttl: "1m", timeoutMs: t3CallMs, runCli: t3CliRunner({ timeoutMs: t3CallMs }) });

export async function heardLedger(thread: string | undefined, events: LedgerEvent[], reader: T3Reader): Promise<HeardLedger> {
  if (!thread) return { lineage: { threads: [], complete: true }, events };
  try {
    return await reader(async (reads) => {
      const lineage = await chainOf(thread, reads.threads);
      return { lineage, events: await withHeardFull(events, lineage, reads.words) };
    });
  } catch {
    return { lineage: { threads: [thread], complete: false }, events: events.filter((event) => event.type !== "mode" || event.mode !== "full") };
  }
}

export const askedFor = (question: string) => /^which mode should thread (\S+) run in\?/i.exec(question.replace(/[`*"“”‘’']/g, "").trim())?.[1];

const heldAtAuto = (settings: Record<string, unknown>) => ({
  ...settings,
  ...String(settings["pull-requests.mode"]).trim().toLowerCase() === "full" ? { "pull-requests.mode": "auto" } : {},
  ...typeof settings["pull-requests.repoModes"] === "string" ? { "pull-requests.repoModes": settings["pull-requests.repoModes"].replace(/=\s*full\b/gi, "=auto") } : {},
});

export function withThreadMode(env: Env, events: LedgerEvent[], chain: Lineage): Env {
  const grant = grantFor(events, counted(chain));
  const settings = JSON.parse(withoutThreadMode(env) ?? "{}") as Record<string, unknown>;
  const scoped = grant ? { ...settings, [threadModeKey]: grant.mode } : chain.complete ? settings : { ...settings, [threadModeKey]: "supervised" };
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
