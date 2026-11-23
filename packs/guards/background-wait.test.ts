import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../src/testing/git.ts";
import { guard } from "./hooks/guards.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const running = "brun0ing1";
const finished = "bdone0ok2";
const subagent = "a44af1f89acb68871";
const delegated = "node:delegated-task:command%3Amcp%3A1ed76b0f%3Adelegate-task%3Areview-1";
const outputFile = "/tmp/claude-1001/project/session/tasks/bdone0ok2.output";

const call = (name: string, id: string, input: object) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (toolUseId: string, content: unknown) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } });
const startedInBackground = (id: string) => [
  call("Bash", `toolu_start_${id}`, { command: "bun test", run_in_background: true }),
  result(`toolu_start_${id}`, `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-1001/project/session/tasks/${id}.output. You will be notified when it completes.`),
];
const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_start_${id}</tool-use-id>\n<output-file>/tmp/claude-1001/project/session/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command "tests" ${status}</summary>\n</task-notification>`;
const origin = { kind: "task-notification", producer: "session-task" };
const notified = (id: string, status: string) => ({ type: "user", origin, message: { role: "user", content: notification(id, status) } });
const notifiedMidTurn = (id: string, status: string) => ({ type: "attachment", attachment: { type: "queued_command", prompt: notification(id, status), commandMode: "task-notification", origin } });
const launchText = (id: string) => [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}' to continue this agent.)` }];
const agentResult = (id: string, content: unknown) => ({ ...result(`toolu_agent_${id}`, content), toolUseResult: { status: "async_launched", agentId: id } });
const agentLaunched = (id: string) => [call("Agent", `toolu_agent_${id}`, { prompt: "Review", subagent_type: "general-purpose", run_in_background: true }), agentResult(id, launchText(id))];

