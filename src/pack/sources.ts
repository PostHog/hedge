import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
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
const slashBuf = Buffer.from("/");
const zeroByteBuf = Buffer.from([0]);
const dotBuf = Buffer.from(".");
const dotDotBuf = Buffer.from("..");
const dotGitBuf = Buffer.from(".git");
const slashDotGitBuf = Buffer.from("/.git");
const slashHeadBuf = Buffer.from("/HEAD");
const slashObjectsBuf = Buffer.from("/objects");
const slashRefsBuf = Buffer.from("/refs");
const slashReftableBuf = Buffer.from("/reftable");
const slashCommondirBuf = Buffer.from("/commondir");
const gitdirPrefixBuf = Buffer.from("gitdir: ");
const bundleV2Buf = Buffer.from("# v2 git bundle\n");
const bundleV3Buf = Buffer.from("# v3 git bundle\n");
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

function resolvePosixPathBytes(base: Buffer, rawPath: Buffer, followLast = true): Buffer | undefined {
  const queue = splitPosixBytes(rawPath);
  const trailingSlash = rawPath.length > 1 && rawPath[rawPath.length - 1] === slashByte;
  let requireDir = trailingSlash;
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
    if (seg.length === 0) continue;
    if (seg.equals(dotBuf)) {
      if (stack.length > 0) {
        try {
          if (!statSync(joinPosixBytes(stack)).isDirectory()) return undefined;
        } catch {}
      }
      continue;
    }
    if (seg.equals(dotDotBuf)) {
      if (stack.length > 0) {
        if (!isDirectoryBytes(joinPosixBytes(stack))) return undefined;
        stack.pop();
      }
      continue;
    }
    const candidate = joinPosixBytes([...stack, seg]);
    if (followLast || index < queue.length || trailingSlash) {
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink()) {
          if (hops >= 40) return undefined;
          hops++;
          const linked = readlinkSync(candidate, "buffer");
          const rest = queue.slice(index);
          if (rest.length === 0 && linked.length > 0 && linked[linked.length - 1] === slashByte) requireDir = true;
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
  const out = joinPosixBytes(stack);
  if (requireDir) {
    try {
      if (!statSync(out).isDirectory()) return undefined;
    } catch {}
  }
  return out;
}

function isDirectoryBytes(pathBuf: Buffer): boolean {
  try {
    return statSync(pathBuf).isDirectory();
  } catch {
    return false;
  }
}

function dirnamePosixBytes(buf: Buffer): Buffer {
  const last = buf.lastIndexOf(slashByte);
  return last <= 0 ? slashBuf : buf.subarray(0, last);
}

function parseGitDirFileBytes(fileBuf: Buffer, baseDir: Buffer): Buffer | undefined {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile() || info.size < gitdirPrefixBuf.length || info.size > 8192) return undefined;
    fd = openSync(fileBuf, "r");
    const header = Buffer.allocUnsafe(gitdirPrefixBuf.length);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(gitdirPrefixBuf)) return undefined;
    const raw = Buffer.allocUnsafe(info.size);
    header.copy(raw, 0);
    let filled = header.length;
    while (filled < info.size) {
      const n = readSync(fd, raw, filled, info.size - filled, filled);
      if (n <= 0) break;
      filled += n;
    }
    const slice = raw.subarray(0, filled);
    const start = gitdirPrefixBuf.length;
    let end = slice.length;
    while (end > start && (slice[end - 1] === 0x0a || slice[end - 1] === 0x0d)) end--;
    if (end <= start) return undefined;
    return resolvePosixPathBytes(baseDir, slice.subarray(start, end));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function isGitBundleFileBytes(fileBuf: Buffer): boolean {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile() || info.size < bundleV2Buf.length) return false;
    fd = openSync(fileBuf, "r");
    const header = Buffer.allocUnsafe(bundleV2Buf.length);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    return header.equals(bundleV2Buf) || header.equals(bundleV3Buf);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function readBoundedPrefixBytes(fileBuf: Buffer, maxBytes: number, rejectOversized = false): Buffer | undefined {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile()) return undefined;
    if (rejectOversized && info.size > maxBytes) return undefined;
    const cap = Math.min(info.size, maxBytes);
    if (cap === 0) return Buffer.alloc(0);
    fd = openSync(fileBuf, "r");
    const raw = Buffer.allocUnsafe(cap);
    let filled = 0;
    while (filled < cap) {
      const n = readSync(fd, raw, filled, cap - filled, filled);
      if (n <= 0) break;
      filled += n;
    }
    return raw.subarray(0, filled);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function isValidHeadBytes(raw: Buffer): boolean {
  const text = raw.toString("latin1");
  if (text.startsWith("ref:")) return /^ref:[ \t\r\n\v\f]*refs\//.test(text);
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:[\r\n]|$)/i.test(text);
}

function nestedCommonKeyBytes(gitDirBuf: Buffer): Buffer | undefined {
  const commonPath = Buffer.concat([gitDirBuf, slashCommondirBuf]);
  let isFile = false;
  try {
    isFile = statSync(commonPath).isFile();
  } catch {
    return undefined;
  }
  if (!isFile) return undefined;
  const rawCommon = readBoundedPrefixBytes(commonPath, 8192, true);
  if (!rawCommon) return Buffer.from("oversized");
  let end = rawCommon.length;
  while (end > 0 && (rawCommon[end - 1] === 0x0a || rawCommon[end - 1] === 0x0d)) end--;
  if (end === 0) return Buffer.from("empty");
  return resolvePosixPathBytes(gitDirBuf, rawCommon.subarray(0, end)) ?? Buffer.concat([Buffer.from("raw:"), rawCommon.subarray(0, end)]);
}

function withNestedCommonBytes(prefix: Buffer, target: Buffer): Buffer {
  const nested = nestedCommonKeyBytes(target);
  return nested ? Buffer.concat([prefix, target, zeroByteBuf, Buffer.from("common:"), nested]) : Buffer.concat([prefix, target]);
}

function resolvedCommonDirBytes(dirBuf: Buffer): Buffer | undefined {
  try {
    if (!statSync(dirBuf).isDirectory()) return undefined;
    const headBytes = readBoundedPrefixBytes(Buffer.concat([dirBuf, slashHeadBuf]), 256);
    if (!headBytes || !isValidHeadBytes(headBytes)) return undefined;
    let commonDir = dirBuf;
    const commonPath = Buffer.concat([dirBuf, slashCommondirBuf]);
    let hasCommonFile = false;
    try {
      hasCommonFile = statSync(commonPath).isFile();
    } catch {}
    if (hasCommonFile) {
      const rawCommon = readBoundedPrefixBytes(commonPath, 8192, true);
      if (!rawCommon) return undefined;
      let end = rawCommon.length;
      while (end > 0 && (rawCommon[end - 1] === 0x0a || rawCommon[end - 1] === 0x0d)) end--;
      if (end > 0) {
        const resolvedCommon = resolvePosixPathBytes(dirBuf, rawCommon.subarray(0, end));
        if (!resolvedCommon) return undefined;
        commonDir = resolvedCommon;
      }
    }
    if (!isDirectoryBytes(Buffer.concat([commonDir, slashObjectsBuf]))) return undefined;
    if (!isDirectoryBytes(Buffer.concat([commonDir, slashRefsBuf])) && !isDirectoryBytes(Buffer.concat([commonDir, slashReftableBuf]))) return undefined;
    return commonDir;
  } catch {
    return undefined;
  }
}

