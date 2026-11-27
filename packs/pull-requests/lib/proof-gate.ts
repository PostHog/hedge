import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { modelFor, type ModelRow } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { covers, hubLedger, refText, riskCalloutOf, tierOf, type Env, type Ledger, type PrRef, type Ssh } from "./decision-ledger.ts";
import { ciOf, readPullRequest, type PullRequest, type Run } from "./pr-ci.ts";
import { ghThrough } from "./gh.ts";
import { openBotFindings } from "./pr-threads.ts";
import { askGap, authorOf, ciRunningCode, conditionName, isStandingCondition, judgeDirectory, judgeGap, judgeGapProof, listStanding, parseVerdict, prDirectory, proofGate, pullRequestDirectory, readDecisions, readJson, receiptOf, reviewRecords, withBrokenConditions, writeJson, type Arbiter, type Decisions, type JudgeSummary, type ProofIdentity, type ProofSummary, type PushedHead } from "./proof.ts";
import { displayEntry } from "./proof-display.ts";
import { receiptMarker } from "./proof-receipt.ts";
import { baseRefs, cleanBaseMerge, devPullOf, diffOf, mergeBase, pullRequestDetails, remotesOf, topLevel } from "./proof-checkout.ts";
import { gitCommitReader, quietCommitIn, testOnlyRange } from "./proof-delta.ts";
import { isCommitSha, measureGrowth, type Growth } from "./proof-end-table.ts";
import { autonomyOf, decidesAll } from "./proof-autonomy.ts";
import { heldNames, mergeCardLine, readTimeline } from "./proof-merge-card.ts";
import { readSanity } from "./proof-sanity.ts";
import { inputsDigest, readBloat } from "./proof-bloat.ts";
import { judge, readCriticalPaths, type JudgeInput } from "./proof-judge.ts";
import { withRoundLock, type RoundLock } from "./proof-panel.ts";
import { askModel, modelLabel, otherFamily, readRiskRubric, readRubric, reviewerRow, skillReferences } from "./proof-models.ts";

export type GateContext = { home: string; cwd: string; env: Env; run: Run; now?: () => Date; ssh?: Ssh };
export type JudgingContext = GateContext & { lock: () => Promise<RoundLock> };
export type FinalGate = { code: number; reason: string; lines: string[]; verdict: string; summary: ProofSummary; cardOf?: () => string; seenGaps?: string[] };

type Checked = Awaited<ReturnType<typeof proofGate>>;
type Judged = { code: number; lines: string[]; covered: string; judge: JudgeSummary; reason?: string };
type GateKey = { head: string; base: string; baseSha: string; tier: string; callout: string; landed: boolean; fingerprint: string; endTable: true };
type Condition = Checked["conditions"][number];
type SavedGate = { key: GateKey; gate: FinalGate; conditions: Condition[] };

export const reviewLimit = (env: Env) => numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;

const arbiterLimit = 180_000;

export const arbiterOf = ({ env, cwd }: Pick<GateContext, "env" | "cwd">): Arbiter => async (prompt) => {
  const answer = await askModel("arbiter", modelFor("lookup", env), { prompt, cwd }, env, arbiterLimit);
  return answer.ok ? parseVerdict(answer.text, answer.model) : { verdict: "unavailable", reason: answer.cause, model: answer.model };
};

const savedPath = (home: string, ref: PrRef, commit: string) => join(pullRequestDirectory(home, { ...ref, commit }), "gate-outcome", `${commit}.json`);
const unhashed = new Set(["gate-outcome", "gate-record", "judge", "carried", "receipt.json", displayEntry]);

async function proofFiles(home: string, ref: PrRef) {
  const root = prDirectory(home, ref);
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !unhashed.has(path.split(sep)[0]!)).sort();
  const hash = createHash("sha256");
  for (const path of files) hash.update(`${path}\0`).update(await readFile(join(root, path))).update("\0");
  return hash.digest("hex");
}

