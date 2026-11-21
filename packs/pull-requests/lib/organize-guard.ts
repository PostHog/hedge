import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ShellThread, t3UserData } from "../../base/lib/t3/index.ts";
import { remoteLauncher } from "../../../src/hub/ssh.ts";
import { runGh } from "./gh.ts";
import { fullIdHint, guardedActions, isOrganize, listedThread, pinnedReason, prState, readHandovers, readT3Threads, settleRefusal, settleTarget } from "./pr-owners.ts";

export type RemoteAnswer = { refusal?: string };
export type SettleCheck = (home: string, environmentId: string, action: string, threadId: string) => Promise<RemoteAnswer | undefined>;
export type Ssh = (alias: string, command: string) => Promise<{ code: number; stdout: string }>;

const aliasPattern = /^[a-z0-9][a-z0-9.-]*$/;
const threadPattern = /^[a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511}$/;
const sshLimitMs = 10_000;

export const settleCheckUsage = "Usage: hedge pr settle-check --action <settle|snooze|archive> --thread <thread id>";

const realSsh: Ssh = async (alias, command) => {
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=5", alias, command], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: sshLimitMs });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code: code ?? 255, stdout };
};

async function thisEnvironment(home: string): Promise<string> {
  return (await readFile(join(t3UserData(home), "environment-id"), "utf8").catch(() => "")).trim();
}

export async function peerOf(home: string, environmentId: string): Promise<string | undefined> {
  const links = join(home, ".config/hedge/peer-links");
  if (!existsSync(links)) return undefined;
  for (const name of (await readdir(links)).filter((file) => file.endsWith(".json")).sort()) {
    const alias = name.slice(0, -".json".length);
    const record = await readFile(join(links, name), "utf8").then((text) => JSON.parse(text) as { environmentId?: unknown }).catch(() => ({ environmentId: undefined }));
    if (record.environmentId === environmentId && aliasPattern.test(alias)) return alias;
  }
  return undefined;
}

export const settleCheckOver = (ssh: Ssh = realSsh): SettleCheck => async (home, environmentId, action, threadId) => {
  if (environmentId === (await thisEnvironment(home))) return undefined;
  const alias = await peerOf(home, environmentId);
  if (!alias) return undefined;
  if (!threadPattern.test(threadId) || !["settle", "snooze", "archive"].includes(action)) throw new Error("the thread id or action has a form Hedge does not send");
  const answer = await ssh(alias, `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" sh ${remoteLauncher} pr settle-check --action ${action} --thread ${threadId}`);
  if (answer.code !== 0) throw new Error(`${alias} did not answer: hedge pr settle-check exited ${answer.code}`);
  const parsed = (() => { try { return JSON.parse(answer.stdout.trim().split("\n").at(-1) ?? "") as unknown; } catch { return undefined; } })();
  if (typeof parsed !== "object" || parsed === null || !("refusal" in parsed)) throw new Error(`${alias} sent no settle-check answer`);
  const { refusal } = parsed as { refusal: unknown };
  if (refusal === null) return {};
  if (typeof refusal === "string" && refusal.trim()) return { refusal };
  throw new Error(`${alias} sent a settle-check answer Hedge cannot read`);
};

export function parseSettleCheck(args: string[]): { action: string; threadId: string } {
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const [action, threadId] = [value("--action"), value("--thread")];
  if (args.length !== 4 || !action || !["settle", "snooze", "archive"].includes(action) || !threadId || !threadPattern.test(threadId)) throw new Error(settleCheckUsage);
  return { action, threadId };
}

export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> };
export type SettleDeps = {
  threads: (home: string, environmentId?: string) => Promise<ShellThread[] | undefined>; prState: (url: string) => Promise<string>;
  self?: string; settleCheck?: SettleCheck;
};

const fallbackPerson = "the person who runs this machine";
const noAnswer = (action: string) => `Hedge blocked this ${action}: T3 did not answer; retry, or ${action} in the T3 UI.`;
const unlisted = (action: string, id: string, full: string | undefined) => `Hedge blocked this ${action}: T3 did not list thread ${id}, so Hedge cannot check its pin or its PRs. `
  + `T3 takes only a full thread id: pass ${full ?? "the id t3_thread_list shows, with environmentId for a thread on another machine"}, or ${action} in the T3 UI.`;
const unnamed = (action: string) => `Hedge blocked this ${action}: the call names no thread, and T3CODE_THREAD_ID is unset, so Hedge cannot tell which thread it ${action}s. Pass threadId, or ${action} in the T3 UI.`;
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

export function personName(home: string): string {
  try {
    const file = join(home, ".local/state/hedge/settings.json");
    const person = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)["guards.person"] : undefined;
    return typeof person === "string" && person.trim() ? person.trim() : fallbackPerson;
  } catch {
    return fallbackPerson;
  }
}

export async function organizeRefusal(action: string, id: string, home: string, deps: SettleDeps, machine?: string, failOpen = true): Promise<string | undefined> {
  const threads = await deps.threads(home, machine).catch(() => undefined);
  if (!threads) return action === "snooze" && failOpen ? undefined : noAnswer(action);
  const person = personName(home);
  const target = listedThread(threads, id);
  if (!target) return action === "snooze" && failOpen ? undefined : unlisted(action, id, fullIdHint(threads, id));
  if (action !== "archive" && target.pinnedAt) return pinnedReason(person);
  if (action === "snooze") return undefined;
  return settleRefusal(target.id, { threads, handovers: () => readHandovers(home), prState: deps.prState }, person);
}

export async function guardSettle(call: ToolCall, home: string, deps: SettleDeps) {
  if (!isOrganize(call.tool_name)) return undefined;
  const input = call.tool_input ?? {};
  const action = String(input.action);
  const id = settleTarget(input, deps.self);
  if (!id) return guardedActions.includes(action) && action !== "snooze" ? deny(unnamed(action)) : undefined;
  const machine = typeof input.environmentId === "string" && input.environmentId ? input.environmentId : undefined;
  if (machine && deps.settleCheck) {
    const remote = await deps.settleCheck(home, machine, action, id).catch(() => null);
    if (remote) return remote.refusal ? deny(remote.refusal) : undefined;
    if (remote === null) {
      const reason = await organizeRefusal(action, id, home, deps, machine, false);
      return reason ? deny(reason) : undefined;
    }
  }
  const reason = await organizeRefusal(action, id, home, deps, machine);
  return reason ? deny(reason) : undefined;
}

export const liveDeps = (): SettleDeps => ({ threads: readT3Threads, prState: (url) => prState(runGh, url), self: process.env.T3CODE_THREAD_ID, settleCheck: settleCheckOver() });
