import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { startT3Stub, ToolRefusal, type T3Fixture, type T3Stub } from "../../base/lib/t3/testing.ts";
import { runThread } from "./thread.ts";
import { linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, shellThread, type LinkedThreadFixture } from "./testing.ts";

const command = join(import.meta.dir, "..", "commands", "thread.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const linkedThreads: LinkedThreadFixture[] = [
  linkedThread("mcp:linked-busy", { status: "running", updatedAt: minutesAgo(5) }),
  linkedThread("mcp:linked-done", { status: "completed", updatedAt: minutesAgo(90), items: [linkedItem("user_message", "Ship it"), linkedItem("assistant_message", "Shipped.")] }),
  linkedThread("mcp:linked-conductor", { status: "idle", runtimeMode: "full-access" }),
  linkedThread("mcp:everywhere"),
  linkedThread("mcp:remote-only"),
];

function fixture(links = [linkedEnvironment], threads = linkedThreads, extraLocal: ShellThread[] = []): T3Fixture {
  const localThreads = [
    shellThread("mcp:local-busy", { status: "running", activeRunId: "run-1", latestRunStartedAt: minutesAgo(2) }),
    shellThread("mcp:local-idle", { status: "completed", latestRunCompletedAt: minutesAgo(30) }),
    shellThread("mcp:everywhere"),
    shellThread("one:twin"),
    shellThread("two:twin"),
    ...extraLocal,
  ];
  return {
    shell: {
      projects: [{ id: "project-local", title: "Local project", workspaceRoot: "/work/local" }],
      threads: localThreads,
    },
    archived: { projects: [], threads: [shellThread("mcp:local-archived", { archivedAt: minutesAgo(100) })] },
    links,
    tools: (name, args) => (name === "t3_thread_send" && args.environmentId === undefined ? localSend(args, localThreads) : linkedTools(threads)(name, args)),
    rpc: (tag) => (tag === "orchestration.dispatchCommand" ? { sequence: 1 } : undefined),
  };
}

function localSend(args: Record<string, unknown>, threads: ShellThread[]) {
  const target = threads.find((candidate) => candidate.id === args.threadId);
  const steerable = Boolean(target?.status === "running" && target.activeRunId);
  if (!steerable && (args.mode === "steer" || args.mode === "restart")) {
    throw new ToolRefusal("no_steerable_run", `Thread ${args.threadId} has no running turn to ${args.mode}.`);
  }
  const delivery = steerable
    ? (args.mode === "queue" ? "queued" : args.mode === "restart" ? "restarted" : "steered")
    : "started";
  const status = delivery === "queued" ? "queued" : delivery === "steered" ? "running" : "starting";
  return { threadId: args.threadId, messageId: `message:${args.clientRequestId}`, runId: "run:local", status, delivery };
}

async function stub(given = fixture()): Promise<T3Stub> {
  const started = await startT3Stub(given);
  cleanups.push(() => started.stop());
  return started;
}

async function thread(t3: T3Stub, args: string[], stdin = "") {
  const lines: string[] = [];
  const code = await runThread(args, { home: t3.home, host: "this-box", print: (line) => lines.push(line), readStdin: async () => stdin });
  return { code, output: lines.join("\n") };
}

const dispatched = (t3: T3Stub) => t3.rpcCalls.filter((call) => call.tag === "orchestration.dispatchCommand").map((call) => call.payload as Record<string, unknown>);
const sends = (t3: T3Stub) => t3.toolCalls.filter((call) => call.name === "t3_thread_send").map((call) => call.args);

test("hedge thread send reaches a thread on a linked environment, found without --host, and steers a running turn by default", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "mcp:linked-busy", "Rebase", "on", "main"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-busy", delivery: "steered" });
  expect(sends(t3)).toEqual([{ environmentId: "env-linked", threadId: "mcp:linked-busy", message: "Rebase on main", mode: "auto", clientRequestId: expect.stringMatching(/^hedge-thread-send:/) }]);
  expect(dispatched(t3)).toEqual([]);
});

test("hedge thread send takes the message from stdin and steers the running turn of a thread on this machine as an agent's message", async () => {
  const t3 = await stub();
  const child = Bun.spawn(["bun", command, "send", "--host", hostname(), "mcp:local-busy"], { env: { ...Bun.env, HOME: t3.home, HEDGE_SETTINGS: "{}" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("It's done'; rm -rf ~ #\n");
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ threadId: "mcp:local-busy", delivery: "steered" });
  expect(sends(t3)).toEqual([{ threadId: "mcp:local-busy", message: "It's done'; rm -rf ~ #", mode: "auto", clientRequestId: expect.stringMatching(/^hedge-thread-send:/) }]);
  expect(dispatched(t3)).toEqual([]);
});

test("an idle thread on this machine starts a turn with the message", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "mcp:local-idle", "Go"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:local-idle", delivery: "started" });
  expect(sends(t3)).toEqual([expect.objectContaining({ threadId: "mcp:local-idle", message: "Go", mode: "auto" })]);
});

