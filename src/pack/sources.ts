import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

type BlockedSwitch = { repo: string; resolved?: string; resolvedDigest?: string };
type Good = { repo: string; ref: string; commit: string; branch?: boolean; peeled?: boolean; asked?: string; askedBranch?: boolean; blocked?: BlockedSwitch[]; resolved?: string; resolvedDigest?: string };

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
  if (now?.commit.toLowerCase() === before.commit.toLowerCase() && now.branch === before.branch) return true;
  let ok = false;
  if (before.branch) {
    const tip = await git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${before.branch}`);
    if (tip.ok && tip.stdout.toLowerCase() === before.commit.toLowerCase()) {
      ok = (await git(dir, "switch", "-q", before.branch)).ok;
    }
  }
  if (!ok) ok = (await git(dir, "checkout", "-q", "--detach", before.commit)).ok;
  if (!ok) return false;
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ok || head.stdout.toLowerCase() !== before.commit.toLowerCase()) return false;
  clearLoadedModules(dir);
  return true;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeRepoBytes(bytes: Uint8Array): string {
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    return `\0raw:${Buffer.from(bytes).toString("hex")}`;
  }
}

async function resolvedRepoUrl(dir: string, repo: string) {
  if (!existsSync(join(dir, ".git"))) return repo;
  const read = await git(dir, "ls-remote", "--get-url", repo);
  if (!read.ok || read.rawBytes.length === 0) return repo;
  const end =
    read.rawBytes.at(-1) === 0x0a
      ? process.platform === "win32" && read.rawBytes.length >= 2 && read.rawBytes.at(-2) === 0x0d
        ? read.rawBytes.length - 2
        : read.rawBytes.length - 1
      : read.rawBytes.length;
  return end > 0 ? decodeRepoBytes(read.rawBytes.subarray(0, end)) : repo;
}

const gitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const stripTrailingColon = (ref: string) => (ref.endsWith(":") ? ref.slice(0, -1) : ref);
const stripSourceRefspec = (ref: string) => {
  const noPlus = ref.startsWith("+") ? ref.slice(1) : ref;
  return stripTrailingColon(noPlus);
};
const isInvalidRef = (ref: string) => {
  if (ref === "") return false;
  if (ref.startsWith("-") || ref.startsWith("^") || /[\0\r\n]/.test(ref)) return true;
  const colon = ref.indexOf(":");
  if (colon !== -1 && colon !== ref.length - 1) return true;
  const src = stripSourceRefspec(ref);
  return !src || src.startsWith("-") || src.startsWith("^");
};

async function repoHashLength(dir: string): Promise<number> {
  if (!existsSync(join(dir, ".git"))) return 40;
  const read = await git(dir, "rev-parse", "--show-object-format");
  return read.ok && read.stdout === "sha256" ? 64 : 40;
}

const isCommitPin = (ref: string, hashLen: number) => ref.length === hashLen && gitHash.test(ref);

function stripTrailingSlashes(url: string) {
  if (url.startsWith("\0raw:")) {
    const raw = Buffer.from(url.slice(5), "hex").toString("latin1").replace(/\/+$/, "");
    return `\0raw:${Buffer.from(raw, "latin1").toString("hex")}`;
  }
  return withoutUserinfo(url)
    .replace(/^[^/@:\s]+@/, "")
    .replace(/\/+$/, "");
}

function canonicalFetchHeadUrl(url: string) {
  if (url.startsWith("\0raw:")) {
    const raw = Buffer.from(url.slice(5), "hex").toString("latin1").replace(/\/+$/, "").replace(/\.git$/, "");
    return `\0raw:${Buffer.from(raw, "latin1").toString("hex")}`;
  }
  return stripTrailingSlashes(url).replace(/\.git$/, "");
}

function firstFetchHeadEntry(raw: string): string {
  const trimmed = process.platform === "win32" && raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const next = trimmed.search(process.platform === "win32" ? /\r?\n(?:[0-9a-f]{40}|[0-9a-f]{64})\t/i : /\n(?:[0-9a-f]{40}|[0-9a-f]{64})\t/i);
  return next === -1 ? trimmed : trimmed.slice(0, next);
}

async function fetchHeadEntry(dir: string, refs?: Array<string | undefined>): Promise<{ oid: string; url: string } | undefined> {
  const raw = await readFile(join(dir, ".git", "FETCH_HEAD")).catch(() => undefined);
  if (!raw || raw.length === 0) return undefined;
  const first = firstFetchHeadEntry(raw.toString("latin1"));
  const line = first.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t[^\t]*\t([\s\S]+)$/i);
  if (!line) return undefined;
  const oid = line[1]!.toLowerCase();
  const desc = line[2]!;
  const descOffset = first.length - desc.length;
  for (const ref of refs ?? []) {
    if (typeof ref !== "string" || !ref) continue;
    const stripped = stripSourceRefspec(ref);
    const short = stripped.replace(/^refs\/(?:heads|tags)\//, "");
    const names = [...new Set([short, stripped, ref])].filter(Boolean);
    for (const name of names) {
      for (const prefix of [`branch '${name}' of `, `tag '${name}' of `, `'${name}' of `]) {
        const latinPrefix = Buffer.from(prefix, "utf8").toString("latin1");
        if (desc.startsWith(latinPrefix)) {
          return { oid, url: decodeRepoBytes(raw.subarray(descOffset + latinPrefix.length, first.length)) };
        }
      }
    }
  }
  const named = desc.match(/^(?:branch '.+?'|tag '.+?'|'.+?'|[0-9a-f]{40}|[0-9a-f]{64}) of /i);
  const urlOffset = descOffset + (named ? named[0].length : 0);
  return { oid, url: decodeRepoBytes(raw.subarray(urlOffset, first.length)) };
}

async function fetchHeadRepo(dir: string, commit: unknown, ref?: string): Promise<string | undefined> {
  if (typeof commit !== "string" || !gitHash.test(commit)) return undefined;
  const entry = await fetchHeadEntry(dir, [ref]);
  return entry && entry.oid === commit.toLowerCase() ? entry.url : undefined;
}

function fetchHeadMatches(fetchedUrl: string, candidate: string) {
  const stripped = stripTrailingSlashes(candidate);
  const canonical = canonicalFetchHeadUrl(candidate);
  for (const variant of [candidate, stripped, canonical]) {
    if (fetchedUrl === variant || fetchedUrl === variant.replace(/\n/g, "\\n")) return true;
  }
  return false;
}

async function isPeeledTagInRepo(dir: string, ref: unknown, commit: unknown): Promise<boolean> {
  if (typeof ref !== "string" || typeof commit !== "string" || !gitHash.test(commit) || !isCommitPin(ref, commit.length) || ref.toLowerCase() === commit.toLowerCase() || !existsSync(join(dir, ".git"))) {
    return false;
  }
  const type = await git(dir, "cat-file", "-t", ref);
  if (!type.ok || type.stdout !== "tag") return false;
  const peeled = await git(dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return peeled.ok && peeled.stdout.toLowerCase() === commit.toLowerCase();
}

async function legacyFallbackMatches(dir: string, good: Good, effectiveRepo: string): Promise<boolean> {
  const entry = await fetchHeadEntry(dir, [good.ref, good.asked]);
  if (entry === undefined) return true;
  const matchesGoodCommit = entry.oid === good.commit.toLowerCase() || (good.peeled === true && entry.oid === good.ref.toLowerCase());
  if (matchesGoodCommit) return fetchHeadMatches(entry.url, effectiveRepo);
  return fetchHeadMatches(entry.url, effectiveRepo) || effectiveRepo === good.repo;
}

async function fetchLocked(ref: SourceRef, dir: string, loadLimitMs: number): Promise<FetchedSource> {
  const repo = repoUrl(ref.repo);
  const edits = await localEdits(dir);
  if (edits.length) return keepEdits(ref, dir, edits, loadLimitMs);
  const rawGood = await lastGood(dir);
  const rawGoodDigest = goodResolvedDigest(rawGood);
  const legacyPeeledCandidate =
    rawGood !== undefined &&
    rawGoodDigest === undefined &&
    rawGood.peeled !== true &&
    rawGood.branch !== true &&
    typeof rawGood.ref === "string" &&
    typeof rawGood.commit === "string" &&
    gitHash.test(rawGood.commit) &&
    isCommitPin(rawGood.ref, rawGood.commit.length) &&
    rawGood.ref.toLowerCase() !== rawGood.commit.toLowerCase();
  const legacyPeeled =
    legacyPeeledCandidate &&
    ((await isPeeledTagInRepo(dir, rawGood.ref, rawGood.commit)) ||
      (existsSync(join(dir, ".git")) &&
        !(await git(dir, "cat-file", "-e", rawGood.ref)).ok &&
        (await fetchHeadEntry(dir, [rawGood.ref]))?.oid === rawGood.ref.toLowerCase()));
  const legacyBranch =
    !legacyPeeled &&
    rawGood !== undefined &&
    rawGoodDigest === undefined &&
    rawGood.branch === undefined &&
    typeof rawGood.ref === "string" &&
    (await fetchHeadIsBranch(dir, rawGood.ref)) === true &&
    (await fetchHeadRepo(dir, rawGood.commit, rawGood.ref)) !== undefined;
  const good =
    legacyPeeled && rawGood
      ? { ...rawGood, peeled: true }
      : legacyBranch && rawGood
        ? { ...rawGood, branch: true }
        : rawGood;
  const goodDigest = goodResolvedDigest(good);
  const before = await currentCheckout(dir);
  const effectiveBefore = await resolvedRepoUrl(dir, repo);
  const effectiveBeforeDigest = repoDigest(effectiveBefore);
  const legacyOk =
    good !== undefined &&
    good.repo === repo &&
    goodDigest === undefined &&
    verifiedGoodCommit(good) !== undefined &&
    (await legacyFallbackMatches(dir, good, effectiveBefore));
  const managedDetached =
    before !== undefined &&
    !before.branch &&
    ((await fetchHeadRepo(dir, before.commit)) !== undefined ||
      (await pinTarget(dir, effectiveBeforeDigest, before.commit)) !== undefined ||
      (goodDigest !== undefined && (await pinTarget(dir, goodDigest, before.commit)) !== undefined));
  const preserveBefore = before !== undefined && (!good || before.commit !== good.commit) && !managedDetached;
  let effectiveRepo = effectiveBefore;
  let fetchError: string | undefined;
  let fetchedNew = false;
  let fetchedOid: string | undefined;
  let savedFetchHead: SavedFetchHead | undefined;
  let checkedOutCommit = await checkedOutFromCache(dir, repo, effectiveBefore, ref, good);
  if (!checkedOutCommit) {
    savedFetchHead = await snapshotFetchHead(dir);
    fetchedNew = true;
    const fetched = await checkout(dir, repo, ref.ref, savedFetchHead, good);
    effectiveRepo = fetched.effectiveRepo;
    fetchError = fetched.error;
    checkedOutCommit = fetched.commit;
    fetchedOid = fetched.fetchedOid;
  }
  const effectiveDigest = repoDigest(effectiveRepo);
  if (!fetchError && checkedOutCommit) {
    const commit = checkedOutCommit;
    const isBranch = fetchedNew ? await fetchHeadIsBranch(dir, ref.ref, fetchedOid) : false;
    const peeled =
      fetchedNew && isBranch === false && isCommitPin(ref.ref, commit.length) && ref.ref.toLowerCase() !== commit.toLowerCase()
        ? fetchedOid === ref.ref.toLowerCase() || (await git(dir, "rev-parse", "--verify", "--quiet", `${ref.ref}^{commit}`)).stdout.toLowerCase() === commit.toLowerCase()
        : !fetchedNew && isCommitPin(ref.ref, commit.length) && ref.ref.toLowerCase() !== commit.toLowerCase()
          ? true
          : undefined;
    const loaded = await load(dir, loadLimitMs);
    if (!("error" in loaded)) {
      const postLoadHead = (await git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).stdout;
      if (!postLoadHead || postLoadHead.toLowerCase() !== commit.toLowerCase()) {
        if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
        return fallBack(ref, dir, repo, effectiveRepo, good, `${ref.ref} from ${ref.repo} changed checkout HEAD while loading`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
      }
      const saveError = await saveGood(dir, {
        repo,
        ref: ref.ref,
        commit,
        ...(isBranch === undefined ? {} : { branch: isBranch }),
        ...(peeled ? { peeled: true } : {}),
        resolvedDigest: effectiveDigest,
      });
      if (!saveError) return { ref, dir, packs: loaded.packs };
      if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
      return fallBack(ref, dir, repo, effectiveRepo, good, `could not record ${ref.ref} from ${ref.repo}: ${saveError}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
    }
    const keepBranchFetchHead =
      isBranch === true &&
      good !== undefined &&
      good.repo === repo &&
      good.ref !== ref.ref &&
      effectiveRepo === effectiveBefore &&
      (goodDigest !== undefined ? goodDigest === effectiveDigest : legacyOk);
    if (savedFetchHead && !keepBranchFetchHead) await restoreFetchHead(dir, savedFetchHead);
    return fallBack(ref, dir, repo, effectiveRepo, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
  }
  if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
  return fallBack(ref, dir, repo, effectiveRepo, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError ?? "unknown commit"}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, undefined);
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
  const effectiveDigest = repoDigest(effectiveRepo);
  const goodDigest = goodResolvedDigest(good);
  const effectiveMatch =
    good !== undefined &&
    verifiedGoodCommit(good) !== undefined &&
    good.repo === repo &&
    (goodDigest !== undefined ? goodDigest === effectiveDigest : legacyFallback);
  const normalizedBlocked = (entries: BlockedSwitch[] | undefined) =>
    Array.isArray(entries)
      ? entries
          .map((entry) => {
            const digest = goodResolvedDigest(entry);
            return entry && typeof entry.repo === "string" && digest !== undefined ? { repo: entry.repo, resolvedDigest: digest } : undefined;
          })
          .filter((entry): entry is { repo: string; resolvedDigest: string } => entry !== undefined)
      : [];
  const recordBlocked = async () => {
    if (!good) return;
    const existing = normalizedBlocked(good.blocked);
    if (existing.some((entry) => entry.repo === repo && entry.resolvedDigest === effectiveDigest)) return;
    const { resolved: _drop, ...rest } = good;
    const updated: Good = {
      ...rest,
      ...(goodDigest !== undefined ? { resolvedDigest: goodDigest } : {}),
      blocked: [...existing, { repo, resolvedDigest: effectiveDigest }],
    };
    await writeAtomic(goodPath(dir), JSON.stringify(updated) + "\n").catch(() => {});
  };
  if (!effectiveMatch || !good) {
    await restoreCheckout(dir, before);
    await recordBlocked();
    return { ref, error: reason };
  }
  if (preserveBefore) {
    await restoreCheckout(dir, before);
    return { ref, error: reason };
  }
  if (before?.branch && before.commit.toLowerCase() === good.commit.toLowerCase()) {
    if (!(await restoreCheckout(dir, before))) return { ref, error: reason };
  } else {
    if (!(await git(dir, "checkout", "-q", "--detach", good.commit)).ok) return { ref, error: reason };
    const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
    if (!head.ok || head.stdout.toLowerCase() !== good.commit.toLowerCase()) return { ref, error: reason };
    clearLoadedModules(dir);
  }
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: reason };
  const nextAskedBranch = askedBranch !== undefined ? askedBranch : branchName(good.asked) === branchName(ref.ref) ? good.askedBranch : undefined;
  const recordAsked = good.ref !== ref.ref || (nextAskedBranch !== undefined && nextAskedBranch !== good.branch);
  const existingBlocked = normalizedBlocked(good.blocked);
  const nextGood: Good = {
    repo: good.repo,
    ref: good.ref,
    commit: good.commit,
    ...(good.branch === undefined ? {} : { branch: good.branch }),
    ...(good.peeled ? { peeled: true } : {}),
    ...(recordAsked ? { asked: ref.ref } : {}),
    ...(recordAsked && nextAskedBranch !== undefined ? { askedBranch: nextAskedBranch } : {}),
    ...(existingBlocked.length ? { blocked: existingBlocked } : {}),
    ...(goodDigest !== undefined ? { resolvedDigest: goodDigest } : {}),
  };
  let saveError: string | undefined;
  if (goodDigest !== undefined) {
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

const goodResolvedDigest = (record: { resolved?: string; resolvedDigest?: string } | undefined): string | undefined =>
  typeof record?.resolvedDigest === "string"
    ? record.resolvedDigest
    : typeof record?.resolved === "string"
      ? repoDigest(record.resolved)
      : undefined;

const pinRef = (repoHash: string, commit: string) => `refs/hedge/pins/${repoHash}/${commit.toLowerCase()}`;

async function writeAtomic(path: string, content: string | Uint8Array, mode = 0o600) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, content, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function exactPinTarget(dir: string, repoHash: string, oid: string): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const normalized = oid.toLowerCase();
  const ref = pinRef(repoHash, normalized);
  const exact = await git(dir, "rev-parse", "--verify", "--quiet", ref);
  if (!exact.ok || exact.stdout.toLowerCase() !== normalized) return undefined;
  const commit = await git(dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return commit.ok && gitHash.test(commit.stdout) ? commit.stdout.toLowerCase() : undefined;
}

async function pinTarget(dir: string, repoHash: string, oid: string): Promise<string | undefined> {
  const exact = await exactPinTarget(dir, repoHash, oid);
  if (exact) return exact;
  if (!existsSync(join(dir, ".git"))) return undefined;
  const normalized = oid.toLowerCase();
  const type = await git(dir, "cat-file", "-t", normalized);
  if (!type.ok || type.stdout !== "commit") return undefined;
  const containing = await git(dir, "for-each-ref", "--count=1", "--contains", normalized, "--format=%(objectname)", `refs/hedge/pins/${repoHash}/`);
  return containing.ok && gitHash.test(containing.stdout) ? normalized : undefined;
}

async function recordPinRef(dir: string, repoHash: string, oid: string): Promise<string | undefined> {
  if ((await exactPinTarget(dir, repoHash, oid)) !== undefined) return undefined;
  const updated = await git(dir, "update-ref", pinRef(repoHash, oid), oid.toLowerCase());
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
    JSON.stringify(before.blocked) === JSON.stringify(good.blocked) &&
    before.resolved === undefined &&
    before.resolvedDigest === good.resolvedDigest;
  const currentCommit = verifiedGoodCommit(good);
  if (currentCommit) {
    const recorded = await recordPinRef(dir, currentCommit.repoHash, currentCommit.commit);
    if (recorded && !unchanged) return recorded;
    if (good.peeled === true && isCommitPin(good.ref, currentCommit.commit.length) && (await git(dir, "cat-file", "-e", good.ref)).ok) {
      const recordedTag = await recordPinRef(dir, currentCommit.repoHash, good.ref);
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

const verifiedGoodCommit = (record: Good | undefined) => {
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
  const repoHash = goodResolvedDigest(record) ?? repoDigest(record.repo);
  return { repoHash, commit: record.commit.toLowerCase() };
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
    const dir = cacheRoot ? join(cacheRoot, ref.name) : undefined;
    const good = dir ? await lastGood(dir) : undefined;
    const repo = repoUrl(ref.repo);
    const goodDigest = goodResolvedDigest(good);
    const sameCachedRepo =
      dir !== undefined &&
      good?.repo === repo &&
      (goodDigest === undefined || repoDigest(await resolvedRepoUrl(dir, repo)) === goodDigest);
    const hashLen = sameCachedRepo ? await repoHashLength(dir) : 40;
    const pinned = isCommitPin(ref.ref, hashLen) && !(sameCachedRepo && cacheRoot && (await followsBranch(ref, cacheRoot)));
    if (!pinned) unpinned.push(ref);
  }
  if (!unpinned.length) return [];
  const origin = await git(profileDir, "config", "--get", "remote.origin.url").then((read) => read.stdout, () => "");
  const ownRepo = (ref: SourceRef) => origin !== "" && repoKey(ref.repo) === repoKey(origin);
  return unpinned
    .filter((ref) => !ownRepo(ref))
    .map((ref) => ({ id: `source:unpinned:${ref.name}`, pack: "engine", say: `The pack source ${ref.name} is not pinned to a commit SHA. Pin its ref in hedge.json, so each apply loads the same packs, even offline.` }));
}

async function checkedOutFromCache(dir: string, repo: string, effectiveRepo: string, ref: SourceRef, good: Good | undefined): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const oid = ref.ref.toLowerCase();
  const hashLen = await repoHashLength(dir);
  if (!isCommitPin(oid, hashLen)) return undefined;
  const effectiveDigest = repoDigest(effectiveRepo);
  const goodDigest = goodResolvedDigest(good);
  const goodCommit = verifiedGoodCommit(good);
  const verifiedGoodMatch =
    goodCommit !== undefined &&
    good?.repo === repo &&
    goodDigest !== undefined &&
    goodDigest === effectiveDigest &&
    (goodCommit.commit === oid || (good.peeled === true && good.ref.toLowerCase() === oid));
  const target = verifiedGoodMatch ? goodCommit.commit : await pinTarget(dir, effectiveDigest, oid);
  if (!target) return undefined;
  return (await git(dir, "checkout", "-q", "--detach", target)).ok ? target : undefined;
}

type SavedFetchHead = { kind: "content"; bytes: Buffer; mode: number } | { kind: "missing" } | { kind: "unreadable" };

async function snapshotFetchHead(dir: string): Promise<SavedFetchHead> {
  const path = join(dir, ".git", "FETCH_HEAD");
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    return { kind: "content", bytes, mode: info.mode & 0o777 };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

async function restoreFetchHead(dir: string, saved: SavedFetchHead) {
  const path = join(dir, ".git", "FETCH_HEAD");
  if (saved.kind === "content") {
    const current = await readFile(path).catch(() => undefined);
    if (current && current.equals(saved.bytes)) return;
    await writeAtomic(path, saved.bytes, saved.mode).catch(() => {});
  } else if (saved.kind === "missing") {
    await rm(path, { force: true }).catch(() => {});
  }
}

function parsePorcelainFetchHead(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = line.match(/^[ *+t!=-]\s+[0-9a-f]+\s+([0-9a-f]{40}|[0-9a-f]{64})\s+FETCH_HEAD$/i);
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

async function fetchExact(dir: string, repo: string, ref: string, shallow: boolean): Promise<{ ok: boolean; oid?: string; stderr: string }> {
  const args = shallow ? ["fetch", "--porcelain", "--depth", "1", "--no-tags", repo, ref] : ["fetch", "--porcelain", "--no-tags", repo, ref];
  const fetched = await git(dir, ...args);
  if (fetched.ok) {
    const oid = parsePorcelainFetchHead(fetched.stdout);
    if (oid) return { ok: true, oid, stderr: "" };
  }
  const unsupportedPorcelain = !fetched.ok && (fetched.code === 129 || /unknown option.*porcelain/i.test(fetched.fullStderr)) && /porcelain/i.test(fetched.fullStderr);
  if (!fetched.ok && !unsupportedPorcelain) {
    return { ok: false, stderr: fetched.stderr };
  }
  const src = stripSourceRefspec(ref) || "HEAD";
  const tmpRef = `refs/hedge/tmp/${crypto.randomUUID()}`;
  try {
    const fallbackArgs = shallow ? ["fetch", "-q", "--depth", "1", "--no-tags", repo, `+${src}:${tmpRef}`] : ["fetch", "-q", "--no-tags", repo, `+${src}:${tmpRef}`];
    const fallback = await git(dir, ...fallbackArgs);
    if (!fallback.ok) return { ok: false, stderr: fallback.stderr };
    const resolved = await git(dir, "rev-parse", "--verify", "--quiet", tmpRef);
    return resolved.ok && gitHash.test(resolved.stdout) ? { ok: true, oid: resolved.stdout.toLowerCase(), stderr: "" } : { ok: false, stderr: resolved.stderr || "could not resolve fetched commit" };
  } finally {
    await git(dir, "update-ref", "-d", tmpRef).catch(() => {});
  }
}

async function checkout(dir: string, repo: string, ref: string, savedFetchHead: SavedFetchHead, good?: Good): Promise<{ effectiveRepo: string; commit?: string; fetchedOid?: string; error?: string }> {
  const effectiveBefore = await resolvedRepoUrl(dir, repo);
  if (isInvalidRef(ref)) return { effectiveRepo: effectiveBefore, error: `invalid ref ${JSON.stringify(ref)}` };
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q");
  const effectiveRepo = await resolvedRepoUrl(dir, repo);
  const sameTrackedBranch =
    good?.branch === true &&
    good.repo === repo &&
    goodResolvedDigest(good) === repoDigest(effectiveRepo) &&
    Boolean(branchName(good.ref)) &&
    branchName(good.ref) === branchName(ref);
  const fetched = await fetchExact(dir, repo, ref, !sameTrackedBranch);
  if (!fetched.ok || !fetched.oid) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: fetched.stderr || "could not fetch commit" };
  }
  if ((await resolvedRepoUrl(dir, repo)) !== effectiveRepo) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: "git remote rewrite rule changed during fetch" };
  }
  const peeled = await git(dir, "rev-parse", "--verify", "--quiet", `${fetched.oid}^{commit}`);
  if (!peeled.ok || !gitHash.test(peeled.stdout)) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: peeled.stderr || "could not resolve fetched commit" };
  }
  const targetCommit = peeled.stdout.toLowerCase();
  const moved = await git(dir, "checkout", "-q", "--detach", targetCommit);
  if (!moved.ok) return { effectiveRepo, error: moved.stderr };
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  return head.ok && head.stdout.toLowerCase() === targetCommit ? { effectiveRepo, commit: targetCommit, fetchedOid: fetched.oid } : { effectiveRepo, error: head.stderr || "could not resolve checked-out HEAD" };
}

