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
  const decided = await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42", "--question", `Accept the prod-shape gap? example/product#42: ${reason}`, "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The change reads no stored rows");
  const id = /\[(d-[0-9a-f]+)\]/.exec(decided.output)?.[1];
  expect(id).toBeDefined();
  return { pr, id, head: await pr.git("rev-parse", "HEAD") };
}

test("a passing gate prints the merge card line: grade and door, reads, each gap and who accepted it, each known issue, and the minutes to ready and to the card", async () => {
  const { pr, id } = await agentAcceptedGap();
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(gate.output.split("\n")).toContain(`merge card: example/product#42: medium, two-way door · 1 round · gaps: prod-shape (🤖 agent ${id}): ${reason} · held: ${id} for prod-shape · 2 known issues: major: feature.txt:1 The greeting repeats on reload.; major: feature.txt:2 The farewell is missing. · 120 min opened to ready, 60 min ready to card`);
  expect(gate.output.split("\n").at(-1)).toStartWith("gate: pass");
});

test("the merge card line names each held decision once, with every kind it accepts", async () => {
  const { pr, id } = await agentAcceptedGap();
  await pr.hedge("require", "--kinds", "prod-shape,live-run,cross-version");
  await pr.hedge("gap", "--kind", "live-run", "--reason", "No sandbox");
  await pr.hedge("gap", "--kind", "cross-version", "--reason", "No old client");
  const decided = await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "live-run", "--kind", "cross-version", "--pr", "example/product#42", "--question", "Accept the live-run and cross-version gaps? example/product#42: No sandbox", "--answer", "Accept the gaps", "--rejected", "Keep the gaps open", "--reason", "The hook runs in its own tests");
  const other = /\[(d-[0-9a-f]+)\]/.exec(decided.output)?.[1];
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(/ · held: ([^·]+) · /.exec(gate.output)?.[1]).toBe(`${other} for live-run/cross-version, ${id} for prod-shape`);
  const json = await pr.hedge("gate", "--json");
  expect((JSON.parse(json.output.trim().split("\n").at(-1) ?? "{}") as { mergeCard?: string }).mergeCard).toContain(` · held: ${other} for live-run/cross-version, ${id} for prod-shape · `);
});

