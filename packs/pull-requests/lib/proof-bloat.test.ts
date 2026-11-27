import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, graded, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lines = (count: number, word: string) => Array.from({ length: count }, (_, index) => `${word} ${index}`).join("\n") + "\n";
const problem = "## Problem\n\nThe greeting drops the last name.\n\n";

async function grownPastLimit(pr: Checkout, body: string) {
  await pr.commit("feature.ts", lines(10, "greet"));
  pr.pullRequestState({ body: body + graded("non-critical") });
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.ts:2 | the greeting drops the last name | anchor: greet 1\n");
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting keeps it\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("retry.ts", lines(11, "retry"));
  return reviewed;
}

test("past 1.5 times the first lines, a fresh judge scores the cuttable share once per HEAD, and the sanity pass and end table carry it", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "BLOAT_JUDGE", JSON.stringify({ cuttable: 52, hunks: [{ citation: "retry.ts:1-11", reason: "the problem never retries" }] }));
  const reviewed = await grownPastLimit(pr, problem);

  const refusal = "Production lines grew from 10 at round 1 to 21 at HEAD, past 1.5 times the first. A fresh judge, bloat-judge-under-test, reads 52% of HEAD's production lines as more than the problem needs: retry.ts:1-11 (the problem never retries). Before another round, cut those hunks back to base behaviour, or justify each: hedge proof sanity --verdict cut|justified --reason '<why>'";
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(refusal);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(refusal);
  const prompts = judge.prompts();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("The greeting drops the last name.");
  expect(prompts[0]).toContain("+greet 9");
  expect(prompts[0]).toContain("+retry 10");
  expect(prompts[0]).not.toContain("the greeting keeps it");
  expect(prompts[0]).toContain(": 21 production lines");
  expect(prompts[0]).toContain("outside tests, docs, lockfiles and generated files. Leave those files out");

  expect((await pr.hedge("sanity", "--verdict", "justified", "--reason", "Retries are the fix")).code).toBe(0);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.hedge("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(report.find((line) => /^\| example\/product#42 \| \d+ rounds? \|/.test(line))).toBe(
    "| example/product#42 | 2 rounds | 10 → 21 (×2.1) | ×2.1, 52% cuttable; justified at HEAD: Retries are the fix | none |");
});

test("a judge that gives no score leaves the growth to be read by hand and is asked again at the next start", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "BLOAT_JUDGE", "I would cut the retries.");
  const reviewed = await grownPastLimit(pr, "");

  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "past 1.5 times the first. Read the growth by hand: the bloat judge bloat-judge-under-test gave no score: its answer is not the JSON asked for. Before another round");
  for (const answer of [{ cuttable: 101, hunks: [] }, { cuttable: 30, hunks: [] }, { cuttable: 30, hunks: [{ citation: " ", reason: "not needed" }] }, { cuttable: 30, hunks: [{ citation: "no citation available", reason: "not needed" }] }]) {
    judge.answer(JSON.stringify(answer));
    await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Read the growth by hand");
  }
  judge.answer(JSON.stringify({ cuttable: 0, hunks: [] }));
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "A fresh judge, bloat-judge-under-test, reads 0% of HEAD's production lines as more than the problem needs and names no hunk.");
  pr.env.HEDGE_PROOF_BLOAT_JUDGE_MODEL = undefined;
  await pr.commit("retry.ts", lines(12, "retry"));
  judge.answer("{}");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Read the growth by hand: the bloat judge a replacement command gave no score");
  const prompts = judge.prompts();
  expect(prompts).toHaveLength(7);
  expect(prompts[0]).toContain("The PR description has no Problem section.");
});