function explicitPointerKeyBytes(pathBuf: Buffer, lexicalPath: Buffer, asFileUrl: boolean): string | undefined {
  const dotGit = Buffer.concat([pathBuf, slashDotGitBuf]);
  try {
    const linkInfo = lstatSync(dotGit);
    if (linkInfo.isSymbolicLink()) {
      const resolvedTarget = resolvePosixPathBytes(pathBuf, dotGitBuf);
      const keyBuf = resolvedTarget
        ? withNestedCommonBytes(Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("dotgit-link:")]), resolvedTarget)
        : Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("dotgit-link:raw:"), readlinkSync(dotGit, "buffer")]);
      return encodeCanonicalLocal(keyBuf, asFileUrl);
    }
    if (linkInfo.isFile()) {
      const target = parseGitDirFileBytes(dotGit, pathBuf);
      const keyBuf = target
        ? withNestedCommonBytes(Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("dotgit-file:")]), target)
        : Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("dotgit-file:invalid")]);
      return encodeCanonicalLocal(keyBuf, asFileUrl);
    }
  } catch {}
  const directTarget = parseGitDirFileBytes(pathBuf, dirnamePosixBytes(lexicalPath));
  if (directTarget) {
    return encodeCanonicalLocal(withNestedCommonBytes(Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("direct-gitfile:")]), directTarget), asFileUrl);
  }
  const bareNested = nestedCommonKeyBytes(pathBuf);
  if (bareNested) {
    return encodeCanonicalLocal(Buffer.concat([lexicalPath, zeroByteBuf, Buffer.from("bare-common:"), bareNested]), asFileUrl);
  }
  return undefined;
}

function implicitDotGitPointerKeyBytes(baseKeyBuf: Buffer, dotGitLexical: Buffer, dotGitResolved: Buffer | undefined, asFileUrl: boolean): string | undefined {
  try {
    const info = lstatSync(dotGitLexical);
    if (info.isSymbolicLink()) {
      const targetBuf = dotGitResolved ?? Buffer.concat([Buffer.from("raw:"), readlinkSync(dotGitLexical, "buffer")]);
      const nested = dotGitResolved ? explicitPointerKeyBytes(dotGitResolved, dotGitLexical, asFileUrl) : undefined;
      return encodeCanonicalLocal(
        Buffer.concat([
          baseKeyBuf,
          zeroByteBuf,
          Buffer.from("implicit-dotgit-link:"),
          targetBuf,
          ...(nested ? [zeroByteBuf, Buffer.from(nested, "utf8")] : []),
        ]),
        asFileUrl,
      );
    }
  } catch {}
  if (dotGitResolved) {
    const nested = explicitPointerKeyBytes(dotGitResolved, dotGitLexical, asFileUrl);
    if (nested) {
      return encodeCanonicalLocal(Buffer.concat([baseKeyBuf, zeroByteBuf, Buffer.from("implicit-dotgit-ptr:"), Buffer.from(nested, "utf8")]), asFileUrl);
    }
  }
  return undefined;
}

function resolveGitIdentityBytes(pathBuf: Buffer, lexicalDir: Buffer, allowBundle: boolean): { identity: Buffer; isStandardChild: boolean } | undefined {
  const dotGit = Buffer.concat([pathBuf, slashDotGitBuf]);
  try {
    const linkInfo = lstatSync(dotGit);
    const resolvedDotGit = linkInfo.isSymbolicLink() ? resolvePosixPathBytes(pathBuf, dotGitBuf) : dotGit;
    if (resolvedDotGit) {
      const info = statSync(resolvedDotGit);
      if (info.isDirectory()) {
        const commonDir = resolvedCommonDirBytes(resolvedDotGit);
        if (commonDir) {
          const isStandardChild = !linkInfo.isSymbolicLink() && resolvedDotGit.equals(dotGit) && commonDir.equals(resolvedDotGit);
          const identity = isStandardChild
            ? pathBuf
            : commonDir.equals(resolvedDotGit)
              ? resolvedDotGit
              : Buffer.concat([resolvedDotGit, zeroByteBuf, commonDir]);
          return { identity, isStandardChild };
        }
      } else if (info.isFile()) {
        const target = parseGitDirFileBytes(resolvedDotGit, pathBuf);
        if (target) {
          const commonDir = resolvedCommonDirBytes(target);
          if (commonDir) {
            const identity = commonDir.equals(target) ? target : Buffer.concat([target, zeroByteBuf, commonDir]);
            return { identity, isStandardChild: false };
          }
        }
      }
    }
  } catch {}
  const directTarget = parseGitDirFileBytes(pathBuf, lexicalDir);
  if (directTarget) {
    const commonDir = resolvedCommonDirBytes(directTarget);
    if (commonDir) {
      const identity = commonDir.equals(directTarget) ? directTarget : Buffer.concat([directTarget, zeroByteBuf, commonDir]);
      return { identity, isStandardChild: false };
    }
  }
  if (allowBundle && isGitBundleFileBytes(pathBuf)) {
    return { identity: Buffer.concat([pathBuf, zeroByteBuf, Buffer.from("bundle")]), isStandardChild: false };
  }
  const bareCommon = resolvedCommonDirBytes(pathBuf);
  if (bareCommon) {
    const identity = bareCommon.equals(pathBuf)
      ? Buffer.concat([pathBuf, zeroByteBuf, Buffer.from("bare")])
      : Buffer.concat([pathBuf, zeroByteBuf, bareCommon]);
    return { identity, isStandardChild: false };
  }
  return undefined;
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

function expandTildeBytes(rawBytes: Buffer): Buffer | undefined {
  if (rawBytes[0] !== 0x7e) return rawBytes;
  const slash = rawBytes.indexOf(slashByte);
  const rest = slash === -1 ? Buffer.alloc(0) : rawBytes.subarray(slash);
  if (slash === 1 || rawBytes.length === 1) {
    const home = process.env.HOME;
    return home ? Buffer.concat([Buffer.from(home, "utf8"), rest]) : undefined;
  }
  const user = rawBytes.subarray(1, slash === -1 ? rawBytes.length : slash).toString("utf8");
  if (!user || user.includes(":")) return undefined;
  try {
    const passwd = readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] === user && fields[5]) return Buffer.concat([Buffer.from(fields[5], "utf8"), rest]);
    }
  } catch {}
  return undefined;
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

