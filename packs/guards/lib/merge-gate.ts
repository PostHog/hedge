import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fold, gateOverride, sameThread, live, mergeCardChoice, mergeCardCondition, namesHead, namesId, overrideChoice, hubLedger, prRef, standingOrder, standingOrderChoice, standingOrderDate, standingOrderEnd, standingOrderQuestion, type DecisionState, type Env, type LedgerEvent } from "../../pull-requests/lib/decision-ledger.ts";
import { isTextList, lastGateResult, latestGateResult, type GateResult } from "../../pull-requests/lib/proof.ts";
import { decidesAll } from "../../pull-requests/lib/proof-autonomy.ts";
import { normalized } from "../../pull-requests/lib/proof-answers.ts";
import { endpointOf, fieldName, ghGroups, inOrder, parseGh, values, type Gh } from "./gh.ts";
import { githubSlug } from "./git.ts";
import { commandsIn, shellTools, type Command, type Scope } from "./shell-words.ts";

export type MergeTarget = { repository: string; pr: number; via: string };
export type MergeIntent = { targets: MergeTarget[]; exempt?: MergeTarget[]; refusal?: string; unreadOnly?: true };

const enqueueLine = /(?:^|\n)[ \t]*\/trunk[ \t]+merge\b/i;
const mentionsEnqueue = /\/trunk\s+merge\b/i;
const graphqlMerge = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/i;
const restMerge = /\/repos\/[^/\s]+\/[^/\s]+\/pulls\/\d+\/merge\b/i;

const oneShape = "`gh pr comment <number> --repo <owner>/<repo> --body '/trunk merge'`";
export const cliReason = `Hedge blocked this command: an agent enters the Trunk merge queue only with ${oneShape}, which the merge gate checks. Use that form.`;
export const graphqlReason = `Hedge blocked this call: a GraphQL merge, auto-merge, enqueue, or comment that posts \`/trunk merge\` skips the merge gate, and a query read from piped input or an unreadable file, a query built from a shell variable or substitution, or a variable built that way for a mutation that posts a comment or review, may be one. Write the query as literal text and pass run-time values as its variables, such as \`-F n="$n"\`. A mutation that posts a comment or review takes only literal variables, such as a body file by its literal path, \`-F b=@body.md\`, written in a call of its own. Enqueue with ${oneShape}, or merge with \`gh pr merge <number> --repo <owner>/<repo>\`.`;
export const rawReason = `Hedge blocked this command: it merges a PR or posts \`/trunk merge\` straight to the GitHub API, or sends GitHub a payload the merge gate cannot read, which skips the merge gate. Enqueue with ${oneShape}.`;
export const otherEndpointReason = `Hedge blocked this call: it writes \`/trunk merge\` somewhere other than a new PR comment, such as an edited comment or a review. Enqueue with ${oneShape}.`;
export const unreadPayloadReason = "Hedge blocked this call: the merge gate cannot read what it sends, such as a body built from a shell variable or substitution, a file that this command writes before the call, or a path it cannot open, so it cannot tell whether the call posts `/trunk merge`. Give the body as literal text or by its literal file path, and write a file in one call, then send it with a call of its own.";
export const splitStringReason = "Hedge blocked this command: `env -S` runs a command line that the merge gate cannot read. Write the gh, trunk, or curl command out as its own words.";
export const shellAliasReason = "Hedge blocked this command: it runs a gh alias that the merge gate cannot read, a shell alias or one with arguments. Write the gh command out.";
const unreadVia = " (unread body)";
export const unreadBodyNote = "The merge gate could not read the body of this comment, such as a piped body, a body built from a shell variable or substitution, or a file named by a shell variable, so it checks the comment as a `/trunk merge` enqueue. If the comment does not post `/trunk merge`, give the body by its literal file path or as literal text, and it posts without this check.";
const unnamedReason = (what: string) => `Hedge blocked this command: it ${what} without naming the PR, so the merge gate cannot check it. Name the PR by number and repository: ${oneShape}.`;

/** Parses guards.merge-gate-exempt: owner/repo or owner/* entries, separated by commas or spaces. */
export function exemptList(value: unknown): string[] {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error("guards.merge-gate-exempt is not text");
  return typeof value === "string" ? value.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean) : [];
}

export const isExempt = (repository: string, exempt: string[]) => {
  const slug = repository.toLowerCase();
  return exempt.some((entry) => entry === slug || (entry.endsWith("/*") && slug.startsWith(entry.slice(0, -1))));
};

export type IntentIO = {
  readText: (path: string) => string | undefined;
  checkoutRepo: (cwd: string) => string | undefined;
  ghRepo?: string;
  aliases?: () => Record<string, string>;
};

