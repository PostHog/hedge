import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AvailableSource } from "../../../../src/pack/types.ts";
import { startT3Stub, type T3Stub } from "../../../../src/integrations/t3/testing.ts";
import type { ShellSnapshot } from "../../../../src/integrations/t3/threads.ts";
import { tempDirs } from "../../../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../../src/testing/packs.ts";
import { recoverCommand } from "./sweep.ts";
import { fakeProxy, limitedThread, modelRows, recoveryHome, t3Inbox } from "./testing.ts";

const temp = tempDirs();
const stubs: T3Stub[] = [];
afterEach(async () => {
  temp.cleanup();
  await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
});
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const start = Date.parse("2026-11-10T20:00:00Z");
const codexThread = (id: string, fields = {}) => limitedThread(id, { providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-test-1" }, ...fields });

async function sweep(threads: Record<string, unknown>[], answers: Parameters<typeof fakeProxy>[0], runs = 1) {
  const inbox = t3Inbox(() => threads);
  const stub = await startT3Stub({ shell: { projects: [], threads } as unknown as ShellSnapshot, rpc: inbox.rpc });
  stubs.push(stub);
  const home = recoveryHome(temp.make("home-"));
  const proxy = fakeProxy(answers);
  const lines: string[] = [];
  const codes: number[] = [];
  for (let run = 0; run < runs; run++) {
    codes.push(await recoverCommand([], {
      home, env: { HEDGE_MODELS: JSON.stringify(modelRows) }, fetch: proxy.fetch, now: () => start + run * 5 * 60_000,
      print: (line) => lines.push(line), session: { home: stub.home },
    }));
  }
  return { codes, lines, delivered: inbox.delivered(), proxy };
}

describe("the provider-recovery workflow", () => {
  test("is off by default, needs the Hub pack and own-account balancing, and sweeps every five minutes on the hub and each devbox once on", () => {
    const sources = () => [engine, ...skillSources(temp.make("skills-"), engine)];
    const recovery = (fields: { packs: string[]; workflows?: Record<string, boolean> }) => resolveEngine(sources(), fields, devbox).workflows.find((workflow) => workflow.id === "provider-recovery");
    const balanced = { "provider-recovery": true, "own-account-balancing": true };
    expect(resolveEngine(sources(), { packs: ["hub"] }, devbox).jobs.some((job) => job.id === "recover")).toBe(false);
    expect(recovery({ packs: ["hub"], workflows: { "provider-recovery": true } })).toMatchObject({ active: false, reason: "needs workflow own-account-balancing" });
    expect(recovery({ packs: ["recovery"], workflows: balanced })).toMatchObject({ active: false, reason: "needs hub" });
    const on = resolveEngine(sources(), { packs: ["hub"], workflows: balanced }, devbox);
    expect(on.jobs).toContainEqual(expect.objectContaining({ id: "recover", pack: "hub", command: ["hedge", "recover"], schedule: { every: "5m" } }));
  });
});

describe("the limit sweep", () => {
  test("sends a thread stopped on a usage limit one continue message once its provider is available", async () => {
    const { codes, lines, delivered } = await sweep([limitedThread("a")], { "claude-test-1": 200, "gpt-test-1": 200 });
    expect(codes).toEqual([0]);
    expect(delivered).toEqual([{ threadId: "a", text: "Continue where you left off.", continuesRunId: "run-a" }]);
    expect(lines).toContain("Thread a (a): continued after a usage limit; claude is available.");
  });

  test("leaves a limited thread alone while its provider is exhausted or unknown", async () => {
    const { lines, delivered } = await sweep([codexThread("b"), limitedThread("c")], { "claude-test-1": [502, "bad gateway"], "gpt-test-1": 429 });
    expect(delivered).toEqual([]);
    expect(lines).toContain("Thread b (b): waits for codex, which is exhausted.");
    expect(lines).toContain("Thread c (c): waits for claude, which is unknown.");
  });

  test("continues a provider error that names spent quota with a new message, since T3 resumes only a usage-limit run, and retries a plain outage", async () => {
    const cooling = limitedThread("d", { lastErrorClass: "provider_error", lastError: "All credentials for model claude-test-1 are cooling down" });
    const outage = limitedThread("e", { lastErrorClass: "provider_error", lastError: "api_error_500 Internal server error" });
    const { codes, delivered } = await sweep([cooling, outage], { "claude-test-1": 200 });
    expect(codes).toEqual([0]);
    expect(delivered).toEqual([
      { threadId: "d", text: "Continue where you left off." },
      { threadId: "e", text: "Continue where you left off." },
    ]);
  });

  test("skips every thread that a person or a block holds", async () => {
    const held = [
      limitedThread("archived", { archivedAt: "2026-11-10T19:30:00.000Z" }),
      limitedThread("running", { activeRunId: "run-new" }),
      limitedThread("asking", { pendingRuntimeRequest: { id: "question" } }),
      limitedThread("settled", { settledAt: "2026-11-10T19:30:00.000Z" }),
      limitedThread("snoozed", { snoozedUntil: "2026-11-11T08:00:00.000Z" }),
      limitedThread("subagent", { creationSource: "provider", lineage: { relationshipToParent: "subagent" } }),
      limitedThread("manual", { limitRecovery: { autoResume: false } }),
      limitedThread("moved", { providerInstanceId: "codex" }),
      limitedThread("stopped", { latestRunStopRequested: true }),
      limitedThread("done", { status: "completed" }),
    ];
    const woke = limitedThread("woke", { snoozedUntil: "2026-11-10T19:59:00.000Z" });
    const { delivered } = await sweep([...held, woke], { "claude-test-1": 200 });
    expect(delivered.map((message) => message.threadId)).toEqual(["woke"]);
  });

  test("sends one continue message per stopped run, however many sweeps see it", async () => {
    const { codes, delivered } = await sweep([limitedThread("f")], { "claude-test-1": 200 }, 3);
    expect(codes).toEqual([0, 0, 0]);
    expect(delivered).toEqual([{ threadId: "f", text: "Continue where you left off.", continuesRunId: "run-f" }]);
  });

  test("resumes a T3 delegated subthread whose owning ancestor is open, even when that ancestor is snoozed, and skips provider-native or orphaned subagents", async () => {
    const conductor = limitedThread("conductor", { status: "completed", latestRunId: "run-done", snoozedUntil: "2026-11-11T08:00:00.000Z" });
    const settledParent = limitedThread("settled-parent", { status: "completed", settledAt: "2026-11-10T19:30:00.000Z" });
    const lane = limitedThread("lane", { creationSource: "mcp", lineage: { parentThreadId: "conductor", rootThreadId: "conductor", relationshipToParent: "subagent" } });
    const nested = limitedThread("nested", {
      creationSource: "mcp", lastErrorClass: "provider_error", lastError: "api_error_503 Service unavailable",
      lineage: { parentThreadId: "lane", rootThreadId: "conductor", relationshipToParent: "subagent" },
    });
    const providerChild = limitedThread("provider-child", { creationSource: "provider", lineage: { parentThreadId: "conductor", rootThreadId: "conductor", relationshipToParent: "subagent" } });
    const settledChild = limitedThread("settled-child", { creationSource: "mcp", lineage: { parentThreadId: "settled-parent", rootThreadId: "settled-parent", relationshipToParent: "subagent" } });
    const orphanChild = limitedThread("orphan-child", { creationSource: "mcp", lineage: { parentThreadId: "archived-parent", rootThreadId: "archived-parent", relationshipToParent: "subagent" } });
    const { codes, delivered } = await sweep([conductor, settledParent, lane, nested, providerChild, settledChild, orphanChild], { "claude-test-1": 200 });
    expect(codes).toEqual([0]);
    expect(delivered).toEqual([
      { threadId: "lane", text: "Continue where you left off.", continuesRunId: "run-lane" },
      { threadId: "nested", text: "Continue where you left off." },
    ]);
  });

  test("probes no provider while no thread waits on a limit", async () => {
    const { lines, proxy } = await sweep([limitedThread("g", { status: "completed" })], { "claude-test-1": 200 });
    expect(proxy.calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});
