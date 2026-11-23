import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv, template, tempDirs } from "../../../../src/testing/git.ts";
import { writeHome } from "../../../hub/lib/testing.ts";
import { dreamCommand } from "./command.ts";
import { isSigned, note, quietIo, realGit, signCommits } from "./testing.ts";

const temp = tempDirs();
afterAll(() => temp.cleanup());

const committedIndex = `# Memory index

- [Rule](tech/rule.md) — the rule
- [Other](other.md) — another
- [Old](old.md) — old one

## Repositories
- [hedge](projects/hedge/INDEX.md) — hedge
`;
const committedHedgeIndex = "# hedge\n\n- [Proj](proj.md) — proj\n";

const memoryRepo = template((home) => {
  const repo = join(home, "repo");
  git(home, "init", "-q", "-b", "main", repo);
  writeHome(repo, {
    "README.md": "# Notes\n",
    "memory/MEMORY.md": committedIndex,
    "memory/tech/rule.md": note("rule"),
    "memory/other.md": note("other"),
    "memory/old.md": note("old"),
    "memory/projects/hedge/INDEX.md": committedHedgeIndex,
    "memory/projects/hedge/proj.md": note("proj"),
  });
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "memory: hub");
});

async function memoryWorktree() {
  const home = await memoryRepo(temp.make("hedge-dream-commit-"));
  const repo = join(home, "repo");
  const dream = (args: string[]) => {
    const { io, printed, said } = quietIo(home, { cwd: repo, git: realGit });
    return dreamCommand(["commit", ...args], io).then((code) => ({ code, printed, said }));
  };
  return { home, repo, dream };
}

const record = ["--why", "It was wrong.", "--prevalence", "3 sessions on hub", "--evidence", "hub claude s-1, hub claude s-2", "--topics", "rule, rules", "--co-author", "Test Agent <agent@example.com>"];
const head = (repo: string) => git(repo, "rev-parse", "HEAD");
const statusOf = (repo: string) => Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, env: gitEnv }).stdout.toString().split("\n").filter(Boolean).sort();
const blobAt = (repo: string, spec: string) => Bun.spawnSync(["git", "cat-file", "blob", spec], { cwd: repo, env: gitEnv }).stdout.toString();
const changedIn = (repo: string, rev: string) => git(repo, "show", "--name-status", "--no-renames", "--format=", rev).split("\n").sort();

test("commit writes the dream's message and commits the named memories with only their own index lines", async () => {
  const { repo, dream } = await memoryWorktree();
  const worktreeIndex = committedIndex
    .replace("— the rule", "— the rule, sharper")
    .replace("— another", "— another, changed")
    .replace("- [Old](old.md) — old one\n", "- [New](new.md) — new\n");
  const worktreeHedgeIndex = "# hedge\n\n- [Proj](proj.md) — proj, renamed\n- [Later](later.md) — later\n";
  writeHome(repo, {
    "memory/MEMORY.md": worktreeIndex,
    "memory/tech/rule.md": note("rule", {}, "Sharper."),
    "memory/other.md": note("other", {}, "Changed."),
    "memory/new.md": note("new"),
    "memory/projects/hedge/INDEX.md": worktreeHedgeIndex,
    "memory/projects/hedge/proj.md": note("proj", {}, "Renamed."),
    "memory/projects/hedge/later.md": note("later"),
  });
  rmSync(join(repo, "memory/old.md"));

  const { code, printed } = await dream(["Update: rule", ...record, "memory/tech/rule.md", "memory/new.md", "memory/projects/hedge/proj.md"]);

  expect(code).toBe(0);
  expect(printed).toEqual([`${git(repo, "rev-parse", "--short", "HEAD")} Update: rule`]);
  expect(git(repo, "log", "-1", "--format=%B")).toBe("Update: rule\n\nIt was wrong.\nPrevalence: 3 sessions on hub\nEvidence: hub claude s-1, hub claude s-2\nTopics: rule, rules\n\nCo-Authored-By: Test Agent <agent@example.com>");
  expect(changedIn(repo, "HEAD")).toEqual(["A\tmemory/new.md", "M\tmemory/MEMORY.md", "M\tmemory/projects/hedge/INDEX.md", "M\tmemory/projects/hedge/proj.md", "M\tmemory/tech/rule.md"]);
  expect(git(repo, "show", "HEAD:memory/MEMORY.md")).toBe(committedIndex.replace("— the rule", "— the rule, sharper").replace("- [Old](old.md) — old one\n", "- [New](new.md) — new\n- [Old](old.md) — old one\n").trimEnd());
  expect(git(repo, "show", "HEAD:memory/projects/hedge/INDEX.md")).toBe("# hedge\n\n- [Proj](proj.md) — proj, renamed");
  expect(statusOf(repo)).toEqual([" D memory/old.md", " M memory/MEMORY.md", " M memory/other.md", " M memory/projects/hedge/INDEX.md", "?? memory/projects/hedge/later.md"]);
  expect(readFileSync(join(repo, "memory/MEMORY.md"), "utf8")).toBe(worktreeIndex);
});

