/** A text that names this machine or its owner, and the label that replaces it. */
export type KnownName = { text: string; as: string; after?: boolean };

type Rule = [RegExp, string | ((match: string, ...groups: Array<string | number | undefined>) => string)];

const secretKey = String.raw`[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|SESSION)[A-Za-z_]*`;

const secretRules: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g, "<token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<token>"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <token>"],
  [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1<credentials>@"],
  [/([?&#][A-Za-z_]*(?:token|key|secret|password|auth|code|sig)[A-Za-z_]*=)[^\s&#"']+/gi, "$1<redacted>"],
  [new RegExp(String.raw`\b(${secretKey})(["']?\s*[:=]\s*)(?:(")(?:[^"\\]|\\.){0,4096}"|(')[^']{0,4096}'|[^\s"']+)`, "gi"), (_match, key, separator, double, single) => `${key}${separator}${double ?? single ?? ""}<redacted>${double ?? single ?? ""}`],
];

const standardRules: Rule[] = [
  [/(?<![\w.+%-])[\w.+%-]+(?:@|%40)[A-Za-z0-9-]+(?:(?:\.|%2E)[A-Za-z0-9-]+)*(?:\.|%2E)[A-Za-z]{2,}\b/gi, (email, offset, text) => (email.startsWith("git@") && String(text)[Number(offset) + email.length] === ":" ? email : "<email>")],
  [/(?<![\w.-])[\w.-]+\/(?:hedge|fleet)-(profile|memory)(?:-[\w-]+)?\b/g, "<$1 repo>"],
  [/(private repos? )[\w.-]+\/[\w.-]+(?: and [\w.-]+\/[\w.-]+)?/g, "$1<private repo>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip: string) => (ip === "127.0.0.1" || ip === "0.0.0.0" ? ip : "<ip>")],
  [/(?<![A-Za-z0-9-]|[A-Za-z0-9-]\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|lan|corp|home\.arpa|coder|ts\.net|tailscale\.net)\b/g, "<host>"],
  [/(\/Users|\/home)\/(?:[^/\n"'`:]{1,64}?(?=\/)|[^/\s"'`:]+)/g, "$1/<user>"],
  [/\b([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(?:[^\\/\n"'`:]{1,64}?(?=[\\/])|[^\\/\s"'`:]+)/gi, "$1<user>"],
];

const randomRule: Rule = [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (text) => (looksRandom(text) ? "<secret>" : text)];
const fixedSecretRules: Rule[] = [...secretRules.slice(0, 6), secretRules[7]!];
const ciFixedSecretRules: Rule[] = fixedSecretRules.map(([pattern, replacement]) => [
  new RegExp(pattern.source, pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`),
  replacement,
]);
const contextualSecretRules: Rule[] = secretRules.slice(8);
const allRules: Rule[] = [...secretRules, ...standardRules, randomRule];
const preRandomRules: Rule[] = [...contextualSecretRules, ...standardRules];

const tokenLetters = 32;
const windowLetters = 128;

type Tally = { letters: number; upper: number };

function looksRandom(text: string) {
  if (!/[A-Z]/.test(text) || !/[a-z]/.test(text)) return false;
  if (/[0-9]/.test(text)) return true;
  const parts: Tally[] = text
    .replace(/=+$/, "")
    .split(/[+/_-]/)
    .filter((part) => /[A-Z]/.test(part) && /[a-z]/.test(part))
    .map((part) => ({ letters: part.length, upper: part.match(/[A-Z]/g)!.length }));
  if (evenCases(parts.reduce(add, { letters: 0, upper: 0 }))) return true;
  for (let start = 0; start < parts.length; start++) {
    let window: Tally = { letters: 0, upper: 0 };
    for (let end = start; end < parts.length && window.letters - parts[start]!.letters < windowLetters; end++) {
      window = add(window, parts[end]!);
      if (evenCases(window)) return true;
    }
  }
  return false;
}

const add = (a: Tally, b: Tally): Tally => ({ letters: a.letters + b.letters, upper: a.upper + b.upper });

function evenCases({ letters, upper }: Tally) {
  return letters >= tokenLetters && Math.min(upper, letters - upper) * 4 >= letters;
}

/**
 * Removes what must not leave the machine in a report: keys, tokens, private
 * keys, passwords in URLs, email addresses, IP addresses, private hostnames,
 * the home path, and the names the caller knows, such as this machine's
 * hostname and its devboxes.
 */
const redactorLabels = new Set([
  "<private key>",
  "<token>",
  "<key>",
  "<credentials>",
  "<redacted>",
  "<email>",
  "<profile repo>",
  "<memory repo>",
  "<private repo>",
  "<ip>",
  "<host>",
  "<user>",
  "<secret>",
]);

function applyRules(text: string, set: Rule[]) {
  let result = text;
  for (const [pattern, replacement] of set) result = result.replace(pattern, replacement as string);
  return result;
}

function encodeUri(text: string) {
  try {
    return encodeURIComponent(text);
  } catch {
    return text;
  }
}

function foldCase(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!;
    const upper = ch.toUpperCase();
    out += upper.length === 1 && !(ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : ch;
  }
  return out;
}

type CiEntry = { text: string; as: string; owner: KnownName; ambiguous?: boolean; regex?: RegExp; pattern?: string };

type CompiledMatcher = {
  ciRegexes: RegExp[];
  ciMaxLen: number;
  ciMap: Map<string, CiEntry>;
  ciEntries: CiEntry[];
  ciFlexEntries: CiEntry[];
  csRegexes: RegExp[];
  csMaxLen: number;
  csMap: Map<string, { as: string; owner: KnownName }>;
};

const maxRegexItems = 256;
const maxRegexChars = 16_384;

function compileRegexChunks(items: Array<{ pattern: string }>, flags: string): RegExp[] {
  const regexes: RegExp[] = [];
  let chunk: string[] = [];
  let chars = 0;
  for (const item of items) {
    const added = item.pattern.length + (chunk.length ? 1 : 0);
    if (chunk.length >= maxRegexItems || (chunk.length > 0 && chars + added > maxRegexChars)) {
      regexes.push(new RegExp(chunk.join("|"), flags));
      chunk = [];
      chars = 0;
    }
    chunk.push(item.pattern);
    chars += item.pattern.length + (chunk.length > 1 ? 1 : 0);
  }
  if (chunk.length) regexes.push(new RegExp(chunk.join("|"), flags));
  return regexes;
}

const unsafeForBatch = /-----BEGIN|["'\0\r\n]|[:=]\s*$/i;
const batchSeparator = "\n!\0!\n";

function batchTransform(inputs: string[], transform: (value: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  const batchable: string[] = [];
  const single: string[] = [];
  for (const input of inputs) {
    if (out.has(input)) continue;
    out.set(input, "");
    if (unsafeForBatch.test(input)) single.push(input);
    else batchable.push(input);
  }
  if (batchable.length > 1) {
    const parts = transform(batchable.join(batchSeparator)).split(batchSeparator);
    if (parts.length === batchable.length) {
      for (let i = 0; i < batchable.length; i++) out.set(batchable[i]!, parts[i]!);
    } else {
      for (const input of batchable) out.set(input, transform(input));
    }
  } else if (batchable.length === 1) {
    out.set(batchable[0]!, transform(batchable[0]!));
  }
  for (const input of single) out.set(input, transform(input));
  return out;
}

function flexSecretPattern(text: string): { pattern: string; maxLen: number } | undefined {
  const hits: Array<{ start: number; end: number; raw: string; masked: string }> = [];
  for (const [regex, replacement] of ciFixedSecretRules) {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (!match[0].length) {
        regex.lastIndex++;
        continue;
      }
      const single = new RegExp(regex.source, regex.flags.replace("g", ""));
      const masked = match[0].replace(single, replacement as string);
      if (masked !== match[0]) {
        hits.push({ start: match.index, end: match.index + match[0].length, raw: match[0], masked });
      }
    }
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let pos = 0;
  let maxLen = 0;
  for (const hit of hits) {
    if (hit.start < pos) continue;
    out += escape(text.slice(pos, hit.start));
    maxLen += hit.start - pos;
    out += `(?:${escape(hit.raw)}|${escape(hit.masked)})`;
    maxLen += Math.max(hit.raw.length, hit.masked.length);
    pos = hit.end;
  }
  out += escape(text.slice(pos));
  maxLen += text.length - pos;
  return { pattern: out, maxLen };
}

function compileSpellings(entries: KnownName[], transform?: (value: string) => string, exempt?: Set<string>, presentExempt?: string[]): CompiledMatcher {
  const validEntries = entries.filter((entry) => typeof entry.text === "string" && typeof entry.as === "string" && entry.text.length >= (entry.after ? 1 : 2));
  const entryBases = validEntries.map((entry) => {
    const minLength = entry.after ? 1 : 2;
    const safeAs = applyRules(entry.as, secretRules);
    const baseVariants = [entry.text, applyRules(entry.text, secretRules), encodeUri(entry.text), entry.text.replace(/ /g, "+")];
    return { entry, minLength, safeAs, baseVariants };
  });
  let transformed: Map<string, string> | undefined;
  if (transform) {
    const inputs: string[] = [];
    for (const item of entryBases) {
      for (const variant of item.baseVariants) {
        inputs.push(variant);
        if (!variant.startsWith("/")) inputs.push(`/${variant}`);
      }
    }
    transformed = batchTransform(inputs, transform);
  }
  const raw = entryBases
    .flatMap(({ entry, minLength, safeAs, baseVariants }) => {
      const variants = [...baseVariants];
      if (transform) {
        for (const variant of new Set(baseVariants)) {
          variants.push(transformed?.get(variant) ?? transform(variant));
          if (!variant.startsWith("/")) {
            const prefixed = transformed?.get(`/${variant}`) ?? transform(`/${variant}`);
            variants.push(prefixed.startsWith("/") ? prefixed.slice(1) : prefixed);
          }
        }
      }
      return [...new Set(variants.filter((variant) => variant.length >= minLength && !exempt?.has(variant)))].map((variant) => ({
        text: variant,
        as: safeAs,
        after: Boolean(entry.after),
        owner: entry,
      }));
    })
    .sort((a, b) => b.text.length - a.text.length);

  const ciItems: Array<{ len: number; pattern: string; exempt?: boolean }> = [];
  const csItems: Array<{ len: number; pattern: string; exempt?: boolean }> = [];
  const ciMap = new Map<string, CiEntry>();
  const ciEntries: CiEntry[] = [];
  const ciFlexEntries: CiEntry[] = [];
  const seenFlex = new Set<string>();
  const csMap = new Map<string, { as: string; owner: KnownName }>();
  for (const name of raw) {
    const left = name.after && /^[~<]/.test(name.text) ? "" : "(?<![\\w-])";
    const right =
      name.after && /[>]$/.test(name.text)
        ? ""
        : name.after && name.text.startsWith("The pack source ")
          ? "(?![\\w/:-]|\\.[A-Za-z0-9])"
          : "(?![\\w-])";
    const pattern = `${left}${escape(name.text)}${right}`;
    if (name.text.length < 4) {
      if (!csMap.has(name.text)) {
        csMap.set(name.text, { as: name.as, owner: name.owner });
        csItems.push({ len: name.text.length, pattern });
      }
    } else {
      const flex = name.after ? flexSecretPattern(name.text) : undefined;
      if (flex && !seenFlex.has(flex.pattern)) {
        seenFlex.add(flex.pattern);
        const flexEntry: CiEntry = { text: name.text, as: name.as, owner: name.owner, pattern: flex.pattern };
        ciFlexEntries.push(flexEntry);
        ciItems.push({ len: flex.maxLen, pattern: `${left}${flex.pattern}${right}` });
      }
      const key = foldCase(name.text);
      const existing = ciMap.get(key);
      if (!existing) {
        const entry: CiEntry = { text: name.text, as: name.as, owner: name.owner };
        ciMap.set(key, entry);
        ciEntries.push(entry);
        if (!flex) ciItems.push({ len: name.text.length, pattern });
      } else if (!(existing.regex ??= new RegExp(`^${escape(existing.text)}$`, "i")).test(name.text)) {
        existing.ambiguous = true;
        const entry: CiEntry = { text: name.text, as: name.as, owner: name.owner };
        ciEntries.push(entry);
        if (!flex) ciItems.push({ len: name.text.length, pattern });
      }
    }
  }
  const byLen = (a: { len: number; exempt?: boolean }, b: { len: number; exempt?: boolean }) => b.len - a.len || Number(Boolean(b.exempt)) - Number(Boolean(a.exempt));
  const exemptItems = presentExempt?.map((label) => ({ len: label.length, pattern: escape(label), exempt: true })) ?? [];
  const ciSorted = [...ciItems, ...exemptItems].sort(byLen);
  const csSorted = [...csItems, ...exemptItems].sort(byLen);
  return {
    ciRegexes: ciItems.length ? compileRegexChunks(ciSorted, "gi") : [],
    ciMaxLen: ciSorted[0]?.len ?? 0,
    ciMap,
    ciEntries,
    ciFlexEntries,
    csRegexes: csItems.length ? compileRegexChunks(csSorted, "g") : [],
    csMaxLen: csSorted[0]?.len ?? 0,
    csMap,
  };
}

function replaceLongestFirst(text: string, regexes: RegExp[], maxLen: number, replacer: (match: string) => string): string {
  const execAt = (slice: string, from: number, cached?: Array<RegExpExecArray | null | undefined>): { index: number; text: string } | undefined => {
    if (regexes.length === 1) {
      const regex = regexes[0]!;
      regex.lastIndex = from;
      const m = regex.exec(slice);
      return m ? { index: m.index, text: m[0] } : undefined;
    }
    let best: { index: number; text: string } | undefined;
    for (let i = 0; i < regexes.length; i++) {
      let m = cached?.[i];
      if (m !== null && (m === undefined || m.index < from)) {
        const regex = regexes[i]!;
        regex.lastIndex = from;
        m = regex.exec(slice);
        if (cached) cached[i] = m;
      }
      if (!m) continue;
      if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.text.length)) {
        best = { index: m.index, text: m[0] };
      }
    }
    return best;
  };
  const replaceRange = (slice: string): string => {
    let out = "";
    let pos = 0;
    const cached = regexes.length > 1 ? new Array<RegExpExecArray | null | undefined>(regexes.length) : undefined;
    while (pos < slice.length) {
      const first = execAt(slice, pos, cached);
      if (!first) break;
      let bestStart = first.index;
      let bestEnd = bestStart + first.text.length;
      let bestMatch = first.text;
      if (bestMatch.length < maxLen) {
        let probe = bestStart + 1;
        while (probe < bestEnd) {
          const next = execAt(slice, probe, cached);
          if (!next || next.index >= bestEnd) break;
          if (next.text.length > bestMatch.length) {
            bestStart = next.index;
            bestEnd = bestStart + next.text.length;
            bestMatch = next.text;
            if (bestMatch.length >= maxLen) break;
            probe = bestStart + 1;
          } else {
            probe = next.index + 1;
          }
        }
      }
      if (bestStart > first.index) {
        out += slice.slice(pos, first.index) + replaceRange(slice.slice(first.index, bestStart));
      } else {
        out += slice.slice(pos, bestStart);
      }
      out += replacer(bestMatch);
      pos = bestEnd;
    }
    return pos === 0 ? slice : out + slice.slice(pos);
  };
  return replaceRange(text);
}

function applySpellings(text: string, matcher: CompiledMatcher, exempt?: Set<string>, skipOwner?: KnownName, onMatch?: (match: string, as: string) => string) {
  let result = text;
  if (matcher.ciRegexes.length) {
    result = replaceLongestFirst(result, matcher.ciRegexes, matcher.ciMaxLen, (match) => {
      if (exempt?.has(match)) return match;
      const fast = matcher.ciMap.get(foldCase(match));
      const hit =
        fast && !fast.ambiguous
          ? fast
          : matcher.ciFlexEntries.find((entry) => (entry.regex ??= new RegExp(`^${entry.pattern}$`, "i")).test(match))
            ?? matcher.ciEntries.find((entry) => (entry.regex ??= new RegExp(`^${escape(entry.text)}$`, "i")).test(match));
      if (!hit || (skipOwner && hit.owner === skipOwner)) return match;
      return onMatch ? onMatch(match, hit.as) : hit.as;
    });
  }
  if (matcher.csRegexes.length) {
    result = replaceLongestFirst(result, matcher.csRegexes, matcher.csMaxLen, (match) => {
      if (exempt?.has(match)) return match;
      const hit = matcher.csMap.get(match);
      if (!hit || (skipOwner && hit.owner === skipOwner)) return match;
      return onMatch ? onMatch(match, hit.as) : hit.as;
    });
  }
  return result;
}

const deferToAfter = new RegExp(
  String.raw`[:?&#="']|-----BEGIN|PRIVATE KEY|\beyJ[A-Za-z0-9_-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b|\b(?:bearer|basic|token)\b|(?:^|[^\w])(?:${secretKey}|[A-Za-z_]*(?:token|key|secret|password|auth|code|sig)[A-Za-z_]*|users|home|private repos?)\s*$`,
  "i",
);

const builtInLabels = new Set([...redactorLabels, "<this machine>", "<hub>", "<branch>", "<private source>", "<name>"]);

export function redact(text: string, home: string, known: KnownName[] = []): string {
  const stripHome = (value: string) => (home.length > 1 ? value.split(home.replace(/\/$/, "")).join("~") : value);
  const valid = known.filter((entry) => typeof entry.text === "string" && typeof entry.as === "string");
  const needsAfter = (entry: KnownName) => Boolean(entry.after) || deferToAfter.test(entry.text) || applyRules(entry.text, secretRules) !== entry.text;
  const primary: KnownName[] = [];
  const after: KnownName[] = [];
  const allEntries: KnownName[] = [];
  for (const entry of valid) {
    if (needsAfter(entry)) {
      const deferred = entry.after ? entry : { ...entry, after: true };
      after.push(deferred);
      allEntries.push(deferred);
    } else {
      primary.push(entry);
      allEntries.push(entry);
    }
  }

  const usedNonces = new Set<number>();
  for (const part of [text, home, ...valid.flatMap((entry) => [entry.text, entry.as])]) {
    for (const match of part.matchAll(/~\.(\d+)\./g)) usedNonces.add(Number(match[1]));
  }
  let nonce = 0;
  while (usedNonces.has(nonce)) nonce++;
  const prefix = `~.${nonce}.`;
  const suffix = ".~";

  const sanitizeExempt = new Set([
    ...builtInLabels,
    ...valid.map((entry) => entry.as).filter((label) => /^<devbox \d+>$/.test(label)),
  ]);
  const rawAllSpellings = compileSpellings(allEntries, undefined, undefined, [...sanitizeExempt]);
  const sanitizeOne = (value: string, skipOwner?: KnownName) => {
    let current = value;
    for (let pass = 0; pass < 4; pass++) {
      const next = applyRules(stripHome(applySpellings(current, rawAllSpellings, sanitizeExempt, skipOwner)), allRules);
      if (next === current) break;
      current = next;
    }
    return current;
  };
  const cacheableLabels: string[] = [];
  for (const entry of allEntries) {
    if (!foldCase(entry.as).includes(foldCase(entry.text))) cacheableLabels.push(entry.as);
  }
  const sanitizedLabelCache = batchTransform(cacheableLabels, (value) => sanitizeOne(value));
  const sanitizeLabel = (entry: KnownName) => {
    const canCache = !foldCase(entry.as).includes(foldCase(entry.text));
    if (canCache) {
      const cached = sanitizedLabelCache.get(entry.as);
      if (cached !== undefined) return cached;
    }
    const value = sanitizeOne(entry.as, entry);
    if (canCache) sanitizedLabelCache.set(entry.as, value);
    return value;
  };

  const labels: string[] = [];
  const maskedEntries = primary.map((entry) => {
    const label = sanitizeLabel(entry);
    labels.push(label);
    return { ...entry, as: label };
  });
  const maskedSpellings = compileSpellings(maskedEntries);
  const tokenPattern = `${escape(prefix)}(\\d+)${escape(suffix)}`;
  const tokenRegex = new RegExp(tokenPattern, "g");
  const tokenOrChunk = new RegExp(`[A-Za-z0-9+/_-]+|${tokenPattern}`, "g");

  const replaceMaskedRandom = (value: string, matchedOriginals: string[]) => {
    let out = "";
    let pos = 0;
    let runStart = -1;
    let runEnd = -1;
    let prevBoundaryEnd = -1;
    let prevTail = "";
    const flush = (nextLead = "") => {
      if (runStart === -1) return;
      let end = runEnd;
      let eq = 0;
      while (eq < 2 && value[end] === "=") {
        end++;
        eq++;
      }
      const slice = value.slice(runStart, end);
      const expanded = slice.replace(tokenRegex, (_tok, idx) => matchedOriginals[Number(idx)] ?? "");
      const prefixTail = runStart === prevBoundaryEnd ? prevTail : "";
      const suffixLead = end === runEnd ? nextLead : "";
      const candidate = `${prefixTail}${expanded}${suffixLead}`;
      const isRandom = (sample: string) => sample.length >= tokenLetters && looksRandom(sample);
      out += value.slice(pos, runStart);
      out += isRandom(expanded) || isRandom(candidate) ? "<secret>" : slice;
      pos = end;
      runStart = -1;
      runEnd = -1;
    };
    tokenOrChunk.lastIndex = 0;
    for (let match = tokenOrChunk.exec(value); match !== null; match = tokenOrChunk.exec(value)) {
      if (match[1] !== undefined) {
        const orig = matchedOriginals[Number(match[1])] ?? "";
        if (!/^[A-Za-z0-9+/_-]+$/.test(orig)) {
          const lead = match.index === runEnd ? (orig.match(/^[A-Za-z0-9+/_-]+={0,2}/)?.[0] ?? "") : "";
          flush(lead);
          prevBoundaryEnd = match.index + match[0].length;
          prevTail = trailingTokenRun(orig);
          continue;
        }
      }
      const start = match.index;
      const end = start + match[0].length;
      if (runStart !== -1 && start === runEnd) {
        runEnd = end;
      } else {
        flush();
        runStart = start;
        runEnd = end;
      }
    }
    flush();
    return pos === 0 ? value : out + value.slice(pos);
  };

  const bearerMaskedRegex = /\b(Bearer|Basic|token)(\s+)([A-Za-z0-9._~+/=-]+)/gi;

  const redactBearerMasked = (value: string, matchedOriginals: string[]) => {
    let out = "";
    let pos = 0;
    bearerMaskedRegex.lastIndex = 0;
    for (let match = bearerMaskedRegex.exec(value); match !== null; match = bearerMaskedRegex.exec(value)) {
      const kind = match[1]!;
      const space = match[2]!;
      const body = match[3]!;
      const expanded = body.replace(tokenRegex, (_tok, idx) => matchedOriginals[Number(idx)] ?? "");
      if (/^[A-Za-z0-9._~+/=-]{12,}/.test(expanded)) {
        out += value.slice(pos, match.index) + `${kind}${space}<token>`;
        pos = match.index + match[0].length;
      } else {
        bearerMaskedRegex.lastIndex = match.index + kind.length + space.length;
      }
    }
    return pos === 0 ? value : out + value.slice(pos);
  };

  const passOne = (value: string) => {
    const preMasked = applyRules(value, fixedSecretRules);
    const matchedOriginals: string[] = [];
    const matchedLabels: string[] = [];
    const masked = applySpellings(preMasked, maskedSpellings, undefined, undefined, (match, as) => {
      const index = matchedOriginals.length;
      matchedOriginals.push(match);
      matchedLabels.push(as);
      return `${prefix}${index}${suffix}`;
    });
    const bearerRedacted = redactBearerMasked(stripHome(masked), matchedOriginals);
    let next = applyRules(bearerRedacted, preRandomRules);
    next = replaceMaskedRandom(next, matchedOriginals);
    return next.replace(tokenRegex, (_tok, idx) => matchedLabels[Number(idx)] ?? "");
  };

  const result = passOne(text);
  if (!after.length) return result;
  const sanitizedAfter = after.map((entry) => ({ ...entry, as: sanitizeLabel(entry) }));
  const exempt = new Set([...redactorLabels, ...labels, ...sanitizedAfter.map((entry) => entry.as)]);
  const angleExempt = new Set<string>();
  const otherExempt: string[] = [];
  for (const label of exempt) {
    if (/^<[^<>\r\n]+>$/.test(label)) angleExempt.add(label);
    else otherExempt.push(label);
  }
  const presentSet = new Set<string>();
  for (const match of result.matchAll(/<[^<>\r\n]+>/g)) {
    if (angleExempt.has(match[0])) presentSet.add(match[0]);
  }
  for (const label of otherExempt) {
    if (result.includes(label)) presentSet.add(label);
  }
  const presentExempt = [...presentSet].sort((a, b) => b.length - a.length);
  const afterSpellings = compileSpellings(sanitizedAfter, passOne, exempt, presentExempt);
  return applySpellings(result, afterSpellings, exempt);
}

function trailingTokenRun(text: string): string {
  let i = text.length;
  while (i > 0 && /[A-Za-z0-9+/_-]/.test(text[i - 1]!)) i--;
  return i === text.length ? "" : text.slice(i);
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
