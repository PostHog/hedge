import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mergeGate } from "../../guards/hooks/merge-gate.ts";
import { join } from "node:path";
import { fold, localLedger, type LedgerEvent } from "./decision-ledger.ts";
import { checkout, cleanFixtures, ledgerDecisions, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

const ledgerFile = (home: string) => join(home, ".local/state/hedge/decisions.jsonl");
const events = (home: string): Record<string, unknown>[] =>
  existsSync(ledgerFile(home)) ? readFileSync(ledgerFile(home), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("each gate result, a failure and a pass, lands in the decision ledger at HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  const head = await pr.git("rev-parse", "HEAD");
  const failed = await pr.hedge("gate");
  expect(failed.code).toBe(1);
  expect(failed.output).not.toContain("merge gate:");
  expect(events(pr.home).filter((event) => event.type === "gate")).toEqual([expect.objectContaining({ commit: head, passed: false })]);

  await pr.hedge("require", "--none", "--reason", "docs only");
  const passed = await pr.hedge("gate");
  expect(passed.code).toBe(0);
  expect(passed.output).toContain("merge gate: pass recorded in the decision ledger");
  expect(passed.output.split("\n").at(-1)).toStartWith("gate: pass");
  expect(events(pr.home).filter((event) => event.type === "gate").at(-1)).toEqual(expect.objectContaining({ type: "gate", repository: "example/product", pr: 42, commit: head, passed: true }));
});

test("the ledger keeps a well-formed gate pass, drops a malformed one, and decisions ignore both", async () => {
  const home = join(await checkout().then((pr) => pr.home), "ledger");
  mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
  const pass = { type: "gate", repository: "example/product", pr: 42, commit: "a".repeat(40), passed: true, machine: "box", at: "2026-11-16T08:00:00Z" };
  const { passed: _, ...unsure } = pass;
  const broken = [{ ...pass, commit: "abc123" }, { ...pass, pr: 0 }, { ...pass, repository: "nobody" }, { ...pass, machine: "" }, { ...pass, passed: "yes" }, unsure];
  writeFileSync(ledgerFile(home), [pass, ...broken].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const read: LedgerEvent[] = await localLedger(home).read();
  expect(read).toEqual([pass as LedgerEvent]);
  expect(fold(read)).toEqual([]);
});

test("a valued option given twice is refused before anything is recorded, so a later --mark 🤖 cannot slip past the 👤 rules", async () => {
  const pr = await checkout();
  pr.chooseGap("judge", "the judge is down");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--mark", "🤖", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "why"))
    .rejects.toThrow("--mark given twice");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--thread", "a", "--thread", "b")).rejects.toThrow("--thread given twice");
  expect(ledgerDecisions(pr)).toEqual([]);
});

test("a gate override is the user's 👤 answer for one PR at one full head, with the incident and why", async () => {
  const pr = await checkout();
  const head = "a".repeat(40);
  const override = (...args: string[]) => pr.decide("record", "--class", "merge", "--kind", "gate-override", "--pr", "example/product#42", ...args);
  await expect(override("--mark", "🤖", "--condition", `${head}: incident fix now`, "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "x")).rejects.toThrow("An agent never overrides the merge gate");
  await expect(override("--mark", "👍", "--condition", `${head}: incident fix now`)).rejects.toThrow("--mark 👤");
  await expect(override("--mark", "👤")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--condition", "abc123: incident fix now")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--pr", "example/product#41", "--condition", `${head}: incident fix now`)).rejects.toThrow("one --pr");
  await expect(pr.decide("record", "--mark", "👤", "--class", "merge", "--kind", "ci", "--pr", "example/product#42")).rejects.toThrow("only --kind gate-override");
  expect(ledgerDecisions(pr)).toEqual([]);

  pr.choose("Keep the gate closed", `Merge example/product#42 at ${head} without a gate pass (gate-override)? The incident cannot wait.`);
  await expect(override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`)).rejects.toThrow('not "Override the gate"');
  pr.choose("Override the gate", `Merge example/product#42 at ${"b".repeat(40)} without a gate pass (gate-override)? The incident cannot wait.`);
  await expect(override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`)).rejects.toThrow(`does not name the head ${head}`);
  expect(ledgerDecisions(pr)).toEqual([]);

  pr.choose("Override the gate", `Merge example/product#42 at ${head} without a gate pass (gate-override)? The incident cannot wait.`);
  const recorded = await override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`);
  expect(recorded.code).toBe(0);
  expect(ledgerDecisions(pr).at(-1)).toMatchObject({ class: "merge", mark: "👤", scope: { prs: ["example/product#42"], kinds: ["gate-override"], condition: `${head}: incident fix, the judge is down` } });
});

test("a standing order is the user's \"Merge on your own\" on a card that names the map, standing-order and its end date, recorded once", async () => {
  const pr = await checkout();
  const question = (end = "its milestone", rest = "") => `Standing order (standing-order) for example/maps#7 until ${end}: may this T3 thread merge every PR it merges on your word, gaps an agent accepted included?${rest}`;
  const order = (...args: string[]) => pr.decide("record", "--class", "merge", "--kind", "standing-order", "--pr", "example/maps#7", ...args);
  await expect(order("--mark", "🤖", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "x")).rejects.toThrow("An agent never gives one");
  await expect(order("--mark", "👍")).rejects.toThrow("--mark 👤");
  await expect(order("--mark", "👤", "--pr", "example/maps#8")).rejects.toThrow("covers one map");
  await expect(order("--mark", "👤", "--condition", "until the milestone")).rejects.toThrow("--condition 'until <YYYY-MM-DD>' with a real date");
  await expect(order("--mark", "👤", "--condition", "until 2027-02-30")).rejects.toThrow("with a real date");
  await expect(order("--mark", "👤", "--condition", "until 2026-10-24")).rejects.toThrow("which has passed");
  await expect(pr.decide("record", "--mark", "👤", "--class", "merge", "--kind", "standing-order", "--kind", "ci", "--pr", "example/maps#7")).rejects.toThrow("only --kind gate-override or --kind standing-order");

  pr.say("Merge on your own", question());
  await expect(order("--mark", "👤", "--words", '2026-10-25 "Merge on your own"')).rejects.toThrow("A standing order is a card answer");
  await expect(order("--mark", "👤", "--message", "message-1")).rejects.toThrow("is a message the user typed");
  pr.choose("Keep asking me", question());
  await expect(order("--mark", "👤")).rejects.toThrow('not "Merge on your own"');
  pr.choose("Merge on your own", "Merge each map PR on your own until the milestone?");
  await expect(order("--mark", "👤", "--message", "request-3:0")).rejects.toThrow("and the user answered another");
  pr.choose("Merge on your own", question("2026-12-10", " Only the docs PR."));
  await expect(order("--mark", "👤", "--condition", "until 2026-12-10")).rejects.toThrow("and the user answered another");
  pr.choose("Merge on your own", "Which words should the standing-order card for example/maps#7 offer? Standing order (standing-order) for example/maps#7 until its milestone: is the opening.");
  await expect(order("--mark", "👤")).rejects.toThrow("and the user answered another");
  pr.choose("Merge on your own", question("2026-12-10"));
  await expect(order("--mark", "👤")).rejects.toThrow("and the user answered another");
  await expect(order("--mark", "👤", "--condition", "until 2026-12-11")).rejects.toThrow("and the user answered another");
  expect(ledgerDecisions(pr)).toEqual([]);

  const recorded = await order("--mark", "👤", "--condition", "until 2026-12-10");
  expect(recorded.code).toBe(0);
  expect(recorded.output).toContain("merge word for every PR merged or enqueued from T3 thread mcp:thread-1");
  expect(recorded.output).toContain("until 2026-12-10 (UTC)");
  expect(recorded.output).toContain("hedge decision reverse");
  expect(recorded.output).toContain("--thread mcp:thread-1");
  expect(ledgerDecisions(pr).at(-1)).toMatchObject({
    class: "merge", mark: "👤", question: question("2026-12-10"), answer: '2026-10-25 "Merge on your own"',
    scope: { prs: ["example/maps#7"], kinds: ["standing-order"], condition: "until 2026-12-10" }, where: { thread: "mcp:thread-1" },
  });
  await expect(order("--mark", "👤", "--condition", "until 2026-12-10")).rejects.toThrow("already recorded");
  pr.choose("Merge on your own (Recommended)", question());
  expect((await order("--mark", "👤")).code).toBe(0);
  const listed = async () => (await pr.decide("list", "--class", "merge", "--live")).output.split("\n").filter((line) => line.startsWith("- "));
  expect(await listed()).toHaveLength(2);
  pr.clock.now = new Date("2026-12-11T00:00:00Z");
  const left = await listed();
  expect(left).toHaveLength(1);
  expect(left[0]).toContain(question());
  expect(left[0]).not.toContain("until 2026-12-10");
});

test("a gate run that throws after a pass at the same head is shared, so another machine's merge gate refuses the merge", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-other-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  try {
    expect((await pr.hedge("gate")).code).toBe(0);
    expect(await mergeThere()).toBeUndefined();
    pr.clock.now = new Date(pr.clock.now.getTime() + 60_000);
    rmSync(join(pr.home, ".agents/guides/coding-standards.md"));
    expect((await pr.hedge("gate")).code).toBe(1);
    expect((await mergeThere())?.hookSpecificOutput.permissionDecisionReason).toContain("has not passed at the head of example/product#42");
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a gate pass from while autonomy was end lets a merge through only while it is still end, here and on another machine", async () => {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(pr.env.HEDGE_SETTINGS ?? "{}"), "pull-requests.autonomy": "end" });
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeOn = (home: string, autonomy: string) => mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home, env: { HEDGE_SETTINGS: JSON.stringify({ "pull-requests.autonomy": autonomy }) }, github });
  const other = join(tmpdir(), `merge-gate-end-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  try {
    expect((await pr.hedge("gate")).code).toBe(0);
    expect(events(pr.home).filter((event) => event.type === "gate").at(-1)).toEqual(expect.objectContaining({ passed: true, onEnd: true }));
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    writeFileSync(ledgerFile(pr.home), "");
    for (const home of [pr.home, other]) {
      expect(await mergeOn(home, "end")).toBeUndefined();
      expect((await mergeOn(home, "ask"))?.hookSpecificOutput.permissionDecisionReason).toContain("nor a pass from while pull-requests.autonomy was end once it is ask again");
    }
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a gate result in the ledger carries the time its run started, the order the gate runs on this machine keep", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const start = pr.clock.now.getTime();
  let reads = 0;
  Object.defineProperty(pr.clock, "now", { get: () => new Date(start + 60_000 * reads++), configurable: true });
  expect((await pr.hedge("gate")).code).toBe(0);
  expect(events(pr.home).filter((event) => event.type === "gate").at(-1)).toMatchObject({ passed: true, at: new Date(start).toISOString() });
});

test("a pass another machine shares after --wait starts but before it reads CI as running loses to the wait's failure", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-race-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  const start = pr.clock.now.getTime();
  const shared = join(other, "pass-shared");
  const pass = { type: "gate", repository: "example/product", pr: 42, commit: head, passed: true, machine: "other-box", at: new Date(start + 60_000).toISOString() };
  pr.whileGithubReadsPull(`echo '${JSON.stringify(pass)}' >> "${ledgerFile(pr.home)}"; touch "${shared}"`);
  Object.defineProperty(pr.clock, "now", { get: () => new Date(existsSync(shared) ? start + 120_000 : start), set: () => {}, configurable: true });
  pr.ci([{ name: "test", bucket: "pending" }]);
  try {
    const whileWaiting: (string | undefined)[] = [];
    pr.panel.onPause = async () => {
      whileWaiting.push((await mergeThere())?.hookSpecificOutput.permissionDecisionReason);
      pr.ci([{ name: "test", bucket: "pass" }]);
    };
    expect((await pr.hedge("gate", "--wait", "10")).code).toBe(0);
    expect(whileWaiting[0]).toContain("has not passed at the head of example/product#42");
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("while --wait waits for CI at a head that passed before, another machine's merge gate refuses the merge until the wait ends in a pass", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-other-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  try {
    expect((await pr.hedge("gate")).code).toBe(0);
    pr.clock.now = new Date(pr.clock.now.getTime() + 60_000);
    pr.ci([{ name: "test", bucket: "pending" }]);
    const whileWaiting: (string | undefined)[] = [];
    pr.panel.onPause = async (ms = 0) => {
      whileWaiting.push((await mergeThere())?.hookSpecificOutput.permissionDecisionReason);
      pr.clock.now = new Date(pr.clock.now.getTime() + ms);
      pr.ci([{ name: "test", bucket: "pass" }]);
    };
    expect((await pr.hedge("gate", "--wait", "10")).code).toBe(0);
    expect(whileWaiting[0]).toContain("has not passed at the head of example/product#42");
    expect(await mergeThere()).toBeUndefined();
  } finally { rmSync(other, { recursive: true, force: true }); }
});
