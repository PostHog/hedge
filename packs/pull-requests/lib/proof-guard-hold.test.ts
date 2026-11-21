import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSection } from "./proof-receipt.ts";
import { renderPage } from "./proof-receipt-page.ts";
import type { ProofSummary } from "./proof.ts";
import { acceptGap, cleanFixtures, checkout, fakeModel, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const token = ["gh", "p_", "a1B2c3D4e5".repeat(4)].join("");
const escapedTooDeeply = `\\u005c${"u005c".repeat(10)}u0061`;

const authorsAnswers = "responses.md";

function storedFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return storedFiles(path);
    return name === authorsAnswers ? [] : [readFileSync(path, "utf8")];
  });
}

const leaked = (pr: Checkout, output: string, value: string) => [output, ...storedFiles(pr.pullRequest)].some((text) => text.includes(value));

async function judged(answer: string) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr, "- minor | feature.txt:1 | the log prints a token\n");
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: ${answer}\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  return { pr, judge: fakeModel(pr, "JUDGE", verdict()) };
}

async function reviewed(description: string) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await pr.hedge("require", "--none", "--reason", "Docs only");
  pr.pullRequestState({ body: `Greets new members. Merge risk: medium.\n\n${description}\n` });
  return { pr, reviewer: fakeModel(pr, "REVIEWER", "No findings.\n") };
}

test("the judge gets no prompt that the secret guard matches, and the gate names the kind", async () => {
  const { pr, judge } = await judged(`removed ${token} from the log.`);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("judge: unavailable (the secret guard matches this prompt: GitHub token)");
  expect(judge.prompts()).toEqual([]);
  expect(leaked(pr, gate.output, token)).toBe(false);
});

test("the judge still gets a prompt the secret guard does not match", async () => {
  const { pr, judge } = await judged("removed the token from the log.");

  expect((await pr.hedge("gate")).code).toBe(0);
  expect(judge.prompts()).toHaveLength(1);
});

test("a single review sends no prompt that the secret guard matches, and fails with the kind", async () => {
  const { pr, reviewer } = await reviewed(`The old token was ${token}.`);

  const review = pr.hedge("review", "--single");
  await expect(review).rejects.toThrow("gave no findings (the secret guard matches this prompt: GitHub token)");
  await expect(review).rejects.not.toThrow(token);
  expect(reviewer.prompts()).toEqual([]);
  expect(leaked(pr, "", token)).toBe(false);
});

test("a single review sends no prompt with text escaped too deeply for the guard to check", async () => {
  const { pr, reviewer } = await reviewed(escapedTooDeeply);

  await expect(pr.hedge("review", "--single")).rejects.toThrow("gave no findings (the secret guard matches this prompt: text escaped too deeply to check)");
  expect(reviewer.prompts()).toEqual([]);
});

test("a single review still sends a prompt the secret guard does not match", async () => {
  const { pr, reviewer } = await reviewed("The old token is gone.");

  expect((await pr.hedge("review", "--single")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(1);
});

async function heldWithAcceptedGaps(condition: string[], answer = `removed ${token} from the log.`) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr, "- minor | feature.txt:1 | the log prints a token\n");
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: ${answer}\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--kinds", "prod-shape");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access");
  const id = /\[(d-[0-9a-f]+)\]/.exec((await acceptGap(pr, "prod-shape", ...condition)).output)![1]!;
  const judge = fakeModel(pr, "JUDGE", verdict());
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge prompt quotes a test token");
  pr.chooseGap("judge", "The judge prompt quotes a test token");
  await acceptGap(pr, "judge");
  return { pr, judge, id };
}

test("an accepted judge gap does not pass a gate whose held judge could not check the condition of an accepted gap", async () => {
  const { pr, judge, id } = await heldWithAcceptedGaps(["--condition", "feature.txt reads no stored rows"]);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(3);
  const refusal = `not accepted (the secret guard held the judge prompt, so no judge checked the condition of decision ${id})`;
  expect(gate.output).toContain(`judge gap: ${refusal}`);
  expect(gate.output).toContain(`hedge decision void <id>`);
  expect(judge.prompts()).toEqual([]);

  const jsonGate = await pr.hedge("gate", "--json");
  expect(jsonGate.code).toBe(3);
  const summary = JSON.parse(jsonGate.output) as ProofSummary;
  expect(summary.judge.gap?.accepted).toBeUndefined();
  expect(summary.judge.gap?.text).toBe(refusal);

  const display = { lines: {}, screenshots: [] };
  const { section } = renderSection({
    summary, gated: true, landed: false, display, notChecked: [], reviews: [], screenshots: [],
  });
  expect(section).toContain("judge: The judge prompt quotes a test token (not accepted)");

  const page = renderPage({
    summary, title: "Test PR", commits: [], records: [], rounds: [], verdicts: [],
    display, decisions: [], notChecked: [], notes: {},
  });
  expect(page).toMatch(/\| judge \| `[^`]+` \| The judge prompt quotes a test token \| \| \| not accepted \|/);
});

test("an accepted judge gap still passes a conditional gap when the judge is unavailable for a cause other than the guard", async () => {
  const { pr, judge } = await heldWithAcceptedGaps(["--condition", "feature.txt reads no stored rows"], "removed the token from the log.");
  judge.answer("");

  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("judge: unavailable (empty answer)");
  expect(gate.code).toBe(0);
  expect(judge.prompts()).toHaveLength(1);
});

test("an accepted judge gap still passes a gate whose held judge had no condition to check", async () => {
  const { pr, judge } = await heldWithAcceptedGaps([]);

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).toContain("judge: unavailable (the secret guard matches this prompt: GitHub token)");
  expect(judge.prompts()).toEqual([]);
});

test("a held judge that could not check a standing rule's condition says to clear the match, not to meet the condition", async () => {
  const pr = await checkout();
  const rule = "Until 2026-11-26, in example/product, accept a live-run gap that only a billable run from main can prove.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `- \`hedge proof standing --kind live-run --until 2026-11-26 --repositories example/product --rule "${rule}"\`\n`);
  await pr.hedge("standing", "--kind", "live-run", "--until", "2026-11-26", "--repositories", "example/product", "--rule", rule);
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr, "- minor | feature.txt:1 | the log prints a token\n");
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: removed ${token} from the log.\n`);
  await pr.hedge("respond", "--round", "1", "responses.md");
  await pr.hedge("require", "--kinds", "live-run");
  await pr.hedge("gap", "--kind", "live-run", "--reason", "only a billable run from main proves it");
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge prompt quotes a test token");
  pr.chooseGap("judge", "The judge prompt quotes a test token");
  await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42");
  const judge = fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(3);
  expect(gate.output).toContain("so no judge checked the condition of standing rule live-run until 2026-11-26)");
  expect(gate.output).toContain("Remove the value the secret guard matches so the judge can check standing rule live-run until 2026-11-26, then run hedge proof gate again");
  expect(gate.output).not.toContain("Meet the condition");
  expect(judge.prompts()).toEqual([]);
});
