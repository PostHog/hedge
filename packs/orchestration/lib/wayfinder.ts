export type Blocker = { number: number; state: string; repository: string };
export type IssueNode = {
  number: number; title: string; state: string; repository: string;
  assignees: string[]; labels: string[]; blockedBy: Blocker[]; childCount: number; children: IssueNode[];
};
export type Ticket = IssueNode & { parent?: number };
export type MapRef = { owner: string; repo: string; number: number };
export type Comment = { author: string; body: string; url: string; createdAt: string; updatedAt?: string };
export type Discussion = { body: string; comments: Comment[] };
export type FetchIssue = (owner: string, repo: string, number: number) => Promise<IssueNode>;
export type FetchDiscussion = (owner: string, repo: string, number: number) => Promise<Discussion>;

export type Tracker = () => string;
export type MapIo = { print(line: string): void; tracker: Tracker; fetchIssue?: FetchIssue; fetchDiscussion?: FetchDiscussion };

export const parked = "wayfinder:awaiting-human";
export const trackerSetting = "orchestration.tracker";
const fenceOpener = /^(\s*)(`{3,}(?=[^`]*$)|~{3,})/;
const fenceCloser = /^(\s*)(`{3,}|~{3,})\s*$/;
type Fence = { indent: number; marker: string };

export function mapRef(value: string, usage: string, tracker: Tracker = () => ""): MapRef {
  const bare = value.match(/^#?(\d+)$/);
  if (bare) return { ...trackerRepository(tracker()), number: Number(bare[1]) };
  const match = value.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/) ?? value.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) throw new Error(usage);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

function trackerRepository(tracker: string): { owner: string; repo: string } {
  if (!tracker) throw new Error(`Set ${trackerSetting} to the owner/repo that holds your maps, or name the map as owner/repo#number.`);
  const match = tracker.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`${trackerSetting} is ${tracker}, not an owner/repo.`);
  return { owner: match[1]!, repo: match[2]! };
}

export function proseLines(text: string): string[] {
  let open: Fence | undefined;
  return text.split("\n").filter((line) => {
    if (open) {
      if (closesFence(line, open)) open = undefined;
      return false;
    }
    const opener = line.match(fenceOpener);
    open = opener ? { indent: opener[1]!.length, marker: opener[2]! } : undefined;
    return !open;
  });
}

function closesFence(line: string, open: Fence): boolean {
  const closer = line.match(fenceCloser);
  if (!closer || closer[1]!.length > open.indent + 3) return false;
  const marker = closer[2]!;
  return marker[0] === open.marker[0] && marker.length >= open.marker.length;
}

export function tableCell(text: string): string {
  return text.replace(/(?<!\\)\|/g, "\\|");
}

export function issueLink({ owner, repo, number }: MapRef): string {
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}

export async function descendants(issue: IssueNode, fetchIssue: FetchIssue, parent?: number): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  for (const child of issue.children) {
    tickets.push({ ...child, parent });
    if (!child.childCount) continue;
    const [owner, repo] = splitRepository(child.repository);
    tickets.push(...await descendants(await fetchIssue(owner, repo, child.number), fetchIssue, child.number));
  }
  return tickets;
}

export function ticketType(ticket: Ticket): string | undefined {
  return ticket.labels.find((label) => label.startsWith("wayfinder:") && label !== parked && label !== "wayfinder:map")?.slice("wayfinder:".length);
}

export function splitRepository(repository: string): [string, string] {
  return repository.split("/") as [string, string];
}

