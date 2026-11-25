import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "./cli.ts";
import { filesAdapter } from "./reconciler/apply.ts";
import { repoRoot } from "./testing/cli.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";
import { stateLock, tryLock } from "./lock.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const guide = ".agents/guides/team-rules.md";

async function teamRepo() {
  const repo = join(temp.make("team-"), "team.git");
  mkdirSync(repo);
  await spawnGit(repo, "init", "-q", "-b", "main");
  await commit(repo, "v1", { "packs/team/rules.md": "Rules v1.\n", "packs/team/AGENTS.md": "Team v1.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
  await spawnGit(repo, "tag", "v1");
  return repo;
}

async function commit(repo: string, message: string, files: Record<string, string>, skills = ["skills/review"]) {
  const manifest = { schema: 1, name: "team", summary: "Team rules.", instructions: "AGENTS.md", guides: [{ guide: "team-rules", path: "rules.md" }], skills };
  for (const [path, text] of Object.entries({ "packs/team/pack.json": JSON.stringify(manifest), ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-q", "-m", message);
}

const v2 = (repo: string) => commit(repo, "v2", { "packs/team/rules.md": "Rules v2.\n", "packs/team/AGENTS.md": "Team v2.\n", "packs/team/skills/plan/SKILL.md": "# plan\n" }, ["skills/review", "skills/plan"]);

async function machine(ref = "main") {
  const repo = await teamRepo();
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [{ name: "team", repo, ref }], packs: ["team"], plan: "both", settings: {}, workflows: {} }));
  const steps: string[][] = [];
  const lines: string[] = [];
  const clock = { at: Date.UTC(2026, 0, 1), naps: [] as number[], onSleep: () => {}, now: () => clock.at, sleep: async (ms: number) => (clock.naps.push(ms), clock.onSleep()) };
  const hedge = (...args: string[]) => main(args, { home, engineRoot: repoRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: async (command) => (steps.push(command), 0), adapters: () => [filesAdapter], clock });
  const code = await hedge("apply", "--profile", profile);
  if (code !== 0) throw new Error(lines.join("\n"));
  steps.length = 0;
  lines.length = 0;
  const read = (target: string) => readFileSync(join(home, target), "utf8");
  const cache = join(home, ".local/share/hedge/sources");
  const pin = (ref: string) => {
    const file = join(profile, "hedge.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...json, sources: [{ ...json.sources[0], ref }] }));
  };
  return { repo, home, cache, clock, hedge, steps, lines, read, pin, profile };
}

const skill = ".agents/skills/review/SKILL.md";

async function forcePushOrphan(repo: string) {
  await spawnGit(repo, "checkout", "-q", "--orphan", "rewrite");
  await commit(repo, "rewrite", { "packs/team/rules.md": "Rewritten.\n", "packs/team/AGENTS.md": "Rewritten.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
  await spawnGit(repo, "branch", "-f", "main", "rewrite");
  await spawnGit(repo, "checkout", "-q", "main");
}

describe("hedge refresh", () => {
  test("brings a moved branch's guide, instructions, and skills, keeps local edits and unmanaged files, and runs no step", async () => {
    const box = await machine();
    writeFileSync(join(box.home, ".codex/AGENTS.md"), "My own edit.\n");
    mkdirSync(join(box.home, ".claude/skills/plan"), { recursive: true });
    writeFileSync(join(box.home, ".claude/skills/plan/SKILL.md"), "# my plan\n");
    writeFileSync(join(box.home, "notes.md"), "Mine.\n");
    await v2(box.repo);

    expect(await box.hedge("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v2.\n");
    expect(box.read(".agents/AGENTS.md")).toContain("Team v2.");
    expect(box.read(".gemini/AGENTS.md")).toContain("Team v2.");
    expect(box.read(".agents/skills/plan/SKILL.md")).toBe("# plan\n");
    expect(box.read(".gemini/config/skills/plan/SKILL.md")).toBe("# plan\n");
    expect(box.read(".codex/AGENTS.md")).toBe("My own edit.\n");
    expect(lstatSync(join(box.home, ".claude/skills/plan")).isSymbolicLink()).toBe(false);
    expect(box.read(".claude/skills/plan/SKILL.md")).toBe("# my plan\n");
    expect(box.read("notes.md")).toBe("Mine.\n");
    expect(box.steps).toEqual([]);
  });

  test("applies nothing when no branch moved", async () => {
    const box = await machine();
    rmSync(join(box.home, guide));

    expect(await box.hedge("refresh")).toBe(0);

    expect(existsSync(join(box.home, guide))).toBe(false);
  });

  test("leaves a source alone that the profile moved back to its branch from a cached commit, until hedge apply runs", async () => {
    const box = await machine();
    box.pin(await spawnGit(box.repo, "rev-parse", "main"));
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    box.pin("main");
    await v2(box.repo);

    expect(await box.hedge("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v1.\n");
  });

  test("leaves a source pinned to a tag alone, even when the tag moves", async () => {
    const box = await machine("v1");
    await v2(box.repo);
    await spawnGit(box.repo, "tag", "-f", "v1");

    expect(await box.hedge("refresh")).toBe(0);

    expect(box.read(guide)).toBe("Rules v1.\n");
  });

  test("waits for another Hedge operation's lock and applies at the next run, though nothing new arrives", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.home, stateLock))!;

    expect(await box.hedge("refresh")).toBe(1);
    expect(box.read(guide)).toBe("Rules v1.\n");

    held.release();
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("keeps an edit to a linked skill when the branch did not move", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");

    expect(await box.hedge("refresh")).toBe(0);

    expect(box.read(skill)).toBe("# my review\n");
  });

  test("skips a moved source while a linked skill has an edit, and names the edited file", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");
    await v2(box.repo);

    expect(await box.hedge("refresh")).toBe(1);

    expect(box.read(skill)).toBe("# my review\n");
    expect(box.read(guide)).toBe("Rules v1.\n");
    expect(box.lines.join("\n")).toContain("packs/team/skills/review/SKILL.md");
  });

  test("keeps a new file in a linked skill folder that the moved branch also adds", async () => {
    const box = await machine();
    writeFileSync(join(box.home, ".agents/skills/review/notes.md"), "Mine.\n");
    await commit(box.repo, "v2", { "packs/team/skills/review/notes.md": "Theirs.\n" });

    expect(await box.hedge("refresh")).toBe(1);

    expect(box.read(".agents/skills/review/notes.md")).toBe("Mine.\n");
  });

  test("hedge apply keeps an edit to a linked skill when the branch moved", async () => {
    const box = await machine();
    writeFileSync(join(box.home, skill), "# my review\n");
    await v2(box.repo);

    await box.hedge("apply");

    expect(box.read(skill)).toBe("# my review\n");
    expect(box.lines.join("\n")).toContain("packs/team/skills/review/SKILL.md");
  });

  test("refuses a force-push that does not build on the applied commit", async () => {
    const box = await machine();
    await forcePushOrphan(box.repo);

    expect(await box.hedge("refresh")).toBe(1);

    expect(box.read(guide)).toBe("Rules v1.\n");
    expect(box.lines.join("\n")).toContain("does not build on");
  });

  test("skips a source whose cache another Hedge run works in", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.cache, "team.lock"))!;
    try {
      expect(await box.hedge("refresh")).toBe(0);
      expect(box.read(guide)).toBe("Rules v1.\n");
    } finally {
      held.release();
    }

    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("hedge apply waits for a source's cache lock", async () => {
    const box = await machine();
    await v2(box.repo);
    const held = tryLock(join(box.cache, "team.lock"))!;
    box.clock.onSleep = () => held.release();

    expect(await box.hedge("apply")).toBe(0);

    expect(box.clock.naps.length).toBeGreaterThan(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
  });

  test("prints a failed fetch", async () => {
    const box = await machine();
    renameSync(box.repo, `${box.repo}.away`);

    expect(await box.hedge("refresh")).toBe(1);
    expect(box.lines.join("\n")).toContain("could not reach");
  });

  test("refreshes a branch across refs/heads/ respellings and branch fallbacks, never a tag fallback or malformed record", async () => {
    const box = await machine("main");
    box.pin("refs/heads/main");
    await v2(box.repo);
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");

    await spawnGit(box.repo, "checkout", "-q", "-b", "release");
    writeFileSync(join(box.repo, "packs/team/pack.json"), "{broken");
    await spawnGit(box.repo, "commit", "-q", "-am", "broken");
    box.pin("release");
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
    await spawnGit(box.repo, "reset", "-q", "--hard", "HEAD~1");
    await commit(box.repo, "v3", { "packs/team/rules.md": "Rules v3.\n", "packs/team/AGENTS.md": "Team v3.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v3.\n");

    await spawnGit(box.repo, "checkout", "-q", "-b", "v2");
    writeFileSync(join(box.repo, "packs/team/pack.json"), "{broken");
    await spawnGit(box.repo, "commit", "-q", "-am", "broken tag");
    await spawnGit(box.repo, "tag", "-f", "v2");
    await spawnGit(box.repo, "reset", "-q", "--hard", "HEAD~1");
    await commit(box.repo, "branch-v2", { "packs/team/rules.md": "Branch v2.\n", "packs/team/AGENTS.md": "Team v2.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    box.pin("v2");
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v3.\n");

    const bad = await machine("main");
    const head = await spawnGit(bad.repo, "rev-parse", "main");
    writeFileSync(join(bad.cache, "team/.git/hedge-source.json"), JSON.stringify({ repo: bad.repo, commit: head, ref: 42 }));
    await v2(bad.repo);
    expect(await bad.hedge("refresh")).toBe(0);
    expect(bad.read(guide)).toBe("Rules v1.\n");
  });

  test("refreshes a 40-character hexadecimal branch shortened to its bare name and keeps the refreshed commit available offline", async () => {
    const hex40 = "e".repeat(40);
    const box = await machine("main");
    await spawnGit(box.repo, "checkout", "-q", "-b", hex40);
    const tip1 = await spawnGit(box.repo, "rev-parse", "HEAD");
    box.pin(`refs/heads/${hex40}`);
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v1.\n");

    box.pin(hex40);
    await v2(box.repo);
    const tip2 = await spawnGit(box.repo, "rev-parse", "HEAD");
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");

    box.pin(tip1);
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v1.\n");

    rmSync(box.repo, { recursive: true, force: true });
    box.lines.length = 0;
    box.pin(tip2);
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");
    expect(box.lines.join("\n")).not.toContain("could not fetch");
  });

  test("refreshes a branch whose name starts with a plus sign after shortening refs/heads/+release", async () => {
    const box = await machine("main");
    await spawnGit(box.repo, "checkout", "-q", "-b", "+release");
    box.pin("refs/heads/+release");
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v1.\n");

    box.pin("+release");
    await commit(box.repo, "mid", { "packs/team/rules.md": "Rules mid.\n", "packs/team/AGENTS.md": "Team mid.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    const midSha = await spawnGit(box.repo, "rev-parse", "HEAD");
    await v2(box.repo);
    expect(await box.hedge("refresh")).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");

    const v3Repo = box.repo;
    box.pin("refs/heads/+release");
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules v2.\n");

    rmSync(v3Repo, { recursive: true, force: true });
    box.lines.length = 0;
    box.pin(midSha);
    expect(await box.hedge("apply", "--profile", box.profile)).toBe(0);
    expect(box.read(guide)).toBe("Rules mid.\n");
    expect(box.lines.join("\n")).not.toContain("could not fetch");

    const plusMain = await machine("+main");
    expect(await plusMain.hedge("apply", "--profile", plusMain.profile)).toBe(0);
    expect(plusMain.read(guide)).toBe("Rules v1.\n");
    plusMain.pin("main");
    await v2(plusMain.repo);
    expect(await plusMain.hedge("refresh")).toBe(0);
    expect(plusMain.read(guide)).toBe("Rules v2.\n");

    const bothPlus = await machine("+main");
    await spawnGit(bothPlus.repo, "checkout", "-q", "-b", "+main");
    await commit(bothPlus.repo, "plus", { "packs/team/rules.md": "Plus branch.\n", "packs/team/AGENTS.md": "Plus.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    await spawnGit(bothPlus.repo, "checkout", "-q", "main");
    expect(await bothPlus.hedge("apply", "--profile", bothPlus.profile)).toBe(0);
    expect(bothPlus.read(guide)).toBe("Rules v1.\n");
    await v2(bothPlus.repo);
    expect(await bothPlus.hedge("refresh")).toBe(0);
    expect(bothPlus.read(guide)).toBe("Rules v2.\n");

    const legacyBroken = await machine("main");
    expect(await legacyBroken.hedge("apply", "--profile", legacyBroken.profile)).toBe(0);
    const cacheDir = join(legacyBroken.home, ".local/share/hedge/sources/team");
    const goodCommit = await spawnGit(legacyBroken.repo, "rev-parse", "HEAD");
    await commit(legacyBroken.repo, "broken", { "packs/team/pack.json": "{not json" });
    await spawnGit(cacheDir, "fetch", "-q", "--no-tags", legacyBroken.repo, "main");
    writeFileSync(join(cacheDir, ".git/hedge-source.json"), JSON.stringify({ repo: legacyBroken.repo, ref: "main", commit: goodCommit }) + "\n");
    await v2(legacyBroken.repo);
    expect(await legacyBroken.hedge("refresh")).toBe(0);
    expect(legacyBroken.read(guide)).toBe("Rules v2.\n");

    const literalPlus = await machine("refs/heads/+release");
    await spawnGit(literalPlus.repo, "checkout", "-q", "-b", "+release");
    await spawnGit(literalPlus.repo, "checkout", "-q", "-b", "release");
    await spawnGit(literalPlus.repo, "checkout", "-q", "+release");
    expect(await literalPlus.hedge("apply", "--profile", literalPlus.profile)).toBe(0);
    expect(literalPlus.read(guide)).toBe("Rules v1.\n");
    literalPlus.pin("+release");
    await commit(literalPlus.repo, "plus-v2", { "packs/team/rules.md": "Plus release v2.\n", "packs/team/AGENTS.md": "Plus v2.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    await spawnGit(literalPlus.repo, "checkout", "-q", "release");
    await commit(literalPlus.repo, "plain-v2", { "packs/team/rules.md": "Plain release v2.\n", "packs/team/AGENTS.md": "Plain v2.\n", "packs/team/skills/review/SKILL.md": "# review\n" });
    expect(await literalPlus.hedge("refresh")).toBe(0);
    expect(literalPlus.read(guide)).toBe("Plus release v2.\n");
  });
});
