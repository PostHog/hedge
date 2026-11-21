import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Decision, LedgerEvent } from "../pull-requests/lib/decision-ledger.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { gateRunDirectory, startGateRun, writeJson } from "../pull-requests/lib/proof.ts";
import { git } from "../../src/testing/git.ts";
import { mergeGate } from "./hooks/merge-gate.ts";
import {
  beforeDeadline, cliReason, exemptList, ghAliases, ghBaseRepo, graphqlReason, mergeGateDeadlineMs, readPayload, realIntentIO, mergeGateRisk, mergeIntent, otherEndpointReason, rawReason, shellAliasReason, splitStringReason,
  type GateIO, type IntentIO, type MergeIntent, type Pull,
} from "./lib/merge-gate.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const head = "a".repeat(40);
const lower = "b".repeat(40);
const older = "c".repeat(40);
const exempt = exemptList("own/*, example/notes");
const files: Record<string, string> = { "/work/body.md": "/trunk merge\n", "/work/note.md": "Merged after review.\n", "/work/payload.json": '{"body":"/trunk merge"}', "/work/query.json": '{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}' };
const io: IntentIO = {
  readText: (path) => files[path],
  checkoutRepo: (cwd) => cwd.startsWith("/work") ? "example/product" : cwd.startsWith("/tooling") ? "own/tooling" : undefined,
  aliases: () => ({ m: "pr merge", say: "pr comment", x: "!gh pr merge 7", c: "pr comment $1", ready: "pr comment --body '/trunk merge'", "pr land": "pr merge" }),
};

const bash = (command: string, cwd = "/work") => mergeIntent({ tool_name: "Bash", tool_input: { command }, cwd }, command, exempt, io);
const mcp = (tool: string, input: Record<string, unknown>) => mergeIntent({ tool_name: tool, tool_input: input }, "", exempt, io);
const target = (repository: string, pr: number) => expect.objectContaining({ repository, pr });

