import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { armOf, triageFindings } from "./proof-triage.ts";
import { checkout, cleanFixtures, fakeModel, graded, lockHolder, lookup, models, settings, verdict, type Checkout } from "./proof-testing.ts";

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
const adviseSecond = labels([1, "needs-answer", "names a trigger"], [2, "advisory", "names no trigger and no requirement"]);

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

async function panelRound(pr: Checkout) {
  const first = join(pr.home, "first-lens");
  writeFileSync(join(pr.home, "lens-findings"), `FINDINGS:\n${findings}\nCOVERED: feature.ts\n`);
  writeFileSync(join(pr.home, "lens-clean"), "FINDINGS:\n(none)\nCOVERED: feature.ts\n");
  pr.env.HEDGE_PROOF_REVIEWER = `cat >/dev/null; if mkdir "${first}" 2>/dev/null; then cat "${pr.home}/lens-findings"; else cat "${pr.home}/lens-clean"; fi`;
  pr.env.HEDGE_PROOF_REVIEWER_MODEL = "lens-model";
  await pr.hedge("review");
}

async function respond(pr: Checkout, answers: string, round = "1") {
  writeFileSync(join(pr.repository, "responses.md"), answers);
  return pr.hedge("respond", "--round", round, "responses.md").then((result) => result, (error: Error) => ({ code: 1, output: error.message }));
}

test("a treated review saves a label for each blocker, major and unrated finding beside the findings", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toEqual({
    model: expect.any(String), ok: true, durationMs: expect.any(Number),
    labels: [
      { finding: 1, severity: "blocker", label: "needs-answer", reason: "names a trigger" },
      { finding: 2, severity: "major", label: "advisory", reason: "names no trigger and no requirement" },
      { finding: 4, severity: "none", label: "needs-answer", reason: "the finding states no severity" },
    ],
  });
});

test("the triage model reads the blocker and major findings and the diff, and no minor, nit or test finding", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);

  await pr.hedge("review", "--single");

  const [prompt] = triage.prompts();
  expect(prompt).toContain("A name with a space throws");
  expect(prompt).toContain("The helper could say more");
  expect(prompt).not.toContain("Rename name to person");
  expect(prompt).not.toContain("The test asserts a mock");
  expect(prompt).not.toContain("tidy the import");
  expect(prompt).toContain("+export const greet");
});

test("the review tells the author which findings need no answer and not to fix them in this pull request", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);

  const review = await pr.hedge("review", "--single");

  expect(review.output).toContain("Advisory, needs no answer, do not fix it in this pull request: finding 2 (major): names no trigger and no requirement");
  expect(review.output).toContain("Needs an answer: findings 1, 4");
});

test("an advisory finding needs no answer, while the others still do", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await pr.hedge("review", "--single");

  expect((await respond(pr, "1. fixed in abc1234: names with spaces greet\n6. fixed in abc1234: the test checks the greeting\n")).output).toContain("Answer findings 4 too");
  expect((await respond(pr, "1. fixed in abc1234: names with spaces greet\n4. rejected: it reads fine\n6. fixed in abc1234: the test checks the greeting\n")).code).toBe(0);
});

test("the labels never rewrite findings.md", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);

  await pr.hedge("review", "--single");

  expect(readFileSync(join(reviewDirectory(pr), "findings.md"), "utf8")).toBe(`${findings}\n`);
});

test("the triage fails closed: a failed call, an unreadable reply, an unknown label, a finding the reply leaves out, or a finding it labels twice both ways needs an answer", async () => {
  const replies: [string, string][] = [
    ["exit 3", "the triage call failed"],
    ["cat >/dev/null; echo 'advisory for all'", "the triage reply is not readable"],
    [`cat >/dev/null; echo '${labels([1, "needs-answer", "trigger"], [2, "unsure", "cannot tell"])}'`, "the triage reply is not readable"],
    [`cat >/dev/null; echo '${labels([1, "needs-answer", "trigger"])}'`, "the triage gave no label"],
    [`cat >/dev/null; echo '${labels([1, "needs-answer", "trigger"], [2, "needs-answer", "a trigger"], [2, "advisory", "taste"])}'`, "the triage gave conflicting labels"],
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

test("the triage reads a reply that is one labels object, bare or in a code fence", async () => {
  for (const reply of [adviseSecond, `\`\`\`json\n${adviseSecond}\n\`\`\``, `\`\`\`JSON\n${adviseSecond}\n\`\`\``, `~~~json\n${adviseSecond}\n~~~`, `~~~\n${adviseSecond}\n~~~`, `\`\`\`\`json\n${adviseSecond}\n\`\`\`\``, `\`\`\`json\n${adviseSecond}\n\`\`\`\``, `\`\`\` json\n${adviseSecond}\n  \`\`\``, `\`\`\`json\r\n${adviseSecond}\r\n\`\`\`\r\n`]) {
    const pr = await treated();
    fakeModel(pr, "TRIAGE", reply);

    await pr.hedge("review", "--single");

    expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4 }] });
  }
});

