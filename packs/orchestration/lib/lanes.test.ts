import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { startT3Stub, ToolRefusal, type T3Fixture, type T3Stub } from "../../base/lib/t3/testing.ts";
import { fakeGitHub, linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, now, shellThread } from "./testing.ts";
import { needsHuman, runLanes } from "./lanes.ts";
import type { Discussion, IssueNode } from "./wayfinder.ts";

const command = join(import.meta.dir, "..", "commands", "lanes.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stub(fixture: T3Fixture): Promise<T3Stub> {
  const started = await startT3Stub(fixture);
  cleanups.push(() => started.stop());
  return started;
}

type Ticket = { number: number; thread?: string; state?: string; labels?: string[]; assignees?: string[] };

const tickets: Ticket[] = [
  { number: 2, thread: "mcp:local-lane" },
  { number: 3, thread: "mcp:linked-stalled" },
  { number: 4, thread: "mcp:linked-waiting" },
  { number: 5, thread: "mcp:linked-archived" },
  { number: 6, thread: "linked-finished" },
  { number: 7, thread: "mcp:nowhere" },
  { number: 8, thread: "mcp:linked-busy" },
  { number: 9, thread: "mcp:linked-finished", state: "CLOSED" },
  { number: 10, thread: "mcp:linked-finished", labels: ["wayfinder:task", "wayfinder:awaiting-human"] },
  { number: 11, thread: "mcp:local-grilling", labels: ["wayfinder:grilling"] },
];

function issue(ticket: Ticket): IssueNode {
  return {
    number: ticket.number, title: `Ticket ${ticket.number}`, state: ticket.state ?? "OPEN", repository: "acme/maps",
    assignees: ticket.assignees ?? ["someone"], labels: ticket.labels ?? ["wayfinder:task"], blockedBy: [], childCount: 0, children: [],
  };
}

function discussion(ticket: Ticket): Discussion {
  const body = `<!-- orchestration-wayfinder-dispatch -->\nDispatched.\nThread: \`${ticket.thread}\``;
  return { body: "", comments: ticket.thread ? [{ author: "someone", body, url: `https://github.com/acme/maps/issues/${ticket.number}#c`, createdAt: minutesAgo(500) }] : [] };
}

const map: IssueNode = { ...issue({ number: 1, labels: ["wayfinder:map"] }), childCount: tickets.length, children: tickets.map(issue) };

const fixture: T3Fixture = {
  shell: {
    projects: [],
    threads: [
      shellThread("mcp:local-lane", { status: "completed", latestRunCompletedAt: minutesAgo(20) }),
      shellThread("mcp:local-grilling", { status: "completed", latestRunCompletedAt: minutesAgo(20) }),
    ],
  },
  turnItems: {
    "mcp:local-lane": [
      { item: { type: "user_message", text: "Go", startedAt: minutesAgo(60) } },
      { item: { type: "assistant_message", text: "I stopped here.\n**NEEDS_HUMAN: pick a name**", startedAt: minutesAgo(20) } },
    ],
  },
  links: [linkedEnvironment],
  tools: linkedTools([
    linkedThread("mcp:linked-stalled", { status: "running", updatedAt: minutesAgo(45) }),
    linkedThread("mcp:linked-waiting", { status: "waiting", updatedAt: minutesAgo(1), pendingRequestCount: 1 }),
    linkedThread("mcp:linked-archived", { archived: true }),
    linkedThread("mcp:linked-finished", { status: "completed", items: [linkedItem("user_message", "Go"), linkedItem("assistant_message", "All done.\nNEEDS_HUMAN: is a quote here, not at the end\nDone.")] }),
    linkedThread("mcp:linked-busy", { status: "completed", updatedAt: minutesAgo(200) }),
    linkedThread("mcp:linked-busy-child", { status: "running", parentThreadId: "mcp:linked-busy", updatedAt: minutesAgo(3) }),
  ]),
};

const expected = (host: string) => [
  "Lanes of acme/maps#1 that need attention:",
  `  #2 task needs the human: pick a name. Ask them with the question tool, then send the answer to its thread. Thread mcp:local-lane on ${host}.`,
  "  #3 task stalled: running with no activity for 45m. Read its thread, and stop it when it is past its cap. Thread mcp:linked-stalled on devbox-2.",
  "  #4 task blocked: waits on an approval or an answer nobody sees in thread mcp:linked-waiting. Thread mcp:linked-waiting on devbox-2.",
  "  #5 task gone: its thread is archived or deleted. Reconcile the ticket as an orphaned lane. Thread mcp:linked-archived on devbox-2.",
  "  #6 task finished: ended its turn with the ticket open. Read its result and act on it. Thread linked-finished on devbox-2.",
  "  #7 task gone: no box has its thread mcp:nowhere. Reconcile the ticket as an orphaned lane.",
];

