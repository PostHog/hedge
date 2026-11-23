import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { type AutoOptions, type CacheHost, cwdsFromLsof, decide, evictable, onlyDisposable, prune, pruneOptions, type PruneOptions, readSightings, readState, reclaimCaches, reclaimT3Versions, recordSightings, removeTreeCommand, t3StatePath, type Facts, type Verdict } from "./prune.ts";

const onLinux = test.skipIf(process.platform !== "linux");
const noMergedPullRequests = () => false;

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const now = Date.parse("2026-09-25T12:00:00Z");
const limits = { now, minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24 };
const idle: Facts = {
  path: "/w/p/a", kind: "worktree", dirty: false, disposable: false, branch: "feature", unreferenced: 0, landed: true, defaultBranch: "origin/main",
  prMerged: false, inUse: false, lastActivity: now - 48 * 3600_000, thread: null, stateUnknown: false, agent: false,
};

test("removes an idle, clean worktree whose commits landed", () => {
  expect(decide(idle, limits)).toEqual({ path: "/w/p/a", remove: true, reason: "all commits are on origin/main" });
});

test("keeps work that is active, dirty, unmerged, or held only by the worktree", () => {
  const thread = { status: "stopped", archived: false, deleted: false, settled: false, wake: null, pending: false, activeAt: 0, openLead: false };
  const cases: Array<[Partial<Facts>, string]> = [
    [{ kind: "main" }, "primary checkout"],
    [{ inUse: true }, "a process runs inside it"],
    [{ thread: { ...thread, status: "running" } }, "T3 session is running"],
    [{ thread: { ...thread, pending: true } }, "T3 thread waits for an answer"],
    [{ lastActivity: now - 2 * 3600_000 }, "active 2.0h ago"],
    [{ dirty: true }, "uncommitted changes"],
    [{ branch: null, unreferenced: 3 }, "3 commits exist only in this worktree"],
    [{ landed: false }, "unmerged work"],
    [{ kind: "orphan", thread }, "Git does not track it, but its T3 thread is open"],
    [{ kind: "orphan", lastActivity: now - 12 * 3600_000 }, "Git does not track it; active 12.0h ago"],
    [{ kind: "broken", dirty: false }, "Git cannot read its worktree metadata"],
  ];
  for (const [change, reason] of cases) expect(decide({ ...idle, ...change }, limits)).toEqual({ path: idle.path, remove: false, reason });
});

test("keeps a landed or merged worktree while an open thread that is not a subagent uses it, and removes it otherwise", () => {
  const open = { status: "completed", archived: false, deleted: false, settled: false, wake: null, pending: false, activeAt: 0, openLead: true };
  const reason = "its T3 thread is open";
  expect(decide({ ...idle, branch: null, thread: open }, limits)).toEqual({ path: idle.path, remove: false, reason });
  expect(decide({ ...idle, landed: false, prMerged: true, thread: open }, limits)).toEqual({ path: idle.path, remove: false, reason });
  expect(decide({ ...idle, thread: { ...open, openLead: false } }, limits)).toMatchObject({ remove: true, reason: "all commits are on origin/main" });
  expect(decide({ ...idle, thread: { ...open, settled: true, openLead: false } }, limits)).toMatchObject({ remove: true, reason: "all commits are on origin/main" });
});

test("removes a worktree of a closed thread whose only changes are ones tools make, and keeps it while the thread is open", () => {
  const settled = { status: "completed", archived: false, deleted: false, settled: true, wake: null, pending: false, activeAt: 0, openLead: false };
  const touched = { ...idle, landed: false, dirty: true, disposable: true };
  expect(decide({ ...touched, thread: settled }, limits)).toMatchObject({ remove: true, reason: "T3 thread is settled; commits stay on feature; drops lockfile and tool output changes" });
  expect(decide({ ...touched, thread: { ...settled, settled: false } }, limits).reason).toBe("uncommitted changes");
  expect(decide({ ...touched, thread: settled, disposable: false }, limits).reason).toBe("uncommitted changes");
});

test("counts only lockfiles, symlinks, generated Convex code, and tool run output as disposable", () => {
  const symlinks = new Set(["node_modules"]);
  const disposable = (...entries: string[]) => onlyDisposable(entries.map((entry) => `${entry}\0`).join(""), (path) => symlinks.has(path));
  expect(disposable(" M pnpm-lock.yaml", "M  bun.lock", "?? node_modules", "?? .coherence/runs/a.jsonl", "?? .preview-sandbox/", " M convex/_generated/api.d.ts")).toBe(true);
  expect(disposable(" M pnpm-lock.yaml", " M package.json")).toBe(false);
  expect(disposable("?? notes.md")).toBe(false);
  expect(disposable("?? .coherence/")).toBe(false);
  expect(disposable(" D pnpm-lock.yaml")).toBe(false);
  expect(disposable("R  pnpm-lock.yaml", "src/lock.ts")).toBe(false);
});

const sh = async (cwd: string, ...command: string[]) => expect((await spawnAsync(command, { cwd })).exitCode).toBe(0);
const commit = async (cwd: string, message: string) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message);

/** A repository whose main branch is also origin/main, with an empty T3 worktree root next to it. */
async function repository(): Promise<{ base: string; repo: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "hedge-prune-"));
  temporary.push(base);
  const repo = join(base, "repo");
  await mkdir(repo);
  await sh(repo, "git", "init", "-q", "-b", "main");
  await writeFile(join(repo, "pnpm-lock.yaml"), "a\n");
  await writeFile(join(repo, "app.ts"), "a\n");
  await sh(repo, "git", "add", ".");
  await commit(repo, "init");
  await sh(repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  return { base, repo, root: join(base, "worktrees") };
}

type StateThread = {
  id?: string; createdAt?: string; archivedAt?: string; deletedAt?: string; worktreePath?: string | null; settledAt?: string;
  lineage?: { parentThreadId: string; relationshipToParent: string }; pullRequests?: object[]; running?: boolean; asking?: boolean;
};
type Schedule = { threadId: string; enabled: boolean; nextRunAt: string | null };