test("the triage cannot read a reply with anything besides one labels object, and keeps only its length", async () => {
  const replies = [
    `Each finding is below.\n${adviseSecond}`,
    JSON.stringify({ draft: JSON.parse(adviseSecond), error: "unsure" }),
    JSON.stringify({ ...JSON.parse(adviseSecond), status: "draft" }),
    `${adviseSecond}\n${JSON.stringify({ status: "final", ...JSON.parse(labels([2, "needs-answer", "a requirement"])) })}`,
    JSON.stringify({ labels: [...JSON.parse(adviseSecond).labels, { finding: 2, label: null, reason: "unsure" }] }),
    JSON.stringify({ labels: [...JSON.parse(adviseSecond).labels, { finding: "2", label: "needs-answer", reason: "a trigger" }] }),
    JSON.stringify({ labels: [...JSON.parse(adviseSecond).labels, { finding: 2.5, label: "needs-answer", reason: "a trigger" }] }),
    adviseSecond.replace('{"finding":1,"label":"needs-answer"', '{"finding":1.00000000000000001,"label":"advisory"'),
    `\`\`\`json\n${adviseSecond}\n\`\`\`~~~`,
    labels([0, "needs-answer", "names a trigger"], [1, "advisory", "names no trigger and no requirement"]),
    labels([1, "needs-answer", "names a trigger"], [2, "advisory", "names no trigger"], [4, "advisory", "a matter of taste"]),
    adviseSecond.replace('{"finding":1,"label":"needs-answer"', '{"finding":1e0,"label":"advisory"'),
    JSON.stringify({ labels: [...JSON.parse(adviseSecond).labels, { finding: 2, label: "needs-answer", reason: ["a trigger"] }] }),
    JSON.stringify({ labels: [...JSON.parse(adviseSecond).labels, null] }),
    JSON.stringify({ labels: JSON.parse(adviseSecond).labels.map(({ finding, label }: { finding: number; label: string }) => ({ finding, label })) }),
    JSON.stringify({ labels: JSON.parse(adviseSecond).labels.map((item: { reason: string }) => ({ ...item, reason: " " })) }),
  ];
  for (const reply of replies) {
    const pr = await treated();
    fakeModel(pr, "TRIAGE", reply);

    await pr.hedge("review", "--single");

    expect(savedLabels(pr)).toMatchObject({ ok: false, cause: `the triage reply is not readable, ${reply.length} characters`, labels: [{ finding: 1 }, { finding: 2, label: "needs-answer", reason: "the triage reply is not readable" }, { finding: 4 }] });
  }
});

test("the triage reads a reply whose reason repeats a value of its entry", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", labels([1, "needs-answer", "needs-answer"], [2, "advisory", "advisory"]));

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory", reason: "advisory" }, { finding: 4 }] });
});

test("the triage cannot read a reply that gives one key twice in an entry", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", '{"labels":[{"finding":1,"label":"needs-answer","reason":"a trigger"},{"finding":2,"label":"needs-answer","label":"advisory","reason":"taste"}]}');

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ ok: false, labels: [{ finding: 1 }, { finding: 2, label: "needs-answer", reason: "the triage reply is not readable" }, { finding: 4 }] });
});

test("the triage reads a reply whose reason quotes the labels key", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond.replace("names no trigger and no requirement", 'it says \\u0022labels\\u0022: and \\"labels\\": but names no trigger'));

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1 }, { finding: 2, label: "advisory", reason: 'it says "labels": and "labels": but names no trigger' }, { finding: 4 }] });
});

