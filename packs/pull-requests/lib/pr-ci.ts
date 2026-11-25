import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import type { CiResult, ProofIdentity } from "./proof.ts";

export type Run = (command: string[]) => { code: number; stdout: string; stderr: string };

export const runIn = (cwd: string, env: Record<string, string | undefined>): Run => (command) => {
  try {
    const child = Bun.spawnSync(command, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${command[0]}: ${(error as Error).message}` };
  }
};
export type PullRequest = { title: string; body: string; draft: boolean; state: "open" | "closed" | "merged"; head: string; base: string; baseSha: string; defaultBranch?: string; mergedAt?: string; mergeCommit?: string };

type CheckRun = { id: number; name: string; status: string; conclusion: string | null; app?: number | null };
type CommitStatus = { context: string; state: string; creator?: { login?: string; type?: string } | null };
type RequiredCheck = { context: string; appId?: number; rulesets?: number[]; postedOnceReady?: true; changedAfterMerge?: true };
type Outcome = "pass" | "fail" | "pending";
type Entry = { name: string; outcome: Outcome; appId?: number; status?: true; botLogin?: string };

const passing = new Set(["success", "neutral", "skipped"]);
const rank: Record<Outcome, number> = { pass: 0, pending: 1, fail: 2 };
const cacheMs = 60 * 60_000;
const cacheVersion = 2;
const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] || "no output";

export function restJson<T>(path: string, run: Run): T {
  const result = run(["gh", "api", path]);
  if (result.code !== 0) throw new Error(`gh api ${path.split("?")[0]} failed (${firstLine(result.stderr)})`);
  return JSON.parse(result.stdout) as T;
}

export function readPullRequest(identity: ProofIdentity, run: Run): PullRequest {
  type Raw = { title?: string; body?: string | null; draft?: boolean; state?: string; merged_at?: string | null; merge_commit_sha?: string | null; head?: { sha?: string }; base?: { ref?: string; sha?: string; repo?: { default_branch?: string } } };
  const raw = restJson<Raw>(`repos/${identity.repository}/pulls/${identity.pr}`, run);
  const state = raw.merged_at ? "merged" : raw.state === "closed" ? "closed" : "open";
  return { title: raw.title ?? "", body: raw.body ?? "", draft: raw.draft === true, state, head: raw.head?.sha ?? "", base: raw.base?.ref ?? "", baseSha: raw.base?.sha ?? "", defaultBranch: raw.base?.repo?.default_branch, ...raw.merged_at ? { mergedAt: raw.merged_at } : {}, ...raw.merged_at && raw.merge_commit_sha ? { mergeCommit: raw.merge_commit_sha } : {} };
}

const commentPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)#issuecomment-(\d+)$/;

export type CommentUrl = { repository: string; pr: number; id: string };

export function commentUrl(url: string): CommentUrl {
  const [, repository, pr, id] = commentPattern.exec(url) ?? [];
  if (!repository || !pr || !id) throw new Error(`--comment takes the URL of a GitHub issue or PR comment, such as https://github.com/owner/repo/issues/1#issuecomment-2, not ${url}`);
  return { repository, pr: Number(pr), id };
}

export function readComment(url: string, run: Run): CommentUrl {
  const named = commentUrl(url);
  type Raw = { issue_url?: string };
  const raw = restJson<Raw>(`repos/${named.repository}/issues/comments/${named.id}`, run);
  const [, repository = "", pr = ""] = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(raw.issue_url ?? "") ?? [];
  const on = repository ? `${repository}#${pr}` : "no PR GitHub names";
  if (on.toLowerCase() !== `${named.repository}#${named.pr}`.toLowerCase()) throw new Error(`The comment ${url} is on ${on}, not on ${named.repository}#${named.pr}`);
  return named;
}

function readRequired(repository: string, branch: string, run: Run): RequiredCheck[] {
  const checks = new Map<string, RequiredCheck>();
  const add = (context: string, appId?: number | null, ruleset?: number) => {
    const key = `${context}\n${appId ?? ""}`;
    const known = checks.get(key);
    const rulesets = ruleset === undefined || (known && !known.rulesets) ? undefined : [...new Set([...known?.rulesets ?? [], ruleset])];
    checks.set(key, { context, ...appId ? { appId } : {}, ...rulesets ? { rulesets } : {} });
  };
  type Rule = { type: string; ruleset_id?: number; parameters?: { required_status_checks?: { context: string; integration_id?: number }[] } };
  const encoded = encodeURIComponent(branch);
  for (let page = 1; ; page++) {
    const rules = run(["gh", "api", `repos/${repository}/rules/branches/${encoded}?per_page=100&page=${page}`]);
    if (rules.code !== 0) {
      if (page === 1 && /HTTP 404|Upgrade to GitHub/.test(rules.stderr)) break;
      throw new Error(`cannot read the rulesets of ${branch} over REST (${firstLine(rules.stderr)})`);
    }
    const list = JSON.parse(rules.stdout) as Rule[];
    for (const rule of list) if (rule.type === "required_status_checks") for (const check of rule.parameters?.required_status_checks ?? []) add(check.context, check.integration_id, rule.ruleset_id);
    if (list.length < 100) break;
  }
  type Branch = { protection?: { required_status_checks?: { enforcement_level?: string; contexts?: string[]; checks?: { context: string; app_id?: number | null }[] } } };
  const branchView = run(["gh", "api", `repos/${repository}/branches/${encoded}`]);
  if (branchView.code !== 0) throw new Error(`cannot read the protection of ${branch} over REST (${firstLine(branchView.stderr)})`);
  const classic = (JSON.parse(branchView.stdout) as Branch).protection?.required_status_checks;
  if (classic && classic.enforcement_level !== "off") {
    for (const check of classic.checks ?? []) add(check.context, check.app_id);
    const pinned = new Set((classic.checks ?? []).map((check) => check.context));
    for (const context of classic.contexts ?? []) {
      if (pinned.has(context)) continue;
      const named = [...checks.values()].filter((check) => check.context === context);
      if (!named.length) add(context);
      for (const check of named) delete check.rulesets;
    }
  }
  return [...checks.values()];
}

function requiredChecks(home: string, repository: string, branch: string, run: Run, now: Date, fresh: boolean): RequiredCheck[] {
  const path = join(home, ".local/state/hedge/required-checks", repository, `${encodeURIComponent(branch)}.json`);
  if (!fresh) try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as { version?: number; fetchedAt: string; checks: RequiredCheck[] };
    const age = now.getTime() - new Date(cached.fetchedAt).getTime();
    if (cached.version === cacheVersion && age >= 0 && age < cacheMs) return cached.checks;
  } catch {}
  const checks = readRequired(repository, branch, run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: cacheVersion, fetchedAt: now.toISOString(), checks }));
  return checks;
}