function parseLocalRepoBytes(
  dir: string,
  effective: string,
): { base: Buffer; rawPath: Buffer; asFileUrl: boolean; invalidTilde?: Buffer } | undefined {
  if (!effective) return undefined;
  if (process.platform === "win32") return undefined;
  const rawBytes = effective.startsWith("\0raw:") ? Buffer.from(effective.slice(5), "hex") : Buffer.from(effective, "utf8");
  const asciiHead = rawBytes.subarray(0, 7).toString("latin1");
  if (asciiHead === "file://") {
    const decoded = decodePercentBytes(rawBytes.subarray(7));
    const firstSlash = decoded.indexOf(slashByte);
    if (firstSlash === -1) return undefined;
    return { base: Buffer.from("/"), rawPath: decoded.subarray(firstSlash), asFileUrl: true };
  }
  const latin = rawBytes.toString("latin1");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(latin) || /^[^/\\]+:/.test(latin)) return undefined;
  const expanded = expandTildeBytes(rawBytes);
  if (!expanded) return { base: Buffer.from("/"), rawPath: Buffer.alloc(0), asFileUrl: false, invalidTilde: rawBytes };
  const base =
    expanded[0] === slashByte
      ? Buffer.from("/")
      : resolvePosixPathBytes(Buffer.from("/"), Buffer.from(resolve(dir), "utf8")) ?? Buffer.from(resolve(dir), "utf8");
  return { base, rawPath: expanded, asFileUrl: false };
}

type LocalRepoInfo = { resolved: string; primary: string; lexicalKey: string; aliasKey: string; pointerKey?: string; hasLiveRepo: boolean; isLocal: boolean; skipPinCache?: boolean };
type ResolvedIdentity = { digest: string; display: string; localInfo: LocalRepoInfo };

function canonicalLocalRepoInfo(dir: string, effective: string): LocalRepoInfo {
  if (process.platform === "win32") {
    if (effective.startsWith("\0raw:")) return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
    if (effective.startsWith("file://")) {
      try {
        const abs = resolve(fileURLToPath(effective));
        const out = pathToFileURL(existsSync(abs) ? realpathSync(abs) : abs).href;
        return { resolved: out, primary: out, lexicalKey: out, aliasKey: out, hasLiveRepo: existsSync(abs), isLocal: true };
      } catch {
        return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: true };
      }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(effective) || (!/^[a-z]:[\\/]/i.test(effective) && /^[^/\\]+:/.test(effective))) {
      return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
    }
    const abs = resolve(dir, effective);
    try {
      const out = realpathSync(abs);
      return { resolved: out, primary: out, lexicalKey: out, aliasKey: out, hasLiveRepo: true, isLocal: true };
    } catch {
      return { resolved: abs, primary: abs, lexicalKey: abs, aliasKey: abs, hasLiveRepo: false, isLocal: true };
    }
  }
  const parsed = parseLocalRepoBytes(dir, effective);
  if (!parsed) return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
  if (parsed.invalidTilde) {
    const invalid = decodeRepoBytes(Buffer.concat([Buffer.from("\0invalid-tilde:"), parsed.invalidTilde]));
    return { resolved: invalid, primary: invalid, lexicalKey: invalid, aliasKey: invalid, hasLiveRepo: false, isLocal: true, skipPinCache: true };
  }
  const { base, rawPath, asFileUrl } = parsed;
  const resolved = resolvePosixPathBytes(base, rawPath);
  const invalidPrimary = decodeRepoBytes(Buffer.concat([Buffer.from("\0invalid-local:"), base, zeroByteBuf, rawPath]));
  const primary = resolved ? encodeCanonicalLocal(resolved, asFileUrl) : invalidPrimary;
  const lexicalPrimary = resolved ? (resolvePosixPathBytes(base, rawPath, false) ?? resolved) : undefined;
  const lexicalKey = lexicalPrimary ? encodeCanonicalLocal(lexicalPrimary, asFileUrl) : invalidPrimary;
  const aliasKey =
    resolved && lexicalPrimary
      ? lexicalPrimary.equals(resolved)
        ? primary
        : encodeCanonicalLocal(Buffer.concat([lexicalPrimary, zeroByteBuf, resolved]), asFileUrl)
      : invalidPrimary;
  const pointerKey = resolved && lexicalPrimary ? explicitPointerKeyBytes(resolved, lexicalPrimary, asFileUrl) : undefined;
  const primaryGit = resolved && lexicalPrimary ? resolveGitIdentityBytes(resolved, dirnamePosixBytes(lexicalPrimary), true) : undefined;
  if (primaryGit) {
    return {
      resolved: primaryGit.isStandardChild ? primary : encodeCanonicalLocal(primaryGit.identity, asFileUrl),
      primary,
      lexicalKey,
      aliasKey,
      ...(pointerKey ? { pointerKey } : {}),
      hasLiveRepo: true,
      isLocal: true,
    };
  }
  const trimmedRaw = stripTrailingSlashBytes(rawPath);
  const dotGitRaw = Buffer.concat([trimmedRaw, dotGitBuf]);
  const dotGitResolved = resolvePosixPathBytes(base, dotGitRaw);
  const dotGitLexical = resolvePosixPathBytes(base, dotGitRaw, false) ?? dotGitResolved;
  const dotGitPointerKey = dotGitLexical
    ? implicitDotGitPointerKeyBytes(lexicalPrimary ?? dotGitLexical, dotGitLexical, dotGitResolved, asFileUrl)
    : undefined;
  const dotGitInfo = dotGitResolved && dotGitLexical ? resolveGitIdentityBytes(dotGitResolved, dirnamePosixBytes(dotGitLexical), false) : undefined;
  if (dotGitResolved && dotGitInfo) {
    return {
      resolved: dotGitInfo.isStandardChild ? encodeCanonicalLocal(dotGitResolved, asFileUrl) : encodeCanonicalLocal(dotGitInfo.identity, asFileUrl),
      primary,
      lexicalKey,
      aliasKey,
      ...(dotGitPointerKey ? { pointerKey: dotGitPointerKey } : {}),
      hasLiveRepo: true,
      isLocal: true,
    };
  }
  const effectivePointerKey = pointerKey ?? dotGitPointerKey;
  return { resolved: primary, primary, lexicalKey, aliasKey, ...(effectivePointerKey ? { pointerKey: effectivePointerKey } : {}), hasLiveRepo: false, isLocal: true };
}

type LocalAliasEntry = { aliasHash: string; targetHash: string };
type ClearAliasEntry = { aliasHash: string; keepRef?: string };

