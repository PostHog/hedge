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

const toolResult = (content: unknown) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_start", content }] } });
const startedInBackground = (id: string) => toolResult(`Command running in background with ID: ${id}. Output is being written to: /tmp/claude-1001/project/session/tasks/${id}.output. You will be notified when it completes.`);
const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_start</tool-use-id>\n<output-file>/tmp/claude-1001/project/session/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command "tests" ${status}</summary>\n</task-notification>`;
const agentLaunched = (id: string) => toolResult([{ type: "text", text: `Async agent launched successfully.\nagentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}' to continue this agent.)` }]);

function transcript(...entries: object[]) {
  const path = join(temp.make("transcript-"), "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

const defaultTranscript = () => transcript(
  startedInBackground(running),
  startedInBackground(finished),
  agentLaunched(subagent),
  { type: "user", message: { role: "user", content: notification(finished, "completed") } },
);

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

  test.each([{ taskId: running }, { taskIds: running }, { taskId: [running] }, { taskIds: [running, 7] }, {}])("refuses a call that does not pass taskIds as a list of IDs: %j", (input) => {
    expect(reason(input)).toContain('`{"taskIds": ["<id>"]}`');
  });

  test("refuses a wait on a background command that already finished, naming its output", () => {
    const text = reason({ taskIds: [finished] });
    expect(text).toContain(`\`${finished}\` already finished (completed)`);
    expect(text).toContain(outputFile);
  });

  test.each(["failed", "killed"])("counts a %s background command as finished", (status) => {
    const path = transcript(startedInBackground(finished), { type: "queue-operation", operation: "enqueue", content: notification(finished, status) });
    expect(reason({ taskIds: [finished] }, path)).toContain(`already finished (${status})`);
  });

  test("ignores a notification that only appears in a command, its output, or a message that quotes it", () => {
    const quoted = notification(running, "completed");
    const path = transcript(
      startedInBackground(running),
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_echo", name: "Bash", input: { command: `echo '${quoted}'` } }] } },
      toolResult(quoted),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: quoted }] } },
      { type: "user", message: { role: "user", content: `The last run said ${quoted}` } },
    );
    expect(waitOn({ taskIds: [running] }, path)).toBeUndefined();
  });

  test("refuses a subagent's ID with the next step", () => {
    const text = reason({ taskIds: [subagent] });
    expect(text).toContain(`\`${subagent}\` is a subagent`);
    expect(text).toContain("run_in_background: false");
  });

  test("refuses the ID of any subagent the transcript shows was launched", () => {
    expect(reason({ taskIds: ["agent-7"] }, transcript(agentLaunched("agent-7")))).toContain("`agent-7` is a subagent");
  });

  test("refuses a subagent's ID even without the transcript that launched it", () => {
    expect(reason({ taskIds: [subagent] }, transcript())).toContain("is a subagent");
  });

  test.each([delegated, "thread:delegated-task:command%3Amcp%3A1ed76b0f", "run:thread:thread%3Adelegated-task:ordinal:1"])("refuses a delegated task's ID with the next step: %s", (id) => {
    const text = reason({ taskIds: [id] });
    expect(text).toContain("is a delegated task");
    expect(text).toContain("t3_thread_wait");
  });

  test("names each wrong ID and the ones left to pass", () => {
    const text = reason({ taskIds: [running, finished, subagent] });
    expect(text).toContain(`\`${finished}\` already finished`);
    expect(text).toContain(`\`${subagent}\` is a subagent`);
    expect(text).toContain(`Pass only the IDs that still run: \`${running}\``);
  });

  test("lets a call that clears the wait through, whatever the IDs", () => {
    expect(waitOn({ taskIds: [finished, subagent], waiting: false })).toBeUndefined();
  });

  test("checks the tool under either spelling of the T3 server name", () => {
    expect(waitOn({ taskIds: [finished] }, defaultTranscript(), "mcp__t3_code__t3_background_wait")).toMatchObject({ permissionDecision: "deny" });
    expect(waitOn({ taskIds: [finished] }, defaultTranscript(), "mcp__other__t3_background_wait")).toBeUndefined();
  });
});
