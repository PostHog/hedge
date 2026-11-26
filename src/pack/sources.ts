import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  if (!ok) ok = (await git(dir, "checkout", "-q", "--detach", `${before.commit}^{commit}`)).ok;
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

const slashByte = 0x2f;
const dotBuf = Buffer.from(".");
const dotDotBuf = Buffer.from("..");
const dotGitBuf = Buffer.from(".git");
const slashDotGitBuf = Buffer.from("/.git");
const slashHeadBuf = Buffer.from("/HEAD");
const slashObjectsBuf = Buffer.from("/objects");
const slashRefsBuf = Buffer.from("/refs");
const slashReftableBuf = Buffer.from("/reftable");
const slashCommondirBuf = Buffer.from("/commondir");
const gitdirPrefixBuf = Buffer.from("gitdir:");
const filePrefixBuf = Buffer.from("file://");

function splitPosixBytes(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === slashByte) {
      if (i > start) parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
}

function joinPosixBytes(parts: Buffer[]): Buffer {
  if (!parts.length) return Buffer.from("/");
  let total = parts.length;
  for (const p of parts) total += p.length;
  const out = Buffer.allocUnsafe(total);
  let pos = 0;
  for (const p of parts) {
    out[pos++] = slashByte;
    p.copy(out, pos);
    pos += p.length;
  }
  return out;
}

function resolvePosixPathBytes(base: Buffer, rawPath: Buffer): Buffer {
  const queue = splitPosixBytes(rawPath);
  const stack: Buffer[] = [];
  if (rawPath[0] !== slashByte) {
    for (const part of splitPosixBytes(base)) {
      if (!part.equals(dotBuf)) stack.push(part);
    }
  }
  let hops = 0;
  let index = 0;
  while (index < queue.length) {
    const seg = queue[index++]!;
    if (seg.length === 0 || seg.equals(dotBuf)) continue;
    if (seg.equals(dotDotBuf)) {
      stack.pop();
      continue;
    }
    const candidate = joinPosixBytes([...stack, seg]);
    if (hops < 40) {
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink()) {
          hops++;
          const linked = readlinkSync(candidate, "buffer");
          const rest = queue.slice(index);
          if (linked[0] === slashByte) stack.length = 0;
          queue.length = 0;
          queue.push(...splitPosixBytes(linked), ...rest);
          index = 0;
          continue;
        }
      } catch {}
    }
    stack.push(seg);
  }
  return joinPosixBytes(stack);
}

function isDirectoryBytes(pathBuf: Buffer): boolean {
  try {
    return statSync(pathBuf).isDirectory();
  } catch {
    return false;
  }
}

function isBareGitDirBytes(dirBuf: Buffer): boolean {
  try {
    if (!statSync(dirBuf).isDirectory()) return false;
    const headPath = Buffer.concat([dirBuf, slashHeadBuf]);
    const headInfo = statSync(headPath);
    if (!headInfo.isFile()) return false;
    const head = readFileSync(headPath, "utf8").trim();
    if (!head.startsWith("ref:") && !gitHash.test(head)) return false;
    let commonDir = dirBuf;
    const commonPath = Buffer.concat([dirBuf, slashCommondirBuf]);
    try {
      if (statSync(commonPath).isFile()) {
        const raw = readFileSync(commonPath);
        let end = raw.indexOf(0x0a);
        if (end === -1) end = raw.length;
        while (end > 0 && (raw[end - 1] === 0x0d || raw[end - 1] === 0x20 || raw[end - 1] === 0x09)) end--;
        if (end > 0) commonDir = resolvePosixPathBytes(dirBuf, raw.subarray(0, end));
      }
    } catch {}
    if (!isDirectoryBytes(Buffer.concat([commonDir, slashObjectsBuf]))) return false;
    return isDirectoryBytes(Buffer.concat([commonDir, slashRefsBuf])) || isDirectoryBytes(Buffer.concat([commonDir, slashReftableBuf]));
  } catch {
    return false;
  }
}

function isGitDirBytes(pathBuf: Buffer): boolean {
  if (isBareGitDirBytes(pathBuf)) return true;
  const dotGit = Buffer.concat([pathBuf, slashDotGitBuf]);
  try {
    const info = statSync(dotGit);
    if (info.isDirectory()) return isBareGitDirBytes(dotGit);
    if (info.isFile()) {
      const raw = readFileSync(dotGit);
      if (raw.length < gitdirPrefixBuf.length || !raw.subarray(0, gitdirPrefixBuf.length).equals(gitdirPrefixBuf)) return false;
      let start = gitdirPrefixBuf.length;
      let end = raw.indexOf(0x0a, start);
      if (end === -1) end = raw.length;
      while (start < end && (raw[start] === 0x20 || raw[start] === 0x09)) start++;
      while (end > start && (raw[end - 1] === 0x0d || raw[end - 1] === 0x20 || raw[end - 1] === 0x09)) end--;
      if (end <= start) return false;
      const target = resolvePosixPathBytes(pathBuf, raw.subarray(start, end));
      return isBareGitDirBytes(target);
    }
  } catch {}
  return false;
}

function endsWithDotGit(pathBuf: Buffer): boolean {
  return pathBuf.length >= 4 && pathBuf.subarray(pathBuf.length - 4).equals(dotGitBuf);
}

function isAsciiHexByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function decodePercentBytes(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x25 && i + 2 < buf.length && isAsciiHexByte(buf[i + 1]!) && isAsciiHexByte(buf[i + 2]!)) {
      const value = Number.parseInt(String.fromCharCode(buf[i + 1]!, buf[i + 2]!), 16);
      if (value !== 0) {
        out.push(value);
        i += 2;
        continue;
      }
    }
    out.push(buf[i]!);
  }
  return Buffer.from(out);
}

function expandTildeBytes(rawBytes: Buffer): Buffer {
  if (rawBytes[0] !== 0x7e) return rawBytes;
  const slash = rawBytes.indexOf(slashByte);
  const rest = slash === -1 ? Buffer.alloc(0) : rawBytes.subarray(slash);
  if (slash === 1 || rawBytes.length === 1) {
    const home = process.env.HOME || homedir();
    return home ? Buffer.concat([Buffer.from(home, "utf8"), rest]) : rawBytes;
  }
  const user = rawBytes.subarray(1, slash === -1 ? rawBytes.length : slash).toString("utf8");
  if (!user || user.includes(":")) return rawBytes;
  try {
    const passwd = readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] === user && fields[5]) return Buffer.concat([Buffer.from(fields[5], "utf8"), rest]);
    }
  } catch {}
  return rawBytes;
}

function stripTrailingSlashBytes(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 1 && buf[end - 1] === slashByte) end--;
  return end === buf.length ? buf : buf.subarray(0, end);
}

function encodeCanonicalLocal(resolvedBuf: Buffer, asFileUrl: boolean): string {
  const decoded = decodeRepoBytes(resolvedBuf);
  if (!asFileUrl) return decoded;
  if (!decoded.startsWith("\0raw:")) {
    try {
      return pathToFileURL(decoded).href;
    } catch {}
  }
  return decodeRepoBytes(Buffer.concat([filePrefixBuf, resolvedBuf]));
}

function parseLocalRepoBytes(dir: string, effective: string): { base: Buffer; rawPath: Buffer; asFileUrl: boolean } | undefined {
  if (!effective) return undefined;
  if (process.platform === "win32") return undefined;
  const rawBytes = effective.startsWith("\0raw:") ? Buffer.from(effective.slice(5), "hex") : Buffer.from(effective, "utf8");
  const asciiHead = rawBytes.subarray(0, 7).toString("latin1");
  if (/^file:\/\//i.test(asciiHead)) {
    const afterScheme = rawBytes.subarray(7);
    const firstSlash = afterScheme.indexOf(slashByte);
    if (firstSlash === -1) return undefined;
    const pathBytes = decodePercentBytes(afterScheme.subarray(firstSlash));
    return { base: Buffer.from("/"), rawPath: pathBytes, asFileUrl: true };
  }
  const latin = rawBytes.toString("latin1");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(latin) || /^[^/\\]+:/.test(latin)) return undefined;
  const expanded = expandTildeBytes(rawBytes);
  const base = expanded[0] === slashByte ? Buffer.from("/") : resolvePosixPathBytes(Buffer.from("/"), Buffer.from(resolve(dir), "utf8"));
  return { base, rawPath: expanded, asFileUrl: false };
}

