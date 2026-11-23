import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { commandsIn } from "./shell-words.ts";

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
type TranscriptEntry = { type?: string; message?: { content?: unknown } };
export type StatusCall = { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string; transcript_path?: string };

const longestAllowedPause = 10;
const chunkSize = 64 * 1024;
const unitSeconds: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

export const sleepPollReason = (person: string) => "Hedge blocked this sleep over 10 s. Wait in one blocking call: `until <check>; do sleep 30; done`, "
  + "`gh run watch <id> --exit-status`, `gh pr checks <number> --watch`, `t3_background_wait` for a background task in T3 Code, "
  + "or `watch_pull_request` and end the turn for a pull request. A sleep and then a check costs a model turn per repeat, "
  + `and each turn rereads the whole context. If nothing can wait for this event in one call, stop and ask ${person}.`;

export const repeatedStatusReason = (person: string) => "Hedge blocked this call: you already checked this task since this thread last woke. "
  + "T3 wakes this thread when the task ends, so end the turn. "
  + "If this turn needs the result now, call `t3_thread_wait` on the task's child thread with a long `timeoutMs`. "
  + `If the task looks stuck, stop and ask ${person}.`;

function seconds(operand: string): number {
  if (/[$`]/.test(operand) || /^\+?inf(?:inity)?[smhd]?$/i.test(operand)) return Infinity;
  const match = operand.match(/^\+?((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([smhd]?)$/i);
  return match ? Number(match[1]) * unitSeconds[match[2].toLowerCase()] : 0;
}

const pauseSeconds = (args: string[]) => args.reduce((total, operand) => total + seconds(operand), 0);

/** A `sleep` command longer than 10 seconds outside a loop that waits in one command: a poll that costs a turn per check. */
export const isSleepPoll = (command: string) =>
  commandsIn(command).some((pause) => pause.name === "sleep" && !pause.inLoop && pauseSeconds(pause.args) > longestAllowedPause);

export const isTaskStatus = (name = "") => /^mcp__t3[-_]code__task_status$/.test(name);

const onlyToolResults = (content: unknown) =>
  Array.isArray(content) && content.length > 0 && content.every((block: Block) => block?.type === "tool_result");

function parse(line: string): TranscriptEntry | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function* linesFromEnd(path: string): Generator<string> {
  const file = openSync(path, "r");
  try {
    let position = fstatSync(file).size;
    let tail: Buffer[] = [];
    while (position > 0) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      readSync(file, chunk, 0, size, position);
      let end = size;
      for (let newline = chunk.lastIndexOf(10, end - 1); newline >= 0; newline = end > 0 ? chunk.lastIndexOf(10, end - 1) : -1) {
        yield Buffer.concat([chunk.subarray(newline + 1, end), ...tail]).toString("utf8");
        tail = [];
        end = newline;
      }
      tail.unshift(chunk.subarray(0, end));
    }
    yield Buffer.concat(tail).toString("utf8");
  } finally {
    closeSync(file);
  }
}

function* transcriptEntries(path: string): Generator<TranscriptEntry | undefined> {
  try {
    for (const line of linesFromEnd(path)) yield parse(line);
  } catch {
    return;
  }
}

/** Whether this thread already checked the same task since a person or a wake last wrote to it. */
export function repeatsTaskStatus(call: StatusCall): boolean {
  if (!call.transcript_path) return false;
  const taskId = call.tool_input?.taskId;
  for (const entry of transcriptEntries(call.transcript_path)) {
    const content = entry?.message?.content;
    if (entry?.type === "user" && !onlyToolResults(content)) return false;
    if (entry?.type !== "assistant" || !Array.isArray(content)) continue;
    const earlierCheck = content.some((block: Block) =>
      block.type === "tool_use" && block.id !== call.tool_use_id && isTaskStatus(block.name) && block.input?.taskId === taskId);
    if (earlierCheck) return true;
  }
  return false;
}

type Finished = { status: string; outputFile?: string };
type Seen = { subagents: Set<string>; finished: Map<string, Finished> };

const subagentShape = /^a[0-9a-f]{16}$/;
const delegatedShape = /^(?:node|thread|run):/;
const notificationStart = "<task-notification>";
const stoppedStart = "Successfully stopped task: ";

function stoppedTaskOf(block: Block & { tool_use_id?: unknown; content?: unknown }): string | undefined {
  if (block?.type !== "tool_result" || typeof block.content !== "string") return undefined;
  try {
    const result = JSON.parse(block.content);
    return typeof result?.task_id === "string" ? result.task_id : undefined;
  } catch {
    return undefined;
  }
}

function stopsIn(entry: TranscriptEntry, stopCalls: Set<string>, stopResults: Map<string, string>) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as (Block & { tool_use_id?: unknown })[]) {
    if (block?.type === "tool_use" && block.name === "TaskStop" && block.id) stopCalls.add(block.id);
    const stopped = stoppedTaskOf(block);
    if (stopped && typeof block.tool_use_id === "string") stopResults.set(block.tool_use_id, stopped);
  }
}

export const isBackgroundWait = (name = "") => /^mcp__t3[-_]code__t3_background_wait$/.test(name);

const fieldReason = 'Hedge blocked this call: `t3_background_wait` takes `taskIds`, a list of IDs, as in `{"taskIds": ["<id>"]}`. '
  + "Pass the ID of a background command or Monitor that this thread started and that still runs.";

const textsOf = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: string; text?: unknown; content?: unknown }) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : block?.type === "tool_result" ? textsOf(block.content) : []);
};

function notificationsOf(entry: TranscriptEntry & { content?: unknown }): string[] {
  if (entry.type === "queue-operation") return typeof entry.content === "string" ? [entry.content] : [];
  const content = entry.message?.content;
  if (entry.type !== "user") return [];
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? content.flatMap((block: Block & { text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : [])) : [];
}

function seenIn(path: string | undefined): Seen {
  const seen: Seen = { subagents: new Set(), finished: new Map() };
  if (!path) return seen;
  const stopCalls = new Set<string>();
  const stopResults = new Map<string, string>();
  try {
    for (const line of linesFromEnd(path)) {
      if (![notificationStart, "agentId: ", stoppedStart, '"TaskStop"'].some((mark) => line.includes(mark))) continue;
      const entry = parse(line);
      if (!entry) continue;
      stopsIn(entry, stopCalls, stopResults);
      if (entry.type === "user") for (const text of textsOf(entry.message?.content)) for (const [, id] of text.matchAll(/^agentId: (\S+)/gm)) seen.subagents.add(id);
      for (const text of notificationsOf(entry).filter((each) => each.trimStart().startsWith(notificationStart))) {
        const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
        const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
        if (id && status) seen.finished.set(id, { status, outputFile: text.match(/<output-file>([^<]+)<\/output-file>/)?.[1] });
      }
    }
  } catch {
    return seen;
  }
  for (const [callId, id] of stopResults) if (stopCalls.has(callId) && !seen.finished.has(id)) seen.finished.set(id, { status: "stopped" });
  return seen;
}

function problemWith(id: string, seen: Seen): string | undefined {
  if (delegatedShape.test(id)) {
    return `\`${id}\` is a delegated task. T3 wakes this thread when it ends: follow the \`next\` step its \`delegate_task\` answer gave and end the turn, `
      + "or call `t3_thread_wait` on its child thread when this turn needs the result.";
  }
  if (seen.subagents.has(id) || subagentShape.test(id)) {
    return `\`${id}\` is a subagent. Claude Code tells this thread when it ends, so keep working or end the turn; `
      + "start a subagent with `run_in_background: false` when this turn needs its result.";
  }
  const done = seen.finished.get(id);
  if (!done) return undefined;
  return `\`${id}\` already finished (${done.status}). Read its output now${done.outputFile ? ` in ${done.outputFile}` : ""}; there is nothing to wait for.`;
}

/** Why a `t3_background_wait` call cannot keep this thread waiting: a wrong field, or an ID of a subagent, a delegated
 * task, or a background command that the transcript shows has finished. Undefined for a call T3 should judge itself. */
export function backgroundWaitRisk(call: StatusCall): string | undefined {
  const input = call.tool_input ?? {};
  const { taskIds } = input;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((id) => typeof id !== "string")) return fieldReason;
  if (input.waiting === false) return undefined;
  const seen = seenIn(call.transcript_path);
  const problems = (taskIds as string[]).flatMap((id) => problemWith(id, seen) ?? []);
  if (problems.length === 0) return undefined;
  const left = (taskIds as string[]).filter((id) => !problemWith(id, seen));
  const rest = left.length > 0 ? ` Pass only the IDs that still run: ${left.map((id) => `\`${id}\``).join(", ")}.` : "";
  return `Hedge blocked this call: ${problems.join(" ")}${rest}`;
}