test("the triage cannot read a reply that gives the labels key twice, however the second key is spelled", async () => {
  for (const second of ['"labels"', '"lab\\u0065ls"', '"\\u006cabels"']) {
    const pr = await treated();
    fakeModel(pr, "TRIAGE", `{"labels":[{"finding":1,"label":"needs-answer","reason":"a trigger"},{"finding":2,"label":"needs-answer","reason":"a requirement"}],${second}:${JSON.stringify(JSON.parse(adviseSecond).labels)}}`);

    await pr.hedge("review", "--single");

    expect(savedLabels(pr)).toMatchObject({ ok: false, labels: [{ finding: 1 }, { finding: 2, label: "needs-answer", reason: "the triage reply is not readable" }, { finding: 4 }] });
  }
});

test("the triage reads a reply whose one labels key is spelled with an escape", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond.replace('"labels"', '"lab\\u0065ls"'));

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4 }] });
});

test("a wait on a finished panel with no labels yet runs the first triage pass, saves it and prints it", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  expect(existsSync(join(reviewDirectory(pr), "triage-labels.json"))).toBe(false);

  const wait = await pr.hedge("review", "--wait", "--round", "1");

  expect(wait.code).toBe(0);
  expect(triage.prompts()).toHaveLength(1);
  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4 }] });
  expect(wait.output).toContain("- Advisory, needs no answer, do not fix it in this pull request: finding 2 (major): names no trigger and no requirement");
});

test("a wait on a round whose triage call failed asks no model again, so the first pass stays the round's labels", async () => {
  const pr = await treated();
  pr.env.HEDGE_PROOF_TRIAGE = "exit 3";
  await panelRound(pr);
  await pr.hedge("review", "--wait", "--round", "1");
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);

  const wait = await pr.hedge("review", "--wait", "--round", "1");

  expect(triage.prompts()).toEqual([]);
  expect(savedLabels(pr)).toMatchObject({ ok: false, labels: [{ finding: 1 }, { finding: 2, label: "needs-answer" }, { finding: 4 }] });
  expect(wait.output).toContain("Needs an answer: findings 1, 2, 4");
});

test("with triage switched off, a wait asks no triage model and saves no labels, even for a round reserved while it was on", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "off" });

  await pr.hedge("review", "--wait", "--round", "1");

  expect(triage.prompts()).toEqual([]);
  expect(existsSync(join(reviewDirectory(pr), "triage-labels.json"))).toBe(false);
});

test("with triage switched off, a single read that resumes a round reserved while it was on asks no triage model", async () => {
  const pr = await treated();
  pr.env.HEDGE_PROOF_REVIEWER = "exit 3";
  await pr.hedge("review", "--single").catch(() => undefined);
  fakeModel(pr, "REVIEWER", findings);
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "off" });

  const resumed = await pr.hedge("review", "--single");

  expect(JSON.parse(resumed.output.split("\n")[0]!)).toMatchObject({ id: "1", triage: { arm: "treated" } });
  expect(triage.prompts()).toEqual([]);
  expect(existsSync(join(reviewDirectory(pr), "triage-labels.json"))).toBe(false);
});

test("a failed triage call prints none of the model's own output", async () => {
  const pr = await treated();
  pr.env.HEDGE_PROOF_TRIAGE = "cat >/dev/null; echo 'provider said: private-detail' >&2; exit 3";

  const review = await pr.hedge("review", "--single");

  expect(savedLabels(pr).cause).toBe("the model call failed; Hedge keeps none of its output");
  expect(review.output).not.toContain("private-detail");
  expect(review.output).toContain("- The triage labelled none of them; triage-labels.json in the round's folder says why.");
});

test("a triage call that throws at once, before it returns a promise, labels every blocker and major finding needs-answer", async () => {
  const triaged = await triageFindings(findings, "", () => { throw new Error("private-detail"); });

  expect(triaged).toMatchObject({ ok: false, cause: "the call threw before the model answered", labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "needs-answer" }, { finding: 4 }] });
  expect(JSON.stringify(triaged)).not.toContain("private-detail");
});