const realSchema = [
  `create table orchestration_v2_projection_threads (thread_id text primary key, project_id text not null, title text not null, default_provider text not null,
    runtime_mode text not null, interaction_mode text not null, active_provider_thread_id text, created_at text not null, updated_at text not null,
    archived_at text, deleted_at text, payload_json text not null, provider_instance_id text)`,
  `create table orchestration_v2_projection_runs (run_id text primary key, thread_id text not null, ordinal integer not null, provider text not null,
    provider_thread_id text, status text not null, requested_at text not null, completed_at text, payload_json text not null, provider_instance_id text)`,
  `create table orchestration_v2_projection_messages (message_id text primary key, thread_id text not null, run_id text, node_id text, role text not null,
    streaming integer not null, created_at text not null, updated_at text not null, payload_json text not null, search_text text)`,
  `create table orchestration_v2_projection_runtime_requests (runtime_request_id text primary key, thread_id text not null, node_id text not null,
    provider_turn_id text, kind text not null, status text not null, created_at text not null, resolved_at text, payload_json text not null)`,
  `create table scheduled_tasks (task_id text primary key, title text not null, prompt text not null, enabled integer not null, schedule_json text not null,
    project_id text not null, thread_id text, workspace_strategy_json text not null, model_selection_json text not null, runtime_mode text not null,
    interaction_mode text not null, created_by text not null, creation_source text not null, created_at text not null, updated_at text not null,
    next_run_at text, last_run_at text, last_run_status text not null, last_run_error text, run_count integer not null,
    webhook_token text, webhook_secret text, last_run_webhook_delivery_id text, thread_mode text not null default 'new_thread')`,
];

function t3State(path: string, threads: StateThread[], schedules: Schedule[] = []): string {
  const db = new Database(path);
  for (const table of realSchema) db.run(table);
  for (const thread of threads) {
    const id = thread.id ?? thread.worktreePath ?? crypto.randomUUID();
    const created = thread.createdAt ?? "2026-09-20T00:00:00Z";
    db.run(`insert into orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
      values (?, 'project', 'title', 'claude', 'full-access', 'default', ?, ?, ?, ?, ?)`, [id, created, created, thread.archivedAt ?? null, thread.deletedAt ?? null, JSON.stringify(thread)]);
    if (thread.running) db.run(`insert into orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      values (?, ?, 1, 'claude', 'running', ?, '{}')`, [`run-${id}`, id, created]);
    if (thread.asking) db.run(`insert into orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      values (?, ?, 'node', 'user-input', 'pending', ?, '{}')`, [`request-${id}`, id, created]);
  }
  db.close();
  for (const task of schedules) schedule(path, task);
  return path;
}

function endWatches(statePath: string, threadId: string): void {
  const db = new Database(statePath);
  const row = db.query("select payload_json payload from orchestration_v2_projection_threads where thread_id = ?").get(threadId) as { payload: string };
  const payload = JSON.parse(row.payload);
  payload.pullRequests = payload.pullRequests.map(({ watch, ...entry }: { watch: object }) => ({ ...entry, watch: null, endedWatch: watch }));
  db.run("update orchestration_v2_projection_threads set payload_json = ? where thread_id = ?", [JSON.stringify(payload), threadId]);
  db.close();
}

function schedule(statePath: string, task: Schedule): void {
  const db = new Database(statePath);
  db.run(`insert into scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
      workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, next_run_at, last_run_status, run_count, thread_mode)
    values (?, 'check', 'check', ?, '{}', 'project', ?, '{}', '{}', 'full-access', 'default', 'agent', 'mcp', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z', ?, 'never', 0, 'existing_thread')`,
    [crypto.randomUUID(), task.enabled ? 1 : 0, task.threadId, task.nextRunAt]);
  db.close();
}

