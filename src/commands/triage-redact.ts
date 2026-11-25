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
const ciStandardMaskRules: Rule[] = [
  [/(?<![\w.+%-])[\w.+%-]+(?:@|%40)[A-Za-z0-9-]+(?:(?:\.|%2E)[A-Za-z0-9-]+)*(?:\.|%2E)[A-Za-z]{2,}\b/gi, "<email>"],
  [/(?<![\w.-])[\w.-]+\/(?:hedge|fleet)-(profile|memory)(?:-[\w-]+)?\b/gi, "<$1 repo>"],
  [/(private repos? )[\w.-]+\/[\w.-]+(?: and [\w.-]+\/[\w.-]+)?/gi, "$1<private repo>"],
  [/(?<![A-Za-z0-9-]|[A-Za-z0-9-]\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|lan|corp|home\.arpa|coder|ts\.net|tailscale\.net)\b/gi, "<host>"],
  [/(\/Users|\/home)\/(?:[^/\n"'`:]{1,64}?(?=\/)|[^/\s"'`:]+)/gi, "$1/<user>"],
];
const ciFlexRules: Rule[] = [...ciFixedSecretRules, ...ciStandardMaskRules];
const canonMaskRules: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, "<private key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "<token>"],
  [/\bsk-[A-Za-z0-9_-]*(?:<key>)+|\bsk-[A-Za-z0-9_-]{16,}/gi, "<key>"],
  [/\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]*(?:<token>)+|\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/gi, "<token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gi, "<key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi, "<token>"],
  [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1<credentials>@"],
  ...ciStandardMaskRules,
];
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
  if (!/[^\x00-\x7f]/.test(text)) return text.toUpperCase();
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!;
    const upper = ch.toUpperCase();
    out += upper.length === 1 && !(ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : ch;
  }
  return out;
}

function foldCharCode(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code < 128) return code >= 97 && code <= 122 ? code - 32 : code;
  const ch = text[index]!;
  const upper = ch.toUpperCase();
  return upper.length === 1 && upper.charCodeAt(0) >= 128 ? upper.charCodeAt(0) : code;
}

function isWordOrDash(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 45;
}

function isLeftOk(text: string, start: number, left: 0 | 1): boolean {
  return left === 0 || start === 0 || !isWordOrDash(text.charCodeAt(start - 1));
}

function isRightOk(text: string, end: number, right: 0 | 1 | 2): boolean {
  if (right === 0 || end >= text.length) return true;
  const code = text.charCodeAt(end);
  if (right === 1) return !isWordOrDash(code);
  if (isWordOrDash(code) || code === 47 || code === 58) return false;
  if (code === 46 && end + 1 < text.length) {
    const next = text.charCodeAt(end + 1);
    if ((next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122)) return false;
  }
  return true;
}

type AcRule = {
  text: string;
  len: number;
  left: 0 | 1;
  right: 0 | 1 | 2;
  as: string;
  owner?: KnownName;
  exempt?: boolean;
  ambiguous?: boolean;
  regex?: RegExp;
  verifyPattern?: string;
  verifyRegex?: RegExp;
};

type AcAutomaton = {
  ci: boolean;
  hasExempt: boolean;
  next: Array<Map<number, number>>;
  fail: Int32Array;
  dict: Int32Array;
  out: Array<AcRule[] | undefined>;
};

type CompiledMatcher = {
  ciAc?: AcAutomaton;
  csAc?: AcAutomaton;
  canonAc?: AcAutomaton;
};

type MatchSpan = {
  start: number;
  end: number;
  len: number;
  as: string;
  exempt?: boolean;
};

type CanonEdit = { cStart: number; cEnd: number; oStart: number; oEnd: number };

function mapPosToOrig(edits: CanonEdit[], pos: number, side: "start" | "end"): number {
  let lo = 0;
  let hi = edits.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = edits[mid]!;
    if (pos < e.cStart) {
      hi = mid - 1;
    } else if (pos > e.cEnd) {
      lo = mid + 1;
    } else {
      if (pos === e.cStart) return side === "start" ? e.oStart : mid > 0 ? edits[mid - 1]!.oEnd + (pos - edits[mid - 1]!.cEnd) : pos;
      if (pos === e.cEnd) return e.oEnd;
      return -1;
    }
  }
  if (hi < 0) return pos;
  const prev = edits[hi]!;
  return prev.oEnd + (pos - prev.cEnd);
}

