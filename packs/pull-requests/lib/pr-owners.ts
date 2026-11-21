import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type LinkedThread, listLinkedThreads, matchThread, readSnapshots, type ShellPullRequest, type ShellThread, type T3HttpClient, withT3Session } from "../../base/lib/t3/index.ts";
import type { Gh } from "./gh.ts";

export type Handover = { pr: string; from: string; to: string; at: string };
export type OwnerDeps = { threads: ShellThread[]; handovers: () => Promise<Handover[]>; prState: (url: string) => Promise<string> };

export const handoverUsage = "Usage: hedge pr handover --pr <PR URL> --to <thread id>";
export const handoverPath = (home: string) => join(home, ".local/state/hedge/pr-handovers.jsonl");
const prUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const threadId = /^[a-zA-Z0-9][a-zA-Z0-9:._%-]{0,511}$/;
const key = (url: string) => url.toLowerCase().replace(/\/+$/, "");

export function parseHandover(args: string[]): { pr: string; to: string } {
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const [pr, to] = [value("--pr"), value("--to")];
  if (args.length !== 4 || !pr || !to || !prUrl.test(pr) || !threadId.test(to)) throw new Error(handoverUsage);
  return { pr, to };
}

export const listedThread = (threads: ShellThread[], id: string) => threads.find((thread) => thread.id === id);