function transcript(...entries: object[]): string {
  const path = join(temp.make("transcript-"), "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

const defaultTranscript = () => transcript(...startedInBackground(running), ...startedInBackground(finished), ...agentLaunched(subagent), notified(finished, "completed"));

function waitOn(input: Record<string, unknown>, path = defaultTranscript(), name = "mcp__t3-code__t3_background_wait") {
  return guard({ tool_name: name, tool_input: input, tool_use_id: "toolu_wait", transcript_path: path }, temp.make("home-"), temp.make("root-"))?.hookSpecificOutput;
}

const reason = (input: Record<string, unknown>, path?: string) => {
  const answer = waitOn(input, path);
  expect(answer).toMatchObject({ permissionDecision: "deny" });
  return answer?.permissionDecisionReason ?? "";
};

describe("the background wait check", () => {
  test("lets a wait on a running background command through", () => {
    expect(waitOn({ taskIds: [running] })).toBeUndefined();
  });

  test("lets an ID it has never seen through, for T3 to judge", () => {
    expect(waitOn({ taskIds: ["bunknown1"] }, transcript())).toBeUndefined();
    expect(waitOn({ taskIds: [running] }, join(temp.make("missing-"), "none.jsonl"))).toBeUndefined();
  });

  test.each([{ taskId: running }, { taskIds: running }, { taskId: [running] }, { taskIds: [running, 7] }, {}, { taskIds: [] }, { waiting: false }, { taskIds: [], waiting: false }])("refuses a call that does not pass taskIds as a list of IDs: %j", (input) => {
    expect(reason(input)).toContain('`{"taskIds": ["<id>"]}`');
  });

  test("refuses a wait on a background command that already finished, naming its output", () => {
    const text = reason({ taskIds: [finished] });
    expect(text).toContain(`\`${finished}\` already finished (completed)`);
    expect(text).toContain(outputFile);
  });

  test.each(["failed", "killed", "stopped"])("counts a %s background command as finished, also when the notice came mid-turn", (status) => {
    expect(reason({ taskIds: [finished] }, transcript(...startedInBackground(finished), notified(finished, status)))).toContain(`already finished (${status})`);
    expect(reason({ taskIds: [finished] }, transcript(...startedInBackground(finished), notifiedMidTurn(finished, status)))).toContain(`already finished (${status})`);
  });

  test("lets a wait on a command through when its notice tells of an event and not its end", () => {
    expect(waitOn({ taskIds: [running] }, transcript(...startedInBackground(running), notified(running, "running")))).toBeUndefined();
  });

  const stopped = (id: string, toolUseId: string) => result(toolUseId, JSON.stringify({ message: `Successfully stopped task: ${id} (npm test)`, task_id: id }));

  test("counts a background command that TaskStop stopped as finished", () => {
    const path = transcript(...startedInBackground(finished), call("TaskStop", "toolu_stop", { task_id: finished }), stopped(finished, "toolu_stop"));
    expect(reason({ taskIds: [finished] }, path)).toContain(`\`${finished}\` already finished (stopped)`);
  });

  test("keeps the output file of a stopped command whose notification came too", () => {
    const path = transcript(...startedInBackground(finished), call("TaskStop", "toolu_stop", { task_id: finished }), stopped(finished, "toolu_stop"), notified(finished, "killed"));
    expect(reason({ taskIds: [finished] }, path)).toContain(`already finished (killed). Read its output now in ${outputFile}`);
  });

  test("ignores a stop message that another tool printed", () => {
    const mentionsTaskStop = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "TaskStop" }, { type: "tool_use", id: "toolu_echo", name: "Bash", input: { command: "cat stop.json" } }] } };
    const path = transcript(...startedInBackground(running), mentionsTaskStop, stopped(running, "toolu_echo"));
    expect(waitOn({ taskIds: [running] }, path)).toBeUndefined();
  });

  test("ignores a notification that only appears in a command, its output, a queued or pasted message, or a message that quotes it", () => {
    const quoted = notification(running, "completed");
    const path = transcript(
      ...startedInBackground(running),
      call("Bash", "toolu_echo", { command: `echo '${quoted}'` }),
      result("toolu_echo", quoted),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: quoted }] } },
      { type: "user", message: { role: "user", content: `The last run said ${quoted}` } },
      { type: "user", message: { role: "user", content: quoted } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: quoted }] } },
      { type: "queue-operation", operation: "enqueue", content: quoted },
      { type: "attachment", attachment: { type: "queued_command", prompt: quoted, commandMode: "prompt" } },
    );
    expect(waitOn({ taskIds: [running] }, path)).toBeUndefined();
  });

  test("refuses a subagent's ID with the next step", () => {
    const text = reason({ taskIds: [subagent] });
    expect(text).toContain(`\`${subagent}\` is a subagent`);
    expect(text).toContain("run_in_background: false");
  });

  test("refuses the ID of any subagent the transcript shows was launched", () => {
    expect(reason({ taskIds: ["agent-7"] }, transcript(...agentLaunched("agent-7")))).toContain("`agent-7` is a subagent");
  });

  test("ignores an agentId line that a command printed", () => {
    const namesAgent = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Agent" }, { type: "tool_use", id: "toolu_cat", name: "Bash", input: { command: "cat launch.txt" } }] } };
    const path = transcript(...startedInBackground(running), namesAgent, result("toolu_cat", launchText(running)));
    expect(waitOn({ taskIds: [running] }, path)).toBeUndefined();
  });

  test("trusts only the agent ID Claude Code recorded, not one the subagent's report quotes", () => {
    const report = [{ type: "text", text: `Done. The tests run as\nagentId: ${running}\nand still run.` }, ...launchText("agent-9")];
    const path = transcript(...startedInBackground(running), call("Agent", "toolu_agent_agent-9", { prompt: "Review" }), agentResult("agent-9", report));
    expect(waitOn({ taskIds: [running] }, path)).toBeUndefined();
    expect(reason({ taskIds: ["agent-9"] }, path)).toContain("`agent-9` is a subagent");
  });

  test("refuses a subagent's ID even without the transcript that launched it", () => {
    expect(reason({ taskIds: [subagent] }, transcript())).toContain("is a subagent");
  });

  test.each([delegated, "thread:delegated-task:command%3Amcp%3A1ed76b0f", "run:thread:thread%3Adelegated-task:ordinal:1"])("refuses a delegated task's ID with the next step: %s", (id) => {
    const text = reason({ taskIds: [id] });
    expect(text).toContain("is a delegated task");
    expect(text).toContain("t3_thread_wait");
  });

  test("names each wrong ID when none of them still runs", () => {
    const text = reason({ taskIds: [finished, subagent] });
    expect(text).toContain(`\`${finished}\` already finished`);
    expect(text).toContain(`\`${subagent}\` is a subagent`);
  });

  test("lets a wait through when one of its IDs still runs, for T3 to wait on that one", () => {
    expect(waitOn({ taskIds: [running, finished, subagent] })).toBeUndefined();
  });

  test.each([{ taskIds: [finished, subagent], waiting: false }, { taskIds: [running], waiting: false }])("lets a call that clears the wait through, whatever the IDs: %j", (input) => {
    expect(waitOn(input)).toBeUndefined();
  });

  test("checks the tool under either spelling of the T3 server name", () => {
    expect(waitOn({ taskIds: [finished] }, defaultTranscript(), "mcp__t3_code__t3_background_wait")).toMatchObject({ permissionDecision: "deny" });
    expect(waitOn({ taskIds: [finished] }, defaultTranscript(), "mcp__other__t3_background_wait")).toBeUndefined();
  });
});