function mapBoundToOrig(edits: CanonEdit[], pos: number, side: "start" | "end"): number {
  let lo = 0;
  let hi = edits.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = edits[mid]!;
    if (pos < e.cStart) {
      hi = mid - 1;
    } else if (pos > e.cEnd) {
      lo = mid + 1;
    } else {
      if (pos === e.cStart && side === "end") return mid > 0 ? edits[mid - 1]!.oEnd + (pos - edits[mid - 1]!.cEnd) : pos;
      return side === "start" ? e.oStart : e.oEnd;
    }
  }
  if (hi < 0) return pos;
  const prev = edits[hi]!;
  return prev.oEnd + (pos - prev.cEnd);
}

function canonicalizeWithMap(text: string): { text: string; edits: CanonEdit[] } {
  let cur = text;
  let edits: CanonEdit[] = [];
  for (const [regex, replacement] of canonMaskRules) {
    regex.lastIndex = 0;
    const single = new RegExp(regex.source, regex.flags.replace("g", ""));
    const layer: CanonEdit[] = [];
    let out = "";
    let pos = 0;
    for (let match = regex.exec(cur); match !== null; match = regex.exec(cur)) {
      if (!match[0].length) {
        regex.lastIndex++;
        continue;
      }
      const mStart = match.index;
      const mEnd = mStart + match[0].length;
      const repl = match[0].replace(single, replacement as string);
      if (repl !== match[0]) {
        out += cur.slice(pos, mStart);
        const cStart = out.length;
        out += repl;
        layer.push({ cStart, cEnd: out.length, oStart: mStart, oEnd: mEnd });
        pos = mEnd;
      }
    }
    if (!layer.length) continue;
    out += cur.slice(pos);
    if (!edits.length) {
      edits = layer;
      cur = out;
      continue;
    }
    const composed: CanonEdit[] = [];
    let p = 0;
    let delta = 0;
    for (const q of layer) {
      while (p < edits.length && edits[p]!.cEnd <= q.oStart) {
        const prev = edits[p]!;
        composed.push({ cStart: prev.cStart + delta, cEnd: prev.cEnd + delta, oStart: prev.oStart, oEnd: prev.oEnd });
        p++;
      }
      let cStart = q.cStart;
      let cEnd = q.cEnd;
      let oStart = mapBoundToOrig(edits, q.oStart, "start");
      let oEnd = mapBoundToOrig(edits, q.oEnd, "end");
      while (p < edits.length && edits[p]!.cStart < q.oEnd) {
        const prev = edits[p]!;
        if (prev.cStart < q.oStart) cStart = prev.cStart + delta;
        if (prev.cEnd > q.oEnd) cEnd = q.cEnd + (prev.cEnd - q.oEnd);
        if (prev.oStart < oStart) oStart = prev.oStart;
        if (prev.oEnd > oEnd) oEnd = prev.oEnd;
        p++;
      }
      composed.push({ cStart, cEnd, oStart, oEnd });
      delta = q.cEnd - q.oEnd;
    }
    while (p < edits.length) {
      const prev = edits[p]!;
      composed.push({ cStart: prev.cStart + delta, cEnd: prev.cEnd + delta, oStart: prev.oStart, oEnd: prev.oEnd });
      p++;
    }
    edits = composed;
    cur = out;
  }
  return { text: cur, edits };
}

