import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { armOf } from "./proof-triage.ts";
import { answerFixed, checkout, cleanFixtures, fakeModel, graded, settings, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const noFindings = (file: string) => `FINDINGS:\n(none)\nCOVERED: ${file}\n`;

async function triaged(triage: string | undefined, body: string, file = "feature.ts", content = "export const greet = (name: string) => name;\n") {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, ...triage === undefined ? {} : { "pull-requests.triage": triage } });
  pr.pullRequestState({ body });
  mkdirSync(dirname(join(pr.repository, file)), { recursive: true });
  await pr.commit(file, content);
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", noFindings(file));
  return pr;
}

const firstLine = async (pr: Checkout, ...args: string[]) => JSON.parse((await pr.hedge("review", ...args)).output.split("\n")[0]!);
const roundRecord = (pr: Checkout, round: string) => JSON.parse(readFileSync(join(pr.pullRequest, "reviews", round, "round.json"), "utf8"));
const oneWay = "## Merge risk\n\n<!-- merge-risk -->\n> 🔵 **Merge risk: medium** · one-way door\n> - **Tier:** non-critical\n<!-- /merge-risk -->\n";

test("the arm of a pull request comes from a stable hash of its repository and number, the same on every machine, and the setting decides who is treated", () => {
  const arms = Array.from({ length: 40 }, (_, pr) => armOf("split", "example/product", pr + 1));
  expect(new Set(arms)).toEqual(new Set(["treated", "control"]));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("split", "Example/Product", pr + 1))).toEqual(arms);
  expect(armOf("split", "example/product", 7)).toBe(armOf("split", "example/product", 7));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("on", "example/product", pr + 1))).toEqual(Array(40).fill("treated"));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("off", "example/product", pr + 1))).toEqual(Array(40).fill("control"));
});

test("with triage on, hedge proof review prints the arm and the standard path of a medium-risk change outside every danger area, and the ledger keeps both", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"));

  expect(await firstLine(pr, "--single")).toMatchObject({ round: 1, triage: { setting: "on", arm: "treated", path: "standard" } });

  expect(roundRecord(pr, "1")).toMatchObject({ commit: await pr.git("rev-parse", "HEAD"), triage: { setting: "on", arm: "treated", path: "standard", why: [] } });
});

test("a high grade, a missing or unreadable grade, a changed file in a danger area, or a file on the critical-path list puts the pull request on the strict path", async () => {
  const pathAt = async (body: string, file?: string) => {
    const pr = await triaged("on", body, file);
    return (await firstLine(pr)).triage;
  };
  expect(await pathAt(graded("critical (b)", "high"))).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["merge-risk grade high"] });
  expect(await pathAt("Greets new members.\n")).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["merge-risk grade none"] });
  expect(await pathAt("Greets.\n\n<!-- merge-risk -->\n> **Merge risk: unclear**\n<!-- /merge-risk -->\n")).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["merge-risk grade unreadable"] });
  expect(await pathAt(graded("non-critical", "medium"), "email-sender.ts")).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["sends: email-sender.ts"] });
  expect(await pathAt(graded("non-critical", "medium"), "redact.ts")).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["redaction: redact.ts"] });

  const listed = await triaged("on", graded("non-critical", "medium"), "pricing.ts");
  writeFileSync(join(listed.home, "critical-paths.md"), "# Critical paths\n\n- `pricing.ts`\n- billing/\n");
  listed.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(listed.env.HEDGE_SETTINGS!), "pull-requests.criticalPathFiles": "example/product=critical-paths.md" });
  expect((await firstLine(listed)).triage).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["critical path: pricing.ts"] });
});

async function listedPath(list: string, file = "rates/plans/old plans.ts") {
  const pr = await triaged("on", graded("non-critical", "medium"), file);
  writeFileSync(join(pr.home, "critical-paths.md"), list);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(pr.env.HEDGE_SETTINGS!), "pull-requests.criticalPathFiles": "example/product=critical-paths.md" });
  return { list, triage: (await firstLine(pr, "--single")).triage };
}

