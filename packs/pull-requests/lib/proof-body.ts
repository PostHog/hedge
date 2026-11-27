import { riskCalloutOf } from "./decision-ledger.ts";

export const bodyWordCap = 800;
export const calloutBulletCap = 6;

const receipt = /<!-- (fleet|hedge)-proof-receipt\b[\s\S]*?<!-- \/(fleet|hedge)-proof-receipt -->/g;
const templateLine = /^[ \t]*[-*] (\[[ xX]\] .*|.*<!-- release-status:.*)$/gm;
const preformatted = /<pre\b[\s\S]*?<\/pre>/g;

const rendered = (markdown: string) => Bun.markdown.html(markdown.replace(receipt, "\n")).replace(/<!--[\s\S]*?-->/g, "\n");

function writtenWords(html: string) {
  const text = html.replace(preformatted, "\n").replace(/<[^>]*>/g, " ").replace(/&[#\w]+;/g, " & ");
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function pictured(html: string) {
  if (/<pre><code class="language-mermaid"/.test(html)) return true;
  const visible = html.replace(preformatted, "\n").replace(/<code>[\s\S]*?<\/code>/g, "");
  return /<(img|video)\b/i.test(visible)
    || visible.includes("https://github.com/user-attachments/assets/")
    || /<(p|li)>(<(strong|em)>)?No picture:(<\/(strong|em)>)?[ \t]*[^<\s]/.test(visible);
}

function topLevelItems(html: string) {
  const rollout = html.search(/<h[1-6]>Rollout\b/i);
  let depth = 0;
  let items = 0;
  for (const [, close, tag] of (rollout === -1 ? html : html.slice(0, rollout)).matchAll(/<(\/?)(ul|ol|li)\b/g)) {
    if (tag !== "li") depth += close ? -1 : 1;
    else if (!close && depth === 1) items += 1;
  }
  return items;
}

export function bodyProblems(body: string): string[] {
  const callout = riskCalloutOf(body);
  if (callout === undefined) return [];
  const words = writtenWords(rendered(body.replace(templateLine, "\n")));
  const bullets = topLevelItems(rendered(callout));
  return [
    ...pictured(rendered(body)) ? [] : ["body: the description has no picture. Fill the picture slot of pr-description's Changes section: a Mermaid diagram, a screenshot or video, or a `No picture: <why>.` line"],
    ...words > bodyWordCap ? [`body: the description holds ${words} written words, over the ${bodyWordCap}-word cap of pr-description. The receipt, code, diagrams, template lines and comments are not counted. Fold it as pr-description's word budget says`] : [],
    ...bullets > calloutBulletCap ? [`body: the merge-risk callout has ${bullets} bullets, over the cap of ${calloutBulletCap} with Switch-off and Tier. Move the other uncovered rows to Known issues`] : [],
  ];
}
