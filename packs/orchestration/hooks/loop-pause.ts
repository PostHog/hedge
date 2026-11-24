import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { expandHome } from "../lib/lessons.ts";
import { loopLedgerSetting, pausedReason, pauseState } from "../lib/loop.ts";
import { readSettings } from "../lib/prose-question.ts";

export type DelegateEvent = { tool_name?: string; transcript_path?: string };
export type LaneDenial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

type Line = { type?: string; isMeta?: boolean; message?: { content?: unknown }; payload?: { type?: string; role?: string; message?: unknown; content?: unknown } };

const startsSubthread = /(?:^|__)delegate_task$/;
const scheduledTask = /^\s*\[T3 Code: scheduled task "[^"\n]*"[^\]\n]*\]\s*/;
const runVerb = /^\W*(?:run|start)\b/i;
const loopName = /\b(?:quality|signal)-loop\b/i;
const coordinator = /\bcoordinator\b/i;

function opensCoordinatorRun(prompt: string): boolean {
  const sent = scheduledTask.exec(prompt);
  if (!sent) return false;
  const line = prompt.slice(sent[0].length).split("\n")[0]!;
  return runVerb.test(line) && loopName.test(line) && coordinator.test(line);
}

const codexContext = /^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>)/;

function textOf(content: unknown, blockTypes: string[]): string | undefined {
  if (typeof content === "string") return content;
  const texts = Array.isArray(content) ? content.filter((block) => blockTypes.includes(block?.type)).map((block) => String(block.text ?? "")) : [];
  return texts.length ? texts.join("\n") : undefined;
}

function promptText(line: Line): string | undefined {
  if (line.type === "event_msg" && line.payload?.type === "user_message") return typeof line.payload.message === "string" ? line.payload.message : undefined;
  if (line.type === "response_item" && line.payload?.type === "message" && line.payload.role === "user") {
    const text = textOf(line.payload.content, ["input_text"]);
    return text === undefined || codexContext.test(text) ? undefined : text;
  }
  if (line.type !== "user" || line.isMeta) return undefined;
  return textOf(line.message?.content, ["text"]);
}

function firstPrompt(transcript: string): string | undefined {
  for (const raw of transcript.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const text = promptText(JSON.parse(raw) as Line);
      if (text !== undefined) return text;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function isLoopCoordinator(transcriptPath: string | undefined): Promise<boolean> {
  if (!transcriptPath) return false;
  try {
    return opensCoordinatorRun(firstPrompt(await readFile(transcriptPath, "utf8")) ?? "");
  } catch {
    return false;
  }
}

function missing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function loopLedger(home: string): string | undefined {
  const value = readSettings(home)[loopLedgerSetting];
  return typeof value === "string" && value.trim() ? expandHome(value.trim(), home) : undefined;
}

export async function guardLoopPause(event: DelegateEvent, home: string): Promise<LaneDenial | undefined> {
  if (!startsSubthread.test(event.tool_name ?? "")) return undefined;
  const ledger = loopLedger(home);
  if (!ledger || missing(ledger) || !(await isLoopCoordinator(event.transcript_path))) return undefined;
  const pause = pauseState(ledger);
  if (pause.state === "runs") return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Hedge blocked this lane. ${pausedReason(pause.why)}` } };
}

export const hook: Hook = async (_provider, readInput, home) => printing(await guardLoopPause(JSON.parse(await readInput()) as DelegateEvent, home));

if (import.meta.main) await runHook(hook);