test("hedge thread send accepts --mode before --host", async () => {
  const t3 = await stub();
  const { output } = await thread(t3, ["send", "--mode", "queue", "--host", "devbox-2", "mcp:linked-busy", "Later"]);

  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-busy", delivery: "queued" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ environmentId: "env-linked", threadId: "mcp:linked-busy", message: "Later", mode: "queue" }),
  ]);
});

test("hedge thread send accepts --mode after --host", async () => {
  const t3 = await stub();
  const { output } = await thread(t3, ["send", "--host", "this-box", "--mode", "restart", "mcp:local-busy", "Again"]);

  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:local-busy", delivery: "restarted" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ threadId: "mcp:local-busy", message: "Again", mode: "restart" }),
  ]);
});

test("hedge thread send keeps --mode words after the thread id as part of the message", async () => {
  const t3 = await stub();
  const { output } = await thread(t3, ["send", "--host", "this-box", "mcp:local-busy", "Start", "--mode", "queue"]);

  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:local-busy", delivery: "steered" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ threadId: "mcp:local-busy", message: "Start --mode queue", mode: "auto" }),
  ]);
});

test("hedge thread send refuses an unknown --mode without sending", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "--mode", "now", "mcp:local-busy", "Hi"])).rejects.toThrow("Unknown --mode now. Use one of: auto, queue, steer, restart.");
  expect(sends(t3)).toEqual([]);
});

test("hedge thread send refuses a missing --mode value without sending", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "--mode"])).rejects.toThrow("Usage: hedge thread list");
  expect(sends(t3)).toEqual([]);
});

test("hedge thread read refuses --mode", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["read", "--mode", "queue", "mcp:local-idle"])).rejects.toThrow("Usage: hedge thread list");
});

test("hedge thread send queues behind a local question card by default", async () => {
  const t3 = await stub(fixture([linkedEnvironment], linkedThreads, [
    shellThread("mcp:local-card", { status: "running", activeRunId: "run-2", pendingRuntimeRequest: { id: "card-1", kind: "user_input" } }),
  ]));

  const { output } = await thread(t3, ["send", "--host", "this-box", "mcp:local-card", "FYI"]);

  expect(JSON.parse(output)).toMatchObject({ threadId: "mcp:local-card", delivery: "queued" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ threadId: "mcp:local-card", message: "FYI", mode: "queue" }),
  ]);
});

test("hedge thread send passes --mode steer through on a local question card", async () => {
  const t3 = await stub(fixture([linkedEnvironment], linkedThreads, [
    shellThread("mcp:local-card", { status: "running", activeRunId: "run-2", pendingRuntimeRequest: { id: "card-1", kind: "user_input" } }),
  ]));

  const { output } = await thread(t3, ["send", "--host", "this-box", "--mode", "steer", "mcp:local-card", "Replace card"]);

  expect(JSON.parse(output)).toMatchObject({ threadId: "mcp:local-card", delivery: "steered" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ threadId: "mcp:local-card", message: "Replace card", mode: "steer" }),
  ]);
});

test("hedge thread send queues behind a linked pending request by default", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [
    ...linkedThreads,
    linkedThread("mcp:linked-card", { status: "running", pendingRequestCount: 1 }),
  ]));

  const { output } = await thread(t3, ["send", "--host", "devbox-2", "mcp:linked-card", "FYI"]);

  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-card", delivery: "queued" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ environmentId: "env-linked", threadId: "mcp:linked-card", message: "FYI", mode: "queue" }),
  ]);
});

test("hedge thread send passes --mode steer through on a linked pending request", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [
    ...linkedThreads,
    linkedThread("mcp:linked-card", { status: "running", pendingRequestCount: 1 }),
  ]));

  const { output } = await thread(t3, ["send", "--host", "devbox-2", "--mode", "steer", "mcp:linked-card", "Replace card"]);

  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-card", delivery: "steered" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ environmentId: "env-linked", threadId: "mcp:linked-card", message: "Replace card", mode: "steer" }),
  ]);
});