function localAliasPlan(localInfo: LocalRepoInfo | undefined, effectiveDigest: string): {
  localAliases?: LocalAliasEntry[];
  clearAliases?: ClearAliasEntry[];
} {
  if (!localInfo || !localInfo.isLocal || !localInfo.hasLiveRepo || repoDigest(localInfo.resolved) !== effectiveDigest) return {};
  const keys = [...new Set([localInfo.aliasKey, localInfo.lexicalKey, ...(localInfo.pointerKey ? [localInfo.pointerKey] : [])])];
  if (localInfo.resolved !== localInfo.primary || localInfo.lexicalKey !== localInfo.primary) {
    const aliasKeys = keys.filter((key) => key !== localInfo.resolved);
    return {
      localAliases: aliasKeys.map((key) => ({ aliasHash: repoDigest(key), targetHash: effectiveDigest })),
      clearAliases: aliasKeys.map((key) => {
        const aliasHash = repoDigest(key);
        return { aliasHash, keepRef: localAliasRef(aliasHash, effectiveDigest) };
      }),
    };
  }
  return { clearAliases: keys.map((key) => ({ aliasHash: repoDigest(key) })) };
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

async function resolveRepoIdentityAt(gitDir: string, dir: string, rawEffective: string): Promise<ResolvedIdentity> {
  const localInfo = canonicalLocalRepoInfo(dir, rawEffective);
  if (localInfo.isLocal && !localInfo.hasLiveRepo && !localInfo.skipPinCache) {
    const lookupKey = localInfo.pointerKey ?? localInfo.aliasKey;
    const aliased = await localAliasDigestAt(dir, gitDir, repoDigest(lookupKey));
    if (aliased) return { digest: aliased, display: localInfo.resolved, localInfo };
  }
  return { digest: repoDigest(localInfo.resolved), display: localInfo.resolved, localInfo };
}

async function resolvedRepoIdentity(dir: string, repo: string): Promise<ResolvedIdentity> {
  return resolveRepoIdentityAt(join(dir, ".git"), dir, await rawResolvedRepoUrl(dir, repo));
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
  const beforeIdentity = await resolveRepoIdentityAt(join(dir, ".git"), dir, rawEffectiveBefore);
  const effectiveBefore = beforeIdentity.display;
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
  const effectiveBeforeDigest = beforeIdentity.digest;
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
  const freshCache = !existsSync(join(dir, ".git"));
  let effectiveDigest = effectiveBeforeDigest;
  let effectiveLocalInfo: LocalRepoInfo | undefined = beforeIdentity.localInfo;
  let fetchError: string | undefined;
  let fetchedNew = false;
  let fetchedOid: string | undefined;
  let savedFetchHead: SavedFetchHead | undefined;
  let checkedOutCommit: string | undefined;
  const cachedHit = beforeIdentity.localInfo.skipPinCache
    ? undefined
    : await checkedOutFromCache(dir, repo, effectiveBeforeDigest, ref, good);
  if (cachedHit) {
    checkedOutCommit = cachedHit.commit;
    effectiveDigest = cachedHit.effectiveDigest;
  }
  if (!checkedOutCommit && !fetchError) {
    savedFetchHead = await snapshotFetchHead(dir);
    fetchedNew = true;
    const fetched = await checkout(dir, repo, ref.ref, savedFetchHead);
    effectiveDigest = fetched.effectiveDigest;
    effectiveLocalInfo = fetched.localInfo;
    fetchError = fetched.error;
    checkedOutCommit = fetched.commit;
    fetchedOid = fetched.fetchedOid;
  }
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
        if (freshCache) await discardFreshCache(dir);
        else if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
        return fallBack(ref, dir, repo, effectiveDigest, good, `${ref.ref} from ${ref.repo} changed checkout HEAD while loading`, loadLimitMs, before, preserveBefore, legacyOk && effectiveDigest === effectiveBeforeDigest, isBranch);
      }
      const { localAliases, clearAliases } = localAliasPlan(effectiveLocalInfo, effectiveDigest);
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
        localAliases,
        clearAliases,
      );
      if (!saveError) {
        return { ref, dir, packs: loaded.packs };
      }
      if (freshCache) await discardFreshCache(dir);
      else if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
      return fallBack(ref, dir, repo, effectiveDigest, good, `could not record ${ref.ref} from ${ref.repo}: ${saveError}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveDigest === effectiveBeforeDigest, isBranch);
    }
    const keepBranchFetchHead =
      isBranch === true &&
      good !== undefined &&
      good.repo === repo &&
      good.ref !== ref.ref &&
      effectiveDigest === effectiveBeforeDigest &&
      (goodDigest !== undefined ? goodDigest === effectiveDigest : legacyOk);
    if (freshCache) {
      await discardFreshCache(dir);
    } else if (savedFetchHead && !keepBranchFetchHead) {
      await restoreFetchHead(dir, savedFetchHead);
    }
    return fallBack(ref, dir, repo, effectiveDigest, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveDigest === effectiveBeforeDigest, isBranch);
  }
  if (savedFetchHead) await restoreFetchHead(dir, savedFetchHead);
  return fallBack(ref, dir, repo, effectiveDigest, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError ?? "unknown commit"}`, loadLimitMs, before, preserveBefore, legacyOk && effectiveDigest === effectiveBeforeDigest, undefined);
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

async function fallBack(ref: SourceRef, dir: string, repo: string, effectiveDigest: string, good: Good | undefined, reason: string, loadLimitMs: number, before?: CheckoutState, preserveBefore = false, legacyFallback = false, askedBranch?: boolean): Promise<FetchedSource> {
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
const localAliasPrefix = (aliasHash: string) => `refs/hedge/local-alias/${aliasHash}/`;
const localAliasRef = (aliasHash: string, targetHash: string) => `refs/hedge/local-alias/${aliasHash}/${targetHash}`;
const inlineHistoryPinLimit = 256;

async function localAliasDigestAt(dir: string, gitDir: string, aliasHash: string): Promise<string | undefined> {
  if (!existsSync(gitDir)) return undefined;
  const prefix = localAliasPrefix(aliasHash);
  const listed = await gitAt(dir, gitDir, "for-each-ref", "--format=%(refname)", prefix);
  if (!listed.ok || !listed.stdout) return undefined;
  const hashes = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
  return hashes.length === 1 ? hashes[0] : undefined;
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

type RefUndo = { ref: string; oldOid?: string };

async function recordPinRef(dir: string, repoHash: string, oid: string, undo?: RefUndo[]): Promise<string | undefined> {
  if ((await exactPinTarget(dir, repoHash, oid)) !== undefined) return undefined;
  const ref = pinRef(repoHash, oid);
  const updated = await git(dir, "update-ref", ref, oid.toLowerCase());
  if (!updated.ok) return updated.stderr || "could not record pinned commit";
  undo?.push({ ref });
  return undefined;
}

async function stagedCommitOids(dir: string, stageDir: string): Promise<Set<string> | undefined> {
  const listed = await gitAtEnv(
    dir,
    join(dir, ".git"),
    { GIT_OBJECT_DIRECTORY: stageDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objecttype) %(objectname)",
  );
  if (!listed.ok) return undefined;
  const commits = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      const oid = line.slice(7).trim().toLowerCase();
      if (gitHash.test(oid)) commits.add(oid);
    }
  }
  return commits;
}