onLinux("a prune pass removes a settled worktree that has only tool changes and keeps one with a real edit", async () => {
  const { base, repo, root } = await repository();
  const tooled = join(root, "repo/tooled");
  const edited = join(root, "repo/edited");
  for (const [path, branch] of [[tooled, "tooled"], [edited, "edited"]]) await sh(repo, "git", "worktree", "add", "-q", "-b", branch, path);
  const shared = join(base, "shared-node-modules");
  await mkdir(shared);
  await writeFile(join(shared, "kept"), "");
  await symlink(shared, join(tooled, "node_modules"));
  await writeFile(join(tooled, "pnpm-lock.yaml"), "b\n");
  await writeFile(join(edited, "app.ts"), "b\n");

  const statePath = t3State(join(base, "statev2.sqlite"), [tooled, edited].map((worktreePath) => ({ worktreePath, settledAt: "2026-09-21T00:00:00Z" })));

  const verdicts = prune({
    worktreeRoot: root, statePath, now: Date.now() + 48 * 3600_000, repos: [], minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24,
    dryRun: false, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"), mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === tooled)?.remove).toBe(true);
  expect(verdicts.find((verdict) => verdict.path === edited)).toMatchObject({ remove: false, reason: "uncommitted changes" });
  expect(await readdir(join(root, "repo"))).toEqual(["edited"]);
  expect(await readdir(shared)).toEqual(["kept"]);
});

const watching = (number: number) => ({ host: "github.com", repository: "acme/app", number, watch: { startedAt: "2026-09-21T00:00:00Z" } });
const ended = (number: number) => ({ host: "github.com", repository: "acme/app", number, watch: null, endedWatch: { startedAt: "2026-09-21T00:00:00Z" } });
const settledAt = "2026-09-21T00:00:00Z";
const evicted = (lines: string[]) => lines.filter((line) => line.startsWith("would evict")).map((line) => line.split(": ")[1].split(" (")[0]);
const scheduledFor = (...threadIds: string[]) => threadIds.map((threadId) => ({ threadId, enabled: true, nextRunAt: "2026-11-16T08:15:00.000Z" }));

async function landedWorktrees(...names: string[]) {
  const { base, repo, root } = await repository();
  const paths = names.map((name) => join(root, "repo", name));
  for (const path of paths) await sh(repo, "git", "worktree", "add", "-q", "-b", basename(path), path);
  return { base, root, paths };
}

function pass(base: string, root: string, statePath: string, change: Partial<PruneOptions> = {}): Verdict[] {
  return prune({
    worktreeRoot: root, statePath, now: Date.now() + 48 * 3600_000, repos: [], minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24,
    dryRun: false, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"), mergedPullRequest: noMergedPullRequests, ...change,
  });
}

const pressured = (later: number, lines: string[]): Partial<PruneOptions> => ({
  now: later, minIdleHours: 1, unownedIdleHours: 6, agentIdleHours: 6, dryRun: true, log: (line) => lines.push(line), evict: { targetGigabytes: 1, free: () => 0 },
});

onLinux("hedge prune on a home keeps the landed worktree of an open top-level thread and removes the one of a finished subagent", async () => {
  const home = await mkdtemp(join(tmpdir(), "hedge-prune-home-"));
  temporary.push(home);
  const repo = join(home, "repo");
  await mkdir(repo);
  await sh(repo, "git", "init", "-q", "-b", "main");
  await writeFile(join(repo, "app.ts"), "a\n");
  await sh(repo, "git", "add", ".");
  await commit(repo, "init");
  await sh(repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  const root = join(home, ".t3/worktrees/repo");
  const [lead, subagent, fork, woken] = ["lead", "subagent", "fork", "woken"].map((name) => join(root, name));
  const old = new Date(Date.now() - 48 * 3600_000);
  for (const path of [lead, subagent, fork, woken]) {
    await sh(repo, "git", "worktree", "add", "-q", "-b", basename(path), path);
    const gitDir = join(repo, ".git/worktrees", basename(path));
    for (const touched of [path, join(gitDir, "HEAD"), join(gitDir, "logs/HEAD")]) await utimes(touched, old, old);
  }
  await mkdir(join(home, ".t3/userdata"), { recursive: true });
  t3State(join(home, ".t3/userdata/statev2.sqlite"), [
    { id: "lead", worktreePath: lead },
    { id: "subagent", worktreePath: subagent, lineage: { parentThreadId: "lead", relationshipToParent: "subagent" } },
    { id: "fork", worktreePath: fork, lineage: { parentThreadId: "lead", relationshipToParent: "fork" } },
    { id: "woken", worktreePath: woken, settledAt, pullRequests: [ended(1), watching(2)] },
  ]);

  const run = await spawnAsync(["bun", join(import.meta.dir, "../commands/prune.ts"), "--no-fetch"], {
    env: { HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", XDG_STATE_HOME: join(home, ".local/state"), PATH: Bun.env.PATH, HEDGE_SETTINGS: JSON.stringify({ "base.diskFloorGigabytes": 0 }) },
  });

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain(`kept: ${lead} (its T3 thread is open)`);
  expect(run.stdout).toContain(`kept: ${fork} (its T3 thread is open)`);
  expect(run.stdout).toContain(`kept: ${woken} (its T3 thread watches acme/app#2)`);
  expect(run.stdout).toContain(`removed: ${subagent} (all commits are on origin/main)`);
  expect((await readdir(root)).sort()).toEqual(["fork", "lead", "woken"]);
});

onLinux("a prune pass keeps the landed worktree of a settled thread while an enabled scheduled task bound to it has a next run", async () => {
  const { base, root, paths: [scheduled, disabled, ran, plain] } = await landedWorktrees("scheduled", "disabled", "ran", "plain");
  const statePath = t3State(join(base, "statev2.sqlite"), [scheduled, disabled, ran, plain].map((worktreePath) => ({ worktreePath, settledAt })), [
    { threadId: scheduled, enabled: true, nextRunAt: "2026-11-16T08:15:00.000Z" },
    { threadId: disabled, enabled: false, nextRunAt: "2026-11-16T08:15:00.000Z" },
    { threadId: ran, enabled: true, nextRunAt: null },
  ]);

  const verdicts = pass(base, root, statePath);

  expect(verdicts.find((verdict) => verdict.path === scheduled)).toMatchObject({ remove: false, reason: "its T3 thread has a scheduled run at 2026-11-16T08:15:00.000Z" });
  expect(await readdir(join(root, "repo"))).toEqual(["scheduled"]);
});

onLinux("a prune pass keeps the landed worktree of a settled thread while it watches a pull request, and removes it once every watch ended", async () => {
  const { base, root, paths: [watched, unwatched] } = await landedWorktrees("watched", "unwatched");
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { worktreePath: watched, settledAt, pullRequests: [ended(1), watching(2)] }, { worktreePath: unwatched, settledAt, pullRequests: [ended(3)] },
  ]);

  const verdicts = pass(base, root, statePath);

  expect(verdicts.find((verdict) => verdict.path === watched)).toMatchObject({ remove: false, reason: "its T3 thread watches acme/app#2" });
  expect(await readdir(join(root, "repo"))).toEqual(["watched"]);
});

onLinux("under disk pressure, a prune pass evicts the worktree of a thread that a wake needs only after every other one", async () => {
  const { base, root, paths: [woken, open] } = await landedWorktrees("woken", "open");
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [open], later - 2 * 3600_000);
  const lines: string[] = [];

  pass(base, root, t3State(join(base, "statev2.sqlite"), [{ worktreePath: woken, settledAt, pullRequests: [watching(1)] }, { worktreePath: open }]), pressured(later, lines));

  expect(evicted(lines)).toEqual([open, woken]);
});

onLinux("a prune pass keeps the landed worktree of a subagent thread while a scheduled task bound to it has a next run", async () => {
  const { base, root, paths: [woken, finished] } = await landedWorktrees("woken", "finished");
  const lineage = { parentThreadId: "lead", relationshipToParent: "subagent" };
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "woken", worktreePath: woken, settledAt, lineage }, { id: "finished", worktreePath: finished, settledAt, lineage },
  ], scheduledFor("woken"));

  const verdicts = pass(base, root, statePath);

  expect(verdicts.find((verdict) => verdict.path === woken)).toMatchObject({ remove: false, reason: "its T3 thread has a scheduled run at 2026-11-16T08:15:00.000Z" });
  expect(await readdir(join(root, "repo"))).toEqual(["woken"]);
});