async function fingerprintOf(home: string, ref: PrRef, files: string, decisions: Decisions) {
  const covering = Array.isArray(decisions) ? decisions.filter((decision) => covers(decision, ref)) : "unreachable";
  return createHash("sha256").update(JSON.stringify({ files, covering, standing: await listStanding(home) })).digest("hex");
}

const keyOf = (pull: PullRequest, landed: boolean, fingerprint: string): GateKey =>
  ({ head: pull.head, base: pull.base, baseSha: pull.baseSha, tier: tierOf(pull.body), callout: createHash("sha256").update(riskCalloutOf(pull.body) ?? "").digest("hex"), landed, fingerprint, endTable: true });

export async function finalGate(head: ProofIdentity, context: JudgingContext, { landed = false }: { landed?: boolean } = {}): Promise<FinalGate> {
  const { home, env, run, now, ssh } = context;
  let pull: PullRequest | undefined;
  const pushedHead = pushedHeadOf(head, run, (read) => { pull ??= read; });
  const files = await proofFiles(home, head);
  const checked = await proofGate(home, head, {
    landed, cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run, () => baseRefs(head, run)), ci: () => ciOf(home, head, run, now?.() ?? new Date(), env),
    pushedHead, openBotFindings: botFindingsOf(head, run), ledger: hubLedger(home, env, ssh), now: now?.(), devPull: devPullOf(run), decidesAll: decidesAll(env),
  });
  const judged: Judged = checked.code === 0 ? await judgeHead(head, checked, context, pull as PullRequest | undefined) : { code: checked.code, lines: [], covered: "", judge: { state: "skipped", lines: [] }, reason: checked.failure };
  const shown = pull === undefined ? undefined : receiptMarker((pull as PullRequest).body);
  const stale = shown && shown.head !== head.commit ? [`receipt: the PR body shows the receipt of ${shown.head.slice(0, 7)}, not HEAD ${head.commit.slice(0, 7)}. Refresh it with hedge proof receipt`] : [];
  const growth = await grownBy(home, head, run, pull);
  const reason = judged.code === 0 ? "pass" : judged.reason?.replace(/\s*[\r\n]+\s*/g, " ").trim() || `exit ${judged.code} without a named check`;
  const gate = {
    code: judged.code,
    reason,
    lines: [...checked.lines, ...judged.lines, ...stale, ...unmeasured(head, run, pull, growth, landed)],
    verdict: verdictOf(judged.code, reason, `${checked.summary}; judge: ${judged.covered}`),
    summary: { ...checked.proofSummary, code: judged.code, judge: judged.judge, growth },
  };
  if (!pull) return gate;
  const read = pull as PullRequest;
  await writeJson(savedPath(home, head, head.commit), { key: keyOf(read, landed, await fingerprintOf(home, head, files, checked.decisions)), gate, conditions: checked.conditions } satisfies SavedGate);
  if (gate.code !== 0) return gate;
  const seenGaps = Array.isArray(checked.decisions) ? checked.decisions.filter((decision) => decision.mark === "🤖" && decision.class === "proof-gap" && covers(decision, head)).map((decision) => decision.id) : [];
  const held = Array.isArray(checked.decisions) ? heldNames(gate.summary, checked.decisions) : [];
  return { ...gate, seenGaps, cardOf: () => mergeCardLine({ ref: head, summary: gate.summary, body: read.body, timeline: readTimeline(head, read, run), held }, now?.() ?? new Date()) };
}

const verdictOf = (code: number, reason: string, covered: string) =>
  code === 0 ? `gate: pass (${covered})`
    : code === ciRunningCode ? `gate: pending (exit ${code}): ${reason}. Run the gate again with --wait <minutes>, such as --wait 10, to wait for CI to finish`
    : `gate: fail (exit ${code}): ${reason}`;

