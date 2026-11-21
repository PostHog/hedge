import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, markPanel, productionMajor, reviewHeadFixed, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const short = (commit: string) => commit.slice(0, 7);
const reviews = (pr: Checkout) => join(pr.pullRequest, "reviews");
const finalRead = (pr: Checkout, base: string) => pr.hedge("review", "--scope", "final", "--base", base);
const firstLine = (output: string) => JSON.parse(output.split("\n")[0]!) as { round: string; id: string };

async function prWithStrayRead(strayGreeting?: string) {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHeadFixed(pr, "feature.txt:1", "greet");
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  const fixed = await pr.commit("feature.txt", "greet the member\n");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");
  expect((await finalRead(pr, reviewed)).code).toBe(0);
  await pr.git("checkout", "-q", "-b", "other", "main");
  if (strayGreeting) await pr.commit("feature.txt", strayGreeting);
  const stray = await pr.commit("other.txt", "another PR\n");
  reviewer.answer(productionMajor("other.txt:1", "another PR"));
  expect((await finalRead(pr, fixed)).code).toBe(0);
  await pr.git("checkout", "-q", "feature");
  const head = await pr.commit("feature.txt", "greet the new member\n");
  reviewer.answer("No findings.");
  return { pr, reviewed, fixed, stray, head, reviewer };
}

test("a final read continues from the latest review on HEAD's history, and the gate holds the read of another branch until it is answered", async () => {
  const { pr, fixed, head, reviewer } = await prWithStrayRead();

  const read = await finalRead(pr, fixed);

  expect(read.code).toBe(0);
  expect(firstLine(read.output)).toMatchObject({ round: "final", id: "final-3" });
  expect(reviewer.prompts().at(-1)).toContain("+greet the new member");
  expect(existsSync(join(reviews(pr), "dropped"))).toBe(false);
  fakeModel(pr, "JUDGE", verdict());
  const held = (await pr.hedge("gate")).output;
  expect(held).toContain("review: HEAD reviewed in final read 3");
  expect(held).toContain("review: final read 2 has unanswered findings 1");
  writeFileSync(join(pr.repository, "responses.md"), `1. rejected: final read 2 read another PR's checkout, not ${head}\n`);
  expect((await pr.hedge("respond", "--round", "final-2", "responses.md")).code).toBe(0);
  expect((await pr.hedge("gate")).output).not.toContain("unanswered findings");
});

test("a final read from the latest reviewed commit keeps a final read of another branch", async () => {
  const { pr, stray } = await prWithStrayRead();

  const read = await finalRead(pr, stray);

  expect(firstLine(read.output)).toMatchObject({ round: "final", id: "final-3" });
  expect(existsSync(join(reviews(pr), "dropped"))).toBe(false);
});

test("a final read from an older review names both commits it may start from", async () => {
  const { pr, reviewed, fixed, stray } = await prWithStrayRead();

  await expect(finalRead(pr, reviewed)).rejects.toThrow(`Final read base must be the latest reviewed commit ${stray}, the latest reviewed commit on HEAD's history ${fixed}, or a clean base merge the gate carried it to`);
  expect(readdirSync(reviews(pr)).sort()).toEqual(["1", "final-1", "final-2"]);
});

test("a final read from a clean base merge of the latest review on HEAD's history is refused when that merge is off HEAD's history", async () => {
  const { pr, fixed, stray } = await prWithStrayRead();
  await pr.advanceBase("base.txt", "from main\n");
  const feature = await pr.git("rev-parse", "HEAD");
  await pr.git("checkout", "-q", "-b", "sibling", fixed);
  await pr.git("merge", "-q", "--no-edit", "origin/main");
  const merged = await pr.git("rev-parse", "HEAD");
  await pr.git("checkout", "-q", "feature");
  expect(await pr.git("rev-parse", "HEAD")).toBe(feature);

  await expect(pr.hedge("review", "--scope", "final", "--base", merged, "--phase", "babysit")).rejects.toThrow(`Final read base must be the latest reviewed commit ${stray}, the latest reviewed commit on HEAD's history ${fixed}`);
});

for (const phase of ["review", "babysit"]) test(`a ${phase} final read from the latest review on HEAD's history is refused when the first panel read another branch`, async () => {
  const { pr, fixed, stray } = await prWithStrayRead("greet the new member\n");
  for (const file of ["panel.json", "lenses"]) rmSync(join(reviews(pr), "1", file), { recursive: true });
  markPanel(pr, "final-2");

  await expect(pr.hedge("review", "--scope", "final", "--base", fixed, "--phase", phase)).rejects.toThrow(`The first panel read ${stray}, which is not on HEAD's history, so a final read from ${short(fixed)} would skip what no panel of this PR read`);
  expect(readdirSync(reviews(pr)).sort()).toEqual(["1", "final-1", "final-2"]);
});

async function prOnOtherHead() {
  const pr = await checkout();
  await pr.git("checkout", "-q", "-b", "other", "main");
  const other = await pr.commit("other.txt", "another PR\n");
  await pr.git("checkout", "-q", "feature");
  const head = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.githubHead(other);
  return { pr, other, head };
}

test("a review refuses a checkout whose HEAD is not the PR's head on GitHub, before it reserves a round", async () => {
  const { pr, other, head } = await prOnOtherHead();
  const refusal = `HEAD ${short(head)} is not on example/product#42, whose head on GitHub is ${short(other)}`;

  await expect(pr.hedge("review-start", "--scope", "full")).rejects.toThrow(refusal);
  await expect(pr.hedge("review", "--single")).rejects.toThrow(refusal);
  expect(existsSync(reviews(pr))).toBe(false);
});

test("a review takes a HEAD that adds unpushed commits to the PR's head", async () => {
  const { pr, head } = await prOnOtherHead();
  pr.githubHead(head);
  await pr.commit("feature.txt", "greet the member\n");

  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
});

test("a review of an explicit --commit skips the check of the checkout", async () => {
  const { pr, head } = await prOnOtherHead();

  expect((await pr.hedge("review-start", "--scope", "full", "--commit", head)).code).toBe(0);
});

test("a review refuses to resume a round of a checkout whose HEAD is not the PR's head on GitHub", async () => {
  const { pr, other, head } = await prOnOtherHead();
  pr.env.HEDGE_PROOF_REVIEWER = "cat >/dev/null; echo 'the reviewer failed' >&2; exit 1";
  await expect(pr.hedge("review", "--single", "--commit", head)).rejects.toThrow("the reviewer failed");

  await expect(pr.hedge("review", "--single")).rejects.toThrow(`HEAD ${short(head)} is not on example/product#42, whose head on GitHub is ${short(other)}`);
});

test("a review refuses to rerun a panel of a checkout whose HEAD is not the PR's head on GitHub", async () => {
  const { pr, other, head } = await prOnOtherHead();
  pr.panel.lostWorkers = true;
  expect((await pr.hedge("review", "--lens", "correctness", "--commit", head)).code).toBe(0);
  pr.panel.lostWorkers = false;

  await expect(pr.hedge("review", "--lens", "correctness")).rejects.toThrow(`HEAD ${short(head)} is not on example/product#42, whose head on GitHub is ${short(other)}`);
});