function rulesetChangedAt(repository: string, ruleset: number, run: Run): number | undefined {
  const result = run(["gh", "api", `repos/${repository}/rulesets/${ruleset}`]);
  if (result.code !== 0) return undefined;
  const changed = Date.parse((JSON.parse(result.stdout) as { updated_at?: string }).updated_at ?? "");
  return Number.isFinite(changed) ? changed : undefined;
}

function markChangedAfterMerge(required: RequiredCheck[], repository: string, mergedAt: string, run: Run): RequiredCheck[] {
  const merged = Date.parse(mergedAt);
  const changed = new Map<number, number | undefined>();
  const changedAt = (ruleset: number) => changed.has(ruleset) ? changed.get(ruleset) : changed.set(ruleset, rulesetChangedAt(repository, ruleset, run)).get(ruleset);
  return required.map((check) => check.rulesets?.length && check.rulesets.every((ruleset) => (changedAt(ruleset) ?? -Infinity) > merged) ? { ...check, changedAfterMerge: true as const } : check);
}

function commitRecords<T>(identity: ProofIdentity, run: Run, path: string, jq: string): T[] {
  const result = run(["gh", "api", "--paginate", `repos/${identity.repository}/commits/${identity.commit}/${path}?per_page=100`, "--jq", jq]);
  if (result.code !== 0) throw new Error(`gh api ${path} failed (${firstLine(result.stderr)})`);
  try { return result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T); }
  catch { throw new Error(`gh api ${path} printed no JSON lines`); }
}

