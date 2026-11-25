import type { LinkedEnvironment, LinkedThread, LinkedTimelineItem, ShellThread } from "../../base/lib/t3/index.ts";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolRefusal, type ToolHandler } from "../../base/lib/t3/testing.ts";
import { cachedCheckout, spawnGit } from "../../../src/testing/git.ts";
import { engineSource, skillSources } from "../../../src/testing/packs.ts";
import type { Discussion, FetchDiscussion, FetchIssue, IssueNode } from "./wayfinder.ts";

export const now = new Date("2026-11-04T12:00:00Z");
export const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

export const linkedEnvironment: LinkedEnvironment = {
  environmentId: "env-linked", label: "devbox-2", urls: ["https://devbox-2.example.test"], access: "read-only",
  linkedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", lastReachedAt: null, lastError: null, status: "reachable",
};

export function shellThread(id: string, fields: Partial<ShellThread> = {}): ShellThread {
  return { id, title: `Thread ${id}`, projectId: "project-local", status: "idle", createdAt: minutesAgo(600), ...fields };
}

export type LinkedThreadFixture = LinkedThread & { archived?: boolean; pendingRequestCount?: number; branch?: string | null; items?: LinkedTimelineItem[]; runtimeMode?: string };

export function linkedThread(threadId: string, fields: Partial<LinkedThreadFixture> = {}): LinkedThreadFixture {
  return {
    threadId, projectId: "project-linked", title: `Thread ${threadId}`, status: "idle", model: "model-a",
    parentThreadId: null, settled: false, snoozedUntil: null, pullRequests: [], itemCount: 2,
    createdAt: minutesAgo(600), updatedAt: minutesAgo(300), ...fields,
  };
}

export function linkedItem(type: string, text: string, fields: Partial<LinkedTimelineItem> = {}): LinkedTimelineItem {
  return { position: 0, itemId: `${type}-${text.length}`, type, text, createdBy: type === "user_message" ? "user" : "agent", creationSource: type === "user_message" ? "web" : "provider", updatedAt: minutesAgo(300), ...fields };
}

export function linkedTools(threads: LinkedThreadFixture[]): ToolHandler {
  return (name, args) => {
    if (args.environmentId !== linkedEnvironment.environmentId) throw new ToolRefusal("invalid_request", "unknown environment");
    if (name === "t3_project_list") return { projects: [{ id: "project-linked", title: "Linked project" }], nextCursor: null };
    if (name === "t3_thread_list") {
      const listed = threads.filter((thread) => !thread.archived && (args.includeSubagents || !thread.parentThreadId) && (args.settled === undefined || thread.settled === args.settled));
      return { projectId: null, currentThreadId: null, threads: listed.map(({ archived, pendingRequestCount, branch, items, runtimeMode, ...item }) => item), nextCursor: null, total: listed.length };
    }
    if (name === "t3_thread_send") {
      const thread = threads.find((candidate) => candidate.threadId === args.threadId);
      if (!thread) throw new ToolRefusal("thread_not_found", "The thread was not found.");
      if (thread.runtimeMode === "full-access") throw new ToolRefusal("runtime_mode_escalation_denied", `Thread ${thread.threadId} runs in full-access mode, above this caller's.`);
      if (thread.status !== "running" && (args.mode === "steer" || args.mode === "restart")) {
        throw new ToolRefusal("no_steerable_run", `Thread ${thread.threadId} has no running turn to ${args.mode}.`);
      }
      const delivery = thread.status === "running"
        ? (args.mode === "queue" ? "queued" : args.mode === "restart" ? "restarted" : "steered")
        : "started";
      return { threadId: thread.threadId, messageId: `message:${args.clientRequestId}`, runId: "run:linked", status: delivery === "queued" ? "queued" : "running", delivery };
    }
    if (name === "t3_thread_read") {
      const thread = threads.find((candidate) => candidate.threadId === args.threadId);
      if (!thread) throw new ToolRefusal("thread_not_found", "The thread was not found.");
      const items = (thread.items ?? []).map((item, position) => ({ ...item, position }));
      const after = typeof args.afterPosition === "number" ? args.afterPosition : -1;
      const view = args.view === "activity" ? items : items.filter((item) => ["user_message", "assistant_message"].includes(item.type));
      const page = args.itemId === undefined ? view.filter((item) => item.position > after).slice(0, Number(args.limit ?? 50)) : items.filter((item) => item.itemId === args.itemId);
      const maxChars = Math.min(Number(args.maxCharsPerItem ?? 20_000), 50_000);
      const offset = Number(args.textOffset ?? 0);
      const shown = page.map((item) => {
        const text = item.text ?? "";
        const end = offset + maxChars;
        return { ...item, text: item.text === null ? null : text.slice(offset, end), textTruncated: end < text.length, nextTextOffset: end < text.length ? end : null };
      });
      const { archived, pendingRequestCount, branch, items: _, runtimeMode, ...detail } = thread;
      return {
        thread: { ...detail, itemCount: items.length, archived: Boolean(archived), pendingRequestCount: pendingRequestCount ?? 0, branch: branch ?? null, worktreePath: null },
        recentRuns: [], items: shown, nextPosition: page.at(-1)?.position ?? null, hasMore: args.itemId === undefined && view.some((item) => item.position > (page.at(-1)?.position ?? after)),
      };
    }
  };
}

