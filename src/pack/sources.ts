import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { loadPacks } from "./manifest.ts";
import { tryLock, waitLock } from "../lock.ts";
import type { AvailableSource, FetchedSource, Finding, LoadedPack, SourceRef } from "./types.ts";
import { bunScript } from "../runner/bun.ts";
import { withoutRepoEnv } from "../repo-env.ts";

export const sourceName = /^[a-z0-9][a-z0-9-]*$/;
const fetchTimeoutMs = 120_000;
const cacheWaitMs = 10 * 60_000;

export type Clock = { sleep(ms: number): Promise<void> };

const realClock: Clock = { sleep: (ms) => Bun.sleep(ms) };

type Good = { repo: string; ref: string; commit: string; branch?: boolean; peeled?: boolean; asked?: string; askedBranch?: boolean; resolved?: string };

export const withoutUserinfo = (text: string) => text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1");

function cleaned(source: FetchedSource): FetchedSource {
  if ("error" in source) return { ...source, error: withoutUserinfo(source.error) };
  return source.stale === undefined ? source : { ...source, stale: withoutUserinfo(source.stale) };
}

export async function fetchSources(refs: SourceRef[], cacheRoot: string): Promise<FetchedSource[]> {
  return Promise.all(refs.map((ref) => fetchSource(ref, cacheRoot)));
}

/**
 * Fetches a source at its ref into <cacheRoot>/<name>. A fetch that fails, or
 * that brings packs which do not load, falls back to the last good checkout
 * of the same repository and reports it as stale. A checkout with edits to
 * its tracked files keeps them, and reports itself as stale instead.
 */
export async function fetchSource(ref: SourceRef, cacheRoot: string, loadLimitMs = fetchTimeoutMs, clock: Clock = realClock): Promise<FetchedSource> {
  const dir = cacheDir(ref, cacheRoot);
  if (typeof dir !== "string") return { ref, error: dir.error };
  const lock = await waitLock(cacheLock(cacheRoot, ref.name), clock.sleep, cacheWaitMs);
  if (!lock) return { ref, error: `another Hedge run kept working in ${dir} for over ${cacheWaitMs / 60_000} minutes` };
  try {
    return cleaned(await fetchLocked(ref, dir, loadLimitMs));
  } finally {
    lock.release();
  }
}

type CheckoutState = { commit: string; branch?: string };

async function currentCheckout(dir: string): Promise<CheckoutState | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ok || !head.stdout) return undefined;
  const symbolic = await git(dir, "symbolic-ref", "-q", "HEAD");
  const branch = symbolic.ok && symbolic.stdout.startsWith("refs/heads/") ? symbolic.stdout.slice("refs/heads/".length) : undefined;
  return { commit: head.stdout, ...(branch ? { branch } : {}) };
}

async function restoreCheckout(dir: string, before: CheckoutState | undefined): Promise<boolean> {
  if (!before) return false;
  const now = await currentCheckout(dir);
  if (now?.commit === before.commit && now.branch === before.branch) return true;
  const restored = before.branch ? await git(dir, "switch", "-q", before.branch) : await git(dir, "checkout", "-q", "--detach", before.commit);
  if (restored.ok) clearLoadedModules(dir);
  return restored.ok;
}

async function resolvedRepoUrl(dir: string, repo: string) {
  if (!existsSync(join(dir, ".git"))) return repo;
  const read = await git(dir, "ls-remote", "--get-url", repo);
  const url = read.rawStdout.endsWith("\n")
    ? process.platform === "win32" && read.rawStdout.endsWith("\r\n")
      ? read.rawStdout.slice(0, -2)
      : read.rawStdout.slice(0, -1)
    : read.rawStdout;
  return read.ok && url ? url : repo;
}

const gitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

async function repoHashLength(dir: string): Promise<number> {
  if (!existsSync(join(dir, ".git"))) return 40;
  const read = await git(dir, "rev-parse", "--show-object-format");
  return read.ok && read.stdout === "sha256" ? 64 : 40;
}

const isCommitPin = (ref: string, hashLen: number) => ref.length === hashLen && gitHash.test(ref);