function buildAc(rules: AcRule[], ci: boolean): AcAutomaton | undefined {
  if (!rules.length) return undefined;
  const next: Array<Map<number, number>> = [new Map()];
  const out: Array<AcRule[] | undefined> = [undefined];
  let hasExempt = false;
  for (const rule of rules) {
    if (rule.exempt) hasExempt = true;
    const key = ci ? foldCase(rule.text) : rule.text;
    let state = 0;
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      let child = next[state]!.get(code);
      if (child === undefined) {
        child = next.length;
        next[state]!.set(code, child);
        next.push(new Map());
        out.push(undefined);
      }
      state = child;
    }
    const list = out[state];
    if (list) list.push(rule);
    else out[state] = [rule];
  }
  const fail = new Int32Array(next.length);
  const dict = new Int32Array(next.length);
  const queue: number[] = [];
  for (const child of next[0]!.values()) queue.push(child);
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    for (const [code, v] of next[u]!) {
      let f = fail[u]!;
      while (f !== 0 && !next[f]!.has(code)) f = fail[f]!;
      const target = next[f]!.get(code) ?? 0;
      fail[v] = target;
      dict[v] = out[target] ? target : dict[target]!;
      queue.push(v);
    }
  }
  return { ci, hasExempt, next, fail, dict, out };
}

function pushStreamingSpan(spans: MatchSpan[], start: number, end: number, len: number, as: string, allowPartialMerge: boolean) {
  while (spans.length > 0 && spans[spans.length - 1]!.start >= start) spans.pop();
  if (allowPartialMerge && spans.length > 0 && spans[spans.length - 1]!.end > start) {
    const last = spans[spans.length - 1]!;
    if (len > last.len) {
      last.len = len;
      last.as = as;
    }
    if (end > last.end) last.end = end;
    return;
  }
  spans.push({ start, end, len, as });
}

function findAcSpans(ac: AcAutomaton | undefined, text: string, skipOwner?: KnownName): MatchSpan[] {
  if (!ac || !text.length) return [];
  const spans: MatchSpan[] = [];
  const exemptSpans: MatchSpan[] = [];
  let state = 0;
  for (let i = 0; i < text.length; i++) {
    const code = ac.ci ? foldCharCode(text, i) : text.charCodeAt(i);
    while (state !== 0 && !ac.next[state]!.has(code)) state = ac.fail[state]!;
    state = ac.next[state]!.get(code) ?? 0;
    const end = i + 1;
    let gotNonExempt = false;
    for (let u = ac.out[state] ? state : ac.dict[state]!; u !== 0; u = ac.dict[u]!) {
      for (const rule of ac.out[u]!) {
        if (skipOwner && rule.owner === skipOwner) continue;
        if (rule.exempt) {
          const start = end - rule.len;
          exemptSpans.push({ start, end, len: rule.len, as: rule.as, exempt: true });
          continue;
        }
        if (gotNonExempt) continue;
        const start = end - rule.len;
        if (!isLeftOk(text, start, rule.left) || !isRightOk(text, end, rule.right)) continue;
        if (rule.ambiguous && !(rule.regex ??= new RegExp(`^${escape(rule.text)}$`, "i")).test(text.slice(start, end))) continue;
        gotNonExempt = true;
        pushStreamingSpan(spans, start, end, rule.len, rule.as, !ac.hasExempt);
      }
      if (gotNonExempt && !ac.hasExempt) break;
    }
  }
  return exemptSpans.length ? [...spans, ...exemptSpans] : spans;
}

function findCanonAcSpans(ac: AcAutomaton | undefined, text: string, skipOwner?: KnownName): MatchSpan[] {
  if (!ac || !text.length) return [];
  const { text: canonText, edits } = canonicalizeWithMap(text);
  const spans: MatchSpan[] = [];
  let state = 0;
  for (let i = 0; i < canonText.length; i++) {
    const code = foldCharCode(canonText, i);
    while (state !== 0 && !ac.next[state]!.has(code)) state = ac.fail[state]!;
    state = ac.next[state]!.get(code) ?? 0;
    const cEnd = i + 1;
    let gotHit = false;
    for (let u = ac.out[state] ? state : ac.dict[state]!; u !== 0; u = ac.dict[u]!) {
      for (const rule of ac.out[u]!) {
        if (gotHit) break;
        if (skipOwner && rule.owner === skipOwner) continue;
        const cStart = cEnd - rule.len;
        const oStart = mapPosToOrig(edits, cStart, "start");
        const oEnd = mapPosToOrig(edits, cEnd, "end");
        if (oStart < 0 || oEnd <= oStart) continue;
        if (!isLeftOk(text, oStart, rule.left) || !isRightOk(text, oEnd, rule.right)) continue;
        const slice = text.slice(oStart, oEnd);
        if (rule.verifyPattern && !(rule.verifyRegex ??= new RegExp(`^(?:${rule.verifyPattern})$`, "i")).test(slice)) continue;
        gotHit = true;
        pushStreamingSpan(spans, oStart, oEnd, oEnd - oStart, rule.as, true);
      }
      if (gotHit) break;
    }
  }
  return spans;
}