test("a critical-path list matches its entries as bullets, plain lines, quoted paths with spaces, table cells, a leading ./ or /, a trailing colon, and globs", async () => {
  const lists = ["- `rates/plans/old plans.ts`\n", "| Path | Owner |\n| --- | --- |\n| rates/plans/old plans.ts | billing |\n", "| Area | Owner |\n| --- | --- |\n| rates | billing |\n", "- rates: the charging code\n", "rates\n", "- ./rates/\n", "Everything under /rates/ needs a second read.\n", "- rates/*\n", "- */plans/**\n", "- {fees,rates}/**\n"];
  for (const list of lists) expect(await listedPath(list)).toEqual({ list, triage: { setting: "on", arm: "treated", path: "strict", why: ["critical path: rates/plans/old plans.ts"] } });
  for (const list of ["- `[slug]/rates.ts`\n", "- [slug]/rates.ts\n", "- app routes ([slug]/)\n"]) expect(await listedPath(list, "[slug]/rates.ts")).toEqual({ list, triage: { setting: "on", arm: "treated", path: "strict", why: ["critical path: [slug]/rates.ts"] } });
  expect(await listedPath("- reports/q4,\n", "reports/q4,")).toEqual({ list: "- reports/q4,\n", triage: { setting: "on", arm: "treated", path: "strict", why: ["critical path: reports/q4,"] } });
  for (const list of ["- `src/{tenant}.ts`\n", "Review src/{tenant}.ts.\n"]) expect(await listedPath(list, "src/{tenant}.ts")).toEqual({ list, triage: { setting: "on", arm: "treated", path: "strict", why: ["critical path: src/{tenant}.ts"] } });
  expect(await listedPath("- [[slug]/rates.ts]\n", "[slug]/rates.ts")).toEqual({ list: "- [[slug]/rates.ts]\n", triage: { setting: "on", arm: "treated", path: "strict", why: ["critical path: [slug]/rates.ts"] } });
  for (const list of ["* billing/\n", "+ billing/*\n"]) expect(await listedPath(list)).toEqual({ list, triage: { setting: "on", arm: "treated", path: "standard", why: [] } });
});

test("a merge-risk grade quoted outside the callout counts as no grade", async () => {
  const pr = await triaged("on", "Greets new members.\n\n```md\n**Merge risk: low**\n```\n");
  expect((await firstLine(pr)).triage).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["merge-risk grade none"] });
});

test("each review records the arm its setting gives the pull request, the same under any spelling of the repository, and keeps no arm of its own", async () => {
  const control = [1, 2, 3, 4, 5, 6, 7, 8].find((number) => armOf("split", "example/product", number) === "control")!;
  const target = (repository: string) => ["--repo", repository, "--pr", String(control)];
  const triage = (setting: string) => { pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": setting }); };
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium"), number: control });
  const reviewed = await pr.commit("feature.ts", "export const greet = (name: string) => name;\n");
  for (const repository of ["example/product", "Example/Product"]) await pr.hedge("require", "--none", "--reason", "fixture", ...target(repository));
  fakeModel(pr, "REVIEWER", noFindings("feature.ts"));

  triage("on");
  expect((await firstLine(pr, "--single", ...target("example/product"))).triage).toMatchObject({ setting: "on", arm: "treated" });
  await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
  triage("split");
  expect((await firstLine(pr, "--scope", "final", "--base", reviewed, ...target("example/product"))).triage).toMatchObject({ setting: "split", arm: "control" });
  expect((await firstLine(pr, "--single", ...target("Example/Product"))).triage).toMatchObject({ setting: "split", arm: "control" });
});

test("a test file in a danger area keeps the standard path", async () => {
  const tests = await triaged("on", graded("non-critical", "medium"), "email-sender.test.ts", "test(\"sends\", () => {});\n");
  expect((await firstLine(tests)).triage).toEqual({ setting: "on", arm: "treated", path: "standard", why: [] });
});

test("a critical-path file hedge cannot read puts the pull request on the strict path", async () => {
  const unreadable = await triaged("on", graded("non-critical", "medium"));
  unreadable.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(unreadable.env.HEDGE_SETTINGS!), "pull-requests.criticalPathFiles": "example/product=missing.md" });
  expect((await firstLine(unreadable)).triage).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["critical-path list unreadable"] });
});