describe("which calls enqueue or merge", () => {
  test.each([
    ["gh pr comment 7 --repo example/product --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body /trunk\\ merge"],
    ["gh pr comment 7 -R example/product -b '/trunk merge'"],
    ["gh pr comment 7 --repo=example/product --body='/trunk merge'"],
    ["gh issue comment 7 --repo example/product --body '/trunk merge'"],
    ["gh pr comment https://github.com/example/product/pull/7 --body '/trunk merge'"],
    ["gh pr comment 7 --body '/trunk merge'"],
    ["GH_REPO=example/product gh pr comment 7 --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body-file body.md"],
    ["gh pr comment 7 --repo example/product --body-file - <<'EOF'\n/trunk merge\nEOF"],
    ["printf '/trunk merge' > new.md && gh pr comment 7 --repo example/product -F new.md"],
    ["sh -c \"gh pr comment 7 --repo example/product --body '/trunk merge'\""],
    ["cd /work && gh pr comment 7 --body '/trunk merge'"],
    ["gh api repos/example/product/issues/7/comments -f body='/trunk merge'"],
    ["gh api -X POST repos/example/product/issues/7/comments -F 'body=/trunk merge'"],
    ["gh api repos/example/product/issues/7/comments -F body=@body.md"],
    ["gh api repos/example/product/issues/7/comments --field body=@body.md"],
    ["gh api repos/example/product/issues/7/comments -F body=@missing.md"],
    ["gh api repos/example/product/issues/7/comments --input payload.json"],
    ["gh api repos/{owner}/{repo}/issues/7/comments -f body='/trunk merge'"],
    ["gh api -X PUT repos/example/product/pulls/7/merge"],
    ["gh pr merge 7 --repo example/product --squash"],
    ["gh pr merge 7 --repo example/product --auto --squash"],
    ["gh pr merge 7 --repo example/product --squash --disable-auto=false"],
    ["printf '/trunk merge' | gh pr comment 7 -R example/product -F -"],
    ["cat payload.json | gh api repos/example/product/issues/7/comments --input -"],
    ["gh m 7 -R example/product --squash"],
    ["gh say 7 -R example/product --body '/trunk merge'"],
    ["gh pr comment 7 --repo example/product --body '  /trunk merge'"],
    ["gh pr comment 7 --repo example/product --body $'Ready.\\r\\n/trunk merge'"],
    ["printf '/trunk merge\\n' | gh pr comment 7 -R example/product -F /dev/stdin"],
    ["printf '/trunk merge' | gh pr comment 7 -R example/product --body-file /dev/fd/0"],
    ["printf '/trunk merge' | gh pr comment 7 -R example/product -F /proc/self/fd/0"],
    ["cat payload.json | gh api repos/example/product/issues/7/comments --input /dev/stdin"],
    ["printf '/trunk merge' | gh api repos/example/product/issues/7/comments -F body=@-"],
    ["printf '/trunk merge' | gh api repos/example/product/issues/7/comments -F body=@/dev/stdin"],
    ["gh pr merge 7 --repo example/product --squash --disable-auto=0"],
    ["gh pr merge 7 --repo example/product --squash --disable-auto=f"],
    ["gh pr merge 7 --repo example/product --squash --disable-auto=FALSE"],
    ["gh pr comment 7 --repo example/product --body \"$(echo /trunk merge)\""],
    ["gh pr comment 7 --repo example/product --body \"$(printf '/trunk merge')\""],
    ["B='/trunk merge'; gh pr comment 7 --repo example/product --body \"$B\""],
    ["gh pr comment 7 --repo example/product --body \"`echo /trunk merge`\""],
    ["gh api repos/example/product/issues/7/comments -f body=\"$(echo /trunk merge)\""],
  ])("%s targets example/product#7", (command) => {
    expect(bash(command)).toEqual({ targets: [target("example/product", 7)] });
  });

  test.each([
    ["gh pr comment 7 --repo example/product --body '/trunk cancel'"],
    ["gh pr comment 7 --repo example/product --body 'Waiting for CI before the next step.'"],
    ["gh pr comment 7 --repo example/product --body-file note.md"],
    ["gh pr comment 7 --repo example/product --body \"$(cat note.md) Ready for review.\""],
    ["gh pr merge 7 --repo example/product --disable-auto"],
    ["gh pr merge 7 --repo example/product --disable-auto=1"],
    ["gh pr merge 7 --repo example/product --disable-auto=True"],
    ["gh api repos/example/product/pulls/7/merge"],
    ["gh api repos/example/product/issues/7/comments"],
    ["gh pr view 7 --repo example/product"],
    ["gh pr comment 7 --repo own/tooling --body '/trunk merge'"],
    ["gh pr merge 7 --repo Example/Notes --squash"],
    ["curl -s https://api.github.com/repos/example/product/pulls/7/merge"],
    ["curl -fsSL -H 'Accept: application/json' -o out.json https://api.github.com/repos/example/product/pulls/7/merge"],
    ["curl -X GET https://api.github.com/repos/example/product/pulls/7/merge"],
    ["wget -qO- --header='Accept: application/json' https://api.github.com/repos/example/product/pulls/7/merge"],
    ["gh pr comment 7 --repo example/product --body Owners=@octocat"],
    ["gh pr comment 7 --repo example/product --body 'Thanks, cc=@octocat'"],
    ["gh issue comment 7 --repo example/product -b x=@octocat"],
    ["gh api repos/example/product/issues/7/comments -f body=@octocat"],
    ["gh api repos/example/product/issues/7/comments --raw-field body=@octocat"],
    ["gh pr review 7 --repo example/product --comment --body Owners=@octocat"],
    ["echo done"],
  ])("%s enqueues nothing the gate checks", (command) => {
    expect(bash(command)).toEqual({ targets: [] });
  });

  test.each([
    ["trunk merge 7", cliReason],
    ["~/.cache/trunk/trunk merge --pr 7", cliReason],
    ["curl -X POST https://api.github.com/repos/example/product/issues/7/comments -d '{\"body\":\"/trunk merge\"}'", rawReason],
    ["curl -X PUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -sXPUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -sd '{}' https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -sd '{\"body\":\"/trunk merge\"}' https://api.github.com/repos/example/product/issues/7/comments", rawReason],
    ["curl -s -d'{\"body\":\"/trunk merge\"}' https://api.github.com/repos/example/product/issues/7/comments", rawReason],
    ["curl -s -XPUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -O -d x https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["curl -X GET -X PUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["wget --method=PUT https://api.github.com/repos/example/product/pulls/7/merge", rawReason],
    ["wget -H --post-data='{\"body\":\"/trunk merge\"}' https://api.github.com/repos/example/product/issues/7/comments", rawReason],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", graphqlReason],
    ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'", graphqlReason],
    ["gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"/trunk merge\"}) { clientMutationId } }'", graphqlReason],
    ["gh api -X PATCH repos/example/product/issues/comments/1 -f body='/trunk merge'", otherEndpointReason],
    ["gh pr review 7 --repo example/product --comment -b '/trunk merge'", otherEndpointReason],
    ["env -S 'gh pr merge 7 -R example/product --squash'", splitStringReason],
    ["env --split-string='gh pr merge 7 -R example/product'", splitStringReason],
    ["/usr/bin/env -S 'gh pr merge 7 -R example/product --squash'", splitStringReason],
    ["env -uFOO -S'gh pr merge 7 -R example/product'", splitStringReason],
    ["gh x", shellAliasReason],
    ["gh c 7 --body '/trunk merge'", shellAliasReason],
    ["gh ready 7 -R example/product", shellAliasReason],
    ["gh pr land 7 -R example/product", shellAliasReason],
    ["curl -X POST https://api.github.com/repos/example/product/issues/7/comments -d @missing.json", rawReason],
    ["curl https://api.github.com/repos/example/product/issues/7/comments --data-binary @payload.json", rawReason],
    ["curl https://api.github.com/graphql --json @query.json", rawReason],
    ["make-body | curl https://api.github.com/repos/example/product/issues/7/comments -d @-", rawReason],
    ["make-query | gh api graphql --input -", graphqlReason],
    ["gh api graphql -F query=@missing.graphql", graphqlReason],
  ])("%s is refused outright", (command, reason) => {
    expect(bash(command).refusal).toBe(reason);
  });

  test("a cd before the call moves it to that checkout's repository, out of an exempt one", () => {
    expect(bash("cd /work/product && gh pr merge 7 --squash", "/tooling")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("cd /tooling && gh pr merge 7 --squash", "/work")).toEqual({ targets: [] });
    expect(bash("(cd /tooling) && gh pr merge 7 --squash", "/work")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("(cd /tooling; true); gh pr merge 7", "/work")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("pushd /work/product && gh pr merge 7", "/tooling")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("pushd /tooling && popd && gh pr merge 7", "/work")).toEqual({ targets: [target("example/product", 7)] });
    const checkoutRepo = (cwd: string) => cwd.startsWith(`${homedir()}/dev/product`) ? "example/product" : io.checkoutRepo(cwd);
    const command = "cd ~/dev/product && gh pr merge 7 --squash";
    expect(mergeIntent({ tool_name: "Bash", tool_input: { command }, cwd: "/tooling" }, command, exempt, { ...io, checkoutRepo })).toEqual({ targets: [target("example/product", 7)] });
  });

  test("a merge or enqueue that names no PR is refused, since the gate cannot check it", () => {
    expect(bash("gh pr comment --body '/trunk merge'").refusal).toContain("without naming the PR");
    expect(bash("gh pr merge --squash").refusal).toContain("without naming the PR");
    expect(bash("gh pr comment 7 --body '/trunk merge'", "/elsewhere").refusal).toContain("without naming the PR");
  });

  test("GitHub MCP tools: a comment that posts /trunk merge and a merge tool target the PR", () => {
    expect(mcp("mcp__github__add_issue_comment", { owner: "example", repo: "product", issue_number: 7, body: "/trunk merge" })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__plugin_github_github__merge_pull_request", { owner: "example", repo: "product", pullNumber: 7 })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__github__add_issue_comment", { owner: "example", repo: "product", issue_number: 7, body: "Thanks" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__merge_pull_request", { owner: "example", repo: "product" }).refusal).toContain("without naming the PR");
    expect(mcp("mcp__github__create_pull_request_review", { owner: "example", repo: "product", pullNumber: 7, body: "/trunk merge" }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__plugin_github_github__merge_pull_request", { repository_full_name: "example/product", pr_number: 7 })).toEqual({ targets: [target("example/product", 7)] });
  });

  test("GitHub MCP reads and PR body edits that name /trunk merge enqueue nothing", () => {
    expect(mcp("mcp__github__search_issues", { query: "/trunk merge", owner: "example", repo: "product" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__update_pull_request", { owner: "example", repo: "product", pullNumber: 7, body: "Steps:\n/trunk merge once green" })).toEqual({ targets: [] });
    expect(mcp("mcp__github__get_pull_request_merge_status", { owner: "example", repo: "product", pullNumber: 7 })).toEqual({ targets: [] });
  });
});

const pulls: Record<number, Pull> = {
  7: { head, base: "layer-1", defaultBranch: "main", open: true },
  6: { head: lower, base: "main", defaultBranch: "main", open: true },
  9: { head, base: "main", defaultBranch: "main", open: true },
};
const gatePass = (pr: number, commit: string, passed = true, at = "2026-11-16T08:00:00Z"): LedgerEvent => ({ type: "gate", repository: "Example/Product", pr, commit, passed, machine: "box-2", at });
const override = (commit: string, mark: Decision["mark"] = "👤", pr = 9): LedgerEvent => ({
  type: "decide", decision: {
    id: `o-${commit.slice(0, 1)}-${mark}`, at: "2026-11-16T08:00:00Z", class: "merge", mark, question: `Merge example/product#${pr} without a gate pass?`, answer: "Override",
    scope: { prs: [`example/product#${pr}`], kinds: ["gate-override"], condition: `${commit}: incident fix, the gate's judge is down` }, where: { thread: "t", message: `m-${commit.slice(0, 1)}`, machine: "hub" },
  },
});

const localAt = Date.parse("2026-11-16T08:30:00Z");
function gate({ local = [] as string[], failed = [] as string[], ledger = [] as LedgerEvent[], hubDown = false, github = true } = {}): GateIO {
  return {
    pull: async (_repository, pr) => { if (!github) throw new Error("GitHub answered 502"); return pulls[pr]; },
    pullFor: async (_repository, branch) => branch === "layer-1" ? 6 : undefined,
    isIssue: async (_repository, number) => number === 404,
    localGate: async (_repository, pr, commit) => local.includes(`${pr}@${commit}`) ? { passed: true, at: localAt } : failed.includes(`${pr}@${commit}`) ? { passed: false, at: localAt } : undefined,
    ledger: async () => { if (hubDown) throw new Error("hub unreachable over SSH"); return ledger; },
  };
}
const one = (pr: number, via = "gh pr comment"): MergeIntent => ({ targets: [{ repository: "example/product", pr, via }] });
const risk = (intent: MergeIntent, io: GateIO) => mergeGateRisk(intent, io, "Robin");

describe("the gate pass each layer needs", () => {
  test("a gate pass at the head on this machine lets the enqueue through", async () => {
    expect(await risk(one(9), gate({ local: [`9@${head}`] }))).toBeUndefined();
  });

  test("no gate run or a failed gate refuses it and names the gate command at the full head and whom to ask", async () => {
    const refusal = await risk(one(9), gate());
    expect(refusal).toContain("has not passed at the head of example/product#9");
    expect(refusal).toContain(`hedge proof gate --repo example/product --pr 9 --commit ${head}`);
    expect(refusal).toContain("ask Robin with the question tool");
  });

  test("a pass another machine copied to the ledger counts, but only at the PR's current head", async () => {
    expect(await risk(one(9), gate({ ledger: [gatePass(9, head)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ ledger: [gatePass(9, older)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [gatePass(8, head)] }))).toContain("has not passed");
  });

  test("a failed gate run after a pass at the same head refuses, wherever either was recorded", async () => {
    const later = "2026-11-16T09:00:00Z";
    expect(await risk(one(9), gate({ ledger: [gatePass(9, head, false, later), gatePass(9, head)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [gatePass(9, head, false), gatePass(9, head, true, later)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ failed: [`9@${head}`], ledger: [gatePass(9, head)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ local: [`9@${head}`], ledger: [gatePass(9, head, false, later)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ failed: [`9@${head}`], ledger: [gatePass(9, head, true, later)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ ledger: [gatePass(9, head, false), gatePass(9, head)] }))).toContain("has not passed");
  });

  test("the top layer of a stack needs every open layer below it to pass at its own head", async () => {
    const refusal = await risk(one(7), gate({ local: [`7@${head}`] }));
    expect(refusal).toContain("example/product#6 (a lower layer of example/product#7)");
    expect(refusal).toContain(`--pr 6 --commit ${lower}`);
    expect(await risk(one(7), gate({ local: [`7@${head}`, `6@${lower}`] }))).toBeUndefined();
  });

  test("a closed layer in the middle is followed, so an open layer below it still needs its pass", async () => {
    const walk = {
      ...gate({ local: [`7@${head}`] }),
      pull: async (_r: string, pr: number) => pr === 6 ? { ...pulls[6]!, base: "layer-0", open: false } : pr === 5 ? { head: older, base: "main", defaultBranch: "main", open: true } : pulls[pr],
      pullFor: async (_r: string, branch: string) => branch === "layer-1" ? 6 : branch === "layer-0" ? 5 : undefined,
    };
    const refusal = await risk(one(7), walk);
    expect(refusal).toContain(`--pr 5 --commit ${older}`);
    expect(refusal).not.toContain("product#6");
  });

  test("a stack deeper than the walk, or one that loops, is refused, not passed", async () => {
    const chain = (pr: number): Pull => ({ head, base: `layer-${pr - 1}`, defaultBranch: "main", open: true });
    const deep = { ...gate(), pull: async (_r: string, pr: number) => chain(pr), pullFor: async (_r: string, branch: string) => Number(branch.slice(6)), localGate: async () => ({ passed: true, at: localAt }) };
    expect(await risk(one(100), deep)).toContain("deeper than 12 PRs");
    expect(await risk(one(100), { ...deep, pullFor: async () => 100 })).toContain("loops back to #100");
  });

  test("an unreadable ledger refuses a PR without a local pass and says why", async () => {
    expect(await risk(one(9), gate({ hubDown: true }))).toContain("decision ledger could not be read");
    expect(await risk(one(9), gate({ hubDown: true, local: [`9@${head}`] }))).toBeUndefined();
  });

  test("GitHub not answering refuses the merge; a comment on an issue GitHub shows as no PR passes, and one it hides does not", async () => {
    expect(await risk(one(9), gate({ github: false }))).toContain("could not check it");
    expect(await risk(one(404), gate())).toBeUndefined();
    expect(await risk(one(405), gate())).toContain("cannot read example/product#405");
    expect(await risk(one(404, "gh pr merge"), gate())).toContain("could not check it");
  });

  test("the person's override counts at its head only, and a 🤖, other PR's or voided one never counts", async () => {
    expect(await risk(one(9), gate({ ledger: [override(head)] }))).toBeUndefined();
    expect(await risk(one(9), gate({ ledger: [override(older)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head, "🤖")] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head, "👤", 8)] }))).toContain("has not passed");
    expect(await risk(one(9), gate({ ledger: [override(head), { type: "void", id: "o-a-👤", reason: "pushed", at: "2026-11-16T09:00:00Z" }] }))).toContain("has not passed");
  });

  test("a refusal from reading the call needs no GitHub read", async () => {
    expect(await risk({ targets: [], refusal: cliReason }, gate({ github: false }))).toBe(cliReason);
  });

  test("a check that runs past the deadline is refused, never let through", async () => {
    expect(await beforeDeadline(() => new Promise(() => {}), Promise.resolve())).toContain("could not read GitHub and the decision ledger in time");
    expect(await beforeDeadline(async () => { throw new Error("boom"); }, new Promise(() => {}))).toContain("the merge gate failed (boom)");
  });
});

function homeIn(settings?: unknown) {
  const home = temp.make("home-");
  if (settings !== undefined) {
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return home;
}

describe("the PreToolUse hook", () => {
  const homeWith = homeIn;
  const call = (command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/work" });

  test("denies an enqueue without a gate pass and lets other calls through even while GitHub is down", async () => {
    const where = { home: homeWith({ "guards.person": "Robin" }), env: {}, gate: gate(), intent: io };
    const denied = await mergeGate(call("gh pr comment 9 --repo example/product --body '/trunk merge'"), where);
    expect(denied?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain("ask Robin");
    expect(await mergeGate(call("gh pr view 9 --repo example/product"), { ...where, gate: gate({ github: false }) })).toBeUndefined();
    expect(await mergeGate(call("gh pr comment 9 --repo example/product --body '/trunk merge'"), { ...where, gate: gate({ local: [`9@${head}`] }) })).toBeUndefined();
  });

  test("the gate runs on this machine count by their latest result at the head", async () => {
    const home = homeWith({ "guards.person": "Robin" });
    const github = { pull: async (_repository: string, pr: number) => pulls[pr], pullFor: async () => undefined };
    const where = { home, env: { HEDGE_SETTINGS: undefined }, github, intent: io };
    const merge = () => mergeGate(call("gh pr merge 9 --repo example/product"), where);
    const run = async (code: number) => (await startGateRun(home, { repository: "example/product", pr: 9, commit: head }))({ code, reason: code ? "CI is red" : "every proof is in" });
    expect(await merge()).toBeDefined();
    await run(0);
    expect(await merge()).toBeUndefined();
    await run(1);
    expect((await merge())?.hookSpecificOutput.permissionDecisionReason).toContain("has not passed");
    writeFileSync(join(home, ".local/state/hedge/decisions.jsonl"), JSON.stringify(gatePass(9, head)) + "\n");
    expect(await merge()).toBeDefined();
    await (await startGateRun(home, { repository: "example/product", pr: 9, commit: older }))({ code: 0, reason: "older head" });
    expect(await merge()).toBeDefined();
  });

  test("outside the hedge CLI, the hook reads the decision ledger through its settings file, so a pass from another machine counts", async () => {
    const home = homeWith({ "guards.person": "Robin" });
    writeFileSync(join(home, ".local/state/hedge/decisions.jsonl"), JSON.stringify(gatePass(9, head)) + "\n");
    const github = { pull: async (_repository: string, pr: number) => pulls[pr], pullFor: async () => undefined };
    const where = { home, env: { HEDGE_SETTINGS: undefined }, github, intent: io };
    expect(await mergeGate(call("gh pr merge 9 --repo example/product"), where)).toBeUndefined();
    writeFileSync(join(home, ".local/state/hedge/decisions.jsonl"), JSON.stringify(gatePass(9, older)) + "\n");
    expect(await mergeGate(call("gh pr merge 9 --repo example/product"), where)).toBeDefined();
  });

  test("guards.merge-gate-exempt lets the listed repositories merge without a gate pass", async () => {
    const where = (settings: unknown) => ({ home: homeWith(settings), env: {}, gate: gate(), intent: io });
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), where({ "guards.merge-gate-exempt": "own/*" }))).toBeUndefined();
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), where({}))).toBeDefined();
  });

  test("settings it cannot read refuse a merge rather than skip the gate, and leave other calls alone", async () => {
    const broken = { home: homeWith("{not json"), env: {}, gate: gate({ local: [`9@${head}`] }), intent: io };
    const denied = await mergeGate(call("gh pr merge 9 --repo own/tooling"), broken);
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain("could not read its settings");
    expect(await mergeGate(call("gh pr view 9 --repo example/product"), broken)).toBeUndefined();
    expect(await mergeGate({ tool_name: "Read", tool_input: { file_path: "/work/body.md" } }, broken)).toBeUndefined();
    expect(await mergeGate(call("gh pr merge 9 --repo own/tooling"), { home: homeWith({ "guards.merge-gate-exempt": 7 }), env: {}, gate: gate(), intent: io })).toBeDefined();
  });
});

test("the merge-gate workflow installs the hook, and the installed script refuses an enqueue it cannot check", async () => {
  const engine = await engineSource();
  const plan = (on: boolean) => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["guards"], workflows: { "merge-gate": on } }, devbox);
  const hookSource = (files: ({ target: string } & ({ source: string } | { content: string }))[]) => {
    const file = files.find((item) => item.target === ".config/hedge/hooks/PreToolUse/merge-gate.ts");
    return file && "source" in file ? file.source : undefined;
  };
  expect(hookSource(plan(false).files)).toBeUndefined();
  const source = hookSource(plan(true).files);
  expect(source).toEndWith("packs/guards/hooks/merge-gate.ts");
  const child = Bun.spawn([process.execPath, source!, "claude"], {
    env: { ...process.env, HOME: temp.make("home-") }, stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command: "trunk merge 7" }, cwd: "/" })]), stdout: "pipe",
  });
  const answer = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(answer.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: cliReason });
});

describe("the hook against GitHub, faked at the gh boundary, and real checkouts, gate runs and ledgers", () => {
  const pull = (sha: string, base = "main", state = "open") => ({ head: { sha }, base: { ref: base, repo: { default_branch: "main" } }, state });
  const machine = (responses: Record<string, unknown>, passes: LedgerEvent[] = [], aliases: Record<string, string> = {}) => {
    const home = homeIn({ "guards.person": "Robin" });
    writeFileSync(join(home, ".local/state/hedge/decisions.jsonl"), passes.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const bin = temp.make("bin-");
    writeFileSync(join(bin, "answers.json"), JSON.stringify(responses));
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst body = (await Bun.file(${JSON.stringify(join(bin, "answers.json"))}).json())[process.argv[4]];\n`
      + `process.stdout.write(body === undefined ? "HTTP/2.0 404 Not Found\\r\\n\\r\\n{}" : "HTTP/2.0 200 OK\\r\\n\\r\\n" + JSON.stringify(body));\nprocess.exit(body === undefined ? 1 : 0);\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const where = { home, env: { HEDGE_SETTINGS: undefined, PATH: `${bin}:${process.env.PATH}` }, intent: { ...realIntentIO, ghRepo: undefined, aliases: () => aliases } };
    const hook = async (command: string, cwd = "/") => (await mergeGate({ tool_name: "Bash", tool_input: { command }, cwd }, where))?.hookSpecificOutput.permissionDecisionReason;
    return Object.assign(hook, { home });
  };
  const pass = (repository: string, pr: number, commit: string): LedgerEvent => ({ type: "gate", repository, pr, commit, passed: true, machine: "box-2", at: "2026-11-16T08:00:00Z" });
  const openHead = (branch: string) => `repos/example/product/pulls?state=open&per_page=2&head=example:${branch}`;
  const closedHead = (branch: string) => `repos/example/product/pulls?state=closed&sort=created&direction=desc&per_page=1&head=example:${branch}`;

  test("a comment passes on an issue GitHub shows, and is refused on a PR without a pass or a target GitHub hides", async () => {
    const hook = machine({ "repos/example/product/issues/4": { number: 4 }, "repos/example/product/pulls/9": pull(head), "repos/example/product/issues/9": { number: 9, pull_request: {} } });
    const enqueue = (number: number) => hook(`gh pr comment ${number} --repo example/product --body '/trunk merge'`);
    expect(await enqueue(4)).toBeUndefined();
    expect(await enqueue(9)).toContain("has not passed at the head of example/product#9");
    expect(await enqueue(5)).toContain("cannot read example/product#5");
  });

  test("a stack layer's parent is its open PR, not a newer closed one, and two open parents are refused", async () => {
    const github = {
      "repos/example/product/pulls/7": pull(head, "layer-1"), "repos/example/product/pulls/6": pull(lower), "repos/example/product/pulls/8": pull(older, "main", "closed"),
      [openHead("layer-1")]: [{ number: 6 }], [closedHead("layer-1")]: [{ number: 8 }],
      "repos/example/product/pulls/3": pull(head, "twice"), [openHead("twice")]: [{ number: 1 }, { number: 2 }],
    };
    const merge = "gh pr merge 7 --repo example/product";
    expect(await machine(github, [pass("example/product", 7, head)])(merge)).toContain("example/product#6 (a lower layer of example/product#7)");
    expect(await machine(github, [pass("example/product", 7, head), pass("example/product", 6, lower)])(merge)).toBeUndefined();
    expect(await machine(github, [pass("example/product", 3, head)])("gh pr merge 3 --repo example/product")).toContain("more than one open PR");
  });

  test("a merged parent is followed to the open layer below it", async () => {
    const github = {
      "repos/example/product/pulls/7": pull(head, "layer-1"), "repos/example/product/pulls/6": pull(lower, "layer-0", "closed"), "repos/example/product/pulls/5": pull(older),
      [openHead("layer-1")]: [], [closedHead("layer-1")]: [{ number: 6 }], [openHead("layer-0")]: [{ number: 5 }],
    };
    const reason = await machine(github, [pass("example/product", 7, head)])("gh pr merge 7 --repo example/product");
    expect(reason).toContain(`--pr 5 --commit ${older}`);
    expect(reason).not.toContain("product#6");
  });

  test("a PR number in a checkout is checked in the repository gh picks, and refused when several remotes leave it open", async () => {
    const checkout = (...remotes: [string, string, string?][]) => {
      const dir = temp.make("checkout-");
      git(dir, "init", "-q");
      for (const [name, url, resolved] of remotes) {
        git(dir, "remote", "add", name, url);
        if (resolved) git(dir, "config", `remote.${name}.gh-resolved`, resolved);
      }
      return dir;
    };
    const github = { "repos/example/product/pulls/9": pull(head), "repos/fork/product/pulls/9": pull(older) };
    const forkPassed = machine(github, [pass("fork/product", 9, older)]);
    const upstreamPassed = machine(github, [pass("example/product", 9, head)]);
    const resolved = checkout(["origin", "https://github.com/fork/product.git"], ["upstream", "https://github.com/example/product.git", "base"]);
    expect(await forkPassed("gh pr merge 9", resolved)).toContain("has not passed at the head of example/product#9");
    expect(await upstreamPassed("gh pr merge 9", resolved)).toBeUndefined();
    expect(await upstreamPassed("gh pr merge 9", checkout(["origin", "https://github.com/fork/product.git", "example/product"]))).toBeUndefined();
    expect(await forkPassed("gh pr merge 9", checkout(["origin", "git@github.com:fork/product.git"]))).toBeUndefined();
    expect(await upstreamPassed("gh pr merge 9", checkout(["origin", "https://github.com/fork/product.git"], ["upstream", "https://github.com/example/product.git"]))).toContain("without naming the PR");
    expect(ghBaseRepo("")).toBeUndefined();
  });

  test("gh aliases from gh's config, quoted names with several words included, are expanded or refused", async () => {
    const config = join(temp.make("gh-"), "config.yml");
    writeFileSync(config, "git_protocol: https\naliases:\n    m: pr merge\n    \"pr land\": 'pr merge 9 --repo example/product'\nother: 1\n");
    const hook = machine({ "repos/example/product/pulls/9": pull(head) }, [], ghAliases(config));
    expect(await hook("gh m 9 --repo example/product")).toContain("has not passed at the head of example/product#9");
    expect(await hook("gh pr land")).toBe(shellAliasReason);
    expect(await hook("gh pr view 9 --repo example/product")).toBeUndefined();
  });

  test("a body the gate cannot read is gated like an enqueue, on the CLI and the REST comment path", async () => {
    const hook = machine({ "repos/example/product/pulls/9": pull(head) });
    const dir = temp.make("work-");
    expect(await hook("gh pr comment 9 --repo example/product --body-file missing.md", dir)).toContain("has not passed at the head of example/product#9");
    expect(await hook("gh api repos/example/product/issues/9/comments -F body=@missing.md", dir)).toContain("has not passed at the head of example/product#9");
    expect(await hook("make-query | gh api graphql -F query=@-", dir)).toBe(graphqlReason);
  });

  const bodyEdits = () => {
    const dir = temp.make("edit-");
    const body = "## Problem\n\nThe `merge-gate` guard refused this edit.\n\n> Merge risk: low · two-way door\n";
    writeFileSync(join(dir, "body.md"), body);
    writeFileSync(join(dir, "body.json"), JSON.stringify({ body }));
    symlinkSync(join(dir, "body.json"), join(dir, "linked.json"));
    return { dir, hook: machine({ "repos/example/product/pulls/9": pull(head) }) };
  };

  test.each([
    ["gh api -X PATCH repos/example/product/pulls/9 --input body.json"],
    ["gh api -X PATCH repos/example/product/pulls/9 --input ./linked.json"],
    ["gh api --method PATCH repos/example/product/pulls/9 --input body.json"],
    ["gh api -X PATCH repos/example/product/issues/9 --input body.json"],
    ["gh api -X PATCH repos/example/product/pulls/9 -F body=@body.md"],
    ["gh api -X PATCH repos/example/product/pulls/9 --field body=@body.md"],
    ["gh api -X PATCH repos/example/product/pulls/9 -f body=\"$(cat body.md)\""],
    ["gh api -X PATCH repos/example/product/pulls/9 --raw-field 'body=Fixes the `merge-gate` guard.'"],
    ["gh api -X PATCH repos/example/product/pulls/9 -f title='Read the PR body payload'"],
    ["gh api -X PATCH repos/example/product/issues/comments/1 --input body.json"],
    ["gh api -X PATCH repos/example/product/pulls/9 --input body.json >> body.json"],
  ])("a body edit whose payload the gate reads and finds no /trunk merge in passes: %s", async (command) => {
    const { dir, hook } = bodyEdits();
    expect(await hook(command, dir)).toBeUndefined();
    expect(await hook(command.replace(/(?<=[ @])(?:\.\/)?(body|linked)\.(json|md)/, `${dir}/$1.$2`), "/")).toBeUndefined();
  });

  test.each([
    ["jq -n --rawfile body body.md '{body: $body}' > new.json && gh api -X PATCH repos/example/product/pulls/9 --input new.json"],
    ["gh api repos/example/product/pulls/9 --jq .body > live.md && sed -i 's/low/medium/' live.md && gh api -X PATCH repos/example/product/pulls/9 -F body=@live.md"],
    ["gh api -X PATCH repos/example/product/pulls/9 --input missing.json"],
    ["gh api -X PATCH repos/example/product/pulls/9 --input <(make-body)"],
    ["f=$(mktemp); gh api -X PATCH repos/example/product/pulls/9 --input \"$f\""],
    ["gh pr review 9 --repo example/product --comment --body-file missing.md"],
  ])("a body edit whose payload the gate cannot read, such as a file the same command writes first, is refused and told to write it first: %s", async (command) => {
    const { dir, hook } = bodyEdits();
    const reason = await hook(command, dir);
    expect(reason).toContain("the merge gate cannot read the file it sends");
    expect(reason).toContain("Write the file in one call, then send it with a call of its own.");
  });

  test.each([
    ["{\"body\":\"Ready.\\n/trunk merge\"}"],
    ["{\"body\":\"Ready.\\n\\/trunk merge\"}"],
    ["{\"body\":\"Ready.\\n\\u002ftrunk merge\"}"],
    ["{\"body\":\"Ready.\\r\\n  /TRUNK \\t MERGE now\"}"],
    ["{\"title\":\"/trunk merge\"}"],
  ])("a body edit, comment edit or review whose payload holds /trunk merge is still refused: %s", async (payload) => {
    const { dir, hook } = bodyEdits();
    writeFileSync(join(dir, "enqueue.json"), payload);
    writeFileSync(join(dir, "enqueue.md"), "Ready.\n/trunk merge\n");
    for (const command of [
      "gh api -X PATCH repos/example/product/pulls/9 --input enqueue.json",
      "gh api --method PATCH repos/example/product/issues/9 --input enqueue.json",
      "gh api -X PATCH repos/example/product/issues/comments/1 --input enqueue.json",
      "gh api repos/example/product/pulls/9/reviews --input enqueue.json",
      `gh api -X PATCH repos/example/product/pulls/9 --input ${dir}/enqueue.json`,
    ]) expect(await hook(command, dir)).toBe(otherEndpointReason);
    expect(await hook("gh api -X PATCH repos/example/product/pulls/9 -F body=@enqueue.md", dir)).toBe(otherEndpointReason);
    expect(await hook("gh pr review 9 --repo example/product --comment --body-file enqueue.md", dir)).toBe(otherEndpointReason);
    expect(await hook("gh api graphql -F query=@enqueue.json", dir)).toBe(graphqlReason);
  });

  test("a call that sends a readable /trunk merge beside a file the gate cannot read keeps the /trunk merge refusal", async () => {
    const { dir, hook } = bodyEdits();
    writeFileSync(join(dir, "enqueue.md"), "Ready.\n/trunk merge\n");
    expect(await hook("gh api -X PATCH repos/example/product/pulls/9 -F body=@enqueue.md -F title=@missing.md", dir)).toBe(otherEndpointReason);
    expect(await hook("gh pr review 9 --repo example/product --comment --body '/trunk merge' --body-file missing.md", dir)).toBe(otherEndpointReason);
  });

  test("the run that started last decides, even when an earlier run took a higher record number", async () => {
    const hook = machine({ "repos/example/product/pulls/9": pull(head) });
    const identity = { repository: "example/product", pr: 9, commit: head };
    const merge = () => hook("gh pr merge 9 --repo example/product");
    const later = await startGateRun(hook.home, identity, new Date("2026-11-16T08:10:00Z"));
    const earlier = await startGateRun(hook.home, identity, new Date("2026-11-16T08:00:00Z"));
    await earlier({ code: 0, reason: "pass" });
    expect(await merge()).toContain("has not passed");
    await later({ code: 1, reason: "CI is red" });
    expect(await merge()).toContain("has not passed");
    await (await startGateRun(hook.home, identity, new Date("2026-11-16T08:20:00Z")))({ code: 0, reason: "pass" });
    expect(await merge()).toBeUndefined();
  });

  test("a gate record from before runs kept their start counts as a failure that any timed run replaces", async () => {
    const hook = machine({ "repos/example/product/pulls/9": pull(head) });
    const identity = { repository: "example/product", pr: 9, commit: head };
    await writeJson(join(gateRunDirectory(hook.home, identity), "1.json"), { code: 0, reason: "every proof is in" });
    expect(await hook("gh pr merge 9 --repo example/product")).toContain("has not passed");
    await (await startGateRun(hook.home, identity, new Date("2026-11-16T08:20:00Z")))({ code: 0, reason: "pass" });
    expect(await hook("gh pr merge 9 --repo example/product")).toBeUndefined();
  });

  test("a PR number in a checkout without a GitHub remote is refused, since no repository can be checked", async () => {
    const dir = temp.make("checkout-");
    git(dir, "init", "-q");
    expect(await machine({})("gh pr merge 9", dir)).toContain("without naming the PR");
  });

  test("ordered by when each run started, a run that started later decides, however late the older one finishes", async () => {
    const hook = machine({ "repos/example/product/pulls/9": pull(head) }, [
      { ...pass("example/product", 9, head), passed: false, at: "2026-11-16T08:10:00Z" } as LedgerEvent,
      pass("example/product", 9, head),
    ]);
    const identity = { repository: "example/product", pr: 9, commit: head };
    const older = await startGateRun(hook.home, identity, new Date("2026-11-16T08:00:00Z"));
    const newer = await startGateRun(hook.home, identity, new Date("2026-11-16T08:10:00Z"));
    await newer({ code: 1, reason: "CI is red" });
    await older({ code: 0, reason: "pass" });
    expect(await hook("gh pr merge 9 --repo example/product")).toContain("has not passed");
    appendFileSync(join(hook.home, ".local/state/hedge/decisions.jsonl"), JSON.stringify({ ...pass("example/product", 9, head), at: "2026-11-16T08:15:00Z" }) + "\n");
    expect(await hook("gh pr merge 9 --repo example/product")).toBeUndefined();
    const later = await startGateRun(hook.home, identity, new Date("2026-11-16T08:20:00Z"));
    await later({ code: 0, reason: "pass" });
    expect(await hook("gh pr merge 9 --repo example/product")).toBeUndefined();
  });
});

test("the installed hook reads gh's aliases from GH_CONFIG_DIR, and a FIFO as a payload cannot stall it", async () => {
  const fifo = temp.make("fifo-");
  expect(Bun.spawnSync(["mkfifo", join(fifo, "body")]).exitCode).toBe(0);
  const config = temp.make("gh-");
  writeFileSync(join(config, "config.yml"), "aliases:\n    \"pr land\": 'pr merge 9 --repo example/product'\n");
  const answer = async (command: string, cwd: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "hooks/merge-gate.ts"), "claude"], {
      env: { ...process.env, HOME: temp.make("home-"), GH_CONFIG_DIR: config }, cwd, timeout: 4_000,
      stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd })]), stdout: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output).hookSpecificOutput.permissionDecisionReason;
  };
  expect(await answer("gh pr land", "/")).toBe(shellAliasReason);
  expect(await answer("curl -X POST https://api.github.com/repos/example/product/issues/7/comments -d @body", fifo)).toBe(rawReason);
});