onLinux("a prune pass keeps a subagent worktree while its open parent watches a PR it links, even without a parent worktree, and removes it once the watch ends", async () => {
  const { base, root, paths: [watched, dismissed, endedParent, closedParent] } = await landedWorktrees("watched", "dismissed", "ended-parent", "closed-parent");
  const linked = (number: number, source?: string) => ({ host: "github.com", repository: "acme/app", number, ...(source ? { source } : {}) });
  const sub = (parentThreadId: string) => ({ parentThreadId, relationshipToParent: "subagent" });
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "conductor", worktreePath: null, pullRequests: [watching(42), watching(43)] },
    { id: "ended-conductor", worktreePath: null, pullRequests: [ended(44)] },
    { id: "archived-conductor", worktreePath: null, archivedAt: settledAt, pullRequests: [watching(45)] },
    { id: "watched", worktreePath: watched, lineage: sub("conductor"), pullRequests: [linked(42)] },
    { id: "dismissed", worktreePath: dismissed, lineage: sub("conductor"), pullRequests: [linked(43, "stack-dismissed")] },
    { id: "ended-parent", worktreePath: endedParent, lineage: sub("ended-conductor"), pullRequests: [linked(44)] },
    { id: "closed-parent", worktreePath: closedParent, lineage: sub("archived-conductor"), pullRequests: [linked(45)] },
  ]);

  const verdicts = pass(base, root, statePath);

  expect(verdicts.find((verdict) => verdict.path === watched)).toMatchObject({ remove: false, reason: "its T3 thread watches acme/app#42 via its parent" });
  expect(await readdir(join(root, "repo"))).toEqual(["watched"]);
});

onLinux("under disk pressure, a subagent worktree whose PR its parent watches is evicted after plain open worktrees", async () => {
  const { base, root, paths: [subWatched, open] } = await landedWorktrees("sub-watched", "open");
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [open], later - 2 * 3600_000);
  const lines: string[] = [];
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "conductor", worktreePath: null, pullRequests: [watching(9)] },
    { id: "sub-watched", worktreePath: subWatched, lineage: { parentThreadId: "conductor", relationshipToParent: "subagent" }, pullRequests: [{ host: "github.com", repository: "acme/app", number: 9 }] },
    { id: "open", worktreePath: open },
  ]);

  pass(base, root, statePath, pressured(later, lines));

  expect(evicted(lines)).toEqual([open, subWatched]);
});

onLinux("a prune pass reads the T3 state again for each worktree, so a run scheduled during the pass keeps its worktree", async () => {
  const { base, root, paths: [early, late] } = await landedWorktrees("early", "late");
  await writeFile(join(early, "app.ts"), "b\n");
  await commit(early, "work");
  const statePath = t3State(join(base, "statev2.sqlite"), [{ id: "early", worktreePath: early }, { id: "late", worktreePath: late, settledAt }]);

  const log = (line: string) => { if (line.startsWith(`kept: ${early} `)) schedule(statePath, scheduledFor("late")[0]); };

  const verdicts = pass(base, root, statePath, { log });

  expect(verdicts.find((verdict) => verdict.path === late)).toMatchObject({ remove: false, reason: "its T3 thread has a scheduled run at 2026-11-16T08:15:00.000Z" });
});

onLinux("a prune pass reads the T3 state after a worktree's own checks, so a run scheduled while they run keeps it", async () => {
  const { base, root, paths: [settled] } = await landedWorktrees("settled");
  await writeFile(join(settled, "app.ts"), "b\n");
  await commit(settled, "work");
  const statePath = t3State(join(base, "statev2.sqlite"), [{ id: "settled", worktreePath: settled, settledAt }]);

  const verdicts = pass(base, root, statePath, { mergedPullRequest: () => (schedule(statePath, scheduledFor("settled")[0]), false) });

  expect(verdicts.find((verdict) => verdict.path === settled)).toMatchObject({ remove: false, reason: "its T3 thread has a scheduled run at 2026-11-16T08:15:00.000Z" });
  expect(await readdir(join(root, "repo"))).toEqual(["settled"]);
});

onLinux("under disk pressure, a worktree whose watch ends during the pass is evicted before one that still has a wake", async () => {
  const { base, root, paths: [older, newer] } = await landedWorktrees("older", "newer");
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [newer], later - 2 * 3600_000);
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "older", worktreePath: older, settledAt, pullRequests: [watching(1)] }, { id: "newer", worktreePath: newer, settledAt, pullRequests: [watching(2)] },
  ]);
  const lines: string[] = [];
  let calls = 0;
  const free = () => (calls++ === 0 ? (endWatches(statePath, "newer"), 0) : Number.POSITIVE_INFINITY);

  pass(base, root, statePath, { ...pressured(later, lines), dryRun: false, evict: { targetGigabytes: 1, free } });

  expect(lines.filter((line) => line.startsWith("evicted")).map((line) => line.split(": ")[1].split(" (")[0])).toEqual([newer]);
  expect(await readdir(join(root, "repo"))).toEqual(["older"]);
});

onLinux("under disk pressure, a worktree whose thread gets a wake during the pass is evicted after every other one", async () => {
  const { base, root, paths: [older, newer] } = await landedWorktrees("older", "newer");
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [newer], later - 2 * 3600_000);
  const statePath = t3State(join(base, "statev2.sqlite"), [{ id: "older", worktreePath: older }, { id: "newer", worktreePath: newer }]);
  const lines: string[] = [];
  let scheduled = false;
  const free = () => (scheduled ||= (schedule(statePath, scheduledFor("older")[0]), true), 0);

  pass(base, root, statePath, { ...pressured(later, lines), dryRun: false, evict: { targetGigabytes: 1, free } });

  expect(lines.filter((line) => line.startsWith("evicted")).map((line) => line.split(": ")[1].split(" (")[0])).toEqual([newer, older]);
});

onLinux("a prune pass reads the T3 state again right before it removes a worktree, so a run scheduled while it prepares the removal keeps it", async () => {
  const { base, root, paths: [settled] } = await landedWorktrees("settled");
  const statePath = t3State(join(base, "statev2.sqlite"), [{ id: "settled", worktreePath: settled, settledAt }]);

  const verdicts = pass(base, root, statePath, { makeWritable: () => schedule(statePath, scheduledFor("settled")[0]) });

  expect(verdicts.find((verdict) => verdict.path === settled)).toMatchObject({ remove: false, reason: "its T3 thread has a scheduled run at 2026-11-16T08:15:00.000Z" });
  expect(await readdir(join(root, "repo"))).toEqual(["settled"]);
});

