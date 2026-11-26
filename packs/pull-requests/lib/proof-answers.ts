import { readThreadWords, t3UserData, withT3Session, type ThreadWord } from "../../base/lib/t3/index.ts";
import { t3StatePath } from "../../base/lib/prune.ts";

export type { ThreadWord };
export type HeardAnswer = { thread: string; message: string; words: string; answered: string; at: string; source: ThreadWord["source"] };
export type ThreadWords = (thread: string) => Promise<ThreadWord[]>;

export const normalized = (text: string) => text.toLowerCase().replace(/[`*_"“”‘’']/g, "").replace(/\s+/g, " ").trim();
export function unlinked(text: string) {
  let plain = "";
  let rest = text;
  for (let link = /\[([^\]]*)\]\(/.exec(rest); link; link = /\[([^\]]*)\]\(/.exec(rest)) {
    const close = closingParenthesis(rest, link.index + link[0].length);
    if (close === undefined) break;
    plain += rest.slice(0, link.index) + link[1];
    rest = rest.slice(close + 1);
  }
  return plain + rest;
}

function closingParenthesis(text: string, from: number) {
  let depth = 1;
  let quote: string | undefined;
  for (let index = from; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") { index++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if ((char === '"' || char === "'") && /\s/.test(text[index - 1] ?? "")) quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return undefined;
}

export const t3ThreadWords = (home: string): ThreadWords => (thread) =>
  withT3Session((client) => readThreadWords(client, thread, t3StatePath(t3UserData(home))), { home })
    .catch((error: Error) => { throw new Error(`Cannot read T3 thread ${thread} (${error.message})`); });
