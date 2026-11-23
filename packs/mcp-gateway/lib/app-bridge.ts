import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { backendArguments, describe, parseUpstream, slack, toolAllowed, type CodexApp } from "./apps.ts";
import { lostCode, reAuthLine, signInLost } from "./sign-in-lost.ts";
import { withUnicodeSkinTones } from "./skin-tones.ts";

type Id = number | string;
type Message = { id?: Id; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string; data?: unknown } };
type Tool = { name: string; description?: string } & Record<string, unknown>;
type Waiter = { resolve: (result: any) => void; reject: (error: Error) => void };

const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const home = process.env.CODEX_HOME;
if (!home) throw new Error("Set CODEX_HOME to the app bridge's own Codex home.");
const app = process.env.HEDGE_APP ? (parseUpstream(JSON.parse(process.env.HEDGE_APP)) as CodexApp) : slack;
if (app.kind !== "codex-app") throw new Error("Set HEDGE_APP to a Codex app upstream.");
const timeout = Number(process.env.HEDGE_CODEX_TIMEOUT_MS ?? 300000);
const config = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
const backend = spawn(process.env.HEDGE_CODEX_BIN ?? "codex", backendArguments(config, app), { stdio: ["pipe", "pipe", "ignore"] });

const toBackend = new Map<Id, Waiter & { timer: ReturnType<typeof setTimeout> }>();
const toAgent = new Map<Id, Waiter>();
let sequence = 0;
let asked = 0;
let active: Id | undefined;
const cancelled = new Set<Id>();
let queue: Promise<unknown> = Promise.resolve();
let catalog = new Map<string, Tool>();
let thread: Promise<string> | undefined;

const reAuth = reAuthLine(app);
type Failure = Error & { code?: number; data?: unknown };
const detail = (error: Failure) => [error.message, error.data];
const explained = (error: Failure) => {
  const code = lostCode(detail(error))!;
  return Object.assign(new Error(`${reAuth} Cause: ${error.message}${error.message.includes(code) ? "" : ` (${code})`}`), { code: error.code });
};
const flagged = (error: Failure) => (signInLost(detail(error)) ? explained(error) : error);
const reply = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const tell = (message: Record<string, unknown>) => backend.stdin.write(`${JSON.stringify(message)}\n`);
const stop = (error: Error, code = 1) => {
  for (const waiter of [...toBackend.values(), ...toAgent.values()]) waiter.reject(error);
  toBackend.clear(), toAgent.clear();
  backend.kill();
  process.exit(code);
};

function call(method: string, params: unknown) {
  const id = ++sequence;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => stop(new Error(`The Codex app backend did not answer ${method}.`)), timeout);
    toBackend.set(id, { resolve, reject, timer });
    tell({ id, method, params });
  });
}

function askAgent(method: string, params: unknown) {
  const id = `hedge-${++asked}`;
  return new Promise<any>((resolve, reject) => {
    toAgent.set(id, { resolve, reject });
    reply({ id, method, params });
  });
}

async function approve(message: Message) {
  try {
    if (message.method !== "mcpServer/elicitation/request" || active === undefined) throw new Error("No agent waits on this Codex request.");
    if (message.params?.mode && !["form", "url"].includes(message.params.mode)) throw new Error("Codex asked for an approval mode MCP cannot show.");
    tell({ id: message.id, result: await askAgent("elicitation/create", message.params) });
  } catch (error) { tell({ id: message.id, error: { code: -32603, message: (error as Error).message } }); }
}

createInterface({ input: backend.stdout }).on("line", (line) => {
  let message: Message;
  try { message = JSON.parse(line); } catch { return stop(new Error("The Codex app backend wrote a line that is not JSON.")); }
  if (message.method !== undefined && message.id !== undefined) return void approve(message);
  const waiter = message.id === undefined ? undefined : toBackend.get(message.id);
  if (!waiter) return;
  toBackend.delete(message.id!), clearTimeout(waiter.timer);
  if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
  else waiter.resolve(message.result);
});
backend.on("error", stop);
backend.on("exit", () => stop(new Error("The Codex app backend exited.")));

async function discover() {
  const found = new Map<string, Tool>();
  for (const server of (await call("mcpServerStatus/list", { serverName: "codex_apps", limit: 100 })).data as Array<{ tools: Record<string, Tool>; toolsError?: unknown }>) {
    if (server.toolsError) throw Object.assign(new Error(`The Codex app backend could not list the ${app.title} tools.`), { data: server.toolsError });
    for (const tool of Object.values(server.tools)) {
      const name = tool.name.slice(app.prefix.length);
      if (!tool.name.startsWith(app.prefix) || !toolAllowed(app, name)) continue;
      found.set(name, { ...tool, name, ...(tool.description && { description: describe(app, tool.description) }) });
    }
  }
  if (!found.size) throw new Error(`The ${app.title} app is not connected to the bridge's ChatGPT sign-in. On the hub, run: hedge mcp-gateway sign-in ${app.name}`);
  return catalog = found;
}

async function invoke(id: Id, params: { name: string; arguments?: Record<string, unknown> }) {
  if (!toolAllowed(app, params.name)) return { isError: true, content: [{ type: "text", text: app.refusal }] };
  if (!catalog.has(params.name) && !(await discover()).has(params.name)) throw new Error(`The ${app.title} app has no tool ${params.name}.`);
  if (cancelled.delete(id)) throw new Error(`The agent cancelled this ${app.title} call.`);
  active = id;
  try {
    thread ??= call("thread/start", { cwd: "/app/data", ephemeral: true }).then((started) => started.thread.id as string, (error) => { thread = undefined; throw error; });
    const args = params.arguments ?? {};
    const { structuredContent, ...answered } = await call("mcpServer/tool/call", { threadId: await thread, server: "codex_apps", tool: `${app.prefix}${params.name}`, arguments: app.skinTones ? withUnicodeSkinTones(args) : args });
    const result = answered.isError && signInLost([answered.content, structuredContent]) ? { ...answered, content: [{ type: "text", text: reAuth }, ...(answered.content ?? [])] } : answered;
    return structuredContent == null ? result : { ...result, structuredContent };
  } finally { active = undefined; }
}

async function handle(message: Message) {
  await ready;
  const params = message.params ?? {};
  if (message.method === "initialize") return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: `hedge-${app.name}`, version: "1" } };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: [...(await discover().catch((error: Failure) => { throw flagged(error); })).values()] };
  if (message.method === "tools/call") {
    const turn = queue.then(() => invoke(message.id!, params as { name: string })).catch((error: Failure) => { throw flagged(error); });
    queue = turn.catch(() => {});
    return turn;
  }
  throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
}

const ready = call("initialize", { clientInfo: { name: `hedge-${app.name}-bridge`, version: "1" }, capabilities: { experimentalApi: true } }).then(() => tell({ method: "initialized", params: {} }));

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Message;
  try { message = JSON.parse(line); } catch { return reply({ id: undefined, error: { code: -32700, message: "Parse error" } }); }
  if (message.method === undefined) {
    const waiter = toAgent.get(message.id!);
    toAgent.delete(message.id!);
    return message.error ? waiter?.reject(new Error(message.error.message)) : waiter?.resolve(message.result);
  }
  if (message.method === "notifications/cancelled") {
    if (message.params?.requestId === active) return stop(new Error(`The agent cancelled the ${app.title} call.`));
    return void cancelled.add(message.params?.requestId);
  }
  if (message.id === undefined) return;
  handle(message).then(
    (result) => reply({ id: message.id, result }),
    (error: Error & { code?: number }) => reply({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
}).on("close", () => stop(new Error("The gateway closed the app bridge."), 0));
