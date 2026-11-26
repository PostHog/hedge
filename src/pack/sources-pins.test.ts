import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../cli.ts";
import { engineRoot } from "../setup/testing.ts";
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

describe("fetchSource pin namespaces and metadata", () => {
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

    const parentRepo = await packRepo("Parent A.");
    const parentCommit = await spawnGit(parentRepo, "rev-parse", "HEAD");
    writePack(parentRepo, "Child B.");
    await spawnGit(parentRepo, "commit", "-q", "-am", "child");
    const childCommit = await spawnGit(parentRepo, "rev-parse", "HEAD");
    const shallowB = join(temp.make("shallow-b-"), "b.git");
    await spawnGit(dirname(shallowB), "clone", "-q", "--depth", "1", `file://${parentRepo}`, shallowB);
    const sharedCache = temp.make("cache-shallow-cross-repo-");
    expect("error" in (await fetchSource({ name: "team", repo: parentRepo, ref: parentCommit }, sharedCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: shallowB, ref: childCommit }, sharedCache))).toBe(false);
    rmSync(shallowB, { recursive: true, force: true });
    const crossPin = await fetchSource({ name: "team", repo: shallowB, ref: parentCommit }, sharedCache);
    expect("error" in crossPin || crossPin.stale !== undefined).toBe(true);
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

});
