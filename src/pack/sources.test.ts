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
    const commit = (await spawnGit(repo, "rev-parse", "HEAD")).toUpperCase();
    const httpRoot = temp.make("http-git-");
    const bareRepo = join(httpRoot, "team.git");
    await spawnGit(httpRoot, "clone", "-q", "--bare", repo, bareRepo);
    await spawnGit(bareRepo, "config", "uploadpack.allowAnySHA1InWant", "true");
    const execPath = await spawnGit(httpRoot, "--exec-path");
    const backend = join(execPath, "git-http-backend");
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        requests++;
        const url = new URL(req.url);
        const body = new Uint8Array(await req.arrayBuffer());
        const proc = Bun.spawn([backend], {
          stdin: body,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: httpRoot,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers.get("content-type") ?? "",
            CONTENT_LENGTH: String(body.byteLength),
            ...(req.headers.get("git-protocol") ? { HTTP_GIT_PROTOCOL: req.headers.get("git-protocol")! } : {}),
          },
        });
        const [raw] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
        const bytes = new Uint8Array(raw);
        let split = -1;
        for (let i = 0; i + 3 < bytes.length; i++) {
          if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
            split = i;
            break;
          }
        }
        const headerText = new TextDecoder().decode(split === -1 ? bytes : bytes.subarray(0, split));
        const headers = new Headers();
        let status = 200;
        for (const line of headerText.split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
          else headers.append(key, value);
        }
        return new Response(split === -1 ? new Uint8Array() : bytes.subarray(split + 4), { status, headers });
      },
    });
    const cache = temp.make("cache-");
    const ref = { name: "team", repo: `http://127.0.0.1:${server.port}/team.git`, ref: commit };
    try {
      const first = await fetchSource(ref, cache);
      if ("error" in first) throw new Error(first.error);
      expect(requests).toBeGreaterThan(0);
      requests = 0;
      const fetched = await fetchSource(ref, cache);
      if ("error" in fetched) throw new Error(fetched.error);
      expect(requests).toBe(0);
      expect([fetched.packs[0]?.manifest.summary, fetched.stale]).toEqual(["Team rules v1.", undefined]);
    } finally {
      server.stop(true);
    }
    const offline = await fetchSource(ref, cache);
    if ("error" in offline) throw new Error(offline.error);
    expect([offline.packs[0]?.manifest.summary, offline.stale]).toEqual(["Team rules v1.", undefined]);
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
    const commit1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: commit1 }, cache);
    const sourceFile = join(cache, "team", ".git", "hedge-source.json");
    expect(statSync(sourceFile).mode & 0o777).toBe(0o600);
    writePack(repo, "Private creds repo v2.");
    await spawnGit(repo, "commit", "-q", "-am", "v2");
    const commit2 = await spawnGit(repo, "rev-parse", "HEAD");
    const updated = await fetchSource({ name: "team", repo, ref: commit2 }, cache);
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.packs[0]?.manifest.summary).toBe("Private creds repo v2.");
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