function canonicalLocalRepoInfo(dir: string, effective: string, goodDigest?: string): { resolved: string; primary: string; usedImplicitDotGit: boolean; isLocal: boolean } {
  if (process.platform === "win32") {
    if (effective.startsWith("\0raw:")) return { resolved: effective, primary: effective, usedImplicitDotGit: false, isLocal: false };
    if (/^file:\/\//i.test(effective)) {
      try {
        const abs = resolve(fileURLToPath(effective));
        const out = pathToFileURL(existsSync(abs) ? realpathSync(abs) : abs).href;
        return { resolved: out, primary: out, usedImplicitDotGit: false, isLocal: true };
      } catch {
        return { resolved: effective, primary: effective, usedImplicitDotGit: false, isLocal: true };
      }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(effective) || (!/^[a-z]:[\\/]/i.test(effective) && /^[^/\\]+:/.test(effective))) {
      return { resolved: effective, primary: effective, usedImplicitDotGit: false, isLocal: false };
    }
    const abs = resolve(dir, effective);
    try {
      const out = realpathSync(abs);
      return { resolved: out, primary: out, usedImplicitDotGit: false, isLocal: true };
    } catch {
      return { resolved: abs, primary: abs, usedImplicitDotGit: false, isLocal: true };
    }
  }
  const parsed = parseLocalRepoBytes(dir, effective);
  if (!parsed) return { resolved: effective, primary: effective, usedImplicitDotGit: false, isLocal: false };
  const { base, rawPath, asFileUrl } = parsed;
  const resolved = resolvePosixPathBytes(base, rawPath);
  const primary = encodeCanonicalLocal(resolved, asFileUrl);
  if (isGitDirBytes(resolved)) return { resolved: primary, primary, usedImplicitDotGit: false, isLocal: true };
  const trimmedRaw = stripTrailingSlashBytes(rawPath);
  if (endsWithDotGit(trimmedRaw)) return { resolved: primary, primary, usedImplicitDotGit: false, isLocal: true };
  const dotGitResolved = resolvePosixPathBytes(base, Buffer.concat([trimmedRaw, dotGitBuf]));
  const dotGitEncoded = encodeCanonicalLocal(dotGitResolved, asFileUrl);
  if (isGitDirBytes(dotGitResolved)) return { resolved: dotGitEncoded, primary, usedImplicitDotGit: true, isLocal: true };
  return { resolved: primary, primary, usedImplicitDotGit: false, isLocal: true };
}

function canonicalLocalRepo(dir: string, effective: string): string {
  return canonicalLocalRepoInfo(dir, effective).resolved;
}

function implicitDotGitFallback(dir: string, effective: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const parsed = parseLocalRepoBytes(dir, effective);
  if (!parsed) return undefined;
  const { base, rawPath, asFileUrl } = parsed;
  const resolved = resolvePosixPathBytes(base, rawPath);
  if (isGitDirBytes(resolved)) return undefined;
  const trimmedRaw = stripTrailingSlashBytes(rawPath);
  if (endsWithDotGit(trimmedRaw)) return undefined;
  const dotGitResolved = resolvePosixPathBytes(base, Buffer.concat([trimmedRaw, dotGitBuf]));
  if (isGitDirBytes(dotGitResolved)) return undefined;
  return encodeCanonicalLocal(dotGitResolved, asFileUrl);
}

async function rawResolvedRepoUrlAt(dir: string, gitDir: string, repo: string) {
  if (!existsSync(gitDir)) return repo;
  const read = await gitAt(dir, gitDir, "ls-remote", "--get-url", repo);
  if (!read.ok || read.rawBytes.length === 0) return repo;
  const end =
    read.rawBytes.at(-1) === 0x0a
      ? process.platform === "win32" && read.rawBytes.length >= 2 && read.rawBytes.at(-2) === 0x0d
        ? read.rawBytes.length - 2
        : read.rawBytes.length - 1
      : read.rawBytes.length;
  return end > 0 ? decodeRepoBytes(read.rawBytes.subarray(0, end)) : repo;
}

async function rawResolvedRepoUrl(dir: string, repo: string) {
  return rawResolvedRepoUrlAt(dir, join(dir, ".git"), repo);
}

async function resolveCanonicalRepoAt(gitDir: string, dir: string, rawEffective: string): Promise<string> {
  const info = canonicalLocalRepoInfo(dir, rawEffective);
  if (info.usedImplicitDotGit || !info.isLocal) return info.resolved;
  const fallback = implicitDotGitFallback(dir, rawEffective);
  if (fallback && fallback !== info.resolved && (await hasImplicitDotGitRefAt(dir, gitDir, repoDigest(info.primary), repoDigest(fallback)))) {
    return fallback;
  }
  return info.resolved;
}

async function resolvedRepoUrlAt(gitDir: string, dir: string, repo: string, _goodDigest?: string) {
  return resolveCanonicalRepoAt(gitDir, dir, await rawResolvedRepoUrlAt(dir, gitDir, repo));
}

async function resolvedRepoUrl(dir: string, repo: string, _goodDigest?: string) {
  return resolvedRepoUrlAt(join(dir, ".git"), dir, repo);
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
  return src.startsWith("-") || src.startsWith("^");
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
  if (typeof ref !== "string" || typeof commit !== "string" || !gitHash.test(commit) || !existsSync(join(dir, ".git"))) {
    return false;
  }
  const stripped = stripSourceRefspec(ref);
  if (!isCommitPin(stripped, commit.length) || stripped.toLowerCase() === commit.toLowerCase()) return false;
  const type = await git(dir, "cat-file", "-t", stripped);
  if (!type.ok || type.stdout !== "tag") return false;
  const peeled = await git(dir, "rev-parse", "--verify", "--quiet", `${stripped}^{commit}`);
  return peeled.ok && peeled.stdout.toLowerCase() === commit.toLowerCase();
}

async function legacyFallbackMatches(dir: string, good: Good, rawEffectiveRepo: string, effectiveRepo: string): Promise<boolean> {
  const entry = await fetchHeadEntry(dir, [good.ref, good.asked]);
  if (entry === undefined) return true;
  const strippedRef = stripSourceRefspec(good.ref);
  const matchesGoodCommit = entry.oid === good.commit.toLowerCase() || (good.peeled === true && entry.oid === strippedRef.toLowerCase());
  if (matchesGoodCommit) return fetchHeadMatches(entry.url, rawEffectiveRepo) || fetchHeadMatches(entry.url, effectiveRepo);
  if (good.branch !== true && good.peeled !== true && isCommitPin(strippedRef, good.commit.length) && strippedRef.toLowerCase() !== good.commit.toLowerCase()) {
    return false;
  }
  return fetchHeadMatches(entry.url, rawEffectiveRepo) || fetchHeadMatches(entry.url, effectiveRepo) || rawEffectiveRepo === good.repo || effectiveRepo === good.repo;
}