function quoteGitAlternatePath(path: string): string {
  const sepChar = process.platform === "win32" ? ";" : ":";
  if (!path.includes(sepChar) && !path.startsWith("\"") && !/[\0-\x1f\x7f\\"]/.test(path)) return path;
  let out = "\"";
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x22) out += "\\\"";
    else if (byte === 0x07) out += "\\a";
    else if (byte === 0x08) out += "\\b";
    else if (byte === 0x0c) out += "\\f";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x0b) out += "\\v";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

async function moveFileAtomic(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
    const tmp = `${dst}.hedge-tmp-${crypto.randomUUID()}`;
    try {
      await copyFile(src, tmp);
      await rename(tmp, dst);
    } catch (copyError) {
      await rm(tmp, { force: true }).catch(() => {});
      throw copyError;
    }
    await rm(src, { force: true }).catch(() => {});
  }
}

async function migrateStagedObjects(stageDir: string, targetObjectsDir: string, moved: string[]): Promise<void> {
  const entries = await readdir(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcSub = join(stageDir, entry.name);
    const dstSub = join(targetObjectsDir, entry.name);
    if (entry.name === "pack") {
      const packFiles = (await readdir(srcSub)).sort((a, b) => {
        const rank = (name: string) => (name.endsWith(".pack") ? 0 : name.endsWith(".idx") ? 1 : 2);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      if (!packFiles.length) continue;
      await mkdir(dstSub, { recursive: true });
      for (const file of packFiles) {
        const dst = join(dstSub, file);
        if (existsSync(dst)) continue;
        await moveFileAtomic(join(srcSub, file), dst);
        moved.push(dst);
      }
      continue;
    }
    if (!/^[0-9a-f]{2}$/i.test(entry.name)) continue;
    const looseFiles = await readdir(srcSub);
    if (!looseFiles.length) continue;
    await mkdir(dstSub, { recursive: true });
    for (const file of looseFiles) {
      const dst = join(dstSub, file);
      if (existsSync(dst)) continue;
      await moveFileAtomic(join(srcSub, file), dst);
      moved.push(dst);
    }
  }
}

async function removeMigratedObjects(moved: string[]): Promise<void> {
  for (let i = moved.length - 1; i >= 0; i--) {
    await rm(moved[i]!, { force: true }).catch(() => {});
  }
}

async function recordHistoryRef(
  dir: string,
  repoHash: string,
  commit: string,
  from: string,
  undo?: RefUndo[],
  stagedCommits?: Set<string>,
): Promise<string | undefined> {
  const normalized = commit.toLowerCase();
  const listed = await git(dir, "rev-list", normalized, `^${from.toLowerCase()}`);
  if (!listed.ok) return listed.stderr || "could not list verified commit history";
  const rawCommits = listed.stdout
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => gitHash.test(line));
  const commits = stagedCommits
    ? rawCommits.filter((oid) => oid === normalized || stagedCommits.has(oid))
    : [normalized];
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
    if (undo) for (const item of toCreate) undo.push({ ref: item.ref });
    return undefined;
  }
  const anchorRef = historyAnchorRef(repoHash, commit, from);
  const existingAnchor = await git(dir, "rev-parse", "--verify", "--quiet", anchorRef);
  if (existingAnchor.ok && gitHash.test(existingAnchor.stdout)) return undefined;
  const anchorOid = await buildHistoryAnchor(dir, commits);
  if (!anchorOid) return "could not record verified commit history";
  const savedAnchor = await git(dir, "update-ref", anchorRef, anchorOid);
  if (!savedAnchor.ok) return savedAnchor.stderr || "could not record verified commit history";
  undo?.push({ ref: anchorRef });
  return undefined;
}

async function rollbackRefs(dir: string, undo: RefUndo[]): Promise<void> {
  if (!undo.length) return;
  const cmds = undo
    .map((entry) => (entry.oldOid ? `update ${entry.ref} ${entry.oldOid}\n` : `delete ${entry.ref}\n`))
    .join("");
  const batch = await gitWithStdin(dir, cmds, ["update-ref", "--stdin"]).catch(() => ({ ok: false }));
  if (batch.ok) return;
  for (const entry of undo) {
    if (entry.oldOid) await git(dir, "update-ref", entry.ref, entry.oldOid).catch(() => {});
    else await git(dir, "update-ref", "-d", entry.ref).catch(() => {});
  }
}

