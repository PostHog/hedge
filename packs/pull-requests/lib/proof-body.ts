import { riskCalloutOf } from "./decision-ledger.ts";

export const bodyWordCap = 800;
export const calloutBulletCap = 6;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function take(text: string, pattern: RegExp): string {
  return text.replace(pattern, "\n");
}

export function countedWords(body: string) {
  const withoutReceipt = take(body, /<!-- (fleet|hedge)-proof-receipt\b[\s\S]*?<!-- \/(fleet|hedge)-proof-receipt -->/g);
  const withoutCode = take(withoutReceipt, /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm);
  const withoutTemplateLines = take(withoutCode, /^[ \t]*[-*] (\[[ xX]\] .*|.*<!-- release-status:.*)$/gm);
  return words(take(withoutTemplateLines, /<!--[\s\S]*?-->/g));
}

const pictured = (body: string) =>
  /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b/m.test(body)
  || /!\[[^\]]*\]\([^)]+\)/.test(body)
  || /<(img|video)\b/i.test(body)
  || /https:\/\/github\.com\/user-attachments\/assets\//.test(body)
  || /No picture:/.test(body);

export function calloutBullets(callout: string) {
  const lines = callout.split("\n");
  const end = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).filter((line) => /^(>[ \t]?)?[-*+][ \t]+\S/.test(line)).length;
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
