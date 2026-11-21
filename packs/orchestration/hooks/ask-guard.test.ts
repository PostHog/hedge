import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AvailableSource } from "../../../src/pack/types.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../src/testing/packs.ts";
import { dispatch } from "../../base/hooks/run.ts";
import { asksForDecision } from "../lib/prose-question.ts";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { startT3Stub } from "../../../src/integrations/t3/testing.ts";
import { guardBackground, guardCard, guardSend, guardStop, hiddenIn, hook, hookWith, type IsHidden, type SendEvent, type SendGuardOptions, type StopEvent } from "./ask-guard.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const topLevel: IsHidden = async (threadId) => threadId === "top";
const claudePrompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const claudeSays = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const claudeAsks = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: {} }] } };
const claudeSaysThenAsks = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "t3", name: "AskUserQuestion", input: {} }] } });
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
const codexPrompt = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });
const codexSays = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const codexAsks = { type: "response_item", payload: { type: "function_call", name: "request_user_input", arguments: "{}" } };

function transcript(...lines: object[]) {
  const path = join(temp.make("transcript-"), "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function home(person?: string, settings: Record<string, unknown> = {}) {
  const dir = temp.make("home-");
  if (person) {
    mkdirSync(join(dir, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(dir, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.person": person, ...settings }));
  }
  return dir;
}

const proseTitles = { "orchestration.proseTitles": "⚠️, 🚨 , ✅ Workflows night" };

const stop = (event: StopEvent, threadId: string | undefined = "top", where = home("Robin")) => guardStop(event, where, threadId, topLevel);

describe("the prose question detector", () => {
  test.each([
    "Both PRs are green. Should I merge the bottom layer first?",
    "Which option do you prefer: A or B",
    "The stack is ready. Please send it when you're ready.",
    "The decision is on the map, ticket 4.",
    "Done with the review.\n\n**Want me to open the follow-up?**",
    "Let me know whether the timeout of 30 s is fine.",
    "I need your approval to delete the old branch.",
    "Three options:\n1. Retry\n2. Skip\n3. Revert\n\nWhich one?",
  ])("finds a decision for the person: %s", (message) => {
    expect(asksForDecision(message)).toBe(true);
  });

  test.each([
    "Merged both PRs. Nothing needs your decision.",
    "All checks pass and the PR is ready.",
    "The test asks:\n```\nwhy does it fail?\n```\nIt failed on a missing fixture, which I added.",
    "> Should we keep the flag?\n\nThe reviewer asked that; I kept the flag, as the spec says.",
    "Why did it fail? A missing fixture. I added it, and the suite passes now. Pushed the fix to the branch, and CI is green on the new head. The PR is ready for review and linked to this thread. "
      + "The next scheduled check runs tomorrow at 05:00 and needs nothing from anyone. ".repeat(10),
  ])("ignores a message that asks the person nothing: %s", (message) => {
    expect(asksForDecision(message)).toBe(false);
  });
});

describe("the ask guard", () => {
  test("blocks a top-level T3 thread once when its Claude turn ends on a prose decision, naming the person", async () => {
    const path = transcript(claudePrompt("Fix the flaky test"), claudeSays("Fixed. Should I also open the follow-up PR?"));
    const blocked = await stop({ transcript_path: path });
    expect(blocked).toEqual({ decision: "block", reason: expect.stringContaining("asks Robin a decision in prose") });
    expect(blocked!.reason).toContain("AskUserQuestion");
    expect(await stop({ transcript_path: path, stop_hook_active: true })).toBeUndefined();
  });

  test("blocks a Codex turn that ends on a prose decision", async () => {
    const path = transcript(codexPrompt("Fix it"), codexSays("Fixed. Do you want the follow-up too?"));
    expect(await stop({ transcript_path: path })).toMatchObject({ decision: "block" });
  });

  test("reads the last assistant message the event names before the transcript", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Do you want the follow-up too?"));
    expect(await stop({ transcript_path: path, last_assistant_message: "Fixed and pushed." })).toBeUndefined();
    const quiet = transcript(claudePrompt("Fix it"), claudeSays("Fixed and pushed."));
    expect(await stop({ transcript_path: quiet, last_assistant_message: "Shall I merge it?" })).toMatchObject({ decision: "block" });
  });

  test("names a fallback person without settings", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Shall I merge it?"));
    expect((await stop({ transcript_path: path }, "top", home()))!.reason).toContain("asks the person a decision");
  });

  test.each([
    ["Claude's question tool", [claudePrompt("Fix it"), claudeSays("Which one do you want?"), claudeAsks]],
    ["Claude's question tool in the same message", [claudePrompt("Fix it"), claudeSaysThenAsks("Which one do you want?")]],
    ["an MCP question tool", [claudePrompt("Fix it"), claudeSays("Which one do you want?"), { ...claudeAsks, message: { ...claudeAsks.message, content: [{ type: "tool_use", id: "t2", name: "mcp__t3__AskUserQuestion", input: {} }] } }]],
    ["Codex's question tool", [codexPrompt("Fix it"), codexSays("Which one do you want?"), codexAsks]],
  ])("lets the stop through when %s asks after the prose question", async (_, lines) => {
    expect(await stop({ transcript_path: transcript(...lines) })).toBeUndefined();
  });

  test("lets the stop through when the last message asks nothing", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I fix it? Yes, the spec says so."), claudeSays("Fixed and pushed."));
    expect(await stop({ transcript_path: path })).toBeUndefined();
  });

  test.each([
    ["an earlier Claude question tool call", [claudePrompt("Fix it"), claudeAsks, toolResult, claudeSays("Asked above. Should I wait?")]],
    ["an earlier Codex question tool call", [codexPrompt("Fix it"), codexAsks, codexSays("Which one do you want?")]],
    ["a message that only names the tool", [claudePrompt("Fix it"), claudeSays('I will call request_user_input(options). "name": "AskUserQuestion". Should I merge?')]],
    ["a tool result that names the tool", [claudePrompt("Fix it"), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: '"name": "AskUserQuestion"' }] } }, claudeSays("Should I merge?")]],
    ["a Codex call to another tool", [codexPrompt("Fix it"), codexSays("Which one do you want?"), { type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"echo request_user_input("}' } }]],
  ])("blocks a prose question that only %s precedes or names", async (_, lines) => {
    expect(await stop({ transcript_path: transcript(...lines) })).toMatchObject({ decision: "block" });
  });

  test("blocks a final message the event names even when the turn asked with the tool earlier", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeAsks, toolResult);
    expect(await stop({ transcript_path: path, last_assistant_message: "Done. Should I also open the follow-up?" })).toMatchObject({ decision: "block" });
  });

  test("counts only the current turn's question tool calls", async () => {
    const path = transcript(claudePrompt("Start"), claudeAsks, toolResult, claudePrompt("Now fix it"), claudeSays("Fixed. Should I merge?"));
    expect(await stop({ transcript_path: path })).toMatchObject({ decision: "block" });
  });

  test.each([
    ["a subagent thread", "child"],
    ["a session outside T3", ""],
  ])("lets %s stop on a prose question", async (_, threadId) => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    expect(await stop({ transcript_path: path }, threadId)).toBeUndefined();
  });

  test("lets the stop through when the transcript is missing or unreadable, or the input is not JSON", async () => {
    expect(await stop({})).toBeUndefined();
    expect(await stop({ transcript_path: join(temp.make("gone-"), "none.jsonl") })).toBeUndefined();
    expect(await hook("claude", async () => "not json", home())).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("outside T3, the installed hook finds no thread and lets the stop through", async () => {
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    const saved = process.env.T3CODE_THREAD_ID;
    delete process.env.T3CODE_THREAD_ID;
    try {
      expect(await hook("claude", async () => JSON.stringify({ transcript_path: path }), home())).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      if (saved !== undefined) process.env.T3CODE_THREAD_ID = saved;
    }
  });
});