onLinux("under disk pressure, a worktree whose thread gets a wake during its own checks is kept while one without a wake can go instead", async () => {
  const { base, root, paths: [older, newer] } = await landedWorktrees("older", "newer");
  for (const path of [older, newer]) {
    await writeFile(join(path, "app.ts"), `${basename(path)}\n`);
    await commit(path, "work");
  }
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [newer], later - 2 * 3600_000);
  const statePath = t3State(join(base, "statev2.sqlite"), [{ id: "older", worktreePath: older }, { id: "newer", worktreePath: newer }]);
  const lines: string[] = [];
  const checked: string[] = [];
  const mergedPullRequest = (branch: string) => {
    checked.push(branch);
    if (branch === "older" && checked.filter((name) => name === "older").length === 2) schedule(statePath, scheduledFor("older")[0]);
    return false;
  };
  const free = () => (lines.some((line) => line.startsWith("evicted")) ? Number.POSITIVE_INFINITY : 0);

  pass(base, root, statePath, { ...pressured(later, lines), dryRun: false, mergedPullRequest, evict: { targetGigabytes: 1, free } });

  expect(lines.filter((line) => line.startsWith("evicted")).map((line) => line.split(": ")[1].split(" (")[0])).toEqual([newer]);
  expect(await readdir(join(root, "repo"))).toEqual(["older"]);
});

onLinux("a worktree that several threads share counts the latest activity of any of them", async () => {
  const { base, root, paths: [recent] } = await landedWorktrees("recent");
  const later = Date.now() + 48 * 3600_000;
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "scheduled", worktreePath: recent, settledAt }, { id: "lately", worktreePath: recent, settledAt, createdAt: new Date(later - 30 * 60_000).toISOString() },
  ], scheduledFor("scheduled"));
  const lines: string[] = [];

  const verdicts = pass(base, root, statePath, pressured(later, lines));

  expect(verdicts.find((verdict) => verdict.path === recent)?.reason).toBe("active 0.5h ago");
  expect(evicted(lines)).toEqual([]);
});

onLinux("a worktree that several threads share counts a running session or a pending answer of any of them", async () => {
  const { base, root, paths: [busy, asking] } = await landedWorktrees("busy", "asking");
  const later = Date.now() + 48 * 3600_000;
  const newer = new Date(later - 5 * 3600_000).toISOString();
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "running", worktreePath: busy, running: true }, { id: "busy-scheduled", worktreePath: busy, settledAt, createdAt: newer },
    { id: "asking", worktreePath: asking, asking: true }, { id: "asking-scheduled", worktreePath: asking, settledAt, createdAt: newer },
  ], scheduledFor("busy-scheduled", "asking-scheduled"));
  const lines: string[] = [];

  const verdicts = pass(base, root, statePath, pressured(later, lines));

  expect(verdicts.map(({ path, reason }) => ({ path, reason }))).toEqual([
    { path: asking, reason: "T3 thread waits for an answer" }, { path: busy, reason: "T3 session is running" },
  ]);
  expect(evicted(lines)).toEqual([]);
});

onLinux("a worktree that several threads share counts the wake of any open one", async () => {
  const { base, root, paths: [shared, plain] } = await landedWorktrees("shared", "plain");
  const later = Date.now() + 48 * 3600_000;
  recordSightings(join(base, "sightings.json"), [plain], later - 2 * 3600_000);
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "watcher", worktreePath: shared, settledAt, pullRequests: [watching(1)] }, { id: "newer", worktreePath: shared, createdAt: new Date(later - 3 * 3600_000).toISOString() },
    { worktreePath: plain },
  ]);
  const lines: string[] = [];

  pass(base, root, statePath, pressured(later, lines));

  expect(evicted(lines)).toEqual([plain, shared]);
});

onLinux("the wake of an archived or deleted thread does not keep a worktree it shares with a settled thread", async () => {
  const { base, root, paths: [archived, deleted] } = await landedWorktrees("archived", "deleted");
  for (const path of [archived, deleted]) await writeFile(join(path, "pnpm-lock.yaml"), "b\n");
  const newer = "2026-09-22T00:00:00Z";
  const statePath = t3State(join(base, "statev2.sqlite"), [
    { id: "archived", worktreePath: archived, archivedAt: settledAt }, { id: "archived-peer", worktreePath: archived, settledAt, createdAt: newer },
    { id: "deleted", worktreePath: deleted, deletedAt: settledAt }, { id: "deleted-peer", worktreePath: deleted, settledAt, createdAt: newer },
  ], scheduledFor("archived", "deleted"));

  pass(base, root, statePath);

  expect(await readdir(join(root, "repo"))).toEqual([]);
});

test("removes an idle agent worktree with unmerged commits on a branch, and keeps unreadable T3 state", () => {
  const agent = { ...idle, path: "/r/.claude/worktrees/agent-a1", agent: true, landed: false };
  expect(decide(agent, limits)).toMatchObject({ remove: true, reason: "agent worktree idle 48.0h; commits stay on feature" });
  expect(decide({ ...agent, lastActivity: now - 12 * 3600_000 }, limits).reason).toBe("unmerged work");
  expect(decide({ ...agent, dirty: true }, limits).reason).toBe("uncommitted changes");
  expect(decide({ ...idle, stateUnknown: true }, limits).reason).toBe("T3 state is unreadable");
});

test("under disk pressure, evicts a clean worktree whose commits a ref keeps, even with an open thread or unreadable state", () => {
  const open = { status: "completed", archived: false, deleted: false, settled: false, wake: null, pending: false, activeAt: 0, openLead: true };
  const pressure = { ...limits, minIdleHours: 1 };
  const unmerged = { ...idle, landed: false, thread: open };
  expect(evictable(unmerged, pressure)).toBe(true);
  expect(evictable({ ...unmerged, thread: null, stateUnknown: true }, pressure)).toBe(true);
  const kept: Array<Partial<Facts>> = [
    { kind: "main" }, { kind: "orphan" }, { inUse: true }, { dirty: true }, { branch: null, unreferenced: 2 },
    { thread: { ...open, status: "running" } }, { thread: { ...open, pending: true } }, { lastActivity: now - 30 * 60_000 },
  ];
  for (const change of kept) expect(evictable({ ...unmerged, ...change }, pressure)).toBe(false);
});

