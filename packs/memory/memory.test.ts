import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { spawnGit, tempDirs } from "../../src/testing/git.ts";
import { skillSources, devbox, engineSource, fileContent, resolveEngine } from "../../src/testing/packs.ts";
import { memoryUrl, syncMemory } from "./commands/memory-sync.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const withPack = (fields = {}) =>
  resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["memory"], settings: { "memory.repo": "me/notes" }, ...fields }, devbox);

describe("the Memory pack", () => {
  test("asks for the memory repo at setup", () => {
    expect(withPack({ settings: {} }).unanswered.map((setting) => setting.key)).toEqual(["memory.repo"]);
  });

  test("points Claude's auto memory at the checkout and syncs every five minutes", () => {
    const result = withPack();
    expect(result.config).toContainEqual(expect.objectContaining({ provider: "claude", key: "autoMemoryDirectory", value: "~/.agents/memory" }));
    expect(result.jobs).toContainEqual(expect.objectContaining({ id: "memory-sync", command: ["hedge", "memory-sync"], schedule: { every: "5m" } }));
    expect(fileContent(result, ".agents/guides/memory.md")).toContain("`~/.agents/memory`");
    expect(Object.keys(result.commands)).toContain("memory-sync");
  });

  test("leaves the Claude parts out for a Codex-only plan", () => {
    const result = withPack({ plan: "codex" });
    expect(result.config.some((entry) => entry.key === "autoMemoryDirectory")).toBe(false);
    expect(result.jobs.map((job) => job.id)).toContain("memory-sync");
  });

  test("reads the memory repo from the settings hedge passes", async () => {
    await expect(syncMemory({ HEDGE_SETTINGS: JSON.stringify({ "memory.repo": "" }) })).rejects.toThrow("Set it with hedge set memory.repo=<owner>/<repo>.");
    await expect(syncMemory({})).rejects.toThrow("run this command as hedge <command>");
  });

  test("turns a repo name into a GitHub URL and keeps a full URL", () => {
    expect(memoryUrl("me/notes")).toBe("https://github.com/me/notes.git");
    expect(memoryUrl("git@example.com:me/notes.git")).toBe("git@example.com:me/notes.git");
  });
});

describe("the memory index hook", () => {
  const indexHook = join(import.meta.dir, "hooks/memory-index.ts");

  test("answers nothing and lets the agent go on when it cannot read its input", async () => {
    const unreadable = openSync(temp.make("stdin-"), "r");
    try {
      const child = Bun.spawn([process.execPath, indexHook, "claude"], { stdin: unreadable, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: temp.make("home-") } });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
    } finally {
      closeSync(unreadable);
    }
  });

  test("answers nothing for an unknown agent without waiting for its input", async () => {
    const child = Bun.spawn([process.execPath, indexHook, "gemini"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
  });

  test("gives Codex the main and repo indexes and Claude only the repo index through the installed runner", async () => {
    const home = temp.make("home-");
    const hooksDir = join(home, ".config/hedge/hooks/SessionStart");
    mkdirSync(hooksDir, { recursive: true });
    symlinkSync(indexHook, join(hooksDir, "memory-index.ts"));
    symlinkSync(join(import.meta.dir, "../base/hooks/run.ts"), join(home, ".config/hedge/hooks/run.ts"));
    mkdirSync(join(home, ".agents/memory/projects/notes-app"), { recursive: true });
    writeFileSync(join(home, ".agents/memory/MEMORY.md"), "# Memory index\n- [Ask before deleting](ask.md)\n");
    writeFileSync(join(home, ".agents/memory/projects/notes-app/INDEX.md"), "# notes-app\n- [Flaky sync test](flaky.md)\n");
    const repo = join(home, "notes-app");
    mkdirSync(repo, { recursive: true });
    await spawnGit(repo, "init", "-q");
    await spawnGit(repo, "remote", "add", "origin", "git@github.com:someone/notes-app.git");

    const runInstalled = async (provider: "claude" | "codex") => {
      const child = Bun.spawn([process.execPath, join(home, ".config/hedge/hooks/run.ts"), provider, "SessionStart"], {
        env: { ...process.env, HOME: home },
        stdin: new Blob([JSON.stringify({ session_id: `s-${provider}`, cwd: repo, source: "startup" })]),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      return JSON.parse(await new Response(child.stdout).text()).hookSpecificOutput.additionalContext as string;
    };

    const codex = await runInstalled("codex");
    expect(codex).toContain("Ask before deleting");
    expect(codex).toContain("Flaky sync test");
    const claude = await runInstalled("claude");
    expect(claude).toContain("Flaky sync test");
    expect(claude).not.toContain("Ask before deleting");
  });
});
