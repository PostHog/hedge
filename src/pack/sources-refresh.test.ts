import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { probeLocalRepoInfo } from "./local-repo-info.ts";
import { advanceSource, cachedSource, fetchSource, followsBranch, unpinnedSources } from "./sources.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

function writePack(dir: string, summary: string) {
  mkdirSync(join(dir, "packs", "team"), { recursive: true });
  writeFileSync(join(dir, "packs", "team", "pack.json"), JSON.stringify({ schema: 1, name: "team", summary }));
}

async function packRepo(summary: string) {
  const dir = temp.make("pack-repo-");
  await spawnGit(dir, "init", "-q", "-b", "main");
  writePack(dir, summary);
  await spawnGit(dir, "add", ".");
  await spawnGit(dir, "commit", "-q", "-m", "v1");
  await spawnGit(dir, "tag", "v1");
  return dir;
}

async function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  await spawnGit(dir, "init", "-q", "-b", "main");
}

async function commitPack(dir: string, _pack: string, summary: string) {
  writePack(dir, summary);
  await spawnGit(dir, "add", ".");
  await spawnGit(dir, "commit", "-q", "-m", summary);
  return await spawnGit(dir, "rev-parse", "HEAD");
}


describe("fetchSource staged refresh and rollback", () => {
  test("anchors >256-commit refreshes with valid Git timestamps so intermediate commits survive shallow fetches and git gc", async () => {
    const repo = temp.make("large-refresh-repo-");
    await spawnGit(repo, "init", "-q", "-b", "main");
    const lines: string[] = [];
    for (let i = 1; i <= 262; i++) {
      const manifest = JSON.stringify({ schema: 1, name: "team", summary: `Bulk ${i}.` });
      lines.push(
        `commit refs/heads/main`,
        `mark :${i}`,
        `committer Test <test@example.com> ${1700000000 + i} +0000`,
        `data 4`,
        `c${String(i).padStart(3, "0")}`,
        ...(i > 1 ? [`from :${i - 1}`] : []),
        `M 100644 inline packs/team/pack.json`,
        `data ${Buffer.byteLength(manifest)}`,
        manifest,
        "",
      );
    }
    const fi = Bun.spawn(["git", "-C", repo, "fast-import", "--quiet"], {
      stdin: new TextEncoder().encode(lines.join("\n")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await fi.exited).toBe(0);
    await spawnGit(repo, "checkout", "-q", "main");
    const allCommits = (await spawnGit(repo, "rev-list", "--reverse", "main")).split("\n").map((s) => s.trim()).filter(Boolean);
    const c1 = allCommits[0]!;
    const cMid = allCommits[130]!;
    const cNearTip = allCommits[260]!;

    await spawnGit(repo, "checkout", "-q", "-B", "track", c1);
    const cache = temp.make("cache-large-refresh-");
    const init = await fetchSource({ name: "team", repo, ref: "track" }, cache);
    if ("error" in init) throw new Error(init.error);
    await spawnGit(repo, "checkout", "-q", "-B", "track", "main");
    const moved = await advanceSource({ name: "team", repo, ref: "track" }, cache, c1);
    expect(moved.state).toBe("moved");

    const cacheDir = join(cache, "team");
    await spawnGit(cacheDir, "fetch", "-q", "--depth", "1", "--no-tags", repo, cNearTip);
    await spawnGit(cacheDir, "checkout", "-q", "--detach", `${cNearTip}^{commit}`);
    writeFileSync(join(cacheDir, ".git", "hedge-source.json"), JSON.stringify({ repo, ref: cNearTip, commit: cNearTip }) + "\n");
    await spawnGit(cacheDir, "gc", "-q", "--prune=now");

    rmSync(repo, { recursive: true, force: true });
    const offlineMid = await fetchSource({ name: "team", repo, ref: cMid }, cache);
    if ("error" in offlineMid) throw new Error(offlineMid.error);
    expect([offlineMid.packs[0]?.manifest.summary, offlineMid.stale]).toEqual(["Bulk 131.", undefined]);
  });

  test("deepening a cache from a full repository does not retroactively attribute ancestors to an earlier shallow refresh", async () => {
    const fullRepo = temp.make("full-history-repo-");
    await initRepo(fullRepo);
    const c1 = await commitPack(fullRepo, "team", "Ancestor C1.");
    const c2 = await commitPack(fullRepo, "team", "Shallow base C2.");
    const c3 = await commitPack(fullRepo, "team", "Shallow tip C3.");

    const shallowRepo = temp.make("shallow-history-repo-");
    await spawnGit(shallowRepo, "init", "-q", "-b", "main");
    await spawnGit(shallowRepo, "fetch", "-q", "--depth", "1", fullRepo, c2);
    await spawnGit(shallowRepo, "checkout", "-q", "-B", "main", "FETCH_HEAD");

    const cache = temp.make("cache-shallow-deepen-");
    const loadedC2 = await fetchSource({ name: "team", repo: shallowRepo, ref: "main" }, cache);
    if ("error" in loadedC2) throw new Error(loadedC2.error);
    expect(loadedC2.packs[0]?.manifest.summary).toBe("Shallow base C2.");

    await spawnGit(shallowRepo, "fetch", "-q", "--depth", "2", fullRepo, c3);
    await spawnGit(shallowRepo, "checkout", "-q", "-B", "main", "FETCH_HEAD");
    const moved = await advanceSource({ name: "team", repo: shallowRepo, ref: "main" }, cache, c2);
    expect(moved.state).toBe("moved");

    const loadedFull = await fetchSource({ name: "team", repo: fullRepo, ref: c1 }, cache);
    if ("error" in loadedFull) throw new Error(loadedFull.error);
    expect(loadedFull.packs[0]?.manifest.summary).toBe("Ancestor C1.");

    rmSync(shallowRepo, { recursive: true, force: true });
    const spoofed = await fetchSource({ name: "team", repo: shallowRepo, ref: c1 }, cache);
    expect("error" in spoofed).toBe(true);
  });

  test("handles offline branch switch refresh, failed fresh SHA-256 recovery, nested commondir repointing, and implicit .git symlink retargeting", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("refresh-sha256-alias-");
    const repo = join(root, "branch-repo");
    await initRepo(repo);
    const v1 = await commitPack(repo, "team", "Branch v1.");
    const branchCache = temp.make("cache-offline-branch-switch-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, branchCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo, ref: v1 }, branchCache))).toBe(false);
    const movedAside = join(root, "branch-repo-offline");
    const { renameSync } = await import("node:fs");
    renameSync(repo, movedAside);
    const offlineSwitch = await fetchSource({ name: "team", repo, ref: "main" }, branchCache);
    if ("error" in offlineSwitch) throw new Error(offlineSwitch.error);
    expect(offlineSwitch.stale).toContain("could not fetch main");
    expect(await followsBranch({ name: "team", repo, ref: "main" }, branchCache)).toBe(true);
    renameSync(movedAside, repo);
    const v2 = await commitPack(repo, "team", "Branch v2.");
    const advanced = await advanceSource({ name: "team", repo, ref: "main" }, branchCache, v1);
    expect(advanced).toMatchObject({ state: "moved", commit: v2 });

    const brokenSha256 = join(root, "broken-sha256");
    mkdirSync(brokenSha256, { recursive: true });
    await spawnGit(brokenSha256, "init", "-q", "--object-format=sha256", "-b", "main");
    await spawnGit(brokenSha256, "config", "user.email", "test@example.com");
    await spawnGit(brokenSha256, "config", "user.name", "Test");
    mkdirSync(join(brokenSha256, "packs", "team"), { recursive: true });
    writeFileSync(join(brokenSha256, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken 256." }));
    await spawnGit(brokenSha256, "add", ".");
    await spawnGit(brokenSha256, "commit", "-q", "-m", "broken");
    const recoveryCache = temp.make("cache-sha256-recover-");
    expect("error" in (await fetchSource({ name: "team", repo: brokenSha256, ref: "main" }, recoveryCache))).toBe(true);
    const recovered = await fetchSource({ name: "team", repo, ref: "main" }, recoveryCache);
    if ("error" in recovered) throw new Error(recovered.error);
    expect([recovered.packs[0]?.manifest.summary, recovered.stale]).toEqual(["Branch v2.", undefined]);

    const mainRepo = join(root, "wt-main");
    await initRepo(mainRepo);
    const wtSha = await commitPack(mainRepo, "team", "WT main.");
    const wtDir = join(root, "wt-dir");
    await spawnGit(mainRepo, "worktree", "add", "-q", "-b", "wt-b", wtDir, "HEAD");
    const wtCache = temp.make("cache-commondir-repoint-");
    expect("error" in (await fetchSource({ name: "team", repo: wtDir, ref: wtSha }, wtCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo, ref: v2 }, wtCache))).toBe(false);
    const wtGitDir = readFileSync(join(wtDir, ".git"), "utf8").replace(/^gitdir: /, "").trim();
    writeFileSync(join(wtGitDir, "commondir"), `${join(root, "missing-common")}\n`);
    expect("error" in (await fetchSource({ name: "team", repo: wtDir, ref: wtSha }, wtCache))).toBe(true);

    const impTargetA = join(root, "imp-a");
    await initRepo(impTargetA);
    const impShaA = await commitPack(impTargetA, "team", "Implicit symlink A.");
    const impPath = join(root, "imp-packs");
    const impDotGitLink = join(root, "imp-packs.git");
    symlinkSync(impTargetA, impDotGitLink);
    const impCache = temp.make("cache-imp-symlink-repoint-");
    expect("error" in (await fetchSource({ name: "team", repo: impPath, ref: impShaA }, impCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo, ref: v2 }, impCache))).toBe(false);
    rmSync(impDotGitLink);
    symlinkSync(join(root, "missing-imp-b"), impDotGitLink);
    expect("error" in (await fetchSource({ name: "team", repo: impPath, ref: impShaA }, impCache))).toBe(true);
  });

  test("cleans up failed fresh post-checkout hooks so a later apply recovers", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-hook-recovery-");
    const hookRepo = join(root, "hook-repo");
    await initRepo(hookRepo);
    const hookSha = await commitPack(hookRepo, "team", "Post-checkout recovery.");
    const templateDir = join(root, "git-template");
    const hooksDir = join(templateDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = join(hooksDir, "post-checkout");
    writeFileSync(hookFile, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const hookCache = temp.make("cache-hook-recovery-");
    const savedTemplate = process.env.GIT_TEMPLATE_DIR;
    process.env.GIT_TEMPLATE_DIR = templateDir;
    try {
      const failedFresh = await fetchSource({ name: "team", repo: hookRepo, ref: hookSha }, hookCache);
      expect("error" in failedFresh).toBe(true);
    } finally {
      if (savedTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
      else process.env.GIT_TEMPLATE_DIR = savedTemplate;
    }
    const recoveredHook = await fetchSource({ name: "team", repo: hookRepo, ref: hookSha }, hookCache);
    if ("error" in recoveredHook) throw new Error(recoveredHook.error);
    expect([recoveredHook.packs[0]?.manifest.summary, recoveredHook.stale]).toEqual(["Post-checkout recovery.", undefined]);
  });

  test("retains intermediate commits after a failed refresh is retried and succeeds", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-retry-intermediate-");
    const retryRepo = join(root, "retry-intermediate");
    await initRepo(retryRepo);
    const r1 = await commitPack(retryRepo, "team", "Retry v1.");
    const retryCache = temp.make("cache-retry-intermediate-");
    expect("error" in (await fetchSource({ name: "team", repo: retryRepo, ref: "main" }, retryCache))).toBe(false);
    const r2 = await commitPack(retryRepo, "team", "Retry v2 intermediate.");
    mkdirSync(join(retryRepo, "packs", "team"), { recursive: true });
    writeFileSync(join(retryRepo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Retry v3 broken." }));
    await spawnGit(retryRepo, "commit", "-qam", "broken v3");
    const failedRefresh = await advanceSource({ name: "team", repo: retryRepo, ref: "main" }, retryCache, r1);
    expect(failedRefresh.state).toBe("failed");
    const r4 = await commitPack(retryRepo, "team", "Retry v4 fixed.");
    const fixedRefresh = await advanceSource({ name: "team", repo: retryRepo, ref: "main" }, retryCache, r1);
    expect(fixedRefresh).toMatchObject({ state: "moved", commit: r4 });
    rmSync(retryRepo, { recursive: true, force: true });
    const offlineR2 = await fetchSource({ name: "team", repo: retryRepo, ref: r2 }, retryCache);
    if ("error" in offlineR2) throw new Error(offlineR2.error);
    expect([offlineR2.packs[0]?.manifest.summary, offlineR2.stale]).toEqual(["Retry v2 intermediate.", undefined]);
  });

  test("preserves tracked files of an enclosing Git repository when a fresh cache fails", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-enclosing-repo-");
    const enclosingRepo = join(root, "enclosing-repo");
    await initRepo(enclosingRepo);
    const trackedInParent = join(enclosingRepo, "caches", "team", "keep.txt");
    mkdirSync(join(enclosingRepo, "caches", "team"), { recursive: true });
    writeFileSync(trackedInParent, "parent tracked file\n");
    await spawnGit(enclosingRepo, "add", ".");
    await spawnGit(enclosingRepo, "commit", "-qm", "track parent file");
    const badPackSrc = join(root, "bad-pack-enclosing");
    await initRepo(badPackSrc);
    mkdirSync(join(badPackSrc, "packs", "team"), { recursive: true });
    writeFileSync(join(badPackSrc, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Bad schema." }));
    await spawnGit(badPackSrc, "add", ".");
    await spawnGit(badPackSrc, "commit", "-qm", "bad schema");
    expect("error" in (await fetchSource({ name: "team", repo: badPackSrc, ref: "main" }, join(enclosingRepo, "caches")))).toBe(true);
    expect(readFileSync(trackedInParent, "utf8")).toBe("parent tracked file\n");
  });

  test("keeps remote-tracking refs intact when a staged origin refresh rolls back", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-origin-refmap-");
    const originUpstream = join(root, "origin-upstream");
    await initRepo(originUpstream);
    const o1 = await commitPack(originUpstream, "team", "Origin v1.");
    const originCache = temp.make("cache-origin-refmap-");
    const originDir = join(originCache, "team");
    await spawnGit(root, "clone", "-q", originUpstream, originDir);
    expect("error" in (await fetchSource({ name: "team", repo: "origin", ref: "main" }, originCache))).toBe(false);
    const remoteBefore = await spawnGit(originDir, "rev-parse", "refs/remotes/origin/main");
    mkdirSync(join(originUpstream, "packs", "team"), { recursive: true });
    writeFileSync(join(originUpstream, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Origin broken." }));
    await spawnGit(originUpstream, "commit", "-qam", "broken origin v2");
    const failedOrigin = await advanceSource({ name: "team", repo: "origin", ref: "main" }, originCache, o1);
    expect(failedOrigin.state).toBe("failed");
    expect(await spawnGit(originDir, "rev-parse", "refs/remotes/origin/main")).toBe(remoteBefore);
    await spawnGit(originDir, "fsck", "--full");
  });

  test("returns a failed refresh state when staging objects fails on a read-only objects directory", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-ro-stage-");
    const roRepo = join(root, "readonly-stage");
    await initRepo(roRepo);
    const ro1 = await commitPack(roRepo, "team", "RO v1.");
    const roCache = temp.make("cache-ro-stage-");
    expect("error" in (await fetchSource({ name: "team", repo: roRepo, ref: "main" }, roCache))).toBe(false);
    await commitPack(roRepo, "team", "RO v2.");
    const roObjects = join(roCache, "team", ".git", "objects");
    chmodSync(roObjects, 0o555);
    try {
      const roFailed = await advanceSource({ name: "team", repo: roRepo, ref: "main" }, roCache, ro1);
      expect(roFailed.state).toBe("failed");
    } finally {
      chmodSync(roObjects, 0o755);
    }
  });

  test("advances a branch whose short name starts with refs/ when no conflicting ref exists", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-refs-custom-");
    const customBranchRepo = join(root, "refs-custom-branch");
    await initRepo(customBranchRepo);
    await spawnGit(customBranchRepo, "checkout", "-q", "-b", "refs/custom/release");
    const cb1 = await commitPack(customBranchRepo, "team", "Custom branch v1.");
    const cbCache = temp.make("cache-refs-custom-");
    expect("error" in (await fetchSource({ name: "team", repo: customBranchRepo, ref: "refs/heads/refs/custom/release" }, cbCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: customBranchRepo, ref: "refs/custom/release" }, cbCache)).toBe(true);
    const cb2 = await commitPack(customBranchRepo, "team", "Custom branch v2.");
    const cbMoved = await advanceSource({ name: "team", repo: customBranchRepo, ref: "refs/custom/release" }, cbCache, cb1);
    expect(cbMoved).toMatchObject({ state: "moved", commit: cb2 });
    const cb3 = await commitPack(customBranchRepo, "team", "Custom branch v3.");
    expect(await followsBranch({ name: "team", repo: customBranchRepo, ref: "refs/custom/release" }, cbCache)).toBe(true);
    const cbMoved2 = await advanceSource({ name: "team", repo: customBranchRepo, ref: "refs/custom/release" }, cbCache, cb2);
    expect(cbMoved2).toMatchObject({ state: "moved", commit: cb3 });
  });

  test("stages refresh objects cleanly when .git/objects is a symlink to another directory", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-sym-obj-");
    const symObjRepo = join(root, "symlink-objects");
    await initRepo(symObjRepo);
    const so1 = await commitPack(symObjRepo, "team", "Symlink objects v1.");
    const symObjCache = temp.make("cache-sym-obj-");
    expect("error" in (await fetchSource({ name: "team", repo: symObjRepo, ref: "main" }, symObjCache))).toBe(false);
    const extObjects = join(root, "external-objects");
    renameSync(join(symObjCache, "team", ".git", "objects"), extObjects);
    symlinkSync(extObjects, join(symObjCache, "team", ".git", "objects"));
    const so2 = await commitPack(symObjRepo, "team", "Symlink objects v2.");
    const soMoved = await advanceSource({ name: "team", repo: symObjRepo, ref: "main" }, symObjCache, so1);
    expect(soMoved).toMatchObject({ state: "moved", commit: so2 });
  });

  test("quotes cache paths containing colons in GIT_ALTERNATE_OBJECT_DIRECTORIES during refresh", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-colon-cache-");
    const colonRepo = join(root, "colon-repo");
    await initRepo(colonRepo);
    const col1 = await commitPack(colonRepo, "team", "Colon v1.");
    const colonCache = join(root, "cache:with:colon");
    mkdirSync(colonCache, { recursive: true });
    expect("error" in (await fetchSource({ name: "team", repo: colonRepo, ref: "main" }, colonCache))).toBe(false);
    const col2 = await commitPack(colonRepo, "team", "Colon v2.");
    const colMoved = await advanceSource({ name: "team", repo: colonRepo, ref: "main" }, colonCache, col1);
    expect(colMoved).toMatchObject({ state: "moved", commit: col2 });
  });

  test("keeps the repository fsck-clean when a post-checkout hook dirties files during refresh rollback", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-dirty-rollback-");
    const dirtyRollbackRepo = join(root, "dirty-rollback");
    await initRepo(dirtyRollbackRepo);
    const dr1 = await commitPack(dirtyRollbackRepo, "team", "Dirty rollback v1.");
    const drCache = temp.make("cache-dirty-rollback-");
    expect("error" in (await fetchSource({ name: "team", repo: dirtyRollbackRepo, ref: "main" }, drCache))).toBe(false);
    const drHooksDir = join(drCache, "team", ".git", "hooks");
    mkdirSync(drHooksDir, { recursive: true });
    const drHook = join(drHooksDir, "post-checkout");
    writeFileSync(drHook, "#!/bin/sh\necho dirty >> packs/team/pack.json\n");
    chmodSync(drHook, 0o755);
    mkdirSync(join(dirtyRollbackRepo, "packs", "team"), { recursive: true });
    writeFileSync(join(dirtyRollbackRepo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Dirty rollback broken." }));
    await spawnGit(dirtyRollbackRepo, "commit", "-qam", "broken v2");
    const drFailed = await advanceSource({ name: "team", repo: dirtyRollbackRepo, ref: "main" }, drCache, dr1);
    expect(drFailed.state).toBe("failed");
    await spawnGit(join(drCache, "team"), "fsck", "--full");
  });

  test("keeps migrated objects when a post-checkout hook creates a new branch before refresh rollback", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-branch-hook-");
    const branchHookRepo = join(root, "branch-hook-rollback");
    await initRepo(branchHookRepo);
    const bh1 = await commitPack(branchHookRepo, "team", "Branch hook v1.");
    const bhCache = temp.make("cache-branch-hook-");
    expect("error" in (await fetchSource({ name: "team", repo: branchHookRepo, ref: "main" }, bhCache))).toBe(false);
    const bhHooksDir = join(bhCache, "team", ".git", "hooks");
    mkdirSync(bhHooksDir, { recursive: true });
    const bhHook = join(bhHooksDir, "post-checkout");
    writeFileSync(bhHook, "#!/bin/sh\ngit update-ref refs/heads/saved-tip \"$2\"\n");
    chmodSync(bhHook, 0o755);
    mkdirSync(join(branchHookRepo, "packs", "team"), { recursive: true });
    writeFileSync(join(branchHookRepo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Branch hook broken." }));
    await spawnGit(branchHookRepo, "commit", "-qam", "broken bh v2");
    const bhFailed = await advanceSource({ name: "team", repo: branchHookRepo, ref: "main" }, bhCache, bh1);
    expect(bhFailed.state).toBe("failed");
    await spawnGit(join(bhCache, "team"), "fsck", "--full");
  });

  test("preserves preexisting cache files when a failed fresh checkout is discarded", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-preexist-");
    const preExistSrc = join(root, "preexist-src");
    await initRepo(preExistSrc);
    mkdirSync(join(preExistSrc, "packs", "team"), { recursive: true });
    writeFileSync(join(preExistSrc, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken preexist." }));
    writeFileSync(join(preExistSrc, "keep.txt"), "keep identical\n");
    await spawnGit(preExistSrc, "add", ".");
    await spawnGit(preExistSrc, "commit", "-qm", "broken with keep.txt");
    const preExistCache = temp.make("cache-preexist-");
    mkdirSync(join(preExistCache, "team"), { recursive: true });
    const preExistFile = join(preExistCache, "team", "keep.txt");
    writeFileSync(preExistFile, "keep identical\n");
    expect("error" in (await fetchSource({ name: "team", repo: preExistSrc, ref: "main" }, preExistCache))).toBe(true);
    expect(readFileSync(preExistFile, "utf8")).toBe("keep identical\n");
  });

  test("preserves a dangling .git symlink when a fresh fetch fails", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-dangling-dotgit-");
    const danglingCache = temp.make("cache-dangling-dotgit-");
    mkdirSync(join(danglingCache, "team"), { recursive: true });
    const danglingLink = join(danglingCache, "team", ".git");
    symlinkSync(join(root, "missing-gitdir-target"), danglingLink);
    expect("error" in (await fetchSource({ name: "team", repo: join(root, "missing-upstream"), ref: "main" }, danglingCache))).toBe(true);
    expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
  });

  test("keeps the repository fsck-clean when logs/HEAD is write-only during refresh rollback", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-wo-headlog-");
    const woLogRepo = join(root, "wo-headlog-repo");
    await initRepo(woLogRepo);
    const wo1 = await commitPack(woLogRepo, "team", "WO log v1.");
    const woCache = temp.make("cache-wo-headlog-");
    expect("error" in (await fetchSource({ name: "team", repo: woLogRepo, ref: "main" }, woCache))).toBe(false);
    await spawnGit(join(woCache, "team"), "config", "core.logAllRefUpdates", "always");
    const woHeadLog = join(woCache, "team", ".git", "logs", "HEAD");
    mkdirSync(join(woCache, "team", ".git", "logs"), { recursive: true });
    writeFileSync(woHeadLog, "");
    chmodSync(woHeadLog, 0o200);
    mkdirSync(join(woLogRepo, "packs", "team"), { recursive: true });
    writeFileSync(join(woLogRepo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "WO broken." }));
    await spawnGit(woLogRepo, "commit", "-qam", "wo broken");
    try {
      const woFailed = await advanceSource({ name: "team", repo: woLogRepo, ref: "main" }, woCache, wo1);
      expect(woFailed.state).toBe("failed");
    } finally {
      chmodSync(woHeadLog, 0o644);
    }
    await spawnGit(join(woCache, "team"), "fsck", "--full");
  });

  test("advances a refs/tags/release branch when no remote tag shadows it", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-short-tag-branch-");
    const shortTagBranchRepo = join(root, "short-tag-branch");
    await initRepo(shortTagBranchRepo);
    await spawnGit(shortTagBranchRepo, "checkout", "-q", "-b", "refs/tags/release");
    const stb1 = await commitPack(shortTagBranchRepo, "team", "Tag-named branch v1.");
    const stbCache = temp.make("cache-short-tag-branch-");
    expect("error" in (await fetchSource({ name: "team", repo: shortTagBranchRepo, ref: "refs/heads/refs/tags/release" }, stbCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: shortTagBranchRepo, ref: "refs/tags/release" }, stbCache)).toBe(true);
    const stb2 = await commitPack(shortTagBranchRepo, "team", "Tag-named branch v2.");
    expect(await advanceSource({ name: "team", repo: shortTagBranchRepo, ref: "refs/tags/release" }, stbCache, stb1)).toMatchObject({ state: "moved", commit: stb2 });
  });

  test("advances a local branch source on refresh when a trailing slash is added to its path", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-trailing-slash-refresh-");
    const repo = join(root, "local-repo");
    await initRepo(repo);
    const c1 = await commitPack(repo, "team", "Trailing slash v1.");
    const cache = temp.make("cache-trailing-slash-refresh-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(false);
    const same = await cachedSource({ name: "team", repo: `${repo}/`, ref: "main" }, cache);
    if ("error" in same) throw new Error(same.error);
    expect(same.packs[0]?.manifest.summary).toBe("Trailing slash v1.");
    const c2 = await commitPack(repo, "team", "Trailing slash v2.");
    const moved = await advanceSource({ name: "team", repo: `${repo}/`, ref: "main" }, cache, c1);
    expect(moved).toMatchObject({ state: "moved", commit: c2 });
    if (moved.state !== "moved") throw new Error(moved.state);
    expect(moved.source.packs[0]?.manifest.summary).toBe("Trailing slash v2.");
  });

  test("keeps FETCH_HEAD valid and fsck-clean when FETCH_HEAD is write-only during refresh rollback", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = temp.make("git-wo-fetchhead-");
    const repo = join(root, "repo");
    await initRepo(repo);
    const c1 = await commitPack(repo, "team", "WO FETCH_HEAD v1.");
    const cache = temp.make("cache-wo-fetchhead-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(false);
    const fetchHeadPath = join(cache, "team", ".git", "FETCH_HEAD");
    const beforeContent = readFileSync(fetchHeadPath, "utf8");
    chmodSync(fetchHeadPath, 0o200);
    mkdirSync(join(repo, "packs", "team"), { recursive: true });
    writeFileSync(join(repo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken v2." }));
    await spawnGit(repo, "commit", "-qam", "broken v2");
    try {
      const failed = await advanceSource({ name: "team", repo, ref: "main" }, cache, c1);
      expect(failed.state).toBe("failed");
    } finally {
      chmodSync(fetchHeadPath, 0o644);
    }
    expect(readFileSync(fetchHeadPath, "utf8")).toBe(beforeContent);
    expect(await spawnGit(join(cache, "team"), "rev-parse", "--verify", "FETCH_HEAD")).toBe(c1);
    await spawnGit(join(cache, "team"), "cat-file", "-e", "FETCH_HEAD");
    await spawnGit(join(cache, "team"), "fsck", "--full");
  });

  test("keeps refresh enabled for the original branch after a failed apply with a trailing-slash spelling", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-blocked-slash-");
    const repo = join(root, "repo");
    await initRepo(repo);
    const c1 = await commitPack(repo, "team", "Blocked slash v1.");
    const cache = temp.make("cache-blocked-slash-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: `${repo}/`, ref: "missing-branch" }, cache))).toBe(true);
    expect(await followsBranch({ name: "team", repo, ref: "main" }, cache)).toBe(true);
    const c2 = await commitPack(repo, "team", "Blocked slash v2.");
    expect(await advanceSource({ name: "team", repo, ref: "main" }, cache, c1)).toMatchObject({ state: "moved", commit: c2 });
  });

  test("cleans up non-UTF-8 tracked files after a failed fresh checkout so a subsequent apply succeeds", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-nonutf8-fresh-");
    const repo = join(root, "repo");
    await initRepo(repo);
    mkdirSync(join(repo, "packs", "team"), { recursive: true });
    const badSuffix = Buffer.concat([Buffer.from("/bad-"), Buffer.from([0xff, 0xfe]), Buffer.from(".txt")]);
    writeFileSync(Buffer.concat([Buffer.from(join(repo, "packs", "team")), badSuffix]), "payload\n");
    writeFileSync(join(repo, "packs", "team", "pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken non-utf8." }));
    await spawnGit(repo, "add", ".");
    await spawnGit(repo, "commit", "-q", "-m", "broken non-utf8");
    const cache = temp.make("cache-nonutf8-fresh-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(true);
    expect(existsSync(Buffer.concat([Buffer.from(join(cache, "team", "packs", "team")), badSuffix]))).toBe(false);
    await commitPack(repo, "team", "Fixed non-utf8.");
    const fixed = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    if ("error" in fixed) throw new Error(fixed.error);
    expect([fixed.packs[0]?.manifest.summary, fixed.stale]).toEqual(["Fixed non-utf8.", undefined]);
  });

  test("rolls back HEAD and tracked files when a post-checkout hook dirties a manifest during a failed offline retained-pin switch", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-offline-hook-rollback-");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await initRepo(repoA);
    const a1 = await commitPack(repoA, "team", "Hook rollback A1.");
    const a2 = await commitPack(repoA, "team", "Hook rollback A2.");
    await initRepo(repoB);
    const b1 = await commitPack(repoB, "team", "Hook rollback B1.");
    const cache = temp.make("cache-offline-hook-rollback-");
    expect("error" in (await fetchSource({ name: "team", repo: repoB, ref: b1 }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: repoA, ref: a2 }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: repoA, ref: a1 }, cache))).toBe(false);
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    const hooksDir = join(cache, "team", ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "post-checkout"), "#!/bin/sh\nprintf '{broken-json' > packs/team/pack.json\n", { mode: 0o755 });
    const sameRepo = await fetchSource({ name: "team", repo: repoA, ref: a2 }, cache);
    if ("error" in sameRepo) throw new Error(sameRepo.error);
    expect(sameRepo.packs[0]?.manifest.summary).toBe("Hook rollback A1.");
    expect(sameRepo.stale).toContain("does not load");
    expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(a1);
    expect(await spawnGit(join(cache, "team"), "status", "--porcelain")).toBe("");
    const crossRepo = await fetchSource({ name: "team", repo: repoB, ref: b1 }, cache);
    expect("error" in crossRepo).toBe(true);
    expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(a1);
    expect(await spawnGit(join(cache, "team"), "status", "--porcelain")).toBe("");
  });

  test("preserves untracked files instead of overwriting them during offline last-good fallback", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-offline-untracked-");
    const repo = join(root, "repo");
    await initRepo(repo);
    writeFileSync(join(repo, "notes.txt"), "tracked v1\n");
    const v1 = await commitPack(repo, "team", "Untracked guard v1.");
    rmSync(join(repo, "notes.txt"));
    const v2 = await commitPack(repo, "team", "Untracked guard v2.");
    const cache = temp.make("cache-offline-untracked-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo, ref: v1 }, cache))).toBe(false);
    await spawnGit(join(cache, "team"), "checkout", "-q", "--detach", v2);
    writeFileSync(join(cache, "team", "notes.txt"), "user local notes\n");
    rmSync(repo, { recursive: true, force: true });
    const offline = await fetchSource({ name: "team", repo, ref: "main" }, cache);
    expect("error" in offline).toBe(true);
    expect(readFileSync(join(cache, "team", "notes.txt"), "utf8")).toBe("user local notes\n");
  });

  test("does not classify a +SHA pin as a branch when the local repo path contains tab-delimited branch text", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-tab-path-branch-");
    const base = join(root, "base");
    await initRepo(base);
    const sha = await commitPack(base, "team", "Tab path pin.");
    const weirdRepo = join(root, `x\tbranch '${sha}' of fake`);
    renameSync(base, weirdRepo);
    const cache = temp.make("cache-tab-path-branch-");
    const loaded = await fetchSource({ name: "team", repo: weirdRepo, ref: `+${sha}` }, cache);
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.packs[0]?.manifest.summary).toBe("Tab path pin.");
    expect(await followsBranch({ name: "team", repo: weirdRepo, ref: `+${sha}` }, cache)).toBe(false);
    expect(await unpinnedSources([{ name: "team", repo: weirdRepo, ref: `+${sha}` }], root, cache)).toEqual([]);
  });

  test("restores identical tracked files modified by a post-checkout hook and handles nonzero hook exit during cached checkout", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-hook-carried-edit-");
    const repo = join(root, "repo");
    await initRepo(repo);
    const c1 = await commitPack(repo, "team", "Carried edit same manifest.");
    writeFileSync(join(repo, "extra.txt"), "v2\n");
    await spawnGit(repo, "add", ".");
    await spawnGit(repo, "commit", "-q", "-m", "v2 same manifest");
    const c2 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-hook-carried-edit-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: c2 }, cache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo, ref: c1 }, cache))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    const hooksDir = join(cache, "team", ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "post-checkout"), "#!/bin/sh\nprintf '{broken-json' > packs/team/pack.json\nexit 1\n", { mode: 0o755 });
    const fallback = await fetchSource({ name: "team", repo, ref: c2 }, cache);
    if ("error" in fallback) throw new Error(fallback.error);
    expect(fallback.packs[0]?.manifest.summary).toBe("Carried edit same manifest.");
    expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(c1);
    expect(await spawnGit(join(cache, "team"), "status", "--porcelain")).toBe("");
  });

  test("preserves tracked edits created at the fetch or checkout boundary during fetchSource and advanceSource", async () => {
    if (process.platform === "win32") return;
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git not found");
    const withGitEditShim = async (trigger: "fetch" | "checkout", targetFile: string, editBody: string, fn: () => Promise<void>) => {
      const shimDir = temp.make("git-edit-shim-");
      const marker = join(shimDir, "triggered");
      const script = [
        "#!/bin/sh",
        `REAL_GIT=${JSON.stringify(realGit)}`,
        `TRIGGER=${JSON.stringify(trigger)}`,
        `TARGET=${JSON.stringify(targetFile)}`,
        `MARKER=${JSON.stringify(marker)}`,
        `BODY=${JSON.stringify(editBody)}`,
        'matched=0',
        'for arg in "$@"; do',
        '  if [ "$arg" = "$TRIGGER" ]; then matched=1; break; fi',
        'done',
        'if [ "$TRIGGER" = "checkout" ] && [ "$matched" = "1" ] && [ ! -f "$MARKER" ]; then',
        '  : > "$MARKER"',
        '  printf "%s" "$BODY" > "$TARGET"',
        'fi',
        '"$REAL_GIT" "$@"',
        'rc=$?',
        'if [ "$TRIGGER" = "fetch" ] && [ "$matched" = "1" ] && [ "$rc" -eq 0 ] && [ ! -f "$MARKER" ]; then',
        '  : > "$MARKER"',
        '  printf "%s" "$BODY" > "$TARGET"',
        'fi',
        'exit "$rc"',
      ].join("\n") + "\n";
      writeFileSync(join(shimDir, "git"), script, { mode: 0o755 });
      const prevPath = process.env.PATH ?? "";
      process.env.PATH = `${shimDir}:${prevPath}`;
      try {
        await fn();
      } finally {
        process.env.PATH = prevPath;
      }
    };

    for (const trigger of ["fetch", "checkout"] as const) {
      const root = temp.make(`git-concurrent-${trigger}-`);
      const repo = join(root, "repo");
      await initRepo(repo);
      const c1 = await commitPack(repo, "team", "Concurrent edit v1.");
      const c2 = await commitPack(repo, "team", "Concurrent edit v2.");
      const cache = temp.make(`cache-concurrent-${trigger}-`);
      expect("error" in (await fetchSource({ name: "team", repo, ref: c1 }, cache))).toBe(false);
      const editedJson = JSON.stringify({ schema: 1, name: "team", summary: `User concurrent fetchSource ${trigger}.` });
      await withGitEditShim(trigger, join(cache, "team", "packs", "team", "pack.json"), editedJson, async () => {
        const res = await fetchSource({ name: "team", repo, ref: c2 }, cache);
        if ("error" in res) throw new Error(res.error);
        expect(res.packs[0]?.manifest.summary).toBe(`User concurrent fetchSource ${trigger}.`);
      });
      expect(readFileSync(join(cache, "team", "packs", "team", "pack.json"), "utf8")).toBe(editedJson);
      expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(c1);

      const refreshCache = temp.make(`cache-refresh-concurrent-${trigger}-`);
      const refreshRepo = join(root, "refresh-repo");
      await initRepo(refreshRepo);
      const r1 = await commitPack(refreshRepo, "team", "Refresh v1.");
      expect("error" in (await fetchSource({ name: "team", repo: refreshRepo, ref: "main" }, refreshCache))).toBe(false);
      await commitPack(refreshRepo, "team", "Refresh v2.");
      const refreshEditedJson = JSON.stringify({ schema: 1, name: "team", summary: `User concurrent refresh ${trigger}.` });
      await withGitEditShim(trigger, join(refreshCache, "team", "packs", "team", "pack.json"), refreshEditedJson, async () => {
        const refreshed = await advanceSource({ name: "team", repo: refreshRepo, ref: "main" }, refreshCache, r1);
        expect(refreshed.state).toBe(trigger === "fetch" ? "edited" : "failed");
      });
      expect(readFileSync(join(refreshCache, "team", "packs", "team", "pack.json"), "utf8")).toBe(refreshEditedJson);
      expect(await spawnGit(join(refreshCache, "team"), "rev-parse", "HEAD")).toBe(r1);
    }
  });

  test("preserves tracked edits to a shared file saved after checkout and before a malformed pack triggers rollback", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-post-checkout-user-edit-");
    const repo = join(root, "repo");
    await initRepo(repo);
    writeFileSync(join(repo, "shared.txt"), "original shared\n");
    const c1 = await commitPack(repo, "team", "Good v1.");
    const cache = temp.make("cache-post-checkout-user-edit-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: c1 }, cache))).toBe(false);

    const sharedInCache = join(cache, "team", "shared.txt");
    rmSync(join(repo, "packs", "team", "pack.json"));
    writeFileSync(
      join(repo, "packs", "team", "pack.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sharedInCache)}, "user edit during load\\n");\nthrow new Error("malformed v2");\n`,
    );
    await spawnGit(repo, "add", "-A");
    await spawnGit(repo, "commit", "-q", "-m", "broken v2");
    const c2 = await spawnGit(repo, "rev-parse", "HEAD");

    const applied = await fetchSource({ name: "team", repo, ref: c2 }, cache);
    if ("error" in applied) throw new Error(applied.error);
    expect(applied.packs[0]?.manifest.summary).toBe("Good v1.");
    expect(await spawnGit(join(cache, "team"), "rev-parse", "HEAD")).toBe(c1);
    expect(readFileSync(sharedInCache, "utf8")).toBe("user edit during load\n");

    const refreshCache = temp.make("cache-refresh-post-checkout-user-edit-");
    const refreshRepo = join(root, "refresh-repo");
    await initRepo(refreshRepo);
    writeFileSync(join(refreshRepo, "shared.txt"), "refresh original\n");
    const r1 = await commitPack(refreshRepo, "team", "Refresh good v1.");
    expect("error" in (await fetchSource({ name: "team", repo: refreshRepo, ref: "main" }, refreshCache))).toBe(false);
    const refreshShared = join(refreshCache, "team", "shared.txt");
    rmSync(join(refreshRepo, "packs", "team", "pack.json"));
    writeFileSync(
      join(refreshRepo, "packs", "team", "pack.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(refreshShared)}, "refresh user edit during load\\n");\nthrow new Error("malformed refresh v2");\n`,
    );
    await spawnGit(refreshRepo, "add", "-A");
    await spawnGit(refreshRepo, "commit", "-q", "-m", "broken refresh v2");

    const refreshed = await advanceSource({ name: "team", repo: refreshRepo, ref: "main" }, refreshCache, r1);
    expect(refreshed.state).toBe("failed");
    expect(await spawnGit(join(refreshCache, "team"), "rev-parse", "HEAD")).toBe(r1);
    expect(readFileSync(refreshShared, "utf8")).toBe("refresh user edit during load\n");
  });

});