test("under disk pressure, keeps a worktree that no thread or agent owns for the longer unowned window", () => {
  const pressure = { ...limits, minIdleHours: 1, unownedIdleHours: 6 };
  const detached = { ...idle, path: "/tmp/eval/new", branch: null, landed: false, lastActivity: now - 3 * 3600_000 };
  expect(evictable(detached, pressure)).toBe(false);
  expect(decide({ ...detached, landed: true }, pressure).reason).toBe("no T3 thread or agent owns it; active 3.0h ago");
  expect(evictable({ ...detached, lastActivity: now - 7 * 3600_000 }, pressure)).toBe(true);
  const open = { status: "completed", archived: false, deleted: false, settled: false, wake: null, pending: false, activeAt: 0, openLead: true };
  expect(evictable({ ...detached, thread: open }, pressure)).toBe(true);
});

onLinux("under disk pressure, a prune pass evicts an idle worktree and keeps one where a process ran since the last pass", async () => {
  const { base, repo, root } = await repository();
  const used = join(root, "repo/used");
  const unused = join(root, "repo/unused");
  for (const path of [used, unused]) {
    await sh(repo, "git", "worktree", "add", "-q", "-b", basename(path), path);
    await writeFile(join(path, "app.ts"), "b\n");
    await commit(path, "work");
  }
  const later = Date.now() + 3 * 3600_000;
  const sightingsPath = join(base, "sightings.json");
  recordSightings(sightingsPath, [join(used, "frontend")], later - 30 * 60_000);

  const verdicts = prune({
    worktreeRoot: root, statePath: t3State(join(base, "statev2.sqlite"), [{ worktreePath: used }, { worktreePath: unused }]), now: later, repos: [],
    minIdleHours: 1, unownedIdleHours: 6, agentIdleHours: 6, dryRun: false, fetch: false, log: () => {}, sightingsPath,
    evict: { targetGigabytes: 1, free: () => 0 }, mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === used)).toMatchObject({ remove: false, reason: "active 0.5h ago" });
  expect(verdicts.find((verdict) => verdict.path === unused)?.remove).toBe(true);
  expect(await readdir(join(root, "repo"))).toEqual(["used"]);
});

onLinux("removes a worktree whose branch has a merged pull request, asking the lookup it was given", async () => {
  const { base, repo, root } = await repository();
  const merged = join(root, "repo/merged");
  await sh(repo, "git", "worktree", "add", "-q", "-b", "merged", merged);
  await writeFile(join(merged, "app.ts"), "squashed\n");
  await commit(merged, "work");
  const asked: string[] = [];

  const verdicts = prune({
    worktreeRoot: root, statePath: join(base, "missing.sqlite"), now: Date.now() + 72 * 3600_000, repos: [],
    minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24, dryRun: true, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"),
    mergedPullRequest: (branch) => (asked.push(branch), branch === "merged"),
  });

  expect(asked).toEqual(["merged"]);
  expect(verdicts.find((verdict) => verdict.path === merged)).toMatchObject({ remove: true, reason: "pull request for merged is merged" });
});

onLinux("keeps a worktree whose Git metadata is gone, with its uncommitted work", async () => {
  const { base, repo, root } = await repository();
  const broken = join(root, "repo/broken");
  await sh(repo, "git", "worktree", "add", "-q", "-b", "broken", broken);
  await writeFile(join(broken, "notes.md"), "not committed\n");
  await rm(join(repo, ".git/worktrees/broken"), { recursive: true, force: true });

  const verdicts = prune({
    worktreeRoot: root, statePath: join(base, "missing.sqlite"), now: Date.now() + 72 * 3600_000, repos: [],
    minIdleHours: 6, unownedIdleHours: 24, agentIdleHours: 24, dryRun: false, fetch: false, log: () => {}, sightingsPath: join(base, "sightings.json"), mergedPullRequest: noMergedPullRequests,
  });

  expect(verdicts.find((verdict) => verdict.path === broken)).toMatchObject({ remove: false, reason: "Git cannot read its worktree metadata" });
  expect(await readdir(broken)).toContain("notes.md");
});

test("records where processes run and forgets sightings older than two days", async () => {
  const base = await mkdtemp(join(tmpdir(), "hedge-sightings-"));
  temporary.push(base);
  const path = join(base, "state/sightings.json");
  recordSightings(path, ["/old"], now - 49 * 3600_000);
  recordSightings(path, ["/recent"], now - 3600_000);
  recordSightings(path, ["/now"], now);
  expect(readSightings(path)).toEqual({ "/recent": now - 3600_000, "/now": now });
});