export type GitHubFixture = { issues: IssueNode[]; discussions?: Record<string, Discussion>; graphqlError?: string; pullRequests?: string[]; restPageSize?: number; restWithout?: ("sub_issues_summary" | "issue_dependencies_summary")[] };
export type CommandResult = { stdout: string; stderr: string; code: number };

export function issueNode(repository: string, number: number, fields: Partial<IssueNode> = {}): IssueNode {
  return { number, title: `Ticket ${number}`, state: "OPEN", repository, assignees: [], labels: ["wayfinder:task"], blockedBy: [], childCount: fields.children?.length ?? 0, children: [], ...fields };
}

export function fixtureFetchers(fixture: GitHubFixture): { fetchIssue: FetchIssue; fetchDiscussion: FetchDiscussion } {
  const issue = (owner: string, repo: string, number: number) => fixture.issues.find((node) => node.repository === `${owner}/${repo}` && node.number === number);
  return {
    fetchIssue: async (owner, repo, number) => issue(owner, repo, number) ?? Promise.reject(new Error(`No issue ${owner}/${repo}#${number}`)),
    fetchDiscussion: async (owner, repo, number) => fixture.discussions?.[`${owner}/${repo}#${number}`] ?? { body: "", comments: [] },
  };
}

export async function fakeGitHub(home: string, fixture: GitHubFixture): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  const name = (repository: string, number: number) => `${repository.replace("/", "-")}-${number}.json`;
  const graph = (value: unknown) => JSON.stringify({ data: { repository: { issue: value } } });
  for (const node of fixture.issues) await writeFile(join(bin, `issue-${name(node.repository, node.number)}`), graph(graphIssue(node)));
  for (const [key, value] of Object.entries(fixture.discussions ?? {})) {
    const [repository, number] = key.split("#") as [string, string];
    await writeFile(join(bin, `discussion-${name(repository, Number(number))}`), graph(graphDiscussion(value)));
  }
  await writeRestFixture(bin, fixture);
  if (fixture.graphqlError) await writeFile(join(bin, "graphql-error"), fixture.graphqlError);
  await writeFile(join(bin, "gh"), `#!/bin/sh
dir="$(dirname "$0")"
if [ "$2" != graphql ]; then
  for arg; do
    if [ -n "\${jq_next:-}" ]; then jq=$arg; jq_next=; continue; fi
    case "$arg" in --paginate) paginate=1 ;; --jq) jq_next=1 ;; repos/*) path=$arg ;; esac
  done
  echo "$path" >> "$dir/rest.log"
  base="$dir/rest-$(printf '%s' "$path" | sed 's/[?].*//' | tr / -)"
  if [ -f "$base.page-001.json" ]; then
    case "\${jq:-}" in
      '') form=json ;;
      '.[] | tojson') form=ndjson ;;
      '.[]') form=ndjson; [ -n "\${GH_FORCE_TTY:-}" ] && form=pretty ;;
      *) echo "fake gh: no fake for --jq $jq" >&2; exit 1 ;;
    esac
    for page in "$base".page-*.json; do
      cat "\${page%.json}.$form" || exit 1
      [ -n "\${paginate:-}" ] || break
    done
    exit 0
  fi
  [ -f "$base.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
  case "\${jq:-}" in
    tojson) cat "$base.json"; echo ;;
    '') if [ -n "\${GH_FORCE_TTY:-}" ]; then printf '\\033[1;37m'; cat "$base.json"; printf '\\033[m\\n'; else cat "$base.json"; fi ;;
    *) echo "fake gh: no fake for --jq $jq" >&2; exit 1 ;;
  esac
  exit 0
fi
for arg; do case "$arg" in owner=*) owner=\${arg#owner=} ;; repo=*) repo=\${arg#repo=} ;; number=*) number=\${arg#number=} ;; query=*) printf '%s\\n' "\${arg#query=}" >> "$(dirname "$0")/queries.log"; case "$arg" in *subIssues*) kind=issue ;; esac ;; esac; done
echo "$owner/$repo#$number" >> "$(dirname "$0")/calls.log"
[ -f "$dir/graphql-error" ] && { echo '{"errors":[{"type":"RATE_LIMITED"}]}'; echo "gh: $(cat "$dir/graphql-error")" >&2; exit 1; }
file="$(dirname "$0")/\${kind:-discussion}-$owner-$repo-$number.json"
[ -f "$file" ] || { [ "\${kind:-}" = issue ] && { echo "no issue $owner/$repo#$number" >&2; exit 1; }; echo '{"data":{"repository":{"issue":{"body":"","comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}'; exit 0; }
cat "$file"
`);
  await chmod(join(bin, "gh"), 0o755);
  return bin;
}

