import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, finishRound, graded, reviewHead, settings, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const decideAtEnd = (pr: Checkout) => { pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.autonomy": "end" }); };

async function escalatedRound(pr: Checkout) {
  const head = await pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.hedge("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", head]));
    await finishRound(pr, round);
  }
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'";
  return ["review-start", "--scope", "fixes", "--base", head];
}

test("on end, an escalated round tells the agent to decide it alone, even on a critical PR, and the decision runs the round", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("critical", "medium") });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Decide the round yourself: run this command again with --agent '<your reason>'");
  await expect(pr.hedge(...third)).rejects.toThrow("the user reads it in hedge decision report, under Decisions");
  await expect(pr.hedge(...third)).rejects.not.toThrow("Ask the user with your question tool");

  expect((await pr.hedge(...third, "--agent", "Round 1 asked for the rename as a nit")).code).toBe(0);
  expect((await pr.decide("list", "--class", "review")).output).toContain("🤖 ");
});

test("on end, an ungraded PR still sends an escalated round to the user", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Ask the user with your question tool");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await expect(pr.hedge("review-finish", "--round", "3", "--reviewer", "gpt-6.1-sol", "findings.md")).rejects.toThrow();
});

const oneWayDoor = () => graded("critical", "medium").replace("two-way door", "one-way door");

async function stoppedOneWay(pr: Checkout) {
  decideAtEnd(pr);
  pr.pullRequestState({ body: oneWayDoor() });
  return escalatedRound(pr);
}

test("on end, a one-way door stops the loop at an escalated round, asks the user nothing, and says to revert the fixes since the latest review", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);
  const reviewed = (await pr.git("rev-parse", "HEAD")).slice(0, 7);

  const stop = pr.hedge(...third);
  await expect(stop).rejects.toThrow(`The arbiter escalates: Round 2 undoes the rename round 1 asked for. On a one-way door the review loop stops here: ask the user nothing about another round. Revert each commit of the PR since ${reviewed} that changes production code`);
  await expect(stop).rejects.toThrow(`answer its finding "<n>. known: <why>"`);
  await expect(stop).rejects.not.toThrow("Ask the user with your question tool");
  await expect(stop).rejects.not.toThrow("--agent");
});

test("on end, a one-way door stops the loop when the arbiter gives no verdict", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo 'Maybe.'";

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter gave no verdict: unparseable answer: Maybe.. On a one-way door the review loop stops here");
});

test("on a one-way door the agent's own decision cannot pass the stop", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);

  await expect(pr.hedge(...third, "--agent", "Round 1 asked for the rename as a nit")).rejects.toThrow("On a one-way door the review loop stops here");
  await expect(pr.hedge("review-finish", "--round", "3", "--reviewer", "gpt-6.1-sol", "findings.md")).rejects.toThrow("not reserved");
});

test("on a one-way door the user's override still runs the escalated round", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);
  pr.choose("Run one more round");

  const round = await pr.hedge(...third, "--override", `2026-11-14 "Run one more round"`, "--thread", "thread-1");
  expect(round.output).toContain(`"round":3`);
});

test("a finding is answered known after the one-way stop, and not before it", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);
  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n");

  await expect(pr.hedge("respond", "--round", "2", "responses.md")).rejects.toThrow(`Answer a finding "known" only once the review budget of 6 reviews is spent; 2 ran. Fix or reject it now. A stop of the review loop at an escalation on a one-way door allows it too`);
  await expect(pr.hedge(...third)).rejects.toThrow("the review loop stops here");
  expect((await pr.hedge("respond", "--round", "2", "responses.md")).code).toBe(0);
});

test("the end table shows the one-way stop", async () => {
  const pr = await checkout();
  const third = await stoppedOneWay(pr);
  await expect(pr.hedge(...third)).rejects.toThrow("the review loop stops here");
  const reviewed = (await pr.git("rev-parse", "HEAD")).slice(0, 7);
  await pr.hedge("gate");

  expect((await pr.decide("report", "--pr", "example/product#42")).output).toContain(`| example/product#42 | 2 rounds; stopped at an escalation on a one-way door at ${reviewed} |`);
});

test("on ask, a one-way door still asks the user about an escalated round, and a known answer waits for the budget", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: oneWayDoor() });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("Ask the user with your question tool");
  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n");
  await expect(pr.hedge("respond", "--round", "2", "responses.md")).rejects.toThrow(`Answer a finding "known" only once`);
});

test("on ask, an escalated round asks the user as before", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("critical", "medium") });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("Ask the user with your question tool");
});

