import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFrontier } from "./frontier.ts";
import { fakeGitHub, fixtureFetchers, hedgeMachine, issueNode, runHedge, runPackCommand, type GitHubFixture } from "./testing.ts";
import type { IssueNode } from "./wayfinder.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hedge-frontier-"));
  cleanups.push(home);
  return home;
}

function mapFixture(repository: string, number = 1): GitHubFixture {
  const epic = issueNode(repository, 6, { title: "Epic", children: [issueNode(repository, 7, { title: "Draft schema" })] });
  const children: IssueNode[] = [
    issueNode(repository, 2, { title: "Pick a store", labels: ["wayfinder:grilling"] }),
    issueNode(repository, 3, {
      title: "Build the store",
      blockedBy: [{ number: 2, state: "OPEN", repository }, { number: 7, state: "OPEN", repository: "globex/core" }, { number: 8, state: "CLOSED", repository }],
    }),
    issueNode(repository, 4, { title: "Wire the API", assignees: ["ada"] }),
    issueNode(repository, 5, { title: "Choose a name", assignees: ["ada"], labels: ["wayfinder:grilling", "wayfinder:awaiting-human"] }),
    { ...epic, children: [] },
    issueNode(repository, 8, { title: "Spike", state: "CLOSED" }),
  ];
  return { issues: [issueNode(repository, number, { title: "Ship the maps", labels: ["wayfinder:map"], children }), epic] };
}

const expected = (repository: string, number = 1) => [
  `Map ${repository}#${number}: Ship the maps (6 open, 1 closed)`,
  "",
  "Frontier, open, unblocked, and unclaimed, in map order:",
  "  #2 grilling: Pick a store",
  "  #6 task: Epic",
  "  #7 task: Draft schema (under #6)",
  "Claimed:",
  "  #4 task @ada: Wire the API",
  "Parked, awaiting the human:",
  "  #5 grilling @ada: Choose a name",
  "Blocked:",
  "  #3 task: Build the store (blocked by #2, globex/core#7)",
  "Closed: #8",
].join("\n");

const noTracker = () => "";

