import type { PullRequestWatch, ShellThread } from "../../base/lib/t3/index.ts";
import { subagentParent } from "../../pull-requests/lib/pr-owners.ts";

export type StopHookEvent = {
  cwd?: string; stop_hook_active?: boolean; last_assistant_message?: string;
  background_tasks?: { id?: string; type?: string; status?: string }[]; session_crons?: unknown[];
};
export type ProcessTable = { pid: number; table: (signal?: AbortSignal) => Promise<string> };

export const stopCheckDeadlineMs = 10_000;

type ShellTask = NonNullable<ShellThread["pendingBackgroundTasks"]>[number];

export const realProcesses: ProcessTable = {
  pid: process.pid,
  table: async (signal) => {
    const child = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,comm="], { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal });
    const [table, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`ps exited ${code}`);
    return table;
  },
};

const isProvider = (command: string) => ["claude", "codex"].includes(command.split("/").at(-1) ?? "");

export function nestedSession(table: string, pid: number): boolean {
  const parents = new Map(table.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [[Number(match[1]), { ppid: Number(match[2]), command: match[3]! }] as const] : [];
  }));
  let providers = 0;
  for (let current = parents.get(pid), steps = 0; current && steps < 64; current = parents.get(current.ppid), steps++) {
    if (isProvider(current.command) && ++providers > 1) return true;
  }
  return false;
}

const checksRun = (watch: PullRequestWatch) => watch.checksPending ?? (!watch.passed && !watch.failedChecks?.length);

export const claudeTaskRuns = (event: StopHookEvent) =>
  Boolean(event.background_tasks?.some((task) => ["running", "pending"].includes(task.status ?? "") && task.type !== "shell"));

const runningStatuses = ["preparing", "queued", "starting", "running", "waiting"];
const holdsCompletion = (task: ShellTask) => task.awaited === true || !["command", "monitor"].includes(task.kind);
const awaitsWork = (thread: ShellThread) => Boolean(thread.blockedOnThreadWait) || (thread.pendingBackgroundTasks ?? []).some(holdsCompletion);
const maxChildDepth = 8;

function waitsOnSubagent(threads: ShellThread[], parent: ShellThread, depth = 0): boolean {
  return depth < maxChildDepth && threads.some((child) => subagentParent(child) === parent.id && !child.settledAt && !child.archivedAt && !child.deletedAt
    && (Boolean(child.activeRunId || child.pendingRuntimeRequest || runningStatuses.includes(child.activityRunStatus ?? child.status))
      || awaitsWork(child) || waitsOnSubagent(threads, child, depth + 1)));
}

export const isSnoozed = (thread: ShellThread, now = Date.now()) => Boolean(thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now);

export const awaitsChecks = ({ snapshot, watch }: NonNullable<ShellThread["pullRequests"]>[number]) =>
  Boolean(watch) && !["merged", "closed"].includes(snapshot?.state?.toLowerCase() ?? "open") && (checksRun(watch!) || Boolean(watch!.awaitingApproval?.length));

export const waits = (threads: ShellThread[], thread: ShellThread) => awaitsWork(thread) || waitsOnSubagent(threads, thread);

export async function withinDeadline<T>(run: (signal: AbortSignal) => Promise<T | undefined>, deadline?: () => Promise<void>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = new AbortController();
  const end = deadline?.() ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, stopCheckDeadlineMs); });
  try {
    return await Promise.race([run(cancel.signal).catch(() => undefined), end.then(() => undefined)]);
  } finally {
    clearTimeout(timer);
    cancel.abort();
  }
}
