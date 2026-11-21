import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { checkout, cleanFixtures, fakeModel, fixture, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function publishBase(pr: Checkout, remote = "origin") {
  const bare = join(fixture("hedge-proof-remote-"), "github.com/example/product.git");
  mkdirSync(bare, { recursive: true });
  await pr.git("init", "-q", "--bare", bare);
  await pr.git("push", "-q", bare, "main:refs/heads/main");
  await pr.git("remote", remote === "origin" ? "set-url" : "add", remote, bare);
  return bare;
}

async function mergeBaseBehindStaleRef(pr: Checkout) {
  await pr.commit("feature.txt", "greet the new member\n");
  const stale = await pr.git("rev-parse", "refs/remotes/origin/main");
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.hedge("require", "--none", "--reason", "docs only");
  return stale;
}

async function judgePrompt(pr: Checkout) {
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  return judge.prompts().at(-1)!;
}

test("after the branch merges a base its stale base ref lags behind, the reviewer reads only the branch's lines", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.txt\n");

  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);

  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("+greet the new member");
  expect(brief).not.toContain("the base moves on");
});

test("after the branch merges a base its stale base ref lags behind, the judge reads only the branch's lines", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr);
  await pr.git("update-ref", "refs/remotes/origin/main", stale);

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("after the base drops a tip the branch merged, the judge reads that tip's lines, which the branch now carries", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("base.md", "a base change that is later dropped\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("checkout", "-q", "main");
  await pr.git("reset", "-q", "--hard", "HEAD^");
  await pr.commit("forced.md", "the force-pushed base\n");
  await pr.git("checkout", "-q", "feature");
  await publishBase(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).toContain("+a base change that is later dropped");
  expect(prompt).not.toContain("the force-pushed base");
});

test("when one remote of the repository cannot be fetched, the judge reads the base from the one that can", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  await publishBase(pr, "upstream");
  await pr.git("remote", "set-url", "origin", join(fixture("hedge-proof-gone-"), "github.com/example/product.git"));
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  await pr.git("update-ref", "refs/remotes/upstream/main", stale);

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});

test("fetching the base writes no ref but the base's remote ref, even in a checkout that prunes and maps the base elsewhere", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  const bare = await publishBase(pr);
  await pr.git("push", "-q", bare, "main:refs/tags/remote-tag");
  await pr.git("update-ref", "refs/remotes/origin/main", stale);
  await pr.git("update-ref", "refs/remotes/origin/gone", stale);
  await pr.git("update-ref", "refs/heads/mirror", stale);
  await pr.git("tag", "unpublished");
  await pr.git("config", "fetch.prune", "true");
  await pr.git("config", "fetch.pruneTags", "true");
  await pr.git("config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/mirror");
  const refsBefore = await pr.git("for-each-ref", "--format=%(refname) %(objectname)", "--exclude=refs/remotes/origin/main");

  await judgePrompt(pr);
  expect(await pr.git("rev-parse", "refs/remotes/origin/main")).toBe(await pr.git("rev-parse", "main"));
  expect(await pr.git("for-each-ref", "--format=%(refname) %(objectname)", "--exclude=refs/remotes/origin/main")).toBe(refsBefore);
  expect(existsSync(join(pr.repository, ".git/FETCH_HEAD"))).toBe(false);
});

test("fetching the base leaves a populated submodule as it was, even when the new base points it at a commit it lacks", async () => {
  const pr = await checkout();
  const library = join(fixture("hedge-proof-library-"), "library.git");
  const elsewhere = fixture("hedge-proof-library-work-");
  const there = (...args: string[]) => spawnAsync(["git", ...args], { cwd: elsewhere, env: pr.env });
  await there("init", "-q", "--bare", "-b", "main", library);
  await there("clone", "-q", library, ".");
  await there("commit", "-q", "--allow-empty", "-m", "First library commit");
  await there("push", "-q", "origin", "HEAD:refs/heads/main");
  await pr.git("checkout", "-q", "main");
  await pr.git("submodule", "add", "-q", library, "library");
  await pr.git("commit", "-q", "-m", "Add the library");
  await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await pr.git("checkout", "-q", "feature");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("submodule", "update", "-q", "--init");
  await pr.commit("feature.txt", "greet the new member\n");
  await there("commit", "-q", "--allow-empty", "-m", "Second library commit");
  await there("push", "-q", "origin", "HEAD:refs/heads/main");
  const unfetched = (await there("rev-parse", "HEAD")).stdout.trim();
  await pr.git("checkout", "-q", "main");
  await pr.git("update-index", "--cacheinfo", `160000,${unfetched},library`);
  await pr.git("commit", "-q", "-m", "Move the library");
  const moved = await pr.git("rev-parse", "HEAD");
  await pr.git("reset", "-q", "--hard", "refs/remotes/origin/main");
  await pr.git("checkout", "-q", "feature");
  const bare = await publishBase(pr);
  await pr.git("push", "-q", bare, `${moved}:refs/heads/main`);
  await pr.hedge("require", "--none", "--reason", "docs only");

  await judgePrompt(pr);
  expect(await pr.git("rev-parse", "refs/remotes/origin/main")).toBe(moved);
  expect((await spawnAsync(["git", "cat-file", "-e", `${unfetched}^{commit}`], { cwd: join(pr.repository, "library"), env: pr.env })).exitCode).not.toBe(0);
});

test("when two remotes of the repository fetch different tips, the judge reads the base from the newer one", async () => {
  const pr = await checkout();
  const stale = await mergeBaseBehindStaleRef(pr);
  const lagging = await publishBase(pr);
  await pr.git("push", "-q", "--force", lagging, `${stale}:refs/heads/main`);
  await publishBase(pr, "upstream");
  await pr.git("update-ref", "refs/remotes/origin/main", stale);

  const prompt = await judgePrompt(pr);
  expect(prompt).toContain("+greet the new member");
  expect(prompt).not.toContain("the base moves on");
});
