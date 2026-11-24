import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { installedOwners } from "../lib/allowlist.ts";
import { downloadRisk } from "../lib/download.ts";
import { exitMaskRewrite, exitMaskRisk } from "../lib/exit-mask.ts";
import { allowRuleList, ghRisk, ownerList } from "../lib/gh.ts";
import { gitRisk, repoList } from "../lib/git.ts";
import { killRisk } from "../lib/kill.ts";
import { onlyRoutineSteps } from "../lib/routine.ts";
import { shellTools } from "../lib/shell-words.ts";
import { backgroundWaitRisk, isBackgroundWait, isSleepPoll, isTaskStatus, repeatedStatusReason, repeatsTaskStatus, sleepPollReason } from "../lib/wait.ts";

export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; tool_use_id?: string; transcript_path?: string; permission_mode?: string };
export type Answer = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision?: "allow" | "deny"; permissionDecisionReason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string };
};

const fallbackPerson = "the person who runs this machine";

type Settings = { person: string; owners: Set<string> | null; mainPushRepos: Set<string>; allowRules: Set<string>; unreadable?: string };

function guardSettings(home: string): Settings {
  const file = join(home, ".local/state/hedge/settings.json");
  if (!existsSync(file)) return { person: fallbackPerson, owners: null, mainPushRepos: new Set(), allowRules: new Set() };
  try {
    const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("it is not a JSON object");
    const { "guards.person": person, "guards.owners": owners, "guards.main-push-repos": mainPushRepos, "guards.allow-rules": allowRules } = settings as Record<string, unknown>;
    if (owners !== undefined && owners !== null && typeof owners !== "string") throw new Error("guards.owners is not text");
    if (mainPushRepos !== undefined && mainPushRepos !== null && typeof mainPushRepos !== "string") throw new Error("guards.main-push-repos is not text");
    return { person: typeof person === "string" && person.trim() ? person.trim() : fallbackPerson, owners: ownerList(owners), mainPushRepos: repoList(mainPushRepos), allowRules: allowRuleList(allowRules) };
  } catch (error) {
    return { person: fallbackPerson, owners: null, mainPushRepos: new Set(), allowRules: new Set(), unreadable: `${file} (${error instanceof Error ? error.message : String(error)})` };
  }
}

function shellCommand(input: Record<string, unknown> = {}) {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return /(?:^|\/)(?:ba)?sh$/.test(String(command[0])) && /^-l?c$/.test(String(command[1])) ? String(command[2] ?? "") : command.join(" ");
  return typeof command === "string" ? command : "";
}

const deny = (reason: string): Answer => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

const unreadableReason = (problem: string, person: string) => `Hedge blocked this call: the shell guards could not read their settings in ${problem}, `
  + `so they cannot tell which GitHub owners and repositories agents may use. Fix that file, or stop and ask ${person}.`;

const uncheckedReason = (error: unknown, person: string) => `Hedge blocked this call: the shell guards could not check it (${error instanceof Error ? error.message : String(error)}). `
  + `Split it into simpler commands, or stop and ask ${person}.`;

function check(call: ToolCall, { person, owners, mainPushRepos, allowRules, unreadable }: Settings): string | undefined {
  if (isTaskStatus(call.tool_name)) return repeatsTaskStatus(call) ? repeatedStatusReason(person) : undefined;
  if (isBackgroundWait(call.tool_name)) return backgroundWaitRisk(call);
  if (!shellTools.has(call.tool_name ?? "")) return undefined;
  if (unreadable) return unreadableReason(unreadable, person);
  const command = shellCommand(call.tool_input);
  const cwd = call.cwd ?? "/";
  return downloadRisk(command, cwd, person) ?? ghRisk(command, owners, person, process.env.GH_REPO, allowRules) ?? killRisk(command, person)
    ?? gitRisk(command, cwd, person, mainPushRepos) ?? exitMaskRisk(command, person) ?? (isSleepPoll(command) ? sleepPollReason(person) : undefined);
}

const rewriteNote = (command: string) => `Hedge ran this command as \`${command}\`: it added \`|| exit\` after each push, commit, merge, `
  + "gate or watch whose exit status the call hid, so the call stops when one of those fails. Write it this way next time.";

const restrictsPersonalHooks = () => !/^(?:|0|false|no|off)$/i.test((process.env.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG ?? "").trim());

function rewritten(call: ToolCall, settings: Settings, provider: string): Answer | undefined {
  const input = call.tool_input;
  if (provider !== "claude" || call.tool_name !== "Bash" || typeof input?.command !== "string" || restrictsPersonalHooks()) return undefined;
  const command = exitMaskRewrite(input.command);
  if (command === undefined) return undefined;
  const updatedInput = { ...input, command };
  if (check({ ...call, tool_input: updatedInput }, settings)) return undefined;
  const allowed = call.permission_mode === "auto" && onlyRoutineSteps(command) ? { permissionDecision: "allow" as const } : {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...allowed, updatedInput, additionalContext: rewriteNote(command) } };
}

/** The answer for a tool call that a shell guard stops, naming the person the settings give. On Claude, a call whose only
 * fault is a hidden exit status runs rewritten into a form that shows it. In auto mode, which holds a rewritten call, the
 * rewrite is allowed when it runs only routine steps, so this list is the only review those calls get; any other rewrite,
 * and every rewrite in another mode, goes to Claude's own permission check.
 * Any other such call is refused, and so is a call the guards cannot check. An installed signed allowlist under the
 * system root wins over guards.owners. */
export function guard(call: ToolCall, home: string, root = "/", provider = ""): Answer | undefined {
  const settings = guardSettings(home);
  try {
    const checked = { ...settings, owners: installedOwners(root) ?? settings.owners };
    const risk = check(call, checked);
    return risk ? (rewritten(call, checked, provider) ?? deny(risk)) : undefined;
  } catch (error) {
    return deny(uncheckedReason(error, settings.person));
  }
}

function answer(input: string, home: string, provider: string): Answer | undefined {
  let call: ToolCall;
  try {
    call = JSON.parse(input);
  } catch {
    return deny(uncheckedReason(new Error("the hook input is not JSON"), guardSettings(home).person));
  }
  return guard(call, home, "/", provider);
}

export const hook: Hook = async (provider, readInput, home) => printing(answer(await readInput(), home, provider));

if (import.meta.main) await runHook(hook);
