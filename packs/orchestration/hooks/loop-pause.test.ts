import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const qualityRun = "Run one coordinator run of the `quality-loop` skill for Payments in acme/app. Follow the skill's steps in order.";
const signalRound = "Run one coordinator round of the signal-loop skill. Read every value in ~/.agents/guides/skill-settings.md first.";
const claudePrompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const claudeMeta = { type: "user", isMeta: true, message: { role: "user", content: "Caveat: local command output follows." } };
const claudeSays = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const codexPrompt = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });
const codexMessage = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const codexInstructions = codexMessage("# AGENTS.md instructions for /home/robin/app\n\n<INSTRUCTIONS>\nRun one coordinator run of the quality-loop skill when asked.\n</INSTRUCTIONS>");
const delegate = "mcp__t3-code__delegate_task";

function machine(limits: string | undefined, settings: Record<string, unknown> = { "orchestration.loopLedger": "~/ledger" }) {
  const home = temp.make("home-");
  mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(home, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.person": "Robin", ...settings }));
  mkdirSync(join(home, "ledger"));
  if (limits !== undefined) writeFileSync(join(home, "ledger/limits.md"), limits);
  return home;
}

function transcript(...lines: object[]) {
  const path = join(temp.make("transcript-"), "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function answer(home: string, tool: string, lines: object[], provider = "claude") {
  const input = JSON.stringify({ tool_name: tool, tool_input: { prompt: "Lane L065" }, transcript_path: transcript(...lines) });
  const run = spawnSync(process.execPath, [join(import.meta.dir, "loop-pause.ts"), provider], { input, env: { PATH: process.env.PATH, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim() ? JSON.parse(run.stdout).hookSpecificOutput : undefined;
}

const paused = "Quality loop WIP: 2\nPaused: yes\n";

describe("the loop pause guard", () => {
  test.each([
    ["a scheduled quality-loop coordinator", [claudeMeta, claudePrompt(qualityRun), claudeSays("Loading the ledger.")], "claude"],
    ["a signal-loop coordinator in Codex", [codexPrompt(signalRound)], "codex"],
    ["a signal-loop coordinator in a Codex session that logs its prompt only as a message", [{ type: "session_meta", payload: { id: "s1" } }, codexInstructions, codexMessage(signalRound)], "codex"],
    ["a scheduled coordinator whose prompt opens with T3's note on who sent it", [claudePrompt(`[T3 Code: scheduled task "nightly-quality-loop" sent this prompt, not the user typing in this chat.]\n\n${qualityRun}`)], "claude"],
    ["a coordinator started with the skill's slash command", [claudePrompt("<command-name>/quality-loop</command-name>")], "claude"],
    ["a coordinator started with the slash command as Claude logs it", [claudePrompt("<command-message>quality-loop is running…</command-message>\n<command-name>/quality-loop</command-name>\n<command-args></command-args>")], "claude"],
    ["a coordinator asked with the loop named first", [claudePrompt("Run a quality-loop coordinator round for Payments.")], "claude"],
    ["a coordinator woken later by a lane's end", [claudePrompt(qualityRun), claudeSays("Lanes started."), claudePrompt("Lane L064 ended.")], "claude"],
  ])("refuses a new lane from %s while the ledger pauses the loops", (_, lines, provider) => {
    expect(answer(machine(paused), delegate, lines, provider)).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("Paused: yes"),
    });
  });

  test("tells the coordinator to settle and keep its watches instead", () => {
    expect(answer(machine(paused), delegate, [claudePrompt(qualityRun)]).permissionDecisionReason).toContain("keep every watch and post-deploy check, record a no-op run, and start no lane");
  });

  test("lets a coordinator start lanes while the loops run", () => {
    expect(answer(machine("Paused: no\n"), delegate, [claudePrompt(qualityRun)])).toBeUndefined();
  });

  test("fails closed when the coordinator's limits file cannot be read", () => {
    expect(answer(machine(undefined), delegate, [claudePrompt(qualityRun)])).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("cannot be read") });
  });

  test.each(["mcp__t3-code__t3_thread_send", "mcp__t3-code__watch_pull_request", "mcp__t3-code__schedule_task", "Bash"])("lets a paused coordinator settle lanes and keep watches with %s", (tool) => {
    expect(answer(machine(paused), tool, [claudePrompt(qualityRun)])).toBeUndefined();
  });

  test.each([
    ["a thread that is no loop coordinator", [claudePrompt("Fix the login redirect and open a draft PR.")]],
    ["a lane of the loop", [claudePrompt("You are quality-loop lane L064. Ship one PR for the cover stage of billing.")]],
    ["a Codex lane whose project instructions mention a coordinator run", [codexInstructions, codexMessage("You are signal-loop lane L070. Ship one fix PR.")]],
    ["a thread that asks about a coordinator run instead of for one", [claudePrompt("Audit last night's quality-loop coordinator run and list its lanes.")]],
    ["a thread that pastes a slash command below its own task", [claudePrompt("Explain why this stalled:\n<command-name>/quality-loop</command-name>")]],
    ["a thread that quotes a coordinator prompt below its own task", [claudePrompt(`Create the nightly schedules on this machine.\n\n1. Title \`Quality loop\`. Prompt:\n\n${qualityRun}`)]],
    ["a thread that mentions a coordinator only after its first prompt", [claudePrompt("Summarize last night's PRs."), claudePrompt(qualityRun)]],
  ])("lets %s start subthreads while the loops are paused", (_, lines) => {
    expect(answer(machine(paused), delegate, lines)).toBeUndefined();
  });

  test("leaves the loops alone on a machine where the ledger directory does not exist", () => {
    expect(answer(machine(paused, { "orchestration.loopLedger": "~/no-such-ledger" }), delegate, [claudePrompt(qualityRun)])).toBeUndefined();
  });

  test("leaves the loops alone on a machine without a loop ledger setting", () => {
    expect(answer(machine(paused, {}), delegate, [claudePrompt(qualityRun)])).toBeUndefined();
  });
});
