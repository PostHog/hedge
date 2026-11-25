import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { matchThread, type ShellThread, t3CliRunner, withT3Session } from "../../base/lib/t3/index.ts";
import { backgroundReason, unwaitedBackgroundTasks } from "../lib/background-stop.ts";
import { awaitsChecks, claudeTaskRuns, isSnoozed, stopCheckDeadlineMs, waits, type ProcessTable, type StopHookEvent } from "../lib/thread-waits.ts";
import { asksForDecision, asksInProse, personName, proseTitles } from "../lib/prose-question.ts";
import { wakeStop } from "../lib/wake-stop.ts";

export type StopEvent = { transcript_path?: string; stop_hook_active?: boolean; last_assistant_message?: string };
export type StopBlock = { decision: "block"; reason: string };
export type IsHidden = (threadId: string | undefined, home: string, event: StopHookEvent) => Promise<boolean>;

type Line = { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown }; payload?: { type?: string; role?: string; name?: string; content?: unknown } };
type Block = { type?: string; text?: string; name?: string };
type Step = { text: string } | { asked: true };

export const questionToolReason = (person: string) => `Hedge blocked this stop: your last message asks ${person} a decision in prose, `
  + "and this thread stays out of their inbox after the turn: it is snoozed, waits on a task, Monitor or thread wait, or watches PR checks. "
  + "Ask it now with the question tool (AskUserQuestion in Claude, request_user_input in Codex): restate the decision in full, with options. "
  + `A pending question brings the thread back to ${person}. `
  + `If you cannot ask on a card, because a skill asks in prose or ${person} turned down the card, end the turn with your complete reply again, word for word: `
  + "T3 shows only the last message, so a pointer such as \"see my previous message\" hides your reply. If you asked nothing, end the turn again.";

const questionTool = /(^|__)(AskUserQuestion|request_user_input)$/;

function parse(line: string): Line | undefined {
  try {
    return JSON.parse(line) as Line;
  } catch {
    return undefined;
  }
}

function isUserPrompt(line: Line | undefined): boolean {
  if (line?.type === "user" && !line.isMeta) {
    const content = line.message?.content;
    return typeof content === "string" || (Array.isArray(content) && content.some((block: Block) => block?.type === "text"));
  }
  return line?.type === "event_msg" && line.payload?.type === "user_message";
}

function steps(line: Line | undefined): Step[] {
  if (line?.type === "response_item" && line.payload?.type === "function_call") return questionTool.test(line.payload.name ?? "") ? [{ asked: true }] : [];
  const content = line?.type === "assistant" ? line.message?.content
    : line?.type === "response_item" && line.payload?.type === "message" && line.payload.role === "assistant" ? line.payload.content : undefined;
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: Block): Step[] => {
    if ((block?.type === "text" || block?.type === "output_text") && block.text) return [{ text: block.text }];
    return block?.type === "tool_use" && questionTool.test(block.name ?? "") ? [{ asked: true }] : [];
  });
}

function askedAfterLastMessage(turn: string[], finalMessage: string | undefined): { last?: string; asked: boolean } {
  const all = turn.flatMap((line) => steps(parse(line)));
  const at = finalMessage === undefined ? all.findLastIndex((step) => "text" in step) : all.findLastIndex((step) => "text" in step && step.text === finalMessage);
  const last = finalMessage ?? (at < 0 ? undefined : (all[at] as { text: string }).text);
  return { last, asked: at >= 0 && all.slice(at + 1).some((step) => "asked" in step) };
}

export async function finalMessage(event: StopEvent): Promise<string | undefined> {
  if (event.last_assistant_message !== undefined || !event.transcript_path) return event.last_assistant_message;
  try {
    return askedAfterLastMessage(currentTurn(await readFile(event.transcript_path, "utf8")), undefined).last;
  } catch {
    return undefined;
  }
}

export function currentTurn(transcript: string): string[] {
  const lines = transcript.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) if (isUserPrompt(parse(lines[index]!))) return lines.slice(index + 1);
  return lines;
}

export const hiddenIn = (shell: ReadShell, now = Date.now): IsHidden => async (threadId, home, event) => {
  if (!threadId) return false;
  try {
    const { threads } = await shell();
    const thread = matchThread(threads, threadId, (item) => item.id);
    if (!thread || thread.lineage?.parentThreadId || asksInProse(thread.title, proseTitles(home))) return false;
    return isSnoozed(thread, now()) || claudeTaskRuns(event)
      || waits(threads, thread) || (thread.pullRequests ?? []).some(awaitsChecks);
  } catch {
    return false;
  }
};