test("a failed triage call keeps none of its output, so no secret or exit status it reports is saved", async () => {
  const pr = await treated();
  const token = ["ghp", "_", "A1b2C3d4".repeat(5)].join("");
  pr.env.HEDGE_PROOF_TRIAGE = `cat >/dev/null; echo 'exit 999: provider said: token=${token}' >&2; exit 3`;
  pr.env.HEDGE_PROOF_TRIAGE_MODEL = "triage-model";

  await pr.hedge("review", "--single");

  const saved = readFileSync(join(reviewDirectory(pr), "triage-labels.json"), "utf8");
  expect(saved).not.toContain(token);
  expect(saved).not.toContain("provider said");
  expect(savedLabels(pr)).toMatchObject({ ok: false, cause: "the model call failed; Hedge keeps none of its output", labels: [{ finding: 1, reason: "the triage call failed: the model call failed; Hedge keeps none of its output" }, { finding: 2 }, { finding: 4 }] });
});

test("a round that weighs the budget while a wait saves the labels of the round before backs out and asks to weigh again", async () => {
  const pr = await treated();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "on", "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 20 });
  fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  await respond(pr, "1. fixed in abc1234: greets\n2. fixed in abc1234: says more\n4. rejected: fine\n6. fixed in abc1234: test\n");
  const base = JSON.parse(readFileSync(join(reviewDirectory(pr), "round.json"), "utf8")).commit;
  await pr.commit("feature.ts", "export const greet = (name: string) => name.trim();\n");
  const started = join(pr.home, "started");
  const go = join(pr.home, "go");
  Bun.spawnSync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; echo > "${started}"; read line < "${go}"; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", base);
  const paused = await Promise.race([readFile(started, "utf8").then(() => "paused"), slow.then(() => "reserved", (error: Error) => error.message)]);
  if (paused !== "paused") writeFileSync(started, "");
  expect(paused).toBe("paused");
  const wait = await pr.hedge("review", "--wait", "--round", "1");
  await writeFile(go, "go\n");

  expect(wait.code).toBe(0);
  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1 }, { finding: 2, label: "advisory" }, { finding: 4 }] });
  await expect(slow).rejects.toThrow("The reviews changed while this one weighed the budget");
});

test("a round that weighs the budget while a wait replaces a malformed labels file backs out and asks to weigh again", async () => {
  const pr = await treated();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "on", "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 20 });
  fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  writeFileSync(join(reviewDirectory(pr), "triage-labels.json"), "{}");
  await respond(pr, "1. fixed in abc1234: greets\n2. fixed in abc1234: says more\n4. rejected: fine\n6. fixed in abc1234: test\n");
  const base = JSON.parse(readFileSync(join(reviewDirectory(pr), "round.json"), "utf8")).commit;
  await pr.commit("feature.ts", "export const greet = (name: string) => name.trim();\n");
  const started = join(pr.home, "started");
  const go = join(pr.home, "go");
  Bun.spawnSync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; echo > "${started}"; read line < "${go}"; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", base);
  const paused = await Promise.race([readFile(started, "utf8").then(() => "paused"), slow.then(() => "reserved", (error: Error) => error.message)]);
  if (paused !== "paused") writeFileSync(started, "");
  expect(paused).toBe("paused");
  const wait = await pr.hedge("review", "--wait", "--round", "1");
  await writeFile(go, "go\n");

  expect(wait.code).toBe(0);
  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1 }, { finding: 2, label: "advisory" }, { finding: 4 }] });
  await expect(slow).rejects.toThrow("The reviews changed while this one weighed the budget");
});

test("a wait saves no labels while another command holds the review budget, and saves them when it runs again", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  const holder = await lockHolder(join(pr.pullRequest, "reviews"));

  const held = await pr.hedge("review", "--wait", "--round", "1");
  await holder.release();

  expect(held.code).toBe(2);
  expect(existsSync(join(reviewDirectory(pr), "triage-labels.json"))).toBe(false);
  expect((await pr.hedge("review", "--wait", "--round", "1")).code).toBe(0);
  expect(savedLabels(pr)).toMatchObject({ ok: true, labels: [{ finding: 1 }, { finding: 2, label: "advisory" }, { finding: 4 }] });
});

