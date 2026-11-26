import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { advanceSource, fetchSource, followsBranch } from "./sources.ts";

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

describe("fetchSource PATH shims", () => {
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
    -o|-p|-i|-l|-F|-S|-c|-m|-b|-E|-I|-J|-L|-O|-Q|-R|-W|-w|-B|-D) shift 2 ;;
    -o*|-p*|-i*|-l*|-F*|-S*) shift ;;
    -4|-6|-A|-a|-C|-f|-G|-g|-K|-k|-M|-N|-n|-q|-s|-T|-t|-V|-v|-X|-x|-Y|-y) shift ;;
    --)
      shift
      break
      ;;
    -*) echo "unknown option: $1" >&2; exit 255 ;;
    *)
      if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
      shift
      ;;
  esac
done
while [ "$#" -gt 0 ]; do
  if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
  shift
done
case "$host" in
  alice@example.invalid) dest=${JSON.stringify(repoA)} ;;
  bob@example.invalid) dest=${JSON.stringify(repoB)} ;;
  *) echo "unexpected host: $host" >&2; exit 1 ;;
esac
case "$cmd" in
  "git-upload-pack '/repo.git'"|"git-upload-pack /repo.git") exec git-upload-pack "$dest" ;;
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

  test("never migrates ambiguous legacy SSH insteadOf caches across usernames", async () => {
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
    -o|-p|-i|-l|-F|-S|-c|-m|-b|-E|-I|-J|-L|-O|-Q|-R|-W|-w|-B|-D) shift 2 ;;
    -o*|-p*|-i*|-l*|-F*|-S*) shift ;;
    -4|-6|-A|-a|-C|-f|-G|-g|-K|-k|-M|-N|-n|-q|-s|-T|-t|-V|-v|-X|-x|-Y|-y) shift ;;
    --)
      shift
      break
      ;;
    -*) echo "unknown option: $1" >&2; exit 255 ;;
    *)
      if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
      shift
      ;;
  esac
done
while [ "$#" -gt 0 ]; do
  if [ -z "$host" ]; then host="$1"; else cmd="$1"; fi
  shift
done
case "$host" in
  alice@example.invalid) dest=${JSON.stringify(sshA)} ;;
  bob@example.invalid) dest=${JSON.stringify(sshB)} ;;
  *) echo "unexpected host: $host" >&2; exit 1 ;;
esac
case "$cmd" in
  "git-upload-pack '/repo.git'"|"git-upload-pack /repo.git") exec git-upload-pack "$dest" ;;
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
      expect(
        Bun.spawnSync(["git", "-C", sshDir, "fetch", "-q", "--depth", "1", "--no-tags", sshConfigured, sshShaA], {
          env: { ...process.env, GIT_SSH_COMMAND: `${join(sshBin, "ssh")}` },
        }).exitCode,
      ).toBe(0);
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

  test("falls back cleanly when git fetch does not support --porcelain even with localized errors", async () => {
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
    printf "Fehler: Unbekannte Option \\\`porcelain'\\nAufruf: git fetch [<Optionen>] [<Repository> [<Refspec>...]]\\n" >&2
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
  });

  test("refuses to overwrite write-only FETCH_HEAD on refresh when git lacks --no-write-fetch-head", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const repo = await packRepo("No write fetch head v1.");
    const c1 = await spawnGit(repo, "rev-parse", "HEAD");
    const cache = temp.make("cache-no-write-fh-");
    expect("error" in (await fetchSource({ name: "team", repo, ref: "main" }, cache))).toBe(false);
    const fetchHeadPath = join(cache, "team", ".git", "FETCH_HEAD");
    const beforeContent = readFileSync(fetchHeadPath, "utf8");
    chmodSync(fetchHeadPath, 0o200);
    writePack(repo, "No write fetch head v2.");
    await spawnGit(repo, "add", ".");
    await spawnGit(repo, "commit", "-q", "-m", "v2");
    const realGit = Bun.which("git")!;
    const binDir = temp.make("old-git-nowrite-");
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--no-write-fetch-head" ]; then
    echo "error: unknown option 'no-write-fetch-head'" >&2
    exit 129
  fi
done
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    try {
      const failed = await advanceSource({ name: "team", repo, ref: "main" }, cache, c1);
      expect(failed.state).toBe("failed");
    } finally {
      process.env.PATH = savedPath;
      chmodSync(fetchHeadPath, 0o644);
    }
    expect(readFileSync(fetchHeadPath, "utf8")).toBe(beforeContent);
    expect(await spawnGit(join(cache, "team"), "rev-parse", "--verify", "FETCH_HEAD")).toBe(c1);
  });
});
