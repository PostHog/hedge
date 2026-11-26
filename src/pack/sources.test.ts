import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { cachedSource, fetchSource, followsBranch } from "./sources.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

async function packRepo(summary: string) {
  const dir = temp.make("pack-repo-");
  await spawnGit(dir, "init", "-q", "-b", "main");
  writePack(dir, summary);
  await spawnGit(dir, "add", ".");
  await spawnGit(dir, "commit", "-q", "-m", "v1");
  await spawnGit(dir, "tag", "v1");
  return dir;
}

function writePack(dir: string, summary: string) {
  mkdirSync(join(dir, "packs", "team"), { recursive: true });
  writeFileSync(join(dir, "packs", "team", "pack.json"), JSON.stringify({ schema: 1, name: "team", summary }));
}

async function tsRepo(files: Record<string, string>) {
  const dir = temp.make("pack-repo-");
  await spawnGit(dir, "init", "-q", "-b", "main");
  await commitTag(dir, "v1", files);
  return dir;
}

async function commitTag(dir: string, tag: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await spawnGit(dir, "add", ".");
  await spawnGit(dir, "commit", "-q", "-m", tag);
  await spawnGit(dir, "tag", tag);
}

describe("fetchSource", () => {
  test("checks a source out at its pinned ref", async () => {
    const repo = await packRepo("Team rules v1.");
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toBeUndefined();
  });

  test("keeps the last fetched packs when the source is unreachable", async () => {
    const repo = await packRepo("Team rules v1.");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toContain("could not fetch v2");
  });

  test("reports an error for an unreachable source never fetched before", async () => {
    const fetched = await fetchSource({ name: "team", repo: join(temp.make(), "missing"), ref: "v1" }, temp.make("cache-"));
    expect(fetched).toMatchObject({ error: expect.stringContaining("could not fetch v1") });
  });

  test("rejects a source name that leaves the cache", async () => {
    const root = temp.make("root-");
    const victim = join(root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "work.txt"), "unsaved\n");
    const fetched = await fetchSource({ name: "../victim", repo: await packRepo("Team rules v1."), ref: "v1" }, join(root, "cache"));
    expect(fetched).toMatchObject({ error: expect.stringContaining("must be lowercase words") });
    expect(existsSync(join(victim, "work.txt"))).toBe(true);
    expect(existsSync(join(victim, ".git"))).toBe(false);
  });

  test("keeps the last good packs when a fetched ref does not load", async () => {
    const repo = await packRepo("Team rules v1.");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    writeFileSync(join(repo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken." }));
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    await spawnGit(repo, "tag", "v2");
    for (const _ of [1, 2]) {
      const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
      if ("error" in fetched) throw new Error(fetched.error);
      expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
      expect(fetched.stale).toContain("does not load");
    }
  });

  test("keeps the last good pack.ts and the files it imports when a fetched ref does not load", async () => {
    const repo = temp.make("pack-repo-");
    await spawnGit(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "packs", "team"), { recursive: true });
    writeFileSync(join(repo, "packs", "team", "pack.ts"), `import { summary } from "./summary.ts";\nexport default { sdk: 1, name: "team", summary, register() {} };\n`);
    writeFileSync(join(repo, "packs", "team", "summary.ts"), `export const summary = "Team rules v1.";\n`);
    await spawnGit(repo, "add", ".");
    await spawnGit(repo, "commit", "-q", "-m", "v1");
    await spawnGit(repo, "tag", "v1");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    writeFileSync(join(repo, "packs", "team", "summary.ts"), `export const summary = "";\n`);
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    await spawnGit(repo, "tag", "v2");
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toContain("does not load");
  });

  test("keeps the last good pack.ts when a fetched pack.ts throws as it loads", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `export default { sdk: 1, name: "team", summary: "Team rules v1.", register() {} };\n` });
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    await commitTag(repo, "v2", { "packs/team/pack.ts": `throw new Error("broken on load");\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toContain("broken on load");
  });

  test("loads a new ref with the new version of a helper outside the pack's folder", async () => {
    const repo = await tsRepo({
      "packs/team/pack.ts": `import { summary } from "../../shared/summary.ts";\nexport default { sdk: 1, name: "team", summary, register() {} };\n`,
      "shared/summary.ts": `export const summary = "Team rules v1.";\n`,
    });
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    await commitTag(repo, "v2", { "shared/summary.ts": `export const summary = "Team rules v2.";\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v2.", undefined]);
  });

  test("loads a new ref with its new helper when the cache folder sits behind a symlink", async () => {
    const repo = await tsRepo({
      "packs/team/pack.ts": `import { summary } from "./summary.ts";\nexport default { sdk: 1, name: "team", summary, register() {} };\n`,
      "packs/team/summary.ts": `export const summary = "Team rules v1.";\n`,
    });
    const cache = join(temp.make("link-"), "cache");
    symlinkSync(temp.make("cache-"), cache);
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    await commitTag(repo, "v2", { "packs/team/summary.ts": `export const summary = "Team rules v2.";\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v2.", undefined]);
  });

  test("loads a pack.ts whose helper keeps a timer running", async () => {
    const repo = await tsRepo({
      "packs/team/pack.ts": `import { summary } from "./ticker.ts";\nexport default { sdk: 1, name: "team", summary, register() {} };\n`,
      "packs/team/ticker.ts": `setInterval(() => {}, 3_600_000);\nexport const summary = "Team rules v1.";\n`,
    });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v1.", undefined]);
  });

  test("reports a pack.ts that never finishes loading, so apply goes on", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `await new Promise((resolve) => setTimeout(resolve, 3_600_000));\nexport default { sdk: 1, name: "team", summary: "Team rules v1.", register() {} };\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"), 1);
    expect(fetched).toMatchObject({ error: expect.stringContaining("did not finish loading within") });
  });

  test("reports a pack.ts that ignores SIGTERM and never finishes loading", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `process.on("SIGTERM", () => {});\nawait new Promise((resolve) => setTimeout(resolve, 3_600_000));\nexport default { sdk: 1, name: "team", summary: "Team rules v1.", register() {} };\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"), 200);
    expect(fetched).toMatchObject({ error: expect.stringContaining("did not finish loading within 0.2 seconds") });
  });

  test("names the signal, not the time limit, when a pack.ts crashes as it loads", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `process.kill(process.pid, "SIGKILL");\nexport default { sdk: 1, name: "team", summary: "Team rules v1.", register() {} };\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    if (!("error" in fetched)) throw new Error("the crashed pack loaded");
    expect(fetched.error).toContain("the packs stop on SIGKILL as they load");
    expect(fetched.error).not.toContain("within");
  });

  test("names the exit code and the thrown error when a pack.ts prints progress and then throws", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `console.log("loading team rules");\nthrow new Error("broken on load");\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    expect(fetched).toMatchObject({ error: expect.stringMatching(/the packs exit 1 as they load: \S+pack\.ts: broken on load$/) });
  });

  test("returns promptly when a pack.ts leaves a process holding its output open and then throws", async () => {
    const pidFile = join(temp.make("sleeper-"), "pid");
    const repo = await tsRepo({ "packs/team/pack.ts": `const sleeper = Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });\nawait Bun.write(${JSON.stringify(pidFile)}, String(sleeper.pid));\nthrow new Error("broken after spawn");\n` });
    try {
      const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
      expect(fetched).toMatchObject({ error: expect.stringMatching(/the packs exit 1 as they load: \S+pack\.ts: broken after spawn$/) });
    } finally {
      if (existsSync(pidFile)) process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL");
    }
  });

  test("names the last line a pack.ts printed when it exits as it loads", async () => {
    const repo = await tsRepo({ "packs/team/pack.ts": `console.error("the team token file is missing");\nprocess.exit(3);\nexport default { sdk: 1, name: "team", summary: "Team rules v1.", register() {} };\n` });
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    expect(fetched).toMatchObject({ error: expect.stringContaining("the packs exit 3 as they load: the team token file is missing") });
  });

  test("never falls back to a cache of another repository", async () => {
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo: await packRepo("Old repo."), ref: "v1" }, cache);
    const fetched = await fetchSource({ name: "team", repo: join(temp.make(), "moved"), ref: "v1" }, cache);
    expect(fetched).toMatchObject({ error: expect.stringContaining("could not fetch v1") });
  });

  test("loads cached SHA-pinned commits offline (including pre-upgrade caches), ignores stale FETCH_HEAD branch lines, and isolates repos", async () => {
    const repo = await packRepo("Team rules v1.");
    const sha1 = (await spawnGit(repo, "rev-parse", "HEAD")).trim();
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const sha2 = (await spawnGit(repo, "rev-parse", "HEAD")).trim();
    const cache = temp.make("cache-");

    await fetchSource({ name: "team", repo, ref: "main" }, cache);
    const fetched1 = await fetchSource({ name: "team", repo, ref: sha1 }, cache);
    if ("error" in fetched1) throw new Error(fetched1.error);
    expect([fetched1.packs[0]?.manifest.summary, fetched1.stale]).toEqual(["Team rules v1.", undefined]);

    writeFileSync(join(cache, "team", ".git", "FETCH_HEAD"), `${sha1}\t\tbranch '${sha1}' of ${repo}\n`);
    expect(await followsBranch({ name: "team", repo, ref: sha1 }, cache)).toBe(false);

    rmSync(repo, { recursive: true, force: true });
    const offline1 = await fetchSource({ name: "team", repo, ref: sha1 }, cache);
    if ("error" in offline1) throw new Error(offline1.error);
    expect([offline1.packs[0]?.manifest.summary, offline1.stale]).toEqual(["Team rules v1.", undefined]);

    const offline2 = await fetchSource({ name: "team", repo, ref: sha2 }, cache);
    if ("error" in offline2) throw new Error(offline2.error);
    expect([offline2.packs[0]?.manifest.summary, offline2.stale]).toEqual(["Team rules v2.", undefined]);

    rmSync(join(cache, "team", ".git", "refs", "hedge"), { recursive: true, force: true });
    const preUpgrade = await fetchSource({ name: "team", repo, ref: sha2 }, cache);
    if ("error" in preUpgrade) throw new Error(preUpgrade.error);
    expect([preUpgrade.packs[0]?.manifest.summary, preUpgrade.stale]).toEqual(["Team rules v2.", undefined]);

    const otherRepo = await fetchSource({ name: "team", repo: join(temp.make(), "other"), ref: sha1 }, cache);
    expect(otherRepo).toMatchObject({ error: expect.stringContaining(`could not fetch ${sha1}`) });
  });

  test("repairs corrupt cache metadata with missing commit when fetching a SHA-pinned source online", async () => {
    const repo = await packRepo("Team rules v1.");
    const sha1 = (await spawnGit(repo, "rev-parse", "HEAD")).trim();
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: sha1 }, cache);
    rmSync(join(cache, "team", ".git", "refs", "hedge"), { recursive: true, force: true });
    writeFileSync(join(cache, "team", ".git", "hedge-source.json"), JSON.stringify({ repo, ref: sha1 }) + "\n");
    const repaired = await fetchSource({ name: "team", repo, ref: sha1 }, cache);
    if ("error" in repaired) throw new Error(repaired.error);
    expect([repaired.packs[0]?.manifest.summary, repaired.stale]).toEqual(["Team rules v1.", undefined]);
  });
});

describe("inside a Git hook of another repository", () => {
  const hookRepoEnv = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"] as const;
  const saved = Object.fromEntries(hookRepoEnv.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of hookRepoEnv) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  function insideHookOf(repo: string) {
    const gitDir = join(repo, ".git");
    Object.assign(process.env, { GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(gitDir, "index"), GIT_COMMON_DIR: gitDir, GIT_OBJECT_DIRECTORY: join(gitDir, "objects"), GIT_PREFIX: "" });
  }

  test("fetches and loads its sources, not the hook's repository", async () => {
    const source = await packRepo("Team rules v1.");
    const caller = await packRepo("Caller repo.");
    insideHookOf(caller);
    const fetched = await fetchSource({ name: "team", repo: source, ref: "v1" }, temp.make("cache-"));
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
  });

  test("reads the cached checkout, not the hook's repository", async () => {
    const source = await packRepo("Team rules v1.");
    const caller = await packRepo("Caller repo.");
    await spawnGit(caller, "commit", "-q", "--allow-empty", "-m", "caller");
    const cache = temp.make("cache-");
    const ref = { name: "team", repo: source, ref: "v1" };
    await fetchSource(ref, cache);
    insideHookOf(caller);
    const cached = await cachedSource(ref, cache);
    if ("error" in cached) throw new Error(cached.error);
    expect(cached.packs[0]?.manifest.summary).toBe("Team rules v1.");
  });
});
