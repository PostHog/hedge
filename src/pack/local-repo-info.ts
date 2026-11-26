import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bunScript } from "../runner/bun.ts";

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeRepoBytes(bytes: Uint8Array): string {
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

const localProbeTimeoutMs = 3_000;
const localRepoInfoScript = join(import.meta.dir, "local-repo-info.ts");

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

function lexicalPosixPathBytes(base: Buffer, rawPath: Buffer): Buffer | undefined {
  const rawSegs = splitPosixBytes(rawPath);
  if (rawSegs.some((seg) => seg.equals(dotDotBuf))) return undefined;
  const stack: Buffer[] = [];
  if (rawPath[0] !== slashByte) {
    for (const part of splitPosixBytes(base)) {
      if (part.equals(dotDotBuf)) return undefined;
      if (part.length > 0 && !part.equals(dotBuf)) stack.push(part);
    }
  }
  for (const seg of rawSegs) {
    if (seg.length === 0 || seg.equals(dotBuf)) continue;
    stack.push(seg);
  }
  return joinPosixBytes(stack);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

type AccessState = { inaccessible: boolean };

function recordAccessError(error: unknown, access?: AccessState): void {
  if (access && !isMissingPathError(error)) access.inaccessible = true;
}

function resolvePosixPathBytes(base: Buffer, rawPath: Buffer, followLast = true, access?: AccessState): Buffer | undefined {
  const queue = splitPosixBytes(rawPath);
  const trailingSlash = rawPath.length > 1 && rawPath[rawPath.length - 1] === slashByte;
  let requireDir = false;
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
        } catch (error) {
          if (!isMissingPathError(error)) {
            recordAccessError(error, access);
            return undefined;
          }
        }
      }
      continue;
    }
    if (seg.equals(dotDotBuf)) {
      if (stack.length > 0) {
        if (!isDirectoryBytes(joinPosixBytes(stack), access)) return undefined;
        stack.pop();
      }
      continue;
    }
    const candidate = joinPosixBytes([...stack, seg]);
    if (followLast || index < queue.length || trailingSlash) {
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink()) {
          if (hops >= 40) {
            if (access) access.inaccessible = true;
            return undefined;
          }
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
      } catch (error) {
        if (!isMissingPathError(error)) {
          recordAccessError(error, access);
          return undefined;
        }
      }
    }
    stack.push(seg);
  }
  const out = joinPosixBytes(stack);
  if (requireDir) {
    try {
      if (!statSync(out).isDirectory()) return undefined;
    } catch (error) {
      if (!isMissingPathError(error)) {
        recordAccessError(error, access);
        return undefined;
      }
    }
  }
  return out;
}

function isDirectoryBytes(pathBuf: Buffer, access?: AccessState): boolean {
  try {
    return statSync(pathBuf).isDirectory();
  } catch (error) {
    recordAccessError(error, access);
    return false;
  }
}

function dirnamePosixBytes(buf: Buffer): Buffer {
  const last = buf.lastIndexOf(slashByte);
  return last <= 0 ? slashBuf : buf.subarray(0, last);
}