describe("the hidden thread check", () => {
  const asker = "mcp:rfc-1";
  const question = "Here is the draft.\n\n1. Should I keep the hard cut on the homepage?";
  const delegated = { kind: "delegated_task", childThreadId: "thread:delegated-task:1" };
  const watched = (watch: Record<string, unknown>, state = "open") =>
    ({ pullRequests: [{ repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", snapshot: { state }, watch: { headSha: "abc", ...watch } }] });
  const check = (thread: Partial<ShellThread>, message = question, event: object = {}) => {
    const threads = [{ id: asker, title: "RFC", projectId: "p", status: "running", ...thread }] as ShellThread[];
    return guardStop({ transcript_path: transcript(claudePrompt("Draft it"), claudeSays(message)), ...event }, home("Robin"), "rfc-1", hiddenIn(async () => ({ threads })));
  };

  test("lets a prose question through when the thread lands in the person's inbox after the turn", async () => {
    expect(await check({})).toBeUndefined();
    expect(await check({ pendingBackgroundTasks: [{ kind: "command" }] })).toBeUndefined();
    expect(await check(watched({ passed: true, failedChecks: [] }))).toBeUndefined();
    expect(await check(watched({ passed: false, failedChecks: [] }, "merged"))).toBeUndefined();
    expect(await check({ snoozedUntil: "2020-01-01T00:00:00Z" })).toBeUndefined();
    expect(await check({ pendingBackgroundTasks: [delegated], lineage: { parentThreadId: "mcp:parent" } })).toBeUndefined();
  });

  test.each([
    ["snoozed", { snoozedUntil: "2999-01-01T00:00:00Z" }],
    ["waiting on a delegated task", { pendingBackgroundTasks: [delegated] }],
    ["waiting on an awaited monitor", { pendingBackgroundTasks: [{ kind: "monitor", awaited: true }] }],
    ["in a thread wait", { blockedOnThreadWait: true }],
    ["watching PR checks that still run", watched({ passed: false, failedChecks: [] })],
    ["watching a run that waits on an approval", watched({ passed: true, failedChecks: [], awaitingApproval: ["deploy"] })],
  ])("blocks a prose question while the thread is %s", async (_, thread) => {
    expect(await check(thread as Partial<ShellThread>)).toMatchObject({ decision: "block" });
  });

  test("blocks a prose question while Claude runs a background agent", async () => {
    expect(await check({}, question, { background_tasks: [{ id: "a1", type: "local_agent", status: "running" }] })).toMatchObject({ decision: "block" });
    expect(await check({}, question, { background_tasks: [{ id: "s1", type: "shell", status: "running" }] })).toBeUndefined();
  });

  test("tells a blocked agent that cannot ask on a card to write its complete reply again", async () => {
    const blocked = await check({ pendingBackgroundTasks: [delegated] });
    expect(blocked?.reason).toContain("complete reply again");
    expect(blocked?.reason).toContain("shows only the last message");
  });

  test.each(["⚠️ Hog worker crash loop", "⚠ Hog worker crash loop", "🚨 EU email send failures", "✅ Workflows night to Mon 23.11."])(
    "lets a prose question through in a thread whose title starts with a prose title, %s", async (title) => {
      const threads = [{ id: asker, title, projectId: "p", status: "running", snoozedUntil: "2999-01-01T00:00:00Z" }] as ShellThread[];
      const ends = (where: string) => guardStop({ transcript_path: transcript(claudePrompt("Triage it"), claudeSays(question)) }, where, "rfc-1", hiddenIn(async () => ({ threads })));
      expect(await ends(home("Robin", proseTitles))).toBeUndefined();
      expect(await ends(home("Robin"))).toMatchObject({ decision: "block" });
    });

  test("still blocks a prose question in a thread whose title only contains a prose title", async () => {
    const threads = [{ id: asker, title: "Fix the ⚠️ banner", projectId: "p", status: "running", snoozedUntil: "2999-01-01T00:00:00Z" }] as ShellThread[];
    const path = transcript(claudePrompt("Fix it"), claudeSays(question));
    expect(await guardStop({ transcript_path: path }, home("Robin", proseTitles), "rfc-1", hiddenIn(async () => ({ threads })))).toMatchObject({ decision: "block" });
  });

  test("lets the stop through when T3 cannot be read", async () => {
    const path = transcript(claudePrompt("Draft it"), claudeSays(question));
    expect(await guardStop({ transcript_path: path }, home("Robin"), "rfc-1", hiddenIn(async () => { throw new Error("T3 down"); }))).toBeUndefined();
  });
});

describe("the question guard workflow", () => {
  const plan = (workflows: Record<string, boolean> = {}, plans: "claude" | "codex" | "both" = "both") =>
    resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["pull-requests", "orchestration"], workflows, plan: plans }, devbox);

  test("installs the Stop hook by default, and the base pack routes Stop to it for Claude and Codex", () => {
    expect(plan().files.map((file) => file.target)).toContain(".config/hedge/hooks/Stop/ask-guard.ts");
    expect(plan({ "question-guard": false }).files.map((file) => file.target)).not.toContain(".config/hedge/hooks/Stop/ask-guard.ts");
    const stops = plan().config.filter((entry) => entry.key === "hooks.Stop");
    expect(stops.map((entry) => entry.provider).sort()).toEqual(["claude", "codex"]);
    for (const entry of stops) expect(JSON.stringify(entry.value)).toContain(`run.sh\\" ${entry.provider} Stop`);
  });

  test("installs the send guard as a PreToolUse hook, and the base pack routes PreToolUse to it for Claude and Codex", () => {
    expect(plan().files.map((file) => file.target)).toContain(".config/hedge/hooks/PreToolUse/ask-guard.ts");
    expect(plan({ "question-guard": false }).files.map((file) => file.target)).not.toContain(".config/hedge/hooks/PreToolUse/ask-guard.ts");
    const preToolUse = plan().config.filter((entry) => entry.key === "hooks.PreToolUse");
    expect(preToolUse.map((entry) => entry.provider).sort()).toEqual(["claude", "codex"]);
    for (const entry of preToolUse) expect(JSON.stringify(entry.value)).toContain(`run.sh\\" ${entry.provider} PreToolUse`);
  });

  test("the hook dispatcher hands the block to the agent as JSON", async () => {
    const where = home("Robin");
    const target = join(where, ".config/hedge/hooks/Stop/ask-guard.ts");
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(import.meta.dir, "ask-guard.ts"), target);
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    const result = await dispatch(dirname(target), "claude", JSON.stringify({ transcript_path: path }), async (hookPath, provider, input) => {
      expect(basename(hookPath)).toBe("ask-guard.ts");
      return { code: 0, stdout: `${JSON.stringify(await guardStop(JSON.parse(input), where, "top", topLevel))}\n`, stderr: provider === "claude" ? "" : "wrong provider" };
    });
    expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("asks Robin") });
  });
});