function unmeasured(head: ProofIdentity, run: Run, pull: PullRequest | undefined, growth: Growth, landed: boolean) {
  if (growth.final || !isCommitSha(pull?.baseSha) || run(["env", "GIT_NO_LAZY_FETCH=1", "git", "cat-file", "-e", `${pull.baseSha}^{commit}`]).code === 0) return [];
  const remote = remotesOf(head.repository, run)[0] ?? `<a remote of ${head.repository}>`;
  return [`growth: unknown at HEAD, since the base commit ${pull.baseSha.slice(0, 7)} that GitHub reports is not in this checkout. Run git fetch ${remote} ${pull.baseSha}, then hedge proof gate${landed ? " --landed" : ""} again`];
}

async function grownBy(home: string, head: ProofIdentity, run: Run, pull: PullRequest | undefined): Promise<Growth> {
  const growth = await measureGrowth(home, head, run, pull?.baseSha);
  const [sanity, bloat] = [(await readSanity(home, head)).at(-1), await readBloat(home, head, () => inputsDigest(head, run, growth, pull?.body ?? ""))];
  return { ...growth, ...sanity ? { sanity } : {}, ...bloat ? { bloat } : {} };
}

const botFindingsOf = (head: PrRef, run: Run) => () => openBotFindings({ repo: head.repository, pr: head.pr }, ghThrough(run));

const pushedHeadOf = (head: ProofIdentity, run: Run, seen: (pull: PullRequest) => void = () => {}) => (): PushedHead => {
  try {
    const read = readPullRequest(head, run);
    seen(read);
    return { commit: read.head, body: read.body };
  } catch (error) { return { error: (error as Error).message }; }
};

export async function currentSummary(ref: PrRef, pull: PullRequest, ledger: Ledger, context: GateContext): Promise<ProofSummary | undefined> {
  const saved = await savedGate(context.home, ref, pull, ledger);
  if (!saved) return undefined;
  const { home, env, run, now } = context;
  const head = { ...ref, commit: pull.head };
  let readAsSaved = true;
  const live = await proofGate(home, head, {
    landed: pull.state === "merged", cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run, () => baseRefs(head, run)),
    ci: () => ciOf(home, head, run, now?.() ?? new Date(), env),
    pushedHead: pushedHeadOf(head, run, (read) => { readAsSaved &&= JSON.stringify(keyOf(read, saved.key.landed, saved.key.fingerprint)) === JSON.stringify(saved.key); }), openBotFindings: botFindingsOf(head, run),
    ledger, now: now?.(), devPull: devPullOf(run), decidesAll: decidesAll(env),
  });
  const judged = readAsSaved && JSON.stringify(live.conditions) === JSON.stringify(saved.conditions) && live.proofSummary.ci.line === saved.gate.summary.ci.line && JSON.stringify(live.proofSummary.ci.checks) === JSON.stringify(saved.gate.summary.ci.checks);
  const receipt = await receiptOf(home, ref);
  return { ...saved.gate.summary, ...receipt ? { receipt } : {}, ...live.proofSummary, code: live.code !== 0 ? live.code : judged ? saved.gate.code : 1 };
}

export async function receiptSummary(head: ProofIdentity, pull: PullRequest, ledger: Ledger, context: GateContext): Promise<{ summary: ProofSummary; gated: boolean }> {
  const current = await currentSummary(head, pull, ledger, context);
  if (current) return { summary: current, gated: true };
  const { home, env, run, now } = context;
  const live = await proofGate(home, head, {
    landed: pull.state === "merged", cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run, () => baseRefs(head, run)),
    ci: () => ciOf(home, head, run, now?.() ?? new Date(), env), pushedHead: pushedHeadOf(head, run), openBotFindings: botFindingsOf(head, run), ledger, now: now?.(), devPull: devPullOf(run), decidesAll: decidesAll(env),
  });
  return { summary: { ...live.proofSummary, code: live.code, judge: { state: "skipped", lines: [] } }, gated: false };
}