function parseGitDirFileBytes(fileBuf: Buffer, baseDir: Buffer, access?: AccessState): Buffer | undefined {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile() || info.size < gitdirPrefixBuf.length) return undefined;
    fd = openSync(fileBuf, "r");
    const header = Buffer.allocUnsafe(gitdirPrefixBuf.length);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(gitdirPrefixBuf)) return undefined;
    if (info.size > 8192) {
      if (access) access.inaccessible = true;
      return undefined;
    }
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
  } catch (error) {
    recordAccessError(error, access);
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function isGitBundleFileBytes(fileBuf: Buffer, access?: AccessState): boolean {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile() || info.size < bundleV2Buf.length) return false;
    fd = openSync(fileBuf, "r");
    const header = Buffer.allocUnsafe(bundleV2Buf.length);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    return header.equals(bundleV2Buf) || header.equals(bundleV3Buf);
  } catch (error) {
    recordAccessError(error, access);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function readBoundedPrefixBytes(fileBuf: Buffer, maxBytes: number, rejectOversized = false, access?: AccessState): Buffer | undefined {
  let fd: number | undefined;
  try {
    const info = statSync(fileBuf);
    if (!info.isFile()) return undefined;
    if (rejectOversized && info.size > maxBytes) {
      if (access) access.inaccessible = true;
      return undefined;
    }
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
  } catch (error) {
    recordAccessError(error, access);
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
  return /^[0-9a-f]{40}/i.test(text);
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

function isValidHeadFileBytes(headPath: Buffer, access?: AccessState): boolean {
  try {
    const info = lstatSync(headPath);
    if (info.isSymbolicLink()) {
      const target = readlinkSync(headPath, "buffer").toString("latin1");
      return target.startsWith("refs/");
    }
  } catch (error) {
    recordAccessError(error, access);
    return false;
  }
  const headBytes = readBoundedPrefixBytes(headPath, 256, false, access);
  return headBytes !== undefined && isValidHeadBytes(headBytes);
}

function resolvedCommonDirBytes(dirBuf: Buffer, access?: AccessState): Buffer | undefined {
  try {
    if (!statSync(dirBuf).isDirectory()) return undefined;
    if (!isValidHeadFileBytes(Buffer.concat([dirBuf, slashHeadBuf]), access)) return undefined;
    let commonDir = dirBuf;
    const commonPath = Buffer.concat([dirBuf, slashCommondirBuf]);
    let hasCommonFile = false;
    try {
      hasCommonFile = statSync(commonPath).isFile();
    } catch (error) {
      recordAccessError(error, access);
    }
    if (hasCommonFile) {
      const rawCommon = readBoundedPrefixBytes(commonPath, 8192, true, access);
      if (!rawCommon) return undefined;
      let end = rawCommon.length;
      while (end > 0 && (rawCommon[end - 1] === 0x0a || rawCommon[end - 1] === 0x0d)) end--;
      if (end > 0) {
        const resolvedCommon = resolvePosixPathBytes(dirBuf, rawCommon.subarray(0, end));
        if (!resolvedCommon) return undefined;
        commonDir = resolvedCommon;
      }
    }
    if (!isDirectoryBytes(Buffer.concat([commonDir, slashObjectsBuf]), access)) return undefined;
    if (!isDirectoryBytes(Buffer.concat([commonDir, slashRefsBuf]), access) && !isDirectoryBytes(Buffer.concat([commonDir, slashReftableBuf]), access)) return undefined;
    return commonDir;
  } catch (error) {
    recordAccessError(error, access);
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

function resolveGitIdentityBytes(pathBuf: Buffer, lexicalDir: Buffer, allowBundle: boolean, access?: AccessState): { identity: Buffer; isStandardChild: boolean } | undefined {
  const dotGit = Buffer.concat([pathBuf, slashDotGitBuf]);
  try {
    const linkInfo = lstatSync(dotGit);
    const resolvedDotGit = linkInfo.isSymbolicLink() ? resolvePosixPathBytes(pathBuf, dotGitBuf) : dotGit;
    if (resolvedDotGit) {
      const info = statSync(resolvedDotGit);
      if (info.isDirectory()) {
        const commonDir = resolvedCommonDirBytes(resolvedDotGit, access);
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
        const target = parseGitDirFileBytes(resolvedDotGit, pathBuf, access);
        if (target) {
          const commonDir = resolvedCommonDirBytes(target, access);
          if (commonDir) {
            const identity = commonDir.equals(target) ? target : Buffer.concat([target, zeroByteBuf, commonDir]);
            return { identity, isStandardChild: false };
          }
        }
      }
    }
  } catch (error) {
    recordAccessError(error, access);
  }
  const directTarget = parseGitDirFileBytes(pathBuf, lexicalDir, access);
  if (directTarget) {
    const commonDir = resolvedCommonDirBytes(directTarget, access);
    if (commonDir) {
      const identity = commonDir.equals(directTarget) ? directTarget : Buffer.concat([directTarget, zeroByteBuf, commonDir]);
      return { identity, isStandardChild: false };
    }
  }
  if (allowBundle && isGitBundleFileBytes(pathBuf, access)) {
    return { identity: Buffer.concat([pathBuf, zeroByteBuf, Buffer.from("bundle")]), isStandardChild: false };
  }
  const bareCommon = resolvedCommonDirBytes(pathBuf, access);
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

function expandTildeBytes(rawBytes: Buffer, allowPasswd = true): Buffer | undefined {
  if (rawBytes[0] !== 0x7e) return rawBytes;
  const slash = rawBytes.indexOf(slashByte);
  const rest = slash === -1 ? Buffer.alloc(0) : rawBytes.subarray(slash);
  if (slash === 1 || rawBytes.length === 1) {
    const home = process.env.HOME;
    return home ? Buffer.concat([Buffer.from(home, "utf8"), rest]) : undefined;
  }
  if (!allowPasswd) return undefined;
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
  allowFs = true,
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
  const expanded = expandTildeBytes(rawBytes, allowFs);
  if (!expanded) return { base: Buffer.from("/"), rawPath: Buffer.alloc(0), asFileUrl: false, invalidTilde: rawBytes };
  const base =
    expanded[0] === slashByte
      ? Buffer.from("/")
      : allowFs
        ? resolvePosixPathBytes(Buffer.from("/"), Buffer.from(resolve(dir), "utf8")) ?? Buffer.from(resolve(dir), "utf8")
        : Buffer.from(resolve(dir), "utf8");
  return { base, rawPath: expanded, asFileUrl: false };
}

export type LocalRepoInfo = {
  resolved: string;
  primary: string;
  lexicalKey: string;
  configuredKey?: string;
  aliasKey: string;
  pointerKey?: string;
  hasLiveRepo: boolean;
  isLocal: boolean;
  skipPinCache?: boolean;
  timedOut?: boolean;
};

export function isLocalRepoSpec(effective: string): boolean {
  if (!effective) return false;
  if (process.platform === "win32") {
    if (effective.startsWith("\0raw:")) return false;
    if (effective.startsWith("file://")) return true;
    return !/^[a-z][a-z0-9+.-]*:\/\//i.test(effective) && (/^[a-z]:[\\/]/i.test(effective) || !/^[^/\\]+:/.test(effective));
  }
  const rawBytes = effective.startsWith("\0raw:") ? Buffer.from(effective.slice(5), "hex") : Buffer.from(effective, "utf8");
  if (rawBytes.subarray(0, 7).toString("latin1") === "file://") {
    return decodePercentBytes(rawBytes.subarray(7)).indexOf(slashByte) !== -1;
  }
  const latin = rawBytes.toString("latin1");
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(latin) && !/^[^/\\]+:/.test(latin);
}

export function lexicalFallbackLocalRepoInfo(dir: string, effective: string, timedOut: boolean): LocalRepoInfo {
  if (!isLocalRepoSpec(effective)) {
    return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
  }
  if (process.platform === "win32") {
    if (effective.startsWith("file://")) {
      try {
        const out = pathToFileURL(resolve(fileURLToPath(effective))).href;
        return { resolved: out, primary: out, lexicalKey: out, aliasKey: out, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
      } catch {
        return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
      }
    }
    const abs = resolve(dir, effective);
    return { resolved: abs, primary: abs, lexicalKey: abs, aliasKey: abs, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
  }
  const parsed = parseLocalRepoBytes(dir, effective, false);
  if (!parsed) {
    return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
  }
  if (parsed.invalidTilde) {
    const invalid = decodeRepoBytes(Buffer.concat([Buffer.from("\0invalid-tilde:"), parsed.invalidTilde]));
    return { resolved: invalid, primary: invalid, lexicalKey: invalid, aliasKey: invalid, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
  }
  const lexical = lexicalPosixPathBytes(parsed.base, parsed.rawPath);
  if (!lexical) {
    const invalidPrimary = decodeRepoBytes(Buffer.concat([Buffer.from(parsed.asFileUrl ? "\0invalid-file:" : "\0invalid-local:"), parsed.base, zeroByteBuf, parsed.rawPath]));
    return { resolved: invalidPrimary, primary: invalidPrimary, lexicalKey: invalidPrimary, aliasKey: invalidPrimary, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
  }
  const encoded = encodeCanonicalLocal(lexical, parsed.asFileUrl);
  return { resolved: encoded, primary: encoded, lexicalKey: encoded, aliasKey: encoded, hasLiveRepo: false, isLocal: true, skipPinCache: true, ...(timedOut ? { timedOut: true } : {}) };
}

export function canonicalLocalRepoInfo(dir: string, effective: string): LocalRepoInfo {
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
  const hasTrailingSlash = rawPath.length > 1 && rawPath[rawPath.length - 1] === slashByte;
  const primaryAccess: AccessState = { inaccessible: false };
  const resolved = resolvePosixPathBytes(base, rawPath, true, primaryAccess);
  const invalidPrimary = decodeRepoBytes(Buffer.concat([Buffer.from(asFileUrl ? "\0invalid-file:" : "\0invalid-local:"), base, zeroByteBuf, rawPath]));
  const primary = resolved ? encodeCanonicalLocal(resolved, asFileUrl) : invalidPrimary;
  const lexicalPrimary = resolved ? (resolvePosixPathBytes(base, rawPath, false) ?? resolved) : undefined;
  const lexicalKey = lexicalPrimary ? encodeCanonicalLocal(lexicalPrimary, asFileUrl) : invalidPrimary;
  const configuredPrimary = resolved ? lexicalPosixPathBytes(base, rawPath) : undefined;
  const configuredKey = configuredPrimary ? encodeCanonicalLocal(configuredPrimary, asFileUrl) : undefined;
  const aliasKey =
    resolved && lexicalPrimary
      ? lexicalPrimary.equals(resolved)
        ? primary
        : encodeCanonicalLocal(Buffer.concat([lexicalPrimary, zeroByteBuf, resolved]), asFileUrl)
      : invalidPrimary;
  const pointerKey = resolved && lexicalPrimary ? explicitPointerKeyBytes(resolved, lexicalPrimary, asFileUrl) : undefined;
  const primaryGit = resolved && lexicalPrimary ? resolveGitIdentityBytes(resolved, dirnamePosixBytes(lexicalPrimary), !hasTrailingSlash, primaryAccess) : undefined;
  if (primaryGit) {
    return {
      resolved: primaryGit.isStandardChild ? primary : encodeCanonicalLocal(primaryGit.identity, asFileUrl),
      primary,
      lexicalKey,
      ...(configuredKey && configuredKey !== primary && configuredKey !== lexicalKey ? { configuredKey } : {}),
      aliasKey,
      ...(pointerKey ? { pointerKey } : {}),
      hasLiveRepo: true,
      isLocal: true,
    };
  }
  if (primaryAccess.inaccessible) {
    return {
      resolved: primary,
      primary,
      lexicalKey,
      ...(configuredKey && configuredKey !== primary && configuredKey !== lexicalKey ? { configuredKey } : {}),
      aliasKey,
      ...(pointerKey ? { pointerKey } : {}),
      hasLiveRepo: false,
      isLocal: true,
      skipPinCache: true,
    };
  }
  const trimmedRaw = stripTrailingSlashBytes(rawPath);
  const dotGitRaw = Buffer.concat([trimmedRaw, dotGitBuf]);
  const dotGitAccess: AccessState = { inaccessible: false };
  const dotGitResolved = resolvePosixPathBytes(base, dotGitRaw, true, dotGitAccess);
  const dotGitLexical = resolvePosixPathBytes(base, dotGitRaw, false) ?? dotGitResolved;
  const dotGitPointerKey = dotGitLexical
    ? implicitDotGitPointerKeyBytes(lexicalPrimary ?? dotGitLexical, dotGitLexical, dotGitResolved, asFileUrl)
    : undefined;
  const dotGitInfo = dotGitResolved && dotGitLexical ? resolveGitIdentityBytes(dotGitResolved, dirnamePosixBytes(dotGitLexical), false, dotGitAccess) : undefined;
  if (dotGitResolved && dotGitInfo) {
    return {
      resolved: dotGitInfo.isStandardChild ? encodeCanonicalLocal(dotGitResolved, asFileUrl) : encodeCanonicalLocal(dotGitInfo.identity, asFileUrl),
      primary,
      lexicalKey,
      ...(configuredKey && configuredKey !== primary && configuredKey !== lexicalKey ? { configuredKey } : {}),
      aliasKey,
      ...(dotGitPointerKey ? { pointerKey: dotGitPointerKey } : {}),
      hasLiveRepo: true,
      isLocal: true,
    };
  }
  const effectivePointerKey = pointerKey ?? dotGitPointerKey;
  return {
    resolved: primary,
    primary,
    lexicalKey,
    ...(configuredKey && configuredKey !== primary && configuredKey !== lexicalKey ? { configuredKey } : {}),
    aliasKey,
    ...(effectivePointerKey ? { pointerKey: effectivePointerKey } : {}),
    hasLiveRepo: false,
    isLocal: true,
    ...(dotGitAccess.inaccessible || (resolved === undefined && dotGitResolved === undefined) ? { skipPinCache: true } : {}),
  };
}

function localProbeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.BUN_OPTIONS;
  return env;
}

export async function probeLocalRepoInfo(
  dir: string,
  effective: string,
  timeoutMs = localProbeTimeoutMs,
  script = localRepoInfoScript,
  deadline?: Promise<void>,
): Promise<LocalRepoInfo> {
  if (!isLocalRepoSpec(effective)) {
    return { resolved: effective, primary: effective, lexicalKey: effective, aliasKey: effective, hasLiveRepo: false, isLocal: false };
  }
  const payload = Buffer.from(JSON.stringify({ dir: resolve(dir), effective }), "utf8");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(bunScript(script), {
      stdin: payload,
      stdout: "pipe",
      stderr: "ignore",
      env: localProbeEnv(),
      detached: process.platform !== "win32",
    });
  } catch {
    return lexicalFallbackLocalRepoInfo(dir, effective, false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  const readOut = (async () => {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
      }
    } catch {}
  })();
  const finished = Promise.all([proc.exited, readOut]).then(([code]) => ({ timedOut: false as const, code }));
  void finished.catch(() => {});
  const timeoutPromise = deadline
    ? deadline.then(() => ({ timedOut: true as const }))
    : new Promise<{ timedOut: true }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
      });
  const outcome = await Promise.race([finished, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.timedOut) {
    void reader.cancel().catch(() => {});
    if (process.platform !== "win32") {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }
    try {
      proc.kill("SIGKILL");
    } catch {}
    proc.unref();
    return lexicalFallbackLocalRepoInfo(dir, effective, true);
  }
  if (outcome.code !== 0) return lexicalFallbackLocalRepoInfo(dir, effective, false);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LocalRepoInfo;
    if (
      parsed &&
      typeof parsed.resolved === "string" &&
      typeof parsed.primary === "string" &&
      typeof parsed.lexicalKey === "string" &&
      typeof parsed.aliasKey === "string" &&
      typeof parsed.hasLiveRepo === "boolean" &&
      typeof parsed.isLocal === "boolean"
    ) {
      return parsed;
    }
  } catch {}
  return lexicalFallbackLocalRepoInfo(dir, effective, false);
}

if (import.meta.main) {
  const raw = await new Response(Bun.stdin.stream()).text();
  const { dir, effective } = JSON.parse(raw) as { dir: string; effective: string };
  await Bun.write(Bun.stdout, JSON.stringify(canonicalLocalRepoInfo(dir, effective)));
}
