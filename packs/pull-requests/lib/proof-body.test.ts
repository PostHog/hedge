import { expect, test } from "bun:test";
import { bodyProblems, calloutBullets, countedWords } from "./proof-body.ts";

const callout = (bullets: number, rollout = "") =>
  `<!-- merge-risk -->\n> [!NOTE]\n> 🔵 **Merge risk: low** · two-way door\n${Array.from({ length: bullets }, (_, index) => `> - row ${index + 1}`).join("\n")}\n${rollout}<!-- /merge-risk -->\n`;

test("a body without a merge-risk callout is not a pr-description body, so nothing is checked", () => {
  expect(bodyProblems("## Problem\n\nA long body with no picture.")).toEqual([]);
});

test("a callout body passes with a Mermaid block, an image, a video, an attachment link or a No picture line", () => {
  for (const picture of ["```mermaid\nflowchart LR\n  A --> B\n```", "![the new tab](https://example.com/tab.png)", "<img src=\"https://example.com/a.png\">", "<video src=\"https://example.com/a.mp4\">", "https://github.com/user-attachments/assets/0f1e", "No picture: the diff shows it whole."]) {
    expect(bodyProblems(`## Changes\n\n${picture}\n\n${callout(3)}`)).toEqual([]);
  }
});

test("a callout body with no picture fails and names the picture slot", () => {
  expect(bodyProblems(`## Changes\n\nA queue now retries.\n\n\`\`\`ts\nretry()\n\`\`\`\n\n${callout(3)}`)).toEqual([
    "body: the description has no picture. Fill the picture slot of pr-description's Changes section: a Mermaid diagram, a screenshot or video, or a `No picture: <why>.` line",
  ]);
});

test("the word cap counts written words only, leaving out the receipt, code, template lines and comments", () => {
  const filler = (count: number) => Array.from({ length: count }, () => "word").join(" ");
  const uncounted = `<!-- hedge-proof-receipt head=abc -->\n${filler(500)}\n<!-- /hedge-proof-receipt -->\n\`\`\`mermaid\n${filler(300)}\n\`\`\`\n- [x] ${filler(50)}\n<!-- ${filler(40)} -->\n`;
  expect(countedWords(`${filler(10)}\n${uncounted}`)).toBe(10);
  const within = `${filler(700)}\n${uncounted}${callout(3)}`;
  expect(bodyProblems(within)).toEqual([]);
  const over = `${filler(800)}\n${uncounted}${callout(3)}`;
  expect(bodyProblems(over)).toEqual([
    `body: the description holds ${countedWords(over)} written words, over the 800-word cap of pr-description. The receipt, code, diagrams, template lines and comments are not counted. Fold it as pr-description's word budget says`,
  ]);
});

test("the callout holds six bullets at most, counting top-level bullets before its Rollout heading", () => {
  const rollout = "\n## Rollout\n\n- **Stages:** one\n- **Watch:** two\n";
  expect(calloutBullets(callout(6, rollout))).toBe(6);
  expect(calloutBullets("> - a\n- b, outside the quote\n>   - a sub-bullet\n")).toBe(2);
  expect(bodyProblems(`No picture: copy only.\n${callout(6, rollout)}`)).toEqual([]);
  expect(bodyProblems(`No picture: copy only.\n${callout(7)}`)).toEqual([
    "body: the merge-risk callout has 7 bullets, over the cap of 6 with Switch-off and Tier. Move the other uncovered rows to Known issues",
  ]);
});
