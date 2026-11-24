import { readFile } from "node:fs/promises";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { expandHome } from "../lib/lessons.ts";
import { loopLedgerSetting, pausedReason, pauseState } from "../lib/loop.ts";
import { readSettings } from "../lib/prose-question.ts";

export type DelegateEvent = { tool_name?: string; transcript_path?: string };
export type LaneDenial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

type Line = { type?: string; isMeta?: boolean; message?: { content?: unknown }; payload?: { type?: string; message?: unknown } };

const startsSubthread = /(?:^|__)delegate_task$/;
const provenance = /^\s*(?:\[[^\]\n]*\]\s*)*/;
const asksForRun = /^[^\n]*\bcoordinator\b[^\n]*\b(?:quality|signal)-loop\b/i;
const slashCommand = /<command-name>\/(?:[\w-]+:)?(?:quality|signal)-loop<\/command-name>/;

const opensCoordinatorRun = (prompt: string) => asksForRun.test(prompt.replace(provenance, "")) || slashCommand.test(prompt);

function promptText(line: Line): string | undefined {
  if (line.type === "event_msg" && line.payload?.type === "user_message") return typeof line.payload.message === "string" ? line.payload.message : undefined;
  if (line.type !== "user" || line.isMeta) return undefined;
  const content = line.message?.content;
  if (typeof content === "string") return content;
  const texts = Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")) : [];
  return texts.length ? texts.join("\n") : undefined;
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

function loopLedger(home: string): string | undefined {
  const value = readSettings(home)[loopLedgerSetting];
  return typeof value === "string" && value.trim() ? expandHome(value.trim(), home) : undefined;
}

/** Refuses a new subthread from a quality-loop or signal-loop coordinator while the loop ledger's limits.md pauses the
 * loops, or cannot be read. Settling, watches, scheduled checks and every other thread pass. */
export async function guardLoopPause(event: DelegateEvent, home: string): Promise<LaneDenial | undefined> {
  if (!startsSubthread.test(event.tool_name ?? "")) return undefined;
  const ledger = loopLedger(home);
  if (!ledger || !(await isLoopCoordinator(event.transcript_path))) return undefined;
  const pause = pauseState(ledger);
  if (pause.state === "runs") return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Hedge blocked this lane. ${pausedReason(pause.why)}` } };
}

export const hook: Hook = async (_provider, readInput, home) => printing(await guardLoopPause(JSON.parse(await readInput()) as DelegateEvent, home));

if (import.meta.main) await runHook(hook);
