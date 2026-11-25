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

describe("fetchSource legacy caches, branches, and hardening", () => {
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
    const beforeFh = readFileSync(join(fhCache, "team", ".git", "FETCH_HEAD"), "utf8");
    const fhRefs = join(fhCache, "team", ".git", "refs");
    setDirModes(fhRefs, 0o555);
    try {
      const fhFailed = await fetchSource({ name: "team", repo: fhRepo, ref: fhPin }, fhCache);
      if ("error" in fhFailed) throw new Error(fhFailed.error);
      expect(fhFailed.stale).toContain(`could not record ${fhPin}`);
    } finally {
      setDirModes(fhRefs, 0o755);
    }
    expect(readFileSync(join(fhCache, "team", ".git", "FETCH_HEAD"), "utf8")).toBe(beforeFh);
    expect(await followsBranch({ name: "team", repo: fhRepo, ref: "main" }, fhCache)).toBe(true);

    const brokenRelRepo = await packRepo("Main v1.");
    await spawnGit(brokenRelRepo, "checkout", "-q", "-b", "release");
    writeFileSync(join(brokenRelRepo, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken release." }));
    await spawnGit(brokenRelRepo, "commit", "-q", "-am", "broken release");
    const brokenRelCache = temp.make("cache-broken-release-fh-");
    const mainGood = await fetchSource({ name: "team", repo: brokenRelRepo, ref: "main" }, brokenRelCache);
    if ("error" in mainGood) throw new Error(mainGood.error);
    const mainSha = await spawnGit(join(brokenRelCache, "team"), "rev-parse", "HEAD");
    const brokenRelRes = await fetchSource({ name: "team", repo: brokenRelRepo, ref: "release" }, brokenRelCache);
    if ("error" in brokenRelRes) throw new Error(brokenRelRes.error);
    expect(brokenRelRes.stale).toContain("does not load");
    expect(await followsBranch({ name: "team", repo: brokenRelRepo, ref: "release" }, brokenRelCache)).toBe(true);
    await spawnGit(brokenRelRepo, "reset", "-q", "--hard", "HEAD~1");
    writePack(brokenRelRepo, "Fixed release.");
    await spawnGit(brokenRelRepo, "commit", "-q", "-am", "fix release");
    const refreshed = await advanceSource({ name: "team", repo: brokenRelRepo, ref: "release" }, brokenRelCache, mainSha);
    expect(refreshed.state).toBe("moved");
    if (refreshed.state === "moved") expect(refreshed.source.packs[0]?.manifest.summary).toBe("Fixed release.");

    const upperGitParent = temp.make("upper-git-");
    const upperGitRepo = join(upperGitParent, "packs.GIT");
    mkdirSync(join(upperGitRepo, "packs/team"), { recursive: true });
    writePack(upperGitRepo, "Uppercase GIT legacy.");
    await spawnGit(upperGitRepo, "init", "-q", "-b", "main");
    await spawnGit(upperGitRepo, "add", ".");
    await spawnGit(upperGitRepo, "commit", "-q", "-m", "v1");
    const upperSha = await spawnGit(upperGitRepo, "rev-parse", "HEAD");
    const upperCache = temp.make("cache-upper-git-");
    const upperDir = join(upperCache, "team");
    mkdirSync(upperDir, { recursive: true });
    await spawnGit(upperDir, "init", "-q");
    await spawnGit(upperDir, "fetch", "-q", "--depth", "1", "--no-tags", `${upperGitRepo}/`, "main");
    await spawnGit(upperDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(upperDir, ".git", "hedge-source.json"), JSON.stringify({ repo: `${upperGitRepo}/`, ref: "main", commit: upperSha }) + "\n");
    rmSync(upperGitRepo, { recursive: true, force: true });
    const upperOffline = await fetchSource({ name: "team", repo: `${upperGitRepo}/`, ref: "main" }, upperCache);
    if ("error" in upperOffline) throw new Error(upperOffline.error);
    expect(upperOffline.packs[0]?.manifest.summary).toBe("Uppercase GIT legacy.");
    expect(upperOffline.stale).toContain("could not fetch main");

    const swapOld = await packRepo("Old legacy mirror.");
    const swapNew = await packRepo("New mirror.");
    await spawnGit(swapNew, "checkout", "-q", "-b", "release");
    writeFileSync(join(swapNew, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken new mirror." }));
    await spawnGit(swapNew, "commit", "-q", "-am", "broken");
    const swapOldSha = await spawnGit(swapOld, "rev-parse", "HEAD");
    const swapCfg = "https://example.invalid/swap-mirror.git";
    const swapCache = temp.make("cache-swap-mirror-");
    const swapDir = join(swapCache, "team");
    mkdirSync(swapDir, { recursive: true });
    await spawnGit(swapDir, "init", "-q");
    await spawnGit(swapDir, "config", `url.${swapOld}.insteadOf`, swapCfg);
    await spawnGit(swapDir, "fetch", "-q", "--depth", "1", "--no-tags", swapCfg, "main");
    await spawnGit(swapDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(swapDir, ".git", "hedge-source.json"), JSON.stringify({ repo: swapCfg, ref: "main", commit: swapOldSha }) + "\n");
    await spawnGit(swapDir, "config", "--unset-all", `url.${swapOld}.insteadOf`);
    await spawnGit(swapDir, "config", `url.${swapNew}.insteadOf`, swapCfg);
    const swapFailed = await fetchSource({ name: "team", repo: swapCfg, ref: "release" }, swapCache);
    expect("error" in swapFailed).toBe(true);
    rmSync(swapNew, { recursive: true, force: true });
    const swapOffline = await fetchSource({ name: "team", repo: swapCfg, ref: "main" }, swapCache);
    expect("error" in swapOffline).toBe(true);

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

  test("rejects refspec injection and falls back offline after a legacy insteadOf broken-ref fetch", async () => {
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

    const plusCache = temp.make("cache-plus-refspec-");
    const plusMain = await fetchSource({ name: "team", repo: repoB, ref: "+main" }, plusCache);
    if ("error" in plusMain) throw new Error(plusMain.error);
    expect(plusMain.packs[0]?.manifest.summary).toBe("Untrusted repo B.");

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
  });

  test("separates invalid-UTF-8 mirror paths and preserves offline legacy fallback", async () => {
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

      const rawLegacyCache = temp.make("cache-raw-legacy-");
      const rawLegacyDir = join(rawLegacyCache, "team");
      mkdirSync(rawLegacyDir, { recursive: true });
      await spawnGit(rawLegacyDir, "init", "-q");
      const rawLegacyCfg = Buffer.concat([
        Buffer.from("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[url \""),
        pathA,
        Buffer.from(`"]\n\tinsteadOf = ${rawConfigured}\n`),
      ]);
      writeFileSync(join(rawLegacyDir, ".git", "config"), rawLegacyCfg);
      await spawnGit(rawLegacyDir, "fetch", "-q", "--depth", "1", "--no-tags", rawConfigured, "main");
      await spawnGit(rawLegacyDir, "checkout", "-q", "--detach", "FETCH_HEAD");
      writeFileSync(join(rawLegacyDir, ".git", "hedge-source.json"), JSON.stringify({ repo: rawConfigured, ref: "main", commit: rawShaA, asked: 42 }) + "\n");
      rmSync(pathA, { recursive: true, force: true });
      const rawLegacyFirst = await fetchSource({ name: "team", repo: rawConfigured, ref: "main" }, rawLegacyCache);
      if ("error" in rawLegacyFirst) throw new Error(rawLegacyFirst.error);
      expect(rawLegacyFirst.packs[0]?.manifest.summary).toBe("Raw byte 0x80.");
      const rawLegacySecond = await fetchSource({ name: "team", repo: rawConfigured, ref: "main" }, rawLegacyCache);
      if ("error" in rawLegacySecond) throw new Error(rawLegacySecond.error);
      expect(rawLegacySecond.packs[0]?.manifest.summary).toBe("Raw byte 0x80.");
    }
  });

  test("tracks blocked cross-repo switches separately and allows offline empty-FETCH_HEAD mirrors", async () => {
    const switchRepoA = await packRepo("Switch repo A.");
    const switchRepoB = await packRepo("Switch repo B.");
    await spawnGit(switchRepoB, "checkout", "-q", "-b", "release");
    writeFileSync(join(switchRepoB, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken B release." }));
    await spawnGit(switchRepoB, "commit", "-q", "-am", "broken B release");
    const switchCache = temp.make("cache-switch-asked-");
    expect("error" in (await fetchSource({ name: "team", repo: switchRepoA, ref: "main" }, switchCache))).toBe(false);
    expect("error" in (await fetchSource({ name: "team", repo: switchRepoB, ref: "release" }, switchCache))).toBe(true);
    const cachedWrongRef = await cachedSource({ name: "team", repo: switchRepoA, ref: "release" }, switchCache);
    expect("error" in cachedWrongRef).toBe(true);

    const unreachableRepoB = join(temp.make("unreachable-b-"), "missing-repo");
    expect("error" in (await fetchSource({ name: "team", repo: unreachableRepoB, ref: "main" }, switchCache))).toBe(true);
    expect(await followsBranch({ name: "team", repo: unreachableRepoB, ref: "main" }, switchCache)).toBe(false);
    expect(await followsBranch({ name: "team", repo: switchRepoA, ref: "main" }, switchCache)).toBe(true);

    const emptyMirror = await packRepo("Empty FH mirror packs.");
    const emptyMirrorSha = await spawnGit(emptyMirror, "rev-parse", "HEAD");
    const emptyMirrorCfg = "https://example.invalid/empty-fh-mirror.git";
    const emptyMirrorCache = temp.make("cache-empty-fh-mirror-");
    const emptyMirrorDir = join(emptyMirrorCache, "team");
    mkdirSync(emptyMirrorDir, { recursive: true });
    await spawnGit(emptyMirrorDir, "init", "-q");
    await spawnGit(emptyMirrorDir, "config", `url.${emptyMirror}.insteadOf`, emptyMirrorCfg);
    await spawnGit(emptyMirrorDir, "fetch", "-q", "--depth", "1", "--no-tags", emptyMirrorCfg, "main");
    await spawnGit(emptyMirrorDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(emptyMirrorDir, ".git", "hedge-source.json"), JSON.stringify({ repo: emptyMirrorCfg, ref: "main", commit: emptyMirrorSha }) + "\n");
    writeFileSync(join(emptyMirrorDir, ".git", "FETCH_HEAD"), "");
    rmSync(emptyMirror, { recursive: true, force: true });
    const emptyMirrorOffline = await fetchSource({ name: "team", repo: emptyMirrorCfg, ref: "main" }, emptyMirrorCache);
    if ("error" in emptyMirrorOffline) throw new Error(emptyMirrorOffline.error);
    expect(emptyMirrorOffline.packs[0]?.manifest.summary).toBe("Empty FH mirror packs.");
    expect(emptyMirrorOffline.stale).toContain("could not fetch main");
  });

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

  test("falls back cleanly when git fetch does not support --porcelain", async () => {
    const repo = await packRepo("Older git packs.");
    const sha = await spawnGit(repo, "rev-parse", "HEAD");
    const realGit = Bun.which("git")!;
    const binDir = temp.make("old-git-bin-");
    const shim = join(binDir, "git");
    writeFileSync(
      shim,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--porcelain" ]; then
    printf "error: unknown option \\\`porcelain'\\nusage: git fetch [<options>] [<repository> [<refspec>...]]\\n" >&2
    exit 129
  fi
done
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const cache = temp.make("cache-old-git-");
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    try {
      const branchRes = await fetchSource({ name: "team", repo, ref: "main" }, cache);
      if ("error" in branchRes) throw new Error(branchRes.error);
      expect(branchRes.packs[0]?.manifest.summary).toBe("Older git packs.");
      expect(await followsBranch({ name: "team", repo, ref: "main" }, cache)).toBe(true);
      const pinRes = await fetchSource({ name: "team", repo, ref: sha }, cache);
      if ("error" in pinRes) throw new Error(pinRes.error);
      expect(pinRes.packs[0]?.manifest.summary).toBe("Older git packs.");
    } finally {
      process.env.PATH = savedPath;
    }
    const leftover = await spawnGit(join(cache, "team"), "for-each-ref", "refs/hedge/tmp");
    expect(leftover).toBe("");
  });
});