function entriesOf(identity: ProofIdentity, run: Run): Entry[] {
  const runs = commitRecords<CheckRun>(identity, run, "check-runs", ".check_runs[] | {id, name, status, conclusion, app: .app.id}");
  const newestRuns = [...runs.reduce((newest, check) => {
    const key = `${check.name}\n${check.app ?? ""}`;
    if ((newest.get(key)?.id ?? -1) < check.id) newest.set(key, check);
    return newest;
  }, new Map<string, CheckRun>()).values()];
  const statuses = commitRecords<CommitStatus>(identity, run, "statuses", ".[]");
  const newest = statuses.filter((status, index) => statuses.findIndex((other) => other.context === status.context) === index);
  return [
    ...newestRuns.map((check): Entry => ({ name: check.name, appId: check.app ?? undefined, outcome: check.status !== "completed" ? "pending" : passing.has(check.conclusion ?? "") ? "pass" : "fail" })),
    ...newest.map((status): Entry => ({ name: status.context, status: true, ...botOf(status), outcome: status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail" })),
  ];
}

const botSuffix = "[bot]";
const botOf = ({ creator }: CommitStatus) => creator?.type === "Bot" && creator.login?.endsWith(botSuffix) ? { botLogin: creator.login } : {};

function appOfBot(bot: string, run: Run): number | undefined {
  const result = run(["gh", "api", `apps/${bot.slice(0, -botSuffix.length)}`]);
  if (result.code === 0) {
    const { id } = JSON.parse(result.stdout) as { id?: unknown };
    return typeof id === "number" ? id : undefined;
  }
  if (/HTTP 404/.test(result.stderr)) return undefined;
  throw new Error(`cannot read the app behind ${bot} over REST (${firstLine(result.stderr)})`);
}

const workflowOf = (context: string) => {
  const split = context.indexOf(" / ");
  return split > 0 ? context.slice(0, split + 3) : undefined;
};

function withPinnedStatuses(entries: Entry[], required: RequiredCheck[], draft: boolean, run: Run): Entry[] {
  const pins = required.filter((check) => check.appId !== undefined);
  const apps = new Map<string, number | undefined>();
  const appOf = (bot: string) => apps.has(bot) ? apps.get(bot) : apps.set(bot, appOfBot(bot, run)).get(bot);
  const spelledTwice = (entry: Entry) => entries.some((other) => other.status && other.name !== entry.name && other.name.toLowerCase() === entry.name.toLowerCase());
  const canWaive = (check: RequiredCheck, workflow: string) => {
    const runs = entries.filter((other) => !other.status && other.appId === check.appId && other.name.startsWith(workflow));
    return draft && !entries.some((other) => other.name === check.context) && runs.length > 0 && runs.every((other) => other.outcome === "pass");
  };
  const nearPin = (entry: Entry) => pins.some((check) => {
    const workflow = workflowOf(check.context);
    return check.context === entry.name || (entry.outcome !== "pass" && workflow !== undefined && entry.name.startsWith(workflow) && canWaive(check, workflow));
  });
  return entries.map((entry) => {
    if (!entry.status || !entry.botLogin || !nearPin(entry) || spelledTwice(entry)) return entry;
    const appId = appOf(entry.botLogin);
    return appId === undefined ? entry : { ...entry, appId };
  });
}

function listOf(names: string[], limit = 8) {
  const unique = [...new Set(names)];
  return unique.length > limit ? `${unique.slice(0, limit).join(", ")} and ${unique.length - limit} more` : unique.join(", ");
}

const reportedBy = (check: RequiredCheck, entry: Entry) => check.appId === undefined || entry.appId === check.appId;

function withheldFromDraft(check: RequiredCheck, entries: Entry[]) {
  const workflow = workflowOf(check.context);
  if (!workflow || entries.some((entry) => entry.name === check.context)) return false;
  const siblings = entries.filter((entry) => entry.name.startsWith(workflow) && reportedBy(check, entry));
  return siblings.length > 0 && siblings.every((entry) => entry.outcome === "pass") && (check.appId === undefined || siblings.some((entry) => !entry.status));
}

function everyCheck(entries: Entry[], commit: string): CiResult {
  if (!entries.length) return { state: "none", detail: `no checks reported on ${short(commit)}` };
  const named = (outcome: Outcome) => entries.filter((entry) => entry.outcome === outcome).map((entry) => entry.name);
  const [failing, pending] = [named("fail"), named("pending")];
  if (failing.length) return { state: "red", detail: `failing: ${listOf(failing)}` };
  if (pending.length) return { state: "pending", detail: `waiting on: ${listOf(pending)}` };
  return { state: "green", detail: `${entries.length} check(s) on ${short(commit)}` };
}

function notRequired(entries: Entry[], { countRunning = true } = {}) {
  const failing = entries.filter((entry) => entry.outcome === "fail").map((entry) => entry.name);
  const running = countRunning ? new Set(entries.filter((entry) => entry.outcome === "pending").map((entry) => entry.name)).size : 0;
  const parts = [failing.length ? `failing: ${listOf(failing)}` : "", running ? `${running} still running` : ""].filter(Boolean);
  return parts.length ? `; not required: ${parts.join("; ")}` : "";
}

const reportOf = (check: RequiredCheck) => (entry: Entry) => entry.name === check.context && (entry.status || check.appId === undefined || entry.appId === check.appId);

function personPassed(required: RequiredCheck[], entries: Entry[], listed: Set<string>) {
  const alone = (check: RequiredCheck) => {
    const workflow = workflowOf(check.context);
    return required.every((other) => other === check || (other.context !== check.context && (workflow === undefined || !other.context.startsWith(workflow))));
  };
  const onlyItsOwn = (check: RequiredCheck) => entries.every((entry) => entry.name !== check.context || reportOf(check)(entry));
  return required.filter((check) => listed.has(check.context) && alone(check) && onlyItsOwn(check));
}

function requiredVerdict(entries: Entry[], required: RequiredCheck[], draft: boolean): CiResult {
  const counted = new Set<Entry>();
  const [failing, pending, missing, withheld, listed, later]: string[][] = [[], [], [], [], [], []];
  for (const check of required) {
    const named = entries.filter((entry) => entry.name === check.context);
    const own = named.filter((entry) => reportedBy(check, entry));
    const matches = own.some((entry) => entry.status) ? [...new Set([...own, ...named.filter((entry) => !entry.status)])] : own;
    matches.forEach((entry) => counted.add(entry));
    if (!matches.length) { (check.changedAfterMerge ? later : !draft ? missing : check.postedOnceReady && !entries.some((entry) => entry.name.toLowerCase() === check.context.toLowerCase()) ? listed : withheldFromDraft(check, entries) ? withheld : missing).push(check.context); continue; }
    const worst = matches.reduce((a, b) => rank[b.outcome] > rank[a.outcome] ? b : a).outcome;
    if (worst === "fail") failing.push(check.context);
    else if (worst === "pending") pending.push(check.context);
  }
  const verdict: CiResult = failing.length ? { state: "red", detail: `required failing: ${listOf(failing)}` }
    : pending.length || missing.length ? { state: "pending", detail: [pending.length ? `required waiting on: ${listOf(pending)}` : "", missing.length ? `required not reported yet: ${listOf(missing)}` : ""].filter(Boolean).join("; ") }
    : { state: "green", detail: `${required.length - withheld.length - listed.length - later.length} required check(s) pass` };
  if (withheld.length) verdict.detail += `; withheld from drafts, required once ready: ${listOf(withheld)} (its workflow finished without posting it)`;
  if (listed.length) verdict.detail += `; withheld from drafts, required once ready: ${listOf(listed)} (pull-requests.draftSkippedChecks lists it)`;
  if (later.length) verdict.detail += `; not judged, never reported and its ruleset changed after the merge: ${listOf(later)}`;
  verdict.detail += notRequired(entries.filter((entry) => !counted.has(entry)), { countRunning: verdict.state === "green" });
  return verdict;
}

const sourceOf = (entry: Entry) => [entry.status ? "status" : "", entry.appId === undefined ? "" : `app ${entry.appId}`].filter(Boolean).join(", ");
const checksOf = (entries: Entry[]) => [...new Set(entries.map((entry) => `${entry.name}${sourceOf(entry) ? ` (${sourceOf(entry)})` : ""}: ${entry.outcome}`))].sort();

function listedChecks(key: string, repository: string, env: Record<string, string | undefined>) {
  const pairs = (optionalStringSetting(key, env) ?? "").split(",").map((pair) => pair.trim()).filter(Boolean);
  return new Set(pairs.flatMap((pair) => {
    const split = pair.indexOf("=");
    return split > 0 && pair.slice(0, split).trim().toLowerCase() === repository.toLowerCase() ? [pair.slice(split + 1).trim()] : [];
  }));
}

export function ciOf(home: string, identity: ProofIdentity, run: Run, now: Date, env: Record<string, string | undefined>): CiResult {
  try {
    const pr = readPullRequest(identity, run);
    const fresh = pr.mergedAt !== undefined;
    let required = requiredChecks(home, identity.repository, pr.base, run, now, fresh);
    const stacked = !required.length && pr.defaultBranch !== undefined && pr.defaultBranch !== pr.base;
    if (stacked) required = requiredChecks(home, identity.repository, pr.defaultBranch!, run, now, fresh);
    const reported = entriesOf(identity, run);
    const byPerson = stacked ? [] : personPassed(required, reported, listedChecks("pull-requests.personChecks", identity.repository, env));
    const entries = reported.filter((entry) => !byPerson.some((check) => reportOf(check)(entry)));
    required = required.filter((check) => !byPerson.includes(check));
    if (!required.length && !byPerson.length) return { ...everyCheck(entries, identity.commit), checks: checksOf(entries) };
    const readyOnly = pr.draft ? listedChecks("pull-requests.draftSkippedChecks", identity.repository, env) : new Set<string>();
    required = required.map((check) => readyOnly.has(check.context) ? { ...check, postedOnceReady: true as const } : check);
    if (pr.mergedAt) required = markChangedAfterMerge(required, identity.repository, pr.mergedAt, run);
    const counted = withPinnedStatuses(entries, required, pr.draft, run);
    const verdict = requiredVerdict(counted, required, pr.draft);
    if (byPerson.length) verdict.detail += `; a person passes it on GitHub, so the gate does not wait on it: ${listOf(byPerson.map((check) => check.context))}`;
    return { ...stacked ? { ...verdict, detail: `${verdict.detail} (required by ${pr.defaultBranch}; the base ${pr.base} requires none)` } : verdict, checks: checksOf(counted) };
  } catch (error) {
    return { state: "unknown", detail: (error as Error).message };
  }
}