async function saveGood(
  dir: string,
  good: Good,
  historyFrom?: string,
  localAliases?: LocalAliasEntry[],
  clearAliases?: ClearAliasEntry[],
  stagedCommits?: Set<string>,
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
  const refUndo: RefUndo[] = [];
  if (currentCommit) {
    const recorded = await recordPinRef(dir, currentCommit.repoHash, currentCommit.commit, refUndo);
    if (recorded && !unchanged) {
      await rollbackRefs(dir, refUndo);
      return recorded;
    }
    for (const localAlias of localAliases ?? []) {
      const aliasRef = localAliasRef(localAlias.aliasHash, localAlias.targetHash);
      const existingAlias = await git(dir, "rev-parse", "--verify", "--quiet", aliasRef);
      const prevAliasOid = existingAlias.ok && gitHash.test(existingAlias.stdout) ? existingAlias.stdout.toLowerCase() : undefined;
      if (prevAliasOid !== currentCommit.commit) {
        const updatedAlias = await git(dir, "update-ref", aliasRef, currentCommit.commit);
        if (!updatedAlias.ok && !unchanged) {
          await rollbackRefs(dir, refUndo);
          return updatedAlias.stderr || "could not record local repository alias";
        }
        if (updatedAlias.ok) refUndo.push({ ref: aliasRef, ...(prevAliasOid ? { oldOid: prevAliasOid } : {}) });
      }
    }
    if (historyFrom && gitHash.test(historyFrom)) {
      const recordedFrom = await recordPinRef(dir, currentCommit.repoHash, historyFrom, refUndo);
      if (recordedFrom && !unchanged) {
        await rollbackRefs(dir, refUndo);
        return recordedFrom;
      }
      const recordedHistory = await recordHistoryRef(dir, currentCommit.repoHash, currentCommit.commit, historyFrom, refUndo, stagedCommits);
      if (recordedHistory && !unchanged) {
        await rollbackRefs(dir, refUndo);
        return recordedHistory;
      }
    }
    const strippedGoodRef = stripSourceRefspec(good.ref);
    if (good.peeled === true && isCommitPin(strippedGoodRef, currentCommit.commit.length) && (await git(dir, "cat-file", "-e", strippedGoodRef)).ok) {
      const recordedTag = await recordPinRef(dir, currentCommit.repoHash, strippedGoodRef, refUndo);
      if (recordedTag && !unchanged) {
        await rollbackRefs(dir, refUndo);
        return recordedTag;
      }
    }
  }
  const clearStaleAliases = async (): Promise<string | undefined> => {
    for (const entry of clearAliases ?? []) {
      const staleAliases = await git(dir, "for-each-ref", "--format=%(refname) %(objectname)", localAliasPrefix(entry.aliasHash));
      if (!staleAliases.ok) return staleAliases.stderr || "could not read local repository aliases";
      if (!staleAliases.stdout) continue;
      for (const line of staleAliases.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const space = trimmed.lastIndexOf(" ");
        if (space <= 0) continue;
        const ref = trimmed.slice(0, space);
        const oldOid = trimmed.slice(space + 1).toLowerCase();
        if (ref === entry.keepRef) continue;
        const deleted = await git(dir, "update-ref", "-d", ref);
        if (!deleted.ok) return deleted.stderr || "could not clear stale local repository alias";
        if (gitHash.test(oldOid)) refUndo.push({ ref, oldOid });
      }
    }
    return undefined;
  };
  const clearError = await clearStaleAliases();
  if (clearError) {
    await rollbackRefs(dir, refUndo);
    return clearError;
  }
  if (unchanged) {
    await chmod(goodPath(dir), 0o600).catch(() => {});
    return undefined;
  }
  try {
    await writeAtomic(goodPath(dir), JSON.stringify(good) + "\n");
  } catch (error) {
    await rollbackRefs(dir, refUndo);
    return error instanceof Error ? error.message : String(error);
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
      (goodDigest === undefined || (await resolvedRepoIdentity(dir, repo)).digest === goodDigest);
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

async function checkedOutFromCache(
  dir: string,
  repo: string,
  effectiveDigest: string,
  ref: SourceRef,
  good: Good | undefined,
): Promise<{ commit: string; effectiveDigest: string } | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const oid = stripSourceRefspec(ref.ref).toLowerCase();
  if (!gitHash.test(oid)) return undefined;
  const hashLen = await repoHashLength(dir);
  if (!isCommitPin(oid, hashLen)) return undefined;
  const goodDigest = goodResolvedDigest(good);
  const goodCommit = verifiedGoodCommit(good);
  const verifiedGoodMatch =
    goodCommit !== undefined &&
    good?.repo === repo &&
    goodDigest !== undefined &&
    goodDigest === effectiveDigest &&
    (goodCommit.commit === oid || (good.peeled === true && stripSourceRefspec(good.ref).toLowerCase() === oid));
  const target = verifiedGoodMatch ? goodCommit.commit : await pinTarget(dir, effectiveDigest, oid);
  if (!target) return undefined;
  return (await git(dir, "checkout", "-q", "--detach", `${target}^{commit}`)).ok
    ? { commit: target, effectiveDigest }
    : undefined;
}

type SavedFetchHead = { kind: "content"; bytes: Buffer; mode: number } | { kind: "missing" } | { kind: "unreadable" };

async function snapshotGitFileAt(gitDir: string, name: string): Promise<SavedFetchHead> {
  const path = join(gitDir, name);
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    return { kind: "content", bytes, mode: info.mode & 0o777 };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

async function snapshotFetchHeadAt(gitDir: string): Promise<SavedFetchHead> {
  return snapshotGitFileAt(gitDir, "FETCH_HEAD");
}

async function snapshotFetchHead(dir: string): Promise<SavedFetchHead> {
  return snapshotFetchHeadAt(join(dir, ".git"));
}

async function restoreGitFileAt(gitDir: string, name: string, saved: SavedFetchHead) {
  const path = join(gitDir, name);
  if (saved.kind === "content") {
    const current = await readFile(path).catch(() => undefined);
    if (current && current.equals(saved.bytes)) return;
    await writeAtomic(path, saved.bytes, saved.mode).catch(() => {});
  } else if (saved.kind === "missing") {
    await rm(path, { force: true }).catch(() => {});
  }
}

async function restoreFetchHeadAt(gitDir: string, saved: SavedFetchHead) {
  return restoreGitFileAt(gitDir, "FETCH_HEAD", saved);
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

async function fetchExactAt(
  dir: string,
  gitDir: string,
  repo: string,
  ref: string,
  shallow: boolean,
  extraEnv?: Record<string, string>,
  noRefmap = false,
): Promise<{ ok: boolean; oid?: string; stderr: string; fullStderr?: string }> {
  const configArgs = noRefmap ? ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.writeCommitGraph=false"] : [];
  const refmapArgs = noRefmap ? ["--refmap=", "--no-prune"] : [];
  const args = [...configArgs, "fetch", "--porcelain", ...(shallow ? ["--depth", "1"] : []), "--no-tags", ...refmapArgs, repo, ref];
  const fetched = await gitAtEnv(dir, gitDir, extraEnv, ...args);
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
    const fallbackArgs = [...configArgs, "fetch", "-q", ...(shallow ? ["--depth", "1"] : []), "--no-tags", ...refmapArgs, repo, `+${src}:${tmpRef}`];
    const fallback = await gitAtEnv(dir, gitDir, extraEnv, ...fallbackArgs);
    if (!fallback.ok) return { ok: false, stderr: fallback.stderr, fullStderr: fallback.fullStderr };
    const resolved = await gitAtEnv(dir, gitDir, extraEnv, "rev-parse", "--verify", "--quiet", tmpRef);
    return resolved.ok && gitHash.test(resolved.stdout) ? { ok: true, oid: resolved.stdout.toLowerCase(), stderr: "" } : { ok: false, stderr: resolved.stderr || "could not resolve fetched commit", fullStderr: resolved.fullStderr };
  } finally {
    await gitAtEnv(dir, gitDir, extraEnv, "update-ref", "-d", tmpRef).catch(() => {});
  }
}

async function fetchExact(dir: string, repo: string, ref: string, shallow: boolean, extraEnv?: Record<string, string>, noRefmap = false) {
  return fetchExactAt(dir, join(dir, ".git"), repo, ref, shallow, extraEnv, noRefmap);
}

async function discardFreshCache(dir: string) {
  const gitDir = join(dir, ".git");
  if (existsSync(gitDir)) {
    await git(dir, "--git-dir", gitDir, "--work-tree", dir, "rm", "-rfq", "--ignore-unmatch", ".").catch(() => {});
    await rm(gitDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkout(
  dir: string,
  repo: string,
  ref: string,
  savedFetchHead: SavedFetchHead,
): Promise<{ effectiveDigest: string; localInfo: LocalRepoInfo; commit?: string; fetchedOid?: string; error?: string }> {
  const beforeIdentity = await resolvedRepoIdentity(dir, repo);
  if (isInvalidRef(ref)) return { effectiveDigest: beforeIdentity.digest, localInfo: beforeIdentity.localInfo, error: `invalid ref ${JSON.stringify(ref)}` };
  await mkdir(dir, { recursive: true });
  const freshInit = !existsSync(join(dir, ".git"));
  if (freshInit) await git(dir, "init", "-q");
  const identity = await resolvedRepoIdentity(dir, repo);
  const effectiveDigest = identity.digest;
  let fetched = await fetchExact(dir, repo, ref, true);
  if (!fetched.ok && freshInit) {
    const strippedRef = stripSourceRefspec(ref);
    const stderrText = `${fetched.fullStderr ?? ""}\n${fetched.stderr}`;
    if (isCommitPin(strippedRef, 64) || /object format|sha256|mismatched algorithms/i.test(stderrText)) {
      await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
      const reinit = await git(dir, "init", "-q", "--object-format=sha256");
      if (reinit.ok) fetched = await fetchExact(dir, repo, ref, true);
    }
  }
  if (!fetched.ok || !fetched.oid) {
    if (freshInit) await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
    else await restoreFetchHead(dir, savedFetchHead);
    return { effectiveDigest, localInfo: identity.localInfo, error: fetched.stderr || "could not fetch commit" };
  }
  const afterIdentity = await resolvedRepoIdentity(dir, repo);
  if (afterIdentity.digest !== effectiveDigest) {
    if (freshInit) await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
    else await restoreFetchHead(dir, savedFetchHead);
    return { effectiveDigest, localInfo: identity.localInfo, error: "git remote rewrite rule changed during fetch" };
  }
  const peeled = await git(dir, "rev-parse", "--verify", "--quiet", `${fetched.oid}^{commit}`);
  if (!peeled.ok || !gitHash.test(peeled.stdout)) {
    if (freshInit) await rm(join(dir, ".git"), { recursive: true, force: true }).catch(() => {});
    else await restoreFetchHead(dir, savedFetchHead);
    return { effectiveDigest, localInfo: afterIdentity.localInfo, error: peeled.stderr || "could not resolve fetched commit" };
  }
  const targetCommit = peeled.stdout.toLowerCase();
  const moved = await git(dir, "checkout", "-q", "--detach", `${targetCommit}^{commit}`);
  if (!moved.ok) {
    if (freshInit) await discardFreshCache(dir);
    return { effectiveDigest, localInfo: afterIdentity.localInfo, error: moved.stderr };
  }
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ok || head.stdout.toLowerCase() !== targetCommit) {
    if (freshInit) await discardFreshCache(dir);
    return { effectiveDigest, localInfo: afterIdentity.localInfo, error: head.stderr || "could not resolve checked-out HEAD" };
  }
  return { effectiveDigest, localInfo: afterIdentity.localInfo, commit: targetCommit, fetchedOid: fetched.oid };
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

async function gitAtEnv(dir: string, gitDir: string, extraEnv: Record<string, string> | undefined, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, "--git-dir", gitDir, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: extraEnv ? { ...gitEnv(), ...extraEnv } : gitEnv(),
    timeout: fetchTimeoutMs,
  });
  const [code, rawBytes, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const bytes = new Uint8Array(rawBytes);
  const rawStdout = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const message = proc.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, code, stdout: rawStdout.trim(), rawStdout, rawBytes: bytes, stderr: message, fullStderr: stderr };
}

async function gitAt(dir: string, gitDir: string, ...args: string[]) {
  return gitAtEnv(dir, gitDir, undefined, ...args);
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
  const stripped = stripSourceRefspec(ref);
  if (stripped.startsWith("refs/heads/")) return stripped.slice("refs/heads/".length) || undefined;
  return stripped || undefined;
};

const hasExplicitHead = (ref: unknown) => typeof ref === "string" && stripSourceRefspec(ref).startsWith("refs/heads/");
const isOtherQualifiedRef = (ref: unknown) => {
  if (typeof ref !== "string") return false;
  const stripped = stripSourceRefspec(ref);
  return stripped.startsWith("refs/") && !stripped.startsWith("refs/heads/");
};
const isNonBranchNamespace = (ref: unknown) => {
  if (typeof ref !== "string") return false;
  const stripped = stripSourceRefspec(ref);
  return /^refs\/(?:tags|remotes|notes|replace|bisect)\//.test(stripped) || stripped === "refs/stash";
};
const hasRefspecDecor = (ref: unknown) => typeof ref === "string" && (ref.startsWith("+") || ref.endsWith(":"));

const sameBranchRef = (a: unknown, b: unknown, hashLen?: number): boolean => {
  const nameA = branchName(a);
  const nameB = branchName(b);
  if (!nameA || nameA !== nameB) return false;
  if (isNonBranchNamespace(a) !== isNonBranchNamespace(b)) return false;
  const fullHash = hashLen !== undefined ? isCommitPin(nameA, hashLen) : gitHash.test(nameA);
  if (!fullHash) return true;
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
  const hashLen = good.commit.length;
  let isBranch: boolean;
  let matchedExplicitHead = false;
  if (sameBranchRef(good.asked, ref.ref, hashLen)) {
    matchedExplicitHead = hasExplicitHead(good.asked);
    if (good.askedBranch === true) isBranch = true;
    else if (good.askedBranch === false) return false;
    else if (sameBranchRef(good.ref, ref.ref, hashLen) && typeof good.branch === "boolean") isBranch = good.branch;
    else isBranch = (await fetchHeadIsBranch(dir, ref.ref)) === true;
  } else if (sameBranchRef(good.ref, ref.ref, hashLen)) {
    matchedExplicitHead = hasExplicitHead(good.ref);
    if (good.branch === true) isBranch = true;
    else if (good.branch === false) return false;
    else isBranch = (await fetchHeadIsBranch(dir, ref.ref)) === true;
  } else {
    return false;
  }
  if (!isBranch) return false;
  if (isCommitPin(branch, hashLen) && matchedExplicitHead && !hasExplicitHead(ref.ref) && existsSync(join(dir, ".git"))) {
    const goodDigest = goodResolvedDigest(good);
    const effectiveDigest = (await resolvedRepoIdentity(dir, repo)).digest;
    const sameRepo = good.repo === repo && (goodDigest === undefined || goodDigest === effectiveDigest);
    const matchesVerifiedGood = sameRepo && verifiedGoodCommit(good)?.commit === branch.toLowerCase();
    if (matchesVerifiedGood || (await pinTarget(dir, effectiveDigest, branch)) !== undefined) return false;
  }
  const hasPlusPrefix = (value: unknown) => typeof value === "string" && value.startsWith("+");
  const needsRepoCheck =
    hasPlusPrefix(ref.ref) ||
    hasPlusPrefix(good.ref) ||
    hasPlusPrefix(good.asked) ||
    (Array.isArray(good.blocked) && good.blocked.length > 0);
  if (!needsRepoCheck) return true;
  const goodDigest = goodResolvedDigest(good);
  const effectiveDigest = (await resolvedRepoIdentity(dir, repo)).digest;
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
  const identity = await resolveRepoIdentityAt(join(dir, ".git"), dir, rawEffectiveRepo);
  const effectiveRepo = identity.display;
  const effectiveDigest = identity.digest;
  const strippedRef = stripSourceRefspec(ref.ref);
  const otherQualified = isOtherQualifiedRef(ref.ref);
  const listed = otherQualified
    ? await git(dir, "ls-remote", repo, head, strippedRef)
    : await git(dir, "ls-remote", repo, head);
  if (!listed.ok) return { state: "failed", say: `could not reach ${ref.repo}: ${listed.stderr}` };
  const legacyRepoMismatch =
    cachedGood !== undefined &&
    cachedDigest === undefined &&
    hasGoodCommit(cachedGood) &&
    !(await legacyFallbackMatches(dir, cachedGood, rawEffectiveRepo, effectiveRepo));
  if (cachedGood && (cachedGood.repo !== repo || (cachedDigest !== undefined ? cachedDigest !== effectiveDigest : legacyRepoMismatch))) {
    return { state: "refused", say: `${ref.name} now points to ${ref.repo}, not the repository Hedge loaded last. Run hedge apply.` };
  }
  const askedBranchActive =
    cachedGood !== undefined &&
    hasGoodCommit(cachedGood) &&
    sameBranchRef(cachedGood.asked, ref.ref, cachedGood.commit.length) &&
    (cachedGood.askedBranch === true || (cachedGood.askedBranch !== false && (await fetchHeadIsBranch(dir, ref.ref)) === true));
  if (
    cachedGood &&
    (!hasGoodCommit(cachedGood) ||
      cachedGood.commit.toLowerCase() !== from.toLowerCase() ||
      (cachedGood.branch === false && !askedBranchActive))
  ) {
    return { state: "busy" };
  }
  const listedEntries = listed.stdout.split("\n").map((line) => line.split("\t"));
  if (otherQualified && listedEntries.some(([, name]) => name === strippedRef)) {
    return { state: "failed", say: `${ref.ref} in ${ref.repo} is not a branch` };
  }
  if (otherQualified && cachedGood && hasGoodCommit(cachedGood) && !sameBranchRef(cachedGood.ref, ref.ref, cachedGood.commit.length) && !askedBranchActive) {
    return { state: "failed", say: `${ref.ref} in ${ref.repo} does not match cached branch ${cachedGood.ref}` };
  }
  const verifiedHistoryFrom = cachedGood !== undefined ? from : undefined;
  const commit = listedEntries.find(([, name]) => name === head)?.[0];
  if (!commit) return { state: "failed", say: `${ref.repo} has no branch ${branch}` };
  if (commit === from) return { state: "same", commit };
  const rewritten = (tip: string) => ({ state: "refused" as const, say: `${branch} of ${ref.repo} moved to ${tip.slice(0, 12)}, which does not build on ${from.slice(0, 12)}, the commit Hedge loaded last. Hedge refresh runs no pack code from a rewritten branch. Run hedge update to take it.` });
  const edits = await localEdits(dir);
  if (edits.length) return { state: "edited", say: `${ref.name} moved, but Hedge ${editsReason(ref, dir, edits)}.` };
  const gitDir = join(dir, ".git");
  const mainObjectsDir = join(gitDir, "objects");
  let targetObjectsDir = mainObjectsDir;
  try {
    targetObjectsDir = realpathSync(mainObjectsDir);
  } catch {}
  const savedFetchHead = await snapshotFetchHead(dir);
  const savedShallow = await snapshotGitFileAt(gitDir, "shallow");
  const savedHeadLog = await snapshotGitFileAt(gitDir, join("logs", "HEAD"));
  let stageDir: string;
  try {
    const stageParent = existsSync(targetObjectsDir) ? targetObjectsDir : gitDir;
    stageDir = await mkdtemp(join(stageParent, "hedge-stage-"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "failed", say: `could not stage refresh for ${ref.name}: ${message}` };
  }
  const stageEnv = { GIT_OBJECT_DIRECTORY: stageDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteGitAlternatePath(targetObjectsDir) };
  let movedObjects: string[] = [];
  const restoreRefreshState = async (removeObjects = true) => {
    await restoreFetchHead(dir, savedFetchHead);
    await restoreGitFileAt(gitDir, "shallow", savedShallow);
    if (removeObjects) {
      await restoreGitFileAt(gitDir, join("logs", "HEAD"), savedHeadLog);
      if (movedObjects.length) {
        await removeMigratedObjects(movedObjects);
        movedObjects = [];
      }
    }
  };
  try {
    const fetched = await fetchExact(dir, repo, head, false, stageEnv, true);
    if (!fetched.ok || !fetched.oid) {
      await restoreRefreshState();
      return { state: "failed", say: `could not fetch ${branch} from ${ref.repo}: ${fetched.stderr}` };
    }
    const afterRefreshIdentity = await resolvedRepoIdentity(dir, repo);
    if (afterRefreshIdentity.digest !== effectiveDigest) {
      await restoreRefreshState();
      return { state: "failed", say: `git remote rewrite rule changed while refreshing ${ref.repo}` };
    }
    const peeledTip = await gitAtEnv(dir, gitDir, stageEnv, "rev-parse", "--verify", "--quiet", `${fetched.oid}^{commit}`);
    if (!peeledTip.ok || !gitHash.test(peeledTip.stdout)) {
      await restoreRefreshState();
      return { state: "failed", say: `could not resolve ${branch} from ${ref.repo}` };
    }
    const tip = peeledTip.stdout.toLowerCase();
    if (!(await gitAtEnv(dir, gitDir, stageEnv, "merge-base", "--is-ancestor", from, tip)).ok) {
      await restoreRefreshState();
      return rewritten(tip);
    }
    const stagedCommits = await stagedCommitOids(dir, stageDir);
    try {
      await migrateStagedObjects(stageDir, targetObjectsDir, movedObjects);
    } catch (error) {
      await restoreRefreshState();
      const message = error instanceof Error ? error.message : String(error);
      return { state: "failed", say: `could not store fetched objects for ${ref.name}: ${message}` };
    }
    const before = await currentCheckout(dir);
    const rollbackCheckout = async (): Promise<boolean> => {
      if (before) return restoreCheckout(dir, before);
      const ok = (await git(dir, "checkout", "-q", "--detach", `${from}^{commit}`)).ok;
      if (ok) clearLoadedModules(dir);
      return ok;
    };
    const moved = await git(dir, "checkout", "-q", "--detach", `${tip}^{commit}`);
    if (!moved.ok) {
      const restored = await rollbackCheckout();
      await restoreRefreshState(restored);
      return { state: "failed", say: `could not check out ${tip.slice(0, 12)} of ${ref.name}: ${moved.stderr}` };
    }
    const loaded = await load(dir, loadLimitMs);
    if ("error" in loaded) {
      const restored = await rollbackCheckout();
      await restoreRefreshState(restored);
      return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} does not load: ${loaded.error}` };
    }
    const postLoadHead = (await git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).stdout;
    if (!postLoadHead || postLoadHead.toLowerCase() !== tip.toLowerCase()) {
      const restored = await rollbackCheckout();
      await restoreRefreshState(restored);
      return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} changed checkout HEAD while loading` };
    }
    const { localAliases: refreshAliases, clearAliases: clearRefreshAliases } = localAliasPlan(afterRefreshIdentity.localInfo, effectiveDigest);
    const saveError = await saveGood(dir, { repo, ref: ref.ref, commit: tip, branch: true, resolvedDigest: effectiveDigest }, verifiedHistoryFrom, refreshAliases, clearRefreshAliases, stagedCommits);
    if (saveError) {
      const restored = await rollbackCheckout();
      await restoreRefreshState(restored);
      return { state: "failed", say: `could not record ${branch} of ${ref.repo} at ${tip.slice(0, 12)}: ${saveError}` };
    }
    return { state: "moved", commit: tip, source: { ref, dir, packs: loaded.packs } };
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
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