export function ghAliases(config = join(process.env.GH_CONFIG_DIR ?? join(homedir(), ".config/gh"), "config.yml")): Record<string, string> {
  if (!existsSync(config)) return {};
  const aliases: Record<string, string> = {};
  let inside = false;
  for (const line of readFileSync(config, "utf8").split("\n")) {
    if (/^aliases:\s*$/.test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) break;
    const entry = inside ? line.match(/^\s+(?:(['"])(.+?)\1|([^:\s]+)):\s*(.+?)\s*$/) : null;
    if (entry) aliases[entry[2] ?? entry[3]!] = entry[4]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return aliases;
}

/** The repository gh picks in a checkout from its remotes: the one `gh repo set-default` resolved, or the only GitHub remote. More than one without a default is no answer, so the PR must be named with its repository. */
export function ghBaseRepo(remoteConfig: string): string | undefined {
  const remotes = new Map<string, { url?: string; resolved?: string }>();
  for (const line of remoteConfig.split("\n")) {
    const entry = line.match(/^remote\.(.+)\.(url|gh-resolved) (.+)$/);
    if (!entry) continue;
    const remote = remotes.get(entry[1]!) ?? {};
    if (entry[2] === "url") remote.url = entry[3]!.trim(); else remote.resolved = entry[3]!.trim();
    remotes.set(entry[1]!, remote);
  }
  const resolved = [...remotes.values()].find((remote) => remote.resolved);
  if (resolved) return resolved.resolved === "base" ? githubSlug(resolved.url ?? "") : repoSlug.test(resolved.resolved!) ? resolved.resolved : undefined;
  const slugs = new Set([...remotes.values()].flatMap((remote) => githubSlug(remote.url ?? "") ?? []).map((slug) => slug.toLowerCase()));
  return slugs.size === 1 ? [...remotes.values()].map((remote) => githubSlug(remote.url ?? "")).find(Boolean) : undefined;
}

const maxPayload = 1 << 20;

export function readPayload(path: string, afterCheck = () => {}): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > maxPayload) return undefined;
    afterCheck();
    return readFileSync(fd, "utf8");
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export const realIntentIO: IntentIO = {
  readText: (path) => readPayload(path),
  checkoutRepo: (cwd) => {
    const child = Bun.spawnSync(["git", "-C", cwd, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], { stdout: "pipe", stderr: "ignore" });
    return child.exitCode === 0 ? ghBaseRepo(child.stdout.toString()) : undefined;
  },
  ghRepo: process.env.GH_REPO,
  aliases: () => ghAliases(),
};

const prUrl = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)\/?$/i;
const repoSlug = /^[\w.-]+\/[\w.-]+$/;

function namedPr(gh: Gh, found: Command, cwd: string | undefined, io: IntentIO): { repository: string; pr: number } | undefined {
  const target = gh.operands.find((operand) => !operand.startsWith("-"));
  const url = target?.match(prUrl);
  if (url) return { repository: url[1]!, pr: Number(url[2]) };
  if (!target || !/^\d+$/.test(target)) return undefined;
  const repository = repositoryOf(gh, found, cwd, io);
  return repository ? { repository, pr: Number(target) } : undefined;
}

function repositoryOf(gh: Gh, found: Command, cwd: string | undefined, io: IntentIO) {
  const flagged = values(gh, "-R", "--repo").at(-1);
  const named = flagged ?? found.env.get("GH_REPO") ?? io.ghRepo;
  if (named) return repoSlug.test(named) ? named : named.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
  return cwd ? io.checkoutRepo(resolve(cwd, found.chdir ?? ".")) : undefined;
}

const stdinPath = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/(?:self|\d+)\/fd\/\d+)$/;
const home = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const builtAtRunTime = /[$`]/;
const runTimeMark = "\u0000";
const isRunTime = (value: string) => value.endsWith(runTimeMark);
const ghPlaceholder = /\{(?:owner|repo|branch)\}|:(?:owner|repo|branch)\b/;
const unreadByTrunk = /^repos\/[\w.-]+\/[\w.-]+\/(?:pulls\/(?:\d+\/comments(?:\/\d+\/replies)?|comments\/\d+)|stacks)$/;
const graphqlCall = /(?<!\w)(?:(?<=(?:^|\})[\s,]*)(mutation|query|subscription)[\s,]+)?([A-Za-z_]\w*)[\s,]*\(/g;
const postingField = (name: string) => (/^(?:add|update|submit)/.test(name) && /Comment|Review/.test(name)) || /^update(?:PullRequest|Issue)$/.test(name);
const lineEnd = (char: string | undefined) => char === "\n" || char === "\r";

function graphqlCode(query: string): string {
  let code = "";
  let index = 0;
  while (index < query.length) {
    if (query[index] === "#") {
      while (index < query.length && !lineEnd(query[index])) index++;
      code += " ";
    } else if (query.startsWith('"""', index)) {
      index += 3;
      while (index < query.length && !query.startsWith('"""', index)) index += query.startsWith('\\"""', index) ? 4 : 1;
      index += 3;
      code += " ";
    } else if (query[index] === '"') {
      index++;
      while (index < query.length && query[index] !== '"' && !lineEnd(query[index])) index += query[index] === "\\" && !lineEnd(query[index + 1]) ? 2 : 1;
      if (query[index] === '"') index++;
      code += " ";
    } else code += query[index++];
  }
  return code;
}

const postsText = (query: string) => [...graphqlCode(query).matchAll(graphqlCall)].some(([, keyword, name]) => !keyword && postingField(name!));
const readAt = (found: Command, cwd: string | undefined, io: IntentIO, path: string) => io.readText(resolve(cwd ?? ".", found.chdir ?? ".", home(path)));

function sentTexts(found: Command, cwd: string | undefined, io: IntentIO, inline: string[], files: string[], built: boolean) {
  const paths = files.map((path) => stdinPath.test(path) ? "-" : path);
  const piped = paths.includes("-") && !found.stdin;
  const read = paths.map((path) => path === "-" ? found.stdin?.body ?? "" : readAt(found, cwd, io, path));
  const texts = [...inline, ...read.filter((text) => text !== undefined)];
  const runTime = built || found.name === "xargs" || (paths.includes("-") && found.stdin?.expands === true);
  return { texts: [...texts, ...texts.flatMap(jsonStrings)], unread: read.includes(undefined) || runTime, missing: read.includes(undefined), built: runTime, dollar: texts.some((text) => builtAtRunTime.test(text)), piped };
}

function runTimeFields(fields: string[], typed: string[], graphql: boolean, bodyFromInput: boolean, readQuery: (path: string) => string | undefined) {
  const built = fields.filter(isRunTime);
  const key = (field: string) => field.replace(/=.*$/s, "");
  const named = (field: string, name: string) => builtAtRunTime.test(key(field)) || fieldName(key(field)).toLowerCase() === name;
  if (bodyFromInput) return false;
  if (!graphql) return built.some((field) => named(field, "body"));
  const queries = fields.filter((field) => key(field) === "query").map((field) => field.slice("query=".length)).map((query) => query.startsWith("@") ? readQuery(query.slice(1)) : query);
  const filled = typed.some((field) => key(field) === "query" && !field.startsWith("query=@") && ghPlaceholder.test(field));
  const quiet = !filled && queries.length > 0 && queries.every((query) => query !== undefined && !postsText(query));
  return built.some((field) => named(field, "query")) || (built.length > 0 && !quiet);
}

function jsonStrings(text: string): string[] {
  if (!/^\s*[{[]/.test(text)) return [];
  try { return strings(JSON.parse(text)); } catch { return []; }
}

type Sent = { texts: string[]; unread: boolean; missing: boolean; built: boolean; dollar: boolean; piped: boolean };
const readsEnqueue = ({ texts, built, dollar }: Sent, raw: string) => texts.some((text) => enqueueLine.test(text)) || ((built || dollar) && mentionsEnqueue.test(raw));
const sendsEnqueue = (sent: Sent, raw: string) => sent.unread || sent.piped || readsEnqueue(sent, raw);
const elsewhere = (sent: Sent, raw: string): MergeIntent => ({ targets: [], refusal: readsEnqueue(sent, raw) ? otherEndpointReason : unreadPayloadReason });

const readOptions = {
  curl: { flags: "sSiILfvk", valued: "HoAwm", long: ["silent", "show-error", "include", "head", "location", "fail", "verbose", "insecure", "compressed"], longValued: ["header", "output", "user-agent", "write-out", "max-time", "connect-timeout"] },
  wget: { flags: "qvNS", valued: "OoUT", long: ["quiet", "verbose", "no-verbose", "server-response"], longValued: ["header", "output-document", "output-file", "user-agent", "timeout"] },
};
const readMethod = /^(?:GET|HEAD)$/i;

function httpWrites(tool: "curl" | "wget", args: string[]): boolean {
  const { flags, valued, long, longValued } = readOptions[tool];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "-" || (tool === "wget" && arg === "-nv")) continue;
    if (arg.startsWith("--")) {
      const [name = "", value] = arg.slice(2).split(/=(.*)/s);
      if (long.includes(name) && value === undefined) continue;
      if (longValued.includes(name)) { if (value === undefined) index++; continue; }
      if (["request", "method"].includes(name) && readMethod.test(value ?? args[++index] ?? "")) continue;
      return true;
    }
    let at = 1;
    while (at < arg.length && flags.includes(arg[at]!)) at++;
    if (at === arg.length) continue;
    if (valued.includes(arg[at]!)) { if (at === arg.length - 1) index++; continue; }
    if (tool === "curl" && arg[at] === "X" && readMethod.test(arg.slice(at + 1) || args[++index] || "")) continue;
    return true;
  }
  return false;
}

const payloadFiles = (args: string[]) => args.flatMap((arg, index) => {
  const attached = arg.match(/^(?:--data(?:-\w+)?|--json|--form|-F|-d)=?(.+)$/)?.[1] ?? arg.match(/^-T(.+)$/)?.[1];
  const value = /^(?:-d|--data(?:-\w+)?|--json|-F|--form)$/.test(arg) ? args[index + 1] : attached;
  if (/^(?:-T|--upload-file)$/.test(arg)) return args[index + 1] ?? [];
  if (attached !== undefined && arg.startsWith("-T")) return attached;
  return value?.match(/^(?:[^=@]*=)?[@<](.+)$/)?.[1] ?? [];
});

function ghArguments({ name, args }: Command) {
  if (name === "gh") return args;
  return name === "xargs" && args.includes("gh") ? args.slice(args.indexOf("gh") + 1) : undefined;
}

function expandAlias(args: string[], io: IntentIO): string[] | undefined {
  const [first = "", ...rest] = args;
  const aliases = io.aliases?.() ?? {};
  const said = `${args.join(" ")} `;
  if (Object.keys(aliases).some((name) => /\s/.test(name) && said.startsWith(`${name.trim().split(/\s+/).join(" ")} `))) return undefined;
  if (ghGroups.has(first) || first.startsWith("-")) return args;
  const alias = aliases[first];
  if (alias === undefined) return args;
  if (alias.startsWith("!") || /\$\d|\$@|['"\\]/.test(alias)) return undefined;
  return [...alias.split(/\s+/).filter(Boolean), ...rest];
}

function commandIntent(found: Command, raw: string, cwd: string | undefined, io: IntentIO): MergeIntent {
  const name = basename(found.name);
  if (name === "trunk" && found.args.includes("merge")) return { targets: [], refusal: cliReason };
  if (["curl", "wget", "http", "https", "xh"].includes(name)) {
    const payloads = payloadFiles(found.args).map((path) => path === "-" ? found.stdin?.body : io.readText(resolve(cwd ?? ".", found.chdir ?? ".", path)));
    const sent = [...found.args, found.stdin?.body ?? "", ...payloads.filter((text) => text !== undefined)].join("\n");
    const writes = name === "curl" || name === "wget" ? httpWrites(name, found.args) : true;
    const opaque = payloads.includes(undefined) && /github/i.test(raw);
    return writes && (opaque || mentionsEnqueue.test(sent) || graphqlMerge.test(sent) || restMerge.test(sent)) ? { targets: [], refusal: rawReason } : { targets: [] };
  }
  const written = ghArguments(found);
  if (!written) return { targets: [] };
  const args = expandAlias(written, io);
  if (!args) return { targets: [], refusal: shellAliasReason };
  const gh = parseGh(inOrder(args));
  const offset = found.args.length - written.length;
  const marked = parseGh(inOrder(expandAlias(written.map((arg, index) => found.argExpands[offset + index] ? `${arg}${runTimeMark}` : arg), io) ?? []));
  const builtBody = () => values(marked, "-b", "--body", "-F", "--body-file").some(isRunTime);
  if ((gh.group === "pr" || gh.group === "issue") && gh.action === "comment") {
    const sent = sentTexts(found, cwd, io, values(gh, "-b", "--body"), values(gh, "-F", "--body-file"), builtBody());
    if (!sendsEnqueue(sent, raw)) return { targets: [] };
    const named = namedPr(gh, found, cwd, io);
    const reads = readsEnqueue(sent, raw);
    const unread = reads ? {} : { unreadOnly: true as const };
    if (!named) return { targets: [], refusal: unnamedReason(reads ? "posts `/trunk merge`" : "posts a comment"), ...unread };
    return { targets: [{ ...named, via: `gh ${gh.group} comment${reads ? "" : unreadVia}` }], ...unread };
  }
  if (gh.group === "pr" && gh.action === "review") {
    const sent = sentTexts(found, cwd, io, values(gh, "-b", "--body"), values(gh, "-F", "--body-file"), builtBody());
    return sendsEnqueue(sent, raw) ? elsewhere(sent, raw) : { targets: [] };
  }
  if (gh.group === "pr" && gh.action === "merge") {
    if (values(gh, "--disable-auto").some((value) => /^(?:|1|t|true)$/i.test(value))) return { targets: [] };
    const named = namedPr(gh, found, cwd, io);
    return named ? { targets: [{ ...named, via: "gh pr merge" }] } : { targets: [], refusal: unnamedReason("merges a PR") };
  }
  if (gh.group !== "api") return { targets: [] };
  const fields = values(gh, "-f", "--raw-field", "-F", "--field");
  const inline = [...fields, ...fields.map((field) => field.replace(/^[^=]*=/, ""))];
  const fieldFiles = values(gh, "-F", "--field").flatMap((field) => field.match(/^[^=]*=@(.+)$/s)?.[1] ?? []);
  let endpoint = endpointOf(gh).replace(/[?#].*$/s, "").replace(/\/$/, "");
  const sent = sentTexts(found, cwd, io, inline, values(gh, "--input").length > 0 ? values(gh, "--input") : fieldFiles, values(marked, "--input").some(isRunTime) || runTimeFields(values(marked, "-f", "--raw-field", "-F", "--field"), values(marked, "-F", "--field"), endpoint === "graphql", values(gh, "--input").length > 0, (path) => stdinPath.test(path) ? found.stdin?.body : readAt(found, cwd, io, path)));
  if (endpoint === "graphql") return sent.piped || sent.unread || sent.texts.some((text) => mentionsEnqueue.test(text) || graphqlMerge.test(text)) || mentionsEnqueue.test(raw) ? { targets: [], refusal: graphqlReason } : { targets: [] };
  if (/\{owner\}|\{repo\}|:owner|:repo/.test(endpoint)) {
    const [owner, repo] = (repositoryOf(gh, found, cwd, io) ?? "/").split("/");
    endpoint = endpoint.replace(/\{owner\}|:owner/, owner ?? "").replace(/\{repo\}|:repo/, repo ?? "");
  }
  const method = (values(gh, "-X", "--method").at(-1) ?? (fields.length || values(gh, "--input").length ? "POST" : "GET")).toUpperCase();
  if (method === "GET" && found.name !== "xargs") return { targets: [] };
  const opaque = !unreadByTrunk.test(endpoint) || isRunTime(endpointOf(marked)) || found.name === "xargs";
  const scoped = opaque ? sent : { ...sent, unread: sent.missing, built: false, piped: false };
  const comment = endpoint.match(/^repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/comments$/);
  const posted = (reads: boolean): MergeIntent => ({ targets: [{ repository: comment![1]!, pr: Number(comment![2]), via: `gh api issues/<n>/comments${reads ? "" : unreadVia}` }], ...reads ? {} : { unreadOnly: true as const } });
  if (comment && method === "POST" && sent.piped) return posted(false);
  const merge = endpoint.match(/^repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/merge$/);
  if (merge) return { targets: [{ repository: merge[1]!, pr: Number(merge[2]), via: "gh api pulls/<n>/merge" }] };
  if (!sendsEnqueue({ ...scoped, piped: false }, raw)) return { targets: [] };
  if (comment && method === "POST") return posted(readsEnqueue(scoped, raw));
  return elsewhere(scoped, raw);
}

function strings(value: unknown): string[] {
  const found: string[] = [];
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string") found.push(next);
    else if (next && typeof next === "object") for (const inner of Object.values(next)) pending.push(inner);
  }
  return found;
}

const reads = /(?:^|_|__)(?:get|list|search|read|fetch)(?:_|$)/i;
const repositoryKeys = ["repository_full_name", "repo_full_name", "full_name", "repository", "nameWithOwner"];
const numberKeys = ["pull_number", "pullNumber", "pr_number", "prNumber", "issue_number", "issueNumber", "number"];

function mcpPr(input: Record<string, unknown>): { repository: string; pr: number } | undefined {
  const full = repositoryKeys.map((key) => input[key]).find((value): value is string => typeof value === "string" && repoSlug.test(value));
  const repository = full ?? (typeof input.owner === "string" && typeof input.repo === "string" ? `${input.owner}/${input.repo}` : undefined);
  const number = numberKeys.map((key) => input[key]).find((value) => /^\d+$/.test(String(value ?? "")));
  return repository && repoSlug.test(repository) && number !== undefined ? { repository, pr: Number(number) } : undefined;
}

const t3Tool = /^mcp__t3[-_]code__/;

function t3Pr(input: Record<string, unknown>): { repository: string; pr: number } | undefined {
  const { repository, number } = input;
  return typeof repository === "string" && repoSlug.test(repository) && Number.isSafeInteger(number) && Number(number) > 0 ? { repository, pr: Number(number) } : undefined;
}

const trimmed = (value: unknown) => typeof value === "string" ? [value.trim()] : [];

function t3Posts(name: string, input: Record<string, unknown>): string[] {
  if (name === "pull_request_respond") return trimmed(input.body);
  if (name !== "pull_request_review") return [];
  const comments = Array.isArray(input.comments) ? input.comments as unknown[] : [];
  return [...typeof input.body === "string" ? [input.body] : [], ...comments.flatMap((comment) => trimmed((comment as { body?: unknown } | null)?.body))];
}

function mcpIntent(tool: string, input: Record<string, unknown>): MergeIntent {
  const name = tool.replace(/^mcp__.*?__/, "");
  if (reads.test(name)) return { targets: [] };
  const merges = /merge/i.test(name) && !/disable|update_pull_request_branch/i.test(name);
  const t3 = t3Tool.test(tool);
  const writesComment = t3 || /comment|review/i.test(name);
  const sent = () => t3 ? t3Posts(name, input) : strings(input);
  if (!merges && !(writesComment && sent().some((text) => enqueueLine.test(text)))) return { targets: [] };
  if (!merges && (/review/i.test(name) || input.reviewThreadId != null)) return { targets: [], refusal: otherEndpointReason };
  const named = t3 ? t3Pr(input) : mcpPr(input);
  return named ? { targets: [{ ...named, via: merges ? tool : `${tool} comment` }] } : { targets: [], refusal: unnamedReason(merges ? "merges a PR" : "posts `/trunk merge`") };
}

export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

/** What a tool call would enqueue in the Trunk merge queue or merge; targets in exempt repositories skip the gate pass and keep only the hold on gaps an agent accepted. */
export function mergeIntent(call: ToolCall, command: string, exempt: string[], io: IntentIO = realIntentIO): MergeIntent {
  const tool = call.tool_name ?? "";
  let intent: MergeIntent = { targets: [] };
  if (shellTools.has(tool)) {
    if (!command) return intent;
    if (/(?:^|[\s;&|(/])env\b[^\n;&|]*\s(?:-[a-zA-Z]*S|--split-string)/.test(command) && /\b(?:gh|trunk|curl|wget)\b/.test(command)) return { targets: [], refusal: splitStringReason };
    let commands: Command[];
    try { commands = commandsIn(command); }
    catch { return mentionsEnqueue.test(command) || graphqlMerge.test(command) || restMerge.test(command) ? { targets: [], refusal: rawReason } : intent; }
    const dirs = new Map<Scope, string[]>();
    const cwdIn = (scope: Scope | undefined): string | undefined => scope === undefined ? call.cwd : dirs.get(scope)?.at(-1) ?? cwdIn(scope.parent);
    let parts = 0;
    let unreadParts = 0;
    for (const found of commands) {
      const name = basename(found.name);
      if (name === "cd" || name === "pushd" || name === "popd") {
        const stack = dirs.get(found.scope) ?? [cwdIn(found.scope) ?? "."];
        const to = found.args.find((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
        if (name === "popd") { if (stack.length > 1) stack.pop(); }
        else if (name === "pushd") stack.push(resolve(stack.at(-1)!, home(to ?? "~")));
        else stack.splice(-1, 1, resolve(stack.at(-1)!, home(to ?? "~")));
        dirs.set(found.scope, stack);
        continue;
      }
      const one = commandIntent(found, command, cwdIn(found.scope), io);
      if (one.targets.length || one.refusal) { parts++; if (one.unreadOnly) unreadParts++; }
      intent = { targets: [...intent.targets, ...one.targets], refusal: intent.refusal ?? one.refusal };
    }
    if (parts > 0 && parts === unreadParts) intent.unreadOnly = true;
  } else if (/github/i.test(tool) || t3Tool.test(tool)) intent = mcpIntent(tool, call.tool_input ?? {});
  const skipping = intent.targets.filter((target) => isExempt(target.repository, exempt));
  return { ...intent, targets: intent.targets.filter((target) => !skipping.includes(target)), ...skipping.length ? { exempt: skipping } : {} };
}

export type Pull = { head: string; base: string; defaultBranch: string; open: boolean };
export type GateIO = {
  pull: (repository: string, pr: number) => Promise<Pull | undefined>;
  pullFor: (repository: string, branch: string) => Promise<number | undefined>;
  isIssue: (repository: string, number: number) => Promise<boolean>;
  localGate: (repository: string, pr: number, commit: string) => Promise<GateResult | undefined>;
  ledger: () => Promise<LedgerEvent[]>;
  decidesAll?: () => boolean;
  thread?: string;
  now?: () => number;
};

type Layer = { repository: string; pr: number; head: string };
const stackDepth = 12;

async function layersOf(target: MergeTarget, io: GateIO): Promise<Layer[]> {
  const layers: Layer[] = [];
  const seen = new Set<number>();
  let pr: number | undefined = target.pr;
  while (pr !== undefined) {
    if (seen.has(pr)) throw new Error(`the stack below ${target.repository}#${target.pr} loops back to #${pr}`);
    if (seen.size === stackDepth) throw new Error(`the stack below ${target.repository}#${target.pr} is deeper than ${stackDepth} PRs`);
    seen.add(pr);
    const pull = await io.pull(target.repository, pr);
    if (!pull) {
      if (seen.size === 1 && target.via.includes("comment") && await io.isIssue(target.repository, pr)) return [];
      throw new Error(`cannot read ${target.repository}#${pr} on GitHub`);
    }
    if (pull.open) layers.push({ repository: target.repository, pr, head: pull.head });
    pr = pull.base === pull.defaultBranch ? undefined : await io.pullFor(target.repository, pull.base);
  }
  return layers;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function sharedResults(events: LedgerEvent[], layer: Layer): GateResult[] {
  return events.flatMap((event) => event.type === "gate" && sameRepo(event.repository, layer.repository) && event.pr === layer.pr && event.commit === layer.head
    ? [{ passed: event.passed, at: Date.parse(event.at), ...event.onEnd === true ? { onEnd: true as const } : {}, ...isTextList(event.agentGaps) ? { agentGaps: event.agentGaps } : {}, ...isTextList(event.seenGaps) ? { seenGaps: event.seenGaps } : {} }] : []);
}

function latestPassed(results: GateResult[], decidesAllNow: boolean) {
  const latest = latestGateResult(results);
  return latest?.passed === true && (!latest.onEnd || decidesAllNow);
}

const namesLayer = (decision: DecisionState, layer: Layer) => decision.scope.prs.some((ref) => sameRepo(ref.replace(/#\d+$/, ""), layer.repository) && ref.endsWith(`#${layer.pr}`));
const usersMergeAt = (decision: DecisionState, layer: Layer) => live(decision) && decision.class === "merge" && decision.mark === "👤" && namesLayer(decision, layer);
const overrideAt = (decision: DecisionState, layer: Layer) => usersMergeAt(decision, layer) && decision.scope.kinds?.includes(gateOverride) === true && decision.scope.condition?.startsWith(`${layer.head}:`) === true;
const chosen = (answer: string) => normalized(answer.replace(/^\d{4}-\d{2}-\d{2}\s+/, ""));
const choseMerge = (decision: DecisionState, head: string) => namesHead(decision.question, head) && [mergeCardChoice, `${mergeCardChoice} (Recommended)`].map(normalized).includes(chosen(decision.answer));
const askedIn = (decision: DecisionState, thread: string | undefined) => thread === undefined || sameThread(decision.where.thread, thread);
const mergeCardAt = (decision: DecisionState, layer: Layer) => usersMergeAt(decision, layer) && decision.scope.condition === mergeCardCondition(layer.head) && choseMerge(decision, layer.head);
const mergeWordAt = (decision: DecisionState, layer: Layer, thread: string | undefined) => overrideAt(decision, layer) || (mergeCardAt(decision, layer) && askedIn(decision, thread));

function overrideIn(decisions: DecisionState[], layer: Layer): boolean {
  return decisions.some((decision) => overrideAt(decision, layer));
}

const agentGap = (decision: DecisionState) => live(decision) && decision.mark === "🤖" && decision.class === "proof-gap" && decision.effect !== "keep-owed";
const inRepository = (decision: DecisionState, repository: string) => decision.scope.prs.some((ref) => sameRepo(prRef(ref).repository, repository));

function agentGapsAt(results: GateResult[], decisions: DecisionState[], layer: Layer): string[] {
  const latest = latestGateResult(results);
  const counted = latest?.passed && latest.agentGaps ? latest : undefined;
  const unseen = decisions.filter((decision) => agentGap(decision) && namesLayer(decision, layer) && !counted?.seenGaps?.includes(decision.id));
  return [...new Set([...counted?.agentGaps ?? [], ...unseen.map((decision) => decision.id)])];
}

const kindsOf = (decisions: DecisionState[], id: string) => decisions.find((decision) => decision.id === id)?.scope.kinds ?? [];
const heldName = (decisions: DecisionState[], id: string) => kindsOf(decisions, id).length ? `${id} for ${kindsOf(decisions, id).join("/")}` : id;
const cardNames = (decisions: DecisionState[], id: string, question: string) => namesId(question, heldName(decisions, id));

const heldGaps = (results: GateResult[], decisions: DecisionState[], layer: Layer, thread: string | undefined) => decisions.some((decision) => overrideAt(decision, layer)) ? []
  : agentGapsAt(results, decisions, layer).filter((id) => !decisions.some((decision) => mergeWordAt(decision, layer, thread) && cardNames(decisions, id, decision.question)));

const isOrder = (decision: DecisionState) => decision.class === "merge" && (decision.reversed?.mark ?? decision.mark) === "👤" && decision.scope.kinds?.includes(standingOrder) === true
  && [standingOrderChoice, `${standingOrderChoice} (Recommended)`].map(normalized).includes(chosen(decision.reversed?.answer ?? decision.answer))
  && decision.scope.prs.length === 1 && normalized(decision.question) === normalized(standingOrderQuestion(decision.scope.prs[0]!, standingOrderDate(decision.scope.condition)));
const inThread = (decision: DecisionState, thread: string | undefined) => thread !== undefined && sameThread(decision.where.thread, thread);
const runs = (decision: DecisionState, now: number) => live(decision) && now < standingOrderEnd(decision.scope.condition);
const orderCovers = (decision: DecisionState, thread: string | undefined, now: number) => isOrder(decision) && runs(decision, now) && inThread(decision, thread);
const orderName = (order: DecisionState) => `${order.id} of ${order.at.slice(0, 10)}`;

function uncoveredWhy(decisions: DecisionState[], thread: string | undefined, now: number) {
  const orders = decisions.filter(isOrder);
  const here = orders.filter((order) => inThread(order, thread));
  const order = (here.length ? here : orders.filter((one) => runs(one, now))).at(-1);
  if (!order) return "";
  if (order.reversed) return ` The standing order ${orderName(order)} was withdrawn on ${order.reversed.at.slice(0, 10)}.`;
  if (order.voided) return ` The standing order ${orderName(order)} ended on ${order.voided.at.slice(0, 10)}: ${order.voided.reason}.`;
  if (!here.length) return ` The standing order ${orderName(order)} covers only merges from T3 thread ${order.where.thread}, and this merge runs ${thread === undefined ? "outside a T3 thread" : `in thread ${thread}`}.`;
  return Number.isNaN(standingOrderEnd(order.scope.condition)) ? ` The standing order ${orderName(order)} names no end date Hedge can read (${order.scope.condition}).`
    : ` The standing order ${orderName(order)} ran ${order.scope.condition} and has ended.`;
}

const heldLayer = (decisions: DecisionState[], layer: Layer, gaps: string[]) => gaps.length ? [`${layer.repository}#${layer.pr} at ${layer.head.slice(0, 12)} (🤖 ${gaps.map((id) => heldName(decisions, id)).join(", ")})`] : [];


const gateCommand = ({ repository, pr, head }: Layer) => `hedge proof gate --repo ${repository} --pr ${pr} --commit ${head}`;
const overrideHint = (person: string) => `For an incident fix that cannot wait for the gate, ask ${person} with the question tool, naming the PR and its full head sha, with the options "${overrideChoice}" and "Keep the gate closed", and record the answer `
  + `with \`hedge decision record --mark 👤 --class merge --kind ${gateOverride} --pr <owner/repo#n> --condition '<full head sha>: <incident and why>'\`.`;

const heldReason = (held: string[], person: string) => `Hedge blocked this merge: an agent accepted proof gaps of ${held.join("; ")} itself, so it merges only on ${person}'s word for that head, or under a standing order they chose on a question card in this T3 thread, whatever else lets it merge: own tooling, a standing merge grant, or full send. `
  + `Show it on a merge card: ask ${person} with the question tool, naming the PR, its full head sha, and each held decision as this message names it, such as \`d-1a2b3c4d for live-run/prod-shape\`, with the options "${mergeCardChoice}" and "Keep it open". When they choose "${mergeCardChoice}", record the answer with \`hedge decision record --mark 👤 --class merge --pr <owner/repo#n> --condition '<full 40-character head sha>: merge card'\`, then merge again. The answer lifts only the decisions its question named that way, only in the T3 thread that asked it, and a push leaves it behind; a gate pass at the new head that saw no such gap lifts the hold.`;

const unreadReason = (repositories: string[]) => `Hedge blocked this merge: the decision ledger could not be read, so the merge gate cannot tell whether an agent accepted a proof gap in ${repositories.join(", ")} itself, and such a gap holds a merge until the person's word. Try again when the hub answers.`;

/** Why the call may not go out, or undefined when every open layer of every target passed the gate at its head and none holds a gap an agent accepted without the person's merge word. */
export async function mergeGateRisk(intent: MergeIntent, io: GateIO, person: string): Promise<string | undefined> {
  if (intent.refusal) return intent.refusal;
  let events: LedgerEvent[] | undefined;
  let decisions: DecisionState[] = [];
  let hubError: string | undefined;
  const missing: string[] = [];
  const held: string[] = [];
  const now = () => io.now?.() ?? Date.now();
  const order = () => decisions.find((decision) => orderCovers(decision, io.thread, now()));
  const hold = (results: GateResult[], layer: Layer) => held.push(...heldLayer(decisions, layer, heldGaps(results, decisions, layer, io.thread)));
  const readLedger = async () => {
    if (events !== undefined || hubError !== undefined) return;
    try { events = await io.ledger(); decisions = fold(events); } catch (error) { hubError = (error as Error).message; }
  };
  const resultsAt = async (layer: Layer) => {
    const local = await io.localGate(layer.repository, layer.pr, layer.head);
    return [...local ? [local] : [], ...events ? sharedResults(events, layer) : []];
  };
  try {
    for (const target of intent.targets) {
      for (const layer of await layersOf(target, io)) {
        await readLedger();
        const results = await resultsAt(layer);
        if (overrideIn(decisions, layer) || latestPassed(results, io.decidesAll?.() ?? false)) { hold(results, layer); continue; }
        const top = layer.pr === target.pr ? "" : ` (a lower layer of ${target.repository}#${target.pr})`;
        missing.push(`${layer.repository}#${layer.pr}${top} at ${layer.head.slice(0, 12)}: run \`${gateCommand(layer)}\``);
      }
    }
    for (const target of intent.exempt ?? []) {
      await readLedger();
      if (hubError !== undefined) return unreadReason([...new Set((intent.exempt ?? []).map((one) => one.repository))]);
      if (!decisions.some((decision) => agentGap(decision) && inRepository(decision, target.repository))) continue;
      for (const layer of await layersOf(target, io)) hold(await resultsAt(layer), layer);
    }
  } catch (error) {
    return `Hedge blocked this merge: the merge gate could not check it (${(error as Error).message}). A merge needs a \`hedge proof gate\` pass at each PR's head on GitHub; try again when GitHub answers.`;
  }
  if (!missing.length && hubError !== undefined) return unreadReason([...new Set(intent.targets.map((target) => target.repository))]);
  if (!missing.length) return held.length && !order() ? heldReason(held, person) + uncoveredWhy(decisions, io.thread, now()) : undefined;
  const hub = hubError ? ` The decision ledger could not be read (${hubError}), so only this machine's gate records counted.` : "";
  const covering = order();
  const ordered = covering ? ` ${person}'s standing order ${orderName(covering)} is their merge word for gaps an agent accepted, never for a missing gate pass.` : "";
  return `Hedge blocked this merge: \`hedge proof gate\` has not passed at the head of ${missing.join("; ")}. A missing proof store, a pass at an older head, or a pass that a later failed run at the same head replaced does not count, nor a pass from while pull-requests.autonomy was end once it is ask again.${hub}${ordered} `
    + `Run the gate on each head until it exits 0, then enqueue again. ${overrideHint(person)}`;
}

export const unreadBody = (intent: MergeIntent) => intent.unreadOnly === true;

export const mergeGateDeadlineMs = 15_000;
const after = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms).unref(); });
const deadlineReason = "Hedge blocked this merge: the merge gate could not read GitHub and the decision ledger in time. Try again; a merge needs a `hedge proof gate` pass at each PR's head.";

/** The check's answer, or a refusal when it fails or runs past the deadline: the hook must answer before its host's timeout lets the call through. */
export async function beforeDeadline(check: () => Promise<string | undefined>, deadline: Promise<void> = after(mergeGateDeadlineMs)): Promise<string | undefined> {
  try { return await Promise.race([check(), deadline.then(() => deadlineReason)]); }
  catch (error) { return `Hedge blocked this merge: the merge gate failed (${(error as Error).message}).`; }
}

export function realGateIO(home: string, env: Env): GateIO {
  const api = async (path: string) => {
    const child = Bun.spawn(["gh", "api", "-i", path], { stdout: "pipe", stderr: "pipe", timeout: 8_000, env: { ...process.env, ...env, GH_PAGER: "cat" } });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const status = Number(stdout.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? 0);
    if (status === 404) return undefined;
    if (code !== 0 || status !== 200) throw new Error(`GitHub answered ${status || `exit ${code}`} for ${path}`);
    return JSON.parse(stdout.slice(stdout.search(/\r?\n\r?\n/)).trim()) as unknown;
  };
  return {
    pull: async (repository, pr) => {
      const pull = await api(`repos/${repository}/pulls/${pr}`) as { head: { sha: string }; base: { ref: string; repo: { default_branch: string } }; state: string } | undefined;
      return pull && { head: pull.head.sha, base: pull.base.ref, defaultBranch: pull.base.repo.default_branch, open: pull.state === "open" };
    },
    pullFor: async (repository, branch) => {
      const head = `head=${repository.split("/")[0]}:${encodeURIComponent(branch)}`;
      const open = await api(`repos/${repository}/pulls?state=open&per_page=2&${head}`) as { number: number }[] | undefined;
      if (open && open.length > 1) throw new Error(`more than one open PR in ${repository} has the head branch ${branch}`);
      if (open?.[0]) return open[0].number;
      const closed = await api(`repos/${repository}/pulls?state=closed&sort=created&direction=desc&per_page=1&${head}`) as { number: number }[] | undefined;
      return closed?.[0]?.number;
    },
    isIssue: async (repository, number) => {
      const issue = await api(`repos/${repository}/issues/${number}`) as { pull_request?: unknown } | undefined;
      return issue !== undefined && issue.pull_request === undefined;
    },
    localGate: (repository, pr, commit) => lastGateResult(home, { repository, pr, commit }).catch(() => ({ passed: false, at: Infinity })),
    ledger: () => hubLedger(home, env).read(),
    decidesAll: () => decidesAll(env),
    thread: env.T3CODE_THREAD_ID || undefined,
    now: () => Date.now(),
  };
}
