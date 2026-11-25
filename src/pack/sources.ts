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

type Good = { repo: string; ref: string; commit: string; asked?: string };

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

async function fetchLocked(ref: SourceRef, dir: string, loadLimitMs: number): Promise<FetchedSource> {
  const repo = repoUrl(ref.repo);
  const edits = await localEdits(dir);
  if (edits.length) return keepEdits(ref, dir, edits, loadLimitMs);
  const good = await lastGood(dir);
  const fetchError = (await checkedOutFromCache(dir, repo, ref, good)) ? undefined : await checkout(dir, repo, ref.ref);
  if (!fetchError) {
    const loaded = await load(dir, loadLimitMs);
    if (!("error" in loaded)) {
      const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: (await git(dir, "rev-parse", "HEAD")).stdout });
      if (!saveError) return { ref, dir, packs: loaded.packs };
      return fallBack(ref, dir, repo, good, `could not record ${ref.ref} from ${ref.repo}: ${saveError}`, loadLimitMs);
    }
    return fallBack(ref, dir, repo, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`, loadLimitMs);
  }
  return fallBack(ref, dir, repo, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError}`, loadLimitMs);
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

async function fallBack(ref: SourceRef, dir: string, repo: string, good: Good | undefined, reason: string, loadLimitMs: number): Promise<FetchedSource> {
  if (!good || good.repo !== repo) return { ref, error: reason };
  if (!(await git(dir, "checkout", "-q", "--detach", good.commit)).ok) return { ref, error: reason };
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: reason };
  const saveError = await saveGood(dir, { repo: good.repo, ref: good.ref, commit: good.commit, ...(good.ref === ref.ref ? {} : { asked: ref.ref }) });
  if (saveError) return { ref, error: reason };
  return { ref, dir, packs: loaded.packs, stale: good.ref === ref.ref ? reason : `${reason}; using ${good.ref} instead` };
}

const loadedModules = createRequire(import.meta.url).cache;

async function load(dir: string, limitMs: number): Promise<{ packs: LoadedPack[] } | { error: string }> {
  if (await hasPackTs(dir)) {
    const error = await loadsElsewhere(dir, limitMs);
    if (error) return { error };
    const folders = [resolve(dir), realpathSync(dir)].map((folder) => folder + sep);
    for (const loaded of Object.keys(loadedModules)) if (folders.some((folder) => loaded.startsWith(folder))) delete loadedModules[loaded];
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
    return JSON.parse(await readFile(goodPath(dir), "utf8")) as Good;
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

async function hasPinRef(dir: string, repo: string, commit: string) {
  const read = await git(dir, "rev-parse", "--verify", "--quiet", `${pinRef(repo, commit)}^{commit}`);
  return read.ok && read.stdout.toLowerCase() === commit.toLowerCase();
}

async function recordPinRef(dir: string, repo: string, commit: string): Promise<string | undefined> {
  if (await hasPinRef(dir, repo, commit)) return undefined;
  const updated = await git(dir, "update-ref", pinRef(repo, commit), commit.toLowerCase());
  return updated.ok ? undefined : updated.stderr || "could not record pinned commit";
}

const pinnedCommit = (record: Good | undefined) =>
  record && typeof record.repo === "string" && typeof record.ref === "string" && typeof record.commit === "string" && commitSha.test(record.ref) && record.ref.toLowerCase() === record.commit.toLowerCase()
    ? { repo: record.repo, commit: record.commit.toLowerCase() }
    : undefined;

async function saveGood(dir: string, good: Good): Promise<string | undefined> {
  const before = await lastGood(dir);
  const previousPin = pinnedCommit(before);
  if (previousPin) {
    const exists = await git(dir, "cat-file", "-e", `${previousPin.commit}^{commit}`);
    if (exists.ok) {
      const migrated = await recordPinRef(dir, previousPin.repo, previousPin.commit);
      if (migrated) return migrated;
    }
  }
  const currentPin = pinnedCommit(good);
  if (currentPin) {
    const recorded = await recordPinRef(dir, currentPin.repo, currentPin.commit);
    if (recorded) return recorded;
  }
  await writeAtomic(goodPath(dir), JSON.stringify(good) + "\n");
  return undefined;
}

const commitSha = /^[0-9a-f]{40}$/i;

const githubRepoPattern = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]+@)?(?:(?:ssh|www)\.)?github\.com(?::\d+)?\/|(?:[^/@:\s]+@)?(?:(?:ssh|www)\.)?github\.com:)(.+)$/i;

