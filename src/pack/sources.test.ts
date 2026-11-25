import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { advanceSource, cachedSource, fetchSource } from "./sources.ts";

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

  test("loads the pinned commit of a cache that an older Hedge wrote without reaching the source", async () => {
    const repo = await packRepo("Legacy rules v1.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await legacyPinnedCache(cache, "team", repo, commit);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource({ name: "team", repo, ref: commit }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Legacy rules v1.", undefined]);
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

  test("preserves verified pin history across repository switches, pre-ref legacy caches, and git gc", async () => {
    const repoA = await packRepo("Repo A v1.");
    const commitA1 = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Repo B v1.");
    const commitB1 = await spawnGit(repoB, "rev-parse", "HEAD");
    const cache = temp.make("cache-");

    const cacheRepo = await legacyPinnedCache(cache, "team", repoA, commitA1);
    await fetchSource({ name: "team", repo: repoB, ref: commitB1 }, cache);

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

  test("preserves usable fallback packs as stale when pin migration cannot write refs offline", async () => {
    const repo = await packRepo("Legacy pinned v1.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    const dir = await legacyPinnedCache(cache, "team", repo, commit);
    rmSync(repo, { recursive: true, force: true });
    const refsDir = join(dir, ".git", "refs");
    setDirModes(refsDir, 0o555);
    try {
      const reapplied = await fetchSource({ name: "team", repo, ref: commit }, cache);
      if ("error" in reapplied) throw new Error(reapplied.error);
      expect([reapplied.packs[0]?.manifest.summary, reapplied.stale]).toEqual(["Legacy pinned v1.", undefined]);

      const fallback = await fetchSource({ name: "team", repo, ref: "main" }, cache);
      if ("error" in fallback) throw new Error(fallback.error);
      expect(fallback.packs[0]?.manifest.summary).toBe("Legacy pinned v1.");
      expect(fallback.stale).toContain("could not fetch main");
    } finally {
      setDirModes(refsDir, 0o755);
    }
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

  test("does not share pin history across repository URLs that differ only by SSH username", async () => {
    const repo = await packRepo("Account A.");
    const commit = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    const alice = "ssh://alice@example.invalid/repo.git";
    const bob = "ssh://bob@example.invalid/repo.git";
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: alice };
    Object.assign(process.env, env);
    try {
      const first = await fetchSource({ name: "team", repo: alice, ref: commit }, cache);
      if ("error" in first) throw new Error(first.error);
      expect(first.packs[0]?.manifest.summary).toBe("Account A.");
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
    const repoB = await packRepo("Account B.");
    const commitB = await spawnGit(repoB, "rev-parse", "HEAD");
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repoB}.insteadOf`, GIT_CONFIG_VALUE_0: bob });
    try {
      const second = await fetchSource({ name: "team", repo: bob, ref: commitB }, cache);
      if ("error" in second) throw new Error(second.error);
      expect(second.packs[0]?.manifest.summary).toBe("Account B.");
      const cross = await fetchSource({ name: "team", repo: bob, ref: commit }, cache);
      if ("error" in cross) throw new Error(cross.error);
      expect(cross.packs[0]?.manifest.summary).toBe("Account B.");
      expect(cross.stale).toContain(`could not fetch ${commit}`);
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  });

  test("preserves a pre-upgrade pinned commit after applying a second pin, and keeps pin history across an older binary write", async () => {
    const repo = await packRepo("Team rules v1.");
    const first = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const second = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Team rules v3.");
    await spawnGit(repo, "commit", "-q", "-am", "v3");
    const third = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await legacyPinnedCache(cache, "team", repo, first);
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

  test("keeps a legacy insteadOf-fetched pinned cache working offline after upgrade, while rejecting a changed rewrite", async () => {
    const repoA = await packRepo("Legacy mirror A.");
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
    expect([offline.packs[0]?.manifest.summary, offline.stale]).toEqual(["Legacy mirror A.", undefined]);

    await spawnGit(dir, "config", "--unset", `url.${repoA}.insteadOf`);
    await spawnGit(dir, "config", `url.${repoB}.insteadOf`, configured);
    rmSync(repoB, { recursive: true, force: true });
    const swapped = await fetchSource({ name: "team", repo: configured, ref: shaA }, cache);
    expect("error" in swapped).toBe(true);
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