test("a one-way door is excluded and runs today's flow", async () => {
  const pr = await triaged("on", oneWay);
  expect((await firstLine(pr)).triage).toEqual({ setting: "on", arm: "treated", path: "excluded", why: ["one-way door"] });
});

test("a final read records the path at its own head", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"));
  expect((await pr.hedge("review", "--single")).code).toBe(0);
  const reviewed = await pr.git("rev-parse", "HEAD");
  const fixed = await pr.commit("send-mail.ts", "export const send = () => {};\n");
  fakeModel(pr, "REVIEWER", noFindings("send-mail.ts"));

  expect(await firstLine(pr, "--scope", "final", "--base", reviewed)).toMatchObject({ round: "final", triage: { setting: "on", arm: "treated", path: "strict" } });
  expect(roundRecord(pr, "final-1")).toMatchObject({ commit: fixed, triage: { setting: "on", arm: "treated", path: "strict", why: ["sends: send-mail.ts"] } });
  expect(roundRecord(pr, "1")).toMatchObject({ commit: reviewed, triage: { path: "standard" } });
});

test("with triage off, or not set, hedge proof review prints and records nothing of it", async () => {
  for (const setting of ["off", undefined]) {
    const pr = await triaged(setting, graded("critical (b)", "high"));
    expect(await firstLine(pr, "--single")).not.toHaveProperty("triage");
    expect(existsSync(join(pr.pullRequest, "triage.json"))).toBe(false);
    expect(roundRecord(pr, "1")).not.toHaveProperty("triage");
  }
});

test("a review reserved with triage on keeps its mark when it is retried after triage is switched off, and the next review records none", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"));
  pr.env.HEDGE_PROOF_REVIEWER = "exit 1";
  await pr.hedge("review", "--single").catch(() => undefined);
  expect(roundRecord(pr, "1")).toMatchObject({ triage: { setting: "on", arm: "treated" } });

  pr.env.HEDGE_SETTINGS = JSON.stringify(settings);
  fakeModel(pr, "REVIEWER", noFindings("feature.ts"));
  expect(await firstLine(pr, "--single")).toMatchObject({ round: 1, triage: { setting: "on", arm: "treated", path: "standard" } });
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
  expect(await firstLine(pr, "--scope", "final", "--base", reviewed)).not.toHaveProperty("triage");
  expect(roundRecord(pr, "final-1")).not.toHaveProperty("triage");
});

test("a final read that changes only a plain file keeps the strict path of a danger-area file an earlier commit changed", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"), "send-mail.ts", "export const send = () => {};\n");
  expect((await firstLine(pr)).triage).toMatchObject({ path: "strict" });
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", "export const greet = (name: string) => name;\n");
  fakeModel(pr, "REVIEWER", noFindings("feature.ts"));

  expect((await firstLine(pr, "--scope", "final", "--base", reviewed)).triage).toEqual({ setting: "on", arm: "treated", path: "strict", why: ["sends: send-mail.ts"] });
});

const major = "FINDINGS:\n- major | feature.ts:1 | the greeting drops the name\nCOVERED: feature.ts\n";

async function budgeted(triage: string | undefined, body: string, ceiling = 100, file?: string) {
  const pr = await triaged(triage, body, file);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(pr.env.HEDGE_SETTINGS!), "pull-requests.freeReviews": 100, "pull-requests.reviewCeiling": ceiling });
  fakeModel(pr, "REVIEWER", major);
  return pr;
}

const latestReviewed = async (pr: Checkout) => (await pr.git("log", "-1", "--format=%H", "HEAD~1"));

