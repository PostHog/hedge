import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { leanClaude, modelFor, modelSessionEnv, modelTable, type ModelRow } from "../../base/lib/models.ts";
import { quotaGraceMs, quotaWatch } from "../../base/lib/quota.ts";
import { secretKinds } from "../../base/hooks/secret-guard.ts";

export const families = ["claude", "gpt"] as const;
export type Family = (typeof families)[number];

export function family(value: string): Family {
  if (!(families as readonly string[]).includes(value)) throw new Error(`Unknown author family ${value}. Use claude or gpt`);
  return value as Family;
}

export function sessionFamily(env: Record<string, string | undefined>): Family | undefined {
  const [claude, gpt] = [Boolean(env.CLAUDE_CODE_SESSION_ID), Boolean(env.CODEX_THREAD_ID)];
  return claude === gpt ? undefined : claude ? "claude" : "gpt";
}

export const familyOf = (row: ModelRow): Family => row.provider === "claude" ? "claude" : "gpt";

export function reviewerRow(author: Family, env: Record<string, string | undefined>) {
  const codexReviewer = author === "gpt" ? modelTable(env).find((row) => row.role === "review-codex") : undefined;
  return codexReviewer ?? modelFor("review", env);
}

export function sameFamilyRow(author: Family, env: Record<string, string | undefined>) {
  const reviewers = modelTable(env).filter((row) => ["review", "review-codex"].includes(row.role));
  return reviewers.find((row) => familyOf(row) === author) ?? reviewerRow(author, env);
}

export function securityRow(env: Record<string, string | undefined>): ModelRow | undefined {
  const row = modelTable(env).find((candidate) => candidate.role === "security");
  const model = env.HEDGE_PROOF_SECURITY_MODEL;
  if (!model) return row;
  return { ...(row ?? { role: "security", work: "Deep security review", effort: "xhigh" }), provider: model.startsWith("claude") ? "claude" : "codex", model };
}

export type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; total?: number; costUsd?: number };
export type ModelAnswer = { ok: true; text: string; model: string; usage?: Usage } | { ok: false; cause: string; model: string };
export type ModelRequest = { prompt: string; cwd: string; readable?: string[]; images?: string[]; schema?: object; started?: (pid: number) => Promise<void> };
export type Role = "arbiter" | "reviewer" | "judge" | "bloat-judge" | "eval-judge";

const prefixes: Record<Role, string> = { arbiter: "HEDGE_REVIEW_ARBITER", reviewer: "HEDGE_PROOF_REVIEWER", judge: "HEDGE_PROOF_JUDGE", "bloat-judge": "HEDGE_PROOF_BLOAT_JUDGE", "eval-judge": "HEDGE_PROOF_EVAL_JUDGE" };
const prefixOf = (role: Role) => prefixes[role];

export function modelLabel(role: Role, row: ModelRow, env: Record<string, string | undefined>, pinned = false) {
  const replacement = env[prefixOf(role)];
  return (!pinned && env[`${prefixOf(role)}_MODEL`]) || (replacement ? `command: ${replacement}` : row.model);
}

