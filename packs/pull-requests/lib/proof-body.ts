import { riskCalloutOf } from "./decision-ledger.ts";

export const bodyWordCap = 800;
export const calloutBulletCap = 6;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const quotePrefix = /^(?: {0,3}>[ \t]?)*/;

function withoutFences(text: string, keep: (info: string) => boolean) {
  const kept: string[] = [];
  let open: { marker: string; length: number; keep: boolean } | undefined;
  for (const line of text.split("\n")) {
    const inner = line.replace(quotePrefix, "");
    if (open) {
      const close = new RegExp(`^ {0,3}${open.marker === "`" ? "`" : "~"}{${open.length},}[ \\t]*$`).test(inner);
      if (open.keep) kept.push(line);
      if (close) open = undefined;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(inner);
    if (fence && !(fence[1]!.startsWith("`") && fence[2]!.includes("`"))) {
      open = { marker: fence[1]![0]!, length: fence[1]!.length, keep: keep(fence[2]!.trim()) };
      if (open.keep) kept.push(line);
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

const withoutReceipt = (body: string) => body.replace(/<!-- (fleet|hedge)-proof-receipt\b[\s\S]*?<!-- \/(fleet|hedge)-proof-receipt -->/g, "\n");
const withoutComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "\n");

function countedWords(body: string) {
  const prose = withoutFences(withoutReceipt(body), () => false).replace(/^[ \t]*[-*] (\[[ xX]\] .*|.*<!-- release-status:.*)$/gm, "\n");
  return words(withoutComments(prose));
}

const mermaid = (text: string) => /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b/m.test(text.split("\n").map((line) => line.replace(quotePrefix, "")).join("\n"));

function pictured(body: string) {
  const prose = withoutComments(withoutReceipt(body));
  if (mermaid(withoutFences(prose, (info) => /^mermaid\b/.test(info)))) return true;
  const visible = withoutFences(prose, () => false).replace(/(`+)[^`]*?\1/g, "");
  return /!\[[^\]]*\](\([^)]+\)|\[[^\]]*\])/.test(visible)
    || /<(img|video)\b/i.test(visible)
    || /https:\/\/github\.com\/user-attachments\/assets\//.test(visible)
    || /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+))*(?:\*\*)?No picture:(?:\*\*)?[ \t]*\S/m.test(visible);
}

function calloutBullets(callout: string) {
  const lines = callout.split("\n");
  const rollout = lines.findIndex((line) => /^(?:>[ \t]?)*#{1,6}[ \t]+Rollout\b/i.test(line));
  const markers = (rollout === -1 ? lines : lines.slice(0, rollout)).flatMap((line) => {
    const item = /^( *)[-*+][ \t]+\S/.exec(line.replace(/^(?: {0,3}>)+[ \t]?/, "").replace(/\t/g, "    "));
    return item ? [item[1]!.length] : [];
  });
  const top = Math.min(...markers);
  return markers.filter((indent) => indent - top < 2).length;
}

export function bodyProblems(body: string): string[] {
  const callout = riskCalloutOf(body);
  if (callout === undefined) return [];
  const counted = countedWords(body);
  const bullets = calloutBullets(callout);
  return [
    ...pictured(body) ? [] : ["body: the description has no picture. Fill the picture slot of pr-description's Changes section: a Mermaid diagram, a screenshot or video, or a `No picture: <why>.` line"],
    ...counted > bodyWordCap ? [`body: the description holds ${counted} written words, over the ${bodyWordCap}-word cap of pr-description. The receipt, code, diagrams, template lines and comments are not counted. Fold it as pr-description's word budget says`] : [],
    ...bullets > calloutBulletCap ? [`body: the merge-risk callout has ${bullets} bullets, over the cap of ${calloutBulletCap} with Switch-off and Tier. Move the other uncovered rows to Known issues`] : [],
  ];
}
