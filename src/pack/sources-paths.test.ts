import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { advanceSource, fetchSource, followsBranch, unpinnedSources } from "./sources.ts";

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

describe("fetchSource local path resolution and object formats", () => {
  test("matches Git path resolution for symlink parent traversal, dangling parent symlinks, and implicit .git directories", async () => {
    const repoA = await packRepo("Mirror A.");
    const shaA = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Mirror B.");
    const mirrorDir = temp.make("mirror-link-");
    const mirror = join(mirrorDir, "mirror");
    symlinkSync(repoA, mirror);
    const cache = temp.make("cache-symlink-mirror-");

    const first = await fetchSource({ name: "team", repo: mirror, ref: shaA }, cache);
    if ("error" in first) throw new Error(first.error);
    expect([first.packs[0]?.manifest.summary, first.stale]).toEqual(["Mirror A.", undefined]);

    rmSync(mirror);
    symlinkSync(repoB, mirror);
    const second = await fetchSource({ name: "team", repo: mirror, ref: shaA }, cache);
    expect("error" in second).toBe(true);

    const fileCache = temp.make("cache-file-symlink-mirror-");
    rmSync(mirror);
    symlinkSync(repoA, mirror);
    const fileUrl = `file://${mirror}`;
    const firstFile = await fetchSource({ name: "team", repo: fileUrl, ref: shaA }, fileCache);
    if ("error" in firstFile) throw new Error(firstFile.error);
    expect([firstFile.packs[0]?.manifest.summary, firstFile.stale]).toEqual(["Mirror A.", undefined]);
    rmSync(mirror);
    symlinkSync(repoB, mirror);
    const secondFile = await fetchSource({ name: "team", repo: fileUrl, ref: shaA }, fileCache);
    expect("error" in secondFile).toBe(true);

    const dotDotRoot = temp.make("dotdot-symlink-");
    const directRepo = join(dotDotRoot, "repo");
    const targetParent = join(dotDotRoot, "target-parent");
    const linkedSiblingRepo = join(targetParent, "repo");
    const linkedLeaf = join(targetParent, "leaf");
    mkdirSync(linkedLeaf, { recursive: true });
    for (const [dir, summary] of [
      [directRepo, "Direct sibling repo."],
      [linkedSiblingRepo, "Linked parent sibling repo."],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      await spawnGit(dir, "init", "-q", "-b", "main");
      writePack(dir, summary);
      await spawnGit(dir, "add", ".");
      await spawnGit(dir, "commit", "-q", "-m", "v1");
    }
    const directSha = await spawnGit(directRepo, "rev-parse", "HEAD");
    const link = join(dotDotRoot, "link");
    symlinkSync(linkedLeaf, link);
    const dotDotCache = temp.make("cache-dotdot-symlink-");
    const loadedDirect = await fetchSource({ name: "team", repo: directRepo, ref: directSha }, dotDotCache);
    if ("error" in loadedDirect) throw new Error(loadedDirect.error);
    expect([loadedDirect.packs[0]?.manifest.summary, loadedDirect.stale]).toEqual(["Direct sibling repo.", undefined]);
    const traversed = await fetchSource({ name: "team", repo: `${link}/../repo`, ref: directSha }, dotDotCache);
    expect("error" in traversed).toBe(true);

    const parentLinkRoot = temp.make("dangling-parent-link-");
    const realTarget = join(parentLinkRoot, "target");
    const nestedRepo = join(realTarget, "repo");
    mkdirSync(nestedRepo, { recursive: true });
    await spawnGit(nestedRepo, "init", "-q", "-b", "main");
    writePack(nestedRepo, "Parent link repo.");
    await spawnGit(nestedRepo, "add", ".");
    await spawnGit(nestedRepo, "commit", "-q", "-m", "v1");
    const nestedSha = await spawnGit(nestedRepo, "rev-parse", "HEAD");
    const parentLink = join(parentLinkRoot, "link");
    symlinkSync(realTarget, parentLink);
    const parentLinkCache = temp.make("cache-dangling-parent-");
    const viaParentLink = await fetchSource({ name: "team", repo: join(parentLink, "repo"), ref: nestedSha }, parentLinkCache);
    if ("error" in viaParentLink) throw new Error(viaParentLink.error);
    rmSync(realTarget, { recursive: true, force: true });
    const offlineViaDanglingParent = await fetchSource({ name: "team", repo: join(parentLink, "repo"), ref: nestedSha }, parentLinkCache);
    if ("error" in offlineViaDanglingParent) throw new Error(offlineViaDanglingParent.error);
    expect([offlineViaDanglingParent.packs[0]?.manifest.summary, offlineViaDanglingParent.stale]).toEqual(["Parent link repo.", undefined]);

    const implicitRoot = temp.make("implicit-git-dir-");
    const bareDir = join(implicitRoot, "packs.git");
    const plainDir = join(implicitRoot, "packs");
    mkdirSync(bareDir, { recursive: true });
    await spawnGit(bareDir, "init", "-q", "-b", "main");
    writePack(bareDir, "Implicit dotgit repo.");
    await spawnGit(bareDir, "add", ".");
    await spawnGit(bareDir, "commit", "-q", "-m", "v1");
    const bareSha = await spawnGit(bareDir, "rev-parse", "HEAD");
    const implicitCache = temp.make("cache-implicit-git-");
    const loadedImplicit = await fetchSource({ name: "team", repo: plainDir, ref: bareSha }, implicitCache);
    if ("error" in loadedImplicit) throw new Error(loadedImplicit.error);
    expect([loadedImplicit.packs[0]?.manifest.summary, loadedImplicit.stale]).toEqual(["Implicit dotgit repo.", undefined]);
    mkdirSync(plainDir, { recursive: true });
    await spawnGit(plainDir, "init", "-q", "-b", "main");
    writePack(plainDir, "New plain repo.");
    await spawnGit(plainDir, "add", ".");
    await spawnGit(plainDir, "commit", "-q", "-m", "v1");
    const afterPlainCreated = await fetchSource({ name: "team", repo: plainDir, ref: bareSha }, implicitCache);
    expect("error" in afterPlainCreated).toBe(true);

    const ordinaryRoot = temp.make("ordinary-dir-dotgit-");
    const ordPlain = join(ordinaryRoot, "packs");
    const ordDotGit = join(ordinaryRoot, "packs.git");
    mkdirSync(ordPlain, { recursive: true });
    mkdirSync(ordDotGit, { recursive: true });
    await spawnGit(ordDotGit, "init", "-q", "-b", "main");
    writePack(ordDotGit, "DotGit behind ordinary dir.");
    await spawnGit(ordDotGit, "add", ".");
    await spawnGit(ordDotGit, "commit", "-q", "-m", "v1");
    const ordSha = await spawnGit(ordDotGit, "rev-parse", "HEAD");
    const ordCache = temp.make("cache-ordinary-dir-");
    const ordFirst = await fetchSource({ name: "team", repo: ordPlain, ref: ordSha }, ordCache);
    if ("error" in ordFirst) throw new Error(ordFirst.error);
    expect([ordFirst.packs[0]?.manifest.summary, ordFirst.stale]).toEqual(["DotGit behind ordinary dir.", undefined]);
    rmSync(ordDotGit, { recursive: true, force: true });
    const ordOffline = await fetchSource({ name: "team", repo: ordPlain, ref: ordSha }, ordCache);
    if ("error" in ordOffline) throw new Error(ordOffline.error);
    expect([ordOffline.packs[0]?.manifest.summary, ordOffline.stale]).toEqual(["DotGit behind ordinary dir.", undefined]);
    await spawnGit(ordPlain, "init", "-q", "-b", "main");
    writePack(ordPlain, "Replaced plain repo.");
    await spawnGit(ordPlain, "add", ".");
    await spawnGit(ordPlain, "commit", "-q", "-m", "v1");
    const ordAfterInit = await fetchSource({ name: "team", repo: ordPlain, ref: ordSha }, ordCache);
    expect("error" in ordAfterInit).toBe(true);

    const aliasRoot = temp.make("alias-dotgit-");
    const aliasTarget = join(aliasRoot, "target");
    const aliasDotGit = join(aliasRoot, "alias.git");
    const targetDotGit = join(aliasRoot, "target.git");
    mkdirSync(aliasTarget, { recursive: true });
    for (const [repoDir, summary] of [
      [aliasDotGit, "Alias dotgit repo."],
      [targetDotGit, "Target dotgit repo."],
    ] as const) {
      mkdirSync(repoDir, { recursive: true });
      await spawnGit(repoDir, "init", "-q", "-b", "main");
      writePack(repoDir, summary);
      await spawnGit(repoDir, "add", ".");
      await spawnGit(repoDir, "commit", "-q", "-m", "v1");
    }
    const aliasSha = await spawnGit(aliasDotGit, "rev-parse", "HEAD");
    const aliasLink = join(aliasRoot, "alias");
    symlinkSync(aliasTarget, aliasLink);
    const aliasCache = temp.make("cache-alias-dotgit-");
    const loadedAlias = await fetchSource({ name: "team", repo: aliasLink, ref: aliasSha }, aliasCache);
    if ("error" in loadedAlias) throw new Error(loadedAlias.error);
    expect([loadedAlias.packs[0]?.manifest.summary, loadedAlias.stale]).toEqual(["Alias dotgit repo.", undefined]);
    const wrongTarget = await fetchSource({ name: "team", repo: targetDotGit, ref: aliasSha }, aliasCache);
    expect("error" in wrongTarget).toBe(true);

    const authRoot = temp.make("file-auth-mirror-");
    const authLink = join(authRoot, "mirror");
    symlinkSync(repoA, authLink);
    const authUrl = `file://example.invalid${authLink}`;
    const authCache = temp.make("cache-file-auth-");
    const authFirst = await fetchSource({ name: "team", repo: authUrl, ref: shaA }, authCache);
    if ("error" in authFirst) throw new Error(authFirst.error);
    rmSync(authLink);
    symlinkSync(repoB, authLink);
    const authSecond = await fetchSource({ name: "team", repo: authUrl, ref: shaA }, authCache);
    expect("error" in authSecond).toBe(true);

    const retryRoot = temp.make("sha256-retry-");
    const hex64 = "a".repeat(64);
    const lateSha1 = join(retryRoot, "late-sha1");
    const lateSha1Cache = temp.make("cache-late-sha1-");
    expect("error" in (await fetchSource({ name: "team", repo: lateSha1, ref: hex64 }, lateSha1Cache))).toBe(true);
    mkdirSync(lateSha1, { recursive: true });
    await spawnGit(lateSha1, "init", "-q", "-b", hex64);
    writePack(lateSha1, "Late SHA-1 hex64 branch.");
    await spawnGit(lateSha1, "add", ".");
    await spawnGit(lateSha1, "commit", "-q", "-m", "v1");
    const loadedLateSha1 = await fetchSource({ name: "team", repo: lateSha1, ref: hex64 }, lateSha1Cache);
    if ("error" in loadedLateSha1) throw new Error(loadedLateSha1.error);
    expect(loadedLateSha1.packs[0]?.manifest.summary).toBe("Late SHA-1 hex64 branch.");

    const lateSha256 = join(retryRoot, "late-sha256");
    const lateSha256Cache = temp.make("cache-late-sha256-");
    expect("error" in (await fetchSource({ name: "team", repo: lateSha256, ref: "main" }, lateSha256Cache))).toBe(true);
    mkdirSync(lateSha256, { recursive: true });
    await spawnGit(lateSha256, "init", "-q", "--object-format=sha256", "-b", "main");
    writePack(lateSha256, "Late SHA-256 main.");
    await spawnGit(lateSha256, "add", ".");
    await spawnGit(lateSha256, "commit", "-q", "-m", "v1");
    const loadedLateSha256 = await fetchSource({ name: "team", repo: lateSha256, ref: "main" }, lateSha256Cache);
    if ("error" in loadedLateSha256) throw new Error(loadedLateSha256.error);
    expect(loadedLateSha256.packs[0]?.manifest.summary).toBe("Late SHA-256 main.");

    if (process.platform === "linux") {
      const rawRoot = temp.make("raw-bytes-symlink-");
      const targetA = Buffer.concat([Buffer.from(`${rawRoot}/repo-`), Buffer.from([0xff])]);
      const targetB = Buffer.concat([Buffer.from(`${rawRoot}/repo-`), Buffer.from([0xfe])]);
      mkdirSync(targetA, { recursive: true });
      mkdirSync(targetB, { recursive: true });
      const initRaw = async (dirBuf: Buffer, summary: string) => {
        const tmpLink = join(rawRoot, "init-link");
        rmSync(tmpLink, { force: true });
        symlinkSync(dirBuf, tmpLink);
        await spawnGit(tmpLink, "init", "-q", "-b", "main");
        writePack(tmpLink, summary);
        await spawnGit(tmpLink, "add", ".");
        await spawnGit(tmpLink, "commit", "-q", "-m", "v1");
        const sha = await spawnGit(tmpLink, "rev-parse", "HEAD");
        rmSync(tmpLink, { force: true });
        return sha;
      };
      const rawShaA = await initRaw(targetA, "Raw byte A.");
      await initRaw(targetB, "Raw byte B.");
      const rawLink = join(rawRoot, "mirror");
      symlinkSync(targetA, rawLink);
      const rawCache = temp.make("cache-raw-symlink-");
      const rawFirst = await fetchSource({ name: "team", repo: rawLink, ref: rawShaA }, rawCache);
      if ("error" in rawFirst) throw new Error(rawFirst.error);
      expect([rawFirst.packs[0]?.manifest.summary, rawFirst.stale]).toEqual(["Raw byte A.", undefined]);
      rmSync(rawLink);
      symlinkSync(targetB, rawLink);
      const rawSecond = await fetchSource({ name: "team", repo: rawLink, ref: rawShaA }, rawCache);
      expect("error" in rawSecond).toBe(true);
    }
  });

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
    expect(allCommits.length).toBe(262);
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

  test("preserves literal %00 symlink names in file URLs and ignores empty .git directories like Git enter_repo", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("pct-nul-empty-git-");
    const repoA = join(root, "repo");
    const realParent = join(root, "alt", "nested");
    const repoB = join(root, "alt", "repo");
    mkdirSync(realParent, { recursive: true });
    await initRepo(repoA);
    const shaA = await commitPack(repoA, "team", "Direct repo.");
    await initRepo(repoB);
    const shaB = await commitPack(repoB, "team", "Symlinked %00 repo.");
    symlinkSync(realParent, join(root, "%00"));

    const cache = temp.make("cache-pct-nul-");
    const viaNulUrl = `file://${root}/%00/../repo`;
    const first = await fetchSource({ name: "team", repo: viaNulUrl, ref: shaB }, cache);
    if ("error" in first) throw new Error(first.error);
    expect([first.packs[0]?.manifest.summary, first.stale]).toEqual(["Symlinked %00 repo.", undefined]);
    const directUrl = `file://${root}/repo`;
    const wrong = await fetchSource({ name: "team", repo: directUrl, ref: shaB }, cache);
    expect("error" in wrong).toBe(true);

    const emptyRoot = temp.make("empty-dot-git-");
    const candidate = join(emptyRoot, "packs");
    const sibling = join(emptyRoot, "packs.git");
    const third = join(emptyRoot, "third");
    mkdirSync(join(candidate, ".git"), { recursive: true });
    await initRepo(sibling);
    const siblingSha = await commitPack(sibling, "team", "Sibling repo.");
    await initRepo(third);
    const thirdSha = await commitPack(third, "team", "Third repo.");

    const emptyCache = temp.make("cache-empty-dot-git-");
    const fromSibling = await fetchSource({ name: "team", repo: candidate, ref: siblingSha }, emptyCache);
    if ("error" in fromSibling) throw new Error(fromSibling.error);
    expect([fromSibling.packs[0]?.manifest.summary, fromSibling.stale]).toEqual(["Sibling repo.", undefined]);

    const fromThird = await fetchSource({ name: "team", repo: third, ref: thirdSha }, emptyCache);
    if ("error" in fromThird) throw new Error(fromThird.error);
    expect([fromThird.packs[0]?.manifest.summary, fromThird.stale]).toEqual(["Third repo.", undefined]);

    rmSync(candidate, { recursive: true, force: true });
    await initRepo(candidate);
    await commitPack(candidate, "team", "Replacement repo.");
    const replacementCheck = await fetchSource({ name: "team", repo: candidate, ref: siblingSha }, emptyCache);
    expect("error" in replacementCheck).toBe(true);
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
    expect(sha256Commit.length).toBe(64);

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

  test("rejects a non-directory refs file in Git dir detection and recovers an offline implicit .git pin only when previously resolved via implicit .git", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("refs-file-implicit-offline-");
    const fakeDir = join(root, "packs");
    const realSibling = join(root, "packs.git");
    const otherRepo = join(root, "other");
    mkdirSync(join(fakeDir, "objects"), { recursive: true });
    writeFileSync(join(fakeDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(fakeDir, "refs"), "not a directory\n");
    await initRepo(realSibling);
    const siblingSha = await commitPack(realSibling, "team", "Implicit sibling.");
    await initRepo(otherRepo);
    const otherSha = await commitPack(otherRepo, "team", "Other repo.");

    const cache = temp.make("cache-refs-file-implicit-");
    const first = await fetchSource({ name: "team", repo: fakeDir, ref: siblingSha }, cache);
    if ("error" in first) throw new Error(first.error);
    expect([first.packs[0]?.manifest.summary, first.stale]).toEqual(["Implicit sibling.", undefined]);

    const switched = await fetchSource({ name: "team", repo: otherRepo, ref: otherSha }, cache);
    if ("error" in switched) throw new Error(switched.error);
    expect([switched.packs[0]?.manifest.summary, switched.stale]).toEqual(["Other repo.", undefined]);

    rmSync(realSibling, { recursive: true, force: true });
    const recoveredOffline = await fetchSource({ name: "team", repo: fakeDir, ref: siblingSha }, cache);
    if ("error" in recoveredOffline) throw new Error(recoveredOffline.error);
    expect([recoveredOffline.packs[0]?.manifest.summary, recoveredOffline.stale]).toEqual(["Implicit sibling.", undefined]);

    rmSync(fakeDir, { recursive: true, force: true });
    await initRepo(fakeDir);
    await commitPack(fakeDir, "team", "Real replacement.");
    const replacementCheck = await fetchSource({ name: "team", repo: fakeDir, ref: siblingSha }, cache);
    expect("error" in replacementCheck).toBe(true);

    const pairRoot = temp.make("distinct-pair-offline-");
    const pairMain = join(pairRoot, "packs");
    const pairGit = join(pairRoot, "packs.git");
    await initRepo(pairMain);
    const pairMainSha = await commitPack(pairMain, "team", "Distinct main.");
    await initRepo(pairGit);
    const pairGitSha = await commitPack(pairGit, "team", "Distinct dotgit.");
    const pairCache = temp.make("cache-distinct-pair-");
    const p1 = await fetchSource({ name: "team", repo: pairMain, ref: pairMainSha }, pairCache);
    if ("error" in p1) throw new Error(p1.error);
    const p2 = await fetchSource({ name: "team", repo: pairGit, ref: pairGitSha }, pairCache);
    if ("error" in p2) throw new Error(p2.error);
    rmSync(pairMain, { recursive: true, force: true });
    rmSync(pairGit, { recursive: true, force: true });
    const crossSpoof = await fetchSource({ name: "team", repo: pairMain, ref: pairGitSha }, pairCache);
    expect("error" in crossSpoof).toBe(true);
  });

  test("does not collapse parent traversal through a missing or non-directory path component to a sibling repository", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("missing-parent-traversal-");
    const repo = join(root, "repo");
    const regularFile = join(root, "not-a-dir");
    await initRepo(repo);
    const sha = await commitPack(repo, "team", "Sibling repo.");
    writeFileSync(regularFile, "plain file\n");

    const cache = temp.make("cache-missing-parent-");
    const first = await fetchSource({ name: "team", repo, ref: sha }, cache);
    if ("error" in first) throw new Error(first.error);
    expect(first.packs[0]?.manifest.summary).toBe("Sibling repo.");

    const missingTraversal = await fetchSource({ name: "team", repo: `${root}/missing/../repo`, ref: sha }, cache);
    expect("error" in missingTraversal).toBe(true);

    const fileTraversal = await fetchSource({ name: "team", repo: `${root}/not-a-dir/../repo`, ref: sha }, cache);
    expect("error" in fileTraversal).toBe(true);

    const fileUrlTraversal = await fetchSource({ name: "team", repo: `file://${root}/missing/../repo`, ref: sha }, cache);
    expect("error" in fileUrlTraversal).toBe(true);
  });

  test("matches Git local-transport identity for repointed .git symlinks, bare+child precedence, direct gitfiles, and trailing-space gitdir targets", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-identity-");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await initRepo(repoA);
    const shaA = await commitPack(repoA, "team", "Repo A.");
    await initRepo(repoB);
    const shaB = await commitPack(repoB, "team", "Repo B.");

    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    symlinkSync(join(repoA, ".git"), join(work, ".git"));
    const symCache = temp.make("cache-symlink-dotgit-");
    const first = await fetchSource({ name: "team", repo: work, ref: shaA }, symCache);
    if ("error" in first) throw new Error(first.error);
    rmSync(join(work, ".git"));
    symlinkSync(join(repoB, ".git"), join(work, ".git"));
    expect("error" in (await fetchSource({ name: "team", repo: `${work}/`, ref: shaA }, symCache))).toBe(true);

    const bareBoth = join(root, "bare-both");
    mkdirSync(bareBoth, { recursive: true });
    await spawnGit(bareBoth, "init", "--bare", "-q", "-b", "main");
    await spawnGit(repoA, "push", "-q", bareBoth, "main");
    const bareCache = temp.make("cache-bare-prec-");
    expect("error" in (await fetchSource({ name: "team", repo: bareBoth, ref: shaA }, bareCache))).toBe(false);
    symlinkSync(join(repoB, ".git"), join(bareBoth, ".git"));
    expect("error" in (await fetchSource({ name: "team", repo: bareBoth, ref: shaA }, bareCache))).toBe(true);
    expect("error" in (await fetchSource({ name: "team", repo: bareBoth, ref: shaB }, bareCache))).toBe(false);

    const spaceTarget = join(root, "space-target ");
    const plainTarget = join(root, "space-target");
    mkdirSync(spaceTarget, { recursive: true });
    await spawnGit(spaceTarget, "init", "--bare", "-q", "-b", "main");
    await spawnGit(repoB, "push", "-q", spaceTarget, "main");
    mkdirSync(plainTarget, { recursive: true });
    await spawnGit(plainTarget, "init", "--bare", "-q", "-b", "main");
    await spawnGit(repoA, "push", "-q", plainTarget, "main");
    const ptrWork = join(root, "ptr-work");
    mkdirSync(ptrWork, { recursive: true });
    const ptrFile = join(ptrWork, ".git");
    writeFileSync(ptrFile, `gitdir: ${spaceTarget}\n`);
    const ptrCache = temp.make("cache-gitdir-ptr-");
    expect("error" in (await fetchSource({ name: "team", repo: ptrWork, ref: shaB }, ptrCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: plainTarget, ref: shaB }, ptrCache))).toBe(true);

    const directCache = temp.make("cache-direct-gitfile-");
    expect("error" in (await fetchSource({ name: "team", repo: ptrFile, ref: shaB }, directCache))).toBe(false);
    writeFileSync(ptrFile, `gitdir: ${plainTarget}\n`);
    expect("error" in (await fetchSource({ name: "team", repo: ptrFile, ref: shaB }, directCache))).toBe(true);
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

  test("preserves leading spaces after gitdir: separator, resolves packs.git to packs.git.git, rejects FILE://, and handles bundle files without reading them whole", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("git-parity-");
    const plainRepo = join(root, "repo");
    const spaceRepo = join(root, " repo");
    await initRepo(plainRepo);
    const plainSha = await commitPack(plainRepo, "team", "Plain repo.");
    await initRepo(spaceRepo);
    const spaceSha = await commitPack(spaceRepo, "team", "Leading-space repo.");

    const gf = join(root, "ptr");
    writeFileSync(gf, "gitdir:  repo/.git\n");
    const gfCache = temp.make("cache-gf-space-");
    const loadedSpace = await fetchSource({ name: "team", repo: gf, ref: spaceSha }, gfCache);
    if ("error" in loadedSpace) throw new Error(loadedSpace.error);
    expect(loadedSpace.packs[0]?.manifest.summary).toBe("Leading-space repo.");
    writeFileSync(gf, "gitdir: repo/.git\n");
    expect("error" in (await fetchSource({ name: "team", repo: gf, ref: spaceSha }, gfCache))).toBe(true);
    const loadedPlain = await fetchSource({ name: "team", repo: gf, ref: plainSha }, gfCache);
    if ("error" in loadedPlain) throw new Error(loadedPlain.error);
    expect(loadedPlain.packs[0]?.manifest.summary).toBe("Plain repo.");

    const dotGit = join(root, "packs.git");
    const doubleDotGit = join(root, "packs.git.git");
    await initRepo(doubleDotGit);
    const doubleSha = await commitPack(doubleDotGit, "team", "Double dotgit.");
    const dotCache = temp.make("cache-double-dotgit-");
    const fromDouble = await fetchSource({ name: "team", repo: dotGit, ref: doubleSha }, dotCache);
    if ("error" in fromDouble) throw new Error(fromDouble.error);
    expect(fromDouble.packs[0]?.manifest.summary).toBe("Double dotgit.");
    await initRepo(dotGit);
    await commitPack(dotGit, "team", "Direct dotgit.");
    expect("error" in (await fetchSource({ name: "team", repo: dotGit, ref: doubleSha }, dotCache))).toBe(true);

    const fileCache = temp.make("cache-file-case-");
    expect("error" in (await fetchSource({ name: "team", repo: `file://${plainRepo}`, ref: plainSha }, fileCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: `FILE://${plainRepo}`, ref: plainSha }, fileCache))).toBe(true);

    const bundlePath = join(root, "packs.bundle");
    await spawnGit(plainRepo, "bundle", "create", "-q", bundlePath, "HEAD");
    const bundleCache = temp.make("cache-bundle-");
    const fromBundle = await fetchSource({ name: "team", repo: bundlePath, ref: plainSha }, bundleCache);
    if ("error" in fromBundle) throw new Error(fromBundle.error);
    expect(fromBundle.packs[0]?.manifest.summary).toBe("Plain repo.");
    const sparseNonGit = join(root, "huge-non-gitfile");
    writeFileSync(sparseNonGit, "not a gitfile\n");
    truncateSync(sparseNonGit, 64 * 1024 * 1024);
    expect("error" in (await fetchSource({ name: "team", repo: sparseNonGit, ref: plainSha }, bundleCache))).toBe(true);
  });

  test("preserves embedded newlines in gitfile targets and resolves relative gitdir: through symlink chains against the symlink directory", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("gitfile-newline-symlink-");
    const truncated = join(root, "line1");
    const embedded = join(root, "line1\nline2", "repo");
    await initRepo(truncated);
    const truncSha = await commitPack(truncated, "team", "Truncated line1.");
    await initRepo(embedded);
    const embedSha = await commitPack(embedded, "team", "Embedded newline.");

    const nlGitfile = join(root, "nl-ptr");
    writeFileSync(nlGitfile, "gitdir: line1\nline2/repo/.git\r\n\n");
    const nlCache = temp.make("cache-nl-gitfile-");
    const loadedNl = await fetchSource({ name: "team", repo: nlGitfile, ref: embedSha }, nlCache);
    if ("error" in loadedNl) throw new Error(loadedNl.error);
    expect([loadedNl.packs[0]?.manifest.summary, loadedNl.stale]).toEqual(["Embedded newline.", undefined]);
    writeFileSync(nlGitfile, "gitdir: line1/.git\n");
    expect("error" in (await fetchSource({ name: "team", repo: nlGitfile, ref: embedSha }, nlCache))).toBe(true);
    const loadedTrunc = await fetchSource({ name: "team", repo: nlGitfile, ref: truncSha }, nlCache);
    if ("error" in loadedTrunc) throw new Error(loadedTrunc.error);
    expect(loadedTrunc.packs[0]?.manifest.summary).toBe("Truncated line1.");

    const dirA = join(root, "dirA");
    const dirB = join(root, "dirB");
    const dirC = join(root, "dirC");
    const targetA = join(dirA, "target");
    const targetB = join(dirB, "target");
    const targetC = join(dirC, "target");
    await initRepo(targetA);
    const shaA = await commitPack(targetA, "team", "Target A.");
    await initRepo(targetB);
    const shaB = await commitPack(targetB, "team", "Target B.");
    await initRepo(targetC);
    const shaC = await commitPack(targetC, "team", "Target C.");
    writeFileSync(join(dirA, "gf"), "gitdir: target/.git\n");
    const link1 = join(dirB, "link1");
    const link2 = join(dirC, "link2");
    symlinkSync("../dirA/gf", link1);
    symlinkSync("../dirB/link1", link2);

    const linkCache = temp.make("cache-symlink-gitfile-");
    const loadedA = await fetchSource({ name: "team", repo: targetA, ref: shaA }, linkCache);
    if ("error" in loadedA) throw new Error(loadedA.error);
    const loadedB = await fetchSource({ name: "team", repo: targetB, ref: shaB }, linkCache);
    if ("error" in loadedB) throw new Error(loadedB.error);
    const loadedC = await fetchSource({ name: "team", repo: link2, ref: shaC }, linkCache);
    if ("error" in loadedC) throw new Error(loadedC.error);
    expect([loadedC.packs[0]?.manifest.summary, loadedC.stale]).toEqual(["Target C.", undefined]);
    for (const foreignSha of [shaA, shaB]) {
      const cross = await fetchSource({ name: "team", repo: link2, ref: foreignSha }, linkCache);
      if ("error" in cross) throw new Error(cross.error);
      expect(cross.packs[0]?.manifest.summary).toBe("Target C.");
      expect(cross.stale).toContain(`could not fetch ${foreignSha}`);
    }

    rmSync(targetC, { recursive: true, force: true });
    const offlineLink = await fetchSource({ name: "team", repo: link2, ref: shaC }, linkCache);
    if ("error" in offlineLink) throw new Error(offlineLink.error);
    expect([offlineLink.packs[0]?.manifest.summary, offlineLink.stale]).toEqual(["Target C.", undefined]);
    rmSync(link2);
    symlinkSync("../dirA/missing", link2);
    expect("error" in (await fetchSource({ name: "team", repo: link2, ref: shaC }, linkCache))).toBe(true);
  });

  test("prefers a Git bundle file over a .git sibling repository when resolving identity", async () => {
    if (process.platform === "win32") return;
    const root = temp.make("bundle-vs-dotgit-");
    const srcA = join(root, "src-a");
    const sibling = join(root, "packs.git");
    await initRepo(srcA);
    const shaA = await commitPack(srcA, "team", "Bundle A.");
    await initRepo(sibling);
    const shaB = await commitPack(sibling, "team", "Sibling B.");

    const bundlePath = join(root, "packs");
    await spawnGit(srcA, "bundle", "create", "-q", bundlePath, "HEAD");

    const cache = temp.make("cache-bundle-sibling-");
    const loadedBundle = await fetchSource({ name: "team", repo: bundlePath, ref: shaA }, cache);
    if ("error" in loadedBundle) throw new Error(loadedBundle.error);
    expect([loadedBundle.packs[0]?.manifest.summary, loadedBundle.stale]).toEqual(["Bundle A.", undefined]);

    const loadedSibling = await fetchSource({ name: "team", repo: sibling, ref: shaB }, cache);
    if ("error" in loadedSibling) throw new Error(loadedSibling.error);
    expect([loadedSibling.packs[0]?.manifest.summary, loadedSibling.stale]).toEqual(["Sibling B.", undefined]);

    const crossSibling = await fetchSource({ name: "team", repo: sibling, ref: shaA }, cache);
    if ("error" in crossSibling) throw new Error(crossSibling.error);
    expect(crossSibling.packs[0]?.manifest.summary).toBe("Sibling B.");
    expect(crossSibling.stale).toContain(`could not fetch ${shaA}`);

    rmSync(bundlePath, { force: true });
    rmSync(sibling, { recursive: true, force: true });
    const offlineBundle = await fetchSource({ name: "team", repo: bundlePath, ref: shaA }, cache);
    if ("error" in offlineBundle) throw new Error(offlineBundle.error);
    expect([offlineBundle.packs[0]?.manifest.summary, offlineBundle.stale]).toEqual(["Bundle A.", undefined]);

    const offlineCrossBundle = await fetchSource({ name: "team", repo: bundlePath, ref: shaB }, cache);
    if ("error" in offlineCrossBundle) throw new Error(offlineCrossBundle.error);
    expect(offlineCrossBundle.packs[0]?.manifest.summary).toBe("Bundle A.");
    expect(offlineCrossBundle.stale).toContain(`could not fetch ${shaB}`);
    expect("error" in (await fetchSource({ name: "team", repo: sibling, ref: shaA }, cache))).toBe(true);
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
  });
});