async function readAgain(pr: Checkout, answered: string, ...args: string[]) {
  await answerFixed(pr, answered);
  const base = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", `export const greet = (name: string) => \`${base.slice(0, 7)} \${name}\`;\n`);
  return pr.hedge("review", "--scope", "final", "--base", base, ...args);
}

test("with triage on, a treated pull request on the standard path gets a hard budget of two reads, which --agent cannot pass and the user's --override can", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));

  expect(await firstLine(pr, "--single")).toMatchObject({ round: 1, budget: 2, triage: { arm: "treated", path: "standard" } });
  expect(roundRecord(pr, "1")).toMatchObject({ budget: 2, triage: { path: "standard" } });
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect(roundRecord(pr, "final-1")).toMatchObject({ budget: 2 });

  await expect(readAgain(pr, "final-1")).rejects.toThrow("The review budget of 2 reviews is spent");
  const third = ["review", "--scope", "final", "--base", await latestReviewed(pr)];
  await expect(pr.hedge(...third, "--agent", "One more read checks the last fix.")).rejects.toThrow("The review budget of 2 reviews is spent");
  pr.choose("Run one more round");
  expect((await pr.hedge(...third, "--override", `2026-10-25 "Run one more round"`)).code).toBe(0);
});

test("a treated pull request on the strict path gets three reads", async () => {
  const pr = await budgeted("on", graded("critical (b)", "high"));
  expect(await firstLine(pr, "--single")).toMatchObject({ budget: 3, triage: { path: "strict" } });
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect((await readAgain(pr, "final-1")).code).toBe(0);
  await expect(readAgain(pr, "final-2")).rejects.toThrow("The review budget of 3 reviews is spent");
});

test("a treated pull request on the strict path of the Read tier gets three reads, its panel first", async () => {
  const pr = await budgeted("on", graded("non-critical", "low"), 100, "send-mail.ts");
  fakeModel(pr, "REVIEWER", major.replace("COVERED: feature.ts", "COVERED: send-mail.ts, feature.ts"));
  expect(await firstLine(pr)).toMatchObject({ round: 1, budget: 3, tier: { name: "read" }, triage: { path: "strict" } });
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect((await readAgain(pr, "final-1")).code).toBe(0);
  await expect(readAgain(pr, "final-2")).rejects.toThrow("The review budget of 3 reviews is spent");
});

test("a lower profile ceiling lowers a treated budget", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"), 1);
  expect(await firstLine(pr, "--single")).toMatchObject({ budget: 1 });
  await expect(readAgain(pr, "1")).rejects.toThrow("The review budget of 1 reviews is spent");
});

test("an excluded pull request keeps the profile's ceiling", async () => {
  const pr = await budgeted("on", oneWay, 6);
  expect(await firstLine(pr, "--single")).toMatchObject({ budget: 6, triage: { path: "excluded" } });
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect((await readAgain(pr, "final-1")).code).toBe(0);
});

test("a control pull request keeps the profile's ceiling", async () => {
  const control = [1, 2, 3, 4, 5, 6, 7, 8].find((number) => armOf("split", "example/product", number) === "control")!;
  const target = ["--repo", "example/product", "--pr", String(control)];
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.triage": "split", "pull-requests.freeReviews": 100 });
  pr.pullRequestState({ body: graded("non-critical", "medium"), number: control });
  await pr.commit("feature.ts", "export const greet = (name: string) => name;\n");
  await pr.hedge("require", "--none", "--reason", "fixture", ...target);
  fakeModel(pr, "REVIEWER", major);
  expect(await firstLine(pr, "--single", ...target)).toMatchObject({ budget: 6, triage: { arm: "control", path: "standard" } });
  for (const answered of ["1", "final-1"]) {
    writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the change keeps the case\n");
    await pr.hedge("respond", "--round", answered, "responses.md", ...target);
    const base = await pr.git("rev-parse", "HEAD");
    await pr.commit("feature.ts", `export const greet = (name: string) => \`${base.slice(0, 7)} \${name}\`;\n`);
    expect((await pr.hedge("review", "--scope", "final", "--base", base, ...target)).code).toBe(0);
  }
});