describe("the send guard", () => {
  const lane = "mcp:0aa3b648";
  const card = { id: "card-7", kind: "user_input" };
  const waiting: Partial<ShellThread> = { id: lane, activeRunId: "run-20", pendingRuntimeRequest: card };
  const t3 = (...threads: Partial<ShellThread>[]) => async () => ({ threads: threads as ShellThread[] });
  const send = (input: Record<string, unknown>, session = "conductor-session"): SendEvent =>
    ({ session_id: session, tool_name: "mcp__t3-code__t3_thread_send", tool_input: { threadId: "0aa3b648", message: "S1 pushed", ...input } });
  const guard = (event: SendEvent, options: Partial<SendGuardOptions> = {}) => guardSend(event, { home: home("Robin"), shell: t3(waiting), ...options });

  test("denies a steering send to a thread whose running turn waits on a question card, and says to queue it", async () => {
    const answer = await guard(send({ mode: "steer" }));
    expect(answer?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(answer!.hookSpecificOutput.permissionDecisionReason).toContain('mode: "queue"');
    expect(answer!.hookSpecificOutput.permissionDecisionReason).toContain("Robin");
  });

  test("lets the same send through when it comes again in the same session, and denies it once for another session", async () => {
    const where = home("Robin");
    expect(await guard(send({ mode: "steer" }), { home: where })).toBeDefined();
    expect(await guard(send({ mode: "steer" }), { home: where })).toBeUndefined();
    expect(await guard(send({ mode: "steer" }, "other-session"), { home: where })).toBeDefined();
    expect(await guard({ ...send({ mode: "steer" }), agent_id: "subagent-1" }, { home: where })).toBeDefined();
  });

  test("lets every send through while the kill switch file exists", async () => {
    const where = home("Robin");
    mkdirSync(join(where, ".config/hedge"), { recursive: true });
    writeFileSync(join(where, ".config/hedge/ask-guard.off"), "");
    expect(await guard(send({ mode: "auto" }), { home: where })).toBeUndefined();
  });

  test("lets the send through when T3 cannot be read", async () => {
    expect(await guard(send({ mode: "auto" }), { shell: async () => { throw new Error("T3 is down"); } })).toBeUndefined();
  });

  test("denies a different message from the same session again, and lets only the identical send through", async () => {
    const where = home("Robin");
    expect(await guard(send({ mode: "auto" }), { home: where })).toBeDefined();
    expect(await guard(send({ mode: "auto", message: "S2 pushed" }), { home: where })).toBeDefined();
    expect(await guard(send({ mode: "auto", message: "S2 pushed" }), { home: where })).toBeUndefined();
    expect(await guard(send({ mode: "auto", threadId: lane }), { home: where })).toBeUndefined();
  });

  test.each(["steer", "restart"])("lets a fresh-context send in mode %s through, as T3 queues it, and keeps the first denial for a later send", async (mode) => {
    const where = home("Robin");
    expect(await guard(send({ mode, freshContext: true }), { home: where })).toBeUndefined();
    expect(await guard(send({ mode }), { home: where })).toBeDefined();
  });

  test("denies a fresh-context send in mode auto or with no mode, as T3 steers it into the running turn", async () => {
    expect(await guard(send({ mode: "auto", freshContext: true }))).toBeDefined();
    expect(await guard(send({ freshContext: true }))).toBeDefined();
  });

  test("keys a card without an id on its running turn, so a new turn's card is denied again", async () => {
    const where = home("Robin");
    const unnamed = (run: string) => t3({ id: lane, activeRunId: run, pendingRuntimeRequest: { kind: "user_input" } });
    expect(await guard(send({ mode: "auto" }), { home: where, shell: unnamed("run-20") })).toBeDefined();
    expect(await guard(send({ mode: "auto" }), { home: where, shell: unnamed("run-20") })).toBeUndefined();
    expect(await guard(send({ mode: "auto" }), { home: where, shell: unnamed("run-21") })).toBeDefined();
  });

  test("forgets denials older than one day when it records a new one", async () => {
    const where = home("Robin");
    expect(await guard(send({ mode: "auto" }), { home: where })).toBeDefined();
    const records = join(where, ".local/state/hedge/ask-guard");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const record of readdirSync(records)) utimesSync(join(records, record), twoDaysAgo, twoDaysAgo);
    expect(await guard(send({ mode: "auto", message: "S2 pushed" }), { home: where })).toBeDefined();
    expect(await guard(send({ mode: "auto", message: "S2 pushed" }), { home: where })).toBeUndefined();
    expect(await guard(send({ mode: "auto" }), { home: where })).toBeDefined();
  });

  test("lets a send to another machine through even when a local thread shares its id, and denies one that names this machine", async () => {
    const where = home("Robin");
    mkdirSync(join(where, ".t3/userdata"), { recursive: true });
    writeFileSync(join(where, ".t3/userdata/environment-id"), "local-env\n");
    expect(await guard(send({ mode: "auto", environmentId: "remote-env" }), { home: where })).toBeUndefined();
    expect(await guard(send({ mode: "auto", environmentId: "local-env" }), { home: where })).toBeDefined();
  });

  test("lets a queued send through", async () => {
    expect(await guard(send({ mode: "queue" }))).toBeUndefined();
  });

  test.each([
    ["an idle thread with a card", { id: lane, activeRunId: null, pendingRuntimeRequest: card }],
    ["a running thread with no card", { id: lane, activeRunId: "run-20", pendingRuntimeRequest: null }],
    ["a running thread waiting on an approval", { id: lane, activeRunId: "run-20", pendingRuntimeRequest: { id: "approval-1", kind: "approval" } }],
  ])("lets a send to %s through", async (_, thread) => {
    expect(await guard(send({ mode: "auto" }), { shell: t3(thread) })).toBeUndefined();
  });

  test("lets the send through when the guard cannot write its state", async () => {
    const where = home("Robin");
    writeFileSync(join(where, ".local/state/hedge/ask-guard"), "");
    expect(await guard(send({ mode: "auto" }), { home: where })).toBeUndefined();
  });

  test("the installed hook sends a thread send to the send guard and a stop to the prose guard", async () => {
    const where = home("Robin");
    const routed = hookWith(() => t3(waiting));
    const denied = await routed("codex", async () => JSON.stringify({ ...send({ mode: "auto" }), tool_name: "mcp__t3_code__t3_thread_send" }), where);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await routed("claude", async () => JSON.stringify({ ...send({ mode: "auto" }), tool_name: "Bash" }), where)).toEqual({ code: 0, stdout: "", stderr: "" });
    const path = transcript(claudePrompt("Fix it"), claudeSays("Should I merge?"));
    expect(await routed("claude", async () => JSON.stringify({ transcript_path: path }), where)).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("outside T3, the installed hook lets a send through", async () => {
    expect(await hook("claude", async () => JSON.stringify(send({ mode: "auto" })), home())).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("the installed hook still denies a send when T3 session revocation fails after the shell read", async () => {
    const stub = await startT3Stub({ shell: { projects: [], threads: [{ ...waiting, title: "Lane", projectId: "p", status: "running", pullRequests: [] }] } as never });
    try {
      const cliPath = join(stub.home, "t3-server.js");
      writeFileSync(cliPath, (await Bun.file(cliPath).text()).replace("esac", '  *"auth session revoke"*) exit 1 ;;\nesac'));
      const result = await hook("claude", async () => JSON.stringify(send({ mode: "auto" })), stub.home);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      expect((await stub.cliCalls()).some((line) => line.includes("auth session revoke"))).toBe(true);
    } finally {
      await stub.stop();
    }
  });

  test("the PreToolUse dispatcher hands the denial to the agent", async () => {
    const where = home("Robin");
    const target = join(where, ".config/hedge/hooks/PreToolUse/ask-guard.ts");
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(import.meta.dir, "ask-guard.ts"), target);
    const routed = hookWith(() => t3(waiting));
    const result = await dispatch(dirname(target), "codex", JSON.stringify(send({ mode: "steer" })), async (_path, provider, input) => routed(provider, async () => input, where));
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining('mode: "queue"') });
  });
});

