import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, LedgerEvent } from "../pull-requests/lib/decision-ledger.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { gateRunDirectory, startGateRun, writeJson } from "../pull-requests/lib/proof.ts";
import { git } from "../../src/testing/git.ts";
import { mergeGate } from "./hooks/merge-gate.ts";
import {
  beforeDeadline, cliReason, exemptList, ghAliases, ghBaseRepo, graphqlReason, mergeGateDeadlineMs, readPayload, realIntentIO, mergeGateRisk, mergeIntent, otherEndpointReason, rawReason, shellAliasReason, splitStringReason, unreadPayloadReason,
  type GateIO, type IntentIO, type MergeIntent, type Pull,
} from "./lib/merge-gate.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const head = "a".repeat(40);
const lower = "b".repeat(40);
const older = "c".repeat(40);
const exempt = exemptList("own/*, example/notes");
const files: Record<string, string> = { "body.md": "/trunk merge\n", "note.md": "Merged after review.\n", "payload.json": '{"body":"/trunk merge"}', "query.json": '{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}', "merge.graphql": "mutation { mergePullRequest(input: {}) { clientMutationId } }", "read.graphql": "query($owner: String!) { repository(owner: $owner, name: \"product\") { id } }", "note.json": '{"body":"Ready for review."}', "read.json": '{"query":"query { viewer { login } }"}', "$F": "Ready for review.\n", "repo-read.graphql": "query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } } # {repo} :owner", "{repo}.graphql": "query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }", "comment.graphql": "mutation($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }", "deep.json": `{"body":"/trunk merge","junk":${"[".repeat(200_000)}${"]".repeat(200_000)}}` };
const workFiles = mkdtempSync(join(tmpdir(), "merge-gate-work-"));
for (const [name, text] of Object.entries(files)) writeFileSync(join(workFiles, name), text);
afterAll(() => rmSync(workFiles, { recursive: true, force: true }));
const io: IntentIO = {
  readText: (path) => path.startsWith("/work/") ? readPayload(join(workFiles, path.slice("/work/".length))) : undefined,
  checkoutRepo: (cwd) => cwd.startsWith("/work") ? "example/product" : cwd.startsWith("/tooling") ? "own/tooling" : undefined,
  aliases: () => ({ m: "pr merge", say: "pr comment", x: "!gh pr merge 7", c: "pr comment $1", ready: "pr comment --body '/trunk merge'", "pr land": "pr merge" }),
};

const bash = (command: string, cwd = "/work") => mergeIntent({ tool_name: "Bash", tool_input: { command }, cwd }, command, exempt, io);
const mcp = (tool: string, input: Record<string, unknown>) => mergeIntent({ tool_name: tool, tool_input: input }, "", exempt, io);
const target = (repository: string, pr: number) => expect.objectContaining({ repository, pr });