test("commit takes a move made with git mv and a deletion made with git rm, with their index lines", async () => {
  const { repo, dream } = await memoryWorktree();
  git(repo, "mv", "memory/other.md", "memory/tech/other.md");
  writeHome(repo, { "memory/MEMORY.md": committedIndex.replace("(other.md)", "(tech/other.md)").replace("- [Old](old.md) — old one\n", "") });

  const moved = await dream(["Move: other", ...record, "memory/other.md", "memory/tech/other.md"]);
  const moveCommit = head(repo);
  git(repo, "rm", "-q", "memory/old.md");
  const deleted = await dream(["Delete: old", ...record, "memory/old.md"]);

  expect([moved.code, deleted.code]).toEqual([0, 0]);
  expect(changedIn(repo, moveCommit)).toEqual(["A\tmemory/tech/other.md", "D\tmemory/other.md", "M\tmemory/MEMORY.md"]);
  expect(changedIn(repo, "HEAD")).toEqual(["D\tmemory/old.md", "M\tmemory/MEMORY.md"]);
  expect(git(repo, "show", `${moveCommit}:memory/MEMORY.md`)).toContain("- [Other](tech/other.md) — another\n- [Old](old.md)");
  expect(statusOf(repo)).toEqual([]);
});

test("commit refuses a deletion it was not given, staged or inside a named folder, and commits nothing", async () => {
  const cases: Array<[string, (repo: string) => void, string[], string]> = [
    ["staged", (repo) => git(repo, "rm", "-q", "memory/old.md"), ["memory/tech/rule.md"], "Hedge dream: the index holds staged changes you did not name: memory/old.md. Name them, or unstage them with git restore --staged."],
    ["folder", (repo) => rmSync(join(repo, "memory/projects/hedge/proj.md")), ["memory/projects/hedge"], "Hedge dream: memory/projects/hedge/proj.md is deleted, and you did not name it. Name each deleted file to commit its deletion."],
    ["gitlink", (repo) => {
      git(repo, "config", "diff.ignoreSubmodules", "all");
      git(repo, "update-index", "--add", "--cacheinfo", `160000,${head(repo)},memory/vendor`);
    }, ["memory/tech/rule.md"], "Hedge dream: the index holds staged changes you did not name: memory/vendor. Name them, or unstage them with git restore --staged."],
    ["new index", (repo) => writeHome(repo, { "memory/projects/web/INDEX.md": "# web\n\n- [Rule](../../tech/rule.md) — rule\n" }), ["memory/tech/rule.md"], "Hedge dream: memory/projects/web/INDEX.md is new and links to a named file. Name it too."],
  ];
  for (const [name, change, paths, refusal] of cases) {
    const { repo, dream } = await memoryWorktree();
    writeHome(repo, { "memory/tech/rule.md": note("rule", {}, "Sharper."), "memory/projects/hedge/INDEX.md": `${committedHedgeIndex}- [More](more.md) — more\n`, "memory/projects/hedge/more.md": note("more") });
    change(repo);
    const before = head(repo);

    const { code, said } = await dream(["Update: rule", ...record, ...paths]);

    expect([name, code, said]).toEqual([name, 1, [refusal]]);
    expect(head(repo)).toBe(before);
  }
});

test("commit refuses a named path with no change, such as a misspelt one, and commits nothing", async () => {
  const { repo, dream } = await memoryWorktree();
  writeHome(repo, { "memory/tech/rule.md": note("rule", {}, "Sharper.") });
  const before = head(repo);

  const { code, said } = await dream(["Update: rule", ...record, "memory/tech/rule.md", "memory/tech/rlue.md"]);

  expect(code).toBe(1);
  expect(said).toEqual(["Hedge dream: memory/tech/rlue.md has no change to commit."]);
  expect(head(repo)).toBe(before);
  expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
});

test("commit signs as the checkout says, and tries once more when signing times out", async () => {
  const { home, repo, dream } = await memoryWorktree();
  const signer = signCommits(repo, home);
  signer.timeOut(1);
  writeHome(repo, { "memory/tech/rule.md": note("rule", {}, "Sharper.") });

  const signed = await dream(["Update: rule", ...record, "memory/tech/rule.md"]);

  expect(signed.code).toBe(0);
  expect(isSigned(repo, "HEAD")).toBe(true);
  signer.timeOut(2);
  writeHome(repo, { "memory/other.md": note("other", {}, "Staged.") });
  git(repo, "add", "memory/other.md");
  writeHome(repo, { "memory/other.md": note("other", {}, "Changed.") });
  const before = head(repo);

  const timedOut = await dream(["Update: other", ...record, "memory/other.md"]);

  expect(timedOut.code).toBe(1);
  expect(timedOut.said).toEqual(["Hedge dream: signing the commit timed out twice. Commit again."]);
  expect(head(repo)).toBe(before);
  expect(statusOf(repo)).toEqual(["MM memory/other.md"]);
  expect(blobAt(repo, ":memory/other.md")).toBe(note("other", {}, "Staged."));
});

