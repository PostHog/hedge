import { expect, test } from "bun:test";
import { bodyProblems } from "./proof-body.ts";

const noPicture = "body: the description has no picture. Fill the picture slot of pr-description's Changes section: a Mermaid diagram, a screenshot or video, or a `No picture: <why>.` line";
const overWords = (count: number) => `body: the description holds ${count} written words, over the 800-word cap of pr-description. The receipt, code, diagrams, template lines and comments are not counted. Fold it as pr-description's word budget says`;
const overBullets = (count: number) => `body: the merge-risk callout has ${count} bullets, over the cap of 6 with Switch-off and Tier. Move the other uncovered rows to Known issues`;
const callout = (lines: string[]) => `<!-- merge-risk -->\n${lines.join("\n")}\n<!-- /merge-risk -->\n`;
const bullets = (count: number, prefix = "> - ") => Array.from({ length: count }, (_, index) => `${prefix}row${index + 1}`);
const filler = (count: number) => Array.from({ length: count }, () => "word").join(" ");

test("a body without a merge-risk callout is not a pr-description body, so nothing is checked", () => {
  expect(bodyProblems(`## Problem\n\n${filler(900)}`)).toEqual([]);
});

test("a picture passes in every form that GitHub renders", () => {
  for (const picture of [
    "```mermaid\nflowchart LR\n  A --> B\n```",
    "> ```mermaid\n> flowchart LR\n> ```",
    "![the new tab](https://example.com/tab.png)",
    "![After][after]\n\n[after]: https://example.com/after.png",
    "<img src=\"https://example.com/a.png\">",
    "<video src=\"https://example.com/a.mp4\">",
    "https://github.com/user-attachments/assets/0f1e",
    "No picture: the diff shows it whole.",
    "**No picture:** the diff shows it whole.",
    "No picture: **the diff shows it whole.**",
    "`<!-- hedge-proof-receipt head=abc -->` opens the receipt.\n\n![shot](https://example.com/a.png)\n\n`<!-- /hedge-proof-receipt -->` closes it.",
  ]) expect(bodyProblems(`## Changes\n\n${picture}\n\n${callout(bullets(3))}`)).toEqual([]);
});

test("a picture that GitHub does not render fails: in a comment, in a code example, in inline code, in the receipt, or a No picture with no reason", () => {
  for (const hidden of [
    "<!-- ![old](https://example.com/old.png) -->",
    "<!-- No picture: the diff shows it whole. -->",
    "```md\n![example](https://example.com/a.png)\nNo picture: an example\n```",
    "Write `No picture: <why>` or `![alt](url)` here.",
    "See https://example.com/?next=https://github.com/user-attachments/assets/0f1e for the old one.",
    "<!-- hedge-proof-receipt head=abc -->\n![shot](https://example.com/a.png)\n<!-- /hedge-proof-receipt -->",
    "No picture:",
  ]) expect(bodyProblems(`## Changes\n\nA queue now retries.\n\n${hidden}\n\n${callout(bullets(3))}`)).toEqual([noPicture]);
});

test("the word cap counts written words only, leaving out the receipt, code, template lines and comments", () => {
  const uncounted = `<!-- hedge-proof-receipt head=abc -->\n${filler(500)}\n<!-- /hedge-proof-receipt -->\n\`\`\`\n${filler(300)}\n\`\`\`\`\n- [x] ${filler(50)}\n<!-- ${filler(40)} -->\n`;
  const body = (written: number) => `No picture: copy.\n${filler(written)}\n${uncounted}${callout(["> - **Tier:** non-critical"])}`;
  expect(bodyProblems(body(795))).toEqual([]);
  expect(bodyProblems(body(796))).toEqual([overWords(801)]);
});

test("a fence that closes with a longer run, or sits inside a quote, still leaves its code out of the count", () => {
  const log = `\`\`\`\n${filler(900)}\n\`\`\`\`\`\n`;
  const quoted = `> ~~~\n> ${filler(900)}\n> ~~~\n`;
  for (const code of [log, quoted]) expect(bodyProblems(`No picture: copy.\n${code}${callout(bullets(3))}`)).toEqual([]);
});

test("the callout holds six top-level bullets at most, however they are indented, up to its Rollout heading", () => {
  const rollout = ["", "## Rollout", "", "- **Stages:** one", "- **Watch:** two"];
  expect(bodyProblems(`No picture: copy.\n${callout([...bullets(6), ...rollout])}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy.\n${callout([...bullets(6), ">   - a nested detail", ">   - another nested detail"])}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy.\n${callout(bullets(7))}`)).toEqual([overBullets(7)]);
  expect(bodyProblems(`No picture: copy.\n${callout([">", ...bullets(7, ">   - ")])}`)).toEqual([overBullets(7)]);
  expect(bodyProblems(`No picture: copy.\n${callout([...bullets(4), "## Notes", ...bullets(3)])}`)).toEqual([overBullets(7)]);
  expect(bodyProblems(`No picture: copy.\n${callout([...bullets(6), "- one outside the quote"])}`)).toEqual([overBullets(7)]);
});

test("the check follows GitHub's rendering at the edges: a quote ends its fence, a comment hides a fence marker, CRLF fences close, and a fenced Rollout heading ends nothing", () => {
  expect(bodyProblems(`> \`\`\`\n> an example\n\n![after](https://example.com/after.png)\n${callout(bullets(3))}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy.\n<!--\n\`\`\`\n-->\n${filler(801)}\n${callout(bullets(3))}`)).toEqual([overWords(807)]);
  expect(bodyProblems(`No picture: copy.\r\n\`\`\`\r\n${filler(900)}\r\n\`\`\`\r\n${callout(bullets(3))}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy.\n${callout(["> ```", "> ## Rollout", "> ```", ...bullets(7)])}`)).toEqual([overBullets(7)]);
});

test("an opening receipt marker with no closing one hides nothing", () => {
  expect(bodyProblems(`<!-- hedge-proof-receipt head=abc -->\nan unclosed block\n\nNo picture: copy.\n${callout(bullets(3))}`)).toEqual([]);
});

test("an image reference without its definition renders as text, so it is no picture", () => {
  expect(bodyProblems(`![After][after]\n\n${callout(bullets(3))}`)).toEqual([noPicture]);
});

test("a deeply nested quote without a picture still gets its answer", () => {
  expect(bodyProblems(`${"> ".repeat(5000)}text\n${callout(bullets(3))}`)).toEqual([noPicture]);
});

test("formatting adds no words and hides no heading: R&D in a link or in bold is one word, and a bold Rollout heading still ends the callout's count", () => {
  const formatted = Array.from({ length: 4 }, () => "**R**&D [R&D](https://example.com)").join(" ");
  expect(bodyProblems(`No picture: copy.\n${filler(786)} ${formatted}\n${callout(bullets(3))}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy.\n${filler(787)} ${formatted}\n${callout(bullets(3))}`)).toEqual([overWords(801)]);
  expect(bodyProblems(`No picture: copy.\n${callout([...bullets(6), "", "## **Rollout**", "", "- **Stages:** one", "- **Watch:** two"])}`)).toEqual([]);
});