type FlexHit = { start: number; end: number; masked: string };

const flexLiteralLimit = 8;

function expandFlexMask(text: string): { literals: string[]; pattern?: string } | undefined {
  const hits: FlexHit[] = [];
  for (const [regex, replacement] of ciFlexRules) {
    regex.lastIndex = 0;
    const single = new RegExp(regex.source, regex.flags.replace("g", ""));
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (!match[0].length) {
        regex.lastIndex++;
        continue;
      }
      const masked = match[0].replace(single, replacement as string);
      if (masked !== match[0]) {
        hits.push({ start: match.index, end: match.index + match[0].length, masked });
      }
      regex.lastIndex = match.index + 1;
    }
  }
  if (!hits.length) return undefined;
  const unique = new Map<string, FlexHit>();
  for (const hit of hits) {
    const key = `${hit.start}:${hit.end}:${hit.masked}`;
    if (!unique.has(key)) unique.set(key, hit);
  }
  const all = [...unique.values()].sort((a, b) => a.start - b.start || b.end - a.end);

  const clusters: Array<{ start: number; end: number; hits: FlexHit[] }> = [];
  let idx = 0;
  while (idx < all.length) {
    const start = all[idx]!.start;
    let end = all[idx]!.end;
    let next = idx + 1;
    while (next < all.length && all[next]!.start < end) {
      if (all[next]!.end > end) end = all[next]!.end;
      next++;
    }
    clusters.push({ start, end, hits: all.slice(idx, next) });
    idx = next;
  }

  let product = 1;
  const clusterLiterals: string[][] = [];
  let canUseLiterals = true;
  for (const cluster of clusters) {
    const lit = text.slice(cluster.start, cluster.end);
    if (cluster.hits.length === 1) {
      const msk = cluster.hits[0]!.masked;
      const alts = msk === lit ? [lit] : [msk, lit];
      clusterLiterals.push(alts);
      product *= alts.length;
    } else if (cluster.hits.every((item) => item.end === cluster.end)) {
      const alts = new Set<string>([lit]);
      for (const item of cluster.hits) {
        alts.add(`${text.slice(cluster.start, item.start)}${item.masked}`);
      }
      const list = [...alts];
      clusterLiterals.push(list);
      product *= list.length;
    } else {
      canUseLiterals = false;
      break;
    }
    if (product > flexLiteralLimit) {
      canUseLiterals = false;
      break;
    }
  }

  if (canUseLiterals) {
    let variants = [""];
    let pos = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cluster = clusters[c]!;
      const gap = text.slice(pos, cluster.start);
      const nextVariants: string[] = [];
      for (const prefix of variants) {
        for (const alt of clusterLiterals[c]!) {
          nextVariants.push(`${prefix}${gap}${alt}`);
        }
      }
      variants = nextVariants;
      pos = cluster.end;
    }
    const tail = text.slice(pos);
    return { literals: variants.map((v) => `${v}${tail}`) };
  }

  const buildRange = (from: number, to: number, list: FlexHit[], branchDepth: number): string => {
    let out = "";
    let pos = from;
    let i = 0;
    while (i < list.length) {
      const h = list[i]!;
      if (h.start < pos || h.end > to) {
        i++;
        continue;
      }
      if (h.start > pos) out += escape(text.slice(pos, h.start));
      let cEnd = h.end;
      let j = i + 1;
      while (j < list.length && list[j]!.start < cEnd) {
        if (list[j]!.end <= to && list[j]!.end > cEnd) cEnd = list[j]!.end;
        j++;
      }
      const cluster = list.slice(i, j).filter((item) => item.end <= cEnd);
      if (cluster.length === 1) {
        const lit = escape(text.slice(h.start, h.end));
        const msk = escape(h.masked);
        out += msk === lit ? lit : `(?:${msk}|${lit})`;
      } else if (cluster.every((item) => item.end === cEnd)) {
        const byStart = new Map<number, Set<string>>();
        for (const item of cluster) {
          let set = byStart.get(item.start);
          if (!set) {
            set = new Set();
            byStart.set(item.start, set);
          }
          set.add(escape(item.masked));
        }
        const starts = [...byStart.keys()].sort((a, b) => a - b);
        let tail = escape(text.slice(starts.at(-1)!, cEnd));
        for (let s = starts.length - 1; s >= 0; s--) {
          const st = starts[s]!;
          const gap = s + 1 < starts.length ? escape(text.slice(st, starts[s + 1]!)) : "";
          const alts = [...byStart.get(st)!, `${gap}${tail}`];
          tail = alts.length === 1 ? alts[0]! : `(?:${alts.join("|")})`;
        }
        out += tail;
      } else if (branchDepth < 8) {
        const first = cluster[0]!;
        const afterFirst = cluster.filter((item) => item.start >= first.end);
        const skippingFirst = cluster.slice(1);
        const withHit = `${escape(first.masked)}${buildRange(first.end, cEnd, afterFirst, branchDepth + (afterFirst.length ? 1 : 0))}`;
        const withoutHit = buildRange(first.start, cEnd, skippingFirst, branchDepth + (first.end < cEnd ? 1 : 0));
        out += withHit === withoutHit ? withHit : `(?:${withHit}|${withoutHit})`;
      } else {
        out += escape(text.slice(h.start, cEnd));
      }
      pos = cEnd;
      i = j;
    }
    if (pos < to) out += escape(text.slice(pos, to));
    return out;
  };
  return { literals: [], pattern: buildRange(0, text.length, all, 0) };
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

  const ciRules: AcRule[] = [];
  const csRules: AcRule[] = [];
  const canonRules: AcRule[] = [];
  const ciSeen = new Map<string, AcRule>();
  const csSeen = new Set<string>();
  const canonSeen = new Set<string>();

  const addLiteralRule = (text: string, as: string, after: boolean, owner: KnownName) => {
    const minLength = after ? 1 : 2;
    if (text.length < minLength || exempt?.has(text)) return;
    const left: 0 | 1 = after && /^[~<]/.test(text) ? 0 : 1;
    const right: 0 | 1 | 2 =
      after && /[>]$/.test(text)
        ? 0
        : after && text.startsWith("The pack source ")
          ? 2
          : 1;
    if (text.length < 4) {
      const key = `${left}:${right}:${text}`;
      if (!csSeen.has(key)) {
        csSeen.add(key);
        csRules.push({ text, len: text.length, left, right, as, owner });
      }
      return;
    }
    const key = `${left}:${right}:${foldCase(text)}`;
    const existing = ciSeen.get(key);
    if (!existing) {
      const rule: AcRule = { text, len: text.length, left, right, as, owner };
      ciSeen.set(key, rule);
      ciRules.push(rule);
    } else if (!(existing.regex ??= new RegExp(`^${escape(existing.text)}$`, "i")).test(text)) {
      existing.ambiguous = true;
      ciRules.push({ text, len: text.length, left, right, as, owner, ambiguous: true });
    }
  };

  for (const name of raw) {
    addLiteralRule(name.text, name.as, name.after, name.owner);
    if (name.after && name.text.length >= 4) {
      const expanded = expandFlexMask(name.text);
      if (expanded) {
        for (const literal of expanded.literals) {
          addLiteralRule(literal, name.as, true, name.owner);
        }
        if (expanded.pattern) {
          const left: 0 | 1 = /^[~<]/.test(name.text) ? 0 : 1;
          const right: 0 | 1 | 2 = /[>]$/.test(name.text) ? 0 : name.text.startsWith("The pack source ") ? 2 : 1;
          const canonKey = canonicalizeWithMap(name.text).text;
          const dedupKey = `${left}:${right}:${foldCase(canonKey)}:${expanded.pattern}`;
          if (canonKey.length >= 4 && !canonSeen.has(dedupKey)) {
            canonSeen.add(dedupKey);
            canonRules.push({
              text: canonKey,
              len: canonKey.length,
              left,
              right,
              as: name.as,
              owner: name.owner,
              verifyPattern: expanded.pattern,
            });
          }
        }
      }
    }
  }

  for (const label of presentExempt ?? []) {
    if (ciRules.length) ciRules.push({ text: label, len: label.length, left: 0, right: 0, as: label, exempt: true });
    if (csRules.length) csRules.push({ text: label, len: label.length, left: 0, right: 0, as: label, exempt: true });
  }

  return {
    ciAc: ciRules.length ? buildAc(ciRules, true) : undefined,
    csAc: csRules.length ? buildAc(csRules, false) : undefined,
    canonAc: canonRules.length ? buildAc(canonRules, true) : undefined,
  };
}

