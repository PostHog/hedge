import { afterEach, expect, test } from "bun:test";
import { checkout, cleanFixtures, reviewHead } from "./proof-testing.ts";

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

test("a bot finding the author replied to, gave a 👍, or resolved no longer holds the gate", async () => {
  const pr = await reviewed();
  pr.reviewThreads([
    { path: "feature.txt", line: 1, comments: [{ by: "posthog", url: "https://github.com/example/product/pull/42#discussion_r1" }, { by: "the-user", url: "https://github.com/example/product/pull/42#discussion_r1a" }] },
    { path: "feature.txt", line: 2, comments: [{ by: "parameterai", url: "https://github.com/example/product/pull/42#discussion_r2", thumbsUp: ["the-user"] }] },
    { ...finding("veria-ai", "https://github.com/example/product/pull/42#discussion_r3"), resolved: true },
  ]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).not.toContain("bot threads:");
});

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

test("--landed on a PR GitHub reports open still holds on an open bot finding", async () => {
  const pr = await reviewed();
  pr.reviewThreads([finding("posthog", "https://github.com/example/product/pull/42#discussion_r1")]);
  const gate = await pr.hedge("gate", "--landed");
  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toStartWith("gate: fail (exit 1): bot threads: 1 bot finding waits for an answer: https://github.com/example/product/pull/42#discussion_r1 (feature.txt:1). ");
});

test("--landed on a PR GitHub reports merged records the merge without reading the bot threads", async () => {
  const pr = await reviewed();
  pr.pullRequestState({ merged: true });
  pr.reviewThreads({ error: "gh: API rate limit already exceeded" });
  const gate = await pr.hedge("gate", "--landed");
  expect(gate.code).toBe(0);
  expect(gate.output).not.toContain("bot threads:");
});
