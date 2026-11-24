import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGate } from "../../guards/hooks/merge-gate.ts";
import { checkout, cleanFixtures, graded, reviewHead, settings, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const knownIssues = "\n## Known issues\n\n- major: feature.txt:1 The greeting repeats on reload.\n- major: feature.txt:2 The farewell is missing.\n";
const reason = "No production read access";

async function agentAcceptedGap(body = graded("non-critical", "medium")) {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.autonomy": "end" });
  pr.pullRequestState({ body: `Adds the greeting.\n\n${body}${knownIssues}` });
  pr.timeline("2026-10-25T09:00:00Z", ["2026-10-25T10:00:00Z", "2026-10-25T11:00:00Z"]);
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "prod-shape");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", reason);
  await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42", "--question", `Accept the prod-shape gap? example/product#42: ${reason}`, "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The change reads no stored rows");
  return { pr, head: await pr.git("rev-parse", "HEAD") };
}

const decisionId = (output: string) => /🤖 [^)]*?(d-[0-9a-f]+)\)/.exec(output)?.[1];

test("a passing gate prints the merge card line: grade and door, reads, each gap and who accepted it, each known issue, and the minutes to ready and to the card", async () => {
  const { pr } = await agentAcceptedGap();
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  const id = decisionId(gate.output);
  expect(gate.output.split("\n")).toContain(`merge card: example/product#42: medium, two-way door · 1 round · gaps: prod-shape (🤖 agent ${id}): ${reason} · 2 known issues: major: feature.txt:1 The greeting repeats on reload.; major: feature.txt:2 The farewell is missing. · 120 min opened to ready, 60 min ready to card`);
  expect(gate.output.split("\n").at(-1)).toStartWith("gate: pass");
});

test("the merge card spells out a one-way door, and a draft has no ready time yet", async () => {
  const { pr } = await agentAcceptedGap(`<!-- merge-risk -->\n> [!CAUTION]\n> 🔴 **Merge risk: high** · one-way door: the stored senders change shape\n> - **Tier:** non-critical\n<!-- /merge-risk -->\n`);
  pr.pullRequestState({ draft: true });
  const gate = await pr.hedge("gate");
  expect(gate.output).toMatch(/^merge card: example\/product#42: high, one-way door · .* · still a draft$/m);
});

test("a failing gate prints no merge card line", async () => {
  const { pr } = await agentAcceptedGap();
  await pr.hedge("require", "--kinds", "prod-shape,live-run");
  const gate = await pr.hedge("gate");
  expect(gate.code).not.toBe(0);
  expect(gate.output).not.toContain("merge card:");
});

test("the receipt writes the merge card block into the PR body without the minutes to the card, and prints the full line", async () => {
  const { pr } = await agentAcceptedGap();
  delete pr.env.HEDGE_HANDLERS;
  expect((await pr.hedge("gate")).code).toBe(0);
  const receipt = await pr.hedge("receipt");
  expect(receipt.code).toBe(0);
  const id = decisionId(receipt.output);
  expect(pr.githubBody()).toContain(`**Merge card:** medium, two-way door · 1 round · gaps: prod-shape (🤖 agent ${id}) · 2 known issues · 120 min opened to ready\n`);
  expect(receipt.output).toContain("· 120 min opened to ready, 60 min ready to card");
  pr.clock.now = new Date("2026-10-25T13:00:00Z");
  expect((await pr.hedge("receipt")).output.split("\n").at(-1)).toBe("receipt current");
});

test("a gate pass with a gap the agent accepted holds the merge, own tooling included, until the user's merge word for that head", async () => {
  const { pr, head } = await agentAcceptedGap();
  expect((await pr.hedge("gate")).code).toBe(0);
  const other = join(tmpdir(), `merge-card-hold-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeOn = (exempt: string) => {
    writeFileSync(join(other, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.merge-gate-exempt": exempt }));
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(join(pr.home, ".local/state/hedge/decisions.jsonl"), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: JSON.stringify({ "pull-requests.autonomy": "end" }) }, github });
  };
  const mergeWord = async (at: string) => {
    pr.choose("Merge", `Merge example/product#42 at ${at}?`);
    expect((await pr.decide("record", "--mark", "👤", "--class", "merge", "--pr", "example/product#42", "--condition", `${at}: merge card`)).code).toBe(0);
  };
  try {
    for (const exempt of ["", "example/*"]) {
      const refusal = (await mergeOn(exempt))?.hookSpecificOutput.permissionDecisionReason;
      expect(refusal).toMatch(new RegExp(`an agent accepted proof gaps of example/product#42 at ${head.slice(0, 12)} \\(🤖 d-[0-9a-f]+\\) itself`));
      expect(refusal).toContain("hedge decision record --mark 👤 --class merge --pr <owner/repo#n>");
    }
    await mergeWord("c".repeat(40));
    expect(await mergeOn("example/*")).toBeDefined();
    await mergeWord(head);
    expect(await mergeOn("")).toBeUndefined();
    expect(await mergeOn("example/*")).toBeUndefined();
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a gate pass without a gap the agent accepted merges without the user's word", async () => {
  const pr: Checkout = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  expect((await pr.hedge("gate")).code).toBe(0);
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  expect(await mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: pr.home, env: { HEDGE_SETTINGS: pr.env.HEDGE_SETTINGS }, github })).toBeUndefined();
});
