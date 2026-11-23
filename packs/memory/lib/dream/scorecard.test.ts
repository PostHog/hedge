import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, spawnGit, tempDirs } from "../../../../src/testing/git.ts";
import { spawnAsync } from "../../../../src/testing/spawn.ts";
import { dreamCommand } from "./command.ts";
import { readMemories, recordRuns, scorecardText, weekOf } from "./scorecard.ts";
import { hubWithSubtree, quietIo, realGit } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const now = Date.parse("2026-11-05T04:10:00Z");
const index = { "MEMORY.md": "# Memory\n" };

async function gitRepo(checkout = temp.make("hedge-memory-")) {
  await spawnGit(checkout, "init", "--quiet", "-b", "main");
  const commit = async (message: string, date: string, files: Record<string, string>, change: { remove?: string[]; rename?: Record<string, string> } = {}) => {
    for (const [from, to] of Object.entries(change.rename ?? {})) {
      mkdirSync(join(checkout, to, ".."), { recursive: true });
      await spawnGit(checkout, "mv", from, to);
    }
    for (const path of change.remove ?? []) rmSync(join(checkout, path));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), text);
    }
    await spawnAsync(["git", "add", "-A"], { cwd: checkout, env: gitEnv });
    await spawnAsync(["git", "commit", "--quiet", "-m", message], { cwd: checkout, env: { ...gitEnv, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  };
  return { checkout, commit };
}

async function memoryRepo() {
  const { checkout, commit } = await gitRepo();
  await commit("Import the memory", "2026-10-01T00:00:00Z", index);
  await commit("Add: run-tests\n\nTopics: test-first", "2026-10-20T00:00:00Z", { "MEMORY.md": "# Memory\n- [Tests](tech/run-tests.md)\n", "tech/run-tests.md": "---\nname: run-tests\n---\nRun them.\n" });
  await commit("Report", "2026-10-20T01:00:00Z", { "dreams/2026-10-20.md": "report\n" });
  return checkout;
}

type Session = { id: string; startedAt: string; reads?: string[]; mistakes: string[] };

function dreamState(sessions: Session[], state = temp.make("hedge-dream-state-")) {
  const run = join(state, "2026-11-04");
  mkdirSync(join(run, "digests"), { recursive: true });
  mkdirSync(join(run, "findings"), { recursive: true });
  for (const session of sessions) {
    const digest = { machine: "devbox-1", provider: "claude", session: session.id, cwd: "/x", repo: "app", model: "m", startedAt: session.startedAt, endedAt: session.startedAt, toolCalls: 1, skills: [], memoryReads: session.reads ?? [], memoryWrites: [], tokens: 5, entries: [] };
    const findings = session.mistakes.map((topic) => ({ kind: "repeated-failure", topic, scope: "app", reach: "general", claim: "c", evidence: "e", memory: "", importance: 2 }));
    writeFileSync(join(run, "digests", `${session.id}.json`), JSON.stringify(digest));
    writeFileSync(join(run, "findings", `${session.id}.json`), JSON.stringify({ taskType: "fix", findings }));
  }
  return state;
}

const reader = (checkout: string) => async (args: string[]) => (await spawnGit(checkout, ...args)) + "\n";
const card = (checkout: string, sessions: Session[]) => scorecardText(dreamState(sessions), checkout, reader(checkout), now);

test("readMemories reads each memory with the topics of its commits, and skips the index and the dream reports", async () => {
  const checkout = await memoryRepo();
  const memories = await readMemories(checkout, reader(checkout));
  expect(memories.map((memory) => [memory.path, [...memory.topics].sort(), memory.addedAt?.slice(0, 10)])).toEqual([["tech/run-tests.md", ["run-tests", "test-first"], "2026-10-20"]]);
});

test("readMemories reads the memories of a memory.subtree folder by their paths in that folder", async () => {
  const { checkout: repo, commit } = await gitRepo();
  await commit("Add: run-tests\n\nTopics: test-first", "2026-10-20T00:00:00Z", { "memory/MEMORY.md": "# Memory\n- [Tests](tech/run-tests.md)\n", "memory/tech/run-tests.md": "---\nname: run-tests\n---\nRun them.\n", "app/notes.md": "not memory\n" });
  const checkout = join(repo, "memory");
  const memories = await readMemories(checkout, reader(checkout));
  expect(memories.map((memory) => [memory.path, [...memory.topics].sort()])).toEqual([["tech/run-tests.md", ["run-tests", "test-first"]]]);
});

test("recordRuns copies each analyzed session into the ledger without its text, and the scorecard counts a repeat on a remembered topic", async () => {
  const checkout = await memoryRepo();
  const state = temp.make("hedge-dream-state-");
  const run = join(state, "2026-10-28");
  mkdirSync(join(run, "digests"), { recursive: true });
  mkdirSync(join(run, "findings"), { recursive: true });
  const digest = { machine: "devbox-1", provider: "claude", session: "s-1", cwd: "/x", repo: "app", model: "m", startedAt: "2026-10-27T10:00:00Z", endedAt: "2026-10-27T11:00:00Z", toolCalls: 1, skills: [], memoryReads: [], memoryWrites: [], tokens: 5, entries: [{ at: "", role: "user", text: "secret words" }] };
  writeFileSync(join(run, "digests", "a.json"), JSON.stringify(digest));
  writeFileSync(join(run, "findings", "a.json"), JSON.stringify({ taskType: "fix", findings: [{ kind: "repeated-failure", topic: "test-first", scope: "app", reach: "general", claim: "c", evidence: "e", memory: "", importance: 2 }] }));
  expect(recordRuns(state, now)).toBe(1);
  expect(readFileSync(join(state, "ledger.json"), "utf8")).not.toContain("secret words");
  const text = await scorecardText(state, checkout, reader(checkout), now);
  expect(text).toContain(`| Week of | ${weekOf("2026-10-27").slice(5)} |`);
  expect(text).toContain("| 1. Repeat mistakes on remembered topics, per 100 sessions | 100.0 |");
  expect(text).toContain("1. `tech/run-tests.md`: recurs and was never opened (1): sharpen its index line");
  expect(text).not.toContain("holdout");
});

test("a commit's topics count only for the memory they name, and its other topics only for the memory its subject names", async () => {
  const { checkout, commit } = await gitRepo();
  await commit("Import the memory", "2026-10-01T00:00:00Z", index);
  await commit("Update: beta\n\nTopics: alpha, flaky-ci", "2026-10-10T00:00:00Z", { "alpha.md": "Alpha.\n", "beta.md": "Beta.\n" });
  const text = await card(checkout, [
    { id: "s-1", startedAt: "2026-10-27T10:00:00Z", mistakes: ["flaky-ci"] },
    { id: "s-2", startedAt: "2026-10-28T10:00:00Z", mistakes: ["alpha"] },
  ]);
  expect(text).toContain("`alpha.md`: recurs and was never opened (1)");
  expect(text).toContain("`beta.md`: recurs and was never opened (1)");
});

test("a read of a memory under a path it had before a rename or a move counts as a read of it", async () => {
  const { checkout, commit } = await gitRepo();
  await commit("Import the memory", "2026-10-01T00:00:00Z", index);
  await commit("Add: two memories", "2026-10-05T00:00:00Z", { "fleet-proof-traps.md": "Proofs need full SHAs.\n", "projects/fleet/relogin.md": "Log in again\nwith the old steps\nthat no longer apply\n" });
  await commit("memory: migrate fleet memories to hedge", "2026-10-10T00:00:00Z", { "projects/hedge/relogin.md": "Sign in headless\nthrough the secret card\nand restart the proxy\n" }, { rename: { "fleet-proof-traps.md": "hedge-proof-traps.md" }, remove: ["projects/fleet/relogin.md"] });
  const text = await card(checkout, [{ id: "s-1", startedAt: "2026-10-27T10:00:00Z", reads: ["fleet-proof-traps.md", "projects/fleet/relogin.md"], mistakes: ["fleet-proof-traps", "relogin"] }]);
  expect(text).toContain("`hedge-proof-traps.md`: recurs although read (1)");
  expect(text).toContain("`projects/hedge/relogin.md`: recurs although read (1)");
});

test("a memory that came with the import has no known start: its mistakes count as repeats in every week, and it has no before and after", async () => {
  const { checkout, commit } = await gitRepo();
  await commit("context: move notes and memory here", "2026-10-14T00:00:00Z", { ...index, "imported.md": "An old lesson.\n" });
  const text = await card(checkout, [
    { id: "s-1", startedAt: "2026-10-08T10:00:00Z", mistakes: ["imported"] },
    { id: "s-2", startedAt: "2026-10-15T10:00:00Z", mistakes: ["imported"] },
  ]);
  expect(text).toContain("| 1. Repeat mistakes on remembered topics, per 100 sessions | 100.0 | 100.0 |");
  expect(text).toContain("No memory has sessions before and after its merge yet.");
});

test("scorecard on a checkout of the memory repository names each memory by its path in the memory.subtree folder, so the sessions' reads match it", async () => {
  const home = temp.make("hedge-dream-home-");
  hubWithSubtree(home);
  const repo = join(home, ".agents/memory-repo");
  const { commit } = await gitRepo(repo);
  await commit("Import the memory", "2026-10-01T00:00:00Z", { "memory/MEMORY.md": "# Memory\n" });
  await commit("Add: run-tests", "2026-10-20T00:00:00Z", { "memory/run-tests.md": "Run them.\n" });
  dreamState([{ id: "s-1", startedAt: "2026-10-27T10:00:00Z", reads: ["run-tests.md"], mistakes: ["run-tests"] }], join(home, ".local/state/hedge/dream"));
  const { io, printed } = quietIo(home, { git: realGit });
  expect(await dreamCommand(["scorecard", repo], io)).toBe(0);
  expect(printed.join("\n")).toContain("1. `run-tests.md`: recurs although read (1)");
});