async function savedGate(home: string, ref: PrRef, pull: PullRequest, ledger: Ledger): Promise<SavedGate | undefined> {
  const saved = await readJson<SavedGate | undefined>(savedPath(home, ref, pull.head), undefined);
  if (!saved) return undefined;
  const key = keyOf(pull, pull.state === "merged", await fingerprintOf(home, ref, await proofFiles(home, ref), await readDecisions(ledger)));
  return JSON.stringify(saved.key) === JSON.stringify(key) ? saved : undefined;
}

async function judgeHead(head: ProofIdentity, checked: Checked, context: JudgingContext, snapshot?: PullRequest): Promise<Judged> {
  const { home, env, run, now } = context;
  const author = await authorOf(home, head);
  const row = reviewerRow(author, env);
  const riskRubric = await readRiskRubric(home);
  const today = now?.() ?? new Date();
  const weighedGap = await judgeGap(home, head, today, checked.decisions, checked.tier, decidesAll(env));
  const known = {
    risk: riskRubric === undefined ? undefined : { rubric: riskRubric, body: snapshot?.body ?? pullRequestDetails(head, run).body },
    shape: snapshot && snapshot.state !== "merged" && riskCalloutOf(snapshot.body) !== undefined ? snapshot.body : undefined,
    commit: head.commit, crossFamily: otherFamily(row, author), ci: checked.ci, owed: checked.owed!, ledger: checked.lines,
    evidence: checked.evidence, reviews: await reviewRecords(home, head), rubric: await readRubric(home), references: skillReferences(home),
    conditions: [...checked.conditions, ...weighedGap?.condition ? [weighedGap.condition] : []], criticalPaths: await readCriticalPaths(home, head.repository, env),
  };
  const outcome = await judgeDiff(head, known, row, context);
  const verdict = (lines: string[], gap?: JudgeSummary["gap"]): JudgeSummary => ({ state: outcome.state, model: outcome.model, ...gap ? { gap } : {}, lines });
  if (riskRubric === undefined) outcome.lines.push("judge risk: not asked; ~/.agents/skills/merge-risk/SKILL.md is not installed");
  const reason = outcome.lines.find((line) => /^judge [a-z]+: fail\b/.test(line)) ?? outcome.lines[0];
  if (outcome.state === "pass") return { code: 0, lines: outcome.lines, covered: `pass by ${outcome.model}`, judge: verdict(outcome.lines) };
  const spentUnchecked = outcome.unchecked ?? [];
  if (spentUnchecked.length) {
    const line = `judge gap: the judge budget is spent, so no judge checks the condition of ${spentUnchecked.map(conditionName).join(" or ")}, and no judge gap passes the gate while it rests on one. ${endSpent(spentUnchecked)}`;
    const lines = [...outcome.lines, line];
    const open = weighedGap && { ...weighedGap, acceptance: undefined, line: `not accepted (the judge budget is spent, so no judge checks the condition of ${spentUnchecked.map(conditionName).join(" or ")})` };
    return { code: 1, lines, covered: "", judge: verdict(lines, open && judgeGapProof(head.commit, open)), reason: line };
  }
  const gap = weighedGap && withBrokenConditions(weighedGap, outcome.broken);
  const unchecked = outcome.held ? [...new Set(known.conditions.map(({ id }) => id))] : [];
  if (gap?.acceptance && unchecked.length) {
    const line = `not accepted (the secret guard held the judge prompt, so no judge checked the condition of ${unchecked.map(conditionName).join(" and ")})`;
    const lines = [...outcome.lines, `judge gap: ${line}: ${gap.reason}. ${endUnchecked(unchecked)}`];
    return { code: 3, lines, covered: "", judge: verdict(lines, judgeGapProof(head.commit, { ...gap, acceptance: undefined, line })), reason: `judge gap: ${line}` };
  }
  const shapeFailure = outcome.lines.find((line) => line.startsWith("judge shape: fail"));
  if (gap?.acceptance && shapeFailure) {
    const line = "judge gap: a judge gap never waives the shape question. Edit the PR body to fix it, then run the gate again";
    const lines = [...outcome.lines, line];
    return { code: 1, lines, covered: "", judge: verdict(lines), reason: shapeFailure };
  }
  if (gap?.acceptance) {
    const lines = [...outcome.lines, `judge gap: ${gap.acceptance.line}: ${gap.reason}`];
    return { code: 0, lines, covered: `${outcome.state} accepted by ${gap.acceptance.by}`, judge: verdict(lines, judgeGapProof(head.commit, gap)) };
  }
  if (gap) {
    const lines = [...outcome.lines, `judge gap: ${gap.line}: ${gap.reason}. ${gap.broken ? endBroken(gap.broken) : askGap(head, "judge", gap.reason, gap.kept ? "ask" : autonomyOf(context.env, () => checked.grade, "proof-gap", ["judge"]))}`];
    return { code: 3, lines, covered: "", judge: verdict(lines, judgeGapProof(head.commit, gap)), reason: `judge gap: ${gap.line}: ${gap.reason}` };
  }
  const hint = checked.tier === "ungraded"
    ? `judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why>, then grade the PR with merge-risk before you decide it: an agent never decides on an ungraded PR`
    : checked.grade.oneWay && !decidesAll(env)
    ? "judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why> and ask the user; on ask an agent never decides on a one-way door"
    : `judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why> and decide it with hedge decision record --mark 🤖 --class proof-gap --kind judge --pr ${refText(head)} --question <q> --answer <a> --rejected <option> --reason <why>${decidesAll(env) ? "" : ", or ask the user"}`;
  const lines = [...outcome.lines, hint];
  return { code: 1, lines, covered: "", judge: verdict(lines), reason };
}

