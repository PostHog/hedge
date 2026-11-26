import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("fetchSource branch transitions and offline fallback", () => {
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


  async function initPackRepo(dir: string, summary: string) {
    mkdirSync(dir, { recursive: true });
    await spawnGit(dir, "init", "-q", "-b", "main");
    writePack(dir, summary);
    await spawnGit(dir, "add", ".");
    await spawnGit(dir, "commit", "-q", "-m", "v1");
    return await spawnGit(dir, "rev-parse", "HEAD");
  }


  test("resumes last-good branch offline after checkout drift and rejects HEAD mutation while loading", async () => {
    const pinResumeRepo = await packRepo("Pin resume v1.");
    const pinV1 = await spawnGit(pinResumeRepo, "rev-parse", "HEAD");
    writePack(pinResumeRepo, "Pin resume v2.");
    await spawnGit(pinResumeRepo, "commit", "-q", "-am", "v2");
    const pinV2 = await spawnGit(pinResumeRepo, "rev-parse", "HEAD");
    const pinResumeCache = temp.make("cache-pin-resume-");
    expect("error" in (await fetchSource({ name: "team", repo: pinResumeRepo, ref: pinV1 }, pinResumeCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: pinResumeRepo, ref: "main" }, pinResumeCache))).toBe(false);
    await spawnGit(join(pinResumeCache, "team"), "checkout", "-q", "--detach", pinV1);
    rmSync(pinResumeRepo, { recursive: true, force: true });
    const resumedBranch = await fetchSource({ name: "team", repo: pinResumeRepo, ref: "main" }, pinResumeCache);
    if ("error" in resumedBranch) throw new Error(resumedBranch.error);
    expect(resumedBranch.packs[0]?.manifest.summary).toBe("Pin resume v2.");
    expect(resumedBranch.stale).toContain("could not fetch main");
    expect(await spawnGit(join(pinResumeCache, "team"), "rev-parse", "HEAD")).toBe(pinV2);

    const mutateRepo = await packRepo("Clean v1.");
    const cleanSha = await spawnGit(mutateRepo, "rev-parse", "HEAD");
    rmSync(join(mutateRepo, "packs/team/pack.json"));
    writeFileSync(
      join(mutateRepo, "packs/team/pack.ts"),
      `import { join } from "node:path";
Bun.spawnSync(["git", "-C", join(import.meta.dir, "../.."), "commit", "--allow-empty", "-q", "-m", "tamper"], {
  env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" },
});
export default { sdk: 1, name: "team", summary: "Mutating.", register() {} };
`,
    );
    await spawnGit(mutateRepo, "add", "-A");
    await spawnGit(mutateRepo, "commit", "-q", "-m", "mutating pack");
    const mutatingSha = await spawnGit(mutateRepo, "rev-parse", "HEAD");
    const mutateCache = temp.make("cache-mutate-head-");
    expect("error" in (await fetchSource({ name: "team", repo: mutateRepo, ref: cleanSha }, mutateCache))).toBe(false);
    const tampered = await fetchSource({ name: "team", repo: mutateRepo, ref: mutatingSha }, mutateCache);
    if ("error" in tampered) throw new Error(tampered.error);
    expect(tampered.stale).toContain("changed checkout HEAD while loading");
    expect(await spawnGit(join(mutateCache, "team"), "rev-parse", "HEAD")).toBe(cleanSha);
  });

  test("restores the prior commit when a broken pack moves the local branch before failing", async () => {
    const moveRepo = await packRepo("Original good pack.");
    const goodCommit = await spawnGit(moveRepo, "rev-parse", "HEAD");
    writePack(moveRepo, "Moved branch pack.");
    await spawnGit(moveRepo, "commit", "-q", "-am", "moved");
    const movedCommit = await spawnGit(moveRepo, "rev-parse", "HEAD");
    await spawnGit(moveRepo, "checkout", "-q", "-b", "broken");
    rmSync(join(moveRepo, "packs/team/pack.json"));
    writeFileSync(
      join(moveRepo, "packs/team/pack.ts"),
      `import { join } from "node:path";
Bun.spawnSync(["git", "-C", join(import.meta.dir, "../.."), "branch", "-f", "local-main", ${JSON.stringify(movedCommit)}]);
throw new Error("broken pack");
`,
    );
    await spawnGit(moveRepo, "add", "-A");
    await spawnGit(moveRepo, "commit", "-q", "-m", "broken");
    const moveCache = temp.make("cache-moved-branch-");
    const initial = await fetchSource({ name: "team", repo: moveRepo, ref: goodCommit }, moveCache);
    if ("error" in initial) throw new Error(initial.error);
    const moveDir = join(moveCache, "team");
    await spawnGit(moveDir, "fetch", "-q", "--no-tags", moveRepo, movedCommit);
    await spawnGit(moveDir, "checkout", "-q", "-B", "local-main", goodCommit);
    const rolled = await fetchSource({ name: "team", repo: moveRepo, ref: "broken" }, moveCache);
    if ("error" in rolled) throw new Error(rolled.error);
    expect(rolled.packs[0]?.manifest.summary).toBe("Original good pack.");
    expect(await spawnGit(moveDir, "rev-parse", "HEAD")).toBe(goodCommit);
  });

  test("omits raw resolved insteadOf URLs from persisted metadata while still working offline", async () => {
    const secretParent = temp.make("secret-mirror-");
    const secretMirror = join(secretParent, "cred-token-987654321");
    const mirrorSha = await initPackRepo(secretMirror, "Rewritten mirror packs.");
    const cfgUrl = "https://example.invalid/private-mirror.git";
    const mirrorCache = temp.make("cache-digest-resolved-");
    const mirrorDir = join(mirrorCache, "team");
    mkdirSync(mirrorDir, { recursive: true });
    await spawnGit(mirrorDir, "init", "-q");
    await spawnGit(mirrorDir, "config", `url.${secretMirror}.insteadOf`, cfgUrl);
    const mirrorRes = await fetchSource({ name: "team", repo: cfgUrl, ref: mirrorSha }, mirrorCache);
    if ("error" in mirrorRes) throw new Error(mirrorRes.error);
    const metaText = readFileSync(join(mirrorDir, ".git", "hedge-source.json"), "utf8");
    expect(metaText).not.toContain("cred-token-987654321");
    expect(metaText).not.toContain(secretMirror);
    rmSync(secretMirror, { recursive: true, force: true });
    const mirrorOffline = await fetchSource({ name: "team", repo: cfgUrl, ref: mirrorSha }, mirrorCache);
    if ("error" in mirrorOffline) throw new Error(mirrorOffline.error);
    expect(mirrorOffline.packs[0]?.manifest.summary).toBe("Rewritten mirror packs.");
    expect(mirrorOffline.stale).toBeUndefined();
  });

  test("defers branch classification when FETCH_HEAD is temporarily unreadable and resolves once readable", async () => {
    const woRepo = await packRepo("Write-only FH packs.");
    const woCache = temp.make("cache-wo-fh-");
    const woDir = join(woCache, "team");
    mkdirSync(woDir, { recursive: true });
    await spawnGit(woDir, "init", "-q");
    const woFh = join(woDir, ".git", "FETCH_HEAD");
    writeFileSync(woFh, "", { mode: 0o200 });
    chmodSync(woFh, 0o200);
    try {
      const woRes = await fetchSource({ name: "team", repo: woRepo, ref: "main" }, woCache);
      if ("error" in woRes) throw new Error(woRes.error);
      expect(woRes.packs[0]?.manifest.summary).toBe("Write-only FH packs.");
      expect(await followsBranch({ name: "team", repo: woRepo, ref: "main" }, woCache)).toBe(false);
    } finally {
      chmodSync(woFh, 0o600);
    }
    expect(await followsBranch({ name: "team", repo: woRepo, ref: "main" }, woCache)).toBe(true);
  });

  test("falls back as stale offline for a legacy annotated tag pin after git gc prunes the tag object", async () => {
    const gcTagRepo = await packRepo("GC tag packs.");
    await spawnGit(gcTagRepo, "tag", "-a", "v2-ann", "-m", "annotated");
    const gcTagSha = await spawnGit(gcTagRepo, "rev-parse", "v2-ann");
    const gcCommitSha = await spawnGit(gcTagRepo, "rev-parse", "v2-ann^{commit}");
    const gcTagCache = temp.make("cache-gc-tag-");
    const gcTagDir = join(gcTagCache, "team");
    mkdirSync(gcTagDir, { recursive: true });
    await spawnGit(gcTagDir, "init", "-q");
    await spawnGit(gcTagDir, "fetch", "-q", "--depth", "1", "--no-tags", gcTagRepo, gcTagSha);
    await spawnGit(gcTagDir, "checkout", "-q", "--detach", gcCommitSha);
    writeFileSync(join(gcTagDir, ".git", "hedge-source.json"), JSON.stringify({ repo: gcTagRepo, ref: gcTagSha, commit: gcCommitSha }) + "\n");
    await spawnGit(gcTagDir, "gc", "--prune=now", "-q");
    rmSync(gcTagRepo, { recursive: true, force: true });
    const gcTagOffline = await fetchSource({ name: "team", repo: gcTagRepo, ref: gcTagSha }, gcTagCache);
    if ("error" in gcTagOffline) throw new Error(gcTagOffline.error);
    expect(gcTagOffline.packs[0]?.manifest.summary).toBe("GC tag packs.");
    expect(gcTagOffline.stale).toContain(`could not fetch ${gcTagSha}`);
  });

  test("handles trailing-colon and empty HEAD refspecs and ignores malformed commit metadata in followsBranch", async () => {
    const colonRepo = await packRepo("Empty dest refspec.");
    const colonCache = temp.make("cache-colon-refspec-");
    const colonRes = await fetchSource({ name: "team", repo: colonRepo, ref: "main:" }, colonCache);
    if ("error" in colonRes) throw new Error(colonRes.error);
    expect(colonRes.packs[0]?.manifest.summary).toBe("Empty dest refspec.");
    expect(await followsBranch({ name: "team", repo: colonRepo, ref: "main:" }, colonCache)).toBe(true);

    const badCommitCache = temp.make("cache-bad-commit-");
    const badCommitDir = join(badCommitCache, "team");
    mkdirSync(join(badCommitDir, ".git"), { recursive: true });
    writeFileSync(join(badCommitDir, ".git", "hedge-source.json"), JSON.stringify({ repo: colonRepo, ref: "main", commit: 42, branch: true }) + "\n");
    expect(await followsBranch({ name: "team", repo: colonRepo, ref: "main" }, badCommitCache)).toBe(false);

    const emptyRefRepo = await packRepo("Default HEAD packs.");
    for (const emptyRef of ["", ":", "+", "+:"]) {
      const emptyRefCache = temp.make("cache-empty-ref-");
      const emptyRefRes = await fetchSource({ name: "team", repo: emptyRefRepo, ref: emptyRef }, emptyRefCache);
      if ("error" in emptyRefRes) throw new Error(emptyRefRes.error);
      expect(emptyRefRes.packs[0]?.manifest.summary).toBe("Default HEAD packs.");
    }
  });

  test("keeps refreshed intermediate commits available offline after a subsequent branch reapply", async () => {
    const midRepo = await packRepo("Branch c1.");
    const c1 = await spawnGit(midRepo, "rev-parse", "HEAD");
    const midCache = temp.make("cache-mid-reapply-");
    expect("error" in (await fetchSource({ name: "team", repo: midRepo, ref: "main" }, midCache))).toBe(false);
    writePack(midRepo, "Branch c2.");
    await spawnGit(midRepo, "commit", "-q", "-am", "c2");
    const c2 = await spawnGit(midRepo, "rev-parse", "HEAD");
    writePack(midRepo, "Branch c3.");
    await spawnGit(midRepo, "commit", "-q", "-am", "c3");
    expect((await advanceSource({ name: "team", repo: midRepo, ref: "main" }, midCache, c1)).state).toBe("moved");
    expect("error" in (await fetchSource({ name: "team", repo: midRepo, ref: "main" }, midCache))).toBe(false);
    rmSync(midRepo, { recursive: true, force: true });
    const midOffline = await fetchSource({ name: "team", repo: midRepo, ref: c2 }, midCache);
    if ("error" in midOffline) throw new Error(midOffline.error);
    expect(midOffline.packs[0]?.manifest.summary).toBe("Branch c2.");
    expect(midOffline.stale).toBeUndefined();
  });

  test("applies an orphan force-pushed branch and tolerates a local branch named after the incoming commit SHA", async () => {
    const forceRepo = await packRepo("Before force.");
    const forceCache = temp.make("cache-force-depth-");
    expect("error" in (await fetchSource({ name: "team", repo: forceRepo, ref: "main" }, forceCache))).toBe(false);
    await spawnGit(forceRepo, "checkout", "-q", "--orphan", "rewritten");
    for (let i = 1; i <= 5; i++) {
      writePack(forceRepo, `Rewritten ${i}.`);
      await spawnGit(forceRepo, "commit", "-q", "-am", `r${i}`);
    }
    await spawnGit(forceRepo, "branch", "-M", "rewritten", "main");
    const forceRes = await fetchSource({ name: "team", repo: forceRepo, ref: "main" }, forceCache);
    if ("error" in forceRes) throw new Error(forceRes.error);
    expect([forceRes.packs[0]?.manifest.summary, forceRes.stale]).toEqual(["Rewritten 5.", undefined]);

    const shaBranchRepo = await packRepo("SHA branch c1.");
    const shaC1 = await spawnGit(shaBranchRepo, "rev-parse", "HEAD");
    const shaBranchCache = temp.make("cache-sha-branch-");
    expect("error" in (await fetchSource({ name: "team", repo: shaBranchRepo, ref: "main" }, shaBranchCache))).toBe(false);
    writePack(shaBranchRepo, "SHA branch c2.");
    await spawnGit(shaBranchRepo, "commit", "-q", "-am", "c2");
    const shaC2 = await spawnGit(shaBranchRepo, "rev-parse", "HEAD");
    await spawnGit(join(shaBranchCache, "team"), "branch", shaC2, shaC1);
    const shaBranchRes = await fetchSource({ name: "team", repo: shaBranchRepo, ref: "main" }, shaBranchCache);
    if ("error" in shaBranchRes) throw new Error(shaBranchRes.error);
    expect(shaBranchRes.packs[0]?.manifest.summary).toBe("SHA branch c2.");
    expect(shaBranchRes.stale).toBeUndefined();
  });

  test("falls back as stale offline for a legacy bare hex-branch record with empty FETCH_HEAD", async () => {
    const hexBranchRepo = await packRepo("Legacy hex branch v1.");
    const hexBranchName = await spawnGit(hexBranchRepo, "rev-parse", "HEAD");
    await spawnGit(hexBranchRepo, "checkout", "-q", "-b", hexBranchName);
    writePack(hexBranchRepo, "Legacy hex branch v2.");
    await spawnGit(hexBranchRepo, "commit", "-q", "-am", "v2");
    const hexBranchTip = await spawnGit(hexBranchRepo, "rev-parse", "HEAD");
    const hexLegacyCache = temp.make("cache-legacy-hex-branch-");
    const hexLegacyDir = join(hexLegacyCache, "team");
    mkdirSync(hexLegacyDir, { recursive: true });
    await spawnGit(hexLegacyDir, "init", "-q");
    await spawnGit(hexLegacyDir, "fetch", "-q", "--depth", "1", "--no-tags", hexBranchRepo, `refs/heads/${hexBranchName}`);
    await spawnGit(hexLegacyDir, "checkout", "-q", "--detach", `${hexBranchTip}^{commit}`);
    writeFileSync(join(hexLegacyDir, ".git", "FETCH_HEAD"), "");
    writeFileSync(join(hexLegacyDir, ".git", "hedge-source.json"), JSON.stringify({ repo: hexBranchRepo, ref: hexBranchName, commit: hexBranchTip }) + "\n");
    rmSync(hexBranchRepo, { recursive: true, force: true });
    const hexLegacyOffline = await fetchSource({ name: "team", repo: hexBranchRepo, ref: hexBranchName }, hexLegacyCache);
    if ("error" in hexLegacyOffline) throw new Error(hexLegacyOffline.error);
    expect(hexLegacyOffline.packs[0]?.manifest.summary).toBe("Legacy hex branch v2.");
    expect(hexLegacyOffline.stale).toContain(`could not fetch ${hexBranchName}`);
  });
});
