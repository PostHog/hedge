import { readPullRequest, type Run } from "./pr-ci.ts";
import { reviewedDiff } from "./proof-review.ts";
import { isTestFile } from "./proof-delta.ts";
import { riskCalloutOf } from "./decision-ledger.ts";
import type { CleanBaseMerge, DevPr, DevPull, ProofIdentity } from "./proof.ts";

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function topLevel(run: Run) {
  const result = run(["git", "rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

const baseOnly = ["--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap="];

/**
 * Where the PR branched from its base as its remotes hold it now. When no remote can be fetched, the local base refs
 * count, and a base branch this checkout has not fetched is fetched once; without such a remote, or without the
 * commit, the error names the commands that fix it.
 */
export function mergeBase(identity: ProofIdentity, run: Run) {
  const base = pullRequestDetails(identity, run).baseRefName;
  const remotes = remotesOf(identity.repository, run);
  const fresh = remotes.filter((remote) => run(["git", "fetch", ...baseOnly, remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]).code === 0);
  const now = fresh.length ? run(["git", "merge-base", identity.commit, ...fresh.map((remote) => `refs/remotes/${remote}/${base}`)]) : undefined;
  if (now?.code === 0) return now.stdout.trim();
  const found = () => {
    for (const remote of remotes) {
      const result = run(["git", "merge-base", `refs/remotes/${remote}/${base}`, identity.commit]);
      if (result.code === 0) return result.stdout.trim();
    }
    return undefined;
  };
  const before = found();
  if (before) return before;
  for (const remote of remotes) run(["git", "fetch", "--quiet", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
  const after = found();
  if (after) return after;
  const where = `Cannot find where ${identity.repository}#${identity.pr} branched from its base ${base} here`;
  if (!remotes.length) throw new Error(`${where}: no remote of this checkout points at ${identity.repository}. Run the command in a checkout of ${identity.repository}, or add one here: git remote add hedge-base https://github.com/${identity.repository}.git && git fetch hedge-base ${base} pull/${identity.pr}/head`);
  if (run(["git", "cat-file", "-e", `${identity.commit}^{commit}`]).code !== 0) throw new Error(`${where}: ${short(identity.commit)} is not in this checkout. Run git fetch ${remotes[0]} pull/${identity.pr}/head`);
  throw new Error(`${where}, after fetching ${base} from ${remotes.join(", ")}: ${short(identity.commit)} shares no history with it`);
}

export function baseTip(identity: ProofIdentity, run: Run) {
  for (const ref of baseRefs(identity, run)) {
    const result = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (result.code === 0) return result.stdout.trim();
  }
  throw new Error(`Cannot find the base branch of ${identity.repository}#${identity.pr} here. Fetch it from a remote of ${identity.repository}`);
}

export function diffOf(from: string, to: string, run: Run) {
  const diff = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", from, to]);
  if (diff.code !== 0) throw new Error(`Cannot diff ${short(from)}..${short(to)} here (${firstLine(diff.stderr)})`);
  return reviewedDiff(diff.stdout);
}

const docsFile = /\.(md|mdx|markdown|rst)$/i;
const lockFile = /(^|\/)([^/]+\.lockb?|package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;
const generatedFile = /(^|\/)(__generated__|generated)\/|\.(generated|gen|min)\.[a-z]+$|\.pb\.go$|_pb2\.pyi?$/;
const readLines = 50;
const authored = (path: string) => !isTestFile(path) && ![docsFile, lockFile, generatedFile].some((pattern) => pattern.test(path));
export const isProductionFile = authored;

export type TierName = "read" | "pair" | "panel";
export type ReviewTier = { name: TierName; why: string };

export const tierLenses: Record<TierName, string[]> = {
  read: ["correctness:other", "risk:other"],
  pair: ["correctness:other", "risk:other", "fresh-eyes:same"],
  panel: ["fresh-eyes", "correctness", "risk", "design", "anti-overengineering"],
};

export const tierCeiling = (tier: ReviewTier, ceiling: number) => tier.name === "read" ? Math.min(2, ceiling) : ceiling;

function gradeOf(body: string | undefined) {
  if (body === undefined) return "unreadable";
  const grade = /Merge risk:\**\s*(low|medium|high)(?![\w/-])(?!\s+[/-]\s*(?:low|medium|high)\b)/i.exec(riskCalloutOf(body) ?? body)?.[1]?.toLowerCase();
  return grade ?? (/merge[- ]risk/i.test(body) ? "unreadable" : "none");
}

function changedLines(identity: ProofIdentity, run: Run, start: string, measuring: boolean) {
  const stat = run(["git", "diff", "--numstat", "-z", measuring ? "--find-renames" : "--no-renames", "--no-relative", start, identity.commit]);
  if (stat.code !== 0 || measuring && stat.stderr.trim()) return undefined;
  const fields = stat.stdout.split("\0");
  const changed: { lines: number; path: string }[] = [];
  for (let index = 0; index < fields.length; index++) {
    if (!fields[index]) continue;
    const [added = "", deleted = "", ...named] = fields[index]!.split("\t");
    const binary = added === "-" || deleted === "-";
    const path = named.join("\t");
    if (path) changed.push({ lines: binary ? Number.POSITIVE_INFINITY : (Number(added) || 0) + (Number(deleted) || 0), path });
    else {
      changed.push({ lines: binary ? Number.POSITIVE_INFINITY : Number(deleted) || 0, path: fields[index + 1] ?? "" }, { lines: binary ? Number.POSITIVE_INFINITY : Number(added) || 0, path: fields[index + 2] ?? "" });
      index += 2;
    }
  }
  return changed;
}

const linesOf = (changed: { lines: number; path: string }[], kept: (path: string) => boolean) =>
  changed.filter(({ path }) => kept(path)).reduce((sum, { lines }) => sum + lines, 0);

const productionLines = (identity: ProofIdentity, run: Run) => {
  const changed = changedLines(identity, run, mergeBase(identity, run), false);
  return changed && linesOf(changed, authored);
};

export type DiffSize = { production: number; tests: number; docs: number };

const offline = (run: Run): Run => (command) => run(["env", "GIT_NO_LAZY_FETCH=1", ...command]);

export function forkPoint(identity: ProofIdentity, run: Run, baseSha: string) {
  const found = offline(run)(["git", "merge-base", identity.commit, baseSha]);
  return found.code === 0 && found.stdout.trim() || undefined;
}

export function diffSize(identity: ProofIdentity, run: Run, start: string): DiffSize | undefined {
  try {
    if (start === identity.commit) return undefined;
    const changed = changedLines(identity, offline(run), start, true)?.filter(({ lines }) => Number.isFinite(lines));
    return changed && { production: linesOf(changed, authored), tests: linesOf(changed, isTestFile), docs: linesOf(changed, (path) => docsFile.test(path)) };
  } catch { return undefined; }
}

export function reviewTier(identity: ProofIdentity, run: Run, body: string | undefined): ReviewTier {
  const grade = gradeOf(body);
  if (grade === "high") return { name: "panel", why: "merge-risk grade high" };
  let lines: number | undefined;
  try { lines = productionLines(identity, run); } catch { lines = undefined; }
  const size = lines === undefined || Number.isNaN(lines) ? "size unknown" : `${lines} authored production lines`;
  const read = ["low", "none"].includes(grade) && lines !== undefined && lines < readLines;
  return { name: read ? "read" : "pair", why: `merge-risk grade ${grade}, ${size}` };
}

export function pullRequestDetails(identity: ProofIdentity, run: Run) {
  try {
    const { title, body, base } = readPullRequest(identity, run);
    return { title, body, baseRefName: base };
  } catch (error) {
    throw new Error(`Cannot read ${identity.repository}#${identity.pr} over GitHub's REST API (${(error as Error).message})`);
  }
}

/** The dev PR's merge time and merge commit on GitHub, over REST. */
export const devPullOf = (run: Run) => (dev: DevPr): DevPull => {
  const pull = readPullRequest({ ...dev, commit: "" }, run);
  return pull.mergedAt ? { mergedAt: pull.mergedAt, ...pull.mergeCommit ? { mergeCommit: pull.mergeCommit } : {} } : {};
};

export function baseRefs(identity: ProofIdentity, run: Run) {
  const base = pullRequestDetails(identity, run).baseRefName;
  return remotesOf(identity.repository, run).map((remote) => `refs/remotes/${remote}/${base}`);
}

export function remotesOf(repository: string, run: Run) {
  const remotes = run(["git", "remote"]).stdout.split("\n").filter(Boolean);
  return remotes.filter((remote) => new RegExp(`github\\.com[:/]${repository.replace(/\./g, "\\.")}(\\.git)?/?$`, "i").test(run(["git", "remote", "get-url", remote]).stdout.trim()));
}

export function cleanBaseMerge(identity: ProofIdentity, run: Run): CleanBaseMerge {
  let bases: string[] | undefined;
  return (commit) => {
    const parents = run(["git", "rev-list", "--parents", "-n", "1", commit]);
    const [, reviewedSide, baseSide, ...more] = parents.code === 0 ? parents.stdout.trim().split(" ") : [];
    if (!reviewedSide || !baseSide || more.length) return undefined;
    bases ??= baseRefs(identity, run);
    if (!bases.some((ref) => run(["git", "merge-base", "--is-ancestor", baseSide, ref]).code === 0)) return undefined;
    const remerge = run(["git", "show", "--remerge-diff", "--format=", "--no-relative", "--no-ext-diff", "--no-textconv", commit]);
    return remerge.code === 0 && !remerge.stdout.trim() ? reviewedSide : undefined;
  };
}