async function fetchLocked(ref: SourceRef, dir: string, loadLimitMs: number): Promise<FetchedSource> {
  const repo = repoUrl(ref.repo);
  const edits = await localEdits(dir);
  if (edits.length) return keepEdits(ref, dir, edits, loadLimitMs);
  const rawGood = await lastGood(dir);
  const rawGoodDigest = goodResolvedDigest(rawGood);
  const rawStrippedRef = typeof rawGood?.ref === "string" ? stripSourceRefspec(rawGood.ref) : "";
  const legacyPeeledCandidate =
    rawGood !== undefined &&
    rawGoodDigest === undefined &&
    rawGood.peeled !== true &&
    rawGood.branch !== true &&
    typeof rawGood.ref === "string" &&
    typeof rawGood.commit === "string" &&
    gitHash.test(rawGood.commit) &&
    isCommitPin(rawStrippedRef, rawGood.commit.length) &&
    rawStrippedRef.toLowerCase() !== rawGood.commit.toLowerCase();
  const legacyPeeled =
    legacyPeeledCandidate &&
    ((await isPeeledTagInRepo(dir, rawGood.ref, rawGood.commit)) ||
      (existsSync(join(dir, ".git")) &&
        !(await git(dir, "cat-file", "-e", rawStrippedRef)).ok &&
        (await fetchHeadEntry(dir, [rawGood.ref]))?.oid === rawStrippedRef.toLowerCase()));
  const rawEffectiveBefore = await rawResolvedRepoUrl(dir, repo);
  const effectiveBefore = await resolveCanonicalRepoAt(join(dir, ".git"), dir, rawEffectiveBefore);
  const rawFhEntry =
    !legacyPeeled &&
    rawGood !== undefined &&
    rawGoodDigest === undefined &&
    rawGood.branch === undefined &&
    typeof rawGood.ref === "string"
      ? await fetchHeadEntry(dir, [rawGood.ref])
      : undefined;
  const legacyBranch =
    rawFhEntry !== undefined &&
    (await fetchHeadIsBranch(dir, rawGood!.ref)) === true &&
    (fetchHeadMatches(rawFhEntry.url, rawEffectiveBefore) ||
      fetchHeadMatches(rawFhEntry.url, effectiveBefore) ||
      (typeof rawGood!.repo === "string" && fetchHeadMatches(rawFhEntry.url, rawGood!.repo)));
  const good =
    legacyPeeled && rawGood
      ? { ...rawGood, peeled: true }
      : legacyBranch && rawGood
        ? { ...rawGood, branch: true }
        : rawGood;
  const goodDigest = goodResolvedDigest(good);
  const before = await currentCheckout(dir);
  const effectiveBeforeDigest = repoDigest(effectiveBefore);
  const legacyOk =
    good !== undefined &&
    good.repo === repo &&
    goodDigest === undefined &&
    hasGoodCommit(good) &&
    (await legacyFallbackMatches(dir, good, rawEffectiveBefore, effectiveBefore));
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
  let swapRollback: (() => Promise<void>) | undefined;
  let commitSwap: (() => Promise<void>) | undefined;
  let savedFetchHead: SavedFetchHead | undefined;
  let checkedOutCommit: string | undefined;
  const cachedHit = await checkedOutFromCache(dir, repo, rawEffectiveBefore, effectiveBefore, ref, good, before);
  if (cachedHit) {
    if (cachedHit.error) {
      fetchError = cachedHit.error;
    } else if (cachedHit.commit) {
      checkedOutCommit = cachedHit.commit;
      effectiveRepo = cachedHit.effectiveRepo;
      swapRollback = cachedHit.rollback;
      commitSwap = cachedHit.commitSwap;
    }
  }
  if (!checkedOutCommit && !fetchError) {
    savedFetchHead = await snapshotFetchHead(dir);
    fetchedNew = true;
    const fetched = await checkout(dir, repo, ref.ref, savedFetchHead, before, good);
    effectiveRepo = fetched.effectiveRepo;
    fetchError = fetched.error;
    checkedOutCommit = fetched.commit;
    fetchedOid = fetched.fetchedOid;
    swapRollback = fetched.rollback;
    commitSwap = fetched.commitSwap;
  }
  const effectiveDigest = repoDigest(effectiveRepo);
  if (!fetchError && checkedOutCommit) {
    const commit = checkedOutCommit;
    const isBranch = fetchedNew ? await fetchHeadIsBranch(dir, ref.ref, fetchedOid) : false;
    const strippedRef = stripSourceRefspec(ref.ref);
    const peeled =
      fetchedNew && isBranch !== true && isCommitPin(strippedRef, commit.length) && strippedRef.toLowerCase() !== commit.toLowerCase()
        ? fetchedOid === strippedRef.toLowerCase() ||
          (await isPeeledTagInRepo(dir, ref.ref, commit)) ||
          (isBranch === false && (await git(dir, "rev-parse", "--verify", "--quiet", `${strippedRef}^{commit}`)).stdout.toLowerCase() === commit.toLowerCase())
        : !fetchedNew && isCommitPin(strippedRef, commit.length) && strippedRef.toLowerCase() !== commit.toLowerCase()
          ? true
          : undefined;
    const loaded = await load(dir, loadLimitMs);
    if (!("error" in loaded)) {
      const postLoadHead = (await git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).stdout;
      if (!postLoadHead || postLoadHead.toLowerCase() !== commit.toLowerCase()) {
        if (swapRollback) await swapRollback();
        if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
        return fallBack(ref, dir, repo, effectiveRepo, good, `${ref.ref} from ${ref.repo} changed checkout HEAD while loading`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
      }
      const rawAfter = await rawResolvedRepoUrl(dir, repo);
      const localInfo = canonicalLocalRepoInfo(dir, rawAfter);
      const usedImplicit = localInfo.isLocal && (localInfo.usedImplicitDotGit || localInfo.primary !== effectiveRepo);
      const implicitAlias =
        usedImplicit && localInfo.primary !== effectiveRepo
          ? { primaryHash: repoDigest(localInfo.primary), dotGitHash: effectiveDigest }
          : undefined;
      const clearImplicitForPrimary = localInfo.isLocal && !usedImplicit ? repoDigest(localInfo.primary) : undefined;
      const saveError = await saveGood(
        dir,
        {
          repo,
          ref: ref.ref,
          commit,
          ...(isBranch === undefined ? {} : { branch: isBranch }),
          ...(peeled ? { peeled: true } : {}),
          resolvedDigest: effectiveDigest,
        },
        undefined,
        implicitAlias,
        clearImplicitForPrimary,
      );
      if (!saveError) {
        await commitSwap?.();
        return { ref, dir, packs: loaded.packs };
      }
      if (swapRollback) await swapRollback();
      if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
      return fallBack(ref, dir, repo, effectiveRepo, good, `could not record ${ref.ref} from ${ref.repo}: ${saveError}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveRepo === effectiveBefore, isBranch);
    }
    const keepBranchFetchHead =
      !swapRollback &&
      isBranch === true &&
      good !== undefined &&
      good.repo === repo &&
      good.ref !== ref.ref &&
      effectiveRepo === effectiveBefore &&
      (goodDigest !== undefined ? goodDigest === effectiveDigest : legacyOk);
    if (swapRollback) await swapRollback();
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
    (goodDigest !== undefined ? verifiedGoodCommit(good) !== undefined : hasGoodCommit(good)) &&
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
    if (!(await git(dir, "checkout", "-q", "--detach", `${good.commit}^{commit}`)).ok) return { ref, error: reason };
    const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
    if (!head.ok || head.stdout.toLowerCase() !== good.commit.toLowerCase()) return { ref, error: reason };
    clearLoadedModules(dir);
  }
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: reason };
  const nextAskedBranch = askedBranch !== undefined ? askedBranch : sameBranchRef(good.asked, ref.ref) ? good.askedBranch : undefined;
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
const historyAnchorRef = (repoHash: string, commit: string, from: string) => `refs/hedge/history-anchor/${repoHash}/${commit.toLowerCase()}/${from.toLowerCase()}`;
const implicitDotGitRef = (primaryHash: string, dotGitHash: string) => `refs/hedge/implicit-dotgit/${primaryHash}/${dotGitHash}`;
const inlineHistoryPinLimit = 256;

async function hasImplicitDotGitRefAt(dir: string, gitDir: string, primaryHash: string, dotGitHash: string): Promise<boolean> {
  if (!existsSync(gitDir)) return false;
  const check = await gitAt(dir, gitDir, "rev-parse", "--verify", "--quiet", implicitDotGitRef(primaryHash, dotGitHash));
  return check.ok && gitHash.test(check.stdout);
}

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

async function exactPinTargetAt(dir: string, gitDir: string, repoHash: string, oid: string): Promise<string | undefined> {
  if (!existsSync(gitDir)) return undefined;
  const normalized = oid.toLowerCase();
  const ref = pinRef(repoHash, normalized);
  const exact = await gitAt(dir, gitDir, "rev-parse", "--verify", "--quiet", ref);
  if (!exact.ok || exact.stdout.toLowerCase() !== normalized) return undefined;
  const commit = await gitAt(dir, gitDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return commit.ok && gitHash.test(commit.stdout) ? commit.stdout.toLowerCase() : undefined;
}

async function exactPinTarget(dir: string, repoHash: string, oid: string): Promise<string | undefined> {
  return exactPinTargetAt(dir, join(dir, ".git"), repoHash, oid);
}

async function gitWithStdinAt(dir: string, gitDir: string, stdin: string, args: string[], extraEnv?: Record<string, string>) {
  const proc = Bun.spawn(["git", "-C", dir, "--git-dir", gitDir, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: extraEnv ? { ...gitEnv(), ...extraEnv } : gitEnv(),
    timeout: fetchTimeoutMs,
  });
  const [code, rawBytes, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const bytes = new Uint8Array(rawBytes);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const message = proc.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, code, stdout: rawStdout.trim(), rawStdout, rawBytes: bytes, stderr: message };
}

async function gitWithStdin(dir: string, stdin: string, args: string[], extraEnv?: Record<string, string>) {
  return gitWithStdinAt(dir, join(dir, ".git"), stdin, args, extraEnv);
}

async function anchorsContainCommitAt(dir: string, gitDir: string, anchorOids: string[], needle: string): Promise<boolean> {
  if (!anchorOids.length) return false;
  const seen = new Set<string>();
  let frontier = anchorOids;
  while (frontier.length) {
    const batch = frontier.filter((oid) => !seen.has(oid));
    if (!batch.length) return false;
    for (const oid of batch) seen.add(oid);
    const read = await gitWithStdinAt(dir, gitDir, `${batch.join("\n")}\n`, ["cat-file", "--batch"]);
    if (!read.ok) return false;
    const raw = read.rawBytes;
    const decoder = new TextDecoder("latin1");
    const next: string[] = [];
    let pos = 0;
    while (pos < raw.length) {
      let nl = pos;
      while (nl < raw.length && raw[nl] !== 0x0a) nl++;
      const header = decoder.decode(raw.subarray(pos, nl));
      pos = nl + 1;
      const parts = header.split(" ");
      if (parts.length < 3) continue;
      const type = parts[1];
      const size = Number(parts[2]);
      if (!Number.isInteger(size) || size < 0 || pos + size > raw.length) break;
      const body = decoder.decode(raw.subarray(pos, pos + size));
      pos += size + 1;
      if (type !== "commit") continue;
      const parentLine = `parent ${needle}\n`;
      if (body.includes(parentLine)) return true;
      if (body.endsWith("\nhedge-history-chain\n")) {
        const firstParent = body.match(/^parent ([0-9a-f]{40}|[0-9a-f]{64})$/m)?.[1]?.toLowerCase();
        if (firstParent && !seen.has(firstParent)) next.push(firstParent);
      }
    }
    frontier = next;
  }
  return false;
}

async function pinTargetAt(dir: string, gitDir: string, repoHash: string, oid: string): Promise<string | undefined> {
  const exact = await exactPinTargetAt(dir, gitDir, repoHash, oid);
  if (exact) return exact;
  if (!existsSync(gitDir)) return undefined;
  const normalized = oid.toLowerCase();
  const type = await gitAt(dir, gitDir, "cat-file", "-t", normalized);
  if (!type.ok || type.stdout !== "commit") return undefined;
  const anchors = await gitAt(dir, gitDir, "for-each-ref", "--format=%(objectname)", `refs/hedge/history-anchor/${repoHash}/`);
  if (anchors.ok && anchors.stdout) {
    const anchorOids = [...new Set(anchors.stdout.split("\n").map((line) => line.trim().toLowerCase()).filter((line) => gitHash.test(line)))];
    if (await anchorsContainCommitAt(dir, gitDir, anchorOids, normalized)) return normalized;
  }
  return undefined;
}

async function pinTarget(dir: string, repoHash: string, oid: string): Promise<string | undefined> {
  return pinTargetAt(dir, join(dir, ".git"), repoHash, oid);
}

async function buildHistoryAnchor(dir: string, commits: string[]): Promise<string | undefined> {
  const tree = await gitWithStdin(dir, "", ["mktree"]);
  if (!tree.ok || !gitHash.test(tree.stdout)) return undefined;
  const emptyTree = tree.stdout.toLowerCase();
  const anchorEnv = {
    GIT_AUTHOR_NAME: "hedge",
    GIT_AUTHOR_EMAIL: "hedge@localhost",
    GIT_AUTHOR_DATE: "@0 +0000",
    GIT_COMMITTER_NAME: "hedge",
    GIT_COMMITTER_EMAIL: "hedge@localhost",
    GIT_COMMITTER_DATE: "@0 +0000",
  };
  let prev: string | undefined;
  for (let i = 0; i < commits.length; i += inlineHistoryPinLimit) {
    const chunk = commits.slice(i, i + inlineHistoryPinLimit);
    const args = ["commit-tree", emptyTree];
    if (prev) args.push("-p", prev);
    for (const oid of chunk) args.push("-p", oid);
    const created = await gitWithStdin(dir, prev ? "hedge-history-chain\n" : "hedge-history\n", args, anchorEnv);
    if (!created.ok || !gitHash.test(created.stdout)) return undefined;
    prev = created.stdout.toLowerCase();
  }
  return prev;
}

async function recordPinRef(dir: string, repoHash: string, oid: string, created?: string[]): Promise<string | undefined> {
  if ((await exactPinTarget(dir, repoHash, oid)) !== undefined) return undefined;
  const ref = pinRef(repoHash, oid);
  const updated = await git(dir, "update-ref", ref, oid.toLowerCase());
  if (!updated.ok) return updated.stderr || "could not record pinned commit";
  created?.push(ref);
  return undefined;
}

async function recordHistoryRef(dir: string, repoHash: string, commit: string, from: string, created?: string[]): Promise<string | undefined> {
  const normalized = commit.toLowerCase();
  const listed = await git(dir, "rev-list", normalized, `^${from.toLowerCase()}`);
  if (!listed.ok) return listed.stderr || "could not list verified commit history";
  const commits = listed.stdout
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => gitHash.test(line));
  if (!commits.length) return undefined;
  if (commits.length <= inlineHistoryPinLimit) {
    const targetRefs = commits.map((oid) => pinRef(repoHash, oid));
    const existingPinsRes = await git(dir, "for-each-ref", "--format=%(refname)", ...targetRefs);
    const existingPins = new Set(
      existingPinsRes.ok ? existingPinsRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [],
    );
    const toCreate: Array<{ ref: string; oid: string }> = [];
    for (let i = 0; i < commits.length; i++) {
      const targetRef = targetRefs[i]!;
      if (!existingPins.has(targetRef)) toCreate.push({ ref: targetRef, oid: commits[i]! });
    }
    if (!toCreate.length) return undefined;
    const cmds = toCreate.map((item) => `update ${item.ref} ${item.oid}\n`).join("");
    const batch = await gitWithStdin(dir, cmds, ["update-ref", "--stdin"]);
    if (!batch.ok) return batch.stderr || "could not record verified commit history";
    if (created) for (const item of toCreate) created.push(item.ref);
    return undefined;
  }
  const anchorRef = historyAnchorRef(repoHash, commit, from);
  const existingAnchor = await git(dir, "rev-parse", "--verify", "--quiet", anchorRef);
  if (existingAnchor.ok && gitHash.test(existingAnchor.stdout)) return undefined;
  const anchorOid = await buildHistoryAnchor(dir, commits);
  if (!anchorOid) return "could not record verified commit history";
  const savedAnchor = await git(dir, "update-ref", anchorRef, anchorOid);
  if (!savedAnchor.ok) return savedAnchor.stderr || "could not record verified commit history";
  created?.push(anchorRef);
  return undefined;
}

async function rollbackRefs(dir: string, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const cmds = refs.map((ref) => `delete ${ref}\n`).join("");
  const batch = await gitWithStdin(dir, cmds, ["update-ref", "--stdin"]).catch(() => ({ ok: false }));
  if (batch.ok) return;
  for (const ref of refs) {
    await git(dir, "update-ref", "-d", ref).catch(() => {});
  }
}

async function saveGood(
  dir: string,
  good: Good,
  historyFrom?: string,
  implicitAlias?: { primaryHash: string; dotGitHash: string },
  clearImplicitForPrimary?: string,
): Promise<string | undefined> {
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
  const createdRefs: string[] = [];
  if (currentCommit) {
    const recorded = await recordPinRef(dir, currentCommit.repoHash, currentCommit.commit, createdRefs);
    if (recorded && !unchanged) {
      await rollbackRefs(dir, createdRefs);
      return recorded;
    }
    if (implicitAlias) {
      const aliasRef = implicitDotGitRef(implicitAlias.primaryHash, implicitAlias.dotGitHash);
      const existingAlias = await git(dir, "rev-parse", "--verify", "--quiet", aliasRef);
      if (!existingAlias.ok || existingAlias.stdout.toLowerCase() !== currentCommit.commit) {
        const updatedAlias = await git(dir, "update-ref", aliasRef, currentCommit.commit);
        if (!updatedAlias.ok && !unchanged) {
          await rollbackRefs(dir, createdRefs);
          return updatedAlias.stderr || "could not record implicit repository alias";
        }
        if (updatedAlias.ok) createdRefs.push(aliasRef);
      }
    }
    if (historyFrom && gitHash.test(historyFrom)) {
      const recordedFrom = await recordPinRef(dir, currentCommit.repoHash, historyFrom, createdRefs);
      if (recordedFrom && !unchanged) {
        await rollbackRefs(dir, createdRefs);
        return recordedFrom;
      }
      const recordedHistory = await recordHistoryRef(dir, currentCommit.repoHash, currentCommit.commit, historyFrom, createdRefs);
      if (recordedHistory && !unchanged) {
        await rollbackRefs(dir, createdRefs);
        return recordedHistory;
      }
    }
    const strippedGoodRef = stripSourceRefspec(good.ref);
    if (good.peeled === true && isCommitPin(strippedGoodRef, currentCommit.commit.length) && (await git(dir, "cat-file", "-e", strippedGoodRef)).ok) {
      const recordedTag = await recordPinRef(dir, currentCommit.repoHash, strippedGoodRef, createdRefs);
      if (recordedTag && !unchanged) {
        await rollbackRefs(dir, createdRefs);
        return recordedTag;
      }
    }
  }
  if (unchanged) {
    await chmod(goodPath(dir), 0o600).catch(() => {});
    if (clearImplicitForPrimary) {
      const staleAliases = await git(dir, "for-each-ref", "--format=%(refname)", `refs/hedge/implicit-dotgit/${clearImplicitForPrimary}/`);
      if (staleAliases.ok && staleAliases.stdout) {
        const refsToClear = staleAliases.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (refsToClear.length) await rollbackRefs(dir, refsToClear);
      }
    }
    return undefined;
  }
  try {
    await writeAtomic(goodPath(dir), JSON.stringify(good) + "\n");
  } catch (error) {
    await rollbackRefs(dir, createdRefs);
    return error instanceof Error ? error.message : String(error);
  }
  if (clearImplicitForPrimary) {
    const staleAliases = await git(dir, "for-each-ref", "--format=%(refname)", `refs/hedge/implicit-dotgit/${clearImplicitForPrimary}/`);
    if (staleAliases.ok && staleAliases.stdout) {
      const refsToClear = staleAliases.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (refsToClear.length) await rollbackRefs(dir, refsToClear);
    }
  }
  return undefined;
}

const hasGoodCommit = (record: Good | undefined) =>
  record !== undefined &&
  typeof record.repo === "string" &&
  typeof record.ref === "string" &&
  typeof record.commit === "string" &&
  gitHash.test(record.commit);

const verifiedGoodCommit = (record: Good | undefined) => {
  if (!record || !hasGoodCommit(record)) return undefined;
  const strippedRef = stripSourceRefspec(record.ref);
  if (record.branch !== true && record.peeled !== true && isCommitPin(strippedRef, record.commit.length) && strippedRef.toLowerCase() !== record.commit.toLowerCase()) {
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
      (goodDigest === undefined || repoDigest(await resolvedRepoUrl(dir, repo, goodDigest)) === goodDigest);
    const hashLen = sameCachedRepo ? await repoHashLength(dir) : 40;
    const pinned = isCommitPin(stripSourceRefspec(ref.ref), hashLen) && !(sameCachedRepo && cacheRoot && (await followsBranch(ref, cacheRoot)));
    if (!pinned) unpinned.push(ref);
  }
  if (!unpinned.length) return [];
  const origin = await git(profileDir, "config", "--get", "remote.origin.url").then(
    (read) => (read.ok ? (process.platform === "win32" ? read.rawStdout.replace(/\r?\n$/, "") : read.rawStdout.replace(/\n$/, "")) : ""),
    () => "",
  );
  const ownRepo = (ref: SourceRef) => origin !== "" && repoKey(ref.repo) === repoKey(origin);
  return unpinned
    .filter((ref) => !ownRepo(ref))
    .map((ref) => ({ id: `source:unpinned:${ref.name}`, pack: "engine", say: `The pack source ${ref.name} is not pinned to a commit SHA. Pin its ref in hedge.json, so each apply loads the same packs, even offline.` }));
}

const altGitDirPath = (dir: string, format: "sha1" | "sha256") => join(dirname(dir), `.${basename(dir)}.git-${format}`);

async function gitConfigFile(...args: string[]) {
  const proc = Bun.spawn(["git", "config", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnv(), timeout: fetchTimeoutMs });
  const [code, rawBytes, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const bytes = new Uint8Array(rawBytes);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { ok: code === 0, code, stdout: rawStdout.trim(), rawStdout, rawBytes: bytes, stderr: stderr.trim() };
}

function parseNullConfigEntries(raw: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const nl = record.indexOf("\n");
    const key = nl === -1 ? record : record.slice(0, nl);
    const value = nl === -1 ? "" : record.slice(nl + 1);
    if (!key) continue;
    const list = entries.get(key) ?? [];
    list.push(value);
    entries.set(key, list);
  }
  return entries;
}

const isFormatConfigKey = (key: string) => key === "core.repositoryformatversion" || key.startsWith("extensions.");

async function syncRepoGitConfig(fromGitDir: string, toGitDir: string): Promise<() => Promise<void>> {
  const fromConfig = join(fromGitDir, "config");
  const toConfig = join(toGitDir, "config");
  if (!existsSync(fromConfig) || !existsSync(toConfig)) return async () => {};
  const [fromBytes, toBytes, toInfo] = await Promise.all([
    readFile(fromConfig),
    readFile(toConfig),
    stat(toConfig),
  ]);
  const savedMode = toInfo.mode & 0o777;
  const restore = async () => {
    await writeAtomic(toConfig, toBytes, savedMode).catch(() => {});
  };
  const targetList = await gitConfigFile("--file", toConfig, "--null", "--list");
  const targetFormatEntries = new Map<string, string[]>();
  if (targetList.ok) {
    for (const [key, values] of parseNullConfigEntries(targetList.rawStdout)) {
      if (isFormatConfigKey(key)) targetFormatEntries.set(key, values);
    }
  }
  await writeAtomic(toConfig, fromBytes, 0o600);
  const copiedList = await gitConfigFile("--file", toConfig, "--null", "--list");
  const keysToClear = new Set<string>(["core.repositoryformatversion", "core.bare"]);
  if (copiedList.ok) {
    for (const key of parseNullConfigEntries(copiedList.rawStdout).keys()) {
      if (isFormatConfigKey(key)) keysToClear.add(key);
    }
  }
  for (const key of keysToClear) {
    await gitConfigFile("--file", toConfig, "--unset-all", key).catch(() => {});
  }
  await gitConfigFile("--file", toConfig, "core.bare", "false");
  for (const [key, values] of targetFormatEntries) {
    for (const value of values) {
      await gitConfigFile("--file", toConfig, "--add", key, value);
    }
  }
  await chmod(toConfig, 0o600).catch(() => {});
  return restore;
}

async function checkoutFromEmptyTree(dir: string, commit: string, branch?: string): Promise<{ ok: boolean; stderr: string }> {
  const emptyTree = await gitWithStdin(dir, "", ["mktree"]);
  if (!emptyTree.ok || !gitHash.test(emptyTree.stdout)) return { ok: false, stderr: emptyTree.stderr || "could not create empty tree" };
  const cleared = await git(dir, "read-tree", "--empty");
  if (!cleared.ok) return { ok: false, stderr: cleared.stderr };
  const populated = await git(dir, "read-tree", "-m", "-u", emptyTree.stdout.toLowerCase(), `${commit}^{commit}`);
  if (!populated.ok) return { ok: false, stderr: populated.stderr };
  const refUpdated = branch
    ? await git(dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`)
    : await git(dir, "update-ref", "--no-deref", "HEAD", commit);
  if (!refUpdated.ok) return { ok: false, stderr: refUpdated.stderr };
  return { ok: true, stderr: "" };
}

async function listTrackedFiles(dir: string): Promise<string[]> {
  if (!existsSync(join(dir, ".git"))) return [];
  const listed = await git(dir, "ls-files", "-z");
  if (!listed.ok || !listed.rawStdout) return [];
  return listed.rawStdout.split("\0").filter(Boolean);
}

async function listTreeFiles(dir: string, gitDir: string, commit: string): Promise<string[] | undefined> {
  const listed = await gitAt(dir, gitDir, "ls-tree", "-r", "--name-only", "-z", commit);
  if (!listed.ok) return undefined;
  return listed.rawStdout ? listed.rawStdout.split("\0").filter(Boolean) : [];
}

async function hasUntrackedUnder(root: string, relDir: string, oldTracked: Set<string>): Promise<boolean> {
  const entries = await readdir(join(root, relDir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (await hasUntrackedUnder(root, childRel, oldTracked)) return true;
    } else if (!oldTracked.has(childRel)) {
      return true;
    }
  }
  return false;
}

async function checkUntrackedCollisions(dir: string, oldTracked: Set<string>, newFiles: string[]): Promise<string | undefined> {
  for (const rel of newFiles) {
    const parts = rel.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join("/");
      try {
        const info = lstatSync(join(dir, prefix));
        if (!info.isDirectory() && !oldTracked.has(prefix)) return `untracked file ${prefix} would be overwritten`;
      } catch {}
    }
    try {
      const info = lstatSync(join(dir, rel));
      if (info.isDirectory()) {
        if (await hasUntrackedUnder(dir, rel, oldTracked)) return `untracked files under ${rel} would be overwritten`;
      } else if (!oldTracked.has(rel)) {
        return `untracked file ${rel} would be overwritten`;
      }
    } catch {}
  }
  return undefined;
}

async function removeTrackedFiles(dir: string, files: string[]): Promise<void> {
  const dirs = new Set<string>();
  const root = resolve(dir);
  for (const rel of files) {
    const full = join(dir, rel);
    await rm(full, { force: true }).catch(() => {});
    let parent = dirname(full);
    while (resolve(parent) !== root && resolve(parent).startsWith(root + sep)) {
      dirs.add(parent);
      parent = dirname(parent);
    }
  }
  for (const folder of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(folder).catch(() => {});
  }
}

async function activateSwappedGit(
  dir: string,
  oldFormat: "sha1" | "sha256",
  targetGit: string,
  targetCommit: string,
  before: CheckoutState | undefined,
  removeTargetOnRollback: boolean,
  onRollbackTarget?: () => Promise<void>,
): Promise<{ commit?: string; rollback?: () => Promise<void>; commitSwap?: () => Promise<void>; error?: string }> {
  const oldTracked = await listTrackedFiles(dir);
  const newFiles = await listTreeFiles(dir, targetGit, targetCommit);
  if (!newFiles) return { error: "could not inspect fetched commit tree" };
  const collision = await checkUntrackedCollisions(dir, new Set(oldTracked), newFiles);
  if (collision) return { error: collision };
  const liveGit = join(dir, ".git");
  const stashOldGit = altGitDirPath(dir, oldFormat);
  let prevStashBackup: string | undefined;
  if (existsSync(stashOldGit)) {
    prevStashBackup = `${stashOldGit}.old-${crypto.randomUUID()}`;
    await rename(stashOldGit, prevStashBackup);
  }
  let movedOld = false;
  let movedNew = false;
  const rollback = async () => {
    if (movedNew) {
      const newTracked = await listTrackedFiles(dir);
      await removeTrackedFiles(dir, newTracked);
      if (removeTargetOnRollback) {
        await rm(liveGit, { recursive: true, force: true }).catch(() => {});
      } else {
        await rename(liveGit, targetGit).catch(() => {});
        await onRollbackTarget?.();
      }
    }
    if (movedOld) await rename(stashOldGit, liveGit).catch(() => {});
    if (prevStashBackup) await rename(prevStashBackup, stashOldGit).catch(() => {});
    if (before) {
      const restored = await checkoutFromEmptyTree(dir, before.commit, before.branch);
      if (!restored.ok) await restoreCheckout(dir, before);
    }
    clearLoadedModules(dir);
  };
  try {
    await rename(liveGit, stashOldGit);
    movedOld = true;
    await rename(targetGit, liveGit);
    movedNew = true;
    await removeTrackedFiles(dir, oldTracked);
    const moved = await checkoutFromEmptyTree(dir, targetCommit);
    if (!moved.ok) {
      await rollback();
      return { error: moved.stderr || "could not check out fetched commit" };
    }
    const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
    if (!head.ok || head.stdout.toLowerCase() !== targetCommit) {
      await rollback();
      return { error: head.stderr || "could not resolve checked-out HEAD" };
    }
    clearLoadedModules(dir);
    const commitSwap = async () => {
      if (prevStashBackup) await rm(prevStashBackup, { recursive: true, force: true }).catch(() => {});
    };
    return { commit: targetCommit, rollback, commitSwap };
  } catch (error) {
    await rollback();
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkedOutFromCache(
  dir: string,
  repo: string,
  rawEffectiveRepo: string,
  effectiveRepo: string,
  ref: SourceRef,
  good: Good | undefined,
  before: CheckoutState | undefined,
): Promise<{ commit?: string; effectiveRepo: string; rollback?: () => Promise<void>; commitSwap?: () => Promise<void>; error?: string } | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const oid = stripSourceRefspec(ref.ref).toLowerCase();
  if (!gitHash.test(oid)) return undefined;
  const hashLen = await repoHashLength(dir);
  const dotGitFallback = implicitDotGitFallback(dir, rawEffectiveRepo);
  const primaryHash = repoDigest(effectiveRepo);
  if (isCommitPin(oid, hashLen)) {
    const candidates = [effectiveRepo];
    if (
      dotGitFallback &&
      dotGitFallback !== effectiveRepo &&
      (await hasImplicitDotGitRefAt(dir, join(dir, ".git"), primaryHash, repoDigest(dotGitFallback)))
    ) {
      candidates.push(dotGitFallback);
    }
    const goodDigest = goodResolvedDigest(good);
    const goodCommit = verifiedGoodCommit(good);
    for (const candidate of candidates) {
      const candidateDigest = repoDigest(candidate);
      const verifiedGoodMatch =
        goodCommit !== undefined &&
        good?.repo === repo &&
        goodDigest !== undefined &&
        goodDigest === candidateDigest &&
        (goodCommit.commit === oid || (good.peeled === true && stripSourceRefspec(good.ref).toLowerCase() === oid));
      const target = verifiedGoodMatch ? goodCommit.commit : await pinTarget(dir, candidateDigest, oid);
      if (!target) continue;
      return (await git(dir, "checkout", "-q", "--detach", `${target}^{commit}`)).ok
        ? { commit: target, effectiveRepo: candidate }
        : undefined;
    }
    return undefined;
  }
  const altFormat = oid.length === 64 ? "sha256" : oid.length === 40 ? "sha1" : undefined;
  if (!altFormat) return undefined;
  const altGit = altGitDirPath(dir, altFormat);
  if (!existsSync(altGit)) return undefined;
  const altCandidates = [effectiveRepo];
  if (
    dotGitFallback &&
    dotGitFallback !== effectiveRepo &&
    (await hasImplicitDotGitRefAt(dir, altGit, primaryHash, repoDigest(dotGitFallback)))
  ) {
    altCandidates.push(dotGitFallback);
  }
  for (const candidate of altCandidates) {
    const target = await pinTargetAt(dir, altGit, repoDigest(candidate), oid);
    if (!target) continue;
    const oldFormat = hashLen === 64 ? "sha256" : "sha1";
    const restoreAltConfig = await syncRepoGitConfig(join(dir, ".git"), altGit);
    const swapped = await activateSwappedGit(dir, oldFormat, altGit, target, before, false, restoreAltConfig);
    if (swapped.error) {
      await restoreAltConfig();
      return { effectiveRepo: candidate, error: swapped.error };
    }
    if (swapped.commit) return { commit: swapped.commit, effectiveRepo: candidate, rollback: swapped.rollback, commitSwap: swapped.commitSwap };
    await restoreAltConfig();
  }
  return undefined;
}

type SavedFetchHead = { kind: "content"; bytes: Buffer; mode: number } | { kind: "missing" } | { kind: "unreadable" };

async function snapshotFetchHeadAt(gitDir: string): Promise<SavedFetchHead> {
  const path = join(gitDir, "FETCH_HEAD");
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    return { kind: "content", bytes, mode: info.mode & 0o777 };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

async function snapshotFetchHead(dir: string): Promise<SavedFetchHead> {
  return snapshotFetchHeadAt(join(dir, ".git"));
}

async function restoreFetchHeadAt(gitDir: string, saved: SavedFetchHead) {
  const path = join(gitDir, "FETCH_HEAD");
  if (saved.kind === "content") {
    const current = await readFile(path).catch(() => undefined);
    if (current && current.equals(saved.bytes)) return;
    await writeAtomic(path, saved.bytes, saved.mode).catch(() => {});
  } else if (saved.kind === "missing") {
    await rm(path, { force: true }).catch(() => {});
  }
}

async function restoreFetchHead(dir: string, saved: SavedFetchHead) {
  return restoreFetchHeadAt(join(dir, ".git"), saved);
}

function parsePorcelainFetchHead(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = line.match(/^[ *+t!=-]\s+[0-9a-f]+\s+([0-9a-f]{40}|[0-9a-f]{64})\s+FETCH_HEAD$/i);
    if (match) return match[1]!.toLowerCase();
  }
  return undefined;
}

async function fetchExactAt(dir: string, gitDir: string, repo: string, ref: string, shallow: boolean): Promise<{ ok: boolean; oid?: string; stderr: string; fullStderr?: string }> {
  const args = shallow ? ["fetch", "--porcelain", "--depth", "1", "--no-tags", repo, ref] : ["fetch", "--porcelain", "--no-tags", repo, ref];
  const fetched = await gitAt(dir, gitDir, ...args);
  if (fetched.ok) {
    const oid = parsePorcelainFetchHead(fetched.stdout);
    if (oid) return { ok: true, oid, stderr: "" };
  }
  const unsupportedPorcelain = !fetched.ok && (fetched.code === 129 || /unknown option.*porcelain/i.test(fetched.fullStderr)) && /porcelain/i.test(fetched.fullStderr);
  if (!fetched.ok && !unsupportedPorcelain) {
    return { ok: false, stderr: fetched.stderr, fullStderr: fetched.fullStderr };
  }
  const src = stripSourceRefspec(ref) || "HEAD";
  const tmpRef = `refs/hedge/tmp/${crypto.randomUUID()}`;
  try {
    const fallbackArgs = shallow ? ["fetch", "-q", "--depth", "1", "--no-tags", repo, `+${src}:${tmpRef}`] : ["fetch", "-q", "--no-tags", repo, `+${src}:${tmpRef}`];
    const fallback = await gitAt(dir, gitDir, ...fallbackArgs);
    if (!fallback.ok) return { ok: false, stderr: fallback.stderr, fullStderr: fallback.fullStderr };
    const resolved = await gitAt(dir, gitDir, "rev-parse", "--verify", "--quiet", tmpRef);
    return resolved.ok && gitHash.test(resolved.stdout) ? { ok: true, oid: resolved.stdout.toLowerCase(), stderr: "" } : { ok: false, stderr: resolved.stderr || "could not resolve fetched commit", fullStderr: resolved.fullStderr };
  } finally {
    await gitAt(dir, gitDir, "update-ref", "-d", tmpRef).catch(() => {});
  }
}

async function fetchExact(dir: string, repo: string, ref: string, shallow: boolean) {
  return fetchExactAt(dir, join(dir, ".git"), repo, ref, shallow);
}

async function checkout(
  dir: string,
  repo: string,
  ref: string,
  savedFetchHead: SavedFetchHead,
  before: CheckoutState | undefined,
  good?: Good,
): Promise<{ effectiveRepo: string; commit?: string; fetchedOid?: string; rollback?: () => Promise<void>; commitSwap?: () => Promise<void>; error?: string }> {
  const goodDigest = goodResolvedDigest(good);
  const effectiveBefore = await resolvedRepoUrl(dir, repo, goodDigest);
  if (isInvalidRef(ref)) return { effectiveRepo: effectiveBefore, error: `invalid ref ${JSON.stringify(ref)}` };
  await mkdir(dir, { recursive: true });
  const freshInit = !existsSync(join(dir, ".git"));
  if (freshInit) await git(dir, "init", "-q");
  const effectiveRepo = await resolvedRepoUrl(dir, repo, goodDigest);
  let fetched = await fetchExact(dir, repo, ref, true);
  if (!fetched.ok) {
    const currentHashLen = await repoHashLength(dir);
    const oldFormat = currentHashLen === 64 ? "sha256" : "sha1";
    const strippedRef = stripSourceRefspec(ref);
    const stderrText = `${fetched.fullStderr ?? ""}\n${fetched.stderr}`;
    const altFormat =
      currentHashLen === 40 && (isCommitPin(strippedRef, 64) || /object format|sha256|mismatched algorithms/i.test(stderrText))
        ? "sha256"
        : currentHashLen === 64 && (isCommitPin(strippedRef, 40) || /object format|sha1|mismatched algorithms/i.test(stderrText))
          ? "sha1"
          : undefined;
    if (altFormat && freshInit) {
      await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
      const reinit = await git(dir, "init", "-q", `--object-format=${altFormat}`);
      if (reinit.ok) fetched = await fetchExact(dir, repo, ref, true);
    } else if (altFormat && !freshInit) {
      const existingAlt = altGitDirPath(dir, altFormat);
      const reusedAlt = existsSync(existingAlt);
      const targetGit = reusedAlt ? existingAlt : join(dirname(dir), `.${basename(dir)}.git-tmp-${crypto.randomUUID()}`);
      const savedAltFetchHead = reusedAlt ? await snapshotFetchHeadAt(targetGit) : undefined;
      let restoreAltConfig: (() => Promise<void>) | undefined;
      try {
        let ready = reusedAlt;
        if (!reusedAlt) {
          await mkdir(targetGit, { recursive: true });
          const initAlt = await gitAt(dir, targetGit, "init", "-q", "--bare", `--object-format=${altFormat}`);
          if (initAlt.ok) {
            await gitAt(dir, targetGit, "config", "core.bare", "false");
            ready = true;
          }
        }
        if (ready) {
          restoreAltConfig = await syncRepoGitConfig(join(dir, ".git"), targetGit);
          const stagedEffective = await resolvedRepoUrlAt(targetGit, dir, repo, goodDigest);
          const stagedFetch = await fetchExactAt(dir, targetGit, repo, ref, true);
          if (stagedFetch.ok && stagedFetch.oid) {
            if ((await resolvedRepoUrlAt(targetGit, dir, repo, goodDigest)) !== stagedEffective) {
              if (savedAltFetchHead) await restoreFetchHeadAt(targetGit, savedAltFetchHead);
              if (reusedAlt) await restoreAltConfig?.();
              else await rm(targetGit, { recursive: true, force: true }).catch(() => {});
              await restoreFetchHead(dir, savedFetchHead);
              return { effectiveRepo: stagedEffective, error: "git remote rewrite rule changed during fetch" };
            }
            const stagedPeeled = await gitAt(dir, targetGit, "rev-parse", "--verify", "--quiet", `${stagedFetch.oid}^{commit}`);
            if (stagedPeeled.ok && gitHash.test(stagedPeeled.stdout)) {
              const stagedCommit = stagedPeeled.stdout.toLowerCase();
              const onRollbackTarget = reusedAlt
                ? async () => {
                    if (savedAltFetchHead) await restoreFetchHeadAt(targetGit, savedAltFetchHead);
                    await restoreAltConfig?.();
                  }
                : undefined;
              const swapped = await activateSwappedGit(dir, oldFormat, targetGit, stagedCommit, before, !reusedAlt, onRollbackTarget);
              if (swapped.commit) {
                return { effectiveRepo: stagedEffective, commit: swapped.commit, fetchedOid: stagedFetch.oid, rollback: swapped.rollback, commitSwap: swapped.commitSwap };
              }
              if (savedAltFetchHead) await restoreFetchHeadAt(targetGit, savedAltFetchHead);
              if (reusedAlt) await restoreAltConfig?.();
              else await rm(targetGit, { recursive: true, force: true }).catch(() => {});
              await restoreFetchHead(dir, savedFetchHead);
              return { effectiveRepo: stagedEffective, error: swapped.error || "could not switch cache object format" };
            }
          } else if (stagedFetch.stderr) {
            fetched = stagedFetch;
          }
        }
      } catch {}
      if (savedAltFetchHead) await restoreFetchHeadAt(targetGit, savedAltFetchHead);
      if (reusedAlt) await restoreAltConfig?.();
      else await rm(targetGit, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!fetched.ok || !fetched.oid) {
    if (freshInit) await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
    else await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: fetched.stderr || "could not fetch commit" };
  }
  if ((await resolvedRepoUrl(dir, repo, goodDigest)) !== effectiveRepo) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: "git remote rewrite rule changed during fetch" };
  }
  const peeled = await git(dir, "rev-parse", "--verify", "--quiet", `${fetched.oid}^{commit}`);
  if (!peeled.ok || !gitHash.test(peeled.stdout)) {
    await restoreFetchHead(dir, savedFetchHead);
    return { effectiveRepo, error: peeled.stderr || "could not resolve fetched commit" };
  }
  const targetCommit = peeled.stdout.toLowerCase();
  const moved = await git(dir, "checkout", "-q", "--detach", `${targetCommit}^{commit}`);
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

async function gitAt(dir: string, gitDir: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, "--git-dir", gitDir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnv(), timeout: fetchTimeoutMs });
  const [code, rawBytes, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const bytes = new Uint8Array(rawBytes);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const message = proc.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, code, stdout: rawStdout.trim(), rawStdout, rawBytes: bytes, stderr: message, fullStderr: stderr };
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

const branchName = (ref: unknown) => {
  if (typeof ref !== "string") return undefined;
  const stripped = stripSourceRefspec(ref).replace(/^refs\/heads\//, "");
  return stripped || undefined;
};

const hasExplicitHead = (ref: unknown) => typeof ref === "string" && stripSourceRefspec(ref).startsWith("refs/heads/");
const hasRefspecDecor = (ref: unknown) => typeof ref === "string" && (ref.startsWith("+") || ref.endsWith(":"));

const sameBranchRef = (a: unknown, b: unknown): boolean => {
  const nameA = branchName(a);
  const nameB = branchName(b);
  if (!nameA || nameA !== nameB) return false;
  if (!gitHash.test(nameA)) return true;
  const headA = hasExplicitHead(a);
  const headB = hasExplicitHead(b);
  if (headA === headB) return true;
  if (headA && !headB && hasRefspecDecor(b)) return false;
  if (headB && !headA && hasRefspecDecor(a)) return false;
  return true;
};

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
  let isBranch: boolean;
  let matchedExplicitHead = false;
  if (sameBranchRef(good.asked, ref.ref)) {
    matchedExplicitHead = hasExplicitHead(good.asked);
    if (good.askedBranch === true) isBranch = true;
    else if (good.askedBranch === false) return false;
    else if (sameBranchRef(good.ref, ref.ref) && typeof good.branch === "boolean") isBranch = good.branch;
    else isBranch = (await fetchHeadIsBranch(dir, ref.ref)) === true;
  } else if (sameBranchRef(good.ref, ref.ref)) {
    matchedExplicitHead = hasExplicitHead(good.ref);
    if (good.branch === true) isBranch = true;
    else if (good.branch === false) return false;
    else isBranch = (await fetchHeadIsBranch(dir, ref.ref)) === true;
  } else {
    return false;
  }
  if (!isBranch) return false;
  if (gitHash.test(branch) && matchedExplicitHead && !hasExplicitHead(ref.ref) && existsSync(join(dir, ".git"))) {
    const obj = await git(dir, "cat-file", "-t", branch);
    if (obj.ok && obj.stdout === "commit") return false;
  }
  const hasPlusPrefix = (value: unknown) => typeof value === "string" && value.startsWith("+");
  const needsRepoCheck =
    hasPlusPrefix(ref.ref) ||
    hasPlusPrefix(good.ref) ||
    hasPlusPrefix(good.asked) ||
    (Array.isArray(good.blocked) && good.blocked.length > 0);
  if (!needsRepoCheck) return true;
  const goodDigest = goodResolvedDigest(good);
  const effectiveDigest = repoDigest(await resolvedRepoUrl(dir, repo, goodDigest));
  const sameRepo = good.repo === repo && (goodDigest === undefined || goodDigest === effectiveDigest);
  if ((hasPlusPrefix(ref.ref) || hasPlusPrefix(good.ref) || hasPlusPrefix(good.asked)) && !sameRepo) return false;
  if (Array.isArray(good.blocked) && good.blocked.length) {
    if (good.blocked.some((entry) => entry && entry.repo === repo && goodResolvedDigest(entry) === effectiveDigest)) return false;
  }
  return true;
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
  const branch = branchName(ref.ref);
  const head = branch ? `refs/heads/${branch}` : "";
  if (!branch || isInvalidRef(head)) return { state: "failed", say: `invalid ref ${JSON.stringify(ref.ref)} for ${ref.repo}` };
  const cachedGood = await lastGood(dir);
  const cachedDigest = goodResolvedDigest(cachedGood);
  const rawEffectiveRepo = await rawResolvedRepoUrl(dir, repo);
  const effectiveRepo = await resolveCanonicalRepoAt(join(dir, ".git"), dir, rawEffectiveRepo);
  const effectiveDigest = repoDigest(effectiveRepo);
  const listed = await git(dir, "ls-remote", repo, head);
  if (!listed.ok) return { state: "failed", say: `could not reach ${ref.repo}: ${listed.stderr}` };
  const legacyRepoMismatch =
    cachedGood !== undefined &&
    cachedDigest === undefined &&
    hasGoodCommit(cachedGood) &&
    !(await legacyFallbackMatches(dir, cachedGood, rawEffectiveRepo, effectiveRepo));
  if (cachedGood && (cachedGood.repo !== repo || (cachedDigest !== undefined ? cachedDigest !== effectiveDigest : legacyRepoMismatch))) {
    return { state: "refused", say: `${ref.name} now points to ${ref.repo}, not the repository Hedge loaded last. Run hedge apply.` };
  }
  if (
    cachedGood &&
    (!hasGoodCommit(cachedGood) ||
      cachedGood.commit.toLowerCase() !== from.toLowerCase() ||
      (cachedGood.branch === false && cachedGood.askedBranch !== true))
  ) {
    return { state: "busy" };
  }
  const verifiedHistoryFrom = cachedGood !== undefined ? from : undefined;
  const commit = listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, name]) => name === head)?.[0];
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
  const moved = await git(dir, "checkout", "-q", "--detach", `${tip}^{commit}`);
  if (!moved.ok) {
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `could not check out ${tip.slice(0, 12)} of ${ref.name}: ${moved.stderr}` };
  }
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", `${from}^{commit}`)).ok) clearLoadedModules(dir);
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} does not load: ${loaded.error}` };
  }
  const postLoadHead = (await git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).stdout;
  if (!postLoadHead || postLoadHead.toLowerCase() !== tip.toLowerCase()) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", `${from}^{commit}`)).ok) clearLoadedModules(dir);
    await restoreFetchHead(dir, savedFetchHead);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} changed checkout HEAD while loading` };
  }
  const rawAfterRefresh = await rawResolvedRepoUrl(dir, repo);
  const refreshLocalInfo = canonicalLocalRepoInfo(dir, rawAfterRefresh);
  const refreshUsedImplicit = refreshLocalInfo.isLocal && (refreshLocalInfo.usedImplicitDotGit || refreshLocalInfo.primary !== effectiveRepo);
  const refreshAlias =
    refreshUsedImplicit && refreshLocalInfo.primary !== effectiveRepo
      ? { primaryHash: repoDigest(refreshLocalInfo.primary), dotGitHash: effectiveDigest }
      : undefined;
  const clearRefreshImplicit = refreshLocalInfo.isLocal && !refreshUsedImplicit ? repoDigest(refreshLocalInfo.primary) : undefined;
  const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: tip, branch: true, resolvedDigest: effectiveDigest }, verifiedHistoryFrom, refreshAlias, clearRefreshImplicit);
  if (saveError) {
    if (before) await restoreCheckout(dir, before);
    else if ((await git(dir, "checkout", "-q", "--detach", `${from}^{commit}`)).ok) clearLoadedModules(dir);
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