async function judgeDiff(head: ProofIdentity, known: Omit<JudgeInput, "cwd" | "from" | "diff" | "testOnly">, row: ModelRow, context: JudgingContext) {
  const { home, cwd, env, run, now, lock } = context;
  const from = mergeBase(head, run);
  const directory = judgeDirectory(home, head);
  const testOnly = testOnlyRange(gitCommitReader(run, () => baseRefs(head, run)), from, known.commit);
  return judge({ ...known, cwd: topLevel(run) ?? cwd, from, diff: diffOf(from, known.commit, run), testOnly }, {
    ask: (request) => askModel("judge", row, request, env, reviewLimit(env)), model: modelLabel("judge", row, env), arbiter: arbiterOf(context),
    directory, commit: known.commit, now: now?.() ?? new Date(), failLimit: numberSetting("pull-requests.reviewCeiling", env), decidesAll: decidesAll(env),
    serialize: async (step) => { await mkdir(directory, { recursive: true, mode: 0o700 }); return withRoundLock(directory, await lock(), step); },
  });
}

function endSpent(ids: string[]) {
  const decisions = ids.filter((id) => !isStandingCondition(id));
  const rules = ids.filter(isStandingCondition);
  return [
    ...decisions.length ? [`End ${decisions.map(conditionName).join(" and ")} with hedge decision void <id> --reason <why>, then decide it again without a condition`] : [],
    ...rules.length ? [`Only the user can raise pull-requests.reviewCeiling, so the judge runs again and checks ${rules.join(" and ")}`] : [],
  ].join(". ");
}

function endUnchecked(ids: string[]) {
  const rules = ids.filter(isStandingCondition);
  const decisions = endBroken(ids.filter((id) => !isStandingCondition(id)));
  return [...decisions ? [decisions] : [], ...rules.length ? [`Remove the value the secret guard matches so the judge can check ${rules.join(" and ")}, then run hedge proof gate again`] : []].join(". ");
}

function endBroken(ids: string[]) {
  const decisions = ids.filter((id) => !isStandingCondition(id));
  const rules = ids.filter(isStandingCondition);
  return [
    ...decisions.length ? [`End ${decisions.map(conditionName).join(" and ")} with hedge decision void <id> --reason <why its condition no longer holds>, then decide or ask again`] : [],
    ...rules.length ? [`Meet the condition of ${rules.join(" and ")} that the judge names, then run hedge proof gate again`] : [],
  ].join(". ");
}