test("a labels file of another shape counts every finding as needing an answer in respond", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await pr.hedge("review", "--single");
  writeFileSync(join(reviewDirectory(pr), "triage-labels.json"), JSON.stringify({ ok: true, labels: { finding: 2, label: "advisory" } }));

  expect((await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n")).output).toContain("Answer findings 2 too");
});

test("a triage call that throws before the model answers labels every blocker and major finding needs-answer, and keeps none of the error's text", async () => {
  const triaged = await triageFindings(findings, "", async () => { throw new Error("settings.json is not readable near private-detail"); });

  expect(triaged).toMatchObject({ ok: false, cause: "the call threw before the model answered", labels: [{ finding: 1, label: "needs-answer", reason: "the triage call failed: the call threw before the model answered" }, { finding: 2, label: "needs-answer" }, { finding: 4 }] });
  expect(JSON.stringify(triaged)).not.toContain("private-detail");
});

test("a wait while another command holds a round with no labels yet asks no triage model, and says to wait again", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  const holder = await lockHolder(reviewDirectory(pr));

  const wait = await pr.hedge("review", "--wait", "--round", "1");
  await holder.release();

  expect(triage.prompts()).toEqual([]);
  expect(wait.code).toBe(2);
  expect(wait.output).toContain("Another hedge command holds review round 1, so the triage labels are not printed. Run hedge proof review --wait --round 1 again to see them.");
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

async function answeredPanel(pr: Checkout, triage = adviseSecond) {
  fakeModel(pr, "TRIAGE", triage);
  await panelRound(pr);
  await pr.hedge("review", "--wait", "--round", "1");
}

async function gatedWithAdvisory() {
  const pr = await treated();
  await answeredPanel(pr);
  await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n");
  const judge = fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.hedge("gate").then((result) => result, (error: Error) => ({ code: 1, output: error.message }));
  return { gate, judge };
}

test("the gate counts an advisory finding as answered", async () => {
  const { gate } = await gatedWithAdvisory();

  expect(gate.output).toContain("review: HEAD reviewed in round 1");
  expect(gate.output).not.toContain("unanswered findings");
});

test("the judge reads which findings the triage made advisory", async () => {
  const { judge } = await gatedWithAdvisory();

  expect(judge.prompts().join("\n")).toContain("The triage labelled finding 2 (major) advisory: it needs no answer, and counts as answered");
});

test("a triage the secret guard holds says so, since the guard names only the kind of secret it matched", async () => {
  const pr = await checkout();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  writeFileSync(join(pr.repository, "findings.md"), findings);
  writeFileSync(join(pr.repository, "change.diff"), `+const token = "${["ghp", "_", "A1b2C3d4".repeat(5)].join("")}";\n`);

  const printed = JSON.parse((await pr.hedge("triage", "--findings", "findings.md", "--diff", "change.diff")).output);

  expect(printed).toMatchObject({ ok: false, cause: "the secret guard matches this prompt: GitHub token" });
  expect(triage.prompts()).toEqual([]);
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

const claudeReply = JSON.stringify({ type: "result", is_error: false, result: adviseSecond, usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.25 });

test("the triage asks the lookup row's model with the arguments of a call with no tools, settings, servers or session, in any order, and saves its labels", async () => {
  const pr = await treated();
  const claude = argvModel(pr, "claude", claudeReply);

  await pr.hedge("review", "--single");

  const argv = claude.argv().split("\n").filter(Boolean).slice(1);
  const options = argv[0] === "[--settings]" ? argv.slice(2) : argv;
  const isolating = { "--model": "lookup-model", "--setting-sources": "", "--mcp-config": '{"mcpServers":{}}', "--tools": "", "--permission-mode": "dontAsk", "--output-format": "json" };
  for (const [flag, value] of Object.entries(isolating)) {
    expect(options.filter((option) => option === `[${flag}]`)).toHaveLength(1);
    expect(options[options.indexOf(`[${flag}]`) + 1]).toBe(`[${value}]`);
  }
  expect(options).toEqual(expect.arrayContaining(["[-p]", "[--strict-mcp-config]", "[--disable-slash-commands]", "[--no-session-persistence]"]));
  expect(savedLabels(pr)).toMatchObject({ ok: true, model: "lookup-model", labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "advisory" }, { finding: 4, label: "needs-answer" }] });
});

test("the triage runs in Hedge's state in the home folder, outside the checkout", async () => {
  const pr = await treated();
  const claude = argvModel(pr, "claude", claudeReply);

  await pr.hedge("review", "--single");

  const cwd = claude.argv().match(/^\[cwd=(.*)\]$/m)?.[1];
  expect(`${cwd}/`.startsWith(`${pr.home}/`)).toBe(true);
  expect(`${cwd}/`.startsWith(`${pr.repository}/`)).toBe(false);
});

test("the triage asks no model when its directory resolves inside the checkout under review", async () => {
  const pr = await treated();
  const claude = argvModel(pr, "claude", claudeReply);
  mkdirSync(join(pr.home, ".local/state/hedge"), { recursive: true });
  mkdirSync(join(pr.repository, "inside"));
  symlinkSync(join(pr.repository, "inside"), join(pr.home, ".local/state/hedge/triage"));

  await pr.hedge("review", "--single");

  expect(claude.argv()).toBe("");
  expect(savedLabels(pr)).toMatchObject({ ok: false, cause: "the triage directory is inside the checkout under review", labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "needs-answer" }, { finding: 4 }] });
});