test("hedge lanes finds each lane on this machine or a linked environment and names the ones that need the conductor", async () => {
  const t3 = await stub(fixture);
  const lines: string[] = [];
  const fetchIssue = async (_owner: string, _repo: string, number: number) => (number === 1 ? map : issue(tickets.find((ticket) => ticket.number === number)!));
  const fetchDiscussion = async (_owner: string, _repo: string, number: number) => discussion(tickets.find((ticket) => ticket.number === number)!);

  const code = await runLanes(["https://github.com/acme/maps/issues/1"], { home: t3.home, host: "this-box", now, fetchIssue, fetchDiscussion, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(expected("this-box").join("\n"));
  expect(code).toBe(1);
  expect(t3.toolCalls.every(({ args }) => args.environmentId === "env-linked")).toBe(true);
});

test("hedge lanes runs as a pack command against GitHub through gh and the local T3 server, over GraphQL and, once its rate limit is spent, over REST", async () => {
  const notice = "hedge: GitHub's GraphQL rate limit is spent, so this command reads issues over REST.\n";
  for (const graphqlError of [undefined, "API rate limit already exceeded for user ID 1."]) {
    const t3 = await stub({ ...fixture, tools: linkedTools([linkedThread("mcp:linked-finished", { status: "completed", items: [linkedItem("assistant_message", "Done.")] })]) });
    const shown = [{ number: 2, thread: "mcp:local-lane" }, { number: 6, thread: "linked-finished" }];
    const discussions = Object.fromEntries(shown.map((ticket) => [`acme/maps#${ticket.number}`, discussion(ticket)]));
    const bin = await fakeGitHub(t3.home, { issues: [{ ...map, childCount: 2, children: shown.map(issue) }], discussions, graphqlError, restPageSize: 1 });

    const child = Bun.spawn(["bun", command, "acme/maps#1", "--stall", "60"], { env: { ...Bun.env, HOME: t3.home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: "{}" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    expect(stderr).toBe(graphqlError ? notice : "");
    expect(stdout).toBe(`${[expected(hostname())[0], expected(hostname())[1], expected(hostname())[5]].join("\n")}\n`);
    expect(code).toBe(1);
  }
});

async function laneReport(fixture: T3Fixture, laneTickets: Ticket[]) {
  const t3 = await stub(fixture);
  const lines: string[] = [];
  const laneMap = { ...map, childCount: laneTickets.length, children: laneTickets.map(issue) };
  const code = await runLanes(["acme/maps#1"], {
    home: t3.home, host: "this-box", now, print: (line) => lines.push(line),
    fetchIssue: async (_owner, _repo, number) => (number === 1 ? laneMap : issue(laneTickets.find((ticket) => ticket.number === number)!)),
    fetchDiscussion: async (_owner, _repo, number) => discussion(laneTickets.find((ticket) => ticket.number === number)!),
  });
  return { code, output: lines.join("\n"), t3 };
}

test("a linked environment that fails to read a lane is named as not answering, and the lane is not called gone", async () => {
  const tools = linkedTools([linkedThread("mcp:linked-flaky", { status: "completed" })]);
  const { code, output } = await laneReport({ shell: { projects: [], threads: [] }, links: [linkedEnvironment], tools(name, args) {
    if (name === "t3_thread_read") throw new ToolRefusal("orchestration_error", "The linked environment answered HTTP 503.");
    return tools(name, args);
  } }, [{ number: 2, thread: "mcp:linked-flaky" }]);

  expect(output).toBe("devbox-2 did not answer: The linked environment answered HTTP 503.");
  expect(code).toBe(1);
});

test("a lane's final message longer than one read still shows the ask on its last line", async () => {
  const long = `${"x".repeat(60_000)}\nNEEDS_HUMAN: pick a region`;
  const { output, t3 } = await laneReport({ shell: { projects: [], threads: [] }, links: [linkedEnvironment], tools: linkedTools([
    linkedThread("mcp:linked-long", { status: "completed", itemCount: 60, items: [
      ...Array.from({ length: 58 }, (_, index) => linkedItem("tool_call", `step ${index}`, { itemId: `step-${index}` })),
      linkedItem("user_message", "Go", { itemId: "ask" }), linkedItem("assistant_message", long, { itemId: "final" }),
    ] }),
  ]) }, [{ number: 2, thread: "mcp:linked-long" }]);

  expect(output).toBe("Lanes of acme/maps#1 that need attention:\n  #2 task needs the human: pick a region. Ask them with the question tool, then send the answer to its thread. Thread mcp:linked-long on devbox-2.");
  expect(t3.toolCalls.filter(({ name, args }) => name === "t3_thread_read" && args.itemId).map(({ args }) => [args.itemId, args.textOffset])).toEqual([["final", 50_000]]);
});

test("hedge lanes refuses a bad map or stall, and says when no lane needs attention", async () => {
  const t3 = await stub({ shell: { projects: [], threads: [] } });
  const io = { home: t3.home, host: "this-box", now, print: () => {}, fetchIssue: async () => ({ ...map, children: [] }), fetchDiscussion: async () => ({ body: "", comments: [] }) };
  const usage = "Usage: hedge lanes <map URL | owner/repo#number> [--stall minutes]";
  await expect(runLanes([], io)).rejects.toThrow(usage);
  await expect(runLanes(["acme/maps#1", "--stall", "soon"], io)).rejects.toThrow(usage);
  await expect(runLanes(["not a map"], io)).rejects.toThrow(usage);
  const lines: string[] = [];
  expect(await runLanes(["acme/maps#1"], { ...io, print: (line) => lines.push(line) })).toBe(0);
  expect(lines).toEqual(["No lane of acme/maps#1 needs attention."]);
});

test("only the last line of a lane's final message asks for the human", () => {
  expect(needsHuman("Done.\n`NEEDS_HUMAN: choose the region`")).toBe("choose the region");
  expect(needsHuman("NEEDS_HUMAN:")).toBe("no ask given");
  expect(needsHuman("NEEDS_HUMAN: quoted\nDone.")).toBeNull();
});