const started = (id: string) => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command: "bun run check", run_in_background: true } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output.` }] }, toolUseResult: { backgroundTaskId: id } },
];
const running = (id: string, type = "shell") => ({ id, type, status: "running" });

describe("the card guard", () => {
  const alertThread = { id: "mcp:alert-1", title: "🚨 EU email send failures", projectId: "p", status: "running" };
  const t3 = (...threads: Partial<ShellThread>[]) => async () => ({ threads: threads as ShellThread[] });
  const asked = {
    AskUserQuestion: { questions: [{ question: "Roll the fix back?", header: "Rollback", multiSelect: false, options: [{ label: "Roll back", description: "Undo the deploy" }, { label: "Keep it", description: "Watch for an hour" }] }] },
    request_user_input: { questions: [{ id: "rollback", header: "Rollback", question: "Roll the fix back?", options: [{ label: "Roll back", description: "Undo the deploy" }, { label: "Keep it", description: "Watch for an hour" }] }] },
  } as Record<string, unknown>;
  const card = (tool = "AskUserQuestion"): SendEvent => ({ session_id: "s", tool_name: tool, tool_input: (asked[tool] ?? {}) as Record<string, unknown> });
  const guard = (event: SendEvent, where: string, threadId: string | undefined = "alert-1", shell = t3(alertThread)) => guardCard(event, { home: where, shell }, threadId);

  test.each(["AskUserQuestion", "request_user_input"])("denies %s in a thread whose title starts with a prose title, and says to ask in the last message", async (tool) => {
    const answer = await guard(card(tool), home("Robin", proseTitles));
    expect(answer?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(answer!.hookSpecificOutput.permissionDecisionReason).toContain("last message");
  });

  test.each([
    ["in a thread with another title", () => guard(card(), home("Robin", proseTitles), "alert-1", t3({ ...alertThread, title: "RFC" }))],
    ["without the setting", () => guard(card(), home("Robin"))],
    ["outside T3", () => guardCard(card(), { home: home("Robin", proseTitles), shell: t3(alertThread) }, undefined)],
    ["when T3 cannot be read", () => guard(card(), home("Robin", proseTitles), "alert-1", async () => { throw new Error("T3 down"); })],
    ["for a tool that is not a question tool", () => guard({ ...card("Bash"), tool_input: { command: "ls" } }, home("Robin", proseTitles))],
  ] as const)("lets a card through %s", async (_, answer) => {
    expect(await answer()).toBeUndefined();
  });

  test("lets every card through while the kill switch file exists", async () => {
    const where = home("Robin", proseTitles);
    mkdirSync(join(where, ".config/hedge"), { recursive: true });
    writeFileSync(join(where, ".config/hedge/ask-guard.off"), "");
    expect(await guard(card(), where)).toBeUndefined();
  });

  test.each([["claude", "AskUserQuestion"], ["codex", "request_user_input"]])("the %s PreToolUse dispatcher runs the installed hook, which reads T3 and denies the card", async (provider, tool) => {
    const stub = await startT3Stub({ shell: { projects: [], threads: [{ ...alertThread, pullRequests: [] }] } as never });
    try {
      mkdirSync(join(stub.home, ".local/state/hedge"), { recursive: true });
      writeFileSync(join(stub.home, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.person": "Robin", ...proseTitles }));
      const target = join(stub.home, ".config/hedge/hooks/PreToolUse/ask-guard.ts");
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(join(import.meta.dir, "ask-guard.ts"), target);
      const installed = async (path: string, from: string, input: string) => {
        const child = Bun.spawn([process.execPath, path, from], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: stub.home, T3CODE_THREAD_ID: "alert-1" } });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code, stdout, stderr };
      };
      const result = await dispatch(dirname(target), provider, JSON.stringify(card(tool)), installed);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("last message") });
    } finally {
      await stub.stop();
    }
  });
});

describe("the background work guard", () => {
  const waitOn = (...taskIds: string[]) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_wait", name: "mcp__t3-code__t3_background_wait", input: { taskIds } }] } });
  const background = (lines: object[], inFlight: object[], extra: object = {}, threadId = "lane") =>
    guardBackground({ transcript_path: transcript(claudePrompt("Run the gate"), ...lines), background_tasks: inFlight, ...extra }, home("Robin"), threadId || undefined);

  test("sends back a turn that leaves its background shell task running with nothing waiting on it", async () => {
    const blocked = await background([...started("bgate1"), claudeSays("Done.")], [running("bgate1")]);
    expect(blocked?.reason).toContain('t3_background_wait with taskIds ["bgate1"]');
    expect(blocked?.reason).toContain("ask Robin");
  });

  test("names only the task nothing waits on", async () => {
    const blocked = await background([...started("bgate1"), ...started("btest2"), waitOn("btest2"), claudeSays("Done.")], [running("bgate1"), running("btest2")]);
    expect(blocked?.reason).toContain('taskIds ["bgate1"]');
  });

  test.each([
    ["the task ended", [...started("bgate1"), claudeSays("Done.")], [], {}, "lane"],
    ["a wait names it", [...started("bgate1"), waitOn("bgate1"), claudeSays("Done.")], [running("bgate1")], {}, "lane"],
    ["an earlier turn started it", [...started("bold1"), claudePrompt("Next"), claudeSays("Done.")], [running("bold1")], {}, "lane"],
    ["only a subagent runs", [claudeSays("Done.")], [running("a1", "subagent")], {}, "lane"],
    ["the stop was sent back once", [...started("bgate1"), claudeSays("Done.")], [running("bgate1")], { stop_hook_active: true }, "lane"],
    ["the session is outside T3", [...started("bgate1"), claudeSays("Done.")], [running("bgate1")], {}, ""],
  ] as const)("lets the stop through when %s", async (_, lines, inFlight, extra, threadId) => {
    expect(await background([...lines], [...inFlight], extra, threadId)).toBeUndefined();
  });
});