test("commit keeps every index line it does not take where it was, whatever the diff settings, link form, or final newline", async () => {
  const lines = committedIndex.split("\n");
  const cases: Array<{ name: string; config?: [string, string]; committed?: string; worktree: string; files: Record<string, string>; named: string[]; expected: string }> = [
    {
      name: "renamed heading below a new line",
      worktree: committedIndex.replace("## Repositories", "- [New](new.md) — new\n## Repos"),
      files: { "memory/new.md": note("new") }, named: ["memory/new.md"],
      expected: committedIndex.replace("## Repositories", "- [New](new.md) — new\n## Repositories"),
    },
    {
      name: "hunks joined over an unchanged line",
      config: ["diff.interHunkContext", "1"],
      worktree: committedIndex.replace("— the rule", "— the rule, sharper").replace("— old one", "— old one, changed"),
      files: { "memory/tech/rule.md": note("rule", {}, "Sharper.") }, named: ["memory/tech/rule.md"],
      expected: committedIndex.replace("— the rule", "— the rule, sharper"),
    },
    {
      name: "links with spaces and escapes",
      worktree: committedIndex.replace("## Repositories", "- [Café](<café notes.md>) — c\n- [Plain](plain%20notes.md) — p\n## Repositories"),
      files: { "memory/café notes.md": note("cafe"), "memory/plain notes.md": note("plain") }, named: ["memory/café notes.md", "memory/plain notes.md"],
      expected: committedIndex.replace("## Repositories", "- [Café](<café notes.md>) — c\n- [Plain](plain%20notes.md) — p\n## Repositories"),
    },
    {
      name: "no final newline",
      committed: lines.slice(0, -1).join("\n"),
      worktree: lines.slice(0, -1).join("\n").replace("— the rule", "— the rule, sharper"),
      files: { "memory/tech/rule.md": note("rule", {}, "Sharper.") }, named: ["memory/tech/rule.md"],
      expected: lines.slice(0, -1).join("\n").replace("— the rule", "— the rule, sharper"),
    },
  ];
  for (const item of cases) {
    const { repo, dream } = await memoryWorktree();
    if (item.committed !== undefined) {
      writeHome(repo, { "memory/MEMORY.md": item.committed });
      git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "memory: hub");
    }
    if (item.config) git(repo, "config", ...item.config);
    writeHome(repo, { "memory/MEMORY.md": item.worktree, ...item.files });

    const { code } = await dream(["Add: note", ...record, ...item.named]);

    expect([item.name, code, blobAt(repo, "HEAD:memory/MEMORY.md")]).toEqual([item.name, 0, item.expected]);
    expect([item.name, readFileSync(join(repo, "memory/MEMORY.md"), "utf8")]).toEqual([item.name, item.worktree]);
  }
});

test("commit takes an absolute path through a symlink to the memory folder", async () => {
  const { home, repo } = await memoryWorktree();
  symlinkSync(join(repo, "memory"), join(home, "notes"));
  writeHome(repo, { "memory/tech/rule.md": note("rule", {}, "Sharper.") });
  const { io } = quietIo(home, { cwd: join(home, "notes"), git: realGit });

  expect(await dreamCommand(["commit", "Update: rule", ...record, join(home, "notes/tech/rule.md")], io)).toBe(0);

  expect(changedIn(repo, "HEAD")).toEqual(["M\tmemory/tech/rule.md"]);
});

test("commit reports success when Git timed out after the commit landed, and makes no second commit", async () => {
  const { home, repo } = await memoryWorktree();
  writeHome(repo, { "memory/tech/rule.md": note("rule", {}, "Sharper.") });
  const before = head(repo);
  const slowHook = async (args: string[]) => {
    const answer = await realGit(args);
    return args.includes("commit") ? { code: 124, stdout: "", stderr: "timed out after 300000 ms" } : answer;
  };
  const { io, printed } = quietIo(home, { cwd: repo, git: slowHook });

  expect(await dreamCommand(["commit", "Update: rule", ...record, "memory/tech/rule.md"], io)).toBe(0);

  expect(git(repo, "rev-parse", "HEAD~1")).toBe(before);
  expect(printed).toEqual([`${git(repo, "rev-parse", "--short", "HEAD")} Update: rule`]);
});

test("commit without its subject, a record line, or a path prints its usage and exits 2", async () => {
  const { dream } = await memoryWorktree();
  const usage = "Usage: hedge dream commit \"<Verb>: <memory name>\" --why <text> --prevalence <text> --evidence <text> --topics <text> [--co-author \"<name> <email>\"] <path>...";
  const cases = [
    [...record, "memory/tech/rule.md"],
    ["rule", ...record, "memory/tech/rule.md"],
    ["Update: rule", ...record.slice(2), "memory/tech/rule.md"],
    ["Update: rule", ...record],
    ["Update: rule", "--why", "One.\nPrevalence: forged", ...record.slice(2), "memory/tech/rule.md"],
  ];
  for (const args of cases) {
    const { code, said } = await dream(args);
    expect([args, code, said]).toEqual([args, 2, [usage]]);
  }
});