test("with triage off a review records no budget and keeps today's ceiling", async () => {
  const pr = await budgeted("off", graded("non-critical", "medium"), 6);
  expect(await firstLine(pr, "--single")).not.toHaveProperty("budget");
  expect(roundRecord(pr, "1")).not.toHaveProperty("budget");
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect((await readAgain(pr, "final-1")).code).toBe(0);
  expect(roundRecord(pr, "final-2")).not.toHaveProperty("budget");
});

test("at a treated budget a finding takes a known answer, and with triage switched off the profile's ceiling applies again", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues\n");
  const on = pr.env.HEDGE_SETTINGS!;
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(on), "pull-requests.triage": "off" });
  await expect(pr.hedge("respond", "--round", "final-1", "responses.md")).rejects.toThrow("review budget of 100 reviews");
  pr.env.HEDGE_SETTINGS = on;
  expect((await pr.hedge("respond", "--round", "final-1", "responses.md")).code).toBe(0);
});

test("a known answer waits for the budget that stops the next read, also after triage is switched on midway", async () => {
  const pr = await budgeted("off", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(pr.env.HEDGE_SETTINGS!), "pull-requests.triage": "on" });

  await expect(readAgain(pr, "final-1")).rejects.toThrow("The review budget of 2 reviews is spent");
  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues\n");
  expect((await pr.hedge("respond", "--round", "final-1", "responses.md")).code).toBe(0);
});

test("when the path changes after counted reads, the next read and a known answer follow the budget of the new path", async () => {
  const pr = await budgeted("on", graded("critical (b)", "high"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  await expect(pr.hedge("respond", "--round", "final-1", "known.md")).rejects.toThrow("review budget of 3 reviews");

  pr.pullRequestState({ body: graded("non-critical", "medium") });
  expect((await pr.hedge("respond", "--round", "final-1", "known.md")).code).toBe(0);
  await expect(readAgain(pr, "final-1")).rejects.toThrow("The review budget of 2 reviews is spent");

  pr.pullRequestState({ body: graded("critical (b)", "high") });
  expect((await pr.hedge("review", "--scope", "final", "--base", await latestReviewed(pr))).code).toBe(0);
});

test("the panel of an excluded pull request on the Read tier stops its reads at the Read tier's budget, and a finding of the panel takes a known answer there", async () => {
  const pr = await budgeted("on", oneWay.replace("medium", "low"), 6);
  expect(await firstLine(pr)).toMatchObject({ round: 1, budget: 2, tier: { name: "read" }, triage: { path: "excluded" } });
  expect(roundRecord(pr, "1")).toMatchObject({ budget: 2 });
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await readAgain(pr, "1")).code).toBe(0);
  await expect(readAgain(pr, "final-1")).rejects.toThrow("The review budget of 2 reviews is spent");
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  expect((await pr.hedge("respond", "--round", "1", "known.md")).code).toBe(0);
});

test("a first panel after two reads of a treated pull request is refused at the budget", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  await answerFixed(pr, "final-1");
  await pr.commit("feature.ts", "export const greet = (name: string) => `hello ${name}`;\n");
  await expect(pr.hedge("review")).rejects.toThrow("The review budget of 2 reviews is spent");
});

test("respond sizes the budget at the pull request's head, so an older commit named by --commit cannot let a known answer in early", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  fakeModel(pr, "REVIEWER", major.replace("COVERED: feature.ts", "COVERED: feature.ts, send-mail.ts"));
  await pr.hedge("review", "--single");
  const first = await pr.git("rev-parse", "HEAD");
  await answerFixed(pr, "1");
  await pr.commit("send-mail.ts", "export const send = () => {};\n");
  expect(await firstLine(pr, "--scope", "final", "--base", first)).toMatchObject({ budget: 3, triage: { path: "strict" } });
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");

  await expect(pr.hedge("respond", "--round", "final-1", "known.md", "--commit", first)).rejects.toThrow("review budget of 3 reviews");
});

