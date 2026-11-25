import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { advanceSource, cachedSource, fetchSource, followsBranch } from "./sources.ts";

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

  test("loads a pinned commit it fetched before without reaching the source", async () => {
    const repo = await packRepo("Team rules v1.");
    const ref = { name: "team", repo, ref: await spawnGit(repo, "rev-parse", "HEAD") };
    const cache = temp.make("cache-");
    await fetchSource(ref, cache);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource(ref, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v1.", undefined]);
  });

  test("falls back as stale offline on a cache that an older Hedge wrote until verified online", async () => {
    const repo = await packRepo("Legacy rules v1.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await legacyPinnedCache(cache, "team", repo, commit);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource({ name: "team", repo, ref: commit }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Legacy rules v1.");
    expect(fetched.stale).toContain(`could not fetch ${commit}`);
  });

  test("loads a commit pinned in capitals from the cache without reaching the source", async () => {
    const repo = await packRepo("Team rules v1.");
    const ref = { name: "team", repo, ref: (await spawnGit(repo, "rev-parse", "HEAD")).toUpperCase() };
    const cache = temp.make("cache-");
    await fetchSource(ref, cache);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource(ref, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v1.", undefined]);
  });

  test("moves to another pinned commit already in the cache without reaching the source", async () => {
    const repo = await packRepo("Team rules v1.");
    const first = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const second = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: first }, cache);
    await fetchSource({ name: "team", repo, ref: second }, cache);
    rmSync(repo, { recursive: true, force: true });
    const ref = { name: "team", repo, ref: first };
    const fetched = await fetchSource(ref, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v1.", undefined]);
    const cached = await cachedSource(ref, cache);
    if ("error" in cached) throw new Error(cached.error);
    expect(cached.packs[0]?.manifest.summary).toBe("Team rules v1.");
  });

  test("fetches a moving ref again, even one that names a commit in the cache", async () => {
    const repo = await packRepo("Team rules v1.");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "HEAD" }, cache);
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const fetched = await fetchSource({ name: "team", repo, ref: "HEAD" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v2.", undefined]);
  });

  test("fetches a pinned commit from a new repository even when the cache holds it", async () => {
    const repo = await packRepo("Team rules v1.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: commit }, cache);
    const fetched = await fetchSource({ name: "team", repo: join(temp.make(), "moved"), ref: commit }, cache);
    expect(fetched).toMatchObject({ error: expect.stringContaining(`could not fetch ${commit}`) });
  });

  test("fetches a pinned commit that the cache holds only from the repository it used before", async () => {
    const before = await packRepo("Old repo.");
    const oldCommit = await spawnGit(before, "rev-parse", "HEAD");
    const now = await packRepo("New repo.");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo: before, ref: oldCommit }, cache);
    await fetchSource({ name: "team", repo: now, ref: await spawnGit(now, "rev-parse", "HEAD") }, cache);
    const fetched = await fetchSource({ name: "team", repo: now, ref: oldCommit }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("New repo.");
    expect(fetched.stale).toContain(`could not fetch ${oldCommit}`);
  });

  test("never falls back to a cache of another repository", async () => {
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo: await packRepo("Old repo."), ref: "v1" }, cache);
    const fetched = await fetchSource({ name: "team", repo: join(temp.make(), "moved"), ref: "v1" }, cache);
    expect(fetched).toMatchObject({ error: expect.stringContaining("could not fetch v1") });
  });

  test("ignores a malformed last-good record and fetches cleanly", async () => {
    const repo = await packRepo("Team rules v1.");
    const commit1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: commit1 }, cache);

    const freshRepo = await packRepo("Fresh rules.");
    const freshCommit = await spawnGit(freshRepo, "rev-parse", "HEAD");
    writeFileSync(join(cache, "team", ".git", "hedge-source.json"), JSON.stringify({ repo: 42 }));
    const fetchedCorrupt = await fetchSource({ name: "team", repo: freshRepo, ref: freshCommit }, cache);
    if ("error" in fetchedCorrupt) throw new Error(fetchedCorrupt.error);
    expect([fetchedCorrupt.packs[0]?.manifest.summary, fetchedCorrupt.stale]).toEqual(["Fresh rules.", undefined]);
  });

  test("keeps hedge-source.json private (0600) across atomic updates", async () => {
    const repo = await packRepo("Private creds repo.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: commit }, cache);
    const sourceFile = join(cache, "team", ".git", "hedge-source.json");
    expect(statSync(sourceFile).mode & 0o777).toBe(0o600);
  });

  async function legacyPinnedCache(cache: string, name: string, repo: string, commit: string, extra: Record<string, string> = {}) {
    const dir = join(cache, name);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".git"))) await spawnGit(dir, "init", "-q");
    await spawnGit(dir, "fetch", "-q", "--depth", "1", "--no-tags", repo, commit);
    await spawnGit(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(dir, ".git", "hedge-source.json"), JSON.stringify({ repo, ref: commit, commit, ...extra }) + "\n");
    return dir;
  }

  function setDirModes(root: string, mode: number) {
    const dirs: string[] = [];
    const walk = (dir: string) => {
      dirs.push(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(join(dir, entry.name));
    };
    if (existsSync(root)) walk(root);
    for (const dir of mode & 0o200 ? dirs : dirs.reverse()) chmodSync(dir, mode);
  }

  test("preserves verified pin history across repository switches and git gc", async () => {
    const repoA = await packRepo("Repo A v1.");
    const commitA1 = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Repo B v1.");
    const commitB1 = await spawnGit(repoB, "rev-parse", "HEAD");
    const cache = temp.make("cache-");

    await fetchSource({ name: "team", repo: repoA, ref: commitA1 }, cache);
    await fetchSource({ name: "team", repo: repoB, ref: commitB1 }, cache);

    const cacheRepo = join(cache, "team");
    await spawnGit(cacheRepo, "reflog", "expire", "--expire=now", "--all");
    await spawnGit(cacheRepo, "gc", "--prune=now", "-q");

    rmSync(repoA, { recursive: true, force: true });
    const offlineA1 = await fetchSource({ name: "team", repo: repoA, ref: commitA1 }, cache);
    if ("error" in offlineA1) throw new Error(offlineA1.error);
    expect([offlineA1.packs[0]?.manifest.summary, offlineA1.stale]).toEqual(["Repo A v1.", undefined]);
  });

  test("does not trust or migrate a malformed legacy record whose ref and commit SHAs disagree", async () => {
    const repoA = await packRepo("Repo A v1.");
    const commitA1 = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Repo B v1.");
    const commitB1 = await spawnGit(repoB, "rev-parse", "HEAD");
    const cache = temp.make("cache-");

    await legacyPinnedCache(cache, "team", repoA, commitA1);
    await fetchSource({ name: "team", repo: repoB, ref: commitB1 }, cache);
    writeFileSync(join(cache, "team", ".git", "hedge-source.json"), JSON.stringify({ repo: repoB, ref: commitB1, commit: commitA1 }) + "\n");

    const directHit = await fetchSource({ name: "team", repo: repoB, ref: commitA1 }, cache);
    expect(directHit).toMatchObject({ error: expect.stringContaining(`could not fetch ${commitA1}`) });

    await fetchSource({ name: "team", repo: repoB, ref: "main" }, cache);
    const afterBranch = await fetchSource({ name: "team", repo: repoB, ref: commitA1 }, cache);
    if ("error" in afterBranch) throw new Error(afterBranch.error);
    expect(afterBranch.packs[0]?.manifest.summary).toBe("Repo B v1.");
    expect(afterBranch.stale).toContain(`could not fetch ${commitA1}`);
  });

  test("loads a pinned commit offline after loading it through a moving branch even after the branch advances", async () => {
    const repo = await packRepo("Branch rules v1.");
    const commit1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    const online1 = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    if ("error" in online1) throw new Error(online1.error);
    writePack(repo, "Branch rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const online2 = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    if ("error" in online2) throw new Error(online2.error);
    rmSync(repo, { recursive: true, force: true });
    const pinned = await fetchSource({ name: "team", repo, ref: commit1 }, cache);
    if ("error" in pinned) throw new Error(pinned.error);
    expect([pinned.packs[0]?.manifest.summary, pinned.stale]).toEqual(["Branch rules v1.", undefined]);
  });

  test("does not report success when Git cannot record a pin ref during fetch or refresh", async () => {
    const repo = await packRepo("Team rules v1.");
    const commit1 = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const commit2 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: commit1 }, cache);

    const refsDir = join(cache, "team", ".git", "refs");
    setDirModes(refsDir, 0o555);
    try {
      const blocked = await fetchSource({ name: "team", repo, ref: commit2 }, cache);
      if ("error" in blocked) throw new Error(blocked.error);
      expect(blocked.packs[0]?.manifest.summary).toBe("Team rules v1.");
      expect(blocked.stale).toContain(`could not record ${commit2}`);

      const repoB = await packRepo("Repo B rules.");
      const commitB = await spawnGit(repoB, "rev-parse", "HEAD");
      const switched = await fetchSource({ name: "team", repo: repoB, ref: commitB }, cache);
      expect(switched).toMatchObject({ error: expect.stringContaining(`could not record ${commitB}`) });
      expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(commit1);
    } finally {
      setDirModes(refsDir, 0o755);
    }

    const refreshCache = temp.make("refresh-cache-");
    const refreshRepo = await legacyPinnedCache(refreshCache, "team", repo, commit1, { asked: "main" });
    const refreshRefs = join(refreshRepo, ".git", "refs");
    setDirModes(refreshRefs, 0o555);
    try {
      const moved = await advanceSource({ name: "team", repo, ref: "main" }, refreshCache, commit1);
      expect(moved).toMatchObject({ state: "failed", say: expect.stringContaining("could not record main") });
      expect(await spawnGit(refreshRepo, "rev-parse", "HEAD")).toBe(commit1);
    } finally {
      setDirModes(refreshRefs, 0o755);
    }
  });

  test("preserves a locally committed cache HEAD on an unreachable repo switch and rolls back when writing metadata fails", async () => {
    const repoA = await packRepo("Repo A v1.");
    const commitA1 = await spawnGit(repoA, "rev-parse", "HEAD");
    writePack(repoA, "Repo A v2.");
    await spawnGit(repoA, "commit", "-q", "-am", "v2");
    const commitA2 = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Repo B v1.");
    const commitB = await spawnGit(repoB, "rev-parse", "HEAD");

    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo: repoA, ref: commitA1 }, cache);
    const cacheDir = join(cache, "team");
    await spawnGit(cacheDir, "checkout", "-q", "-b", "topic");
    writePack(cacheDir, "Local cache edit.");
    await spawnGit(cacheDir, "commit", "-q", "-am", "local edit");
    await spawnGit(cacheDir, "tag", "topic");
    const localCommit = await spawnGit(cacheDir, "rev-parse", "HEAD");

    const unreachable = await fetchSource({ name: "team", repo: join(temp.make("missing-"), "gone.git"), ref: "main" }, cache);
    expect("error" in unreachable).toBe(true);
    expect(await spawnGit(cacheDir, "rev-parse", "HEAD")).toBe(localCommit);
    expect(await spawnGit(cacheDir, "symbolic-ref", "-q", "HEAD")).toBe("refs/heads/topic");

    const refsDir = join(cacheDir, ".git", "refs");
    setDirModes(refsDir, 0o555);
    try {
      const sameRepoBlocked = await fetchSource({ name: "team", repo: repoA, ref: commitA2 }, cache);
      expect(sameRepoBlocked).toMatchObject({ error: expect.stringContaining(`could not record ${commitA2}`) });
      expect(await spawnGit(cacheDir, "rev-parse", "HEAD")).toBe(localCommit);
      expect(await spawnGit(cacheDir, "symbolic-ref", "-q", "HEAD")).toBe("refs/heads/topic");
    } finally {
      setDirModes(refsDir, 0o755);
    }

    const metaPath = join(cacheDir, ".git", "hedge-source.json");
    writeFileSync(metaPath, "null\n");
    const repaired = await fetchSource({ name: "team", repo: repoA, ref: commitA1 }, cache);
    if ("error" in repaired) throw new Error(repaired.error);
    expect([repaired.packs[0]?.manifest.summary, repaired.stale]).toEqual(["Repo A v1.", undefined]);
    await spawnGit(cacheDir, "switch", "-q", "topic");

    rmSync(metaPath, { force: true });
    mkdirSync(metaPath, { recursive: true });
    writeFileSync(join(metaPath, "keep"), "x");
    try {
      const switchFailed = await fetchSource({ name: "team", repo: repoB, ref: commitB }, cache);
      expect(switchFailed).toMatchObject({ error: expect.stringContaining(`could not record ${commitB}`) });
      expect(await spawnGit(cacheDir, "rev-parse", "HEAD")).toBe(localCommit);
      expect(await spawnGit(cacheDir, "symbolic-ref", "-q", "HEAD")).toBe("refs/heads/topic");
    } finally {
      rmSync(metaPath, { recursive: true, force: true });
    }

    const refreshCache = temp.make("refresh-meta-");
    const refreshDir = await legacyPinnedCache(refreshCache, "team", repoA, commitA1, { asked: "main" });
    await spawnGit(refreshDir, "checkout", "-q", "-b", "local-work");
    const refreshMeta = join(refreshDir, ".git", "hedge-source.json");
    rmSync(refreshMeta, { force: true });
    mkdirSync(refreshMeta, { recursive: true });
    writeFileSync(join(refreshMeta, "keep"), "x");
    try {
      const refreshFailed = await advanceSource({ name: "team", repo: repoA, ref: "main" }, refreshCache, commitA1);
      expect(refreshFailed).toMatchObject({ state: "failed", say: expect.stringContaining("could not record main") });
      expect(await spawnGit(refreshDir, "rev-parse", "HEAD")).toBe(commitA1);
      expect(await spawnGit(refreshDir, "symbolic-ref", "-q", "HEAD")).toBe("refs/heads/local-work");
    } finally {
      rmSync(refreshMeta, { recursive: true, force: true });
    }

    const enclosing = await packRepo("Outer worktree.");
    const outerBranch = await spawnGit(enclosing, "symbolic-ref", "-q", "HEAD");
    const outerHead = await spawnGit(enclosing, "rev-parse", "HEAD");
    const fakeCache = join(enclosing, "nested-cache");
    mkdirSync(join(fakeCache, "team"), { recursive: true });
    const pinCheck = await fetchSource({ name: "team", repo: enclosing, ref: outerHead }, fakeCache);
    if ("error" in pinCheck) throw new Error(pinCheck.error);
    expect(await spawnGit(enclosing, "symbolic-ref", "-q", "HEAD")).toBe(outerBranch);
    expect(await spawnGit(enclosing, "rev-parse", "HEAD")).toBe(outerHead);

    const detachedCache = temp.make("detached-edit-");
    await fetchSource({ name: "team", repo: repoA, ref: commitA1 }, detachedCache);
    const detachedDir = join(detachedCache, "team");
    writePack(detachedDir, "Detached local commit.");
    await spawnGit(detachedDir, "commit", "-q", "-am", "detached local edit");
    const detachedLocal = await spawnGit(detachedDir, "rev-parse", "HEAD");
    const detachedRefs = join(detachedDir, ".git", "refs");
    setDirModes(detachedRefs, 0o555);
    try {
      const blocked = await fetchSource({ name: "team", repo: repoA, ref: commitA2 }, detachedCache);
      expect(blocked).toMatchObject({ error: expect.stringContaining(`could not record ${commitA2}`) });
      expect(await spawnGit(detachedDir, "rev-parse", "HEAD")).toBe(detachedLocal);
    } finally {
      setDirModes(detachedRefs, 0o755);
    }
  });

  test("keys pin history by Git's resolved insteadOf URL and invalidates pack.ts modules on refresh rollback", async () => {
    const repoA = await packRepo("InsteadOf Repo A.");
    const commitA = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("InsteadOf Repo B.");
    const alias = "https://instead.example.com/team/packs.git";
    const cache = temp.make("insteadof-");
    const dir = join(cache, "team");
    mkdirSync(dir, { recursive: true });
    await spawnGit(dir, "init", "-q");
    await spawnGit(dir, "config", `url.${repoA}.insteadOf`, alias);

    const first = await fetchSource({ name: "team", repo: alias, ref: commitA }, cache);
    if ("error" in first) throw new Error(first.error);
    expect(first.packs[0]?.manifest.summary).toBe("InsteadOf Repo A.");

    await spawnGit(dir, "config", "--unset", `url.${repoA}.insteadOf`);
    await spawnGit(dir, "config", `url.${repoB}.insteadOf`, alias);
    const switched = await fetchSource({ name: "team", repo: alias, ref: commitA }, cache);
    expect("error" in switched).toBe(true);

    const modRepo = temp.make("mod-repo-");
    await spawnGit(modRepo, "init", "-q", "-b", "main");
    mkdirSync(join(modRepo, "packs/team"), { recursive: true });
    writeFileSync(join(modRepo, "packs/team/pack.ts"), 'export default { sdk: 1, name: "team", summary: "Module v1.", register() {} };\n');
    await spawnGit(modRepo, "add", ".");
    await spawnGit(modRepo, "commit", "-q", "-m", "v1");
    const mod1 = await spawnGit(modRepo, "rev-parse", "HEAD");
    writeFileSync(join(modRepo, "packs/team/pack.ts"), 'export default { sdk: 1, name: "team", summary: "Module v2.", register() {} };\n');
    await spawnGit(modRepo, "commit", "-q", "-am", "v2");

    const modCache = temp.make("mod-cache-");
    await fetchSource({ name: "team", repo: modRepo, ref: mod1 }, modCache);
    const modMeta = join(modCache, "team", ".git", "hedge-source.json");
    writeFileSync(modMeta, JSON.stringify({ repo: modRepo, ref: "main", commit: mod1 }) + "\n");
    const modRefs = join(modCache, "team", ".git", "refs");
    setDirModes(modRefs, 0o555);
    try {
      const failed = await advanceSource({ name: "team", repo: modRepo, ref: "main" }, modCache, mod1);
      expect(failed).toMatchObject({ state: "failed" });
    } finally {
      setDirModes(modRefs, 0o755);
    }
    const cached = await cachedSource({ name: "team", repo: modRepo, ref: "main" }, modCache);
    if ("error" in cached) throw new Error(cached.error);
    expect(cached.packs[0]?.manifest.summary).toBe("Module v1.");
  });

  test("records pinned history even for a relative repository path named after an Object property", async () => {
    const cache = temp.make("cache-");
    const repo = join(cache, "team", "constructor");
    mkdirSync(repo, { recursive: true });
    await spawnGit(repo, "init", "-q", "-b", "main");
    writePack(repo, "Proto rules.");
    await spawnGit(repo, "add", ".");
    await spawnGit(repo, "commit", "-q", "-m", "v1");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const first = await fetchSource({ name: "team", repo: "constructor", ref: commit }, cache);
    if ("error" in first) throw new Error(first.error);
    expect(first.packs[0]?.manifest.summary).toBe("Proto rules.");
    rmSync(repo, { recursive: true, force: true });
    const offline = await fetchSource({ name: "team", repo: "constructor", ref: commit }, cache);
    if ("error" in offline) throw new Error(offline.error);
    expect([offline.packs[0]?.manifest.summary, offline.stale]).toEqual(["Proto rules.", undefined]);
  });

  test("does not share pin history across effective SSH URLs that differ only by SSH username", async () => {
    const repoA = await packRepo("Account A.");
    const commitA = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Account B.");
    const commitB = await spawnGit(repoB, "rev-parse", "HEAD");
    const bin = temp.make("fake-ssh-");
    writeFileSync(
      join(bin, "ssh"),
      `#!/bin/sh
dest=""
host=""
cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-l) shift 2 ;;
    -*) shift ;;
    *)
      if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
      shift
      ;;
  esac
done
case "$host" in
  alice@example.invalid) dest=${JSON.stringify(repoA)} ;;
  bob@example.invalid) dest=${JSON.stringify(repoB)} ;;
  *) echo "unexpected host: $host" >&2; exit 1 ;;
esac
case "$cmd" in
  *"git-upload-pack"*"/repo.git"*) exec git-upload-pack "$dest" ;;
  *) echo "unexpected command: $cmd" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const cache = temp.make("cache-");
    const alice = "ssh://alice@example.invalid/repo.git";
    const bob = "ssh://bob@example.invalid/repo.git";
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    try {
      const first = await fetchSource({ name: "team", repo: alice, ref: commitA }, cache);
      if ("error" in first) throw new Error(first.error);
      expect(first.packs[0]?.manifest.summary).toBe("Account A.");
      const second = await fetchSource({ name: "team", repo: bob, ref: commitB }, cache);
      if ("error" in second) throw new Error(second.error);
      expect(second.packs[0]?.manifest.summary).toBe("Account B.");
      const cross = await fetchSource({ name: "team", repo: bob, ref: commitA }, cache);
      if ("error" in cross) throw new Error(cross.error);
      expect(cross.packs[0]?.manifest.summary).toBe("Account B.");
      expect(cross.stale).toContain(`could not fetch ${commitA}`);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  test("keeps verified pin history across an older binary write", async () => {
    const repo = await packRepo("Team rules v1.");
    const first = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const second = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v3.");
    await spawnGit(repo, "commit", "-q", "-am", "v3");
    const third = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: first }, cache);
    await fetchSource({ name: "team", repo, ref: second }, cache);
    await legacyPinnedCache(cache, "team", repo, third);
    rmSync(repo, { recursive: true, force: true });
    const back = await fetchSource({ name: "team", repo, ref: first }, cache);
    if ("error" in back) throw new Error(back.error);
    expect([back.packs[0]?.manifest.summary, back.stale]).toEqual(["Team rules v1.", undefined]);
  });

  test("keeps distinct pin namespaces for local repositories whose paths differ only by a trailing space", async () => {
    const parent = temp.make("spaces-");
    const repoA = join(parent, "repo ");
    const repoB = join(parent, "repo");
    for (const [dir, summary] of [[repoA, "Trailing space repo."], [repoB, "Plain repo."]] as const) {
      mkdirSync(dir, { recursive: true });
      await spawnGit(dir, "init", "-q", "-b", "main");
      writePack(dir, summary);
      await spawnGit(dir, "add", ".");
      await spawnGit(dir, "commit", "-q", "-m", "v1");
    }
    const shaA = await spawnGit(repoA, "rev-parse", "HEAD");
    const shaB = await spawnGit(repoB, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    const first = await fetchSource({ name: "team", repo: repoA, ref: shaA }, cache);
    if ("error" in first) throw new Error(first.error);
    expect(first.packs[0]?.manifest.summary).toBe("Trailing space repo.");
    const second = await fetchSource({ name: "team", repo: repoB, ref: shaB }, cache);
    if ("error" in second) throw new Error(second.error);
    expect(second.packs[0]?.manifest.summary).toBe("Plain repo.");
    const cross = await fetchSource({ name: "team", repo: repoB, ref: shaA }, cache);
    if ("error" in cross) throw new Error(cross.error);
    expect(cross.packs[0]?.manifest.summary).toBe("Plain repo.");
    expect(cross.stale).toContain(`could not fetch ${shaA}`);
  });

  test("keeps a legacy insteadOf-fetched pinned cache working offline after upgrade (including .git mirrors), while rejecting a changed rewrite", async () => {
    const parent = temp.make("legacy-mirror-");
    const repoA = join(parent, "mirror-a.git");
    mkdirSync(repoA, { recursive: true });
    await spawnGit(repoA, "init", "-q", "-b", "main");
    writePack(repoA, "Legacy mirror A.");
    await spawnGit(repoA, "add", ".");
    await spawnGit(repoA, "commit", "-q", "-m", "v1");
    const shaA = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Legacy mirror B.");
    const configured = "https://example.invalid/team-legacy.git";
    const cache = temp.make("cache-");
    const dir = join(cache, "team");
    mkdirSync(dir, { recursive: true });
    await spawnGit(dir, "init", "-q");
    await spawnGit(dir, "config", `url.${repoA}.insteadOf`, configured);
    await spawnGit(dir, "fetch", "-q", "--depth", "1", "--no-tags", configured, shaA);
    await spawnGit(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(dir, ".git", "hedge-source.json"), JSON.stringify({ repo: configured, ref: shaA, commit: shaA }) + "\n");
    rmSync(repoA, { recursive: true, force: true });

    const offline = await fetchSource({ name: "team", repo: configured, ref: shaA }, cache);
    if ("error" in offline) throw new Error(offline.error);
    expect(offline.packs[0]?.manifest.summary).toBe("Legacy mirror A.");

    const offlineAgain = await fetchSource({ name: "team", repo: configured, ref: shaA }, cache);
    if ("error" in offlineAgain) throw new Error(offlineAgain.error);
    expect(offlineAgain.packs[0]?.manifest.summary).toBe("Legacy mirror A.");

    await spawnGit(dir, "config", "--unset", `url.${repoA}.insteadOf`);
    await spawnGit(dir, "config", `url.${repoB}.insteadOf`, configured);
    rmSync(repoB, { recursive: true, force: true });
    const swapped = await fetchSource({ name: "team", repo: configured, ref: shaA }, cache);
    expect("error" in swapped).toBe(true);
    const swappedAgain = await fetchSource({ name: "team", repo: configured, ref: shaA }, cache);
    expect("error" in swappedAgain).toBe(true);

    const directRepo = await packRepo("Direct repo.");
    const directSha = await spawnGit(directRepo, "rev-parse", "HEAD");
    const emptyFhCache = temp.make("cache-empty-fh-");
    const emptyFhDir = join(emptyFhCache, "team");
    mkdirSync(emptyFhDir, { recursive: true });
    await spawnGit(emptyFhDir, "init", "-q");
    const mirrorRepo = await packRepo("Mirror only.");
    const mirrorSha = await spawnGit(mirrorRepo, "rev-parse", "HEAD");
    await spawnGit(emptyFhDir, "config", `url.${mirrorRepo}.insteadOf`, directRepo);
    await spawnGit(emptyFhDir, "fetch", "-q", "--depth", "1", "--no-tags", directRepo, mirrorSha);
    await spawnGit(emptyFhDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(emptyFhDir, ".git", "hedge-source.json"), JSON.stringify({ repo: directRepo, ref: mirrorSha, commit: mirrorSha }) + "\n");
    writeFileSync(join(emptyFhDir, ".git", "FETCH_HEAD"), "");
    await spawnGit(emptyFhDir, "config", "--unset", `url.${mirrorRepo}.insteadOf`);
    expect("error" in (await fetchSource({ name: "team", repo: directRepo, ref: directSha }, emptyFhCache))).toBe(false);
    rmSync(directRepo, { recursive: true, force: true });
    const poisoned = await fetchSource({ name: "team", repo: directRepo, ref: mirrorSha }, emptyFhCache);
    expect("error" in poisoned || poisoned.stale !== undefined).toBe(true);
    if (!("error" in poisoned)) expect(poisoned.packs[0]?.manifest.summary).toBe("Direct repo.");
  });

  test("falls back to the last-good commit offline after an interrupted apply left detached HEAD at FETCH_HEAD", async () => {
    const repo = await packRepo("Good v1.");
    const v1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    const initial = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    if ("error" in initial) throw new Error(initial.error);
    expect(initial.packs[0]?.manifest.summary).toBe("Good v1.");

    writePack(repo, "Interrupted v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const dir = join(cache, "team");
    await spawnGit(dir, "fetch", "-q", "--depth", "1", "--no-tags", repo, "main");
    await spawnGit(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
    rmSync(repo, { recursive: true, force: true });

    const recovered = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    if ("error" in recovered) throw new Error(recovered.error);
    expect(recovered.packs[0]?.manifest.summary).toBe("Good v1.");
    expect(recovered.stale).toContain("could not fetch main");
    expect(await spawnGit(dir, "rev-parse", "HEAD")).toBe(v1);
  });

  async function initPackRepo(dir: string, summary: string) {
    mkdirSync(dir, { recursive: true });
    await spawnGit(dir, "init", "-q", "-b", "main");
    writePack(dir, summary);
    await spawnGit(dir, "add", ".");
    await spawnGit(dir, "commit", "-q", "-m", "v1");
    return await spawnGit(dir, "rev-parse", "HEAD");
  }

  test("keeps distinct pin namespaces across sibling packs and packs.git directories", async () => {
    const parent = temp.make("dotgit-");
    const packsDir = join(parent, "packs");
    const packsGitDir = join(parent, "packs.git");
    const thirdDir = join(parent, "third");
    const shaA = await initPackRepo(packsDir, "Plain packs.");
    const shaB = await initPackRepo(packsGitDir, "Dotgit packs.");
    const shaC = await initPackRepo(thirdDir, "Third packs.");
    const cache = temp.make("cache-dotgit-");
    expect("error" in (await fetchSource({ name: "team", repo: packsDir, ref: shaA }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: packsGitDir, ref: shaB }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: thirdDir, ref: shaC }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: packsGitDir, ref: shaA }, cache))).toBe(true);
  });

  test("keeps distinct pin namespaces when repository paths differ by a trailing carriage return or leading UTF-8 BOM", async () => {
    const parent = temp.make("cr-");
    const crDir = join(parent, "repo\r");
    const plainCrDir = join(parent, "repo");
    const shaCr = await initPackRepo(crDir, "CR repo.");
    const shaPlain = await initPackRepo(plainCrDir, "No CR repo.");
    const crCache = temp.make("cache-cr-");
    expect("error" in (await fetchSource({ name: "team", repo: crDir, ref: shaCr }, crCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: plainCrDir, ref: shaPlain }, crCache))).toBe(false);
    const crossCr = await fetchSource({ name: "team", repo: plainCrDir, ref: shaCr }, crCache);
    if ("error" in crossCr) throw new Error(crossCr.error);
    expect(crossCr.packs[0]?.manifest.summary).toBe("No CR repo.");
    expect(crossCr.stale).toContain(`could not fetch ${shaCr}`);

    const bomCache = temp.make("cache-bom-");
    const bomRepo = join(bomCache, "team", "\ufeffrepo");
    const plainBomRepo = join(bomCache, "team", "repo");
    const bomSha = await initPackRepo(bomRepo, "BOM repo.");
    const plainBomSha = await initPackRepo(plainBomRepo, "Plain BOM sibling.");
    expect("error" in (await fetchSource({ name: "team", repo: "\ufeffrepo", ref: bomSha }, bomCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: "repo", ref: plainBomSha }, bomCache))).toBe(false);
    rmSync(plainBomRepo, { recursive: true, force: true });
    const bomCross = await fetchSource({ name: "team", repo: "repo", ref: bomSha }, bomCache);
    if ("error" in bomCross) throw new Error(bomCross.error);
    expect(bomCross.packs[0]?.manifest.summary).toBe("Plain BOM sibling.");
    expect(bomCross.stale).toContain(`could not fetch ${bomSha}`);
  });

  test("repairs null-commit metadata on the next online fetch", async () => {
    const repairRepo = await packRepo("Repairable.");
    const repairCache = temp.make("cache-null-commit-");
    expect("error" in (await fetchSource({ name: "team", repo: repairRepo, ref: "main" }, repairCache))).toBe(false);
    writeFileSync(join(repairCache, "team", ".git", "hedge-source.json"), JSON.stringify({ repo: repairRepo, ref: "main", commit: null }) + "\n");
    const repaired = await fetchSource({ name: "team", repo: repairRepo, ref: "main" }, repairCache);
    if ("error" in repaired) throw new Error(repaired.error);
    expect(repaired.packs[0]?.manifest.summary).toBe("Repairable.");
  });

  test("falls back offline for paths containing ' of ', apostrophe branches, newline paths, and HEAD mirrors", async () => {
    const parent = temp.make("fh-edge-");
    const ofDir = join(parent, "end of path");
    await initPackRepo(ofDir, "Of path repo.");
    const ofCache = temp.make("cache-of-");
    expect("error" in (await fetchSource({ name: "team", repo: ofDir, ref: "main" }, ofCache))).toBe(false);
    rmSync(ofDir, { recursive: true, force: true });
    const ofFallback = await fetchSource({ name: "team", repo: ofDir, ref: "main" }, ofCache);
    if ("error" in ofFallback) throw new Error(ofFallback.error);
    expect(ofFallback.packs[0]?.manifest.summary).toBe("Of path repo.");
    expect(ofFallback.stale).toContain("could not fetch main");

    const apostropheRepo = await packRepo("Apostrophe branch packs.");
    await spawnGit(apostropheRepo, "checkout", "-q", "-b", "release/o'hare");
    const apostropheSha = await spawnGit(apostropheRepo, "rev-parse", "HEAD");
    const apostropheCache = temp.make("cache-apostrophe-");
    const apostropheDir = join(apostropheCache, "team");
    mkdirSync(apostropheDir, { recursive: true });
    await spawnGit(apostropheDir, "init", "-q");
    await spawnGit(apostropheDir, "fetch", "-q", "--depth", "1", "--no-tags", apostropheRepo, "release/o'hare");
    await spawnGit(apostropheDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(apostropheDir, ".git", "hedge-source.json"), JSON.stringify({ repo: apostropheRepo, ref: "release/o'hare", commit: apostropheSha }) + "\n");
    rmSync(apostropheRepo, { recursive: true, force: true });
    const apostropheOffline = await fetchSource({ name: "team", repo: apostropheRepo, ref: "release/o'hare" }, apostropheCache);
    if ("error" in apostropheOffline) throw new Error(apostropheOffline.error);
    expect(apostropheOffline.packs[0]?.manifest.summary).toBe("Apostrophe branch packs.");
    expect(apostropheOffline.stale).toContain("could not fetch release/o'hare");

    const newlineRepo = join(parent, "dir\nwith-newline", "repo");
    const newlineSha = await initPackRepo(newlineRepo, "Newline path packs.");
    const newlineCache = temp.make("cache-newline-");
    const newlineDir = join(newlineCache, "team");
    mkdirSync(newlineDir, { recursive: true });
    await spawnGit(newlineDir, "init", "-q");
    await spawnGit(newlineDir, "fetch", "-q", "--depth", "1", "--no-tags", newlineRepo, "main");
    await spawnGit(newlineDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(newlineDir, ".git", "hedge-source.json"), JSON.stringify({ repo: newlineRepo, ref: "main", commit: newlineSha }) + "\n");
    rmSync(join(parent, "dir\nwith-newline"), { recursive: true, force: true });
    const newlineOffline = await fetchSource({ name: "team", repo: newlineRepo, ref: "main" }, newlineCache);
    if ("error" in newlineOffline) throw new Error(newlineOffline.error);
    expect(newlineOffline.packs[0]?.manifest.summary).toBe("Newline path packs.");
    expect(newlineOffline.stale).toContain("could not fetch main");

    const headMirror = await packRepo("HEAD mirror packs.");
    const headSha = await spawnGit(headMirror, "rev-parse", "HEAD");
    const headConfigured = "https://example.invalid/head-mirror.git";
    const headCache = temp.make("cache-head-legacy-");
    const headDir = join(headCache, "team");
    mkdirSync(headDir, { recursive: true });
    await spawnGit(headDir, "init", "-q");
    await spawnGit(headDir, "config", `url.${headMirror}.insteadOf`, headConfigured);
    await spawnGit(headDir, "fetch", "-q", "--depth", "1", "--no-tags", headConfigured, "HEAD");
    await spawnGit(headDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(headDir, ".git", "hedge-source.json"), JSON.stringify({ repo: headConfigured, ref: "HEAD", commit: headSha }) + "\n");
    rmSync(headMirror, { recursive: true, force: true });
    const headOffline = await fetchSource({ name: "team", repo: headConfigured, ref: "HEAD" }, headCache);
    if ("error" in headOffline) throw new Error(headOffline.error);
    expect(headOffline.packs[0]?.manifest.summary).toBe("HEAD mirror packs.");
    expect(headOffline.stale).toContain("could not fetch HEAD");
  });

  test("never migrates ambiguous legacy insteadOf caches across .git siblings or SSH usernames", async () => {
    const parent = temp.make("legacy-ambig-");
    const migPacks = join(parent, "mig-packs");
    const migPacksGit = join(parent, "mig-packs.git");
    const migShaA = await initPackRepo(migPacks, "Legacy target A.");
    const migShaB = await initPackRepo(migPacksGit, "Target B.");
    const migConfigured = "https://example.invalid/mig-team.git";
    const migCache = temp.make("cache-mig-dotgit-");
    const migDir = join(migCache, "team");
    mkdirSync(migDir, { recursive: true });
    await spawnGit(migDir, "init", "-q");
    await spawnGit(migDir, "config", `url.${migPacks}.insteadOf`, migConfigured);
    await spawnGit(migDir, "fetch", "-q", "--depth", "1", "--no-tags", migConfigured, migShaA);
    await spawnGit(migDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(migDir, ".git", "hedge-source.json"), JSON.stringify({ repo: migConfigured, ref: migShaA, commit: migShaA }) + "\n");
    await spawnGit(migDir, "config", "--unset", `url.${migPacks}.insteadOf`);
    await spawnGit(migDir, "config", `url.${migPacksGit}.insteadOf`, migConfigured);
    expect("error" in (await fetchSource({ name: "team", repo: migConfigured, ref: migShaB }, migCache))).toBe(false);
    rmSync(migPacksGit, { recursive: true, force: true });
    expect("error" in (await fetchSource({ name: "team", repo: migPacksGit, ref: migShaA }, migCache))).toBe(true);

    const dotgitSrc = join(parent, "swap-packs.git");
    const plainDst = join(parent, "swap-packs");
    const dotgitSha = await initPackRepo(dotgitSrc, "Legacy dotgit.");
    const plainSha = await initPackRepo(plainDst, "Sibling plain.");
    const swapConfigured = "https://example.invalid/dotgit-swap.git";
    const swapCache = temp.make("cache-dotgit-swap-");
    const swapDir = join(swapCache, "team");
    mkdirSync(swapDir, { recursive: true });
    await spawnGit(swapDir, "init", "-q");
    await spawnGit(swapDir, "config", `url.${dotgitSrc}.insteadOf`, swapConfigured);
    await spawnGit(swapDir, "fetch", "-q", "--depth", "1", "--no-tags", swapConfigured, dotgitSha);
    await spawnGit(swapDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(swapDir, ".git", "hedge-source.json"), JSON.stringify({ repo: swapConfigured, ref: dotgitSha, commit: dotgitSha }) + "\n");
    rmSync(dotgitSrc, { recursive: true, force: true });
    await spawnGit(swapDir, "config", "--unset", `url.${dotgitSrc}.insteadOf`);
    await spawnGit(swapDir, "config", `url.${plainDst}.insteadOf`, swapConfigured);
    const swapHit = await fetchSource({ name: "team", repo: swapConfigured, ref: dotgitSha }, swapCache);
    expect("error" in swapHit || swapHit.stale !== undefined).toBe(true);
    expect("error" in (await fetchSource({ name: "team", repo: swapConfigured, ref: plainSha }, swapCache))).toBe(false);
    rmSync(plainDst, { recursive: true, force: true });
    const swapPoison = await fetchSource({ name: "team", repo: swapConfigured, ref: dotgitSha }, swapCache);
    if ("error" in swapPoison) throw new Error(swapPoison.error);
    expect(swapPoison.packs[0]?.manifest.summary).toBe("Sibling plain.");
    expect(swapPoison.stale).toContain(`could not fetch ${dotgitSha}`);

    const unsetDotgit = join(parent, "unset-packs.git");
    const unsetPlain = join(parent, "unset-packs");
    const unsetMirrorSha = await initPackRepo(unsetDotgit, "Unset mirror.");
    const unsetRealSha = await initPackRepo(unsetPlain, "Unset real.");
    const unsetCache = temp.make("cache-unset-dotgit-");
    const unsetDir = join(unsetCache, "team");
    mkdirSync(unsetDir, { recursive: true });
    await spawnGit(unsetDir, "init", "-q");
    await spawnGit(unsetDir, "config", `url.${unsetDotgit}.insteadOf`, unsetPlain);
    await spawnGit(unsetDir, "fetch", "-q", "--depth", "1", "--no-tags", unsetPlain, unsetMirrorSha);
    await spawnGit(unsetDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(unsetDir, ".git", "hedge-source.json"), JSON.stringify({ repo: unsetPlain, ref: unsetMirrorSha, commit: unsetMirrorSha }) + "\n");
    rmSync(unsetDotgit, { recursive: true, force: true });
    await spawnGit(unsetDir, "config", "--unset", `url.${unsetDotgit}.insteadOf`);
    expect("error" in (await fetchSource({ name: "team", repo: unsetPlain, ref: unsetRealSha }, unsetCache))).toBe(false);
    await spawnGit(unsetDir, "reflog", "expire", "--expire=now", "--all");
    await spawnGit(unsetDir, "gc", "--prune=now", "-q");
    rmSync(unsetPlain, { recursive: true, force: true });
    const unsetBack = await fetchSource({ name: "team", repo: unsetPlain, ref: unsetMirrorSha }, unsetCache);
    if ("error" in unsetBack) throw new Error(unsetBack.error);
    expect(unsetBack.packs[0]?.manifest.summary).toBe("Unset real.");
    expect(unsetBack.stale).toContain(`could not fetch ${unsetMirrorSha}`);

    const sshA = await packRepo("SSH legacy A.");
    const sshShaA = await spawnGit(sshA, "rev-parse", "HEAD");
    const sshB = await packRepo("SSH legacy B.");
    const sshShaB = await spawnGit(sshB, "rev-parse", "HEAD");
    const sshBin = temp.make("legacy-ssh-bin-");
    writeFileSync(
      join(sshBin, "ssh"),
      `#!/bin/sh
dest=""
host=""
cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-l) shift 2 ;;
    -*) shift ;;
    *)
      if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
      shift
      ;;
  esac
