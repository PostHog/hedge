import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armOf } from "./proof-triage.ts";
import { checkout, cleanFixtures, fakeModel, graded, markPanel, recordingModel, settings, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const findings = [
  "- blocker | feature.ts:1 | A name with a space throws: greet(\"a b\") crashes the signup form | anchor: export const greet",
  "- major | feature.ts:1 | The helper could say more about its contract | anchor: export const greet",
  "- minor | feature.ts:1 | Rename name to person | anchor: export const greet",
  "- feature.ts:1 | The greeting reads oddly | anchor: export const greet",
  "- nit: tidy the import order",
  "",
  "TESTS:",
  "",
  "- feature.test.ts:1 | The test asserts a mock | anchor: test(",
].join("\n");

const labels = (...items: [number, string, string][]) => JSON.stringify({ labels: items.map(([finding, label, reason]) => ({ finding, label, reason })) });
const adviseSecond = labels([1, "needs-answer", "names a trigger"], [2, "advisory", "names no trigger and no requirement"], [4, "advisory", "a matter of taste"]);

async function treated(triage = "on", number = 42) {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": triage });
  pr.pullRequestState({ body: graded("non-critical", "medium"), number });
  await pr.commit("feature.ts", "export const greet = (name: string) => name;\n");
  await pr.hedge("require", "--none", "--reason", "fixture", "--repo", "example/product", "--pr", String(number));
  fakeModel(pr, "REVIEWER", findings);
  return pr;
}

const reviewDirectory = (pr: Checkout, round = "1") => join(pr.pullRequest, "reviews", round);
const savedLabels = (pr: Checkout, round = "1") => JSON.parse(readFileSync(join(reviewDirectory(pr, round), "triage-labels.json"), "utf8"));

async function respond(pr: Checkout, answers: string, round = "1") {
  writeFileSync(join(pr.repository, "responses.md"), answers);
  return pr.hedge("respond", "--round", round, "responses.md").then((result) => result, (error: Error) => ({ code: 1, output: error.message }));
}

test("a treated review asks the triage model about each blocker, major and unrated finding, saves its labels beside the findings, and tells the author which need no answer", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);

  const review = await pr.hedge("review", "--single");

  expect(readFileSync(join(reviewDirectory(pr), "findings.md"), "utf8")).toBe(`${findings}\n`);
  expect(savedLabels(pr)).toEqual({
    model: expect.any(String), ok: true, durationMs: expect.any(Number),
    labels: [
      { finding: 1, severity: "blocker", label: "needs-answer", reason: "names a trigger" },
      { finding: 2, severity: "major", label: "advisory", reason: "names no trigger and no requirement" },
      { finding: 4, severity: "none", label: "needs-answer", reason: "the finding states no severity" },
    ],
  });
  const [prompt] = triage.prompts();
  expect(prompt).toContain("A name with a space throws");
  expect(prompt).toContain("The helper could say more");
  expect(prompt).not.toContain("Rename name to person");
  expect(prompt).not.toContain("The test asserts a mock");
  expect(prompt).not.toContain("tidy the import");
  expect(prompt).toContain("+export const greet");
  expect(review.output).toContain("Advisory, needs no answer, do not fix it in this pull request: finding 2 (major): names no trigger and no requirement");
  expect(review.output).toContain("Needs an answer: findings 1, 4");
});

test("an advisory finding needs no answer, while the others still do, and the labels never rewrite findings.md", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await pr.hedge("review", "--single");

  expect((await respond(pr, "1. fixed in abc1234: names with spaces greet\n6. fixed in abc1234: the test checks the greeting\n")).output).toContain("Answer findings 4 too");
  expect((await respond(pr, "1. fixed in abc1234: names with spaces greet\n4. rejected: it reads fine\n6. fixed in abc1234: the test checks the greeting\n")).code).toBe(0);
  expect(readFileSync(join(reviewDirectory(pr), "findings.md"), "utf8")).toBe(`${findings}\n`);
});

test("the triage fails closed: a failed call, an unreadable reply, an unknown label, or a finding the reply leaves out needs an answer", async () => {
  const replies: [string, string][] = [
    ["exit 3", "the triage call failed"],
    ["cat >/dev/null; echo 'advisory for all'", "the triage reply is not readable"],
    [`cat >/dev/null; echo '${labels([1, "needs-answer", "trigger"], [2, "unsure", "cannot tell"], [4, "advisory", "taste"])}'`, "the triage gave no label"],
    [`cat >/dev/null; echo '${labels([1, "needs-answer", "trigger"])}'`, "the triage gave no label"],
  ];
  for (const [command, reason] of replies) {
    const pr = await treated();
    pr.env.HEDGE_PROOF_TRIAGE = command;
    expect((await pr.hedge("review", "--single")).code).toBe(0);
    const second = savedLabels(pr).labels.find(({ finding }: { finding: number }) => finding === 2);
    expect(second).toEqual({ finding: 2, severity: "major", label: "needs-answer", reason: expect.stringContaining(reason) });
    expect((await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n")).output).toContain("Answer findings 2 too");
  }
});

test("the triage reads its labels from a reply that wraps them in prose with braces, and keeps the start of a reply it cannot read", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", `Each finding about \`{ setting, arm }\` is below.\n\`\`\`json\n${adviseSecond}\n\`\`\`\nThat covers \`}\` too.`);

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4 }] });
  triage.answer("I cannot label { these } findings.");
  const printed = await pr.hedge("triage", "--findings", join(reviewDirectory(pr), "findings.md"), "--diff", join(reviewDirectory(pr), "diff.patch"));
  expect(JSON.parse(printed.output)).toMatchObject({ ok: false, cause: "the triage reply is not readable: I cannot label { these } findings.", labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "needs-answer", reason: "the triage reply is not readable" }, { finding: 4 }] });
});