const failPullRead = (pr: Checkout, read: number) => {
  const github = join(dirname(pr.home), "github");
  const script = `n=$(cat ${github}/reads 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${github}/reads; if [ $n -eq ${read} ]; then echo 'HTTP 503' > ${github}/pull-error-42; else rm -f ${github}/pull-error-42; fi; cp ${github}/counter.sh ${github}/while-reading\n`;
  writeFileSync(join(github, "counter.sh"), script);
  writeFileSync(join(github, "while-reading"), script);
};

test("a one-way pull request whose pull request cannot be read is not capped: a known answer waits for the profile's ceiling, and the review prints and records why", async () => {
  const pr = await budgeted("on", oneWay, 6);
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  expect((await readAgain(pr, "final-1")).code).toBe(0);
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  await expect(pr.hedge("respond", "--round", "final-2", "known.md")).rejects.toThrow("review budget of 6 reviews");

  pr.pullRequestState({ unreadable: "gh: Service Unavailable (HTTP 503)" });
  await expect(pr.hedge("respond", "--round", "final-2", "known.md")).rejects.toThrow("review budget of 6 reviews");

  rmSync(join(dirname(pr.home), "github", "pull-error-42"));
  await answerFixed(pr, "final-2");
  const base = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", "export const greet = (name: string) => `bye ${name}`;\n");
  failPullRead(pr, 2);
  const uncapped = { budget: 6, uncapped: "the pull request could not be read" };
  expect(await firstLine(pr, "--scope", "final", "--base", base)).toMatchObject({ round: "final", ...uncapped, triage: { arm: "treated" } });
  expect(roundRecord(pr, "final-3")).toMatchObject(uncapped);
});

test("a head on GitHub whose changed files cannot be read here leaves the known answer at the profile's ceiling", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  pr.githubHead("b".repeat(40));
  await expect(pr.hedge("respond", "--round", "final-1", "known.md")).rejects.toThrow("review budget of 100 reviews");
});

test("a body that was read without a merge-risk grade still gets the strict budget", async () => {
  const pr = await budgeted("on", "Greets new members.\n");
  expect(await firstLine(pr)).toMatchObject({ budget: 3, triage: { path: "strict", why: ["merge-risk grade none"] } });
  expect(roundRecord(pr, "1")).not.toHaveProperty("uncapped");
});

test("a failed lookup of the changed files leaves the pull request on the strict path and uncapped together, from one lookup", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  await answerFixed(pr, "1");
  const base = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.ts", "export const greet = (name: string) => `bye ${name}`;\n");
  failPullRead(pr, 3);
  expect(await firstLine(pr, "--scope", "final", "--base", base)).toMatchObject({ budget: 100, uncapped: "its changed files could not be read", triage: { path: "strict", why: ["changed files unknown"] } });
});

test("respond sizes the budget at a local head that builds on the pull request's head, as the review does", async () => {
  const pr = await budgeted("on", graded("non-critical", "medium"));
  await pr.hedge("review", "--single");
  expect((await readAgain(pr, "1")).code).toBe(0);
  pr.githubHead(await pr.git("rev-parse", "HEAD"));
  await pr.commit("send-mail.ts", "export const send = () => {};\n");
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  await expect(pr.hedge("respond", "--round", "final-1", "known.md")).rejects.toThrow("review budget of 3 reviews");
});

test("with triage off respond sizes today's ceiling at the commit --commit names", async () => {
  const pr = await budgeted("off", graded("non-critical", "low"));
  await pr.hedge("review");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await readAgain(pr, "1")).code).toBe(0);
  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("large.ts", Array.from({ length: 60 }, (_, line) => `export const value${line} = ${line};\n`).join(""));
  writeFileSync(join(pr.repository, "known.md"), "1. known: listed under Known issues\n");
  expect((await pr.hedge("respond", "--round", "final-1", "known.md", "--commit", reviewed)).code).toBe(0);
});
