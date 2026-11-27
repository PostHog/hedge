import { riskCalloutOf } from "./decision-ledger.ts";

export const bodyWordCap = 800;
export const calloutBulletCap = 6;

const pictureMark = "\u0001";
const codeOpen = "\u0002";
const codeClose = "\u0003";
const rawOpen = "\u0004";
const rawClose = "\u0005";
const rawChunk = new RegExp(`${rawOpen}([^${rawClose}]*)${rawClose}`, "g");
const templateLine = /^[ \t]*[-*] (\[[ xX]\] .*|.*<!-- release-status:.*)$/gm;
const receiptMarker = /^<!-- \/?(fleet|hedge)-proof-receipt\b/;
const media = /<(img|video)\b/i;
const markers = /[\u0001-\u0005]/g;

function rawBlock(raw: string) {
  const shown = raw.split(/<!--[\s\S]*?-->/).join(" ");
  return `${media.test(shown) ? pictureMark : ""} ${shown.split(/<[^>]*>/).join(" ")}\n\n`;
}

type Shape = { text: string; visible: string; topLevelItems: number };

function shapeOf(markdown: string): Shape {
  let inReceipt = false;
  let closingsAhead = markdown.match(/<!-- \/(fleet|hedge)-proof-receipt -->/g)?.length ?? 0;
  let afterRollout = false;
  let topLevelItems = 0;
  const kept = (text: string) => inReceipt ? "" : text;
  const block = (children: string) => kept(`${children}\n\n`);
  const rendered = Bun.markdown.render(markdown, {
    text: (written: string) => /^<[\s\S]*>$/.test(written) ? `${rawOpen}${written.replace(markers, "")}${rawClose}` : kept(written.replace(markers, "")),
    html: (children: string) => {
      const raw = children.replace(rawChunk, "$1").trim();
      if (receiptMarker.test(raw)) {
        const closing = raw.startsWith("<!-- /");
        if (closing) closingsAhead -= 1;
        inReceipt = !closing && closingsAhead > 0;
        return "\n\n";
      }
      return kept(rawBlock(raw));
    },
    codespan: (children: string) => kept(`${codeOpen}${children.replace(rawChunk, "$1")}${codeClose}`),
    code: (_children: string, meta?: { language?: string }) => kept(/^mermaid\b/.test(meta?.language ?? "") ? `${pictureMark}\n\n` : "\n\n"),
    image: () => kept(pictureMark),
    heading: (children: string) => {
      if (!inReceipt && /^Rollout\b/i.test(children.trim())) afterRollout = true;
      return block(children);
    },
    listItem: (children: string, meta?: { depth?: number }) => {
      if (!inReceipt && !afterRollout && meta?.depth === 0) topLevelItems += 1;
      return kept(`${children}\n`);
    },
    paragraph: block,
    th: (children: string) => kept(` ${children} `),
    td: (children: string) => kept(` ${children} `),
    tr: (children: string) => kept(`${children}\n`),
    hr: () => "\n\n",
  });
  const text = rendered.replace(rawChunk, (_chunk, raw: string) => /^<(img|video)\b/i.test(raw) ? pictureMark : " ");
  const visible = text.replace(new RegExp(`${codeOpen}[^${codeClose}]*${codeClose}`, "g"), " ");
  return { text: text.replaceAll(codeOpen, "").replaceAll(codeClose, "").replaceAll(pictureMark, " "), visible, topLevelItems };
}

const writtenWords = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

const pictured = ({ visible }: Shape) => visible.includes(pictureMark)
  || /(^|\s)https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/m.test(visible)
  || /^[ \t]*No picture:[ \t]*\S/m.test(visible);

export function bodyProblems(body: string): string[] {
  const callout = riskCalloutOf(body);
  if (callout === undefined) return [];
  const words = writtenWords(shapeOf(body.replace(templateLine, "\n")).text);
  const bullets = shapeOf(callout).topLevelItems;
  return [
    ...pictured(shapeOf(body)) ? [] : ["body: the description has no picture. Fill the picture slot of pr-description's Changes section: a Mermaid diagram, a screenshot or video, or a `No picture: <why>.` line"],
    ...words > bodyWordCap ? [`body: the description holds ${words} written words, over the ${bodyWordCap}-word cap of pr-description. The receipt, code, diagrams, template lines and comments are not counted. Fold it as pr-description's word budget says`] : [],
    ...bullets > calloutBulletCap ? [`body: the merge-risk callout has ${bullets} bullets, over the cap of ${calloutBulletCap} with Switch-off and Tier. Move the other uncovered rows to Known issues`] : [],
  ];
}