test("reads the live orchestration v2 state of a nightly T3 and ignores its frozen legacy tables", async () => {
  const userdata = await mkdtemp(join(tmpdir(), "hedge-state-v2-"));
  temporary.push(userdata);
  await writeFile(join(userdata, "state.sqlite"), "");
  const state = join(userdata, "statev2.sqlite");
  const db = new Database(state);
  db.run(`create table projection_threads (thread_id text, worktree_path text, archived_at text, deleted_at text, created_at text,
    latest_user_message_at text, pending_approval_count integer, pending_user_input_count integer, settled_override text, settled_at text)`);
  db.run("create table projection_thread_sessions (thread_id text, status text)");
  db.run("create table projection_turns (thread_id text, requested_at text, started_at text, completed_at text)");
  db.run("insert into projection_threads values ('done', '/w/done', null, null, '2026-09-20T00:00:00Z', null, 0, 0, null, null)");
  db.run("insert into projection_thread_sessions values ('done', 'running')");
  db.run("create table orchestration_v2_projection_threads (thread_id text, created_at text, archived_at text, deleted_at text, payload_json text)");
  db.run("create table orchestration_v2_projection_runs (run_id text, thread_id text, ordinal integer, status text, requested_at text, completed_at text)");
  db.run("create table orchestration_v2_projection_messages (message_id text, thread_id text, role text, created_at text)");
  db.run("create table orchestration_v2_projection_runtime_requests (runtime_request_id text, thread_id text, created_at text, resolved_at text)");
  const thread = (id: string, payload: object, archived: string | null = null) =>
    db.run("insert into orchestration_v2_projection_threads values (?, '2026-09-20T00:00:00Z', ?, null, ?)", [id, archived, JSON.stringify({ worktreePath: `/w/${id}`, ...payload })]);
  thread("done", { settledOverride: null, settledAt: "2026-09-24T00:00:00Z" });
  thread("busy", {});
  thread("asking", {});
  thread("archived", {}, "2026-09-23T00:00:00Z");
  thread("review", { lineage: { parentThreadId: "busy", relationshipToParent: "subagent" } });
  db.run("insert into orchestration_v2_projection_threads values ('lead', '2026-09-20T00:00:00Z', null, null, ?)", [JSON.stringify({ worktreePath: "/w/review", lineage: { parentThreadId: null } })]);
  thread("solo-child", { lineage: { parentThreadId: "busy", relationshipToParent: "subagent" } });
  thread("fork", { lineage: { parentThreadId: "busy", relationshipToParent: "fork" } });
  db.run("insert into orchestration_v2_projection_runs values ('d1', 'done', 1, 'completed', '2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z')");
  db.run("insert into orchestration_v2_projection_runs values ('b1', 'busy', 1, 'completed', '2026-09-21T00:00:00Z', '2026-09-21T01:00:00Z')");
  db.run("insert into orchestration_v2_projection_runs values ('b2', 'busy', 2, 'running', '2026-09-25T10:00:00Z', null)");
  thread("waiting", {});
  db.run("insert into orchestration_v2_projection_runs values ('w1', 'waiting', 1, 'running', '2026-09-21T00:00:00Z', null)");
  db.run("insert into orchestration_v2_projection_runs values ('w2', 'waiting', 2, 'queued', '2026-09-21T00:05:00Z', null)");
  db.run("insert into orchestration_v2_projection_messages values ('m1', 'asking', 'user', '2026-09-23T00:00:00Z')");
  db.run("insert into orchestration_v2_projection_runtime_requests values ('r1', 'asking', '2026-09-23T00:01:00Z', null)");
  db.close();

  const threads = readState(t3StatePath(userdata)).threads;
  expect(threads.get("/w/done")).toMatchObject({ status: "completed", settled: true, pending: false, activeAt: Date.parse("2026-09-22T00:00:00Z") });
  expect(threads.get("/w/busy")).toMatchObject({ status: "running", settled: false, activeAt: Date.parse("2026-09-25T10:00:00Z") });
  expect(threads.get("/w/asking")).toMatchObject({ pending: true, activeAt: Date.parse("2026-09-23T00:00:00Z") });
  expect(threads.get("/w/archived")).toMatchObject({ archived: true });
  expect(threads.get("/w/busy")).toMatchObject({ openLead: true });
  expect(threads.get("/w/solo-child")).toMatchObject({ openLead: false });
  expect(threads.get("/w/fork")).toMatchObject({ openLead: true });
  expect(threads.get("/w/review")).toMatchObject({ openLead: true });
  expect(threads.get("/w/archived")).toMatchObject({ openLead: false });
  expect(decide({ ...idle, path: "/w/busy", thread: threads.get("/w/busy")! }, limits).reason).toBe("T3 session is running");
  expect(threads.get("/w/waiting")).toMatchObject({ status: "running" });
  const queued = { ...threads.get("/w/busy")!, status: "queued" };
  expect(decide({ ...idle, path: "/w/busy", thread: queued }, limits).reason).toBe("T3 session is queued");
});

test("removes old T3 versions and keeps the active, updating, linked, and recent ones", async () => {
  const t3Home = await mkdtemp(join(tmpdir(), "hedge-t3-versions-"));
  temporary.push(t3Home);
  const versions = join(t3Home, "runtime/versions");
  const old = (now - 3 * 86_400_000) / 1000;
  for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"]) {
    await mkdir(join(versions, version), { recursive: true });
    await writeFile(join(versions, version, "t3"), "");
    if (version !== "1.0.6") await utimes(join(versions, version), old, old);
  }
  const update = { fromVersion: "1.0.3", targetVersion: "1.0.4", status: "pending" };
  await writeFile(join(t3Home, "runtime/service-state.json"), JSON.stringify({ protocol: 3, activeVersion: "1.0.3", update }));
  const cli = join(t3Home, "t3");
  await symlink(join(versions, "1.0.1/t3"), cli);

  reclaimT3Versions(t3Home, cli, now, () => {});

  expect((await readdir(versions)).sort()).toEqual(["1.0.1", "1.0.3", "1.0.4", "1.0.6"]);
});

test("keeps every T3 version when the service state is unreadable", async () => {
  const t3Home = await mkdtemp(join(tmpdir(), "hedge-t3-versions-"));
  temporary.push(t3Home);
  const versions = join(t3Home, "runtime/versions");
  const old = (now - 3 * 86_400_000) / 1000;
  for (const version of ["1.0.0", "1.0.1"]) {
    await mkdir(join(versions, version), { recursive: true });
    await utimes(join(versions, version), old, old);
  }
  await writeFile(join(t3Home, "runtime/service-state.json"), "{");

  reclaimT3Versions(t3Home, join(t3Home, "t3"), now, () => {});

  expect((await readdir(versions)).sort()).toEqual(["1.0.0", "1.0.1"]);
});

const gigabytes = 1024 ** 3;
const home = "/home/test";
const uvCache = `${home}/.cache/uv`;
const cargoTarget = `${home}/.cargo/target`;
const cacheAuto: AutoOptions = {
  lowFreeGigabytes: 25, criticalFreeGigabytes: 10, targetFreeGigabytes: 40, intervalMinutes: 60, lowIntervalMinutes: 10,
  cargoTargetGigabytes: 20, uvCacheGigabytes: 5, stampPath: "/unused/stamp",
};

/** Fake host: sizes come from `caches` (bytes), and `busy` lists the process patterns that pgrep finds. */
function fakeHost(caches: Record<string, number>, busy: string[] = [], platform = "linux") {
  const ran: string[] = [];
  const host: CacheHost = {
    platform,
    has: () => true,
    run: (command) => {
      ran.push(command.join(" "));
      const last = command.at(-1)!;
      if (command[0] === "du") return { ok: true, out: `${caches[last] / 1024}\t${last}` };
      if (command[0] === "pgrep") return { ok: true, out: busy.includes(last) ? "42" : "" };
      return { ok: true, out: "" };
    },
    isDirectory: (path) => path in caches,
    free: () => "20.0G free",
  };
  return { host, ran };
}

test("under disk pressure, prunes the pnpm store and clears a uv cache past its cap", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes, [cargoTarget]: gigabytes });
  reclaimCaches(home, "low", cacheAuto, () => {}, host);
  expect(ran).toContain("pnpm store prune");
  expect(ran).toContain(`rm -rf --one-file-system ${uvCache}`);
  expect(ran).not.toContain(`rm -rf --one-file-system ${cargoTarget}`);
});