const fields = "number title state repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }";
const issueQuery = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { ${fields} subIssues(first: 100) { nodes { ${fields} subIssuesSummary { total } } } } } }`;
const discussionQuery = "query($owner: String!, $repo: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $repo) { issue(number: $number) { body comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { author { login } body url createdAt updatedAt } } } } }";

type GraphIssue = {
  number: number; title: string; state: string; repository: { nameWithOwner: string };
  assignees: { nodes: { login: string }[] }; labels: { nodes: { name: string }[] };
  blockedBy: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] };
  subIssuesSummary?: { total: number }; subIssues?: { nodes: GraphIssue[] };
};
type GraphDiscussion = {
  body: string;
  comments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { author: { login: string } | null; body: string; url: string; createdAt: string; updatedAt: string }[] };
};

function byIssue(left: Blocker, right: Blocker): number {
  return left.number - right.number || left.repository.localeCompare(right.repository);
}

function issueNode(issue: GraphIssue): IssueNode {
  return {
    number: issue.number, title: issue.title, state: issue.state, repository: issue.repository.nameWithOwner,
    assignees: issue.assignees.nodes.map((node) => node.login), labels: issue.labels.nodes.map((node) => node.name),
    blockedBy: issue.blockedBy.nodes.map((node) => ({ number: node.number, state: node.state, repository: node.repository.nameWithOwner })).sort(byIssue),
    childCount: issue.subIssuesSummary?.total ?? issue.subIssues?.nodes.length ?? 0,
    children: issue.subIssues?.nodes.map(issueNode) ?? [],
  };
}

function discussion(pages: GraphDiscussion[]): Discussion {
  return {
    body: pages[0]?.body ?? "",
    comments: pages.flatMap((page) => page.comments.nodes).map((node) => ({ author: node.author?.login ?? "", body: node.body, url: node.url, createdAt: node.createdAt, updatedAt: node.updatedAt })),
  };
}

async function discussionPages(owner: string, repo: string, number: number): Promise<GraphDiscussion[]> {
  const pages: GraphDiscussion[] = [];
  let cursor: string | null = null;
  do {
    const page: GraphDiscussion = await queryIssue<GraphDiscussion>(discussionQuery, owner, repo, number, cursor);
    pages.push(page);
    cursor = page.comments.pageInfo.hasNextPage ? page.comments.pageInfo.endCursor : null;
  } while (cursor);
  return pages;
}

async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`gh ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function queryIssue<T>(query: string, owner: string, repo: string, number: number, cursor?: string | null): Promise<T> {
  const after = cursor ? ["-f", `cursor=${cursor}`] : [];
  const response = JSON.parse(await gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`, ...after]));
  const issue = response.data?.repository?.issue as T | undefined;
  if (!issue) throw new Error(`No issue ${owner}/${repo}#${number}`);
  return issue;
}

type RestIssue = {
  number: number; title: string; state: string; body: string | null; repository_url: string;
  assignees: { login: string }[]; labels: { name: string }[];
  sub_issues_summary?: { total: number }; issue_dependencies_summary?: { total_blocked_by: number }; pull_request?: unknown;
};
type RestComment = { user: { login: string } | null; body: string; html_url: string; created_at: string; updated_at: string };

async function restGetIssue(owner: string, repo: string, number: number): Promise<RestIssue> {
  const issue: RestIssue = JSON.parse(await gh(["api", `repos/${owner}/${repo}/issues/${number}`]));
  if (issue.pull_request) throw new Error(`No issue ${owner}/${repo}#${number}`);
  return issue;
}

async function restList<T>(path: string): Promise<T[]> {
  const lines = await gh(["api", "--paginate", "--jq", ".[] | tojson", `${path}?per_page=100`]);
  return lines.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function restRepository(issue: RestIssue): string {
  return issue.repository_url.split("/").slice(-2).join("/");
}

async function restNode(issue: RestIssue, children?: RestIssue[]): Promise<IssueNode> {
  const path = `repos/${restRepository(issue)}/issues/${issue.number}`;
  const blockers = issue.issue_dependencies_summary?.total_blocked_by === 0 ? [] : await restList<RestIssue>(`${path}/dependencies/blocked_by`);
  const childCount = children?.length ?? issue.sub_issues_summary?.total ?? (await restList<RestIssue>(`${path}/sub_issues`)).length;
  const nodes: IssueNode[] = [];
  for (const child of children ?? []) nodes.push(await restNode(child));
  return {
    number: issue.number, title: issue.title, state: issue.state.toUpperCase(), repository: restRepository(issue),
    assignees: issue.assignees.map((user) => user.login), labels: issue.labels.map((label) => label.name),
    blockedBy: blockers.map((blocker) => ({ number: blocker.number, state: blocker.state.toUpperCase(), repository: restRepository(blocker) })).sort(byIssue),
    childCount,
    children: nodes,
  };
}

async function restIssue(owner: string, repo: string, number: number): Promise<IssueNode> {
  const issue = await restGetIssue(owner, repo, number);
  return restNode(issue, await restList<RestIssue>(`repos/${owner}/${repo}/issues/${number}/sub_issues`));
}

async function restDiscussion(owner: string, repo: string, number: number): Promise<Discussion> {
  const issue = await restGetIssue(owner, repo, number);
  const comments = await restList<RestComment>(`repos/${owner}/${repo}/issues/${number}/comments`);
  return {
    body: issue.body ?? "",
    comments: comments.map((comment) => ({ author: comment.user?.login ?? "", body: comment.body, url: comment.html_url, createdAt: comment.created_at, updatedAt: comment.updated_at })),
  };
}

let graphQuotaSpent = false;

async function graphOrRest<T>(graph: () => Promise<T>, rest: () => Promise<T>): Promise<T> {
  if (graphQuotaSpent) return rest();
  try {
    return await graph();
  } catch (error) {
    if (!/API rate limit (already )?exceeded/i.test(String(error))) throw error;
    if (!graphQuotaSpent) console.error("hedge: GitHub's GraphQL rate limit is spent, so this command reads issues over REST.");
    graphQuotaSpent = true;
    return rest();
  }
}

export const fetchIssueFromGitHub: FetchIssue = (owner, repo, number) =>
  graphOrRest(async () => issueNode(await queryIssue<GraphIssue>(issueQuery, owner, repo, number)), () => restIssue(owner, repo, number));
export const fetchDiscussionFromGitHub: FetchDiscussion = (owner, repo, number) =>
  graphOrRest(async () => discussion(await discussionPages(owner, repo, number)), () => restDiscussion(owner, repo, number));