export async function guardStop(event: StopEvent & StopHookEvent, home: string, threadId = process.env.T3CODE_THREAD_ID, hidden: IsHidden = hiddenIn(liveShell(home))): Promise<StopBlock | undefined> {
  if (event.stop_hook_active || !event.transcript_path) return undefined;
  let turn: string[];
  try {
    turn = currentTurn(await readFile(event.transcript_path, "utf8"));
  } catch {
    return undefined;
  }
  const { last, asked } = askedAfterLastMessage(turn, event.last_assistant_message);
  if (asked || !last || !asksForDecision(last)) return undefined;
  if (!(await hidden(threadId, home, event))) return undefined;
  return { decision: "block", reason: questionToolReason(personName(home)) };
}

export type ToolEvent = { session_id?: string; agent_id?: string; tool_name?: string; tool_input?: Record<string, unknown> };
export type CardDenial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };
export type ReadShell = () => Promise<{ threads: ShellThread[] }>;
export type CardGuardOptions = { home: string; shell: ReadShell };

export const killSwitch = ".config/hedge/ask-guard.off";

async function readThreads(shell: ReadShell): Promise<ShellThread[] | undefined> {
  try {
    return (await shell()).threads;
  } catch {
    return undefined;
  }
}

export const proseCardReason = "Hedge blocked this card: this thread's title marks it as one that asks in prose, because a job queues messages into it, and a pending card would hold them. "
  + "Write the questions in your last message instead, numbered, each with your recommendation first.";

export async function guardCard(event: ToolEvent, options: CardGuardOptions, threadId: string | undefined): Promise<CardDenial | undefined> {
  if (!questionTool.test(event.tool_name ?? "") || !threadId || existsSync(join(options.home, killSwitch))) return undefined;
  const starts = proseTitles(options.home);
  if (!starts.length) return undefined;
  const thread = matchThread((await readThreads(options.shell)) ?? [], threadId, (item) => item.id);
  if (!asksInProse(thread?.title, starts)) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: proseCardReason } };
}

const t3CallMs = 3_000;

async function readShell(home: string): Promise<{ threads: ShellThread[] }> {
  let result: { threads: ShellThread[] } | undefined;
  try {
    return await withT3Session(async (client) => (result = await client.getShell<{ threads: ShellThread[] }>()), { home, ttl: "1m", timeoutMs: t3CallMs, runCli: t3CliRunner({ timeoutMs: t3CallMs }) });
  } catch (error) {
    if (result) return result;
    throw error;
  }
}

const liveShell = (home: string): ReadShell => {
  let snapshot: Promise<{ threads: ShellThread[] }> | undefined;
  return () => (snapshot ??= readShell(home));
};

export type StopDeps = { threadId?: string; processes?: ProcessTable; deadline?: () => Promise<void>; hidden?: IsHidden; now?: () => number };

export async function guardBackground(event: StopEvent & StopHookEvent, home: string, threadId: string | undefined): Promise<StopBlock | undefined> {
  if (event.stop_hook_active || !threadId || !event.transcript_path || !event.background_tasks?.length) return undefined;
  const ids = unwaitedBackgroundTasks(currentTurn(await readFile(event.transcript_path, "utf8")), event.background_tasks);
  return ids.length ? { decision: "block", reason: backgroundReason(ids, personName(home)) } : undefined;
}

async function guardTurnEnd(event: StopEvent & StopHookEvent, home: string, shell: ReadShell, deps: StopDeps) {
  const threadId = "threadId" in deps ? deps.threadId : process.env.T3CODE_THREAD_ID;
  const prose = await guardStop(event, home, threadId, deps.hidden ?? hiddenIn(shell)).catch(() => undefined);
  if (prose || existsSync(join(home, killSwitch))) return prose;
  const background = await guardBackground(event, home, threadId).catch(() => undefined);
  if (background) return background;
  const last = await finalMessage(event);
  const now = deps.now ?? Date.now;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = deps.deadline?.() ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, stopCheckDeadlineMs); });
  try {
    const answer = await wakeStop(event, last, { home, threadId, shell, processes: deps.processes, deadline: () => end });
    return now() - started < stopCheckDeadlineMs ? answer : undefined;
  } finally {
    clearTimeout(timer);
  }
}

export const hookWith = (shell: (home: string) => ReadShell, stop: StopDeps = {}): Hook => async (_provider, readInput, home) => {
  try {
    const event = JSON.parse(await readInput()) as StopEvent & StopHookEvent & ToolEvent;
    if (event.tool_name !== undefined) {
      const options = { home, shell: shell(home) };
      return printing(await guardCard(event, options, "threadId" in stop ? stop.threadId : process.env.T3CODE_THREAD_ID));
    }
    return printing(await guardTurnEnd(event, home, shell(home), stop));
  } catch {
    return printing(undefined);
  }
};

export const hook = hookWith(liveShell);

if (import.meta.main) await runHook(hook, { exitOnAnswer: true });