test("when the disk is critical, clears the uv cache and the Rust build output whatever their size", () => {
  const { host, ran } = fakeHost({ [uvCache]: gigabytes, [cargoTarget]: gigabytes });
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).toContain(`rm -rf --one-file-system ${uvCache}`);
  expect(ran).toContain(`rm -rf --one-file-system ${cargoTarget}`);
});

test("when the disk is only low, keeps a uv cache under its cap", () => {
  const { host, ran } = fakeHost({ [uvCache]: 2 * gigabytes });
  reclaimCaches(home, "low", cacheAuto, () => {}, host);
  expect(ran).toContain("pnpm store prune");
  expect(ran).not.toContain(`rm -rf --one-file-system ${uvCache}`);
});

test("on a normal disk, leaves the pnpm store and the uv cache alone", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes });
  reclaimCaches(home, "normal", cacheAuto, () => {}, host);
  expect(ran).not.toContain("pnpm store prune");
  expect(ran.some((command) => command.includes(uvCache))).toBe(false);
});

test("keeps the uv cache while a uv process runs", () => {
  const { host, ran } = fakeHost({ [uvCache]: 6 * gigabytes }, ["uv"]);
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).not.toContain(`rm -rf --one-file-system ${uvCache}`);
});

test("takes the disk floor from settings and keeps the low and target marks above it", () => {
  const { options, auto } = pruneOptions(["--auto"], () => {}, { home: "/home/test", env: {}, floorGigabytes: 12 });
  expect(auto).toMatchObject({ criticalFreeGigabytes: 12, lowFreeGigabytes: 27, targetFreeGigabytes: 42, stampPath: "/home/test/.local/state/hedge/worktree-prune.last" });
  expect(options).toMatchObject({ worktreeRoot: "/home/test/.t3/worktrees", sightingsPath: "/home/test/.local/state/hedge/worktree-sightings.json" });
  expect(pruneOptions([], () => {}, { home: "/home/test", env: { XDG_STATE_HOME: "/state" }, floorGigabytes: 10 }).options.sightingsPath).toBe("/state/hedge/worktree-sightings.json");
});

test("on a Mac, reads the working directories of processes from lsof", () => {
  expect(cwdsFromLsof("p1\nfcwd\nn/Users/me/.t3/worktrees/app/a\np2\nfcwd\nn/\n")).toEqual(["/Users/me/.t3/worktrees/app/a", "/"]);
});

test("on a Mac, stops when lsof lists no process, since prune itself always runs", () => {
  expect(() => cwdsFromLsof("")).toThrow("lsof listed no running processes");
});

test("on a Mac, clears a cache with the rm flag macOS knows", () => {
  const { host, ran } = fakeHost({ [uvCache]: gigabytes }, [], "darwin");
  reclaimCaches(home, "critical", cacheAuto, () => {}, host);
  expect(ran).toContain(`rm -rfx ${uvCache}`);
});

test("removes a tree without leaving its filesystem, with the flag each platform's rm knows", () => {
  expect(removeTreeCommand("/w/a", "linux")).toEqual(["rm", "-rf", "--one-file-system", "/w/a"]);
  expect(removeTreeCommand("/w/a", "darwin")).toEqual(["rm", "-rfx", "/w/a"]);
});

test("a pass on a machine where T3 made no worktrees yet keeps nothing and fails nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "hedge-fresh-"));
  temporary.push(home);
  const lines: string[] = [];
  const { options } = pruneOptions(["--no-fetch"], (line) => lines.push(line), { home, env: {}, floorGigabytes: 10 });
  expect(prune(options)).toEqual([]);
  expect(lines.at(-1)).toMatch(/^Done: 0 removed, 0 kept\. [\d.]+G free$/);
});

onLinux("prune keeps a landed worktree whose repository is a Fleet checkout from before the rename, and its other worktrees still go", async () => {
  const { base, repo, root } = await repository();
  const old = join(base, ".local/share/fleet/engine");
  await mkdir(dirname(old), { recursive: true });
  await rename(repo, old);
  const backed = join(root, "engine", "backed");
  await sh(old, "git", "worktree", "add", "-q", "-b", "backed", backed);
  const elsewhere = await landedWorktrees("plain");
  const statePath = t3State(join(base, "statev2.sqlite"), [backed, ...elsewhere.paths].map((worktreePath) => ({ worktreePath, settledAt })));

  const verdicts = [...pass(base, root, statePath, { home: base }), ...pass(elsewhere.base, elsewhere.root, statePath, { home: base })];

  expect(verdicts.find((verdict) => verdict.path === backed)).toMatchObject({ remove: false, reason: "its Git repository is in a Fleet path from before the rename" });
  expect(await readdir(join(root, "engine"))).toEqual(["backed"]);
  expect(await readdir(join(elsewhere.root, "repo"))).toEqual([]);
});

onLinux("prune keeps every worktree in a Fleet path from before the rename, also through a linked root, and inspects none of them", async () => {
  const { base, repo } = await repository();
  const inFleet = join(base, ".local/share/fleet/worktrees");
  const inside = join(inFleet, "repo", "inside");
  const linkedReal = join(base, ".local/share/fleet/linked");
  const linked = join(base, "linked", "repo", "through");
  await sh(repo, "git", "worktree", "add", "-q", "-b", "inside", inside);
  await sh(repo, "git", "worktree", "add", "-q", "-b", "through", join(linkedReal, "repo", "through"));
  await symlink(linkedReal, join(base, "linked"));
  const statePath = t3State(join(base, "statev2.sqlite"), [inside, linked].map((worktreePath) => ({ worktreePath, settledAt })));

  const verdicts = [...pass(base, inFleet, statePath, { home: base }), ...pass(base, join(base, "linked"), statePath, { home: base })];

  expect(verdicts.sort((a, b) => a.path.localeCompare(b.path))).toEqual([join(linkedReal, "repo", "through"), inside].map((path) => ({ path, remove: false, reason: "it is in a Fleet path from before the rename" })));
  expect([await readdir(join(inFleet, "repo")), await readdir(join(linkedReal, "repo"))]).toEqual([["inside"], ["through"]]);
});