test("a later HEAD or an edited Problem section gets its own score, a gate shows no score of old inputs, and the end table names the commit of an older score", async () => {
  const pr = await checkout();
  const hunk = { citation: "retry.ts:1-11", reason: "the problem never retries" };
  const judge = fakeModel(pr, "BLOAT_JUDGE", JSON.stringify({ cuttable: 52, hunks: [hunk] }));
  const reviewed = await grownPastLimit(pr, problem);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("reads 52%");
  pr.pullRequestState({ body: "## Problem\n\nThe greeting drops the last name, and a slow store times it out.\n\n" + graded("non-critical") });
  judge.answer(JSON.stringify({ cuttable: 40, hunks: [hunk] }));
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("reads 40%");
  expect(judge.prompts()[1]).toContain("a slow store times it out");
  pr.pullRequestState({ body: problem + graded("non-critical") });
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  const unscored = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(unscored.find((line) => /^\| example\/product#42 \| \d+ rounds? \|/.test(line))).toBe("| example/product#42 | 1 round | 10 → 21 (×2.1) | not run | none |");
  judge.answer("no score");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("Read the growth by hand");
  judge.answer(JSON.stringify({ cuttable: 52, hunks: [hunk] }));
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("reads 52%");
  expect(judge.prompts()).toHaveLength(4);
  await pr.commit("retry.ts", lines(13, "retry"));
  judge.answer(JSON.stringify({ cuttable: 56, hunks: [hunk] }));
  pr.clock.now = new Date("2026-10-25T13:00:00Z");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("from 10 at round 1 to 23 at HEAD, past 1.5 times the first. A fresh judge, bloat-judge-under-test, reads 56%");
  const scored = await pr.git("rev-parse", "HEAD");
  await pr.commit("retry.ts", lines(5, "retry"));
  expect((await pr.hedge("sanity", "--verdict", "cut", "--reason", "Dropped most retries")).code).toBe(0);
  expect(judge.prompts()).toHaveLength(5);
  await pr.hedge("gate");
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(report.find((line) => /^\| example\/product#42 \| \d+ rounds? \|/.test(line))).toBe(
    `| example/product#42 | 1 round | 10 → 15 (×1.5) | ×2.3, 56% cuttable at ${scored.slice(0, 7)}; cut at HEAD: Dropped most retries | none |`);
});

test("diffs past the judge's cap are read by hand, a score saved after a gate leaves that gate standing, and a partial score file is skipped", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "BLOAT_JUDGE", JSON.stringify({ cuttable: 0, hunks: [] }));
  const reviewed = await grownPastLimit(pr, problem);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  await pr.hedge("gate");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("reads 0%");
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(report.find((line) => /^\| example\/product#42 \| \d+ rounds? \|/.test(line))).toBe("| example/product#42 | 1 round | 10 → 21 (×2.1) | not run | none |");

  mkdirSync(join(pr.pullRequest, "judge", "bloat"), { recursive: true });
  for (const name of ["0", "1"]) writeFileSync(join(pr.pullRequest, "judge", "bloat", `${name.repeat(40)}.json`), JSON.stringify({ cuttable: 0, hunks: [] }));
  await pr.commit("README.md", "x".repeat(300_001));
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "Read the growth by hand: the diffs pass the bloat judge's cap of 300000 characters. Before another round, cut the PR back to base behaviour");
  expect(judge.prompts()).toHaveLength(1);
  expect((await pr.hedge("gate")).output).toMatch(/^gate: (pass|fail)/m);
});

test("with no reviewer row in the model table, the growth is read by hand and the round still waits for the sanity pass", async () => {
  const pr = await checkout();
  const reviewed = await grownPastLimit(pr, problem);
  pr.env.HEDGE_PROOF_BLOAT_JUDGE = undefined;
  pr.env.HEDGE_MODELS = JSON.stringify([{ role: "lookup", work: "Find files", provider: "claude", model: "lookup-model", effort: "medium" }]);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    "past 1.5 times the first. Read the growth by hand: the bloat judge has no model: the model table of your AI plan has no review row. Before another round, cut the PR back to base behaviour, or justify the growth");
  expect((await pr.hedge("sanity", "--verdict", "cut", "--reason", "Dropped the retries")).code).toBe(0);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).code).toBe(0);
});

test("a round-one diff git cannot print leaves the growth to be read by hand, and the gate drops the score and saves its verdict", async () => {
  const pr = await checkout();
  const reviewed = await grownPastLimit(pr, problem);
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("reads 0%");
  const shim = join(pr.home, "failing-git");
  mkdirSync(shim);
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" --no-textconv "*" ${reviewed} "*) echo "fatal: bad object ${reviewed}" >&2; exit 128;; esac\nexec ${Bun.which("git")} "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  pr.env.PATH = `${shim}:${pr.env.PATH}`;
  pr.pullRequestState({ body: "## Problem\n\nThe greeting drops the last name and the title.\n\n" + graded("non-critical") });
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", reviewed)).rejects.toThrow(
    `past 1.5 times the first. Read the growth by hand: the bloat judge cannot run here: Cannot diff`);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  expect((await pr.hedge("gate")).output).toMatch(/^gate: (pass|fail)/m);
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
  expect(report.find((line) => /^\| example\/product#42 \| \d+ rounds? \|/.test(line))).toBe("| example/product#42 | 1 round | 10 → 21 (×2.1) | not run | none |");
});