export async function runPackCommand(command: string, args: string[], env: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "commands", `${command}.ts`), ...args], { env: { ...Bun.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

export async function hedgeMachine(home: string, settings: Record<string, unknown>, origin?: string): Promise<string> {
  const profile = join(home, "profile");
  const sources = skillSources(join(home, ".local/share/hedge/sources"), await engineSource());
  for (const source of sources) await cachedCheckout(source.dir, source.ref);
  await mkdir(profile, { recursive: true });
  const engine = { repo: "acme/fleet-engine", ref: "main", channel: "track" };
  await writeFile(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine, sources: sources.map((source) => source.ref), packs: ["pull-requests", "orchestration"], plan: "both", settings, workflows: {} }));
  await spawnGit(profile, "init", "-q");
  if (origin) await spawnGit(profile, "remote", "add", "origin", origin);
  await mkdir(join(home, ".config/hedge"), { recursive: true });
  await writeFile(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: profile }));
  return profile;
}

export async function runHedge(args: string[], env: Record<string, string>): Promise<CommandResult> {
  const { HEDGE_SETTINGS, HEDGE_PROFILE_DIR, ...inherited } = Bun.env;
  const child = Bun.spawn(["sh", join(import.meta.dir, "../../../hedge"), ...args], { env: { ...inherited, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

function graphIssue(node: IssueNode): Record<string, unknown> {
  return {
    number: node.number, title: node.title, state: node.state, repository: { nameWithOwner: node.repository },
    assignees: { nodes: node.assignees.map((login) => ({ login })) }, labels: { nodes: node.labels.map((name) => ({ name })) },
    blockedBy: { nodes: node.blockedBy.map(({ repository, ...blocker }) => ({ ...blocker, repository: { nameWithOwner: repository } })) },
    subIssuesSummary: { total: node.childCount }, subIssues: { nodes: node.children.map(graphIssue) },
  };
}

function restIssue(repository: string, number: number, fields: Partial<IssueNode> = {}, body: string | null = null): Record<string, unknown> {
  const node = issueNode(repository, number, { title: "", labels: [], ...fields });
  return {
    number, title: node.title, state: node.state.toLowerCase(), body, repository_url: `https://api.github.com/repos/${repository}`,
    assignees: node.assignees.map((login) => ({ login })), labels: node.labels.map((name) => ({ name })),
    sub_issues_summary: { total: node.childCount, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: { blocked_by: node.blockedBy.filter((blocker) => blocker.state === "OPEN").length, total_blocked_by: node.blockedBy.length, blocking: 0, total_blocking: 0 },
  };
}

async function writeRestFixture(bin: string, fixture: GitHubFixture): Promise<void> {
  const file = (path: string) => join(bin, `rest-${path.replaceAll("/", "-")}.json`);
  const size = fixture.restPageSize ?? 100;
  const list = async (path: string, items: unknown[]) => {
    const pages = Array.from({ length: Math.max(1, Math.ceil(items.length / size)) }, (_, index) => items.slice(index * size, (index + 1) * size));
    for (const [index, page] of pages.entries()) {
      const stem = join(bin, `rest-${path.replaceAll("/", "-")}.page-${String(index + 1).padStart(3, "0")}`);
      await writeFile(`${stem}.json`, JSON.stringify(page));
      await writeFile(`${stem}.ndjson`, page.map((item) => `${JSON.stringify(item)}\n`).join(""));
      await writeFile(`${stem}.pretty`, page.map((item) => `${JSON.stringify(item, null, 2)}\n`).join(""));
    }
  };
  const issue = (...args: Parameters<typeof restIssue>) => {
    const fields = restIssue(...args);
    for (const field of fixture.restWithout ?? []) delete fields[field];
    return fields;
  };
  const write = async (node: IssueNode) => {
    const path = `repos/${node.repository}/issues/${node.number}`;
    const discussion = fixture.discussions?.[`${node.repository}#${node.number}`];
    const comments = (discussion?.comments ?? []).map((comment) => ({ user: { login: comment.author }, body: comment.body, html_url: comment.url, created_at: comment.createdAt, updated_at: comment.updatedAt }));
    await writeFile(file(path), JSON.stringify(issue(node.repository, node.number, node, discussion?.body ?? null)));
    const newestBlockerFirst = [...node.blockedBy].reverse();
    await list(`${path}/sub_issues`, node.children.map((child) => issue(child.repository, child.number, child)));
    await list(`${path}/dependencies/blocked_by`, newestBlockerFirst.map((blocker) => issue(blocker.repository, blocker.number, { state: blocker.state })));
    await list(`${path}/comments`, comments);
  };
  for (const key of fixture.pullRequests ?? []) {
    const [repository, number] = key.split("#") as [string, string];
    const path = `repos/${repository}/issues/${number}`;
    await writeFile(file(path), JSON.stringify({ ...restIssue(repository, Number(number)), pull_request: { url: `https://api.github.com/${path.replace("issues", "pulls")}` } }));
    await list(`${path}/sub_issues`, []);
    await list(`${path}/comments`, []);
  }
  const nested = (node: IssueNode): IssueNode[] => node.children.flatMap((child) => [child, ...nested(child)]);
  for (const node of fixture.issues.flatMap(nested)) await write(node);
  for (const node of fixture.issues) await write(node);
}

function graphDiscussion(value: Discussion): Record<string, unknown> {
  return { body: value.body, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: value.comments.map(({ author, ...rest }) => ({ author: { login: author }, ...rest })) } };
}