const repoKey = (repo: string) => {
  const url = repoUrl(repo).replace(/\.git$/, "");
  const github = url.match(githubRepoPattern)?.[1];
  return github ? github.toLowerCase() : url;
};

export async function unpinnedSources(refs: SourceRef[], profileDir: string): Promise<Finding[]> {
  const unpinned = refs.filter((ref) => !commitSha.test(ref.ref));
  if (!unpinned.length) return [];
  const origin = await git(profileDir, "config", "--get", "remote.origin.url").then((read) => read.stdout, () => "");
  const ownRepo = (ref: SourceRef) => origin !== "" && repoKey(ref.repo) === repoKey(origin);
  return unpinned
    .filter((ref) => !ownRepo(ref))
    .map((ref) => ({ id: `source:unpinned:${ref.name}`, pack: "engine", say: `The pack source ${ref.name} is not pinned to a commit SHA. Pin its ref in hedge.json, so each apply loads the same packs, even offline.` }));
}

async function checkedOutFromCache(dir: string, repo: string, ref: SourceRef, good: Good | undefined) {
  const commit = ref.ref.toLowerCase();
  if (!commitSha.test(commit)) return false;
  const fetchedHere =
    (good?.repo === repo && typeof good.commit === "string" && good.commit.toLowerCase() === commit) ||
    (await hasPinRef(dir, repo, commit));
  if (!fetchedHere) return false;
  return (await git(dir, "checkout", "-q", "--detach", commit)).ok;
}

async function checkout(dir: string, url: string, ref: string): Promise<string | undefined> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q");
  const fetched = await git(dir, "fetch", "-q", "--depth", "1", "--no-tags", url, ref);
  if (!fetched.ok) return fetched.stderr;
  const moved = await git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  return moved.ok ? undefined : moved.stderr;
}

/** Runs git without any prompt: no terminal, no askpass program, SSH in batch mode, and a time limit. */
async function git(dir: string, ...args: string[]) {
  const env = { ...withoutRepoEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const process = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: fetchTimeoutMs });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  const message = process.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, stdout: stdout.trim(), stderr: message };
}

export function sourceCache(home: string) {
  return join(home, ".local", "share", "hedge", "sources");
}

const branchName = (ref: unknown) => (typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined);

export async function followsBranch(ref: SourceRef, cacheRoot: string) {
  if (commitSha.test(ref.ref)) return false;
  const good = await lastGood(join(cacheRoot, ref.name));
  const branch = branchName(ref.ref);
  if (!good || !branch || (branchName(good.ref) !== branch && branchName(good.asked) !== branch)) return false;
  const fetched = await readFile(join(cacheRoot, ref.name, ".git", "FETCH_HEAD"), "utf8").catch(() => "");
  return fetched.split("\n")[0]?.includes(`\tbranch '${branch}' of `) ?? false;
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
  const listed = await git(dir, "ls-remote", repo, head);
  if (!listed.ok) return { state: "failed", say: `could not reach ${ref.repo}: ${listed.stderr}` };
  const commit = listed.stdout.split("\n").map((line) => line.split("\t")).find(([, name]) => name === head)?.[0];
  if (!commit) return { state: "failed", say: `${ref.repo} has no branch ${branch}` };
  if (commit === from) return { state: "same", commit };
  const rewritten = (tip: string) => ({ state: "refused" as const, say: `${branch} of ${ref.repo} moved to ${tip.slice(0, 12)}, which does not build on ${from.slice(0, 12)}, the commit Hedge loaded last. Hedge refresh runs no pack code from a rewritten branch. Run hedge update to take it.` });
  const edits = await localEdits(dir);
  if (edits.length) return { state: "edited", say: `${ref.name} moved, but Hedge ${editsReason(ref, dir, edits)}.` };
  const fetched = await git(dir, "fetch", "-q", "--no-tags", repo, head);
  if (!fetched.ok) return { state: "failed", say: `could not fetch ${branch} from ${ref.repo}: ${fetched.stderr}` };
  const tip = (await git(dir, "rev-parse", "FETCH_HEAD")).stdout;
  if (!(await git(dir, "merge-base", "--is-ancestor", from, tip)).ok) return rewritten(tip);
  const moved = await git(dir, "checkout", "-q", "--detach", tip);
  if (!moved.ok) return { state: "failed", say: `could not check out ${tip.slice(0, 12)} of ${ref.name}: ${moved.stderr}` };
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) {
    await git(dir, "checkout", "-q", "--detach", from);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} does not load: ${loaded.error}` };
  }
  const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: tip });
  if (saveError) {
    await git(dir, "checkout", "-q", "--detach", from);
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
