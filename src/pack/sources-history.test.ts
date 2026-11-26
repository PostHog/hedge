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

describe("fetchSource retained history and refresh pins", () => {
  async function initPackRepo(dir: string, summary: string) {
    mkdirSync(dir, { recursive: true });
    await spawnGit(dir, "init", "-q", "-b", "main");
    writePack(dir, summary);
    await spawnGit(dir, "add", ".");
    await spawnGit(dir, "commit", "-q", "-m", "v1");
    return await spawnGit(dir, "rev-parse", "HEAD");
  }

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

  test("applying a tag at an intermediate cached commit does not hide earlier ancestors from offline SHA pins", async () => {
    const repo = await packRepo("Commit 1.");
    const c1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-shallow-ancestor-");
    const ref = { name: "team", repo, ref: "main" };
    const initial = await fetchSource(ref, cache);
    if ("error" in initial) throw new Error(initial.error);

    writePack(repo, "Commit 2.");
    await spawnGit(repo, "commit", "-q", "-am", "c2");
    const c2 = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Commit 3.");
    await spawnGit(repo, "commit", "-q", "-am", "c3");
    await spawnGit(repo, "tag", "v3");
    writePack(repo, "Commit 4.");
    await spawnGit(repo, "commit", "-q", "-am", "c4");

    const advanced = await advanceSource(ref, cache, c1);
    expect(advanced.state).toBe("moved");

    const tagged = await fetchSource({ name: "team", repo, ref: "v3" }, cache);
    if ("error" in tagged) throw new Error(tagged.error);
    expect(tagged.packs[0]?.manifest.summary).toBe("Commit 3.");

    rmSync(repo, { recursive: true, force: true });
    const pinned = await fetchSource({ name: "team", repo, ref: c2 }, cache);
    if ("error" in pinned) throw new Error(pinned.error);
    expect(pinned.stale).toBeUndefined();
    expect(pinned.packs[0]?.manifest.summary).toBe("Commit 2.");
  });

  test("fetching a shared tag from a second repository keeps the first repository's refreshed ancestors available offline without exposing them to the second", async () => {
    const repoA = await packRepo("Repo A c1.");
    const c1 = await spawnGit(repoA, "rev-parse", "HEAD");
    const cache = temp.make("cache-cross-repo-shallow-");
    const refA = { name: "team", repo: repoA, ref: "main" };
    const initial = await fetchSource(refA, cache);
    if ("error" in initial) throw new Error(initial.error);

    writePack(repoA, "Repo A c2.");
    await spawnGit(repoA, "commit", "-q", "-am", "c2");
    const c2 = await spawnGit(repoA, "rev-parse", "HEAD");
    writePack(repoA, "Repo A c3.");
    await spawnGit(repoA, "commit", "-q", "-am", "c3");
    const c3 = await spawnGit(repoA, "rev-parse", "HEAD");
    await spawnGit(repoA, "tag", "v3");
    writePack(repoA, "Repo A c4.");
    await spawnGit(repoA, "commit", "-q", "-am", "c4");

    const advanced = await advanceSource(refA, cache, c1);
    expect(advanced.state).toBe("moved");

    const repoB = join(temp.make("repo-b-"), "fork.git");
    await spawnGit(dirname(repoB), "clone", "-q", repoA, repoB);
    const fromB = await fetchSource({ name: "team", repo: repoB, ref: "v3" }, cache);
    if ("error" in fromB) throw new Error(fromB.error);
    expect(fromB.packs[0]?.manifest.summary).toBe("Repo A c3.");

    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });

    const pinA = await fetchSource({ name: "team", repo: repoA, ref: c2 }, cache);
    if ("error" in pinA) throw new Error(pinA.error);
    expect(pinA.stale).toBeUndefined();
    expect(pinA.packs[0]?.manifest.summary).toBe("Repo A c2.");

    const pinBExact = await fetchSource({ name: "team", repo: repoB, ref: c3 }, cache);
    if ("error" in pinBExact) throw new Error(pinBExact.error);
    expect(pinBExact.stale).toBeUndefined();
    expect(pinBExact.packs[0]?.manifest.summary).toBe("Repo A c3.");

    const pinBAncestor = await fetchSource({ name: "team", repo: repoB, ref: c2 }, cache);
    if (!("error" in pinBAncestor)) {
      expect(pinBAncestor.stale).toContain("could not fetch");
      expect(pinBAncestor.packs[0]?.manifest.summary).toBe("Repo A c3.");
    }
  });

  test("doctor prints unpinned advisory when remote.origin.url differs by a trailing space", async () => {
    const root = temp.make("origin-space-");
    const home = join(root, "home");
    const profileDir = join(root, "profile");
    mkdirSync(home, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    await spawnGit(profileDir, "init", "-q");
    const spacedOrigin = join(root, "repo ");
    const plainSource = join(root, "repo");
    await spawnGit(profileDir, "remote", "add", "origin", spacedOrigin);
    const baseProfile = {
      schema: 1,
      engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
      sources: [] as Array<{ name: string; repo: string; ref: string }>,
      packs: [],
      plan: "both",
      settings: {},
      workflows: {},
    };
    writeFileSync(join(profileDir, "hedge.json"), JSON.stringify(baseProfile));
    expect(
      await main(["apply", "--profile", profileDir], {
        home,
        engineRoot,
        platform: process.platform,
        print: () => {},
        run: async () => 0,
      }),
    ).toBe(0);
    writeFileSync(
      join(profileDir, "hedge.json"),
      JSON.stringify({ ...baseProfile, sources: [{ name: "ext", repo: plainSource, ref: "main" }] }),
    );
    const doctorLines: string[] = [];
    const doctorCode = await main(["doctor"], {
      home,
      engineRoot,
      platform: process.platform,
      print: (line) => doctorLines.push(line),
      run: async () => 0,
    });
    expect(doctorCode).toBe(0);
    expect(doctorLines.join("\n")).toContain("Note: The pack source ext is not pinned to a commit SHA.");
  });

  test("fetches +SHA and SHA: refspecs offline and doctor treats them as pinned", async () => {
    const root = temp.make("plus-sha-");
    const home = join(root, "home");
    const profileDir = join(root, "profile");
    mkdirSync(home, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    const pinRepo = await packRepo("Pin refspec.");
    const pinSha = await spawnGit(pinRepo, "rev-parse", "HEAD");
    const pinCache = temp.make("cache-plus-sha-");
    for (const refSpec of [`+${pinSha}`, `${pinSha}:`]) {
      const online = await fetchSource({ name: "team", repo: pinRepo, ref: refSpec }, pinCache);
      if ("error" in online) throw new Error(online.error);
      expect(online.stale).toBeUndefined();
    }
    const baseProfile = {
      schema: 1,
      engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
      sources: [] as Array<{ name: string; repo: string; ref: string }>,
      packs: [],
      plan: "both",
      settings: {},
      workflows: {},
    };
    writeFileSync(join(profileDir, "hedge.json"), JSON.stringify(baseProfile));
    expect(
      await main(["apply", "--profile", profileDir], {
        home,
        engineRoot,
        platform: process.platform,
        print: () => {},
        run: async () => 0,
      }),
    ).toBe(0);
    writeFileSync(
      join(profileDir, "hedge.json"),
      JSON.stringify({
        ...baseProfile,
        sources: [
          { name: "plus", repo: pinRepo, ref: `+${pinSha}` },
          { name: "colon", repo: pinRepo, ref: `${pinSha}:` },
        ],
      }),
    );
    const pinnedDoctorLines: string[] = [];
    expect(
      await main(["doctor"], {
        home,
        engineRoot,
        platform: process.platform,
        print: (line) => pinnedDoctorLines.push(line),
        run: async () => 0,
      }),
    ).toBe(0);
    expect(pinnedDoctorLines.join("\n")).not.toContain("not pinned to a commit SHA");
    rmSync(pinRepo, { recursive: true, force: true });
    for (const refSpec of [`+${pinSha}`, `${pinSha}:`]) {
      const offline = await fetchSource({ name: "team", repo: pinRepo, ref: refSpec }, pinCache);
      if ("error" in offline) throw new Error(offline.error);
      expect(offline.stale).toBeUndefined();
      expect(offline.packs[0]?.manifest.summary).toBe("Pin refspec.");
    }
  });

  test("does not expose refreshed commits offline after a metadata write failure", async () => {
    const failRepo = await tsRepo({
      "packs/team/pack.ts": 'export default { sdk: 1, name: "team", summary: "Base v1.", register() {} };\n',
    });
    const failCache = temp.make("cache-rollback-history-");
    const failRef = { name: "team", repo: failRepo, ref: "main" };
    const failInit = await fetchSource(failRef, failCache);
    if ("error" in failInit) throw new Error(failInit.error);
    const failBaseSha = await spawnGit(failRepo, "rev-parse", "HEAD");
    const failMetaPath = join(failCache, "team", ".git", "hedge-source.json");
    const savedFailMeta = readFileSync(failMetaPath, "utf8");
    writeFileSync(
      join(failRepo, "packs/team/pack.ts"),
      'export default { sdk: 1, name: "team", summary: "Mid v2.", register() {} };\n',
    );
    await spawnGit(failRepo, "commit", "-q", "-am", "mid");
    const failMidSha = await spawnGit(failRepo, "rev-parse", "HEAD");
    writeFileSync(
      join(failRepo, "packs/team/pack.ts"),
      [
        'import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const meta = join(import.meta.dir, "..", "..", ".git", "hedge-source.json");',
        'if (existsSync(meta) && !statSync(meta).isDirectory()) {',
        '  rmSync(meta, { force: true });',
        '  mkdirSync(meta, { recursive: true });',
        '  writeFileSync(join(meta, "block"), "x");',
        '}',
        'export default { sdk: 1, name: "team", summary: "Tip v3.", register() {} };',
        "",
      ].join("\n"),
    );
    await spawnGit(failRepo, "commit", "-q", "-am", "tip");
    const failTipSha = await spawnGit(failRepo, "rev-parse", "HEAD");
    try {
      const failedAdvance = await advanceSource(failRef, failCache, failBaseSha);
      expect(failedAdvance).toMatchObject({ state: "failed", say: expect.stringContaining("could not record main") });
    } finally {
      rmSync(failMetaPath, { recursive: true, force: true });
      writeFileSync(failMetaPath, savedFailMeta);
    }
    rmSync(failRepo, { recursive: true, force: true });
    for (const blockedSha of [failMidSha, failTipSha]) {
      const offlineAfterFailedRefresh = await fetchSource({ name: "team", repo: failRepo, ref: blockedSha }, failCache);
      if (!("error" in offlineAfterFailedRefresh)) {
        expect(offlineAfterFailedRefresh.stale).toContain("could not fetch");
        expect(offlineAfterFailedRefresh.packs[0]?.manifest.summary).toBe("Base v1.");
      }
    }
  });

  test("keeps intermediate commits available offline across multiple branch refreshes", async () => {
    const repo = await packRepo("R0.");
    const cache = temp.make("cache-multi-refresh-");
    const ref = { name: "team", repo, ref: "main" };
    let prev = await spawnGit(repo, "rev-parse", "HEAD");
    const init = await fetchSource(ref, cache);
    if ("error" in init) throw new Error(init.error);
    let midCommit = "";
    for (let i = 1; i <= 4; i++) {
      writePack(repo, `R${i}a.`);
      await spawnGit(repo, "commit", "-q", "-am", `r${i}a`);
      if (i === 1) midCommit = await spawnGit(repo, "rev-parse", "HEAD");
      writePack(repo, `R${i}b.`);
      await spawnGit(repo, "commit", "-q", "-am", `r${i}b`);
      const moved = await advanceSource(ref, cache, prev);
      expect(moved.state).toBe("moved");
      prev = await spawnGit(repo, "rev-parse", "HEAD");
    }
    rmSync(repo, { recursive: true, force: true });
    const pinnedMid = await fetchSource({ name: "team", repo, ref: midCommit }, cache);
    if ("error" in pinnedMid) throw new Error(pinnedMid.error);
    expect(pinnedMid.stale).toBeUndefined();
    expect(pinnedMid.packs[0]?.manifest.summary).toBe("R1a.");
  });

  test("revalidates refresh base commit under the lock and scopes hex-branch cache checks to the requested repository", async () => {
    const originA = await packRepo("Origin A0.");
    const a0 = await spawnGit(originA, "rev-parse", "HEAD");
    writePack(originA, "Origin A1.");
    await spawnGit(originA, "commit", "-q", "-am", "a1");
    const a1 = await spawnGit(originA, "rev-parse", "HEAD");
    writePack(originA, "Origin A2.");
    await spawnGit(originA, "commit", "-q", "-am", "a2");
    const a2 = await spawnGit(originA, "rev-parse", "HEAD");

    const shallowB = join(temp.make("shallow-race-b-"), "b.git");
    await spawnGit(dirname(shallowB), "clone", "-q", "--depth", "1", `file://${originA}`, shallowB);
    writePack(shallowB, "Shallow B3.");
    await spawnGit(shallowB, "commit", "-q", "-am", "b3");

    const raceCache = temp.make("cache-stale-from-race-");
    const fromA0 = await fetchSource({ name: "team", repo: originA, ref: "main" }, raceCache);
    if ("error" in fromA0) throw new Error(fromA0.error);
    const fromA0Pin = await fetchSource({ name: "team", repo: originA, ref: a0 }, raceCache);
    if ("error" in fromA0Pin) throw new Error(fromA0Pin.error);
    const switchedToB = await fetchSource({ name: "team", repo: shallowB, ref: a2 }, raceCache);
    if ("error" in switchedToB) throw new Error(switchedToB.error);
    const switchedToBBranch = await fetchSource({ name: "team", repo: shallowB, ref: "main" }, raceCache);
    if ("error" in switchedToBBranch) throw new Error(switchedToBBranch.error);
    writePack(shallowB, "Shallow B4.");
    await spawnGit(shallowB, "commit", "-q", "-am", "b4");

    const staleRefresh = await advanceSource({ name: "team", repo: shallowB, ref: "main" }, raceCache, a0);
    expect(staleRefresh).toEqual({ state: "busy" });

    rmSync(shallowB, { recursive: true, force: true });
    const offlineHidden = await fetchSource({ name: "team", repo: shallowB, ref: a1 }, raceCache);
    expect("error" in offlineHidden || offlineHidden.stale !== undefined).toBe(true);

    const repoA = await packRepo("Repo A pinned.");
    const shaA = await spawnGit(repoA, "rev-parse", "HEAD");
    const repoB = await packRepo("Repo B branch.");
    await spawnGit(repoB, "checkout", "-q", "-b", shaA);
    writePack(repoB, "Repo B hex branch.");
    await spawnGit(repoB, "commit", "-q", "-am", "hex-branch");
    const hexCache = temp.make("cache-cross-repo-hex-branch-");
    const loadA = await fetchSource({ name: "team", repo: repoA, ref: shaA }, hexCache);
    if ("error" in loadA) throw new Error(loadA.error);
    const loadB = await fetchSource({ name: "team", repo: repoB, ref: `refs/heads/${shaA}` }, hexCache);
    if ("error" in loadB) throw new Error(loadB.error);
    expect(loadB.packs[0]?.manifest.summary).toBe("Repo B hex branch.");
    rmSync(repoA, { recursive: true, force: true });
    const backToA = await fetchSource({ name: "team", repo: repoA, ref: shaA }, hexCache);
    if ("error" in backToA) throw new Error(backToA.error);
    expect([backToA.packs[0]?.manifest.summary, backToA.stale]).toEqual(["Repo A pinned.", undefined]);

    const sameRepoHex = await packRepo("Commit A.");
    const commitA = await spawnGit(sameRepoHex, "rev-parse", "HEAD");
    await spawnGit(sameRepoHex, "checkout", "-q", "-b", commitA);
    writePack(sameRepoHex, "Branch B.");
    await spawnGit(sameRepoHex, "commit", "-q", "-am", "branch-b");
    const sameHexCache = temp.make("cache-same-repo-hex-branch-");
    const cachedCommitA = await fetchSource({ name: "team", repo: sameRepoHex, ref: commitA }, sameHexCache);
    if ("error" in cachedCommitA) throw new Error(cachedCommitA.error);
    const cachedBranchB = await fetchSource({ name: "team", repo: sameRepoHex, ref: `refs/heads/${commitA}` }, sameHexCache);
    if ("error" in cachedBranchB) throw new Error(cachedBranchB.error);
    expect(cachedBranchB.packs[0]?.manifest.summary).toBe("Branch B.");
    rmSync(sameRepoHex, { recursive: true, force: true });
    const pinCommitA = await fetchSource({ name: "team", repo: sameRepoHex, ref: commitA }, sameHexCache);
    if ("error" in pinCommitA) throw new Error(pinCommitA.error);
    expect([pinCommitA.packs[0]?.manifest.summary, pinCommitA.stale]).toEqual(["Commit A.", undefined]);

    const tagRepo = await packRepo("Annotated tag v1.");
    await spawnGit(tagRepo, "tag", "-a", "rel-1", "-m", "release 1");
    const tagOid = await spawnGit(tagRepo, "rev-parse", "rel-1");
    const tagCache = temp.make("cache-writeonly-fh-tag-");
    const tagInit = await fetchSource({ name: "team", repo: tagRepo, ref: "main" }, tagCache);
    if ("error" in tagInit) throw new Error(tagInit.error);
    const tagFetchHead = join(tagCache, "team", ".git", "FETCH_HEAD");
    chmodSync(tagFetchHead, 0o200);
    try {
      const tagOnline = await fetchSource({ name: "team", repo: tagRepo, ref: tagOid }, tagCache);
      if ("error" in tagOnline) throw new Error(tagOnline.error);
      expect(tagOnline.stale).toBeUndefined();
    } finally {
      chmodSync(tagFetchHead, 0o644);
    }
    rmSync(tagRepo, { recursive: true, force: true });
    const tagOffline = await fetchSource({ name: "team", repo: tagRepo, ref: tagOid }, tagCache);
    if ("error" in tagOffline) throw new Error(tagOffline.error);
    expect([tagOffline.packs[0]?.manifest.summary, tagOffline.stale]).toEqual(["Annotated tag v1.", undefined]);
  });

  test("serves last-good legacy 40-hex branch offline when FETCH_HEAD points at a rejected tip, and repairs damaged non-string branch metadata online", async () => {
    const hexRepo = await packRepo("Hex branch v1.");
    const hexBranch = "c".repeat(40);
    await spawnGit(hexRepo, "checkout", "-q", "-b", hexBranch);
    const v1Sha = await spawnGit(hexRepo, "rev-parse", "HEAD");
    writeFileSync(join(hexRepo, "packs/team/pack.json"), JSON.stringify({ schema: 2, name: "team", summary: "Broken v2." }));
    await spawnGit(hexRepo, "commit", "-q", "-am", "broken-v2");
    const legacyCache = temp.make("cache-legacy-hex-rejected-tip-");
    const legacyDir = join(legacyCache, "team");
    mkdirSync(legacyDir, { recursive: true });
    await spawnGit(legacyDir, "init", "-q");
    await spawnGit(legacyDir, "fetch", "-q", "--depth", "1", "--no-tags", hexRepo, v1Sha);
    await spawnGit(legacyDir, "checkout", "-q", "--detach", `${v1Sha}^{commit}`);
    await spawnGit(legacyDir, "fetch", "-q", "--depth", "1", "--no-tags", hexRepo, `refs/heads/${hexBranch}`);
    writeFileSync(join(legacyDir, ".git", "hedge-source.json"), JSON.stringify({ repo: hexRepo, ref: hexBranch, commit: v1Sha }) + "\n");
    rmSync(hexRepo, { recursive: true, force: true });
    const legacyOffline = await fetchSource({ name: "team", repo: hexRepo, ref: hexBranch }, legacyCache);
    if ("error" in legacyOffline) throw new Error(legacyOffline.error);
    expect(legacyOffline.packs[0]?.manifest.summary).toBe("Hex branch v1.");
    expect(legacyOffline.stale).toContain(`could not fetch ${hexBranch}`);

    const damagedRepo = await packRepo("Damaged meta v1.");
    const damagedSha = await spawnGit(damagedRepo, "rev-parse", "HEAD");
    const damagedCache = temp.make("cache-damaged-branch-ref-");
    const init = await fetchSource({ name: "team", repo: damagedRepo, ref: damagedSha }, damagedCache);
    if ("error" in init) throw new Error(init.error);
    const metaPath = join(damagedCache, "team", ".git", "hedge-source.json");
    const existing = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...existing, branch: true, ref: 42 }) + "\n");
    const repaired = await fetchSource({ name: "team", repo: damagedRepo, ref: damagedSha }, damagedCache);
    if ("error" in repaired) throw new Error(repaired.error);
    expect([repaired.packs[0]?.manifest.summary, repaired.stale]).toEqual(["Damaged meta v1.", undefined]);

    const otherRepo = await packRepo("Other repo v1.");
    const otherSha = await spawnGit(otherRepo, "rev-parse", "HEAD");
    const numMetaCache = temp.make("cache-numeric-legacy-repo-");
    const numMetaDir = join(numMetaCache, "team");
    mkdirSync(numMetaDir, { recursive: true });
    await spawnGit(numMetaDir, "init", "-q");
    await spawnGit(numMetaDir, "fetch", "-q", "--depth", "1", "--no-tags", damagedRepo, "main");
    await spawnGit(numMetaDir, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(numMetaDir, ".git", "hedge-source.json"), JSON.stringify({ repo: 42, ref: "main", commit: damagedSha }) + "\n");
    const switchedFromNum = await fetchSource({ name: "team", repo: otherRepo, ref: otherSha }, numMetaCache);
    if ("error" in switchedFromNum) throw new Error(switchedFromNum.error);
    expect([switchedFromNum.packs[0]?.manifest.summary, switchedFromNum.stale]).toEqual(["Other repo v1.", undefined]);

    const hexRefreshRepo = await packRepo("Hex A.");
    const hexASha = await spawnGit(hexRefreshRepo, "rev-parse", "HEAD");
    await spawnGit(hexRefreshRepo, "checkout", "-q", "-b", hexASha);
    writePack(hexRefreshRepo, "Hex B.");
    await spawnGit(hexRefreshRepo, "commit", "-q", "-am", "hex-b");
    const hexBSha = await spawnGit(hexRefreshRepo, "rev-parse", "HEAD");
    const hexRefreshCache = temp.make("cache-hex-refresh-override-");
    const pinAFirst = await fetchSource({ name: "team", repo: hexRefreshRepo, ref: hexASha }, hexRefreshCache);
    if ("error" in pinAFirst) throw new Error(pinAFirst.error);
    const loadHexBranch = await fetchSource({ name: "team", repo: hexRefreshRepo, ref: `refs/heads/${hexASha}` }, hexRefreshCache);
    if ("error" in loadHexBranch) throw new Error(loadHexBranch.error);
    writePack(hexRefreshRepo, "Hex C.");
    await spawnGit(hexRefreshRepo, "commit", "-q", "-am", "hex-c");
    const movedBareHex = await advanceSource({ name: "team", repo: hexRefreshRepo, ref: hexASha }, hexRefreshCache, hexBSha);
    expect(movedBareHex.state).toBe("moved");
    rmSync(hexRefreshRepo, { recursive: true, force: true });
    const pinAAgain = await fetchSource({ name: "team", repo: hexRefreshRepo, ref: hexASha }, hexRefreshCache);
    if ("error" in pinAAgain) throw new Error(pinAAgain.error);
    expect([pinAAgain.packs[0]?.manifest.summary, pinAAgain.stale]).toEqual(["Hex A.", undefined]);
  });

  test("keeps refreshed intermediate commits available offline even after an older shallow fetch rewrites .git/shallow", async () => {
    const repo = await packRepo("Commit 1.");
    const c1 = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Commit 2.");
    await spawnGit(repo, "commit", "-q", "-am", "c2");
    const c2 = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Commit 3.");
    await spawnGit(repo, "commit", "-q", "-am", "c3");
    const c3 = await spawnGit(repo, "rev-parse", "HEAD");
    writePack(repo, "Commit 4.");
    await spawnGit(repo, "commit", "-q", "-am", "c4");

    const cache = temp.make("cache-older-shallow-refresh-");
    const dir = join(cache, "team");
    await spawnGit(repo, "checkout", "-q", "-B", "track", c1);
    const initTrack = await fetchSource({ name: "team", repo, ref: "track" }, cache);
    if ("error" in initTrack) throw new Error(initTrack.error);
    await spawnGit(repo, "checkout", "-q", "-B", "track", "main");
    const moved = await advanceSource({ name: "team", repo, ref: "track" }, cache, c1);
    expect(moved.state).toBe("moved");

    await spawnGit(dir, "fetch", "-q", "--depth", "1", "--no-tags", repo, c3);
    await spawnGit(dir, "checkout", "-q", "--detach", `${c3}^{commit}`);
    writeFileSync(join(dir, ".git", "hedge-source.json"), JSON.stringify({ repo, ref: c3, commit: c3 }) + "\n");
    await spawnGit(dir, "gc", "-q", "--prune=now");

    rmSync(repo, { recursive: true, force: true });
    const offlineC2 = await fetchSource({ name: "team", repo, ref: c2 }, cache);
    if ("error" in offlineC2) throw new Error(offlineC2.error);
    expect([offlineC2.packs[0]?.manifest.summary, offlineC2.stale]).toEqual(["Commit 2.", undefined]);
  });
});