function gitEnv() {
  const base = withoutRepoEnv();
  const ctype = base.LC_CTYPE ?? base.LC_ALL ?? base.LANG;
  delete base.LC_ALL;
  return {
    ...base,
    ...(ctype ? { LC_CTYPE: ctype } : {}),
    LC_MESSAGES: "C",
    LANGUAGE: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}

/** Runs git without any prompt: no terminal, no askpass program, SSH in batch mode, and a time limit. */
async function git(dir: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnv(), timeout: fetchTimeoutMs });
  const [code, rawBytes, stderr] = await Promise.all([process.exited, new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text()]);
  const bytes = new Uint8Array(rawBytes);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const message = process.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, code, stdout: rawStdout.trim(), rawStdout, rawBytes: bytes, stderr: message, fullStderr: stderr };
}

export function sourceCache(home: string) {
  return join(home, ".local", "share", "hedge", "sources");
}

const branchName = (ref: unknown) => (typeof ref === "string" ? stripTrailingColon(ref).replace(/^refs\/heads\//, "") : undefined);

async function fetchHeadIsBranch(dir: string, ref: string, expectedOid?: string): Promise<boolean | undefined> {
  const branch = branchName(ref);
  if (!branch) return false;
  let fetched: string;
  try {
    fetched = await readFile(join(dir, ".git", "FETCH_HEAD"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false : undefined;
  }
  const first = firstFetchHeadEntry(fetched);
  if (expectedOid) {
    const oid = first.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t/i)?.[1]?.toLowerCase();
    if (oid !== expectedOid.toLowerCase()) return false;
  }
  return first.includes(`\tbranch '${branch}' of `);
}

export async function followsBranch(ref: SourceRef, cacheRoot: string) {
  const dir = join(cacheRoot, ref.name);
  const good = await lastGood(dir);
  const branch = branchName(ref.ref);
  const repo = repoUrl(ref.repo);
  if (!good || !branch || typeof good.commit !== "string" || !gitHash.test(good.commit)) return false;
  if (Array.isArray(good.blocked) && good.blocked.length) {
    const effectiveDigest = repoDigest(await resolvedRepoUrl(dir, repo));
    if (good.blocked.some((entry) => entry && entry.repo === repo && goodResolvedDigest(entry) === effectiveDigest)) return false;
  }
  if (branchName(good.asked) === branch) {
    if (good.askedBranch === true) return true;
    if (good.askedBranch === false) return false;
  }
  if (branchName(good.ref) === branch) {
    if (good.branch === true) return true;
    if (good.branch === false) return false;
    return (await fetchHeadIsBranch(dir, ref.ref)) === true;
  }
  if (branchName(good.asked) !== branch) return false;
  return (await fetchHeadIsBranch(dir, ref.ref)) === true;
}

export async function loadedCommit(ref: SourceRef, cacheRoot: string) {
  const commit = (await lastGood(join(cacheRoot, ref.name)))?.commit;
  return typeof commit === "string" && gitHash.test(commit) ? commit : undefined;
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
  const branch = stripTrailingColon(ref.ref).replace(/^refs\/heads\//, "");
  const head = `refs/heads/${branch}`;
  if (!branch || isInvalidRef(head)) return { state: "failed", say: `invalid ref ${JSON.stringify(ref.ref)} for ${ref.repo}` };
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
  const fetched = await fetchExact(dir, repo, head, false);
  if (!fetched.ok || !fetched.oid) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not fetch ${branch} from ${ref.repo}: ${fetched.stderr}` };
  }
  if ((await resolvedRepoUrl(dir, repo)) !== effectiveRepo) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `git remote rewrite rule changed while refreshing ${ref.repo}` };
  }
  const peeledTip = await git(dir, "rev-parse", "--verify", "--quiet", `${fetched.oid}^{commit}`);
  if (!peeledTip.ok || !gitHash.test(peeledTip.stdout)) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not resolve ${branch} from ${ref.repo}` };
  }
  const tip = peeledTip.stdout.toLowerCase();
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
  const postLoadHead = (await git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).stdout;
  if (!postLoadHead || postLoadHead.toLowerCase() !== tip.toLowerCase()) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", from)).ok) clearLoadedModules(dir);
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} changed checkout HEAD while loading` };
  }
  const effectiveDigest = repoDigest(effectiveRepo);
  const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: tip, branch: true, resolvedDigest: effectiveDigest });
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