test("a control pull request, a one-way door, and triage off run no triage and print no labels", async () => {
  const control = [1, 2, 3, 4, 5, 6, 7, 8].find((number) => armOf("split", "example/product", number) === "control")!;
  const runs: [string, number, string?][] = [["split", control], ["on", 42, "one-way"], ["off", 42]];
  for (const [setting, number, door] of runs) {
    const pr = await treated(setting, number);
    if (door) pr.pullRequestState({ body: graded("non-critical", "medium").replace("two-way door", "one-way door"), number });
    const triage = fakeModel(pr, "TRIAGE", adviseSecond);
    const review = await pr.hedge("review", "--single", "--repo", "example/product", "--pr", String(number));
    expect(triage.prompts()).toEqual([]);
    expect(readdirSync(join(pr.home, ".local/state/hedge/proof/example/product", String(number), "reviews", "1"))).not.toContain("triage-labels.json");
    expect(review.output).not.toContain("Advisory");
  }
});

test("an advisory finding answered as fixed buys no further round, where the same answer without triage does", async () => {
  const runs: [string, boolean][] = [["on", false], ["off", true]];
  for (const [setting, buys] of runs) {
    const pr = await treated(setting);
    fakeModel(pr, "REVIEWER", "- major | feature.ts:1 | The helper could say more about its contract | anchor: export const greet");
    fakeModel(pr, "TRIAGE", labels([1, "advisory", "names no trigger"]));
    const reviewed = await pr.git("rev-parse", "HEAD");
    await pr.hedge("review", "--single");
    await respond(pr, "1. fixed in abc1234: says more\n");
    await pr.commit("feature.ts", "export const greet = (person: string) => person;\n");

    const next = await pr.hedge("review", "--single", "--scope", "fixes", "--base", reviewed).then((result) => result, (error: Error) => ({ code: 1, output: error.message }));
    expect(next.output.includes("found no bug in production code that the PR introduced")).toBe(!buys);
  }
});

test("the gate counts an advisory finding as answered, and the judge reads which findings the triage made advisory", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await pr.hedge("review", "--single");
  markPanel(pr, "1");
  await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n");
  const judge = fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate").then((result) => result, (error: Error) => ({ code: 1, output: error.message }));

  expect(gate.output).not.toContain("unanswered findings");
  expect(judge.prompts().join("\n")).toContain("The triage labelled finding 2 (major) advisory: it needs no answer, and counts as answered");
});

test("hedge proof triage labels a findings file against a diff and prints the labels without touching the ledger", async () => {
  const pr = await checkout();
  fakeModel(pr, "TRIAGE", adviseSecond);
  writeFileSync(join(pr.repository, "findings.md"), findings);
  writeFileSync(join(pr.repository, "change.diff"), "+export const greet = (name: string) => name;\n");

  const printed = await pr.hedge("triage", "--findings", "findings.md", "--diff", "change.diff");

  expect(JSON.parse(printed.output)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4, label: "needs-answer" }] });
  expect(existsSync(join(pr.home, ".local/state/hedge/proof"))).toBe(false);
});

test("the triage asks the lookup row's model with no tools, and records its time and tokens beside the labels", async () => {
  const pr = await treated();
  const claude = recordingModel(pr, "claude", JSON.stringify({ type: "result", is_error: false, result: adviseSecond, usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.25 }));

  await pr.hedge("review", "--single");

  expect(claude.calls()[0]).toContain("--model lookup-model");
  expect(claude.calls()[0]).toContain("--tools  ");
  expect(savedLabels(pr)).toMatchObject({ model: "lookup-model", ok: true, durationMs: expect.any(Number), usage: { input: 12, output: 7, costUsd: 0.25 }, labels: [{ finding: 1 }, { finding: 2, label: "advisory" }, { finding: 4 }] });
});

test("the proof receipt lists each advisory finding with its first severity", async () => {
  const pr = await treated();
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical", "medium")}` });
  pr.env.HEDGE_HANDLERS = JSON.stringify({ "proof-receipt": publisherScript(pr) });
  fakeModel(pr, "TRIAGE", adviseSecond);
  await pr.hedge("review", "--single");
  markPanel(pr, "1");
  await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n");
  await pr.hedge("gate");

  expect((await pr.hedge("receipt")).code).toBe(0);

  expect(pr.githubBody()).toContain("**Advisory findings, no answer needed:** round 1 finding 2 (major)");
});

function publisherScript(pr: Checkout) {
  const path = join(pr.home, "publish.ts");
  writeFileSync(path, `await Bun.stdin.json();\nconsole.log(JSON.stringify({ id: "receipt-1", url: "https://receipts.example/r/receipt-1" }));\n`);
  return path;
}
