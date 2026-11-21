import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnRunner } from "./adapters/run.ts";
import { realMachine } from "./setup/commands.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";

isolateGit();
const temp = tempDirs();
const saved = process.env.GIT_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = saved;
  temp.cleanup();
});

async function hookOfOtherRepo() {
  const caller = temp.make("caller-");
  await spawnGit(caller, "init", "-q");
  const own = temp.make("own-");
  await spawnGit(own, "init", "-q");
  process.env.GIT_DIR = join(caller, ".git");
  return { caller, own };
}

test("git -C works on its own repository inside another repository's hook", async () => {
  const { own } = await hookOfOtherRepo();
  const command = ["git", "-C", own, "rev-parse", "--absolute-git-dir"];
  expect((await spawnRunner(command)).stdout.trim()).toBe(join(own, ".git"));
  expect((await realMachine.exec(command)).stdout.trim()).toBe(join(own, ".git"));
});

test("other commands keep the hook's repository", async () => {
  const { caller } = await hookOfOtherRepo();
  const command = ["sh", "-c", 'printf %s "$GIT_DIR"'];
  expect((await spawnRunner(command)).stdout).toBe(join(caller, ".git"));
  expect((await realMachine.exec(command)).stdout).toBe(join(caller, ".git"));
});