describe("which calls enqueue or merge", () => {
  test("a merge after 40,000 literal pipeline stages still targets its PR", () => {
    expect(bash([...Array(40_000).fill("true"), "gh pr merge 7 --repo example/product"].join(" | "))).toEqual({ targets: [target("example/product", 7)] });
  });

  test("a comment mutation after a 300,000-character name in a query file is still refused", () => {
    writeFileSync(join(workFiles, "long.graphql"), `${"x".repeat(300_000)}\nmutation($b: String!) { addComment(input: {subjectId: "x", body: $b}) { clientMutationId } }`);
    expect(bash("gh api graphql -F query=@long.graphql -f b=\"$B\"").refusal).toBe(graphqlReason);
  });

  test("a run-time body beside a field with a 128,000-character key is still refused", () => {
    expect(bash(`gh api -X PATCH repos/example/product/issues/comments/1 -f ${"x".repeat(128_000)}[]="$V" -f body="$B"`).refusal).toBe(unreadPayloadReason);
    expect(bash(`gh api -X PATCH repos/example/product/issues/comments/1 -f ${"x".repeat(128_000)}[body]="$B"`).refusal).toBe(unreadPayloadReason);
  });

  test("a comment mutation after an unclosed string of 100,000 escaped quotes is still refused", () => {
    writeFileSync(join(workFiles, "slow.graphql"), `"${'\\"'.repeat(100_000)}\nmutation($b: String!) { addComment(input: {subjectId: "x", body: $b}) { clientMutationId } }`);
    expect(bash("gh api graphql -F query=@slow.graphql -f b=\"$B\"").refusal).toBe(graphqlReason);
  });

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
    ["gh pr comment 7 --repo example/product --body $\"/trunk merge\""],
    ["zsh -c 'B=\"/trunk merge\"; gh pr comment 7 --repo example/product --body \"$~B\"'"],
    ["zsh -c 'B=\"/trunk merge\"; gh pr comment 7 --repo example/product --body \"$^B\"'"],
    ["bash -c \"echo $X; xargs $'gh' pr comment 7 --repo example/product --body '/trunk merge' < /dev/null\""],
  ])("%s targets example/product#7", (command) => {
    expect(bash(command)).toMatchObject({ targets: [target("example/product", 7)] });
  });

  test.each([
    ["gh pr comment 7 --repo example/product --body '/trunk cancel'"],
    ["gh pr comment 7 --repo example/product --body 'Waiting for CI before the next step.'"],
    ["gh pr comment 7 --repo example/product --body-file note.md"],
    ["gh pr merge 7 --repo example/product --disable-auto"],
    ["gh pr merge 7 --repo example/product --disable-auto=1"],
    ["gh pr merge 7 --repo example/product --disable-auto=True"],
    ["gh api repos/example/product/pulls/7/merge"],
    ["gh api repos/example/product/issues/7/comments"],
    ["gh pr view 7 --repo example/product"],
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
    ["gh pr comment 7 --repo own/tooling --body '/trunk merge'", "own/tooling"],
    ["gh pr merge 7 --repo Example/Notes --squash", "Example/Notes"],
  ])("%s in an exempt repository parses as an exempt target, which the hook checks only for gaps an agent accepted", (command, repository) => {
    expect(bash(command)).toEqual({ targets: [], exempt: [target(repository, 7)] });
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
    ["B='/trunk merge'; gh api --hostname \"$H\" repos/example/product/pulls/7/comments/1/replies -f body=\"$B\"", otherEndpointReason],
    ["B='/trunk merge'; gh api repos/example/product/pulls/7/comments/1/replies -f body=\"$B\"", otherEndpointReason],
    ["gh api repos/example/product/pulls/7/comments/1/replies -f body=\"After CI, run /trunk merge on $PR.\"", otherEndpointReason],
    ["B='/trunk merge'; gh api \"$E\" -f query='mutation($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", otherEndpointReason],
  ])("%s is refused outright", (command, reason) => {
    expect(bash(command).refusal).toBe(reason);
  });

  test.each([
    ["B=$(cat body.md); gh pr comment 7 --repo example/product --body \"$B\""],
    ["gh pr comment 7 --repo example/product --body \"$(cat body.md)\""],
    ["gh pr comment 7 --repo example/product --body \"$(cat note.md) Ready for review.\""],
    ["gh pr comment 7 --repo example/product --body=$B"],
    ["gh pr comment 7 --repo example/product -b\"${B}\""],
    ["gh pr comment 7 --repo example/product --body \"`cat body.md`\""],
    ["gh pr comment 7 --repo example/product --body $B"],
    ["bash -c \"gh pr comment 7 --repo example/product --body '$(cat body.md)'\""],
    ["eval \"gh pr comment 7 --repo example/product --body '$B'\""],
    ["bash <<EOF\ngh pr comment 7 --repo example/product --body '$B'\nEOF"],
    ["echo \"gh pr comment 7 --repo example/product --body '$B'\" | sh"],
    ["cat args.txt | xargs gh pr comment 7 --repo example/product --body x"],
    ["gh issue comment 7 --repo example/product -b \"$B\""],
    ["gh pr comment 7 --repo example/product --body-file - <<EOF\n$(cat body.md)\nEOF"],
    ["gh pr comment 7 --repo example/product --body-file - <<EOF\nReady.\n$B\nEOF"],
    ["gh pr comment 7 --repo example/product -F - <<< \"$B\""],
    ["sh -c 'gh pr comment 7 --repo example/product --body \"$B\"'"],
    ["gh api repos/example/product/issues/7/comments -f body=\"$B\""],
    ["gh api repos/example/product/issues/7/comments -F \"body=$(cat body.md)\""],
    ["gh api repos/example/product/issues/7/comments --raw-field body=`cat body.md`"],
    ["gh pr comment 7 --repo example/product --body-file \"$F\""],
    ["bash -c \"X=\\$(gh pr comment 7 --repo example/product --body '$B')\""],
    ["bash -c \"gh pr comment 7 --repo example/product -F - <<'EOF'\n$B\nEOF\""],
    ["bash -c \"gh pr comment 7 --repo example/product -F - <<< '$B'\""],
    ["bash -c \"gh pr comment 7 --repo example/product --body '`cat body.md`'\""],
    ["gh pr comment 7 --repo example/product --body \"$\\\nB\""],
    ["gh pr comment 7 --repo example/product --body $\\\nB"],
  ])("a comment body built at run time is checked as an unread body: %s", (command) => {
    expect(bash(command)).toEqual({ targets: [target("example/product", 7)], unreadOnly: true });
  });

  test.each([
    ["gh pr review 7 --repo example/product --comment --body \"$B\"", unreadPayloadReason],
    ["gh pr review 7 --repo example/product --approve -b \"$(cat body.md)\"", unreadPayloadReason],
    ["gh api -X PATCH repos/example/product/issues/comments/1 -f body=\"$B\"", unreadPayloadReason],
    ["gh api -X PATCH repos/example/product/pulls/7 -f body=\"$(cat body.md)\"", unreadPayloadReason],
    ["gh api repos/example/product/pulls/7/reviews -f event=COMMENT -f \"comments[][body]=$B\"", unreadPayloadReason],
    ["Q=$(cat merge.graphql); gh api graphql -f query=\"$Q\"", graphqlReason],
    ["gh api graphql -F query=\"$(cat merge.graphql)\"", graphqlReason],
    ["gh api graphql -f query=\"`cat merge.graphql`\"", graphqlReason],
    ["gh api graphql -f query='mutation($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f 'query=query { viewer { login } }' -f \"$K=$V\"", graphqlReason],
    ["gh api graphql -F query=@comment.graphql -f b=\"$B\"", graphqlReason],
    ["gh api graphql -F query=@- -f owner=\"$OWNER\" <<< \"$Q\"", graphqlReason],
    ["gh api graphql -f 'query=mutation,($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f 'query=mutation # c\n($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f 'query=query A { viewer { login } } mutation B($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f operationName=B -f b=\"$B\"", graphqlReason],
    ["cat body.md | gh pr review 7 --repo example/product --comment -F -", unreadPayloadReason],
    ["gh api graphql -f 'query=query A { viewer { login } },mutation B($b: String!) { addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f operationName=B -f b=\"$B\"", graphqlReason],
    ["cat args.txt | xargs gh api repos/example/product/issues/7/comments", unreadPayloadReason],
    ["echo body=x | xargs gh api repos/example/product/issues/comments/1 -X PATCH -f", unreadPayloadReason],
    ["gh api -X PATCH repos/example/product/issues/comments/1 -f \"$K=$V\"", unreadPayloadReason],
    ["gh api graphql -f 'query=mutation($t: ID!, $b: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $t, body: $b}) { comment { id } } }' -f t=x -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f 'query=mutation($id: ID!) { submitPullRequestReview(input: {pullRequestReviewId: $id, event: COMMENT}) { clientMutationId } }' -f id=\"$ID\"", graphqlReason],
    ["gh api graphql -f 'query=mutation($b: String!) { updateIssueComment(input: {id: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f 'query=mutation($b: String!) { updatePullRequest(input: {pullRequestId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f query=\"mutation { resolveReviewThread(input: {threadId: \\\"$T\\\"}) { thread { isResolved } } }\"", graphqlReason],
    ["gh api graphql -f query=\"query A { repository(owner: \\\"example\\\", name: \\\"product\\\") { pullRequest(number: $n) { id } } }\"", graphqlReason],
    ["gh api graphql -F query=@\"$F\"", graphqlReason],
    ["gh api \"$R/1/replies\" -f body=\"$A\"", unreadPayloadReason],
    ["gh api -X PATCH repos/example/product/issues/7 -f body=\"$B\"", unreadPayloadReason],
    ["gh api repos/example/product/pulls/7/reviews/1/events -f event=COMMENT -f body=\"$B\"", unreadPayloadReason],
    ["gh api repos/{owner}/{repo}/issues/{branch}/comments -f body=\"$B\"", unreadPayloadReason],
    ["gh api repos/example/product/issues/%37/comments -f body=\"$B\"", unreadPayloadReason],
    ["gh api repos/example/product/pulls/7/comments/1/replies/../../../../../issues/7/comments -f body=\"$B\"", unreadPayloadReason],
    ["gh api repos/example/product/commits/abc/comments -f body=\"$B\"", unreadPayloadReason],
    ["gh api -X PATCH repos/example/product/pulls/7 --input \"$F\"", unreadPayloadReason],
    ["gh api graphql -f query='{ viewer { login } }' -f \"$KEY=x{ a }\"", graphqlReason],
    ["gh api graphql -f Query='{ viewer { login } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -F query='mutation($b: String!) { {repo}(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql --field query='mutation($b: String!) { :repo(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f query={viewer{login$X}}", graphqlReason],
    ["gh api graphql -f query=\"{ viewer { login } }\"$X", graphqlReason],
    ["gh api graphql -f \"query={ viewer { login\"$X\" } }\"", graphqlReason],
    ["gh api graphql -f \"query={ viewer { login } } $@\"", graphqlReason],
    ["gh api graphql -f \"query={ viewer { login } } ${args[@]}\"", graphqlReason],
    ["gh api graphql -f query=\"query{repository(owner:\\\"example\\\",name:\\\"product\\\"){pullRequest(number:$n){id}}}\"", graphqlReason],
    ["gh api graphql -f query=\" { repository(owner: \\\"example\\\", name: \\\"product\\\") { pullRequest(number: $n) { id } } }\"", graphqlReason],
    ["gh api repos/example/product/pulls/7/comments/1/replies$S -f body=\"$B\"", unreadPayloadReason],
    ["gh api \"https://$H/repos/example/product/pulls/7/comments/1/replies\" -f body=\"$B\"", unreadPayloadReason],
    ["gh api \"https://api.github.com$X/repos/example/product/pulls/7/comments/1/replies\" -f body=\"$B\"", unreadPayloadReason],
    ["printf x | xargs gh api repos/example/product/pulls/7/comments/1/replies -f body=", unreadPayloadReason],
    ["gh api graphql -f 'query=mutation($b: String!) { query addComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f query=$'mutation($b: String!) { # c\\raddComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api graphql -f query=$'mutation($b: String!) { resolveReviewThread(input: {threadId: \"x\\\\\\naddComment(input: {subjectId: \"x\", body: $b}) { clientMutationId } }' -f b=\"$B\"", graphqlReason],
    ["gh api repos/example/product/pulls/7/comments/1/replies --input missing.json", unreadPayloadReason],
    ["cat args.txt | xargs gh api", unreadPayloadReason],
  ])("a review, comment edit or GraphQL call whose body or query is built at run time is refused: %s", (command, reason) => {
    expect(bash(command).refusal).toBe(reason);
  });

  test.each([
    ["gh pr comment 7 --repo example/product --body 'Costs $5, see `merge-gate`.'"],
    ["gh pr comment 7 --repo example/product --body \"Costs \\$5, see \\`merge-gate\\`.\""],
    ["gh pr comment 7 --repo example/product --body $'Costs $5.\\n'"],
    ["gh pr comment 7 --repo example/product --body-file - <<'EOF'\nUses $HOME and $(date).\nEOF"],
    ["gh pr comment 7 --repo example/product --body-file - <<EOF\nReady for review.\nEOF"],
    ["gh pr comment 7 --repo example/product --body-file note.md"],
    ["gh pr comment \"$PR\" --repo example/product --body 'Ready for review.'"],
    ["gh pr review 7 --repo example/product --approve --body 'Looks good.'"],
    ["gh pr edit 7 --repo example/product --body-file note.md --add-label \"$LABEL\""],
    ["gh api graphql -f query='query($owner: String!) { repository(owner: $owner, name: \"product\") { id } }' -f owner=\"$OWNER\""],
    ["gh api -X POST repos/example/product/git/refs -f ref=refs/heads/next -f sha=\"$(git rev-parse HEAD)\""],
    ["gh api repos/example/product/issues/7/comments -F body=@note.md"],
    ["gh pr edit 7 --repo example/product --title \"Notes for $USER\" --body '$USER'"],
    ["gh pr comment 7 --repo example/product --body \"Currency symbol: $\""],
    ["gh pr comment 7 --repo example/product --body Costs\\ 5$"],
    ["gh pr comment 7 --repo example/product -F - <<EOF\nCurrency symbol: $\nEOF"],
    ["gh pr comment 7 --repo example/product -F - <<< \"Currency symbol: $\""],
    ["gh api graphql -F query=@read.graphql -f owner=\"$OWNER\""],
    ["gh api graphql -f 'query=query($owner: String!) { repository(owner: $owner, name: \"mutation\") { id } }' -f owner=\"$OWNER\""],
    ["gh api -X PATCH repos/example/product/pulls/7 --input note.json -f body=\"$NOTE\""],
    ["gh api graphql -f 'query=query($q: String!) { search(query: $q, type: REPOSITORY, first: 1) { repositoryCount } } # mutation (x)' -f q=\"$Q\""],
    ["gh api graphql -f 'query=query($n: Int!) { search(query: \"mutation testing\", type: REPOSITORY, first: $n) { repositoryCount } }' -F n=\"$N\""],
    ["gh api graphql --input read.json -f owner=\"$OWNER\""],
    ["gh api graphql -F query=@- -f owner=\"$OWNER\" <<'EOF'\nquery($owner: String!) { repository(owner: $owner, name: \"product\") { id } }\nEOF"],
    ["gh api graphql -F query=@- -f owner=\"$OWNER\" <<< 'query { viewer { login } }'"],
    ["gh api graphql -f 'query=# mutation example\nquery { viewer { login } }' -f owner=\"$OWNER\""],
    ["gh api graphql -f 'query=query mutation($n: Int!) { repository(owner: \"example\", name: \"product\") { pullRequest(number: $n) { id } } }' -F n=\"$N\""],
    ["gh api graphql -f 'query=query($n: Int!) { search(query: \"} mutation\", type: REPOSITORY, first: $n) { repositoryCount } }' -F n=\"$N\""],
    ["gh pr edit 7 --repo example/product --body 'After CI, run `/trunk merge`.'"],
    ["gh pr edit 7 --repo example/product --body 'Ready for review.' <<EOF\n/trunk merge\nEOF"],
    ["bash -c \"gh pr comment 7 --repo example/product --body 'Ready for review.'\""],
    ["bash <<'EOF'\ngh pr comment 7 --repo example/product --body '$B'\nEOF"],
    ["echo \"gh pr comment 7 --repo example/product --body 'Ready for review.'\" | sh"],
    ["echo \"gh pr comment 7 --repo example/product --body 'Ready for review.'\" | sh -s \"$X\""],
    ["echo \"gh pr comment 7 --repo example/product --body 'Ready for review.'\" | tee \"$LOG\" | sh"],
    ["echo \"gh pr comment 7 --repo example/product --body 'Costs \\$5'\" | tee -a \"$LOG\" | sh"],
    ["bash -c \"gh api graphql -H 'X-Trace: $TRACE' -f query='{ viewer { login } }'\""],
    ["bash -c \"gh api -X GET repos/example/product/pulls/7/merge -H 'Accept: $ACCEPT'\""],
    ["timeout 380 bash -c \"until [ \\\"\\$(gh api repos/example/product/commits/$SHA/check-runs --jq .total_count)\\\" -gt 0 ]; do sleep 30; done\""],
    ["gh pr edit 7 --repo example/product --body \"$(cat body.md)\""],
    ["gh issue edit 7 --repo example/product --body-file \"$S/body.md\""],
    ["gh api graphql -f 'query=mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t=\"$T\""],
    ["gh api graphql -f 'query=mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }' -f id=\"$ID\""],
    ["gh api graphql -f 'query=mutation($id: ID!) { updatePullRequestBranch(input: {pullRequestId: $id}) { clientMutationId } }' -f id=\"$ID\""],
    ["gh api graphql -f 'query=mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { body: id } } } # addComment(input: {})' -f t=\"$T\""],
    ["gh api graphql -f 'query=query($n: Int!) { search(query: \"addComment(input: {})\", type: REPOSITORY, first: $n) { repositoryCount } }' -F n=\"$N\""],
    ["gh api repos/example/product/pulls/7/comments/1/replies -f body=\"$A\""],
    ["printf 'x' | gh api -X PATCH repos/example/product/pulls/7 --input note.json -F note=@-"],
    ["gh api graphql -f query='query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } } # {repo}' -f q=\"$Q\""],
    ["gh api graphql -F query=@repo-read.graphql -f q=\"$Q\""],
    ["gh api graphql -F query=@'{repo}.graphql' -f q=\"$Q\""],
    ["gh api https://api.github.com/repos/example/product/pulls/7/comments/1/replies -f body=\"$B\""],
    ["gh api graphql -f query='mutation($id: ID!, $b: String!) { addComment(input: {subjectId: $id, body: $b}) { clientMutationId } }' -f id=X -F b=@note.md"],
    ["gh api repos/example/product/pulls/7/merge --cache \"$TTL\""],
    ["gh api repos/example/product/pulls/7/merge -H \"Accept: $ACCEPT\""],
    ["gh api graphql -f 'query=mutation UpdateReviewThread($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t=\"$T\""],
    ["gh api graphql -f 'query=mutation addComment($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t=\"$T\""],
    ["gh api graphql -f 'query=query($n: Int!) { addComment: repository(owner: \"example\", name: \"product\") { pullRequest(number: $n) { id } } }' -F n=\"$N\""],
    ["gh api graphql -f 'query=mutation($t: ID!) { resolveReviewThread(input: {threadId: $t, clientMutationId: \"\"\"has \\\"\"\" addComment( inside\"\"\"}) { thread { isResolved } } }' -f t=\"$T\""],
    ["gh api graphql -f query=$'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t, clientMutationId: \"\"\"one\\naddComment( two\"\"\"}) { thread { isResolved } } }' -f t=\"$T\""],
    ["timeout 380 bash -c \"until gh api 'repos/example/product/commits/$SHA/check-runs' --jq '.total_count'; do sleep 30; done\""],
    ["gh api -X PATCH repos/example/product/pulls/comments/1 -f body=\"Fixed in $SHA.\""],
    ["echo '{\"pull_requests\":[7,8]}' | gh api -X POST repos/example/product/stacks --input -"],
    ["make-body | gh api -X PATCH repos/example/product/pulls/7 --input -"],
    ["cat release.json | gh api repos/example/product/releases --input -"],
    ["jq -n '{ref:\"main\"}' | gh api -X POST repos/example/product/actions/workflows/ci.yml/dispatches --input -"],
  ])("a literal body, literal path or literal heredoc posts without a check: %s", (command) => {
    expect(bash(command)).toEqual({ targets: [] });
  });

  test("a cd before the call moves it to that checkout's repository, out of an exempt one", () => {
    expect(bash("cd /work/product && gh pr merge 7 --squash", "/tooling")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("cd /tooling && gh pr merge 7 --squash", "/work")).toEqual({ targets: [], exempt: [target("own/tooling", 7)] });
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

  test("T3 Code's PR tools: a merge, an auto-merge, a stack merge and a PR comment that posts /trunk merge target the PR, on either server name", () => {
    const merge = { repository: "example/product", number: 7, expectedHeadSha: head };
    expect(mcp("mcp__t3-code__pull_request_merge", merge)).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__t3_code__pull_request_merge", merge)).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__t3-code__pull_request_merge", { ...merge, auto: true, method: "squash" })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__t3-code__pull_request_merge", { ...merge, stack: true, environmentId: "box-2" })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__t3-code__pull_request_merge", { ...merge, repository: "own/tooling" })).toEqual({ targets: [], exempt: [target("own/tooling", 7)] });
    expect(mcp("mcp__t3-code__pull_request_respond", { repository: "example/product", number: 7, body: "Ready.\n/trunk merge" })).toEqual({ targets: [target("example/product", 7)] });
  });

  test("a T3 merge or /trunk merge comment that leaves T3 to pick the PR is refused, since the gate cannot check it", () => {
    for (const input of [
      { expectedHeadSha: head },
      { number: 7, expectedHeadSha: head },
      { repository: "example/product", expectedHeadSha: head },
      { repository: "https://github.com/example/product", number: 7, expectedHeadSha: head },
      { repository: "example/product", number: "7", expectedHeadSha: head },
      { repository: "example/product", number: 0, expectedHeadSha: head },
      { owner: "example", repo: "product", pullNumber: 7, expectedHeadSha: head },
    ]) expect(mcp("mcp__t3-code__pull_request_merge", input).refusal).toContain("merges a PR without naming the PR");
    expect(mcp("mcp__t3-code__pull_request_respond", { body: "/trunk merge" }).refusal).toContain("posts `/trunk merge` without naming the PR");
  });

  test.each([["\r/trunk merge"], ["\v/trunk merge"], ["\uFEFF/trunk merge"], ["\u00A0\u2028/trunk merge"]])("a T3 body that T3 trims to /trunk merge counts as one: %j", (body) => {
    const pr = { repository: "example/product", number: 7 };
    expect(mcp("mcp__t3-code__pull_request_respond", { ...pr, body })).toEqual({ targets: [target("example/product", 7)] });
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", comments: [{ path: "a.ts", line: 1, body }] }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__t3-code__pull_request_respond", { ...pr, reviewThreadId: "thread-1", body }).refusal).toBe(otherEndpointReason);
  });

  test("a T3 call is read only in the fields T3 posts, each as T3 posts it", () => {
    const pr = { repository: "example/product", number: 7 };
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", body: "\r/trunk merge" })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", body: "Looks good.", comments: [{ path: "a.ts", line: 1, body: "Nit.", note: "/trunk merge" }] })).toEqual({ targets: [] });
  });

  test("a T3 reply with a null reviewThreadId, which T3 posts as a PR comment, is gated as one", () => {
    expect(mcp("mcp__t3-code__pull_request_respond", { repository: "example/product", number: 7, reviewThreadId: null, body: "/trunk merge" })).toEqual({ targets: [target("example/product", 7)] });
  });

  test("input nested too deep for a recursive walk is still read, so the hook cannot crash and let the call through", () => {
    const deep = (inside: unknown) => JSON.parse(`${"[".repeat(200_000)}${JSON.stringify(inside)}${"]".repeat(200_000)}`);
    const pr = { repository: "example/product", number: 7 };
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", body: "Looks good.", comments: [{ path: "a.ts", line: 1, body: "/trunk merge", note: deep(null) }] }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", body: "Looks good.", comments: [{ path: "a.ts", line: 1, body: "Nit.", note: deep(null) }] })).toEqual({ targets: [] });
    expect(mcp("mcp__github__add_issue_comment", { owner: "example", repo: "product", issue_number: 7, body: "/trunk merge", junk: deep(null) })).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("gh api repos/example/product/issues/7/comments --input deep.json")).toEqual({ targets: [target("example/product", 7)] });
    expect(bash("cat deep.json | gh api repos/example/product/issues/7/comments --input -")).toMatchObject({ targets: [target("example/product", 7)] });
  });

  test("a T3 review or review-thread reply that posts /trunk merge is refused, and T3 reads, edits, issue comments and other comments enqueue nothing", () => {
    const pr = { repository: "example/product", number: 7 };
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "comment", body: "/trunk merge" }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "approve", expectedHeadSha: head, comments: [{ path: "a.ts", line: 1, body: "/trunk merge" }] }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__t3-code__pull_request_respond", { ...pr, reviewThreadId: "thread-1", body: "/trunk merge" }).refusal).toBe(otherEndpointReason);
    expect(mcp("mcp__t3-code__pull_request_respond", { ...pr, body: "Thanks, fixed." })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_respond", { ...pr, reviewThreadId: "thread-1", resolved: true })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_review", { ...pr, verdict: "approve", expectedHeadSha: head })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_update", { ...pr, body: "Steps:\n/trunk merge once green", ready: true })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_read", { ...pr })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_list", { repository: "example/product" })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__pull_request_create", { title: "Merge queue", body: "/trunk merge once green" })).toEqual({ targets: [] });
    expect(mcp("mcp__t3-code__t3_thread_send", { threadId: "t", message: "/trunk merge" })).toEqual({ targets: [] });
    for (const target of [{ url: "https://github.com/example/product/pull/7" }, { url: "https://github.com/example/product/issues/7" }, { key: "ENG-7" }]) {
      expect(mcp("mcp__t3-code__comment_on_issue", { ...target, body: "/trunk merge" })).toEqual({ targets: [] });
    }
    expect(mcp("mcp__other__pull_request_merge", { ...pr, expectedHeadSha: head })).toEqual({ targets: [] });
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

  test("a pass from while autonomy was end counts only while it is still end, wherever it was recorded", async () => {
    const onEnd: LedgerEvent = { ...gatePass(9, head), onEnd: true } as LedgerEvent;
    const localOnEnd = (decidesAll: boolean): GateIO => ({ ...gate(), localGate: async () => ({ passed: true, at: localAt, onEnd: true }), decidesAll: () => decidesAll });
    expect(await risk(one(9), { ...gate({ ledger: [onEnd] }), decidesAll: () => true })).toBeUndefined();
    expect(await risk(one(9), localOnEnd(true))).toBeUndefined();
    for (const io of [{ ...gate({ ledger: [onEnd] }), decidesAll: () => false }, gate({ ledger: [onEnd] }), localOnEnd(false)]) {
      expect(await risk(one(9), io)).toContain("nor a pass from while pull-requests.autonomy was end once it is ask again");
    }
    expect(await risk(one(9), { ...gate({ ledger: [onEnd, gatePass(9, head, true, "2026-11-16T09:00:00Z")] }), decidesAll: () => false })).toBeUndefined();
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

  test("an unreadable ledger refuses a merge: without a local pass it names the missing gate, and with one it cannot tell whether a gap an agent accepted holds the head", async () => {
    expect(await risk(one(9), gate({ hubDown: true }))).toContain("has not passed at the head of example/product#9");
    expect(await risk(one(9), gate({ hubDown: true, local: [`9@${head}`] }))).toContain("the decision ledger could not be read, so the merge gate cannot tell whether an agent accepted a proof gap in example/product itself");
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

describe("a standing order of the person's", () => {
  const conductor = "thread:project:map:conductor-1";
  const words = "Go full autonomous mode again here until we reach the next goal milestone.";
  const gap: LedgerEvent = {
    type: "decide", decision: {
      id: "d-agent", at: "2026-11-27T08:00:00Z", class: "proof-gap", mark: "🤖", question: "Accept the live-run gap? example/product#9: only a run from main proves it", answer: "Accept the gap", rejected: "Keep the gap open", reason: "x",
      scope: { prs: ["example/product#9"], kinds: ["live-run"] }, effect: "accept", where: { thread: "lane", machine: "hub" },
    },
  };
  const order = (condition?: string, thread = conductor): LedgerEvent => ({
    type: "decide", decision: {
      id: "d-order", at: "2026-11-27T07:00:00Z", class: "merge", mark: "👤", question: `Standing order (standing-order) for example/maps#7 until ${/^until (\S+)$/.exec(condition ?? "")?.[1] ?? "its milestone"}: may this T3 thread merge every PR it merges on your word, gaps an agent accepted included?`, answer: '2026-11-27 "Merge on your own"',
      scope: { prs: ["example/maps#7"], kinds: ["standing-order"], ...condition ? { condition } : {} }, where: { thread, message: "m-order", machine: "hub" },
    },
  });
  const pass = gatePass(9, head);
  const github: Pick<GateIO, "pull" | "pullFor"> = { pull: async () => pulls[9], pullFor: async () => undefined };
  const mergeFrom = async (thread: string | undefined, ledger: LedgerEvent[], clock: { now?: () => number; github?: typeof github; command?: string } = {}) => {
    const home = homeIn({ "guards.person": "Robin" });
    writeFileSync(join(home, ".local/state/hedge/decisions.jsonl"), ledger.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const env = thread === undefined ? {} : { T3CODE_THREAD_ID: thread };
    const command = clock.command ?? "gh pr merge 9 --repo example/product";
    return (await mergeGate({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, { home, env, github: clock.github ?? github, now: clock.now, intent: io }))?.hookSpecificOutput.permissionDecisionReason;
  };

  test("covers a PR whose gaps an agent accepted, when the conductor merges it from the thread the person chose it in", async () => {
    expect(await mergeFrom(conductor, [gap, pass, order()])).toBeUndefined();
    expect(await mergeFrom("conductor-1", [gap, pass, order("until 2099-12-31")])).toBeUndefined();
  });

  test("without one, the PR stays held for the merge card", async () => {
    const refusal = await mergeFrom(conductor, [gap, pass]);
    expect(refusal).toContain("an agent accepted proof gaps of example/product#9");
    expect(refusal).toContain("or under a standing order they chose on a question card in this T3 thread");
    expect(refusal).not.toContain("The standing order d-order");
  });

  test("a merge from another thread, another map's conductor or a lane, or from outside T3, stays held, says whose thread it covers, and never copies the person's words", async () => {
    for (const thread of ["thread:project:map:conductor-2", "lane", undefined]) {
      const refusal = await mergeFrom(thread, [gap, pass, order()]);
      expect(refusal).toContain("an agent accepted proof gaps of example/product#9");
      expect(refusal).toContain(`The standing order d-order of 2026-11-27 covers only merges from T3 thread ${conductor}`);
      expect(refusal).not.toContain(words);
    }
    expect(await mergeFrom(undefined, [gap, pass, order()])).toContain("this merge runs outside a T3 thread");
    const lapsedElsewhere = await mergeFrom("lane", [gap, pass, order("until 2020-01-01")]);
    expect(lapsedElsewhere).toContain("an agent accepted proof gaps");
    expect(lapsedElsewhere).not.toContain("The standing order d-order");
  });

  test("an order that ended stays held and says when: past its date, at the milestone, or withdrawn", async () => {
    expect(await mergeFrom(conductor, [gap, pass, order("until 2020-01-01")])).toContain("The standing order d-order of 2026-11-27 ran until 2020-01-01 and has ended.");
    expect(await mergeFrom(conductor, [gap, pass, order("until 2099-02-30")])).toContain("names no end date Hedge can read (until 2099-02-30)");
    expect(await mergeFrom(conductor, [gap, pass, order("whenever")])).toContain("names no end date Hedge can read (whenever)");
    const milestone: LedgerEvent = { type: "void", id: "d-order", reason: "milestone reached", at: "2026-11-28T09:00:00Z" };
    expect(await mergeFrom(conductor, [gap, pass, order(), milestone])).toContain("ended on 2026-11-28: milestone reached.");
    const withdrawn: LedgerEvent = { type: "reverse", id: "d-order", words: '2026-11-28 "Stop merging on your own."', thread: conductor, message: "m-stop", machine: "hub", at: "2026-11-28T10:00:00Z" };
    expect(await mergeFrom(conductor, [gap, pass, order(), withdrawn])).toContain("was withdrawn on 2026-11-28.");
  });

  test("an agent's own order counts for nothing, and an order never stands in for a missing gate pass", async () => {
    const agents = order();
    if (agents.type === "decide") agents.decision.mark = "🤖";
    expect(await mergeFrom(conductor, [gap, pass, agents])).toContain("an agent accepted proof gaps");
    const refusal = await mergeFrom(conductor, [gap, order()]);
    expect(refusal).toContain("has not passed at the head of example/product#9");
    expect(refusal).toContain("Robin's standing order d-order of 2026-11-27");
    expect(refusal).toContain("never for a missing gate pass");
  });

  test("an order runs through the last day it names, in UTC, and the clock is read once every PR of the call is read", async () => {
    const at = (time: string) => Date.parse(time);
    const ledger = [gap, pass, order("until 2026-12-10")];
    expect(await mergeFrom(conductor, ledger, { now: () => at("2026-12-10T23:59:59Z") })).toBeUndefined();
    expect(await mergeFrom(conductor, ledger, { now: () => at("2026-12-11T00:00:00Z") })).toContain("ran until 2026-12-10 and has ended.");
    let time = at("2026-12-10T23:59:59Z");
    const lateGithub = { pull: async (_repository: string, pr: number) => { if (pr === 6) time = at("2026-12-11T00:00:01Z"); return pulls[pr]; }, pullFor: async (_repository: string, branch: string) => branch === "layer-1" ? 6 : undefined };
    const both = "gh pr merge 9 --repo example/product && gh pr merge 7 --repo example/product";
    const stacked = [...ledger, gatePass(7, head), gatePass(6, lower)];
    expect(await mergeFrom(conductor, stacked, { now: () => time, github: lateGithub, command: both })).toContain("an agent accepted proof gaps of example/product#9");
  });

  test("a ledger entry counts as an order only with the person's choice on the exact standing-order question", async () => {
    const reworded = (change: (decision: Decision) => void) => { const one = order(); if (one.type === "decide") change(one.decision); return one; };
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.answer = '2026-11-27 "Keep asking me"'; })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = `${decision.question} Only the docs PR.`; })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.scope.prs = ["example/maps#7", "example/maps#8"]; })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.answer = '2026-11-27 "Merge on your own (Recommended)"'; })])).toBeUndefined();
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[example/maps#7](https://github.com/example/maps/issues/7)"); })])).toBeUndefined();
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[example/maps#8](https://github.com/example/maps/issues/7)"); })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[example/maps#7](https://github.com/example/maps/issues/8)"); })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.answer = '2026-11-27 "2026-11-27 Merge on your own"'; })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[example/ma_ps#7](https://github.com/example/maps/issues/7)"); })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[example/maps#7](https://github.com/example/ma_ps/issues/7)"); })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "example/ma_ps#7"); })])).toContain("an agent accepted proof gaps");
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace("example/maps#7", "[Example/Maps#7](https://github.com/example/maps/issues/7)"); })])).toBeUndefined();
    expect(await mergeFrom(conductor, [gap, pass, reworded((decision) => { decision.question = decision.question.replace(": may", `:${" ".repeat(600)} may`); })])).toContain("an agent accepted proof gaps");
  });

  test("an order voided while the call reads a later PR holds the merge", async () => {
    const home = homeIn({ "guards.person": "Robin" });
    const ledger = join(home, ".local/state/hedge/decisions.jsonl");
    writeFileSync(ledger, [gap, pass, gatePass(7, head), gatePass(6, lower), order()].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const milestone = JSON.stringify({ type: "void", id: "d-order", reason: "milestone reached", at: "2026-11-28T09:00:00Z" });
    const voidMidCall = { pull: async (_repository: string, pr: number) => { if (pr === 7) appendFileSync(ledger, `${milestone}\n`); return pulls[pr]; }, pullFor: async (_repository: string, branch: string) => branch === "layer-1" ? 6 : undefined };
    const command = "gh pr merge 9 --repo example/product && gh pr merge 7 --repo example/product";
    const refusal = await mergeGate({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, { home, env: { T3CODE_THREAD_ID: conductor }, github: voidMidCall, intent: io });
    expect(refusal?.hookSpecificOutput.permissionDecisionReason).toContain("ended on 2026-11-28: milestone reached.");
  });

  test("another live order of the same thread still covers the merge when the first ends while the call reads a later PR", async () => {
    const home = homeIn({ "guards.person": "Robin" });
    const ledger = join(home, ".local/state/hedge/decisions.jsonl");
    const second = order();
    if (second.type === "decide") Object.assign(second.decision, { id: "d-order-2", where: { ...second.decision.where, message: "m-order-2" } });
    writeFileSync(ledger, [gap, pass, gatePass(7, head), gatePass(6, lower), order(), second].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const milestone = JSON.stringify({ type: "void", id: "d-order", reason: "milestone reached", at: "2026-11-28T09:00:00Z" });
    const voidMidCall = { pull: async (_repository: string, pr: number) => { if (pr === 7) appendFileSync(ledger, `${milestone}\n`); return pulls[pr]; }, pullFor: async (_repository: string, branch: string) => branch === "layer-1" ? 6 : undefined };
    const command = "gh pr merge 9 --repo example/product && gh pr merge 7 --repo example/product";
    expect(await mergeGate({ tool_name: "Bash", tool_input: { command }, cwd: "/" }, { home, env: { T3CODE_THREAD_ID: conductor }, github: voidMidCall, intent: io })).toBeUndefined();
  });
});

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

  test("in an exempt repository, a gap an agent accepted holds the merge until a gate pass at the head shows it gone, and a gap elsewhere reads nothing", async () => {
    const agentGap = (repository: string): LedgerEvent => ({
      type: "decide", decision: {
        id: "d-agent", at: "2026-11-16T08:00:00Z", class: "proof-gap", mark: "🤖", question: `Accept the live-run gap? ${repository}#9: no sandbox`, answer: "Accept the gap", rejected: "Keep the gap open", reason: "x",
        scope: { prs: [`${repository}#9`], kinds: ["live-run"] }, effect: "accept", where: { thread: "t", machine: "hub" },
      },
    });
    const where = (ledger: LedgerEvent[], github = true) => ({ home: homeWith({ "guards.merge-gate-exempt": "own/*" }), env: {}, gate: gate({ ledger, github }), intent: io });
    const merge = (ledger: LedgerEvent[], github = true) => mergeGate(call("gh pr merge 9 --repo own/tooling"), where(ledger, github));
    const pass = (seenGaps?: string[], agentGaps: string[] | undefined = seenGaps && []): LedgerEvent => ({ type: "gate", repository: "own/tooling", pr: 9, commit: head, passed: true, machine: "box-2", at: "2026-11-16T07:30:00Z", ...agentGaps ? { agentGaps } : {}, ...seenGaps ? { seenGaps } : {} });
    expect((await merge([agentGap("own/tooling")]))?.hookSpecificOutput.permissionDecisionReason).toContain(`an agent accepted proof gaps of own/tooling#9 at ${head.slice(0, 12)} (🤖 d-agent for live-run) itself`);
    expect(await merge([agentGap("own/tooling"), pass(["d-agent"])])).toBeUndefined();
    expect(await merge([agentGap("own/tooling"), pass([])])).toBeDefined();
    expect(await merge([agentGap("own/tooling"), pass()])).toBeDefined();
    expect(await merge([agentGap("own/tooling"), pass(["d-agent"], ["d-agent"])])).toBeDefined();
    expect(await merge([agentGap("example/product")], false)).toBeUndefined();
    const word = (answer: string, gaps = "d-agent for live-run"): LedgerEvent => ({
      type: "decide", decision: {
        id: `w-${answer}-${gaps}`, at: "2026-11-16T09:00:00Z", class: "merge", mark: "👤", question: `Merge own/tooling#9 at ${head}? An agent accepted ${gaps}.`, answer: `2026-11-16 "${answer}"`,
        scope: { prs: ["own/tooling#9"], condition: `${head}: merge card` }, where: { thread: "t", message: `m-${answer}`, machine: "hub" },
      },
    });
    expect(await merge([agentGap("own/tooling"), word("Merge")])).toBeUndefined();
    expect(await merge([agentGap("own/tooling"), word('"Merge"')])).toBeUndefined();
    expect(await merge([agentGap("own/tooling"), word("Keep it open")])).toBeDefined();
    expect(await merge([agentGap("own/tooling"), word("Merge", "d-other for live-run")])).toBeDefined();
    expect(await merge([agentGap("own/tooling"), word("Merge", "d-agent")])).toBeDefined();
    const mistyped = word("Merge");
    if (mistyped.type === "decide") mistyped.decision.question = `Merge own/tooling#9 at ${head}0? An agent accepted d-agent for live-run.`;
    expect(await merge([agentGap("own/tooling"), mistyped])).toBeDefined();
    expect(await merge([agentGap("own/tooling"), word("Merge", "d-agent2 for live-run")])).toBeDefined();
  });

  test("the person's gate override for the head lifts the hold on a gap an agent accepted, though its card names no gap", async () => {
    const gap: LedgerEvent = { type: "decide", decision: { id: "d-agent", at: "2026-11-16T08:00:00Z", class: "proof-gap", mark: "🤖", question: "Accept the live-run gap? own/tooling#9: no sandbox", answer: "Accept the gap", rejected: "Keep the gap open", reason: "x", scope: { prs: ["own/tooling#9"], kinds: ["live-run"] }, effect: "accept", where: { thread: "t", machine: "hub" } } };
    const incident: LedgerEvent = { type: "decide", decision: { id: "o-incident", at: "2026-11-16T09:00:00Z", class: "merge", mark: "👤", question: `Override the gate for own/tooling#9 at ${head}?`, answer: '2026-11-16 "Override the gate"', scope: { prs: ["own/tooling#9"], kinds: ["gate-override"], condition: `${head}: incident fix, the judge is down` }, where: { thread: "t", message: "m-o", machine: "hub" } } };
    const merge = (ledger: LedgerEvent[]) => mergeGate(call("gh pr merge 9 --repo own/tooling"), { home: homeWith({ "guards.merge-gate-exempt": "own/*" }), env: {}, gate: gate({ ledger }), intent: io });
    expect(await merge([gap])).toBeDefined();
    expect(await merge([gap, incident])).toBeUndefined();
  });

  test("in an exempt repository, a ledger the hook cannot read refuses the merge, since a gap an agent accepted may hold it", async () => {
    const where = { home: homeWith({ "guards.merge-gate-exempt": "own/*" }), env: {}, gate: gate({ hubDown: true }), intent: io };
    expect((await mergeGate(call("gh pr merge 9 --repo own/tooling"), where))?.hookSpecificOutput.permissionDecisionReason).toContain("the decision ledger could not be read, so the merge gate cannot tell");
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
    const tool = async (tool_name: string, tool_input: Record<string, unknown>) => (await mergeGate({ tool_name, tool_input, cwd: "/" }, where))?.hookSpecificOutput.permissionDecisionReason;
    return Object.assign(hook, { home, bin, tool });
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

  test("T3's merge tool gets the refusal gh pr merge gets, and passes where it passes", async () => {
    const github = { "repos/example/product/pulls/9": pull(head) };
    const t3Merge = { repository: "example/product", number: 9, expectedHeadSha: head, method: "squash" };
    const unpassed = machine(github);
    const refusal = await unpassed("gh pr merge 9 --repo example/product --squash");
    expect(refusal).toContain("has not passed at the head of example/product#9");
    expect(await unpassed.tool("mcp__t3-code__pull_request_merge", t3Merge)).toBe(refusal!);
    expect(await unpassed.tool("mcp__t3-code__pull_request_merge", { ...t3Merge, auto: true })).toBe(refusal!);
    expect(await unpassed.tool("mcp__t3-code__pull_request_respond", { repository: "example/product", number: 9, body: "/trunk merge" })).toBe(refusal!);
    const passed = machine(github, [pass("example/product", 9, head)]);
    expect(await passed("gh pr merge 9 --repo example/product --squash")).toBeUndefined();
    expect(await passed.tool("mcp__t3-code__pull_request_merge", t3Merge)).toBeUndefined();
    expect(await passed.tool("mcp__t3-code__pull_request_merge", { ...t3Merge, number: 5 })).toContain("cannot read example/product#5");
  });

  test("T3's merge tool is held on a gap an agent accepted, as gh pr merge is, until the person's merge card names it", async () => {
    const github = { "repos/example/product/pulls/9": pull(head) };
    const gap: LedgerEvent = { type: "decide", decision: { id: "d-agent", at: "2026-11-16T08:00:00Z", class: "proof-gap", mark: "🤖", question: "Accept the live-run gap? example/product#9: no sandbox", answer: "Accept the gap", rejected: "Keep the gap open", reason: "x", scope: { prs: ["example/product#9"], kinds: ["live-run"] }, effect: "accept", where: { thread: "t", machine: "hub" } } };
    const card: LedgerEvent = { type: "decide", decision: { id: "w-merge", at: "2026-11-16T09:00:00Z", class: "merge", mark: "👤", question: `Merge example/product#9 at ${head}? An agent accepted d-agent for live-run.`, answer: '2026-11-16 "Merge"', scope: { prs: ["example/product#9"], condition: `${head}: merge card` }, where: { thread: "t", message: "m-w", machine: "hub" } } };
    const t3Merge = { repository: "example/product", number: 9, expectedHeadSha: head };
    const held = machine(github, [pass("example/product", 9, head), gap]);
    const refusal = await held("gh pr merge 9 --repo example/product");
    expect(refusal).toContain("an agent accepted proof gaps of example/product#9");
    expect(await held.tool("mcp__t3-code__pull_request_merge", t3Merge)).toBe(refusal!);
    expect(await machine(github, [pass("example/product", 9, head), gap, card]).tool("mcp__t3-code__pull_request_merge", t3Merge)).toBeUndefined();
  });

  test("T3's stack merge needs a gate pass at every open layer below the PR", async () => {
    const github = { "repos/example/product/pulls/7": pull(head, "layer-1"), "repos/example/product/pulls/6": pull(lower), [openHead("layer-1")]: [{ number: 6 }] };
    const t3Merge = { repository: "example/product", number: 7, expectedHeadSha: head, stack: true };
    expect(await machine(github, [pass("example/product", 7, head)]).tool("mcp__t3-code__pull_request_merge", t3Merge)).toContain("example/product#6 (a lower layer of example/product#7)");
    expect(await machine(github, [pass("example/product", 7, head), pass("example/product", 6, lower)]).tool("mcp__t3-code__pull_request_merge", t3Merge)).toBeUndefined();
  });

  test("the installed hook script gates T3's merge tool", async () => {
    const hook = machine({ "repos/example/product/pulls/9": pull(head) });
    const answer = async (tool_input: Record<string, unknown>) => {
      const { HEDGE_SETTINGS: _settings, GH_REPO: _repo, ...env } = process.env;
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "hooks/merge-gate.ts"), "claude"], {
        env: { ...env, HOME: hook.home, PATH: `${hook.bin}:${process.env.PATH}` }, cwd: "/", timeout: 4_000,
        stdin: new Blob([JSON.stringify({ tool_name: "mcp__t3-code__pull_request_merge", tool_input, cwd: "/" })]), stdout: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output).hookSpecificOutput.permissionDecisionReason;
    };
    expect(await answer({ repository: "example/product", number: 9, expectedHeadSha: head })).toContain("has not passed at the head of example/product#9");
    expect(await answer({ expectedHeadSha: head })).toContain("merges a PR without naming the PR");
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
    ["gh api -X PATCH repos/example/product/pulls/9 -f body=\"$(cat body.md)\""],
    ["gh pr review 9 --repo example/product --comment --body-file missing.md"],
  ])("a body edit whose payload the gate cannot read, such as a file the same command writes first, is refused and told to write it first: %s", async (command) => {
    const { dir, hook } = bodyEdits();
    const reason = await hook(command, dir);
    expect(reason).toContain("the merge gate cannot read what it sends");
    expect(reason).toContain("write a file in one call, then send it with a call of its own.");
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

  const report = [
    "## End-of-run report: example/product#9, example/product#10", "", "### Still yours",
    "- Merge example/product#9: its proofs pass, and it waits on your merge word.",
    "- Merge example/product#10: its proofs pass, and it waits on your merge word.", "",
  ].join("\n");
  const heldGap: LedgerEvent = {
    type: "decide", decision: {
      id: "d-agent", at: "2026-11-16T08:00:00Z", class: "proof-gap", mark: "🤖", question: "Accept the live-run gap? example/product#9: no sandbox", answer: "Accept the gap", rejected: "Keep the gap open", reason: "x",
      scope: { prs: ["example/product#9"], kinds: ["live-run"] }, effect: "accept", where: { thread: "t", machine: "hub" },
    },
  };
  const reportDir = () => {
    const dir = temp.make("report-");
    writeFileSync(join(dir, "report.md"), report);
    writeFileSync(join(dir, "enqueue.md"), `${report}\n/trunk merge\n`);
    return dir;
  };
  const opensWithNote = "The merge gate could not read the body of this comment";

  test("a report that names a pending merge posts by its literal path, on a PR with a held gap", async () => {
    const hook = machine({}, [heldGap]);
    expect(await hook("gh pr comment 9 --repo example/product --body-file report.md", reportDir())).toBeUndefined();
    expect(await hook("gh api repos/example/product/issues/9/comments -F body=@report.md", reportDir())).toBeUndefined();
  });

  test("a comment whose body the gate cannot read is checked as an enqueue, and the refusal says so first and how to send it", async () => {
    const dir = reportDir();
    const held = machine({ "repos/example/product/pulls/9": pull(head) }, [heldGap, pass("example/product", 9, head)]);
    const lane = await held(`R=${dir}/report.md; gh pr comment 9 --repo example/product --body-file $R > post.log 2>&1; echo post=$?`, dir);
    expect(lane).toStartWith(opensWithNote);
    expect(lane).toContain("give the body by its literal file path");
    expect(lane).toContain("an agent accepted proof gaps of example/product#9");
    const unpassed = machine({ "repos/example/product/pulls/9": pull(head) });
    for (const command of ["gh pr comment 9 --repo example/product --body-file missing.md", "cat report.md | gh pr comment 9 --repo example/product -F -", "cat report.md | gh api repos/example/product/issues/9/comments -F body=@-", "gh api repos/example/product/issues/9/comments --input missing.json", "cat report.md | gh api repos/example/product/issues/9/comments --input - -f body='/trunk merge'"]) {
      const reason = await unpassed(command, dir);
      expect(reason).toStartWith(opensWithNote);
      expect(reason).toContain("has not passed at the head of example/product#9");
    }
    const unnamed = await unpassed("gh pr comment 9 --body-file \"$R\"", dir);
    expect(unnamed).toStartWith(opensWithNote);
    expect(unnamed).toContain("posts a comment");
  });

  test("a refusal caused by a readable enqueue, a merge, or a mixed call does not blame an unread body", async () => {
    const dir = reportDir();
    const unpassed = machine({ "repos/example/product/pulls/9": pull(head), "repos/example/product/pulls/10": pull(head) }, [pass("example/product", 10, head)]);
    expect(await unpassed("gh pr comment 9 --repo example/product --body-file enqueue.md", dir)).toStartWith("Hedge blocked this merge");
    expect(await unpassed("gh pr merge 9 --repo example/product", dir)).toStartWith("Hedge blocked this merge");
    expect(await unpassed("gh pr merge 9 --repo example/product; gh pr comment 10 --repo example/product --body-file \"$R\"", dir)).toStartWith("Hedge blocked this merge");
    expect(await unpassed("gh pr comment 9 --repo example/product --body-file \"$R\"; trunk merge 9", dir)).toStartWith("Hedge blocked this command: an agent enters the Trunk merge queue only with");
    const unnamedWithMerge = await unpassed("gh pr comment 9 --body-file \"$R\"; gh pr merge 10 --repo example/product", dir);
    expect(unnamedWithMerge).toStartWith("Hedge blocked this command: it posts a comment without naming the PR");
  });

  test("a refusal of an unread body says so first when the gate cannot read its settings", async () => {
    const home = homeIn("{ not json");
    const unnamed = (await mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr comment 9 --body-file \"$R\"" }, cwd: "/" }, { home, env: {}, intent: realIntentIO }))?.hookSpecificOutput.permissionDecisionReason;
    expect(unnamed).toStartWith(opensWithNote);
    const reason = (await mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr comment 9 --repo example/product --body-file \"$R\"" }, cwd: "/" }, { home, env: {}, intent: realIntentIO }))?.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toStartWith(opensWithNote);
    expect(reason).toContain("could not read its settings");
  });

  const runTimeDir = () => {
    const dir = reportDir();
    writeFileSync(join(dir, "merge.graphql"), "mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }\n");
    return dir;
  };
  const unpassedNine = () => machine({ "repos/example/product/pulls/9": pull(head) });

  test.each([
    ["B=$(cat enqueue.md); gh pr comment 9 --repo example/product --body \"$B\""],
    ["gh issue comment 9 --repo example/product --body \"$(cat enqueue.md)\""],
    ["gh pr comment 9 --repo example/product --body \"`cat enqueue.md`\""],
    ["gh pr comment 9 --repo example/product --body-file - <<EOF\n$(cat enqueue.md)\nEOF"],
    ["X=$(cat enqueue.md); gh api repos/example/product/issues/9/comments -f body=\"$X\""],
    ["bash -c \"gh pr comment 9 --repo example/product --body '$(cat enqueue.md)'\""],
  ])("a comment body built at run time from a real file is checked as an enqueue, with the unread note first: %s", async (command) => {
    const reason = await unpassedNine()(command, runTimeDir());
    expect(reason).toStartWith(opensWithNote);
    expect(reason).toContain("has not passed at the head of example/product#9");
  });

  test.each([
    ["B=$(cat enqueue.md); gh pr review 9 --repo example/product --comment --body \"$B\"", unreadPayloadReason],
    ["X=$(cat enqueue.md); gh api -X PATCH repos/example/product/issues/comments/1 -f body=\"$X\"", unreadPayloadReason],
    ["cat enqueue.md | gh pr review 9 --repo example/product --comment -F -", unreadPayloadReason],
    ["Q=$(cat merge.graphql); gh api graphql -f query=\"$Q\"", graphqlReason],
    ["gh api graphql -f query=\"query{repository(owner:\\\"example\\\",name:\\\"product\\\"){pullRequest(number:$n){id}}}\"", graphqlReason],
  ])("a review, comment edit or GraphQL call built at run time from a real file is refused: %s", async (command, reason) => {
    expect(await unpassedNine()(command, runTimeDir())).toBe(reason);
  });

  test.each([
    ["gh pr comment 9 --repo example/product --body-file report.md"],
    ["gh pr comment 9 --repo example/product --body 'Costs $5 and runs `hedge proof gate`.'"],
    ["gh pr comment 9 --repo example/product --body-file - <<'EOF'\nRun $(hedge proof gate) when $HOME is set.\nEOF"],
    ["gh pr review 9 --repo example/product --comment --body-file report.md"],
    ["gh pr edit 9 --repo example/product --body-file report.md"],
    ["gh pr edit 9 --repo example/product --body \"$(cat enqueue.md)\""],
    ["gh api graphql -f query='mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t=\"$T\""],
    ["gh api graphql -f query='query($n: Int!) { repository(owner: \"example\", name: \"product\") { pullRequest(number: $n) { id } } }' -F n=\"$N\""],
    ["A=$(cat enqueue.md); gh api repos/example/product/pulls/9/comments/1/replies -f body=\"$A\""],
  ])("a literal body, path, heredoc or GraphQL read posts through the hook: %s", async (command) => {
    expect(await unpassedNine()(command, runTimeDir())).toBeUndefined();
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