test("a wait run outside any checkout asks no model when the triage directory resolves inside the panel's checkout", async () => {
  const pr = await treated();
  const triage = fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  mkdirSync(join(pr.repository, "inside"));
  symlinkSync(join(pr.repository, "inside"), join(pr.home, ".local/state/hedge/triage"));
  const head = await pr.git("rev-parse", "HEAD");

  await pr.hedgeIn(pr.home, "review", "--wait", "--round", "1", "--repo", "example/product", "--pr", "42", "--commit", head);

  expect(triage.prompts()).toEqual([]);
  expect(savedLabels(pr)).toMatchObject({ ok: false, cause: "the triage directory is inside the checkout under review" });
});

test("the triage records the model's time and tokens beside the labels", async () => {
  const pr = await treated();
  argvModel(pr, "claude", claudeReply);

  await pr.hedge("review", "--single");

  expect(savedLabels(pr)).toMatchObject({ model: "lookup-model", ok: true, durationMs: expect.any(Number), usage: { input: 12, output: 7, costUsd: 0.25 }, labels: [{ finding: 1 }, { finding: 2, label: "advisory" }, { finding: 4 }] });
});

test("on a Codex lookup row, which cannot run without tools, the triage asks no model and every blocker and major needs an answer", async () => {
  const pr = await treated();
  pr.env.HEDGE_MODELS = JSON.stringify([{ ...lookup, provider: "codex" }, ...models.slice(1)]);
  const codex = argvModel(pr, "codex", adviseSecond);

  const review = await pr.hedge("review", "--single");

  expect(codex.argv()).toBe("");
  expect(review.output).toContain("- The triage labelled none of them; triage-labels.json in the round's folder says why.");
  expect(savedLabels(pr)).toMatchObject({ ok: false, cause: "the triage runs only on a Claude lookup row, which has no tools", labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "needs-answer" }, { finding: 4 }] });
});

test("a machine whose model table has no lookup row labels every blocker and major finding needs-answer", async () => {
  const pr = await treated();
  pr.env.HEDGE_MODELS = JSON.stringify(models.slice(1));

  expect((await pr.hedge("review", "--single")).code).toBe(0);

  expect(savedLabels(pr)).toMatchObject({ ok: false, labels: [{ finding: 1, label: "needs-answer" }, { finding: 2, label: "needs-answer", reason: expect.stringContaining("the triage call failed") }, { finding: 4 }] });
});

test("a wait while another command holds the round still prints the labels already saved", async () => {
  const pr = await treated();
  await answeredPanel(pr);
  const holder = await lockHolder(reviewDirectory(pr));

  const wait = await pr.hedge("review", "--wait", "--round", "1");
  await holder.release();

  expect(wait.output).toContain("Advisory, needs no answer, do not fix it in this pull request: finding 2 (major)");
  expect(wait.output).not.toContain("Another hedge command holds");
});