test("a payload swapped for a FIFO after the reader checked it is read from the file it checked, never by its path", () => {
  const dir = temp.make("swap-");
  const body = join(dir, "body");
  writeFileSync(body, "Merged after review.\n");
  let writer: ReturnType<typeof Bun.spawn> | undefined;
  const swap = () => {
    rmSync(body);
    expect(Bun.spawnSync(["mkfifo", body]).exitCode).toBe(0);
    writer = Bun.spawn(["sh", "-c", 'printf "/trunk merge\\n" > "$0"', body]);
  };
  try {
    expect(readPayload(body, swap)).toBe("Merged after review.\n");
  } finally { writer?.kill(); }
});

test("the merge-gate risk names the deadline the hook keeps", () => {
  const pack = JSON.parse(readFileSync(join(import.meta.dir, "pack.json"), "utf8")) as { workflows: { id: string; risk: string }[] };
  expect(pack.workflows.find((workflow) => workflow.id === "merge-gate")?.risk).toContain(`up to ${mergeGateDeadlineMs / 1000} seconds`);
});

describe("a piped comment body", () => {
  test("needs a gate pass, and the refusal says why", async () => {
    const piped = bash("cat notes.md | gh pr comment 9 -R example/product -F -");
    expect(piped).toEqual({ targets: [target("example/product", 9)] });
    expect(await risk(piped, gate())).toContain("A piped body cannot be read");
    expect(await risk(bash("gh pr merge 9 -R example/product"), gate())).not.toContain("piped body");
  });
});