test("the merge card takes the door from the grade line, and a draft has no ready time yet", async () => {
  const { pr } = await agentAcceptedGap(`<!-- merge-risk -->\n> [!CAUTION]\n> 🔴 **Merge risk: high** · one-way door: the stored senders change shape\n> - **Tier:** non-critical\n<!-- /merge-risk -->\n`);
  pr.pullRequestState({ draft: true });
  expect((await pr.hedge("gate")).output).toMatch(/^merge card: example\/product#42: high, one-way door · .* · still a draft$/m);
  pr.pullRequestState({ body: `<!-- merge-risk -->\n> [!WARNING]\n> 🟡 **Merge risk: medium** · two-way door\n> - No one-way door: the stored senders keep their shape\n> - **Tier:** non-critical\n<!-- /merge-risk -->\n${knownIssues}` });
  expect((await pr.hedge("gate")).output).toMatch(/^merge card: example\/product#42: medium, two-way door · /m);
});

test("a failing gate prints no merge card line, and its receipt writes no merge card", async () => {
  const { pr } = await agentAcceptedGap();
  delete pr.env.HEDGE_HANDLERS;
  await pr.hedge("require", "--kinds", "prod-shape,live-run");
  const gate = await pr.hedge("gate");
  expect(gate.code).not.toBe(0);
  expect(gate.output).not.toContain("merge card:");
  const receipt = await pr.hedge("receipt");
  expect(receipt.code).toBe(0);
  expect(receipt.output).not.toContain("merge card:");
  expect(pr.githubBody()).not.toContain("**Merge card:**");
});

test("the receipt writes the merge card block into the PR body without the minutes to the card, and prints the full line", async () => {
  const { pr, id } = await agentAcceptedGap();
  delete pr.env.HEDGE_HANDLERS;
  expect((await pr.hedge("gate")).code).toBe(0);
  const receipt = await pr.hedge("receipt");
  expect(receipt.code).toBe(0);
  expect(pr.githubBody()).toContain(`**Merge card:** medium, two-way door · 1 round · gaps: prod-shape (🤖 agent ${id}) · 2 known issues · 120 min opened to ready\n`);
  expect(receipt.output).toContain("· 120 min opened to ready, 60 min ready to card");
  expect(receipt.output).not.toContain("held:");
  expect(pr.githubBody()).not.toContain("held:");
  pr.clock.now = new Date("2026-10-25T13:00:00Z");
  expect((await pr.hedge("receipt")).output.split("\n").at(-1)).toBe("receipt current");
});

test("a gate pass with a gap the agent accepted holds the merge, own tooling included, until the user's merge word for that head", async () => {
  const { pr, head, id } = await agentAcceptedGap();
  expect((await pr.hedge("gate")).code).toBe(0);
  const other = join(tmpdir(), `merge-card-hold-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeOn = (exempt: string) => {
    writeFileSync(join(other, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.merge-gate-exempt": exempt }));
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(join(pr.home, ".local/state/hedge/decisions.jsonl"), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: JSON.stringify({ "pull-requests.autonomy": "end" }) }, github });
  };
  const mergeWord = async (at: string, choice = "Merge", question = `Merge example/product#42 at ${at}? An agent accepted ${id} for prod-shape.`) => {
    pr.choose(choice, question);
    return pr.decide("record", "--mark", "👤", "--class", "merge", "--pr", "example/product#42", "--condition", `${at}: merge card`);
  };
  try {
    for (const exempt of ["", "example/*"]) {
      const refusal = (await mergeOn(exempt))?.hookSpecificOutput.permissionDecisionReason;
      expect(refusal).toMatch(new RegExp(`an agent accepted proof gaps of example/product#42 at ${head.slice(0, 12)} \\(🤖 d-[0-9a-f]+ for prod-shape\\) itself`));
      expect(refusal).toContain("hedge decision record --mark 👤 --class merge --pr <owner/repo#n>");
    }
    await expect(mergeWord(head, "Keep it open")).rejects.toThrow('The user chose "Keep it open", not "Merge"');
    await expect(mergeWord(head, "Merge", "Merge example/product#42?")).rejects.toThrow(`does not name the head ${head}`);
    await expect(mergeWord(head.toUpperCase(), "Keep it open")).rejects.toThrow("A merge card answer needs --condition '<full 40-character lowercase head sha>: merge card'");
    expect((await mergeWord("c".repeat(40))).code).toBe(0);
    expect(await mergeOn("example/*")).toBeDefined();
    expect((await mergeWord(head)).code).toBe(0);
    expect(await mergeOn("")).toBeUndefined();
    expect(await mergeOn("example/*")).toBeUndefined();
    await pr.hedge("require", "--kinds", "live-run");
    await pr.hedge("gap", "--kind", "live-run", "--reason", "No sandbox");
    await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "live-run", "--pr", "example/product#42", "--question", "Accept the live-run gap? example/product#42: No sandbox", "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The hook runs in its own tests");
    expect(await mergeOn("example/*")).toBeDefined();
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a merge word lifts an agent's gap decision only when its card named every proof kind that decision accepts", async () => {
  const pr: Checkout = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.autonomy": "end" });
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "live-run");
  await pr.hedge("gap", "--kind", "live-run", "--reason", "No sandbox");
  const decided = await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--kind", "live-run", "--pr", "example/product#42", "--question", "Accept the live-run gap? example/product#42: No sandbox", "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "The hook runs in its own tests");
  const id = /\[(d-[0-9a-f]+)\]/.exec(decided.output)?.[1] ?? "";
  const head = await pr.git("rev-parse", "HEAD");
  expect((await pr.hedge("gate")).code).toBe(0);
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const merge = async () => (await mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: pr.home, env: { HEDGE_SETTINGS: pr.env.HEDGE_SETTINGS }, github }))?.hookSpecificOutput.permissionDecisionReason;
  expect(await merge()).toContain(`(🤖 ${id} for prod-shape/live-run) itself`);
  pr.choose("Merge", `Merge example/product#42 at ${head}? An agent accepted ${id} for live-run.`);
  expect((await pr.decide("record", "--mark", "👤", "--class", "merge", "--pr", "example/product#42", "--condition", `${head}: merge card`)).code).toBe(0);
  await pr.hedge("require", "--kinds", "prod-shape");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  const gate = await pr.hedge("gate");
  expect(gate.output).toContain(`prod-shape: gap from ${head.slice(0, 7)}, accepted by 🤖 decision ${id}`);
  const held = / · held: ([^·]+) · /.exec(gate.output)?.[1];
  expect(held).toBe(`${id} for prod-shape/live-run`);
  expect(await merge()).toContain(`(🤖 ${id} for prod-shape/live-run) itself`);
  pr.choose("Merge", `Merge example/product#42 at ${head}? An agent accepted ${id} for live-run, and d-0000 for prod-shape.`);
  expect((await pr.decide("record", "--mark", "👤", "--class", "merge", "--pr", "example/product#42", "--condition", `${head}: merge card`)).code).toBe(0);
  expect(await merge()).toContain(`(🤖 ${id} for prod-shape/live-run) itself`);
  pr.choose("Merge", `Merge example/product#42 at ${head}? An agent accepted ${held}.`);
  expect((await pr.decide("record", "--mark", "👤", "--class", "merge", "--pr", "example/product#42", "--condition", `${head}: merge card`)).code).toBe(0);
  expect(await merge()).toBeUndefined();
});

test("a gate pass that read a gap the agent accepted, and did not rely on it, merges without the user's word", async () => {
  const pr: Checkout = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  await pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "live-run", "--pr", "example/product#42", "--question", "Accept the live-run gap? example/product#42: no sandbox", "--answer", "Accept the gap", "--rejected", "Keep the gap open", "--reason", "Nothing runs");
  const head = await pr.git("rev-parse", "HEAD");
  expect((await pr.hedge("gate")).code).toBe(0);
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const merge = () => mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: pr.home, env: { HEDGE_SETTINGS: pr.env.HEDGE_SETTINGS }, github });
  expect(await merge()).toBeUndefined();
  const ledger = join(pr.home, ".local/state/hedge/decisions.jsonl");
  const events = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
  expect(events.some((event) => event.type === "gate")).toBe(true);
  writeFileSync(ledger, events.filter((event) => event.type !== "gate").map((event) => JSON.stringify(event)).join("\n") + "\n");
  expect(await merge()).toBeUndefined();
});
