import { afterEach, expect, test } from "bun:test";
import { checkout, clean, cleanFixtures, fakeModel, graded, reviewHead, type ReviewThread } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function reviewed() {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  return pr;
}

const finding = (by: string, url: string, path = "feature.txt") => ({ path, line: 1, comments: [{ by, url }] });
const lastLine = (output: string) => output.split("\n").at(-1);

test("an unanswered bot finding fails the gate, which names each open thread by its URL", async () => {
  const pr = await reviewed();
  pr.reviewThreads([
    finding("posthog-security-review-bot", "https://github.com/example/product/pull/42#discussion_r1", "api/views.py"),
    finding("posthog", "https://github.com/example/product/pull/42#discussion_r2"),
  ]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("bot threads: 2 bot findings wait for an answer: https://github.com/example/product/pull/42#discussion_r1 (api/views.py:1), https://github.com/example/product/pull/42#discussion_r2 (feature.txt:1). ");
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 2 bot findings wait for an answer: https://github.com/example/product/pull/42#discussion_r1 (api/views.py:1), https://github.com/example/product/pull/42#discussion_r2 (feature.txt:1). ");
});

const passes = async (threads: ReviewThread[]) => {
  const pr = await reviewed();
  pr.reviewThreads(threads);
  const gate = await pr.hedge("gate");
  expect(gate.output).not.toContain("bot threads:");
  expect(gate.code).toBe(0);
};

test("a bot finding the author replied to no longer holds the gate", () => passes([
  { path: "feature.txt", line: 1, comments: [{ by: "posthog", url: "https://github.com/example/product/pull/42#discussion_r1" }, { by: "the-user", url: "https://github.com/example/product/pull/42#discussion_r1a" }] },
]));

test("a bot finding the author gave a 👍 no longer holds the gate", () => passes([
  { path: "feature.txt", line: 1, comments: [{ by: "parameterai", url: "https://github.com/example/product/pull/42#discussion_r2", thumbsUp: ["a-teammate", "the-user"] }] },
]));

test("a resolved bot finding no longer holds the gate", () => passes([{ ...finding("veria-ai", "https://github.com/example/product/pull/42#discussion_r3"), resolved: true }]));

test("a bot that answers the author's reply opens its finding again", async () => {
  const pr = await reviewed();
  pr.reviewThreads([{ path: "feature.txt", line: 1, comments: [
    { by: "posthog", url: "https://github.com/example/product/pull/42#discussion_r1" },
    { by: "the-user", url: "https://github.com/example/product/pull/42#discussion_r1a" },
    { by: "posthog", url: "https://github.com/example/product/pull/42#discussion_r1b" },
  ] }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 1 bot finding waits for an answer: https://github.com/example/product/pull/42#discussion_r1 (feature.txt:1). ");
});

test("a bot login GitHub reports as a user account still counts as a bot", async () => {
  const pr = await reviewed();
  pr.reviewThreads([{ path: "feature.txt", line: 1, comments: [{ by: "posthog-security-review-bot", app: false, url: "https://github.com/example/product/pull/42#discussion_r1" }] }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toContain("https://github.com/example/product/pull/42#discussion_r1 (feature.txt:1)");
});

test("a person's open thread is not a bot finding and leaves the gate to its other checks", async () => {
  const pr = await reviewed();
  pr.reviewThreads([{ path: "feature.txt", line: 1, comments: [{ by: "a-teammate", app: false, url: "https://github.com/example/product/pull/42#discussion_r1" }] }]);
  expect((await pr.hedge("gate")).code).toBe(0);
});

test("the refusal says how to answer the open findings", async () => {
  const pr = await reviewed();
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  const gate = await pr.hedge("gate");
  expect(lastLine(gate.output)).toEndWith("Fix each one and run hedge pr bot-threads --repo example/product --pr 42 --fixed <URL>, or reply in the thread with why it does not hold, then run the gate again");
});

test("a gate that cannot read the review threads fails closed and names the cause", async () => {
  const pr = await reviewed();
  pr.reviewThreads({ error: "gh: API rate limit already exceeded" });
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): bot threads: cannot read the PR's review threads on GitHub (gh api failed: gh: API rate limit already exceeded); run the gate again");
});

test("--landed does not skip an open bot finding, so it cannot pass an open PR past one", async () => {
  const pr = await reviewed();
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  const gate = await pr.hedge("gate", "--landed");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 1 bot finding waits for an answer: https://github.com/example/product/pull/42#discussion_r1 (feature.txt:1). ");
});

test("--landed on a merged PR still names a finding the bots left after the merge", async () => {
  const pr = await reviewed();
  pr.pullRequestState({ merged: true });
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  const gate = await pr.hedge("gate", "--landed");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 1 bot finding waits for an answer: https://github.com/example/product/pull/42#discussion_r1 (feature.txt:1). ");
});

test("the gate reads the bot threads of the PR it gates, not another one", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const target = ["--repo", "example/product", "--pr", "43"];
  await pr.hedge("require", "--none", "--reason", "docs only", ...target);
  fakeModel(pr, "REVIEWER", clean);
  await pr.hedge("review", "--lens", "correctness", ...target);
  expect((await pr.hedge("review", "--wait", ...target)).code).toBe(0);
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  pr.reviewThreads([finding("veria-ai", "https://github.com/example/product/pull/43#discussion_r7")], 43);
  const gate = await pr.hedge("gate", ...target);
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 1 bot finding waits for an answer: https://github.com/example/product/pull/43#discussion_r7 (feature.txt:1). ");
});

test("a bot finding that comes after a passing gate shows on the receipt as a gate that fails now", async () => {
  const pr = await reviewed();
  pr.pullRequestState({ body: `## Testing\n\nThe greeting.\n\n${graded("non-critical", "medium")}` });
  expect((await pr.hedge("gate")).code).toBe(0);
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  expect((await pr.hedge("receipt")).code).toBe(0);
  expect(pr.githubBody()).toContain("but the gate fails now");
});

test("a bot finding that comes after a passing gate sends the decision report back to the gate", async () => {
  const pr = await reviewed();
  pr.pullRequestState({ body: graded("non-critical") });
  const head = await pr.git("rev-parse", "HEAD");
  expect((await pr.hedge("gate")).code).toBe(0);
  const before = (await pr.decide("report", "--pr", "example/product#42")).output;
  expect(before).toContain("- Merge example/product#42: its proofs pass, and it waits on your merge word.");
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  const after = (await pr.decide("report", "--pr", "example/product#42")).output;
  expect(after).toContain(`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run hedge proof gate in its checkout to see why.`);
  expect(after).not.toContain("- Merge example/product#42");
});