test("hedge thread send fails closed to queue on a linked thread when checking pending requests fails", async () => {
  const base = fixture();
  const t3 = await stub({
    ...base,
    tools(name, args) {
      if (name === "t3_thread_read") throw new ToolRefusal("orchestration_error", "timeout");
      return base.tools!(name, args);
    },
  });

  const result = await thread(t3, ["send", "--host", "devbox-2", "mcp:linked-busy", "FYI"]);

  expect(JSON.parse(result.output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-busy", delivery: "queued" });
  expect(sends(t3)).toEqual([
    expect.objectContaining({ environmentId: "env-linked", threadId: "mcp:linked-busy", message: "FYI", mode: "queue" }),
  ]);
});

test("hedge thread send refuses an archived thread, an empty message, and a thread it cannot place, and sends nothing", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "mcp:local-archived", "Hi"])).rejects.toThrow("Thread mcp:local-archived is archived. Unarchive it before you send it a message.");
  await expect(thread(t3, ["send", "mcp:local-idle"], "  \n")).rejects.toThrow("The message is empty.");
  await expect(thread(t3, ["send", "mcp:everywhere", "Hi"])).rejects.toThrow("Thread mcp:everywhere is on this-box, devbox-2. Choose one with --host.");
  await expect(thread(t3, ["send", "mcp:nowhere", "Hi"])).rejects.toThrow("No machine has thread mcp:nowhere.");
  await expect(thread(t3, ["send", "--host", "nowhere", "mcp:local-idle", "Hi"])).rejects.toThrow("No linked environment nowhere. Linked: devbox-2.");
  expect(dispatched(t3)).toEqual([]);
  expect(sends(t3)).toEqual([]);
});

test("a linked environment that cannot answer is named when no machine has the thread", async () => {
  const t3 = await stub(fixture([{ ...linkedEnvironment, status: "unreachable", lastError: "connection refused" }]));

  await expect(thread(t3, ["send", "mcp:linked-busy", "Hi"])).rejects.toThrow("No machine has thread mcp:linked-busy.\ndevbox-2: did not answer: connection refused");
});

test("T3's refusal of a linked send is shown as T3 words it", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "--host", "devbox-2", "mcp:linked-conductor", "Hi"])).rejects.toThrow("Thread mcp:linked-conductor runs in full-access mode, above this caller's.");
});

test("words after the thread id are the message, even when they look like flags", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "--host", "this-box", "mcp:everywhere", "Explain", "--host", "devbox-2"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:everywhere" });
  expect(sends(t3)).toEqual([expect.objectContaining({ threadId: "mcp:everywhere", message: "Explain --host devbox-2" })]);
  expect(dispatched(t3)).toEqual([]);
});

test("a short id finds a linked thread the same way it finds a local one, and an id that fits two threads is refused", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "remote-only", "Hi"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:remote-only" });
  await expect(thread(t3, ["send", "twin", "Hi"])).rejects.toThrow("On this-box, twin fits one:twin, two:twin. Give the full id.");
  expect(dispatched(t3)).toEqual([]);
});

test("an archived linked thread named by its full id wins over a live thread whose id ends with it", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [...linkedThreads, linkedThread("target", { archived: true }), linkedThread("mcp:target")]));
  const { code, output } = await thread(t3, ["send", "--host", "devbox-2", "target", "Hi"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "target" });
  expect(sends(t3)).toEqual([expect.objectContaining({ threadId: "target" })]);
});

test("a short id that fits two threads on a linked machine is refused, even when this machine has one match", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [...linkedThreads, linkedThread("one:local-idle"), linkedThread("two:local-idle")]));

  await expect(thread(t3, ["read", "local-idle"])).rejects.toThrow("On devbox-2, local-idle fits one:local-idle, two:local-idle. Give the full id.");
  await expect(thread(t3, ["send", "local-idle", "Hi"])).rejects.toThrow("On devbox-2, local-idle fits one:local-idle, two:local-idle. Give the full id.");
  expect(dispatched(t3)).toEqual([]);
});

test("an unqualified send waits for every machine to answer, so a copy on a silent machine is never skipped", async () => {
  const t3 = await stub(fixture([linkedEnvironment, { ...linkedEnvironment, environmentId: "env-down", label: "devbox-3", status: "unreachable", lastError: "connection refused" }]));

  await expect(thread(t3, ["send", "mcp:local-idle", "Hi"])).rejects.toThrow("Thread mcp:local-idle is on this-box, but devbox-3 could not be checked (did not answer: connection refused). Choose the machine with --host.");
  expect(dispatched(t3)).toEqual([]);
  const { code } = await thread(t3, ["send", "--host", "this-box", "mcp:local-idle", "Hi"]);
  expect(code).toBe(0);
});

