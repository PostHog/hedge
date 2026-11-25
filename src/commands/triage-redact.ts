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
const allRules: Rule[] = [...secretRules, ...standardRules, randomRule];
const preRandomRules: Rule[] = [...secretRules, ...standardRules];

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

type CompiledMatcher = {
  ciRegex?: RegExp;
  ciMap: Map<string, { as: string; owner: KnownName }>;
  csRegex?: RegExp;
  csMap: Map<string, { as: string; owner: KnownName }>;
};

function compileSpellings(entries: KnownName[], transform?: (value: string) => string, exempt?: Set<string>, presentExempt?: string[]): CompiledMatcher {
  const raw = entries
    .filter((entry) => typeof entry.text === "string" && typeof entry.as === "string" && entry.text.length >= (entry.after ? 1 : 2))
    .flatMap((entry) => {
      const minLength = entry.after ? 1 : 2;
      const safeAs = applyRules(entry.as, secretRules);
      const variants = [entry.text, applyRules(entry.text, secretRules), encodeUri(entry.text), entry.text.replace(/ /g, "+")];
      if (transform) {
        variants.push(transform(entry.text));
        if (!entry.text.startsWith("/")) {
          const prefixed = transform(`/${entry.text}`);
          variants.push(prefixed.startsWith("/") ? prefixed.slice(1) : prefixed);
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
  const ciMap = new Map<string, { as: string; owner: KnownName }>();
  const csMap = new Map<string, { as: string; owner: KnownName }>();
  for (const name of raw) {
    const left = name.after && /^[~<]/.test(name.text) ? "" : "(?<![\\w-])";
    const right = name.after && /[>]$/.test(name.text) ? "" : "(?![\\w-])";
    const pattern = `${left}${escape(name.text)}${right}`;
    if (name.text.length < 4) {
      if (!csMap.has(name.text)) {
        csMap.set(name.text, { as: name.as, owner: name.owner });
        csItems.push({ len: name.text.length, pattern });
      }
    } else {
      const key = name.text.toLowerCase();
      if (!ciMap.has(key)) {
        ciMap.set(key, { as: name.as, owner: name.owner });
        ciItems.push({ len: name.text.length, pattern });
      }
    }
  }
  const byLen = (a: { len: number; exempt?: boolean }, b: { len: number; exempt?: boolean }) => b.len - a.len || Number(Boolean(b.exempt)) - Number(Boolean(a.exempt));
  const exemptItems = presentExempt?.map((label) => ({ len: label.length, pattern: escape(label), exempt: true })) ?? [];
  return {
    ...(ciItems.length ? { ciRegex: new RegExp([...ciItems, ...exemptItems].sort(byLen).map((item) => item.pattern).join("|"), "gi") } : {}),
    ciMap,
    ...(csItems.length ? { csRegex: new RegExp([...csItems, ...exemptItems].sort(byLen).map((item) => item.pattern).join("|"), "g") } : {}),
    csMap,
  };
}

function applySpellings(text: string, matcher: CompiledMatcher, exempt?: Set<string>, skipOwner?: KnownName) {
  let result = text;
  if (matcher.ciRegex) {
    result = result.replace(matcher.ciRegex, (match) => {
      if (exempt?.has(match)) return match;
      const hit = matcher.ciMap.get(match.toLowerCase());
      return !hit || (skipOwner && hit.owner === skipOwner) ? match : hit.as;
    });
  }
  if (matcher.csRegex) {
    result = result.replace(matcher.csRegex, (match) => {
      if (exempt?.has(match)) return match;
      const hit = matcher.csMap.get(match);
      return !hit || (skipOwner && hit.owner === skipOwner) ? match : hit.as;
    });
  }
  return result;
}

const reservedWord = new RegExp(String.raw`^(?:${secretKey}|bearer|basic|auth|code|sig|key|users|home)$`, "i");

export function redact(text: string, home: string, known: KnownName[] = []): string {
  const stripHome = (value: string) => (home.length > 1 ? value.split(home.replace(/\/$/, "")).join("~") : value);
  const valid = known.filter((entry) => typeof entry.text === "string" && typeof entry.as === "string");
  const primary = valid.filter((entry) => !entry.after && !reservedWord.test(entry.text));
  const after = valid.filter((entry) => entry.after || reservedWord.test(entry.text)).map((entry) => (entry.after ? entry : { ...entry, after: true }));

  const usedNonces = new Set<number>();
  for (const part of [text, home, ...valid.flatMap((entry) => [entry.text, entry.as])]) {
    for (const match of part.matchAll(/~\.(\d+)\./g)) usedNonces.add(Number(match[1]));
  }
  let nonce = 0;
  while (usedNonces.has(nonce)) nonce++;
  const prefix = `~.${nonce}.`;
  const suffix = ".~";

  const rawPrimarySpellings = compileSpellings(primary);
  const sanitizeLabel = (entry: KnownName) => applyRules(stripHome(applySpellings(entry.as, rawPrimarySpellings, undefined, entry)), allRules);

  const labels: string[] = [];
  const originals: string[] = [];
  const maskedEntries = primary.map((entry) => {
    const index = labels.length;
    labels.push(sanitizeLabel(entry));
    originals.push(entry.text);
    return { ...entry, as: `${prefix}${index}${suffix}` };
  });
  const maskedSpellings = compileSpellings(maskedEntries);
  const tokenPattern = `${escape(prefix)}(\\d+)${escape(suffix)}`;
  const tokenRegex = new RegExp(tokenPattern, "g");
  const tokenOrChunk = new RegExp(`[A-Za-z0-9+/_-]+|${tokenPattern}`, "g");

  const replaceMaskedRandom = (value: string) => {
    let out = "";
    let pos = 0;
    let runStart = -1;
    let runEnd = -1;
    const flush = () => {
      if (runStart === -1) return;
      let end = runEnd;
      let eq = 0;
      while (eq < 2 && value[end] === "=") {
        end++;
        eq++;
      }
      const slice = value.slice(runStart, end);
      const expanded = slice.replace(tokenRegex, (_tok, idx) => originals[Number(idx)] ?? "");
      out += value.slice(pos, runStart);
      out += expanded.length >= tokenLetters && looksRandom(expanded) ? "<secret>" : slice;
      pos = end;
      runStart = -1;
      runEnd = -1;
    };
    tokenOrChunk.lastIndex = 0;
    for (let match = tokenOrChunk.exec(value); match !== null; match = tokenOrChunk.exec(value)) {
      if (match[1] !== undefined && !/^[A-Za-z0-9+/_-]+$/.test(originals[Number(match[1])] ?? "")) {
        flush();
        continue;
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

  const passOne = (value: string) => {
    let next = applyRules(stripHome(applySpellings(value, maskedSpellings)), preRandomRules);
    next = replaceMaskedRandom(next);
    return next.replace(tokenRegex, (_tok, idx) => labels[Number(idx)] ?? "");
  };

  const result = passOne(text);
  const sanitizedAfter = after.map((entry) => ({ ...entry, as: sanitizeLabel(entry) }));
  const exempt = new Set([...redactorLabels, ...labels, ...sanitizedAfter.map((entry) => entry.as)]);
  const presentExempt = [...exempt].filter((label) => result.includes(label)).sort((a, b) => b.length - a.length);
  const afterSpellings = compileSpellings(sanitizedAfter, passOne, exempt, presentExempt);
  return applySpellings(result, afterSpellings, exempt);
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