test("a wait on a round labelled nothing while triage is now off, as another command holds it, prints no warning about triage labels", async () => {
  const pr = await treated();
  fakeModel(pr, "TRIAGE", adviseSecond);
  await panelRound(pr);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "off" });
  const holder = await lockHolder(reviewDirectory(pr));

  const wait = await pr.hedge("review", "--wait", "--round", "1");
  await holder.release();

  expect(wait.output).not.toContain("triage labels");
});

test("the proof receipt lists each advisory finding with its first severity", async () => {
  const pr = await treated();
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical", "medium")}` });
  pr.env.HEDGE_HANDLERS = JSON.stringify({ "proof-receipt": publisherScript(pr) });
  await answeredPanel(pr);
  await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n");
  await pr.hedge("gate");

  expect((await pr.hedge("receipt")).code).toBe(0);

  expect(pr.githubBody()).toContain("**Advisory findings, no answer needed:** round 1 finding 2 (major)");
});

test("the full receipt answers an unanswered advisory finding as advisory", async () => {
  const pr = await treated();
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical", "medium")}` });
  pr.env.HEDGE_HANDLERS = JSON.stringify({ "proof-receipt": publisherScript(pr) });
  await answeredPanel(pr);
  await respond(pr, "1. fixed in abc1234: greets\n4. rejected: fine\n6. fixed in abc1234: test\n");
  await pr.hedge("gate");

  await pr.hedge("receipt");

  expect(readFileSync(join(pr.home, "published.json"), "utf8")).toContain("advisory, needs no answer");
});

test("the full receipt keeps the advisory mark beside an answer the author gave anyway", async () => {
  const pr = await treated();
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical", "medium")}` });
  pr.env.HEDGE_HANDLERS = JSON.stringify({ "proof-receipt": publisherScript(pr) });
  await answeredPanel(pr);
  await respond(pr, "1. fixed in abc1234: greets\n2. rejected: a matter of taste\n4. rejected: fine\n6. fixed in abc1234: test\n");
  await pr.hedge("gate");

  await pr.hedge("receipt");

  expect(readFileSync(join(pr.home, "published.json"), "utf8")).toContain("rejected: a matter of taste (advisory, needs no answer)");
});

test("an advisory blocker that the author answers known still holds the merge", async () => {
  const pr = await treated();
  pr.pullRequestState({ body: `${graded("non-critical", "medium")}\n\n## Known issues\n\n- feature.ts:1 a name with a space throws\n`, number: 42 });
  await answeredPanel(pr, labels([1, "advisory", "a matter of taste"], [2, "advisory", "taste"]));
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "on", "pull-requests.reviewCeiling": 1 });
  await respond(pr, "1. known: listed under Known issues\n4. rejected: fine\n6. fixed in abc1234: test\n");
  fakeModel(pr, "JUDGE", verdict());

  const gate = await pr.hedge("gate").then((result) => result, (error: Error) => ({ code: 1, output: error.message }));

  expect(gate.output).toContain("answers findings 1 known, and an open blocker holds the merge");
});

function argvModel(pr: Checkout, provider: "claude" | "codex", answer: string) {
  const argv = join(pr.home, `${provider}-argv`);
  const reply = provider === "claude" ? `echo '${answer}'` : `for arg in "$@"; do [ "$previous" = "-o" ] && echo '${answer}' > "$arg"; previous="$arg"; done`;
  writeFileSync(join(pr.env.PATH!.split(":")[0]!, provider), `#!/bin/sh\nprintf '[cwd=%s]\\n' "$PWD" >> "${argv}"\nfor arg in "$@"; do printf '[%s]\\n' "$arg" >> "${argv}"; done\ncat > /dev/null\n${reply}\n`, { mode: 0o755 });
  return { argv: () => existsSync(argv) ? readFileSync(argv, "utf8") : "" };
}

function publisherScript(pr: Checkout) {
  const path = join(pr.home, "publish.ts");
  writeFileSync(path, `await Bun.write(${JSON.stringify(join(pr.home, "published.json"))}, await Bun.stdin.text());\nconsole.log(JSON.stringify({ id: "receipt-1", url: "https://receipts.example/r/receipt-1" }));\n`);
  return path;
}