function applySpans(text: string, spans: MatchSpan[], exempt?: Set<string>, onMatch?: (match: string, as: string) => string): string {
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start || b.len - a.len || Number(Boolean(b.exempt)) - Number(Boolean(a.exempt)));
  let out = "";
  let pos = 0;
  let idx = 0;
  while (idx < spans.length) {
    while (idx < spans.length && spans[idx]!.start < pos) idx++;
    if (idx >= spans.length) break;
    const first = spans[idx]!;
    if (first.exempt) {
      out += text.slice(pos, first.end);
      pos = first.end;
      idx++;
      continue;
    }
    let clusterEnd = first.end;
    let best = first;
    let scan = idx + 1;
    let blockedByExempt = false;
    while (scan < spans.length && spans[scan]!.start < clusterEnd) {
      const cand = spans[scan]!;
      if (cand.exempt) {
        if (cand.end <= clusterEnd) {
          scan++;
          continue;
        }
        if (cand.len >= best.len) {
          blockedByExempt = true;
          break;
        }
        break;
      }
      if (cand.len > best.len) best = cand;
      if (cand.end > clusterEnd) clusterEnd = cand.end;
      scan++;
    }
    if (blockedByExempt) {
      idx++;
      continue;
    }
    out += text.slice(pos, first.start);
    const matched = text.slice(first.start, clusterEnd);
    out += exempt?.has(matched) ? matched : onMatch ? onMatch(matched, best.as) : best.as;
    pos = clusterEnd;
    idx = scan;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

function applySpellings(text: string, matcher: CompiledMatcher, exempt?: Set<string>, skipOwner?: KnownName, onMatch?: (match: string, as: string) => string) {
  if (!matcher.ciAc && !matcher.csAc && !matcher.canonAc) return text;
  const spans = [
    ...findAcSpans(matcher.ciAc, text, skipOwner),
    ...findCanonAcSpans(matcher.canonAc, text, skipOwner),
    ...findAcSpans(matcher.csAc, text, skipOwner),
  ];
  return applySpans(text, spans, exempt, onMatch);
}

const deferToAfter = new RegExp(
  String.raw`[:?&#="']|-----BEGIN|PRIVATE KEY|\beyJ[A-Za-z0-9_-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b|\b(?:bearer|basic|token)\b|(?:^|[^\w])(?:${secretKey}|[A-Za-z_]*(?:token|key|secret|password|auth|code|sig)[A-Za-z_]*|users|home|private repos?)\s*$`,
  "i",
);

const builtInLabels = new Set([...redactorLabels, "<this machine>", "<hub>", "<branch>", "<private source>", "<name>"]);

export function redact(text: string, home: string, known: KnownName[] = []): string {
  const trimmedHome = home.replace(/\/$/, "");
  const stripHome = (value: string) => (home.length > 1 ? value.split(trimmedHome).join("~") : value);
  const homeCiRegex = home.length > 1 ? new RegExp(escape(trimmedHome), "gi") : undefined;
  const stripHomeCi = (value: string) => (homeCiRegex ? value.replace(homeCiRegex, "~") : value);
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

  const preMasked = applyRules(text, fixedSecretRules);
  const matchedOriginals: string[] = [];
  const matchedLabels: string[] = [];
  const masked = applySpellings(preMasked, maskedSpellings, undefined, undefined, (match, as) => {
    const index = matchedOriginals.length;
    matchedOriginals.push(match);
    matchedLabels.push(as);
    return `${prefix}${index}${suffix}`;
  });
  const bearerRedacted = redactBearerMasked(stripHome(masked), matchedOriginals);
  const preRandom = applyRules(bearerRedacted, preRandomRules);
  if (!after.length) {
    const postRandom = replaceMaskedRandom(preRandom, matchedOriginals);
    return postRandom.replace(tokenRegex, (_tok, idx) => matchedLabels[Number(idx)] ?? "");
  }

  let expanded = "";
  let expPos = 0;
  const primarySpans: MatchSpan[] = [];
  tokenRegex.lastIndex = 0;
  for (let match = tokenRegex.exec(preRandom); match !== null; match = tokenRegex.exec(preRandom)) {
    expanded += preRandom.slice(expPos, match.index);
    const idx = Number(match[1]);
    const orig = matchedOriginals[idx] ?? "";
    const label = matchedLabels[idx] ?? "";
    const start = expanded.length;
    expanded += orig;
    primarySpans.push({ start, end: expanded.length, len: orig.length, as: label });
    expPos = match.index + match[0].length;
  }
  expanded += preRandom.slice(expPos);

  const sanitizedAfter = after.map((entry) => ({ ...entry, as: sanitizeLabel(entry) }));
  const exempt = new Set([...redactorLabels, ...labels, ...sanitizedAfter.map((entry) => entry.as)]);
  const angleExempt = new Set<string>();
  const otherExempt: string[] = [];
  for (const label of exempt) {
    if (/^<[^<>\r\n]+>$/.test(label)) angleExempt.add(label);
    else otherExempt.push(label);
  }
  const presentSet = new Set<string>();
  for (const match of expanded.matchAll(/<[^<>\r\n]+>/g)) {
    if (angleExempt.has(match[0])) presentSet.add(match[0]);
  }
  for (const label of otherExempt) {
    if (expanded.includes(label)) presentSet.add(label);
  }
  const presentExempt = [...presentSet].sort((a, b) => b.length - a.length);
  const afterTransform = (value: string) => applyRules(stripHome(value), allRules);
  const afterEntries = sanitizedAfter.flatMap((entry) => {
    const ciHome = stripHomeCi(entry.text);
    return ciHome !== entry.text && ciHome !== stripHome(entry.text) ? [entry, { ...entry, text: ciHome }] : [entry];
  });
  const afterSpellings = compileSpellings(afterEntries, afterTransform, exempt, presentExempt);
  const afterSpans = [
    ...findAcSpans(afterSpellings.ciAc, expanded),
    ...findCanonAcSpans(afterSpellings.canonAc, expanded),
    ...findAcSpans(afterSpellings.csAc, expanded),
  ];
  const mergedOriginals: string[] = [];
  const mergedLabels: string[] = [];
  const merged = applySpans(expanded, [...primarySpans, ...afterSpans], exempt, (match, as) => {
    const index = mergedOriginals.length;
    mergedOriginals.push(match);
    mergedLabels.push(as);
    return `${prefix}${index}${suffix}`;
  });
  const afterBearer = redactBearerMasked(stripHome(merged), mergedOriginals);
  const afterStandard = applyRules(afterBearer, preRandomRules);
  const postRandom = replaceMaskedRandom(afterStandard, mergedOriginals);
  return postRandom.replace(tokenRegex, (_tok, idx) => mergedLabels[Number(idx)] ?? "");
}

function trailingTokenRun(text: string): string {
  let i = text.length;
  while (i > 0 && /[A-Za-z0-9+/_-]/.test(text[i - 1]!)) i--;
  return i === text.length ? "" : text.slice(i);
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