export function fullIdHint(threads: ShellThread[], id: string): string | undefined {
  const matches = threads.filter((thread) => thread.id.endsWith(`:${id}`));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export const linkedPullRequests = (thread: ShellThread) => (thread.pullRequests ?? []).filter((pr) => pr.source !== "stack-dismissed");
const links = (thread: ShellThread, url: string) => linkedPullRequests(thread).some((link) => key(link.url) === key(url));

export async function recordHandover(args: string[], home: string, from: string | undefined, now: Date, readThreads: () => Promise<ShellThread[] | undefined>): Promise<Handover> {
  const { pr, to } = parseHandover(args);
  if (!from) throw new Error("hedge pr handover runs inside a T3 thread: T3CODE_THREAD_ID names the thread that hands the PR over.");
  const threads = await readThreads().catch(() => undefined);
  if (!threads) throw new Error("hedge pr handover needs T3, and T3 did not answer; retry.");
  const taker = listedThread(threads, to);
  if (!taker) {
    const full = fullIdHint(threads, to);
    throw new Error(`T3 did not list thread ${to}. ${full ? `Hand the PR to its full id ${full}.` : "Hand the PR to the full id t3_thread_list shows."}`);
  }
  if (!live(taker)) throw new Error(`Thread ${to} is settled, archived, or deleted, so it cannot own the PR. Hand it to an open thread.`);
  if (taker.id === from) throw new Error(`Thread ${to} is the thread that hands the PR over. Hand it to another open thread.`);
  if (!links(taker, pr)) {
    throw new Error(`Thread ${to} does not link ${pr} yet. Send it a message with t3_thread_send that hands the PR over and asks it to link the PR with link_pull_request, then run the handover again.`);
  }
  const record: Handover = { pr: key(pr), from, to, at: now.toISOString() };
  await mkdir(dirname(handoverPath(home)), { recursive: true, mode: 0o700 });
  await appendFile(handoverPath(home), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function readHandovers(home: string): Promise<Handover[]> {
  const text = await readFile(handoverPath(home), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).flatMap((row) => {
    try {
      const record = JSON.parse(row) as Partial<Handover>;
      return typeof record.pr === "string" && typeof record.from === "string" && typeof record.to === "string" ? [record as Handover] : [];
    } catch {
      return [];
    }
  });
}

const live = (thread: ShellThread) => !thread.deletedAt && !thread.archivedAt && !thread.settledAt;
export const subagentParent = (thread: ShellThread) =>
  (thread.lineage?.relationshipToParent ?? "subagent") === "subagent" ? thread.lineage?.parentThreadId ?? undefined : undefined;

function rootOf(threads: ShellThread[], thread: ShellThread): string | undefined {
  let current = thread;
  for (let parentId = subagentParent(current), steps = 0; parentId && steps < 64; parentId = subagentParent(current), steps++) {
    const parent = threads.find((candidate) => candidate.id === parentId);
    if (!parent) return current.lineage?.rootThreadId ?? parentId;
    current = parent;
  }
  return current === thread ? undefined : current.id;
}
const seenOpen = (state: string | undefined) => !["merged", "closed"].includes(state ?? "");

export function ownedLinks(threads: ShellThread[], id: string): string[] {
  return ownedPullRequests(threads, id).map((pr) => pr.url);
}

export function ownedPullRequests(threads: ShellThread[], id: string): ShellPullRequest[] {
  const target = matchThread(threads, id, (thread) => thread.id);
  if (!target) return [];
  const root = rootOf(threads, target);
  if (root && threads.some((thread) => thread.id === root && live(thread))) return [];
  const family = threads.filter((thread) => thread.id === target.id || (rootOf(threads, thread) === target.id && live(thread)));
  const others = new Set(threads.filter((thread) => live(thread) && !family.includes(thread)).flatMap((thread) => linkedPullRequests(thread).map((pr) => key(pr.url))));
  const owned = new Map(family.flatMap(linkedPullRequests).filter((pr) => seenOpen(pr.snapshot?.state)).map((pr) => [key(pr.url), pr]));
  return [...owned].filter(([known]) => !others.has(known)).map(([, pr]) => pr);
}

function handedOverBy(handovers: Handover[], threads: ShellThread[], id: string): Set<string> {
  const settling = matchThread(threads, id, (thread) => thread.id);
  if (!settling) return new Set();
  const named = (value: string) => matchThread(threads, value, (thread) => thread.id);
  return new Set(handovers.filter(({ pr, from, to }) => {
    const taker = named(to);
    return named(from) === settling && taker !== undefined && taker !== settling && live(taker) && links(taker, pr);
  }).map(({ pr }) => key(pr)));
}

export function unhandedLinks(threads: ShellThread[], id: string, handovers: Handover[]): string[] {
  const handed = handedOverBy(handovers, threads, id);
  return ownedLinks(threads, id).filter((url) => !handed.has(key(url)));
}

export const handOverFirst = "Or hand each over first: send the thread that takes it over a message with t3_thread_send that asks it to link the PR with link_pull_request, "
  + "then run `hedge pr handover --pr <PR URL> --to <thread id>`, which counts only while that thread stays open and links the PR. Or close or merge the PR.";

export async function settleRefusal(id: string, deps: OwnerDeps, person: string): Promise<string | undefined> {
  const open: string[] = [];
  for (const url of unhandedLinks(deps.threads, id, await deps.handovers())) {
    const state = await deps.prState(url).catch((error: Error) => `unknown (${error.message.split("\n")[0]})`);
    if (!["closed", "merged"].includes(state)) open.push(state === "open" ? url : `${url} (state ${state})`);
  }
  if (!open.length) return undefined;
  return `Hedge blocked this settle: the thread owns open PR(s) ${open.join(", ")}, and no other open thread links them. `
    + `If ${person} parked them, snooze the thread until the park date instead. `
    + handOverFirst;
}

export async function prState(gh: Gh, url: string): Promise<string> {
  const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i) ?? [];
  if (!number) throw new Error(`Not a PR URL: ${url}`);
  const pr = JSON.parse(await gh(["api", `repos/${owner}/${repo}/pulls/${number}`])) as { state: string; merged_at: string | null };
  return pr.merged_at ? "merged" : pr.state;
}

export const isOrganize = (name = "") => /^mcp__t3[-_]code__t3_thread_organize$/.test(name);

export const guardedActions = ["settle", "snooze", "archive"];

export const pinnedReason = (person: string) => `Hedge blocked this call: ${person} pinned this thread to keep it in view, so leave it open. Only ${person} snoozes it, in T3.`;

export function settleTarget(input: Record<string, unknown>, self: string | undefined): string | undefined {
  if (!guardedActions.includes(String(input.action))) return undefined;
  return typeof input.threadId === "string" && input.threadId ? input.threadId : self;
}

export function threadsOwningPrs(threads: ShellThread[]): string[] {
  return threads.filter((thread) => live(thread) && !rootOf(threads, thread)).flatMap((thread) => {
    const owned = ownedLinks(threads, thread.id);
    return owned.length ? [`${thread.title} (owns open PR ${owned.join(", ")})`] : [];
  });
}

async function localEnvironment(client: T3HttpClient): Promise<string | undefined> {
  const answer = await client.get<{ environmentId?: unknown }>("/.well-known/t3/environment").catch(() => undefined);
  return typeof answer?.environmentId === "string" ? answer.environmentId : undefined;
}

function asShellThreads(linked: LinkedThread[]): ShellThread[] {
  const byId = new Map(linked.map((thread) => [thread.threadId, thread]));
  const rootOfLinked = (thread: LinkedThread): string => {
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
    return parent ? rootOfLinked(parent) : thread.parentThreadId ?? thread.threadId;
  };
  return linked.map((thread) => ({
    id: thread.threadId, title: thread.title, projectId: thread.projectId, status: thread.status,
    ...(thread.settled ? { settledAt: thread.updatedAt || "settled" } : {}),
    ...(thread.pinned ? { pinnedAt: thread.updatedAt || "pinned" } : {}),
    ...(thread.parentThreadId ? { lineage: { parentThreadId: thread.parentThreadId, rootThreadId: rootOfLinked(thread), relationshipToParent: thread.relationshipToParent ?? null } } : {}),
    pullRequests: (thread.pullRequests ?? []).map((pr) => ({ repository: pr.repository, number: pr.number, url: pr.url, ...(pr.state ? { snapshot: { state: pr.state } } : {}) })),
  }));
}

export async function readT3Threads(home: string, environmentId?: string): Promise<ShellThread[] | undefined> {
  return withT3Session(async (client) => {
    if (environmentId && environmentId !== await localEnvironment(client)) {
      return asShellThreads(await listLinkedThreads(client, environmentId, { allProjects: true, includeSubagents: true }));
    }
    return (await readSnapshots(client)).flatMap((snapshot) => snapshot.threads);
  }, { home }).catch(() => undefined);
}