done
case "$host" in
  alice@example.invalid) dest=${JSON.stringify(sshA)} ;;
  bob@example.invalid) dest=${JSON.stringify(sshB)} ;;
  *) echo "unexpected host: $host" >&2; exit 1 ;;
esac
case "$cmd" in
  *"git-upload-pack"*"/repo.git"*) exec git-upload-pack "$dest" ;;
  *) echo "unexpected command: $cmd" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const sshCache = temp.make("cache-legacy-ssh-");
    const sshDir = join(sshCache, "team");
    const sshConfigured = "https://example.invalid/ssh-legacy.git";
    const sshAlice = "ssh://alice@example.invalid/repo.git";
    const sshBob = "ssh://bob@example.invalid/repo.git";
    mkdirSync(sshDir, { recursive: true });
    await spawnGit(sshDir, "init", "-q");
    await spawnGit(sshDir, "config", `url.${sshAlice}.insteadOf`, sshConfigured);
    const savedPath = process.env.PATH;
    process.env.PATH = `${sshBin}:${savedPath ?? ""}`;
    try {
      expect(Bun.spawnSync(["git", "-C", sshDir, "fetch", "-q", "--depth", "1", "--no-tags", sshConfigured, sshShaA], { env: { ...process.env, GIT_SSH_COMMAND: `${join(sshBin, "ssh")}` } }).exitCode).toBe(0);
      await spawnGit(sshDir, "checkout", "-q", "--detach", "FETCH_HEAD");
      writeFileSync(join(sshDir, ".git", "hedge-source.json"), JSON.stringify({ repo: sshConfigured, ref: sshShaA, commit: sshShaA }) + "\n");
      await spawnGit(sshDir, "config", "--unset", `url.${sshAlice}.insteadOf`);
      await spawnGit(sshDir, "config", `url.${sshBob}.insteadOf`, sshConfigured);
      expect("error" in (await fetchSource({ name: "team", repo: sshConfigured, ref: sshShaB }, sshCache))).toBe(false);
      expect("error" in (await fetchSource({ name: "team", repo: sshBob, ref: sshShaA }, sshCache))).toBe(true);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  test("handles SHA-256 repositories and hexadecimal branch names on SHA-1 repositories", async () => {
    const parent = temp.make("objfmt-");
    const sha256Repo = join(parent, "sha256-repo");
    mkdirSync(sha256Repo, { recursive: true });
    await spawnGit(sha256Repo, "init", "-q", "--object-format=sha256", "-b", "main");
    writePack(sha256Repo, "SHA-256 branch packs.");
    await spawnGit(sha256Repo, "add", ".");
    await spawnGit(sha256Repo, "commit", "-q", "-m", "v1");
    const sha256Cache = temp.make("cache-sha256-");
    const sha256Dir = join(sha256Cache, "team");
    mkdirSync(sha256Dir, { recursive: true });
    await spawnGit(sha256Dir, "init", "-q", "--object-format=sha256");
    const sha256Online = await fetchSource({ name: "team", repo: sha256Repo, ref: "main" }, sha256Cache);
    if ("error" in sha256Online) throw new Error(sha256Online.error);
    expect(sha256Online.packs[0]?.manifest.summary).toBe("SHA-256 branch packs.");
    rmSync(sha256Repo, { recursive: true, force: true });
    const sha256Offline = await fetchSource({ name: "team", repo: sha256Repo, ref: "main" }, sha256Cache);
    if ("error" in sha256Offline) throw new Error(sha256Offline.error);
    expect(sha256Offline.packs[0]?.manifest.summary).toBe("SHA-256 branch packs.");
    expect(sha256Offline.stale).toContain("could not fetch main");

    const hex64Branch = "a".repeat(64);
    const sha1HexRepo = join(parent, "sha1-hex64-branch");
    mkdirSync(sha1HexRepo, { recursive: true });
    await spawnGit(sha1HexRepo, "init", "-q", "-b", hex64Branch);
    writePack(sha1HexRepo, "Hex-64 branch packs.");
    await spawnGit(sha1HexRepo, "add", ".");
    await spawnGit(sha1HexRepo, "commit", "-q", "-m", "v1");
    const hexCache = temp.make("cache-hex64-");
    const hexOnline = await fetchSource({ name: "team", repo: sha1HexRepo, ref: hex64Branch }, hexCache);
    if ("error" in hexOnline) throw new Error(hexOnline.error);
    expect(hexOnline.packs[0]?.manifest.summary).toBe("Hex-64 branch packs.");
    expect(await followsBranch({ name: "team", repo: sha1HexRepo, ref: hex64Branch }, hexCache)).toBe(true);
    rmSync(sha1HexRepo, { recursive: true, force: true });
    const hexOffline = await fetchSource({ name: "team", repo: sha1HexRepo, ref: hex64Branch }, hexCache);
    if ("error" in hexOffline) throw new Error(hexOffline.error);
    expect(hexOffline.packs[0]?.manifest.summary).toBe("Hex-64 branch packs.");
    expect(hexOffline.stale).toContain(`could not fetch ${hex64Branch}`);

    const hex40Branch = "b".repeat(40);
    const hex40Repo = join(parent, "sha1-hex40-branch");
    mkdirSync(hex40Repo, { recursive: true });
    await spawnGit(hex40Repo, "init", "-q", "-b", hex40Branch);
    writePack(hex40Repo, "Hex-40 branch packs.");
    await spawnGit(hex40Repo, "add", ".");
    await spawnGit(hex40Repo, "commit", "-q", "-m", "v1");
    const hex40Tip = await spawnGit(hex40Repo, "rev-parse", "HEAD");
    const hex40Cache = temp.make("cache-hex40-");
    const hex40Online = await fetchSource({ name: "team", repo: hex40Repo, ref: `refs/heads/${hex40Branch}` }, hex40Cache);
    if ("error" in hex40Online) throw new Error(hex40Online.error);
    expect(await followsBranch({ name: "team", repo: hex40Repo, ref: hex40Branch }, hex40Cache)).toBe(true);
    expect(await followsBranch({ name: "team", repo: hex40Repo, ref: `refs/heads/${hex40Branch}` }, hex40Cache)).toBe(true);

    const legacyHex40Cache = temp.make("cache-legacy-hex40-");
    const legacyHex40Dir = join(legacyHex40Cache, "team");
    mkdirSync(legacyHex40Dir, { recursive: true });
    await spawnGit(legacyHex40Dir, "init", "-q");
    await spawnGit(legacyHex40Dir, "fetch", "-q", "--depth", "1", "--no-tags", hex40Repo, `refs/heads/${hex40Branch}`);
    await spawnGit(legacyHex40Dir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(legacyHex40Dir, ".git", "hedge-source.json"), JSON.stringify({ repo: hex40Repo, ref: hex40Branch, commit: hex40Tip }) + "\n");
    rmSync(hex40Repo, { recursive: true, force: true });
    const legacyHex40Offline = await fetchSource({ name: "team", repo: hex40Repo, ref: hex40Branch }, legacyHex40Cache);
    if ("error" in legacyHex40Offline) throw new Error(legacyHex40Offline.error);
    expect(legacyHex40Offline.packs[0]?.manifest.summary).toBe("Hex-40 branch packs.");
    expect(legacyHex40Offline.stale).toContain(`could not fetch ${hex40Branch}`);
  });

  test("updates remote tracking refs when fetching or advancing a named Git remote", async () => {
    const remoteSrc = await packRepo("Named remote v1.");
    const remoteCommit1 = await spawnGit(remoteSrc, "rev-parse", "HEAD");
    const remoteCache = temp.make("cache-named-remote-");
    const remoteDir = join(remoteCache, "team");
    mkdirSync(remoteDir, { recursive: true });
    await spawnGit(remoteDir, "init", "-q");
    await spawnGit(remoteDir, "remote", "add", "origin", remoteSrc);
    const remoteFetched = await fetchSource({ name: "team", repo: "origin", ref: "main" }, remoteCache);
    if ("error" in remoteFetched) throw new Error(remoteFetched.error);
    expect(await spawnGit(remoteDir, "rev-parse", "refs/remotes/origin/main")).toBe(remoteCommit1);
    writePack(remoteSrc, "Named remote v2.");
    await spawnGit(remoteSrc, "commit", "-q", "-am", "v2");
    const remoteCommit2 = await spawnGit(remoteSrc, "rev-parse", "HEAD");
    const remoteAdvanced = await advanceSource({ name: "team", repo: "origin", ref: "main" }, remoteCache, remoteCommit1);
    expect(remoteAdvanced).toMatchObject({ state: "moved", commit: remoteCommit2 });
    expect(await spawnGit(remoteDir, "rev-parse", "refs/remotes/origin/main")).toBe(remoteCommit2);
  });

  test("preserves FETCH_HEAD contents and permissions on failed fetches, rollbacks, and unreadable files", async () => {
    const emptyLegacyRepo = await packRepo("Empty FETCH_HEAD legacy.");
    const emptyLegacySha = await spawnGit(emptyLegacyRepo, "rev-parse", "HEAD");
    const emptyLegacyCache = temp.make("cache-empty-legacy-");
    const emptyLegacyDir = await legacyPinnedCache(emptyLegacyCache, "team", emptyLegacyRepo, emptyLegacySha);
    writeFileSync(join(emptyLegacyDir, ".git", "FETCH_HEAD"), "");
    rmSync(emptyLegacyRepo, { recursive: true, force: true });
    const emptyLegacyOffline = await fetchSource({ name: "team", repo: emptyLegacyRepo, ref: emptyLegacySha }, emptyLegacyCache);
    if ("error" in emptyLegacyOffline) throw new Error(emptyLegacyOffline.error);
    expect(emptyLegacyOffline.packs[0]?.manifest.summary).toBe("Empty FETCH_HEAD legacy.");
    expect(emptyLegacyOffline.stale).toContain(`could not fetch ${emptyLegacySha}`);

    const fhRepo = await packRepo("Branch v1.");
    writePack(fhRepo, "Branch v2.");
    await spawnGit(fhRepo, "commit", "-q", "-am", "v2");
    const fhPin = await spawnGit(fhRepo, "rev-parse", "HEAD");
    await spawnGit(fhRepo, "reset", "-q", "--hard", "HEAD~1");
    const fhCache = temp.make("cache-restore-fh-");
    const fhInitial = await fetchSource({ name: "team", repo: fhRepo, ref: "main" }, fhCache);
    if ("error" in fhInitial) throw new Error(fhInitial.error);
    expect(await followsBranch({ name: "team", repo: fhRepo, ref: "main" }, fhCache)).toBe(true);
    const fhRefs = join(fhCache, "team", ".git", "refs");
    setDirModes(fhRefs, 0o555);
    try {
      const fhFailed = await fetchSource({ name: "team", repo: fhRepo, ref: fhPin }, fhCache);
      if ("error" in fhFailed) throw new Error(fhFailed.error);
      expect(fhFailed.stale).toContain(`could not record ${fhPin}`);
    } finally {
      setDirModes(fhRefs, 0o755);
    }
    expect(await followsBranch({ name: "team", repo: fhRepo, ref: "main" }, fhCache)).toBe(true);

    const roRepo = await packRepo("Read-only FH.");
    const roCache = temp.make("cache-ro-fh-");
    expect("error" in (await fetchSource({ name: "team", repo: roRepo, ref: "main" }, roCache))).toBe(false);
    const roFh = join(roCache, "team", ".git", "FETCH_HEAD");
    chmodSync(roFh, 0o400);
    try {
      const roFailed = await fetchSource({ name: "team", repo: roRepo, ref: "main" }, roCache);
      if ("error" in roFailed) throw new Error(roFailed.error);
      expect(roFailed.stale).toContain("could not fetch main");
      expect(statSync(roFh).mode & 0o777).toBe(0o400);
    } finally {
      chmodSync(roFh, 0o600);
    }

    const unreadableRepo = await packRepo("Unreadable FH.");
    const unreadableCache = temp.make("cache-unreadable-fh-");
    expect("error" in (await fetchSource({ name: "team", repo: unreadableRepo, ref: "main" }, unreadableCache))).toBe(false);
    rmSync(unreadableRepo, { recursive: true, force: true });
    const unreadableFh = join(unreadableCache, "team", ".git", "FETCH_HEAD");
    chmodSync(unreadableFh, 0o000);
    try {
      const failed = await fetchSource({ name: "team", repo: unreadableRepo, ref: "main" }, unreadableCache);
      if ("error" in failed) throw new Error(failed.error);
      expect(failed.stale).toContain("could not fetch main");
      expect(existsSync(unreadableFh)).toBe(true);
    } finally {
      chmodSync(unreadableFh, 0o600);
    }
    expect(await followsBranch({ name: "team", repo: unreadableRepo, ref: "main" }, unreadableCache)).toBe(true);
  });

  test("tracks branch identity across respellings, commit-named branches, tag-to-branch transitions, and rejected replacement tags", async () => {
    const spellRepo = await packRepo("Main good.");
    await spawnGit(spellRepo, "checkout", "-q", "-b", "release");
    writeFileSync(join(spellRepo, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken release." }));
    await spawnGit(spellRepo, "commit", "-q", "-am", "broken release");
    const spellCache = temp.make("cache-branch-spell-");
    expect("error" in (await fetchSource({ name: "team", repo: spellRepo, ref: "main" }, spellCache))).toBe(false);
    const brokenRelease = await fetchSource({ name: "team", repo: spellRepo, ref: "release" }, spellCache);
    if ("error" in brokenRelease) throw new Error(brokenRelease.error);
    expect(brokenRelease.stale).toContain("does not load");
    rmSync(spellRepo, { recursive: true, force: true });
    const offlineRespell = await fetchSource({ name: "team", repo: spellRepo, ref: "refs/heads/release" }, spellCache);
    if ("error" in offlineRespell) throw new Error(offlineRespell.error);
    expect(offlineRespell.stale).toContain("could not fetch refs/heads/release");
    expect(await followsBranch({ name: "team", repo: spellRepo, ref: "release" }, spellCache)).toBe(true);
    expect(await followsBranch({ name: "team", repo: spellRepo, ref: "refs/heads/release" }, spellCache)).toBe(true);

    const tipBranchRepo = await packRepo("Tip-named branch v1.");
    const tipSha = await spawnGit(tipBranchRepo, "rev-parse", "HEAD");
    await spawnGit(tipBranchRepo, "checkout", "-q", "-b", tipSha);
    const tipCache = temp.make("cache-tip-pin-");
    expect("error" in (await fetchSource({ name: "team", repo: tipBranchRepo, ref: `refs/heads/${tipSha}` }, tipCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: tipBranchRepo, ref: `refs/heads/${tipSha}` }, tipCache)).toBe(true);
    expect("error" in (await fetchSource({ name: "team", repo: tipBranchRepo, ref: tipSha }, tipCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: tipBranchRepo, ref: tipSha }, tipCache)).toBe(false);

    const tagToBranchRepo = await packRepo("Tag v1 good.");
    const tagCache = temp.make("cache-tag-to-branch-");
    expect("error" in (await fetchSource({ name: "team", repo: tagToBranchRepo, ref: "v1" }, tagCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: tagToBranchRepo, ref: "v1" }, tagCache)).toBe(false);
    await spawnGit(tagToBranchRepo, "tag", "-d", "v1");
    await spawnGit(tagToBranchRepo, "checkout", "-q", "-b", "v1");
    writeFileSync(join(tagToBranchRepo, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken v1 branch." }));
    await spawnGit(tagToBranchRepo, "commit", "-q", "-am", "broken branch v1");
    const tagBroken = await fetchSource({ name: "team", repo: tagToBranchRepo, ref: "v1" }, tagCache);
    if ("error" in tagBroken) throw new Error(tagBroken.error);
    expect(tagBroken.stale).toContain("does not load");
    expect(await followsBranch({ name: "team", repo: tagToBranchRepo, ref: "v1" }, tagCache)).toBe(true);

    const branchRepoA = await packRepo("Repo A branch v1.");
    await spawnGit(branchRepoA, "tag", "-d", "v1");
    await spawnGit(branchRepoA, "checkout", "-q", "-b", "v1");
    const tagRepoB = await packRepo("Repo B broken tag v1.");
    await spawnGit(tagRepoB, "tag", "-d", "v1");
    writeFileSync(join(tagRepoB, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken tag v1." }));
    await spawnGit(tagRepoB, "commit", "-q", "-am", "broken v1");
    await spawnGit(tagRepoB, "tag", "v1");
    await spawnGit(tagRepoB, "checkout", "-q", "-b", "v1");
    writePack(tagRepoB, "Repo B branch v1.");
    await spawnGit(tagRepoB, "commit", "-q", "-am", "branch v1");
    const repoSwitchCache = temp.make("cache-branch-repo-switch-");
    expect("error" in (await fetchSource({ name: "team", repo: branchRepoA, ref: "v1" }, repoSwitchCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: branchRepoA, ref: "v1" }, repoSwitchCache)).toBe(true);
    expect("error" in (await fetchSource({ name: "team", repo: tagRepoB, ref: "v1" }, repoSwitchCache))).toBe(true);
    expect(await followsBranch({ name: "team", repo: tagRepoB, ref: "v1" }, repoSwitchCache)).toBe(false);
    expect(await followsBranch({ name: "team", repo: branchRepoA, ref: "v1" }, repoSwitchCache)).toBe(true);
  });

  test("pins annotated tag object IDs offline across git gc and preserves legacy annotated-tag offline fallback", async () => {
    const annotatedRepo = await packRepo("Annotated tag v1.");
    await spawnGit(annotatedRepo, "tag", "-a", "rel-v1", "-m", "release v1");
    const tagOid = await spawnGit(annotatedRepo, "rev-parse", "refs/tags/rel-v1");
    const commitOid = await spawnGit(annotatedRepo, "rev-parse", "HEAD");
    expect(tagOid).not.toBe(commitOid);
    writePack(annotatedRepo, "Annotated tag v2.");
    await spawnGit(annotatedRepo, "commit", "-q", "-am", "v2");
    const v2Sha = await spawnGit(annotatedRepo, "rev-parse", "HEAD");
    const tagPinCache = temp.make("cache-annotated-tag-oid-");
    const tagOnline = await fetchSource({ name: "team", repo: annotatedRepo, ref: tagOid }, tagPinCache);
    if ("error" in tagOnline) throw new Error(tagOnline.error);
    expect([tagOnline.packs[0]?.manifest.summary, tagOnline.stale]).toEqual(["Annotated tag v1.", undefined]);
    const tagSwitch = await fetchSource({ name: "team", repo: annotatedRepo, ref: v2Sha }, tagPinCache);
    if ("error" in tagSwitch) throw new Error(tagSwitch.error);
    await spawnGit(join(tagPinCache, "team"), "reflog", "expire", "--expire=now", "--all");
    await spawnGit(join(tagPinCache, "team"), "gc", "--prune=now", "-q");
    rmSync(annotatedRepo, { recursive: true, force: true });
    const tagOfflineBack = await fetchSource({ name: "team", repo: annotatedRepo, ref: tagOid }, tagPinCache);
    if ("error" in tagOfflineBack) throw new Error(tagOfflineBack.error);
    expect([tagOfflineBack.packs[0]?.manifest.summary, tagOfflineBack.stale]).toEqual(["Annotated tag v1.", undefined]);
    const tagOfflineFallback = await fetchSource({ name: "team", repo: annotatedRepo, ref: "main" }, tagPinCache);
    if ("error" in tagOfflineFallback) throw new Error(tagOfflineFallback.error);
    expect(tagOfflineFallback.packs[0]?.manifest.summary).toBe("Annotated tag v1.");
    expect(tagOfflineFallback.stale).toContain("could not fetch main");

    const legacyTagRepo = await packRepo("Legacy annotated tag v1.");
    await spawnGit(legacyTagRepo, "tag", "-a", "legacy-v1", "-m", "legacy tag");
    const legacyTagOid = await spawnGit(legacyTagRepo, "rev-parse", "refs/tags/legacy-v1");
    const legacyTagCommit = await spawnGit(legacyTagRepo, "rev-parse", "HEAD");
    const legacyTagCache = temp.make("cache-legacy-tag-oid-");
    const legacyTagDir = join(legacyTagCache, "team");
    mkdirSync(legacyTagDir, { recursive: true });
    await spawnGit(legacyTagDir, "init", "-q");
    await spawnGit(legacyTagDir, "fetch", "-q", "--depth", "1", "--no-tags", legacyTagRepo, legacyTagOid);
    await spawnGit(legacyTagDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(legacyTagDir, ".git", "hedge-source.json"), JSON.stringify({ repo: legacyTagRepo, ref: legacyTagOid, commit: legacyTagCommit }) + "\n");
    rmSync(legacyTagRepo, { recursive: true, force: true });
    const legacyTagOffline = await fetchSource({ name: "team", repo: legacyTagRepo, ref: legacyTagOid }, legacyTagCache);
    if ("error" in legacyTagOffline) throw new Error(legacyTagOffline.error);
    expect(legacyTagOffline.packs[0]?.manifest.summary).toBe("Legacy annotated tag v1.");
    expect(legacyTagOffline.stale).toContain(`could not fetch ${legacyTagOid}`);
  });

  test("rejects refspec injection, separates invalid-UTF-8 mirror paths, and falls back offline after a legacy insteadOf broken-ref fetch", async () => {
    const repoA = await packRepo("Trusted repo A.");
    const repoB = await packRepo("Untrusted repo B.");
    const shaA = await spawnGit(repoA, "rev-parse", "HEAD");
    const shaB = await spawnGit(repoB, "rev-parse", "HEAD");
    const forgedHash = new Bun.CryptoHasher("sha256").update(repoA).digest("hex");
    const forgedCache = temp.make("cache-forged-refspec-");
    expect("error" in (await fetchSource({ name: "team", repo: repoA, ref: shaA }, forgedCache))).toBe(false);
    const forged = await fetchSource({ name: "team", repo: repoB, ref: `HEAD:refs/hedge/pins/${forgedHash}/${shaB}` }, forgedCache);
    expect("error" in forged).toBe(true);
    rmSync(repoA, { recursive: true, force: true });
    const afterForge = await fetchSource({ name: "team", repo: repoA, ref: shaB }, forgedCache);
    if ("error" in afterForge) throw new Error(afterForge.error);
    expect(afterForge.packs[0]?.manifest.summary).toBe("Trusted repo A.");
    expect(afterForge.stale).toContain(`could not fetch ${shaB}`);

    const legacyMirror = await packRepo("Legacy insteadOf good v1.");
    const legacyGoodSha = await spawnGit(legacyMirror, "rev-parse", "HEAD");
    await spawnGit(legacyMirror, "checkout", "-q", "-b", "broken");
    writeFileSync(join(legacyMirror, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken ref." }));
    await spawnGit(legacyMirror, "commit", "-q", "-am", "broken");
    const legacyConfigured = "https://example.invalid/legacy-broken.git";
    const legacyBrokenCache = temp.make("cache-legacy-broken-");
    const legacyBrokenDir = join(legacyBrokenCache, "team");
    mkdirSync(legacyBrokenDir, { recursive: true });
    await spawnGit(legacyBrokenDir, "init", "-q");
    await spawnGit(legacyBrokenDir, "config", `url.${legacyMirror}.insteadOf`, legacyConfigured);
    await spawnGit(legacyBrokenDir, "fetch", "-q", "--depth", "1", "--no-tags", legacyConfigured, "main");
    await spawnGit(legacyBrokenDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(legacyBrokenDir, ".git", "hedge-source.json"), JSON.stringify({ repo: legacyConfigured, ref: "main", commit: legacyGoodSha }) + "\n");
    await spawnGit(legacyBrokenDir, "fetch", "-q", "--depth", "1", "--no-tags", legacyConfigured, "broken");
    rmSync(legacyMirror, { recursive: true, force: true });
    const legacyBrokenOffline = await fetchSource({ name: "team", repo: legacyConfigured, ref: "main" }, legacyBrokenCache);
    if ("error" in legacyBrokenOffline) throw new Error(legacyBrokenOffline.error);
    expect(legacyBrokenOffline.packs[0]?.manifest.summary).toBe("Legacy insteadOf good v1.");
    expect(legacyBrokenOffline.stale).toContain("could not fetch main");

    if (process.platform === "linux") {
      const rawParent = temp.make("raw-bytes-");
      const pathA = Buffer.concat([Buffer.from(rawParent + "/repo-"), Buffer.from([0x80])]);
      const pathB = Buffer.concat([Buffer.from(rawParent + "/repo-"), Buffer.from([0x81])]);
      mkdirSync(pathA, { recursive: true });
      mkdirSync(pathB, { recursive: true });
      const initRaw = (dir: Buffer, summary: string) => {
        const res = Bun.spawnSync(["python3", "-c", `import json, os, subprocess, sys
d = bytes.fromhex(sys.argv[1])
os.makedirs(os.path.join(d, b"packs", b"team"), exist_ok=True)
with open(os.path.join(d, b"packs", b"team", b"pack.json"), "w") as f:
  json.dump({"schema": 1, "name": "team", "summary": sys.argv[2]}, f)
env = {**os.environ, "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.com"}
for cmd in [["git", "init", "-q", "-b", "main"], ["git", "add", "."], ["git", "commit", "-q", "-m", "v1"]]:
  subprocess.run(cmd, cwd=d, env=env, check=True)
print(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=d, env=env).decode().strip())`, dir.toString("hex"), summary]);
        if (res.exitCode !== 0) throw new Error(res.stderr.toString());
        return res.stdout.toString().trim();
      };
      const rawShaA = initRaw(pathA, "Raw byte 0x80.");
      const rawShaB = initRaw(pathB, "Raw byte 0x81.");
      const rawConfigured = "https://example.invalid/raw-bytes.git";
      const rawCache = temp.make("cache-raw-bytes-");
      const rawDir = join(rawCache, "team");
      mkdirSync(rawDir, { recursive: true });
      await spawnGit(rawDir, "init", "-q");
      const setRawInsteadOf = (target: Buffer) => {
        const cfg = Buffer.concat([
          Buffer.from("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[url \""),
          target,
          Buffer.from(`"]\n\tinsteadOf = ${rawConfigured}\n`),
        ]);
        writeFileSync(join(rawDir, ".git", "config"), cfg);
      };
      setRawInsteadOf(pathA);
      const fetchedA = await fetchSource({ name: "team", repo: rawConfigured, ref: rawShaA }, rawCache);
      if ("error" in fetchedA) throw new Error(fetchedA.error);
      expect(fetchedA.packs[0]?.manifest.summary).toBe("Raw byte 0x80.");
      setRawInsteadOf(pathB);
      const fetchedB = await fetchSource({ name: "team", repo: rawConfigured, ref: rawShaB }, rawCache);
      if ("error" in fetchedB) throw new Error(fetchedB.error);
      expect(fetchedB.packs[0]?.manifest.summary).toBe("Raw byte 0x81.");
      rmSync(pathB, { recursive: true, force: true });
      const crossRaw = await fetchSource({ name: "team", repo: rawConfigured, ref: rawShaA }, rawCache);
      if ("error" in crossRaw) throw new Error(crossRaw.error);
      expect(crossRaw.packs[0]?.manifest.summary).toBe("Raw byte 0x81.");
      expect(crossRaw.stale).toContain(`could not fetch ${rawShaA}`);
    }
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