test("hedge thread read finds a linked thread and prints its messages", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["read", "mcp:linked-done"]);
  const read = JSON.parse(output);

  expect(code).toBe(0);
  expect(read.host).toBe("devbox-2");
  expect(read.thread.thread.threadId).toBe("mcp:linked-done");
  expect(read.thread.items.map((item: { text: string }) => item.text)).toEqual(["Ship it", "Shipped."]);
});

test("hedge thread find names the machine that has a thread, local or linked, without reading the thread", async () => {
  const t3 = await stub();

  expect(JSON.parse((await thread(t3, ["find", "remote-only"])).output)).toEqual({ host: "devbox-2", threadId: "mcp:remote-only" });
  expect(JSON.parse((await thread(t3, ["find", "mcp:local-idle"])).output)).toEqual({ host: "this-box", threadId: "mcp:local-idle" });
  await expect(thread(t3, ["find", "mcp:everywhere"])).rejects.toThrow("Thread mcp:everywhere is on this-box, devbox-2. Choose one with --host.");
  await expect(thread(t3, ["find", "mcp:local-idle", "extra"])).rejects.toThrow("Usage: hedge thread list");
  expect(t3.toolCalls.filter((call) => call.name === "t3_thread_read").map((call) => call.args.limit)).toEqual([1, 1]);
  expect(t3.rpcCalls.filter((call) => call.tag === "orchestration.getThreadProjection")).toEqual([]);
});

test("hedge thread read --words exports only what a person typed in a thread on a linked machine, each with the reply it answered", async () => {
  const long = "z".repeat(60_000);
  const t3 = await stub(fixture([linkedEnvironment], [linkedThread("mcp:talk", { items: [
    linkedItem("user_message", "First ask"),
    linkedItem("assistant_message", "Which branch?"),
    linkedItem("user_message", "agent says hi", { createdBy: "agent", creationSource: "mcp" }),
    linkedItem("user_message", "server relay", { createdBy: "user", creationSource: "server" }),
    linkedItem("user_message", "agent from the web", { createdBy: "agent", creationSource: "web" }),
    linkedItem("user_message", long, { itemId: "long-ask", creationSource: "mobile" }),
  ] })]));
  const { code, output } = await thread(t3, ["read", "talk", "--words"]);
  const read = JSON.parse(output);

  expect(code).toBe(0);
  expect(read.host).toBe("devbox-2");
  expect(read.words.map((word: { thread: string; text: string; answered: string; source: string }) => [word.thread, word.text.length, word.answered, word.source])).toEqual([
    ["mcp:talk", "First ask".length, "", "typed"],
    ["mcp:talk", 60_000, "Which branch?", "typed"],
  ]);
  expect(read.words[1].text).toBe(long);
});

test("hedge thread read --words reads every page of a long thread on a linked machine, each word at the time T3 gives its item", async () => {
  const items = Array.from({ length: 150 }, (_, index) => index === 1 || index === 140
    ? linkedItem("user_message", `Ask ${index}`, { itemId: `ask-${index}`, updatedAt: `2026-10-25T07:${String(index % 60).padStart(2, "0")}:00.000Z` })
    : linkedItem("assistant_message", `Reply ${index}`, { itemId: `reply-${index}` }));
  const t3 = await stub(fixture([linkedEnvironment], [linkedThread("mcp:long", { items })]));
  const read = JSON.parse((await thread(t3, ["read", "long", "--words"])).output);

  expect(read.words.map((word: { text: string; answered: string; at: string }) => [word.text, word.answered, word.at])).toEqual([
    ["Ask 1", "Reply 0", "2026-10-25T07:01:00.000Z"],
    ["Ask 140", "Reply 139", "2026-10-25T07:20:00.000Z"],
  ]);
  expect(t3.toolCalls.filter((call) => call.name === "t3_thread_read" && call.args.view === "messages").map((call) => call.args.afterPosition)).toEqual([undefined, 99]);
});

test("hedge thread list lists the threads of this machine and each linked environment", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["list", "--json"]);
  const reports = JSON.parse(output);

  expect(code).toBe(0);
  expect(reports.map((report: { host: string; threads: { id: string }[] }) => [report.host, report.threads.map((listed) => listed.id)])).toEqual([
    ["this-box", ["mcp:local-busy", "mcp:local-idle", "mcp:everywhere", "mcp:local-archived", "one:twin", "two:twin"]],
    ["devbox-2", ["mcp:linked-busy", "mcp:linked-done", "mcp:everywhere", "mcp:linked-conductor", "mcp:remote-only"]],
  ]);
});

test("hedge thread without an action prints its usage", async () => {
  const t3 = await stub();

  await expect(thread(t3, [])).rejects.toThrow("Usage: hedge thread list");
  await expect(thread(t3, ["read"])).rejects.toThrow("Usage: hedge thread list");
});
