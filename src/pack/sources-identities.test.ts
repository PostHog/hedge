import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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


describe("fetchSource repository identities and object formats", () => {
  test("does not treat a cached refs/heads/<SHA> branch as the same ref as a +<SHA> commit pin", async () => {
    const repo = temp.make("sha-branch-vs-plus-pin-");
    await initRepo(repo);
    const c1 = await commitPack(repo, "team", "Pinned commit C1.");
    const c2 = await commitPack(repo, "team", "Moving branch C2.");
    await spawnGit(repo, "branch", c1, c2);

    const cache = temp.make("cache-sha-branch-plus-");
    const profileDir = temp.make("profile-sha-branch-plus-");
    const asBranch = await fetchSource({ name: "team", repo, ref: `refs/heads/${c1}` }, cache);
    if ("error" in asBranch) throw new Error(asBranch.error);
    expect(asBranch.packs[0]?.manifest.summary).toBe("Moving branch C2.");

    const plusPinRef = { name: "team", repo, ref: `+${c1}` };
    expect(await followsBranch(plusPinRef, cache)).toBe(false);
    expect(await unpinnedSources([plusPinRef], profileDir, cache)).toEqual([]);
    expect(await followsBranch({ name: "team", repo, ref: `+refs/heads/${c1}` }, cache)).toBe(true);
    expect((await unpinnedSources([{ name: "team", repo, ref: `+refs/heads/${c1}` }], profileDir, cache)).length).toBe(1);

    const loadedPin = await fetchSource(plusPinRef, cache);
    if ("error" in loadedPin) throw new Error(loadedPin.error);
    expect(loadedPin.packs[0]?.manifest.summary).toBe("Pinned commit C1.");
  });

  test("supports fresh SHA-256 caches offline and leaves an existing SHA-1 cache untouched when pointed at a SHA-256 repository", async () => {
    const sha1Repo = temp.make("switch-sha1-repo-");
    await initRepo(sha1Repo);
    const sha1Commit = await commitPack(sha1Repo, "team", "SHA-1 pack.");

    const sha256Repo = temp.make("switch-sha256-repo-");
    await spawnGit(sha256Repo, "init", "-q", "-b", "main", "--object-format=sha256");
    await spawnGit(sha256Repo, "config", "user.email", "test@example.com");
    await spawnGit(sha256Repo, "config", "user.name", "Test");
    const sha256Commit = await commitPack(sha256Repo, "team", "SHA-256 pack.");

    const sha256Cache = temp.make("cache-fresh-sha256-");
    const fresh256 = await fetchSource({ name: "team", repo: sha256Repo, ref: sha256Commit }, sha256Cache);
    if ("error" in fresh256) throw new Error(fresh256.error);
    expect([fresh256.packs[0]?.manifest.summary, fresh256.stale]).toEqual(["SHA-256 pack.", undefined]);
    expect(await unpinnedSources([{ name: "team", repo: sha256Repo, ref: sha256Commit }], sha256Repo, sha256Cache)).toEqual([]);

    const sha1Cache = temp.make("cache-sha1-intact-");
    const first = await fetchSource({ name: "team", repo: sha1Repo, ref: sha1Commit }, sha1Cache);
    if ("error" in first) throw new Error(first.error);
    const localNotes = join(sha1Cache, "team", "local-notes.txt");
    writeFileSync(localNotes, "keep my notes\n");

    const mismatch = await fetchSource({ name: "team", repo: sha256Repo, ref: sha256Commit }, sha1Cache);
    expect("error" in mismatch).toBe(true);
    expect(readFileSync(localNotes, "utf8")).toBe("keep my notes\n");

    rmSync(sha1Repo, { recursive: true, force: true });
    const stillSha1 = await fetchSource({ name: "team", repo: sha1Repo, ref: sha1Commit }, sha1Cache);
    if ("error" in stillSha1) throw new Error(stillSha1.error);
    expect([stillSha1.packs[0]?.manifest.summary, stillSha1.stale]).toEqual(["SHA-1 pack.", undefined]);

    rmSync(sha256Repo, { recursive: true, force: true });
    const offline256 = await fetchSource({ name: "team", repo: sha256Repo, ref: sha256Commit }, sha256Cache);
    if ("error" in offline256) throw new Error(offline256.error);
    expect([offline256.packs[0]?.manifest.summary, offline256.stale]).toEqual(["SHA-256 pack.", undefined]);
  });

  test("preserves existing implicit .git aliases on metadata write failure", async () => {
    if (process.platform === "win32") return;
    const aliasRoot = temp.make("alias-rollback-");
    const aliasPath = join(aliasRoot, "packs");
    const aliasDotGit = join(aliasRoot, "packs.git");
    await initRepo(aliasDotGit);
    const aliasV1 = await commitPack(aliasDotGit, "team", "Alias v1.");
    const aliasCache = temp.make("cache-alias-rollback-");
    const a1 = await fetchSource({ name: "team", repo: aliasPath, ref: aliasV1 }, aliasCache);
    if ("error" in a1) throw new Error(a1.error);
    const aliasV2 = await commitPack(aliasDotGit, "team", "Alias v2.");
    const goodFile = join(aliasCache, "team", ".git", "hedge-source.json");
    const savedGood = readFileSync(goodFile);
    rmSync(goodFile);
    mkdirSync(goodFile);
    try {
      const a2 = await fetchSource({ name: "team", repo: aliasPath, ref: aliasV2 }, aliasCache);
      expect("error" in a2).toBe(true);
    } finally {
      rmSync(goodFile, { recursive: true, force: true });
      writeFileSync(goodFile, savedGood);
    }
    rmSync(aliasDotGit, { recursive: true, force: true });
    const offlineAfterRollback = await fetchSource({ name: "team", repo: aliasPath, ref: aliasV1 }, aliasCache);
    if ("error" in offlineAfterRollback) throw new Error(offlineAfterRollback.error);
    expect([offlineAfterRollback.packs[0]?.manifest.summary, offlineAfterRollback.stale]).toEqual(["Alias v1.", undefined]);
  });

  test("keeps followsBranch true for 40-hex SHA-256 branches and for hex branches matching only a foreign repository's cached commit", async () => {
    const sha256Repo = temp.make("sha256-40hex-branch-");
    await spawnGit(sha256Repo, "init", "-q", "--object-format=sha256", "-b", "main");
    await spawnGit(sha256Repo, "config", "user.email", "test@example.com");
    await spawnGit(sha256Repo, "config", "user.name", "Test");
    writePack(sha256Repo, "SHA-256 branch v1.");
    await spawnGit(sha256Repo, "add", ".");
    await spawnGit(sha256Repo, "commit", "-qm", "v1");
    const c1 = await spawnGit(sha256Repo, "rev-parse", "HEAD");
    const prefix40 = c1.slice(0, 40);
    await spawnGit(sha256Repo, "checkout", "-q", "-b", prefix40);
    const branchCache = temp.make("cache-sha256-40hex-");
    const loadedBranch = await fetchSource({ name: "team", repo: sha256Repo, ref: `refs/heads/${prefix40}` }, branchCache);
    if ("error" in loadedBranch) throw new Error(loadedBranch.error);
    expect(await followsBranch({ name: "team", repo: sha256Repo, ref: prefix40 }, branchCache)).toBe(true);

    const foreignRepo = temp.make("foreign-hex-a-");
    await initRepo(foreignRepo);
    const foreignSha = await commitPack(foreignRepo, "team", "Foreign repo.");
    const currentRepo = temp.make("foreign-hex-b-");
    await initRepo(currentRepo);
    await commitPack(currentRepo, "team", "Current repo v1.");
    await spawnGit(currentRepo, "checkout", "-q", "-b", foreignSha);
    const sharedCache = temp.make("cache-foreign-hex-");
    expect("error" in (await fetchSource({ name: "team", repo: foreignRepo, ref: foreignSha }, sharedCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: currentRepo, ref: `refs/heads/${foreignSha}` }, sharedCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: currentRepo, ref: foreignSha }, sharedCache)).toBe(true);
  });

  test("keeps cached linked worktrees, .git symlinks, and direct gitfiles working offline and rejects replacement repos", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("offline-indirect-");
    const mainRepo = join(root, "main-repo");
    await initRepo(mainRepo);
    const shaMain = await commitPack(mainRepo, "team", "Worktree pack.");

    const worktreeDir = join(root, "linked-wt");
    await spawnGit(mainRepo, "worktree", "add", "-q", "-b", "wt-branch", worktreeDir, "HEAD");

    const wtPinCache = temp.make("cache-wt-pin-");
    const wtPin = await fetchSource({ name: "team", repo: worktreeDir, ref: shaMain }, wtPinCache);
    if ("error" in wtPin) throw new Error(wtPin.error);
    expect([wtPin.packs[0]?.manifest.summary, wtPin.stale]).toEqual(["Worktree pack.", undefined]);

    const wtBranchCache = temp.make("cache-wt-branch-");
    const wtBranch = await fetchSource({ name: "team", repo: worktreeDir, ref: "main" }, wtBranchCache);
    if ("error" in wtBranch) throw new Error(wtBranch.error);
    expect([wtBranch.packs[0]?.manifest.summary, wtBranch.stale]).toEqual(["Worktree pack.", undefined]);

    rmSync(worktreeDir, { recursive: true, force: true });
    const wtOfflinePin = await fetchSource({ name: "team", repo: worktreeDir, ref: shaMain }, wtPinCache);
    if ("error" in wtOfflinePin) throw new Error(wtOfflinePin.error);
    expect([wtOfflinePin.packs[0]?.manifest.summary, wtOfflinePin.stale]).toEqual(["Worktree pack.", undefined]);

    const wtOfflineBranch = await fetchSource({ name: "team", repo: worktreeDir, ref: "main" }, wtBranchCache);
    if ("error" in wtOfflineBranch) throw new Error(wtOfflineBranch.error);
    expect(wtOfflineBranch.packs[0]?.manifest.summary).toBe("Worktree pack.");
    expect(wtOfflineBranch.stale).toContain("could not fetch main");

    await initRepo(worktreeDir);
    await commitPack(worktreeDir, "team", "Replacement repo.");
    expect("error" in (await fetchSource({ name: "team", repo: worktreeDir, ref: shaMain }, wtPinCache))).toBe(true);

    const symWork = join(root, "sym-work");
    mkdirSync(symWork, { recursive: true });
    symlinkSync(join(mainRepo, ".git"), join(symWork, ".git"));
    const symCache = temp.make("cache-sym-offline-");
    const symFirst = await fetchSource({ name: "team", repo: symWork, ref: shaMain }, symCache);
    if ("error" in symFirst) throw new Error(symFirst.error);
    rmSync(symWork, { recursive: true, force: true });
    const symOffline = await fetchSource({ name: "team", repo: symWork, ref: shaMain }, symCache);
    if ("error" in symOffline) throw new Error(symOffline.error);
    expect([symOffline.packs[0]?.manifest.summary, symOffline.stale]).toEqual(["Worktree pack.", undefined]);
    await initRepo(symWork);
    await commitPack(symWork, "team", "Replacement sym.");
    expect("error" in (await fetchSource({ name: "team", repo: symWork, ref: shaMain }, symCache))).toBe(true);

    const directPtr = join(root, "direct-ptr");
    writeFileSync(directPtr, `gitdir: ${join(mainRepo, ".git")}\n`);
    const directCache = temp.make("cache-direct-offline-");
    const directFirst = await fetchSource({ name: "team", repo: directPtr, ref: shaMain }, directCache);
    if ("error" in directFirst) throw new Error(directFirst.error);
    rmSync(directPtr, { force: true });
    const directOffline = await fetchSource({ name: "team", repo: directPtr, ref: shaMain }, directCache);
    if ("error" in directOffline) throw new Error(directOffline.error);
    expect([directOffline.packs[0]?.manifest.summary, directOffline.stale]).toEqual(["Worktree pack.", undefined]);

    const repointWork = join(root, "repoint-work");
    const otherRepo = join(root, "other-repo");
    await initRepo(otherRepo);
    const shaOther = await commitPack(otherRepo, "team", "Other repo.");
    mkdirSync(repointWork, { recursive: true });
    symlinkSync(join(mainRepo, ".git"), join(repointWork, ".git"));
    const repointCache = temp.make("cache-repoint-unreachable-");
    expect("error" in (await fetchSource({ name: "team", repo: repointWork, ref: shaMain }, repointCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: otherRepo, ref: shaOther }, repointCache))).toBe(false);
    rmSync(join(repointWork, ".git"));
    symlinkSync(join(root, "missing-repo", ".git"), join(repointWork, ".git"));
    expect("error" in (await fetchSource({ name: "team", repo: repointWork, ref: shaMain }, repointCache))).toBe(true);
  });

  test("resolves percent-encoded file:// path boundaries offline", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-pct-boundary-");
    const pctRepo = join(root, "pct-repo");
    await initRepo(pctRepo);
    const pctSha = await commitPack(pctRepo, "team", "Percent boundary.");
    const pctCache = temp.make("cache-pct-boundary-");
    const encodedBoundary = `file://localhost%2F${pctRepo.replace(/^\//, "")}`;
    const loadedPct = await fetchSource({ name: "team", repo: encodedBoundary, ref: pctSha }, pctCache);
    if ("error" in loadedPct) throw new Error(loadedPct.error);
    expect(loadedPct.packs[0]?.manifest.summary).toBe("Percent boundary.");
    rmSync(pctRepo, { recursive: true, force: true });
    const offlinePct = await fetchSource({ name: "team", repo: `file://${pctRepo}`, ref: pctSha }, pctCache);
    if ("error" in offlinePct) throw new Error(offlinePct.error);
    expect([offlinePct.packs[0]?.manifest.summary, offlinePct.stale]).toEqual(["Percent boundary.", undefined]);
  });

  test("separates outer bare repos from removed inner .git directories", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-bare-inner-");
    const outerSrc = join(root, "bare-outer-src");
    await initRepo(outerSrc);
    const outerSha = await commitPack(outerSrc, "team", "Outer bare repo.");
    const hybrid = join(root, "bare-with-dotgit");
    mkdirSync(hybrid, { recursive: true });
    await spawnGit(hybrid, "init", "--bare", "-q", "-b", "main");
    await spawnGit(outerSrc, "push", "-q", hybrid, "main");
    await spawnGit(hybrid, "init", "-q", "-b", "main");
    await spawnGit(hybrid, "config", "user.email", "test@example.com");
    await spawnGit(hybrid, "config", "user.name", "Test");
    const innerSha = await commitPack(hybrid, "team", "Inner dotgit repo.");
    const hybridCache = temp.make("cache-bare-inner-");
    expect("error" in (await fetchSource({ name: "team", repo: hybrid, ref: innerSha }, hybridCache))).toBe(false);
    rmSync(join(hybrid, ".git"), { recursive: true, force: true });
    expect("error" in (await fetchSource({ name: "team", repo: `${hybrid}/`, ref: innerSha }, hybridCache))).toBe(true);
    const loadedOuter = await fetchSource({ name: "team", repo: `${hybrid}/`, ref: outerSha }, hybridCache);
    if ("error" in loadedOuter) throw new Error(loadedOuter.error);
    expect(loadedOuter.packs[0]?.manifest.summary).toBe("Outer bare repo.");
  });

  test("loads a cached pin offline after a repository symlink is removed", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-deleted-symlink-");
    const realCheckout = join(root, "real-checkout");
    await initRepo(realCheckout);
    const realSha = await commitPack(realCheckout, "team", "Through symlink.");
    const checkoutLink = join(root, "checkout-link");
    symlinkSync(realCheckout, checkoutLink);
    const linkCache = temp.make("cache-deleted-symlink-");
    expect("error" in (await fetchSource({ name: "team", repo: checkoutLink, ref: realSha }, linkCache))).toBe(false);
    rmSync(checkoutLink);
    const offlineAfterLinkRemoved = await fetchSource({ name: "team", repo: checkoutLink, ref: realSha }, linkCache);
    if ("error" in offlineAfterLinkRemoved) throw new Error(offlineAfterLinkRemoved.error);
    expect([offlineAfterLinkRemoved.packs[0]?.manifest.summary, offlineAfterLinkRemoved.stale]).toEqual(["Through symlink.", undefined]);
  });

  test("rejects +refs/tags/release as a branch when both a tag and branch share the name", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-tag-vs-branch-");
    const tagBranchRepo = join(root, "tag-vs-branch");
    await initRepo(tagBranchRepo);
    await spawnGit(tagBranchRepo, "checkout", "-q", "-b", "refs/tags/release");
    const tb1 = await commitPack(tagBranchRepo, "team", "Branch v1.");
    await spawnGit(tagBranchRepo, "tag", "release", tb1);
    const tbCache = temp.make("cache-tag-vs-branch-");
    expect("error" in (await fetchSource({ name: "team", repo: tagBranchRepo, ref: "refs/heads/refs/tags/release" }, tbCache))).toBe(false);
    expect(await followsBranch({ name: "team", repo: tagBranchRepo, ref: "+refs/tags/release" }, tbCache)).toBe(false);
    await commitPack(tagBranchRepo, "team", "Branch v2.");
    const refusedTagAdvance = await advanceSource({ name: "team", repo: tagBranchRepo, ref: "+refs/tags/release" }, tbCache, tb1);
    expect(refusedTagAdvance.state).toBe("failed");
  });

  test("isolates shallow side-branch merge ancestors from foreign cached pins", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-shallow-side-");
    const foreignRepo = join(root, "foreign-deep");
    await initRepo(foreignRepo);
    const deepA = await commitPack(foreignRepo, "team", "Foreign deep A.");
    const deepB = await commitPack(foreignRepo, "team", "Foreign deep B.");
    const shallowSrc = join(root, "shallow-merge-src");
    await initRepo(shallowSrc);
    const baseShallow = await commitPack(shallowSrc, "team", "Shallow base.");
    await spawnGit(shallowSrc, "fetch", "-q", "--depth", "1", `file://${foreignRepo}`, deepB);
    await spawnGit(shallowSrc, "merge", "-q", "-X", "theirs", "--allow-unrelated-histories", "-m", "merge side", "FETCH_HEAD");
    const mergedTip = await spawnGit(shallowSrc, "rev-parse", "HEAD");
    await spawnGit(shallowSrc, "update-ref", "refs/heads/main", baseShallow);
    const shallowCache = temp.make("cache-shallow-side-");
    expect("error" in (await fetchSource({ name: "team", repo: foreignRepo, ref: deepB }, shallowCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: foreignRepo, ref: deepA }, shallowCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: shallowSrc, ref: "main" }, shallowCache))).toBe(false);
    await spawnGit(shallowSrc, "update-ref", "refs/heads/main", mergedTip);
    const advShallow = await advanceSource({ name: "team", repo: shallowSrc, ref: "main" }, shallowCache, baseShallow);
    expect(advShallow.state).toBe("moved");
    rmSync(shallowSrc, { recursive: true, force: true });
    const offlineDeepA = await fetchSource({ name: "team", repo: shallowSrc, ref: deepA }, shallowCache);
    if ("error" in offlineDeepA) throw new Error(offlineDeepA.error);
    expect(offlineDeepA.stale).toContain(`could not fetch ${deepA}`);
    expect(offlineDeepA.packs[0]?.manifest.summary).toBe("Foreign deep B.");
    const loadedMerged = await fetchSource({ name: "team", repo: shallowSrc, ref: mergedTip }, shallowCache);
    if ("error" in loadedMerged) throw new Error(loadedMerged.error);
    expect([loadedMerged.packs[0]?.manifest.summary, loadedMerged.stale]).toEqual(["Foreign deep B.", undefined]);
  });

  test("rejects an unresolved ~user source without hitting a literal ~user pin", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-unresolved-tilde-");
    const tildeWork = join(root, "tilde-host");
    const literalTilde = join(tildeWork, "~hedge_nonexistent_user_999", "repo");
    await initRepo(literalTilde);
    const tildeSha = await commitPack(literalTilde, "team", "Literal tilde repo.");
    const tildeCache = temp.make("cache-unresolved-tilde-");
    mkdirSync(join(tildeCache, "team", "~hedge_nonexistent_user_999"), { recursive: true });
    symlinkSync(literalTilde, join(tildeCache, "team", "~hedge_nonexistent_user_999", "repo"));
    expect("error" in (await fetchSource({ name: "team", repo: literalTilde, ref: tildeSha }, tildeCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: "~hedge_nonexistent_user_999/repo", ref: tildeSha }, tildeCache))).toBe(true);
  });

  test("loads a cached pin offline after a parent directory symlink is removed", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-parent-symlink-");
    const parentReal = join(root, "parent-real");
    const parentRepo = join(parentReal, "repo");
    await initRepo(parentRepo);
    const parentSha = await commitPack(parentRepo, "team", "Through parent symlink.");
    const parentLink = join(root, "parent-link");
    symlinkSync(parentReal, parentLink);
    const parentLinkRepo = join(parentLink, "repo");
    const parentCache = temp.make("cache-parent-symlink-");
    expect("error" in (await fetchSource({ name: "team", repo: parentLinkRepo, ref: parentSha }, parentCache))).toBe(false);
    rmSync(parentLink);
    const offlineParentMissing = await fetchSource({ name: "team", repo: parentLinkRepo, ref: parentSha }, parentCache);
    if ("error" in offlineParentMissing) throw new Error(offlineParentMissing.error);
    expect([offlineParentMissing.packs[0]?.manifest.summary, offlineParentMissing.stale]).toEqual(["Through parent symlink.", undefined]);
  });

  test("does not alias a symlink/.. path to its lexical path", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-dotdot-alias-");
    const dotDotTarget = join(root, "dd-target");
    const dotDotLeaf = join(dotDotTarget, "leaf");
    const dotDotReal = join(dotDotTarget, "repo");
    mkdirSync(dotDotLeaf, { recursive: true });
    await initRepo(dotDotReal);
    const ddSha = await commitPack(dotDotReal, "team", "Target dotdot repo.");
    const ddLink = join(root, "dd-link");
    symlinkSync(dotDotLeaf, ddLink);
    const ddCache = temp.make("cache-dotdot-alias-");
    expect("error" in (await fetchSource({ name: "team", repo: `${ddLink}/../repo`, ref: ddSha }, ddCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: join(root, "repo"), ref: ddSha }, ddCache))).toBe(true);
  });

  test("does not report a retained SHA-256 pin as unpinned in doctor after another SHA-256 repository uses the same source name", async () => {
    const repoA = temp.make("retained-sha256-a-");
    await spawnGit(repoA, "init", "-q", "-b", "main", "--object-format=sha256");
    await spawnGit(repoA, "config", "user.email", "test@example.com");
    await spawnGit(repoA, "config", "user.name", "Test");
    const shaA = await commitPack(repoA, "team", "SHA-256 A.");

    const repoB = temp.make("retained-sha256-b-");
    await spawnGit(repoB, "init", "-q", "-b", "main", "--object-format=sha256");
    await spawnGit(repoB, "config", "user.email", "test@example.com");
    await spawnGit(repoB, "config", "user.name", "Test");
    const shaB = await commitPack(repoB, "team", "SHA-256 B.");

    const profileDir = temp.make("retained-sha256-profile-");
    await initRepo(profileDir);
    const cache = temp.make("cache-retained-sha256-");

    const first = await fetchSource({ name: "team", repo: repoA, ref: shaA }, cache);
    if ("error" in first) throw new Error(first.error);
    const second = await fetchSource({ name: "team", repo: repoB, ref: shaB }, cache);
    if ("error" in second) throw new Error(second.error);

    rmSync(repoA, { recursive: true, force: true });
    expect(await unpinnedSources([{ name: "team", repo: repoA, ref: shaA }], profileDir, cache)).toEqual([]);

    const offlineA = await fetchSource({ name: "team", repo: repoA, ref: shaA }, cache);
    if ("error" in offlineA) throw new Error(offlineA.error);
    expect([offlineA.packs[0]?.manifest.summary, offlineA.stale]).toEqual(["SHA-256 A.", undefined]);
  });

  test("fails closed on symlink aliases and falls back as stale without blocking the event loop when local probing times out", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-stalled-probe-");
    const repo = join(root, "nfs-repo");
    await initRepo(repo);
    const sha = await commitPack(repo, "team", "Cached NFS pin.");
    const cache = temp.make("cache-stalled-probe-");
    const initial = await fetchSource({ name: "team", repo, ref: sha }, cache);
    if ("error" in initial) throw new Error(initial.error);

    const readyFifo = join(root, "probe-ready");
    const goneFifo = join(root, "probe-gone");
    expect(Bun.spawnSync(["mkfifo", readyFifo, goneFifo]).exitCode).toBe(0);
    const hungScript = join(root, "hung-probe.ts");
    writeFileSync(
      hungScript,
      `import { openSync, writeFileSync } from "node:fs";
const fd = openSync(${JSON.stringify(goneFifo)}, "w");
void fd;
writeFileSync(${JSON.stringify(readyFifo)}, "started\\n");
await new Promise(() => {});
`,
    );
    const readyProc = Bun.spawn(["cat", readyFifo], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const goneProc = Bun.spawn(["cat", goneFifo], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const readyText = new Response(readyProc.stdout).text();
    const fifoClosed = new Response(goneProc.stdout).text();
    let fireTimeout!: () => void;
    const deadline = new Promise<void>((resolve) => {
      fireTimeout = resolve;
    });
    let fetchSettled = false;
    try {
      const fetchPromise = fetchSource({ name: "team", repo, ref: sha }, cache, undefined, undefined, (dir, effective) =>
        probeLocalRepoInfo(dir, effective, 0, hungScript, deadline),
      ).finally(() => {
        fetchSettled = true;
      });
      expect((await readyText).trim()).toBe("started");
      expect(fetchSettled).toBe(false);
      fireTimeout();
      const loaded = await fetchPromise;
      if ("error" in loaded) throw new Error(loaded.error);
      expect(loaded.packs[0]?.manifest.summary).toBe("Cached NFS pin.");
      expect(loaded.stale).toContain("timed out inspecting local repository");
      expect(await fifoClosed).toBe("");
    } finally {
      try {
        readyProc.kill("SIGKILL");
      } catch {}
      try {
        goneProc.kill("SIGKILL");
      } catch {}
    }

    const mirrorLink = join(root, "mirror-link");
    symlinkSync(repo, mirrorLink);
    const mirrorCache = temp.make("cache-stalled-mirror-");
    expect("error" in (await fetchSource({ name: "team", repo: mirrorLink, ref: sha }, mirrorCache))).toBe(false);
    const mirrorRepoB = join(root, "nfs-repo-b");
    await initRepo(mirrorRepoB);
    await commitPack(mirrorRepoB, "team", "Other NFS repo.");
    rmSync(mirrorLink);
    symlinkSync(mirrorRepoB, mirrorLink);
    const mirrorReadyFifo = join(root, "mirror-ready");
    const mirrorGoneFifo = join(root, "mirror-gone");
    expect(Bun.spawnSync(["mkfifo", mirrorReadyFifo, mirrorGoneFifo]).exitCode).toBe(0);
    const mirrorHungScript = join(root, "hung-mirror-probe.ts");
    writeFileSync(
      mirrorHungScript,
      `import { openSync, writeFileSync } from "node:fs";
const fd = openSync(${JSON.stringify(mirrorGoneFifo)}, "w");
void fd;
writeFileSync(${JSON.stringify(mirrorReadyFifo)}, "started\\n");
await new Promise(() => {});
`,
    );
    const mirrorReadyProc = Bun.spawn(["cat", mirrorReadyFifo], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const mirrorGoneProc = Bun.spawn(["cat", mirrorGoneFifo], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const mirrorReadyText = new Response(mirrorReadyProc.stdout).text();
    const mirrorClosed = new Response(mirrorGoneProc.stdout).text();
    let fireMirrorTimeout!: () => void;
    const mirrorDeadline = new Promise<void>((resolve) => {
      fireMirrorTimeout = resolve;
    });
    try {
      const stalledMirrorPromise = fetchSource({ name: "team", repo: mirrorLink, ref: sha }, mirrorCache, undefined, undefined, (dir, effective) =>
        probeLocalRepoInfo(dir, effective, 0, mirrorHungScript, mirrorDeadline),
      );
      expect((await mirrorReadyText).trim()).toBe("started");
      fireMirrorTimeout();
      const stalledMirror = await stalledMirrorPromise;
      expect("error" in stalledMirror).toBe(true);
      expect(await mirrorClosed).toBe("");
    } finally {
      try {
        mirrorReadyProc.kill("SIGKILL");
      } catch {}
      try {
        mirrorGoneProc.kill("SIGKILL");
      } catch {}
    }
  });

  test("fails closed instead of reusing a symlink alias when a parent directory becomes inaccessible", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = temp.make("git-eacces-parent-");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await initRepo(repoA);
    await initRepo(repoB);
    const shaA = await commitPack(repoA, "team", "Accessible A.");
    await commitPack(repoB, "team", "Accessible B.");
    const gate = join(root, "gate");
    mkdirSync(gate, { recursive: true });
    const link = join(gate, "mirror");
    symlinkSync(repoA, link);
    const cache = temp.make("cache-eacces-parent-");
    const initial = await fetchSource({ name: "team", repo: link, ref: shaA }, cache);
    if ("error" in initial) throw new Error(initial.error);
    rmSync(link);
    symlinkSync(repoB, link);
    chmodSync(gate, 0o000);
    try {
      const blocked = await fetchSource({ name: "team", repo: link, ref: shaA }, cache);
      expect("error" in blocked).toBe(true);
    } finally {
      chmodSync(gate, 0o755);
    }
  });

  test("applies a relative source path on first fetch before the cache directory exists", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-rel-first-");
    const upstream = join(root, "upstream", "packs");
    await initRepo(upstream);
    const sha = await commitPack(upstream, "team", "Relative first apply.");
    const cache = join(root, "cache");
    const loaded = await fetchSource({ name: "team", repo: "../../upstream/packs", ref: sha }, cache);
    if ("error" in loaded) throw new Error(loaded.error);
    expect([loaded.packs[0]?.manifest.summary, loaded.stale]).toEqual(["Relative first apply.", undefined]);
  });

  test("refuses to establish verified pins when local probing falls back without timing out", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-probe-fail-closed-");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await initRepo(repoA);
    const shaA = await commitPack(repoA, "team", "Probe fallback A.");
    await initRepo(repoB);
    const shaB = await commitPack(repoB, "team", "Probe fallback B.");
    const link = join(root, "mirror");
    symlinkSync(repoA, link);
    const cache = temp.make("cache-probe-fail-closed-");
    const missingProbe = join(root, "missing-probe.ts");
    const failingProbe = (dir: string, effective: string) => probeLocalRepoInfo(dir, effective, 3_000, missingProbe);
    const failed = await fetchSource({ name: "team", repo: link, ref: shaA }, cache, undefined, undefined, failingProbe);
    expect("error" in failed).toBe(true);
    rmSync(link);
    symlinkSync(repoB, link);
    expect("error" in (await fetchSource({ name: "team", repo: link, ref: shaA }, cache))).toBe(true);
    const okB = await fetchSource({ name: "team", repo: link, ref: shaB }, cache);
    if ("error" in okB) throw new Error(okB.error);
    expect([okB.packs[0]?.manifest.summary, okB.stale]).toEqual(["Probe fallback B.", undefined]);
  });

});
