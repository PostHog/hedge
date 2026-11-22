import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnRunner } from "./adapters/run.ts";
import { withoutRepoEnv } from "./repo-env.ts";
import { realMachine } from "./setup/commands.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";

isolateGit();
const temp = tempDirs();
const hookEnv = ["GIT_DIR", "GIT_WORK_TREE"] as const;
const saved = Object.fromEntries(hookEnv.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of hookEnv) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  temp.cleanup();
});

async function hookOfOtherRepo() {
  const caller = temp.make("caller-");
  await spawnGit(caller, "init", "-q");
  const own = temp.make("own-");
  await spawnGit(own, "init", "-q");
  Object.assign(process.env, { GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: caller });
  return { caller, own };
}

test("git -C works on its own repository inside another repository's hook", async () => {
  const { own } = await hookOfOtherRepo();
  const command = ["git", "-C", own, "rev-parse", "--absolute-git-dir"];
  const ownGitDir = join(realpathSync(own), ".git");
  expect((await spawnRunner(command)).stdout.trim()).toBe(ownGitDir);
  expect((await realMachine.exec(command)).stdout.trim()).toBe(ownGitDir);
});

test("git clone makes its own repository inside another repository's hook", async () => {
  const { own } = await hookOfOtherRepo();
  await spawnGit(own, "commit", "-q", "--allow-empty", "-m", "own");
  const runnerCopy = join(temp.make("copy-"), "repo");
  const machineCopy = join(temp.make("copy-"), "repo");
  expect((await spawnRunner(["git", "clone", "-q", own, runnerCopy])).code).toBe(0);
  expect((await realMachine.exec(["git", "clone", "-q", own, machineCopy])).code).toBe(0);
});

test("leaves Git's config variables, so git -c and credential settings still apply", () => {
  const env = { GIT_DIR: "/hook/.git", GIT_QUARANTINE_PATH: "/hook/.git/objects/incoming", GIT_CONFIG_PARAMETERS: "'a.b'='c'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" };
  expect(withoutRepoEnv(env)).toEqual({ GIT_CONFIG_PARAMETERS: "'a.b'='c'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" });
});

test("other commands keep the hook's repository", async () => {
  const { caller } = await hookOfOtherRepo();
  const command = ["sh", "-c", 'printf %s "$GIT_DIR"'];
  expect((await spawnRunner(command)).stdout).toBe(join(caller, ".git"));
  expect((await realMachine.exec(command)).stdout).toBe(join(caller, ".git"));
});