test("on end, a gap prints the agent's own decision, and the ledger takes it", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");

  const gap = await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  expect(gap.output).toContain(`Decide the gap yourself: run hedge decision record --mark 🤖 --class proof-gap --kind prod-shape --pr example/product#42 --question 'Accept the prod-shape gap? example/product#42: No production read access' --answer 'Accept the gap' --rejected 'Keep the gap open' --reason '<your reason>'`);
  expect(gap.output).toContain("the user reads it in hedge decision report, under Decisions");
  expect(gap.output).not.toContain("Ask the user with your question tool");

  const recorded = await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42", "--question", "Accept the prod-shape gap? example/product#42: No production read access", "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The change reads no stored rows");
  expect(recorded.code).toBe(0);
  expect((await pr.decide("list", "--class", "proof-gap")).output).toContain("🤖 **Accept the prod-shape gap? example/product#42: No production read access** Accept the gap");
});

test("on end, a panel gap, any gap on a one-way door, and a product gap on a critical PR still go to the user", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");

  expect((await pr.hedge("gap", "--kind", "panel", "--reason", "A docs-only lane")).output).toContain("Ask the user with your question tool");
  pr.pullRequestState({ body: graded("non-critical").replace("two-way door", "one-way door") });
  expect((await pr.hedge("gap", "--kind", "post-deploy-watch", "--reason", "No dashboard yet")).output).toContain("Ask the user with your question tool");
  pr.pullRequestState({ body: graded("critical", "high") });
  expect((await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access")).output).toContain("Ask the user with your question tool");
  expect((await pr.hedge("gap", "--kind", "post-deploy-watch", "--reason", "No dashboard yet")).output).toContain("Decide the gap yourself");
});

test("on end, the gate tells the agent to decide an open judge gap alone", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");

  const gate = await pr.hedge("gate");
  expect(gate.code).not.toBe(0);
  expect(gate.output).toContain("judge gap: not accepted: The judge reads feature.txt as code. Decide the gap yourself: run hedge decision record --mark 🤖 --class proof-gap --kind judge --pr example/product#42");
});

test("on a one-way door, the gate's first judge failure tells the agent to ask the user, never to decide alone", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical").replace("two-way door", "one-way door") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));

  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why> and ask the user; an agent never decides on a one-way door");
  expect(gate.output).not.toContain("--mark 🤖");
});

test("on end, the printed decision command quotes a gap reason so the shell passes it whole", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");
  const reason = "The \"staging\" account can't read `rows` in $HOME";

  const printed = (await pr.hedge("gap", "--kind", "prod-shape", "--reason", reason)).output;
  const args = /run hedge decision record (.*?) --reason '<your reason>'/.exec(printed)![1]!;
  const split = Bun.spawnSync(["bash", "-c", `printf '%s\\0' ${args}`]).stdout.toString().split("\0");
  expect(split[split.indexOf("--question") + 1]).toBe(`Accept the prod-shape gap? example/product#42: ${reason}`);
});

test("on end, a judge gap the user keeps owed goes back to the user, not to another agent acceptance", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");
  pr.chooseGap("judge", "The judge reads feature.txt as code", "Keep the gap open");
  expect((await acceptGap(pr, "judge", "--keep-owed")).code).toBe(0);

  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("The judge reads feature.txt as code. Ask the user with your question tool");
  expect(gate.output).not.toContain("Decide the gap yourself");
  const again = await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");
  expect(again.output).toContain("Ask the user with your question tool");
  expect(again.output).not.toContain("Decide the gap yourself");

  pr.clock.now = new Date("2026-10-25T12:30:00Z");
  pr.chooseGap("judge", "The judge reads feature.txt as code", "Accept the gap");
  expect((await acceptGap(pr, "judge")).code).toBe(0);
  expect((await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code")).output).toContain("Decide the gap yourself");

  await pr.commit("feature.txt", "greet new members twice\n");
  pr.clock.now = new Date("2026-10-25T13:00:00Z");
  expect((await pr.hedge("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code")).output).toContain("Decide the gap yourself");
});

test("on end, the gap prompt follows the gate when the user accepts a gap and later keeps it owed", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "prod-shape");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access", "Accept the gap");
  expect((await acceptGap(pr, "prod-shape")).code).toBe(0);
  pr.clock.now = new Date("2026-10-25T12:30:00Z");
  pr.chooseGap("prod-shape", "No production read access", "Keep the gap open");
  expect((await acceptGap(pr, "prod-shape", "--keep-owed")).code).toBe(0);

  expect((await pr.hedge("gate")).output).toContain("accepted by 👤 decision");
  const again = await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  expect(again.output).toContain("Decide the gap yourself");
});

test("on ask, a gap reads no merge-risk grade from GitHub", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical"), unreadable: "stalled" });
  await pr.commit("feature.txt", "new\n");

  expect((await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access")).output).toContain("Ask the user with your question tool");
  const calls = (() => { try { return pr.githubCalls(); } catch { return []; } })();
  expect(calls.filter((call) => call.includes("pulls/42"))).toEqual([]);
});