export async function askModel(role: Role, row: ModelRow, request: ModelRequest, env: Record<string, string | undefined>, limit: number, pinned = false): Promise<ModelAnswer> {
  const prefix = prefixOf(role);
  const replacement = env[prefix];
  const model = modelLabel(role, row, env, pinned);
  const timeout = Number(env[`${prefix}_TIMEOUT_MS`]) || limit;
  const matched = secretKinds(request.prompt);
  if (matched.length) return { ok: false, cause: `the secret guard matches this prompt: ${matched.join(", ")}`, model };
  const scratch = await mkdtemp(join(tmpdir(), "hedge-proof-model-"));
  try {
    const output = join(scratch, "answer.txt");
    const command = replacement ? ["sh", "-c", replacement] : await modelCommand(role, { ...row, model }, request, scratch, output);
    const lean = replacement ? undefined : row.provider;
    const limits = { timeout, grace: graceOf(env.HEDGE_PROOF_QUOTA_GRACE_MS), events: lean !== undefined };
    const { argv, env: spawnEnv } = lean === "claude" ? leanClaude(command, env.HOME ?? homedir(), env) : { argv: command, env };
    let answer = await spawnWithLimit(argv, request, spawnEnv, limits);
    if (answer.transient) {
      await Bun.sleep(retryDelayOf(env.HEDGE_PROOF_RETRY_DELAY_MS));
      answer = await spawnWithLimit(argv, request, spawnEnv, limits);
      if (answer.transient) return { ok: false, cause: `${answer.cause} (after a retry)`, model };
    }
    if (answer.cause !== undefined) return { ok: false, cause: answer.cause, model };
    const reply = lean === "claude" ? claudeReply(answer.stdout)
      : lean === "codex" ? { text: await readFile(output, "utf8").catch(() => ""), usage: codexUsage(answer.stdout) }
      : { text: answer.stdout };
    if (reply.error) return { ok: false, cause: reply.error, model };
    return reply.text.trim() ? { ok: true, text: reply.text.trim(), model, ...reply.usage ? { usage: reply.usage } : {} } : { ok: false, cause: "empty answer", model };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const retryDelayMs = 30_000;

function retryDelayOf(value: string | undefined) {
  const delay = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(delay) && delay >= 0 ? delay : retryDelayMs;
}

function graceOf(value: string | undefined) {
  const grace = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(grace) && grace >= 0 ? grace : quotaGraceMs;
}

async function modelCommand(role: Role, row: ModelRow, request: ModelRequest, scratch: string, output: string) {
  if (row.provider === "claude") {
    return ["claude", "-p", "--model", row.model, "--effort", row.effort, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--tools", role === "arbiter" ? "" : "Read,Grep,Glob",
      "--permission-mode", "dontAsk", ...(request.readable ?? []).flatMap((directory) => ["--add-dir", directory])];
  }
  const schema = request.schema ? join(scratch, "schema.json") : undefined;
  if (schema) await writeFile(schema, JSON.stringify(request.schema));
  return ["codex", "exec", "--json", "-m", row.model, "-c", `model_reasoning_effort="${row.effort}"`, "-s", "read-only", "--ephemeral", "-C", request.cwd, "-o", output,
    ...(schema ? ["--output-schema", schema] : []), ...(request.images ?? []).flatMap((image) => ["-i", image]), "-"];
}

type Event = { type?: unknown; result?: unknown; is_error?: unknown; message?: unknown; error?: { message?: unknown }; item?: { type?: unknown; message?: unknown }; usage?: Record<string, unknown>; total_cost_usd?: unknown; info?: { total_token_usage?: Record<string, unknown> }; payload?: Event; msg?: Event };

function eventOf(line: string): Event | undefined {
  if (!line.trimStart().startsWith("{")) return undefined;
  try { return JSON.parse(line) as Event; } catch { return undefined; }
}

function eventMessage(line: string) {
  const event = eventOf(line);
  const text = event && [event.is_error === true ? event.result : undefined, event.message, event.error?.message, event.item?.type === "error" ? event.item.message : undefined].find((value) => typeof value === "string");
  return typeof text === "string" ? text : undefined;
}

const eventText = (line: string) => eventMessage(line) ?? line;

function usageOf(counts: Record<keyof Usage, unknown>): Usage | undefined {
  const usage = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
  return Object.keys(usage).length ? usage : undefined;
}

function claudeReply(stdout: string): { text: string; usage?: Usage; error?: string } {
  const reply = eventOf(stdout.trim());
  // A Claude result envelope without a result string is a failed call, never a review; other output is a custom reviewer's text.
  if (typeof reply?.result !== "string") return reply?.type === "result" || "is_error" in (reply ?? {}) ? { text: "", error: "the reviewer returned no result" } : { text: stdout };
  if (reply.is_error === true) return { text: "", error: reply.result || "the reviewer reported an error" };
  const counts = reply.usage ?? {};
  return { text: reply.result, usage: usageOf({ input: counts.input_tokens, cacheRead: counts.cache_read_input_tokens, cacheWrite: counts.cache_creation_input_tokens, output: counts.output_tokens, total: undefined, costUsd: reply.total_cost_usd }) };
}

function codexUsage(stdout: string) {
  let found: Usage | undefined;
  for (const line of stdout.split("\n")) {
    const event = eventOf(line);
    const counts = event?.usage ?? (event?.payload ?? event?.msg ?? event)?.info?.total_token_usage;
    if (!counts) continue;
    found = usageOf({ input: counts.input_tokens, cacheRead: counts.cached_input_tokens, cacheWrite: counts.cache_write_input_tokens, output: counts.output_tokens, total: counts.total_tokens, costUsd: undefined }) ?? found;
  }
  return found;
}

type Spawned = { stdout: string; cause?: undefined; transient?: undefined } | { stdout?: undefined; cause: string; transient?: boolean };
type Limits = { timeout: number; grace: number; events: boolean };

export const quotaExhausted = "quota exhausted";
export const isQuotaExhausted = (cause: string | undefined) => Boolean(cause?.startsWith(quotaExhausted));
export const quotaExitCode = 4;

async function spawnWithLimit(command: string[], request: ModelRequest, env: Record<string, string | undefined>, { timeout, grace, events }: Limits): Promise<Spawned> {
  let child: Bun.Subprocess<Blob, "pipe", "pipe"> | undefined;
  let stop: ReturnType<typeof setTimeout> | undefined;
  let stalled: string | undefined;
  const watch = quotaWatch(grace, (line) => { stalled = line; if (child) stopGroup(child.pid); });
  try {
    const running = child = Bun.spawn(command, { cwd: request.cwd, env: modelSessionEnv(env), stdin: new Blob([request.prompt]), stdout: "pipe", stderr: "pipe", detached: true });
    stop = setTimeout(() => stopGroup(running.pid), timeout);
    const [stdout, stderr, code] = await Promise.all([watched(child.stdout, events ? eventLines(watch.stream()) : watch.stream()), watched(child.stderr, watch.stream()), child.exited, request.started?.(child.pid)]);
    if (stalled) return { cause: `${quotaExhausted}: no progress after "${stalled}"` };
    if (child.signalCode) return { cause: `stopped by ${child.signalCode} at the ${Math.round(timeout / 1000)} s limit` };
    if (code !== 0 && watch.waiting()) return { cause: `${quotaExhausted}: exit ${code} after "${watch.waiting()}"` };
    if (code !== 0) {
      const last = lastLines(stderr) || lastLines(stdout.split("\n").map((line) => eventMessage(line) ?? "").join("\n"));
      return { cause: `exit ${code}${last ? `: ${last}` : ""}`, transient: true };
    }
    return { stdout };
  } catch (error) {
    if (child) { stopGroup(child.pid); await child.exited; }
    return { cause: (error as Error).message };
  } finally { clearTimeout(stop); watch.stop(); }
}

const lastLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).map((line) => line.slice(0, 200)).join(" | ");

type Lines = { observe: (chunk: string) => void; end: () => void };

function eventLines(lines: Lines): Lines {
  let partial = "";
  return {
    observe(chunk) {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) lines.observe(`${eventText(line)}\n`);
    },
    end() { if (partial) lines.observe(eventText(partial)); partial = ""; lines.end(); },
  };
}

async function watched(stream: ReadableStream<Uint8Array>, lines: Lines) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    lines.observe(part);
    text += part;
  }
  const rest = decoder.decode();
  lines.observe(rest);
  lines.end();
  return text + rest;
}

function stopGroup(group: number) {
  try { process.kill(-group, "SIGKILL"); } catch {}
}

export async function readRubric(home: string) {
  const standards = (await readFile(join(home, ".agents/guides/coding-standards.md"), "utf8").catch(() => "")).trim();
  if (!standards) throw new Error("~/.agents/guides/coding-standards.md is missing or empty; it holds the coding standards to review against");
  return standards;
}

export async function readRiskRubric(home: string) {
  const skill = (await readFile(join(home, ".agents/skills/merge-risk/SKILL.md"), "utf8").catch(() => "")).trim();
  return skill || undefined;
}

export const skillReferences = (home: string) => ["tdd", "codebase-design"].map((skill) => join(home, ".agents/skills", skill, "SKILL.md"));