test("hedge frontier sorts a map's open tickets into frontier, claimed, parked, and blocked", async () => {
  const lines: string[] = [];

  const code = await runFrontier(["https://github.com/acme/maps/issues/1"], { ...fixtureFetchers(mapFixture("acme/maps")), tracker: noTracker, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(expected("acme/maps"));
  expect(code).toBe(0);
});

test("hedge frontier says none when the frontier is empty", async () => {
  const repository = "acme/maps";
  const fixture = { issues: [issueNode(repository, 1, { title: "Done map", children: [issueNode(repository, 2, { assignees: ["ada"] })] })] };
  const lines: string[] = [];

  await runFrontier(["acme/maps#1"], { ...fixtureFetchers(fixture), tracker: noTracker, print: (line) => lines.push(line) });

  expect(lines.join("\n")).toBe(["Map acme/maps#1: Done map (1 open, 0 closed)", "", "Frontier, open, unblocked, and unclaimed, in map order:", "  none", "Claimed:", "  #2 task @ada: Ticket 2"].join("\n"));
});

test("hedge frontier runs as a pack command and finds a bare map number on the tracker from the settings", async () => {
  for (const tracker of ["acme/maps", "globex/plans"]) {
    const home = await temporaryHome();
    const bin = await fakeGitHub(home, mapFixture(tracker));

    const result = await runPackCommand("frontier", ["#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: JSON.stringify({ "orchestration.tracker": tracker }) });

    expect(result).toEqual({ stdout: `${expected(tracker)}\n`, stderr: "", code: 0 });
    expect((await readFile(join(bin, "calls.log"), "utf8")).split("\n").filter(Boolean)).toEqual([`${tracker}#1`, `${tracker}#6`]);
  }
});

test("hedge frontier refuses a bad map, and a bare number when no tracker is set", async () => {
  const io = { ...fixtureFetchers({ issues: [] }), tracker: noTracker, print: () => {} };
  const usage = "Usage: hedge frontier <map URL | owner/repo#number | number>";
  await expect(runFrontier([], io)).rejects.toThrow(usage);
  await expect(runFrontier(["acme/maps#1", "extra"], io)).rejects.toThrow(usage);
  await expect(runFrontier(["not a map"], io)).rejects.toThrow(usage);
  await expect(runFrontier(["12"], io)).rejects.toThrow("Set orchestration.tracker to the owner/repo that holds your maps, or name the map as owner/repo#number.");
  await expect(runFrontier(["#12"], { ...io, tracker: () => "maps" })).rejects.toThrow("orchestration.tracker is maps, not an owner/repo.");

  const home = await temporaryHome();
  const result = await runPackCommand("frontier", ["#1"], { HOME: home, HEDGE_SETTINGS: JSON.stringify({ "orchestration.tracker": "" }) });
  expect(result).toEqual({ stdout: "", stderr: "hedge: Set orchestration.tracker to the owner/repo that holds your maps, or name the map as owner/repo#number.\n", code: 1 });
});

test("hedge frontier 12 runs through hedge with the tracker that the profile sets", async () => {
  const home = await temporaryHome();
  await hedgeMachine(home, { "orchestration.tracker": "acme/maps" });
  const bin = await fakeGitHub(home, mapFixture("acme/maps", 12));

  const result = await runHedge(["frontier", "12"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}` });

  expect(result).toEqual({ stdout: `${expected("acme/maps", 12)}\n`, stderr: "", code: 0 });
  expect((await readFile(join(bin, "calls.log"), "utf8")).split("\n")[0]).toBe("acme/maps#12");
});

test("hedge frontier 12 finds the map on the profile repo's GitHub origin when no tracker is set", async () => {
  const home = await temporaryHome();
  await hedgeMachine(home, {}, "git@github.com:globex/hedge-profile.git");
  const bin = await fakeGitHub(home, mapFixture("globex/hedge-profile", 12));

  const result = await runHedge(["frontier", "12"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}` });

  expect(result).toEqual({ stdout: `${expected("globex/hedge-profile", 12)}\n`, stderr: "", code: 0 });
});

test("hedge frontier 12 asks for the tracker when the profile repo has no GitHub origin", async () => {
  const home = await temporaryHome();
  await hedgeMachine(home, {}, "https://git.example.test/acme/hedge-profile.git");

  const result = await runHedge(["frontier", "12"], { HOME: home });

  expect(result).toEqual({ stdout: "", stderr: "hedge: Set orchestration.tracker to the owner/repo that holds your maps, or name the map as owner/repo#number.\n", code: 1 });
});

const rateLimited = "API rate limit already exceeded for user ID 1.";
const restNotice = "hedge: GitHub's GraphQL rate limit is spent, so this command reads issues over REST.\n";

test("hedge frontier reads the map over REST, every page of it, with the same report, when GitHub's GraphQL rate limit is spent", async () => {
  const home = await temporaryHome();
  const bin = await fakeGitHub(home, { ...mapFixture("acme/maps"), graphqlError: rateLimited, restPageSize: 1 });

  const result = await runPackCommand("frontier", ["acme/maps#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: "{}" });

  expect(result).toEqual({ stdout: `${expected("acme/maps")}\n`, stderr: restNotice, code: 0 });
  expect((await readFile(join(bin, "calls.log"), "utf8")).split("\n").filter(Boolean)).toEqual(["acme/maps#1"]);
  expect((await readFile(join(bin, "rest.log"), "utf8")).split("\n").filter(Boolean).sort()).toEqual([
    "repos/acme/maps/issues/1",
    "repos/acme/maps/issues/1/sub_issues?per_page=100",
    "repos/acme/maps/issues/3/dependencies/blocked_by?per_page=100",
    "repos/acme/maps/issues/6",
    "repos/acme/maps/issues/6/sub_issues?per_page=100",
  ]);
});

test("hedge frontier over REST refuses a pull request number", async () => {
  const home = await temporaryHome();
  const bin = await fakeGitHub(home, { issues: [], pullRequests: ["acme/maps#9"], graphqlError: rateLimited });

  const result = await runPackCommand("frontier", ["acme/maps#9"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: "{}" });

  expect(result).toEqual({ stdout: "", stderr: `${restNotice}hedge: No issue acme/maps#9\n`, code: 1 });
});

test("hedge frontier fails on a secondary rate limit or any other GraphQL error, and does not read over REST", async () => {
  for (const error of ["You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", "Could not resolve to a Repository with the name 'acme/maps'."]) {
    const home = await temporaryHome();
    const bin = await fakeGitHub(home, { ...mapFixture("acme/maps"), graphqlError: error });

    const result = await runPackCommand("frontier", ["acme/maps#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: "{}" });

    expect(result).toEqual({ stdout: "", stderr: `hedge: gh api failed: gh: ${error}\n`, code: 1 });
    expect(await Bun.file(join(bin, "rest.log")).exists()).toBe(false);
  }
});

test("hedge frontier lists a ticket's blockers by number, whatever order GitHub returns them in, over GraphQL and over REST", async () => {
  const repository = "acme/maps";
  const blocked = issueNode(repository, 2, { title: "Ship it", blockedBy: [{ number: 5, state: "OPEN", repository }, { number: 3, state: "OPEN", repository }] });
  const fixture = { issues: [issueNode(repository, 1, { title: "Map", children: [blocked] })] };
  for (const graphqlError of [undefined, rateLimited]) {
    const home = await temporaryHome();
    const bin = await fakeGitHub(home, { ...fixture, graphqlError });

    const result = await runPackCommand("frontier", ["acme/maps#1"], { HOME: home, PATH: `${bin}:${Bun.env.PATH}`, HEDGE_SETTINGS: "{}" });

    expect(result.stdout).toContain("  #2 task: Ship it (blocked by #3, #5)\n");
  }
});
