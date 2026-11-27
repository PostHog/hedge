import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import type { Env } from "../../pull-requests/lib/decision-ledger.ts";
import { fullHeldAtAuto, type T3Reader } from "../../pull-requests/lib/mode.ts";
import { beforeDeadline, exemptList, mergeGateRisk, mergeIntent, realGateIO, realIntentIO, unreadBody, unreadBodyNote, type GateIO, type IntentIO, type ToolCall } from "../lib/merge-gate.ts";

export type Denial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };
export type Where = { home: string; env: Env; gate?: GateIO; github?: Pick<GateIO, "pull" | "pullFor">; now?: () => number; intent?: IntentIO; deadline?: Promise<void>; reader?: T3Reader };

const fallbackPerson = "the person who runs this machine";
const deny = (reason: string): Denial => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

type GateSettings = { person: string; exempt: string[]; text: string; applied: boolean };

function gateSettings(home: string): GateSettings {
  const file = join(home, ".local/state/hedge/settings.json");
  if (!existsSync(file)) return { person: fallbackPerson, exempt: [], text: "{}", applied: false };
  const text = readFileSync(file, "utf8");
  const settings = JSON.parse(text) as Record<string, unknown>;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error(`${file} is not a JSON object`);
  const person = settings["guards.person"];
  return { person: typeof person === "string" && person.trim() ? person.trim() : fallbackPerson, exempt: exemptList(settings["guards.merge-gate-exempt"]), text, applied: true };
}

function shellCommand(input: Record<string, unknown> = {}) {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return /(?:^|\/)(?:ba)?sh$/.test(String(command[0])) && /^-l?c$/.test(String(command[1])) ? String(command[2] ?? "") : command.join(" ");
  return typeof command === "string" ? command : "";
}

/** Refuses an enqueue or merge until `hedge proof gate` passed at the head of each open layer of the PR's stack, or the person's gate override covers that head, and while a layer holds a gap an agent accepted without the person's merge word for its head, exempt repositories included. */
export async function mergeGate(call: ToolCall, where: Where): Promise<Denial | undefined> {
  let settings: GateSettings | undefined;
  let problem = "";
  try { settings = gateSettings(where.home); }
  catch (error) { problem = (error as Error).message; }
  const intent = mergeIntent(call, shellCommand(call.tool_input), settings?.exempt ?? [], where.intent ?? realIntentIO);
  if (!intent.refusal && !intent.targets.length && !intent.exempt?.length) return undefined;
  const explained = (reason: string) => deny(unreadBody(intent) ? `${unreadBodyNote} ${reason}` : reason);
  if (!settings) return explained(`Hedge blocked this merge: the merge gate could not read its settings (${problem}), so it cannot tell which repositories skip the gate. Fix that file.`);
  const env = { ...where.env, HEDGE_SETTINGS: where.env.HEDGE_SETTINGS ?? settings.text };
  const io = where.gate ?? { ...realGateIO(where.home, env, settings.applied ? settings.text : fullHeldAtAuto(env.HEDGE_SETTINGS), settings.applied ? where.env.HEDGE_SETTINGS : undefined, where.reader), ...where.github, ...where.now ? { now: where.now } : {} };
  const refusal = await beforeDeadline(() => mergeGateRisk(intent, io, settings.person), where.deadline);
  return refusal ? explained(refusal) : undefined;
}

async function answer(input: string, home: string): Promise<Denial | undefined> {
  let call: ToolCall;
  try { call = JSON.parse(input); }
  catch { return deny("Hedge blocked this call: the merge gate could not read the hook input, which is not JSON."); }
  return mergeGate(call, { home, env: Bun.env });
}

export const hook: Hook = async (_provider, readInput, home) => printing(await answer(await readInput(), home));

export { hook as hedgeHook };

if (import.meta.main) await runHook(hook, { exitOnAnswer: true });