const canonicalFetchHeadUrl = (url: string) =>
  withoutUserinfo(url)
    .replace(/^[^/@:\s]+@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

function firstFetchHeadEntry(raw: string): string {
  const trimmed = process.platform === "win32" && raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const next = trimmed.search(process.platform === "win32" ? /\r?\n(?:[0-9a-f]{40}|[0-9a-f]{64})\t/i : /\n(?:[0-9a-f]{40}|[0-9a-f]{64})\t/i);
  return next === -1 ? trimmed : trimmed.slice(0, next);
}

async function fetchHeadRepo(dir: string, commit: unknown, ref?: string): Promise<string | undefined> {
  if (typeof commit !== "string" || !gitHash.test(commit)) return undefined;
  const raw = await readFile(join(dir, ".git", "FETCH_HEAD"), "utf8").catch(() => "");
  const first = firstFetchHeadEntry(raw);
  const line = first.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t[^\t]*\t([\s\S]+)$/i);
  if (!line || line[1]!.toLowerCase() !== commit.toLowerCase()) return undefined;
  const desc = line[2]!;
  if (ref) {
    const short = ref.replace(/^refs\/(?:heads|tags)\//, "");
    for (const prefix of [`branch '${short}' of `, `tag '${short}' of `, `'${short}' of `, `'${ref}' of `]) {
      if (desc.startsWith(prefix)) return desc.slice(prefix.length);
    }
  }
  const named = desc.match(/^(?:branch '.+?'|tag '.+?'|'.+?'|[0-9a-f]{40}|[0-9a-f]{64}) of ([\s\S]+)$/i);
  return named ? named[1]! : desc;
}

function fetchHeadMatches(fetchedUrl: string, candidate: string) {
  const canonical = canonicalFetchHeadUrl(candidate);
  const escaped = candidate.replace(/\n/g, "\\n");
  const escapedCanonical = canonical.replace(/\n/g, "\\n");
  return fetchedUrl === candidate || fetchedUrl === canonical || fetchedUrl === escaped || fetchedUrl === escapedCanonical;
}

async function legacyFallbackMatches(dir: string, good: Good, effectiveRepo: string): Promise<boolean> {
  const fetched = await fetchHeadRepo(dir, good.commit, good.ref);
  if (fetched !== undefined) return fetchHeadMatches(fetched, effectiveRepo);
  return effectiveRepo === good.repo;
}

async function fetchLocked(ref: SourceRef, dir: string, loadLimitMs: number): Promise<FetchedSource> {
  const repo = repoUrl(ref.repo);
  const edits = await localEdits(dir);
  if (edits.length) return keepEdits(ref, dir, edits, loadLimitMs);
  const good = await lastGood(dir);
  const before = await currentCheckout(dir);
  const effectiveBefore = await resolvedRepoUrl(dir, repo);
  const legacyOk =
    good !== undefined &&
    good.repo === repo &&
    typeof good.resolved !== "string" &&
    verifiedGoodCommit(good) !== undefined &&
    (await legacyFallbackMatches(dir, good, effectiveBefore));
  const preserveBefore =
    before !== undefined &&
    (!good || before.commit !== good.commit) &&
    (Boolean(before.branch) || (await fetchHeadRepo(dir, before.commit)) === undefined);
  let effectiveRepo = effectiveBefore;
  let fetchError: string | undefined;
  let fetchedNew = false;
  let savedFetchHead: SavedFetchHead | undefined;
  if (!(await checkedOutFromCache(dir, repo, effectiveBefore, ref, good))) {
    savedFetchHead = await snapshotFetchHead(dir);
    fetchedNew = true;
    const fetched = await checkout(dir, repo, ref.ref, savedFetchHead);
    effectiveRepo = fetched.effectiveRepo;
    fetchError = fetched.error;
  }
  if (!fetchError) {
    const loaded = await load(dir, loadLimitMs);
    if (!("error" in loaded)) {
      const commit = (await git(dir, "rev-parse", "HEAD")).stdout;
      const isBranch = fetchedNew ? await fetchHeadIsBranch(dir, ref.ref) : false;
      const peeled =
        fetchedNew && !isBranch && isCommitPin(ref.ref, commit.length) && ref.ref.toLowerCase() !== commit.toLowerCase()
          ? (await git(dir, "rev-parse", "--verify", "--quiet", `${ref.ref}^{commit}`)).stdout.toLowerCase() === commit.toLowerCase()
          : !fetchedNew && isCommitPin(ref.ref, commit.length) && ref.ref.toLowerCase() !== commit.toLowerCase()
            ? true
            : undefined;
      const saveError = await saveGood(dir, {
        repo,
        ref: ref.ref,
        commit,
        branch: isBranch,
        ...(peeled ? { peeled: true } : {}),
        resolved: effectiveRepo,
      });
      if (!saveError) return { ref, dir, packs: loaded.packs };
      if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
      return fallBack(ref, dir, repo, effectiveRepo, good, `could not record ${ref.ref} from ${ref.repo}: ${saveError}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
    }
    const askedBranch = fetchedNew ? await fetchHeadIsBranch(dir, ref.ref) : false;
    if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
    return fallBack(ref, dir, repo, effectiveRepo, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, askedBranch);
  }
  if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
  return fallBack(ref, dir, repo, effectiveRepo, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, undefined);
}

function cacheDir(ref: SourceRef, cacheRoot: string): string | { error: string } {
  const dir = resolve(cacheRoot, ref.name);
  if (!sourceName.test(ref.name) || relative(resolve(cacheRoot), dir) !== ref.name) {
    return { error: `source name ${JSON.stringify(ref.name)} must be lowercase words joined by dashes` };
  }
  return dir;
}

const cacheLock = (cacheRoot: string, name: string) => join(cacheRoot, `${name}.lock`);

/** The tracked files that differ from the checked-out commit, such as a skill edited through its link. */
async function localEdits(dir: string) {
  if (!existsSync(join(dir, ".git"))) return [];
  const changed = await git(dir, "diff", "--name-only", "HEAD", "--");
  return changed.ok && changed.stdout ? changed.stdout.split("\n") : [];
}

function editsReason(ref: SourceRef, dir: string, edits: string[]) {
  return `kept your edits to ${edits.join(", ")} in ${dir}. Commit or undo them there, and Hedge updates ${ref.name} again`;
}

async function keepEdits(ref: SourceRef, dir: string, edits: string[], loadLimitMs: number): Promise<FetchedSource> {
  const reason = editsReason(ref, dir, edits);
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: `${reason}; ${loaded.error}` };
  return { ref, dir, packs: loaded.packs, stale: reason };
}

export function repoUrl(repo: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

async function fallBack(ref: SourceRef, dir: string, repo: string, effectiveRepo: string, good: Good | undefined, reason: string, loadLimitMs: number, before?: CheckoutState, preserveBefore = false, legacyFallback = false, askedBranch?: boolean): Promise<FetchedSource> {
  const effectiveMatch =
    good !== undefined &&
    verifiedGoodCommit(good) !== undefined &&
    good.repo === repo &&
    (typeof good.resolved === "string" ? good.resolved === effectiveRepo : legacyFallback);
  if (!effectiveMatch || !good) {
    await restoreCheckout(dir, before);
    return { ref, error: reason };
  }
  if (preserveBefore) {
    await restoreCheckout(dir, before);
    return { ref, error: reason };
  }
  if (before?.branch) {
    if (!(await restoreCheckout(dir, before))) return { ref, error: reason };
  } else if (!(await git(dir, "checkout", "-q", "--detach", good.commit)).ok) {
    return { ref, error: reason };
  } else {
    clearLoadedModules(dir);
  }
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: reason };
  const nextAskedBranch =
    askedBranch !== undefined
      ? askedBranch
      : branchName(good.asked) === branchName(ref.ref)
        ? good.askedBranch
        : undefined;
  const recordAsked = good.ref !== ref.ref || (nextAskedBranch !== undefined && nextAskedBranch !== good.branch);
  const nextGood: Good = {
    repo: good.repo,
    ref: good.ref,
    commit: good.commit,
    ...(good.branch === undefined ? {} : { branch: good.branch }),
    ...(good.peeled ? { peeled: true } : {}),
    ...(recordAsked ? { asked: ref.ref } : {}),
    ...(recordAsked && nextAskedBranch !== undefined ? { askedBranch: nextAskedBranch } : {}),
    ...(typeof good.resolved === "string" ? { resolved: good.resolved } : {}),
  };
  let saveError: string | undefined;
  if (typeof good.resolved === "string") {
    saveError = await saveGood(dir, nextGood);
    if (saveError) await writeAtomic(goodPath(dir), JSON.stringify(nextGood) + "\n").catch(() => {});
  } else if (nextGood.asked !== good.asked || nextGood.askedBranch !== good.askedBranch) {
    await writeAtomic(goodPath(dir), JSON.stringify(nextGood) + "\n").catch(() => {});
  }
  const why = saveError && !reason.includes(saveError) ? `${reason}; ${saveError}` : reason;
  return { ref, dir, packs: loaded.packs, stale: good.ref === ref.ref ? why : `${why}; using ${good.ref} instead` };
}

const loadedModules = createRequire(import.meta.url).cache;

function clearLoadedModules(dir: string) {
  const folders = [resolve(dir), existsSync(dir) ? realpathSync(dir) : resolve(dir)].map((folder) => folder + sep);
  for (const loaded of Object.keys(loadedModules)) if (folders.some((folder) => loaded.startsWith(folder))) delete loadedModules[loaded];
}

async function load(dir: string, limitMs: number): Promise<{ packs: LoadedPack[] } | { error: string }> {
  if (await hasPackTs(dir)) {
    const error = await loadsElsewhere(dir, limitMs);
    if (error) return { error };
    clearLoadedModules(dir);
  }
  try {
    return { packs: await loadPacks(dir) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function goodPath(dir: string) {
  return join(dir, ".git", "hedge-source.json");
}

async function lastGood(dir: string): Promise<Good | undefined> {
  try {
    const parsed = JSON.parse(await readFile(goodPath(dir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Good) : undefined;
  } catch {
    return undefined;
  }
}

const repoDigest = (repo: string) => createHash("sha256").update(repo).digest("hex");

const pinRef = (repo: string, commit: string) => `refs/hedge/pins/${repoDigest(repo)}/${commit.toLowerCase()}`;

async function writeAtomic(path: string, content: string) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function pinTarget(dir: string, repo: string, oid: string): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const ref = pinRef(repo, oid);
  const exact = await git(dir, "rev-parse", "--verify", "--quiet", ref);
  if (!exact.ok || exact.stdout.toLowerCase() !== oid.toLowerCase()) return undefined;
  const commit = await git(dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return commit.ok && gitHash.test(commit.stdout) ? commit.stdout.toLowerCase() : undefined;
}

async function recordPinRef(dir: string, repo: string, oid: string): Promise<string | undefined> {
  if ((await pinTarget(dir, repo, oid)) !== undefined) return undefined;
  const updated = await git(dir, "update-ref", pinRef(repo, oid), oid.toLowerCase());
  return updated.ok ? undefined : updated.stderr || "could not record pinned commit";
}

async function saveGood(dir: string, good: Good): Promise<string | undefined> {
  const before = await lastGood(dir);
  const unchanged =
    before !== undefined &&
    before.repo === good.repo &&
    before.ref === good.ref &&
    before.commit === good.commit &&
    before.branch === good.branch &&
    before.peeled === good.peeled &&
    before.asked === good.asked &&
    before.askedBranch === good.askedBranch &&
    before.resolved === good.resolved;
  const currentCommit = verifiedGoodCommit(good);
  if (currentCommit) {
    const recorded = await recordPinRef(dir, currentCommit.repo, currentCommit.commit);
    if (recorded && !unchanged) return recorded;
    if (good.peeled === true && isCommitPin(good.ref, currentCommit.commit.length)) {
      const recordedTag = await recordPinRef(dir, currentCommit.repo, good.ref);
      if (recordedTag && !unchanged) return recordedTag;
    }
  }
  if (unchanged) {
    await chmod(goodPath(dir), 0o600).catch(() => {});
    return undefined;
  }
  try {
    await writeAtomic(goodPath(dir), JSON.stringify(good) + "\n");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

const verifiedGoodCommit = (record: Good | undefined, overrideRepo?: string) => {
  if (
    !record ||
    typeof record.repo !== "string" ||
    typeof record.ref !== "string" ||
    typeof record.commit !== "string" ||
    !gitHash.test(record.commit) ||
    (record.branch !== true && record.peeled !== true && isCommitPin(record.ref, record.commit.length) && record.ref.toLowerCase() !== record.commit.toLowerCase())
  ) {
    return undefined;
  }
  const effective = overrideRepo ?? (typeof record.resolved === "string" ? record.resolved : record.repo);
  return { repo: effective, commit: record.commit.toLowerCase() };
};

const githubRepoPattern = /^(?:https:\/\/(?:[^/@\s]+@)?(?:www\.)?github\.com(?::443)?\/|ssh:\/\/(?:[^/@\s]+@)?(?:github\.com(?::22)?|ssh\.github\.com(?::443)?)\/|git:\/\/github\.com(?::9418)?\/|(?:[^/@:\s]+@)?github\.com:)(.+)$/i;

const repoKey = (repo: string) => {
  const url = repoUrl(repo);
  const github = url.match(githubRepoPattern)?.[1];
  return github ? github.replace(/\.git$/i, "").toLowerCase() : url;
};

export async function unpinnedSources(refs: SourceRef[], profileDir: string, cacheRoot?: string): Promise<Finding[]> {
  const unpinned: SourceRef[] = [];
  for (const ref of refs) {
    const hashLen = cacheRoot ? await repoHashLength(join(cacheRoot, ref.name)) : 40;
    const pinned = isCommitPin(ref.ref, hashLen) && !(cacheRoot && (await followsBranch(ref, cacheRoot)));
    if (!pinned) unpinned.push(ref);
  }
  if (!unpinned.length) return [];
  const origin = await git(profileDir, "config", "--get", "remote.origin.url").then((read) => read.stdout, () => "");
  const ownRepo = (ref: SourceRef) => origin !== "" && repoKey(ref.repo) === repoKey(origin);
  return unpinned
    .filter((ref) => !ownRepo(ref))
    .map((ref) => ({ id: `source:unpinned:${ref.name}`, pack: "engine", say: `The pack source ${ref.name} is not pinned to a commit SHA. Pin its ref in hedge.json, so each apply loads the same packs, even offline.` }));
}

async function checkedOutFromCache(dir: string, repo: string, effectiveRepo: string, ref: SourceRef, good: Good | undefined): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const oid = ref.ref.toLowerCase();
  const hashLen = await repoHashLength(dir);
  if (!isCommitPin(oid, hashLen)) return false;
  const goodCommit = verifiedGoodCommit(good);
  const verifiedGoodMatch =
    goodCommit !== undefined &&
    good?.repo === repo &&
    typeof good.resolved === "string" &&
    good.resolved === effectiveRepo &&
    (goodCommit.commit === oid || (good.peeled === true && good.ref.toLowerCase() === oid));
  const target = verifiedGoodMatch ? goodCommit.commit : await pinTarget(dir, effectiveRepo, oid);
  if (!target) return false;
  return (await git(dir, "checkout", "-q", "--detach", target)).ok;
}

type SavedFetchHead = { kind: "content"; text: string } | { kind: "missing" } | { kind: "unreadable" };

async function snapshotFetchHead(dir: string): Promise<SavedFetchHead> {
  try {
    return { kind: "content", text: await readFile(join(dir, ".git", "FETCH_HEAD"), "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

async function restoreFetchHead(dir: string, saved: SavedFetchHead) {
  const path = join(dir, ".git", "FETCH_HEAD");
  if (saved.kind === "content") await writeAtomic(path, saved.text).catch(() => {});
  else if (saved.kind === "missing") await rm(path, { force: true }).catch(() => {});
}

async function checkout(dir: string, repo: string, ref: string, savedFetchHead: SavedFetchHead): Promise<{ effectiveRepo: string; error?: string }> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q");
  const effectiveRepo = await resolvedRepoUrl(dir, repo);
  const fetched = await git(dir, "fetch", "-q", "--depth", "1", "--no-tags", repo, ref);
  if (!fetched.ok) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: fetched.stderr };
  }
  if ((await resolvedRepoUrl(dir, repo)) !== effectiveRepo) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: "git remote rewrite rule changed during fetch" };
  }
  const moved = await git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  return { effectiveRepo, ...(moved.ok ? {} : { error: moved.stderr }) };
}

/** Runs git without any prompt: no terminal, no askpass program, SSH in batch mode, and a time limit. */
async function git(dir: string, ...args: string[]) {
  const env = { ...withoutRepoEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const process = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: fetchTimeoutMs });
  const [code, rawBytes, stderr] = await Promise.all([process.exited, new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text()]);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawBytes);
  const message = process.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, stdout: rawStdout.trim(), rawStdout, stderr: message };
}

export function sourceCache(home: string) {
  return join(home, ".local", "share", "hedge", "sources");
}

const branchName = (ref: unknown) => (typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined);

async function fetchHeadIsBranch(dir: string, ref: string): Promise<boolean> {
  const branch = branchName(ref);
  if (!branch) return false;
  const fetched = await readFile(join(dir, ".git", "FETCH_HEAD"), "utf8").catch(() => "");
  return firstFetchHeadEntry(fetched).includes(`\tbranch '${branch}' of `);
}

export async function followsBranch(ref: SourceRef, cacheRoot: string) {
  const dir = join(cacheRoot, ref.name);
  const good = await lastGood(dir);
  const branch = branchName(ref.ref);
  if (!good || !branch) return false;
  if (branchName(good.asked) === branch) {
    if (good.askedBranch === true) return true;
    if (good.askedBranch === false) return false;
  }
  if (branchName(good.ref) === branch) {
    if (good.branch === true) return true;
    if (good.branch === false) return false;
    return fetchHeadIsBranch(dir, ref.ref);
  }
  if (branchName(good.asked) !== branch) return false;
  return fetchHeadIsBranch(dir, ref.ref);
}

export async function loadedCommit(ref: SourceRef, cacheRoot: string) {
  return (await lastGood(join(cacheRoot, ref.name)))?.commit;
}

export type Advance =
  | { state: "same"; commit: string }
  | { state: "moved"; commit: string; source: AvailableSource }
  | { state: "busy" }
  | { state: "edited"; say: string }
  | { state: "refused"; say: string }
  | { state: "failed"; say: string };

/**
 * Moves a branch source forward from the commit it last loaded, for hedge refresh.
 * It asks the remote first and fetches only when the branch moved. It leaves the
 * source as it is while another run works in its cache, while it has local edits,
 * and when the new commit does not build on the old one.
 */
export async function advanceSource(ref: SourceRef, cacheRoot: string, from: string, loadLimitMs = fetchTimeoutMs): Promise<Advance> {
  const dir = cacheDir(ref, cacheRoot);
  if (typeof dir !== "string") return { state: "failed", say: dir.error };
  const lock = tryLock(cacheLock(cacheRoot, ref.name));
  if (!lock) return { state: "busy" };
  try {
    const advanced = await advanceLocked(ref, dir, from, loadLimitMs);
    return "say" in advanced ? { ...advanced, say: withoutUserinfo(advanced.say) } : advanced;
  } finally {
    lock.release();
  }
}

async function advanceLocked(ref: SourceRef, dir: string, from: string, loadLimitMs: number): Promise<Advance> {
  const repo = repoUrl(ref.repo);
  const branch = ref.ref.replace(/^refs\/heads\//, "");
  const head = `refs/heads/${branch}`;
  const effectiveRepo = await resolvedRepoUrl(dir, repo);
  const listed = await git(dir, "ls-remote", repo, head);
  if (!listed.ok) return { state: "failed", say: `could not reach ${ref.repo}: ${listed.stderr}` };
  const commit = listed.stdout.split("\n").map((line) => line.split("\t")).find(([, name]) => name === head)?.[0];
  if (!commit) return { state: "failed", say: `${ref.repo} has no branch ${branch}` };
  if (commit === from) return { state: "same", commit };
  const rewritten = (tip: string) => ({ state: "refused" as const, say: `${branch} of ${ref.repo} moved to ${tip.slice(0, 12)}, which does not build on ${from.slice(0, 12)}, the commit Hedge loaded last. Hedge refresh runs no pack code from a rewritten branch. Run hedge update to take it.` });
  const edits = await localEdits(dir);
  if (edits.length) return { state: "edited", say: `${ref.name} moved, but Hedge ${editsReason(ref, dir, edits)}.` };
  const savedFetchHead = await snapshotFetchHead(dir);
  const fetched = await git(dir, "fetch", "-q", "--no-tags", repo, head);
  if (!fetched.ok) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not fetch ${branch} from ${ref.repo}: ${fetched.stderr}` };
  }
  if ((await resolvedRepoUrl(dir, repo)) !== effectiveRepo) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `git remote rewrite rule changed while refreshing ${ref.repo}` };
  }
  const tip = (await git(dir, "rev-parse", "FETCH_HEAD")).stdout;
  if (!(await git(dir, "merge-base", "--is-ancestor", from, tip)).ok) {
    await restoreFetchHead(dir, savedFetchHead);
    return rewritten(tip);
  }
  const before = await currentCheckout(dir);
  const moved = await git(dir, "checkout", "-q", "--detach", tip);
  if (!moved.ok) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not check out ${tip.slice(0, 12)} of ${ref.name}: ${moved.stderr}` };
  }
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", from)).ok) clearLoadedModules(dir);
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} does not load: ${loaded.error}` };
  }
  const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: tip, branch: true, resolved: effectiveRepo });
  if (saveError) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", from)).ok) clearLoadedModules(dir);
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not record ${branch} of ${ref.repo} at ${tip.slice(0, 12)}: ${saveError}` };
  }
  return { state: "moved", commit: tip, source: { ref, dir, packs: loaded.packs } };
}

export async function cachedSource(ref: SourceRef, cacheRoot: string, clock: Clock = realClock): Promise<FetchedSource> {
  const dir = cacheDir(ref, cacheRoot);
  if (typeof dir !== "string") return { ref, error: dir.error };
  if (!existsSync(join(dir, ".git"))) return { ref, error: "never fetched; run hedge apply" };
  const lock = await waitLock(cacheLock(cacheRoot, ref.name), clock.sleep, cacheWaitMs);
  if (!lock) return { ref, error: `another Hedge run kept working in ${dir} for over ${cacheWaitMs / 60_000} minutes` };
  try {
    const good = await lastGood(dir);
    const head = (await git(dir, "rev-parse", "HEAD")).stdout;
    const asked = good?.ref === ref.ref || good?.asked === ref.ref;
    if (good?.repo !== repoUrl(ref.repo) || !asked || good.commit !== head) return { ref, error: `the cached checkout is not ${ref.ref}; run hedge apply` };
    return { ref, dir, packs: await loadPacks(dir) };
  } finally {
    lock.release();
  }
}

async function hasPackTs(dir: string) {
  const packs = await readdir(join(dir, "packs")).catch(() => [] as string[]);
  return packs.some((name) => existsSync(join(dir, "packs", name, "pack.ts")));
}

async function loadsElsewhere(dir: string, limitMs: number): Promise<string | undefined> {
  const started = performance.now();
  const child = Bun.spawn(bunScript(join(import.meta.dir, "load-source.ts"), dir), { env: process.env, stdout: "ignore", stderr: "pipe", timeout: limitMs, killSignal: "SIGKILL" });
  const stderr = readUntilQuiet(child.stderr);
  const code = await child.exited;
  if (code === 0) return undefined;
  if (performance.now() - started >= limitMs) return `the packs did not finish loading within ${limitMs / 1000} seconds`;
  const lastLine = (await stderr()).trim().split("\n").at(-1);
  const how = child.signalCode ? `stop on ${child.signalCode}` : `exit ${code}`;
  return [`the packs ${how} as they load`, lastLine].filter(Boolean).join(": ");
}

const drainMs = 100;

function readUntilQuiet(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value, { stream: true });
  })().catch(() => {});
  return async () => {
    const drained = await Promise.race([done.then(() => true), Bun.sleep(drainMs).then(() => false)]);
    if (!drained) await reader.cancel().catch(() => {});
    return text;
  };
}
