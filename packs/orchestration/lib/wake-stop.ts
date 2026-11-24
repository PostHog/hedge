import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { matchThread, type ShellThread, t3StatePath, t3UserData } from "../../base/lib/t3/index.ts";
import { subagentParent } from "../../pull-requests/lib/pr-owners.ts";
import { isSnoozed, nestedSession, realProcesses, waits, withinDeadline, type ProcessTable, type ProofStopEvent } from "./proof-stop.ts";
import { personName } from "./prose-question.ts";

export type WakeStopOptions = { home: string; threadId: string | undefined; shell: () => Promise<{ threads: ShellThread[] }>; processes?: ProcessTable; now?: () => number; deadline?: () => Promise<void> };

const waitMarks = ["⏳", "🔕"];

const closingLine = (message: string) => message.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";

const closesOnWait = (message: string) => waitMarks.some((mark) => closingLine(message).replaceAll("\uFE0F", "").startsWith(mark));

export const noWakeReason = (person: string) => `Hedge blocked this stop: your closing line says this thread waits, but nothing will wake this thread. `
  + "It holds no PR watch until merge, no running child task, no thread wait, and no scheduled check bound to it, so T3 puts it in "
  + `${person}'s inbox, and Hedge never snoozes or settles it for you. Give the wait something that wakes it, then end the turn again: `
  + 'for a PR you wait on, such as CI, a reviewer or the merge queue, call watch_pull_request with until: "merged"; '
  + "for a lane, keep its delegate_task child or call t3_thread_wait; for a check at a time, call schedule_task bound to this thread. "
  + `If nothing can wake it, such as a reply by email, say so and end on the line for ${person}'s move instead. Do not snooze the thread to hide it.`;

const writtenByT3 = (time: string) => Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;

const claudeWakesOnEnd = (event: ProofStopEvent) => Boolean(event.background_tasks?.some((task) => ["running", "pending"].includes(task.status ?? "")));

function hasScheduledCheck(home: string, threadId: string): boolean {
  const path = t3StatePath(t3UserData(home));
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ next: string }, [string]>("select next_run_at next from scheduled_tasks where thread_id = ? and enabled = 1 and next_run_at is not null")
      .all(threadId).some(({ next }) => writtenByT3(next));
  } finally {
    db.close();
  }
}

const outsideWakeCheck = (thread: ShellThread, now: number) => Boolean(subagentParent(thread) || thread.lineage?.sideChat || thread.delegatedFrom || thread.pendingRuntimeRequest || isSnoozed(thread, now));

type ShellPullRequest = NonNullable<ShellThread["pullRequests"]>[number];

const watchWakes = ({ snapshot, watch }: ShellPullRequest) => Boolean(watch) && (snapshot?.state?.toLowerCase() ?? "open") === "open"
  && (watch!.until === "merged" || watch!.checksPending !== false);

const wakes = (threads: ShellThread[], thread: ShellThread) => waits(threads, thread) || (thread.pullRequests ?? []).some(watchWakes);

type WakeStopBlock = { decision: "block"; reason: string };

export const wakeStop = (event: ProofStopEvent, message: string | undefined, options: WakeStopOptions): Promise<WakeStopBlock | undefined> =>
  withinDeadline((signal) => check(event, message, options, signal), options.deadline);

async function check(event: ProofStopEvent, message: string | undefined, options: WakeStopOptions, signal: AbortSignal): Promise<WakeStopBlock | undefined> {
  const { home, threadId } = options;
  if (event.stop_hook_active || !threadId || !message || !closesOnWait(message)) return undefined;
  if (claudeWakesOnEnd(event) || event.session_crons?.length) return undefined;
  const processes = options.processes ?? realProcesses;
  if (nestedSession(await processes.table(signal), processes.pid)) return undefined;
  const { threads } = await options.shell();
  const thread = matchThread(threads, threadId, (item) => item.id);
  if (!thread || outsideWakeCheck(thread, (options.now ?? Date.now)()) || wakes(threads, thread)) return undefined;
  return hasScheduledCheck(home, thread.id) ? undefined : { decision: "block", reason: noWakeReason(personName(home)) };
}
