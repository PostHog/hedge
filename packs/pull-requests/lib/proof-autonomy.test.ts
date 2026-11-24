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

test("on end, an escalated round on a one-way door goes to the agent like any other round", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: oneWayDoor() });
  const third = await escalatedRound(pr);

  await expect(pr.hedge(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Decide the round yourself: run this command again with --agent '<your reason>'");
  expect((await pr.hedge(...third, "--agent", "Round 1 asked for the rename as a nit")).code).toBe(0);
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

test("on end, fixes rounds and final reads past the budget share the agent's three reads, and then the budget holds", async () => {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.reviewCeiling": 2, "pull-requests.autonomy": "end" });
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  let reviewed = await pr.commit("feature.txt", "new\n");
  await pr.hedge("review-start", "--scope", "full");
  await finishRound(pr, "1");
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  const fixesRound = async (round: number, ...args: string[]) => {
    const head = await pr.commit("feature.txt", `fix ${round}\n`);
    await pr.hedge("review-start", "--scope", "fixes", "--base", reviewed, ...args);
    await finishRound(pr, String(round));
    reviewed = head;
  };
  await fixesRound(2);

  for (const round of [3, 4]) await fixesRound(round, "--agent", "The last fix changed the greeting.");
  await pr.commit("feature.txt", "fix final\n");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", reviewed, "--agent", "The last fix changed the greeting.")).code).toBe(0);
  await finishRound(pr, "final-1");
  await expect(fixesRound(5, "--agent", "The last fix changed the greeting.")).rejects.toThrow("The agent's 3 reads past the budget are spent too");
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

test("on end, a panel gap, any gap on a one-way door, and a product gap on a critical PR go to the agent", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");

  expect((await pr.hedge("gap", "--kind", "panel", "--reason", "A docs-only lane")).output).toContain("Decide the gap yourself");
  pr.pullRequestState({ body: oneWayDoor() });
  expect((await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access")).output).toContain("Decide the gap yourself");
  pr.pullRequestState({ body: graded("critical", "high") });
  expect((await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access")).output).toContain("Decide the gap yourself");
});

const acceptAlone = (pr: Checkout, kind: string, reason: string) =>
  pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", kind, "--pr", "example/product#42", "--question", `Accept the ${kind} gap? example/product#42: ${reason}`, "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The change reads no stored rows");

test("on end, the gate counts the agent's acceptance of a panel gap and of a product gap on a one-way door", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: oneWayDoor() });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--kinds", "prod-shape");
  for (const [kind, reason] of [["panel", "A docs-only lane"], ["prod-shape", "No production read access"]] as const) {
    await pr.hedge("gap", "--kind", kind, "--reason", reason);
    expect((await acceptAlone(pr, kind, reason)).code).toBe(0);
  }

  const gate = (await pr.hedge("gate")).output;
  expect(gate).toMatch(/prod-shape: gap from \w+, accepted by 🤖 decision/);
  expect(gate).toMatch(/panel gap from \w+, accepted by 🤖 decision/);
});

test("on ask, the agent cannot accept a panel gap", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("gap", "--kind", "panel", "--reason", "A docs-only lane");

  await expect(acceptAlone(pr, "panel", "A docs-only lane")).rejects.toThrow("a panel gap is the user's to accept");
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

test("on end, the gate's first judge failure on a one-way door tells the agent to decide it alone", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: oneWayDoor() });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));

  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why> and decide it with hedge decision record --mark 🤖");
});

test("on ask, the gate's first judge failure on a one-way door tells the agent to ask the user", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: oneWayDoor() });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));

  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("judge gap: when the judge is wrong, record hedge proof gap --kind judge --reason <why> and ask the user; on ask an agent never decides on a one-way door");
  expect(gate.output).not.toContain("--mark 🤖");
});

test("on end, the agent still decides no design ask alone on a critical PR", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("critical", "medium") });
  await pr.commit("feature.txt", "new\n");

  await expect(pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", "Keep the greeting short?", "--answer", "Keep it short", "--rejected", "Make it long", "--reason", "Short reads better")).rejects.toThrow("example/product#42 is critical at HEAD: an agent decides only process there");
});

test("on end, a judge the arbiter stops tells the agent to decide the judge gap alone", async () => {
  const pr = await checkout();
  decideAtEnd(pr);
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo 'ESCALATE: The judge failed the owed kinds three times.'";
  for (const answer of ["First answer.", "Second answer.", "Third answer."]) {
    writeFileSync(join(pr.repository, "responses.md"), `${answer}\n`);
    await pr.hedge("respond", "--round", "1", "responses.md");
    await pr.hedge("gate").catch(() => undefined);
  }

  const gate = (await pr.hedge("gate")).output;
  expect(gate).toContain("judge: the arbiter stops the retries: The judge failed the owed kinds three times. First record hedge proof gap --kind judge --reason <why>, then do what it prints: decide the gap yourself with its hedge decision record --mark 🤖 command, or, on an ungraded PR or a gap the user keeps owed, ask the user its question");
  expect(gate).not.toContain("escalate to the user");
  expect(gate).not.toContain("or ask the user");
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
