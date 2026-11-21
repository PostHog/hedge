import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFixtures, settings, checkout, clean, verdict, fakeModel, recordingModel, fixture, stalledOnQuota, panelGuide, acceptGap, answerFixed, hubAt, exitedPid, productionMajor, reviewHead, reviewHeadFixed, models, type Checkout } from "./proof-testing.ts";
import { askModel } from "./proof-models.ts";
import { combinedLens, processStart, readPlan, withSlot, type Lens, type PanelIO } from "./proof-panel.ts";

afterEach(cleanFixtures);

const pairLenses = 3;

test("hedge proof review --lens runs each PANEL.md lens on its lane's family, and the judge weighs their joined answers as findings captured by hedge", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  writeFileSync(join(pr.repository, "incidents.md"), "A greeting once leaked a member's email.\n");
  await expect(pr.hedge("review", "--lens", "team")).rejects.toThrow("--knowledge <perspective>=<file");

  const started = await pr.hedge("review", "--lens", "fresh-eyes", "--lens", "correctness", "--lens", "design:same", "--knowledge", "correctness=incidents.md");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1, lenses: [{ name: "fresh-eyes", family: "claude" }, { name: "correctness", family: "gpt" }, { name: "design", family: "claude" }, { name: "risk", family: "gpt" }] });
  const [freshEyes, correctness, design] = reviewer.prompts();
  for (const prompt of [freshEyes, correctness, design]) for (const part of ["Goal: Greet new members", "+greet the new member", "- Keep things simple."]) expect(prompt).toContain(part);
  expect(freshEyes).toContain("Lens: Fresh eyes\n\nRead it as a senior engineer");
  expect(correctness).toContain("PR description: Adds the greeting.");
  expect(correctness).toContain("A greeting once leaked a member's email.");
  expect(design).toContain("Find the code judo move.");
  expect(design).not.toContain("Adds the greeting.");

  const waited = await pr.hedge("review", "--wait");
  expect(waited.code).toBe(0);
  expect(waited.output).toContain("design: done by claude");
  const findings = readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8");
  expect(findings).toMatch(/^## Fresh eyes lens, by command: [^\n]+\n\nFINDINGS:\n\(none\)\nCOVERED: feature\.txt\n\n## Correctness lens/);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"))).toMatchObject({ capturedBy: "hedge" });

  const judge = fakeModel(pr, "JUDGE", verdict());
  expect((await pr.hedge("gate")).code).toBe(0);
  expect(judge.prompts()[0]).toMatch(/captured by hedge">\n## Fresh eyes lens/);
});

test("the sweep lens reads the other lenses' findings once they finish, and hedge flags a finding whose anchor is not in the diff", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", `FINDINGS:
- feature.txt:1 | major | Correctness | an empty name -> a blank greeting | guard it | sites: feature.txt:1 | anchor: greet the new member
- feature.txt:1 | minor | Correctness | a typo -> confusion | fix it | sites: feature.txt:1 | anchor: welcome every new member
COVERED: feature.txt
`);

  await pr.hedge("review", "--lens", "correctness", "--lens", "sweep");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const sweep = reviewer.prompts().at(-1)!;
  expect(sweep).toContain("Find what the other lenses missed.");
  expect(sweep).toContain("The findings of the other lenses, which you sweep:\n\n### Correctness\n\nFINDINGS:\n- feature.txt:1 | major");
  const check = readFileSync(join(pr.pullRequest, "reviews/1/anchors.md"), "utf8");
  expect(readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8")).not.toContain("## Anchor check");
  expect(check).toContain("Not in the diff, so check it before triage: - feature.txt:1 | minor");
  expect(check).not.toContain("| major |");
});

test("a lens without a FINDINGS block or a full COVERED list runs once more, then keeps the round unfinished until the same command reruns it", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");

  await pr.hedge("review", "--lens", "correctness", "--lens", "design");
  expect(reviewer.prompts()).toHaveLength((pairLenses + 1) * 2);
  const failed = await pr.hedge("review", "--wait");
  expect(failed.code).toBe(1);
  expect(failed.output).toContain("correctness: failed by gpt");
  expect(failed.output).toContain("no FINDINGS block (after 2 attempts)");
  expect((await pr.hedge("gate")).code).toBe(1);
  await expect(pr.hedge("review", "--lens", "sweep")).rejects.toThrow("The unfinished round runs the lenses correctness, design, risk, fresh-eyes");

  reviewer.answer("FINDINGS:\n(none)\nCOVERED: other.txt\n");
  await pr.hedge("review");
  expect((await pr.hedge("show")).output).toContain("COVERED misses feature.txt (after 2 attempts)");

  reviewer.answer(clean);
  await pr.hedge("review", "--lens", "design", "--lens", "correctness:same");
  expect((await pr.hedge("review", "--wait")).output).toContain("correctness: done by claude");
  expect((await pr.hedge("show")).output.split("\n")[0]).toMatch(/^round 1 on \w+: finished by command: .*, captured by hedge/);
});

test("a lens stuck on spent quota fails at once without a second attempt, and --wait exits 4 until the rerun passes", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const attempts = join(pr.home, "attempts");
  pr.env.HEDGE_PROOF_QUOTA_GRACE_MS = "0";
  pr.env.HEDGE_PROOF_REVIEWER = `echo attempt >> "${attempts}"; ${stalledOnQuota("exceeded retry limit, last status: 429 Too Many Requests")}`;

  await pr.hedge("review", "--lens", "correctness");
  expect(readFileSync(attempts, "utf8")).toBe("attempt\n".repeat(pairLenses));
  const failed = await pr.hedge("review", "--wait");
  expect(failed.code).toBe(4);
  expect(failed.output).toContain('correctness: failed by gpt (command: echo attempt');
  expect(failed.output).toContain('quota exhausted: no progress after "exceeded retry limit, last status: 429 Too Many Requests" (after 1 attempt)');
  expect(failed.output).toContain("A lens stopped on spent quota");

  fakeModel(pr, "REVIEWER", clean);
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
});

test("a lens waits for a free panel slot of the machine, and --wait restarts a lens whose worker died", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.panelSlots": 1 });
  const slots = join(pr.home, ".local/state/hedge/proof/.panel-slots");
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(slots, "0"), String(process.pid));

  pr.panel.lostWorkers = true;
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("show")).output).toContain("correctness: queued by gpt");

  pr.panel.lostWorkers = false;
  const whileQueued: string[] = [];
  pr.panel.onPause = async () => {
    whileQueued.push((await pr.hedge("show")).output);
    rmSync(join(slots, "0"));
  };
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(whileQueued).toEqual([expect.stringContaining("correctness: queued by gpt")]);
  expect(readdirSync(slots)).toEqual([]);
});

test("a lens reads the whole diff from the round directory and REVIEW.md from the tip of the base branch, and its findings need answers, not its COVERED list", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.advanceBase("REVIEW.md", "Flag every unchecked webhook signature.\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const claude = recordingModel(pr, "claude", "FINDINGS:\n- feature.txt:1 | high | the greeting names no member\nCOVERED: feature.txt");
  recordingModel(pr, "codex", clean);

  await pr.hedge("review", "--lens", "fresh-eyes");
  const round = join(pr.pullRequest, "reviews/1");
  expect(readFileSync(join(round, "diff.patch"), "utf8")).toContain("+greet the new member");
  expect(claude.prompt()).toContain(`is in ${join(round, "diff.patch")}`);
  expect(claude.prompt()).toContain("Flag every unchecked webhook signature.");
  expect(claude.calls()[0]).toContain(`--add-dir ${round}`);

  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const unanswered = await pr.hedge("gate");
  expect(unanswered.code).toBe(1);
  expect(unanswered.output).toContain("review: round 1 has unanswered findings 1;");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in this commit: the greeting names the member.\n");
  await pr.hedge("respond", "--round", "1", "responses.md");
  expect((await pr.hedge("gate")).code).toBe(0);
});


function slotIO(slotCount: number): PanelIO {
  return { env: {}, pause: () => new Promise((done) => setImmediate(done)), now: () => new Date(), startTime: async () => "Sun Oct 25 11:00:00 2026", slots: fixture("hedge-panel-slots-"), slotCount, pid: process.pid, limit: 60_000 };
}

test("claimants that find a dead worker's slot at once reclaim it once, so the panel never runs more lenses than its slots", async () => {
  const io = slotIO(1);
  const running = fixture("hedge-panel-running-");
  const claimant = join(running, "claim.ts");
  writeFileSync(claimant, `import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { withSlot } from ${JSON.stringify(join(import.meta.dir, "proof-panel.ts"))};
const [slots, running] = process.argv.slice(2);
const tick = () => new Promise((done) => setImmediate(done));
writeFileSync(running + "/ready-" + process.pid, "");
while (readdirSync(running).filter((name) => name.startsWith("ready-")).length < 4) await tick();
await withSlot({ env: {}, pause: tick, now: () => new Date(), startTime: async () => "Sun Oct 25 11:00:00 2026", slots, slotCount: 1, pid: process.pid, limit: 60000 }, async () => {
  writeFileSync(running + "/" + process.pid, "");
  writeFileSync(running + "/most-" + process.pid, String(readdirSync(running).filter((name) => /^\\d+$/.test(name)).length));
  for (let count = 0; count < 2000; count++) await tick();
  rmSync(running + "/" + process.pid);
});
`);
  for (let race = 0; race < 4; race++) {
    for (const name of readdirSync(running).filter((name) => name !== "claim.ts")) rmSync(join(running, name));
    writeFileSync(join(io.slots, "0"), String(await exitedPid()));
    const claimants = Array.from({ length: 4 }, () => Bun.spawn(["bun", claimant, io.slots, running], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(claimants.map((child) => child.exited))).toEqual([0, 0, 0, 0]);
    const most = readdirSync(running).filter((name) => name.startsWith("most-")).map((name) => Number(readFileSync(join(running, name), "utf8")));
    expect(most).toEqual([1, 1, 1, 1]);
    expect(readdirSync(io.slots).filter((name) => !name.startsWith("."))).toEqual([]);
  }
});

test("a reclaimed slot's reviewer stops with it, and a lens records its reviewer in its slot", async () => {
  const io = slotIO(1);
  const reviewer = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: reviewer.pid, reviewerStarted: "Sun Oct 25 11:00:00 2026" }));
    await withSlot(io, async () => undefined);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
  } finally { reviewer.kill("SIGKILL"); }

  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const slots = join(pr.home, ".local/state/hedge/proof/.panel-slots");
  const seen = join(pr.home, "slot-seen");
  pr.env.HEDGE_PROOF_REVIEWER = `cat >/dev/null; echo $$ > "${seen}.pid"; until grep -qs reviewer "${slots}"/[0-9]*; do :; done; cat "${slots}"/[0-9]* > "${seen}"; printf 'FINDINGS:\\n(none)\\nCOVERED: feature.txt\\n'`;
  await pr.hedge("review", "--lens", "correctness");
  expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ pid: process.pid, reviewer: Number(readFileSync(`${seen}.pid`, "utf8")) });
});

test("a reclaimed slot leaves alone a process that holds its reviewer's process id unless both start times are known and match", async () => {
  for (const recorded of [undefined, "Sun Oct 25 11:00:00 2026"]) {
    const unknown = Bun.spawn(["sleep", "30"], { detached: true });
    try {
      const io = { ...slotIO(1), startTime: async (pid: number) => pid === unknown.pid && recorded ? undefined : "Sun Oct 25 11:00:00 2026" };
      writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: unknown.pid, reviewerStarted: recorded }));
      await withSlot(io, async () => undefined);
      unknown.kill("SIGTERM");
      await unknown.exited;
      expect(unknown.signalCode).toBe("SIGTERM");
    } finally { unknown.kill("SIGKILL"); }
  }
});

test("a reclaimed slot leaves alone a process that now holds its reviewer's process id but started later", async () => {
  const later = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    const io = { ...slotIO(1), startTime: async (pid: number) => pid === later.pid ? "Sun Oct 25 12:00:00 2026" : "Sun Oct 25 11:00:00 2026" };
    writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: later.pid, reviewerStarted: "Sun Oct 25 10:00:00 2026" }));
    await withSlot(io, async () => undefined);
    later.kill("SIGTERM");
    await later.exited;
    expect(later.signalCode).toBe("SIGTERM");
  } finally { later.kill("SIGKILL"); }
});

test("a claimant that judged a holder stale after another claimant took the slot over leaves the new claim in place and waits for it", async () => {
  const io = slotIO(1);
  writeFileSync(join(io.slots, "0"), JSON.stringify({ pid: process.pid, token: "reused", started: "Sun Oct 25 09:00:00 2026" }));
  const order: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first: Promise<void> | undefined;
  let lookups = 0;
  const late = {
    ...io,
    startTime: async () => {
      if (++lookups === 2) {
        first = withSlot(io, async () => { order.push("first in"); await held; order.push("first out"); });
        while (!order.includes("first in")) await new Promise((done) => setImmediate(done));
      }
      return "Sun Oct 25 11:00:00 2026";
    },
    pause: async () => { release(); await new Promise((done) => setImmediate(done)); },
  };

  await withSlot(late, async () => { order.push("second in"); });
  await first;
  expect(order).toEqual(["first in", "first out", "second in"]);
  expect(readdirSync(io.slots).filter((name) => !name.startsWith("."))).toEqual([]);
});

test("a claimant that crashed while it reclaimed a slot no longer holds it", async () => {
  const slots = fixture("hedge-panel-slots-");
  const crashing = join(fixture("hedge-panel-crash-"), "crash.ts");
  const reviewer = await exitedPid();
  writeFileSync(crashing, `import { withSlot } from ${JSON.stringify(join(import.meta.dir, "proof-panel.ts"))};
const startTime = async (pid: number) => { if (pid === ${reviewer}) process.kill(process.pid, "SIGKILL"); return "Sun Oct 25 11:00:00 2026"; };
await withSlot({ env: {}, pause: async () => {}, now: () => new Date(), startTime, slots: ${JSON.stringify(slots)}, slotCount: 1, pid: process.pid, limit: 60000 }, async () => {});
`);
  writeFileSync(join(slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer, reviewerStarted: "Sun Oct 25 10:00:00 2026" }));
  const crashed = Bun.spawn(["bun", crashing], { stdout: "ignore", stderr: "ignore" });
  await crashed.exited;
  expect(crashed.signalCode).toBe("SIGKILL");

  const io = { ...slotIO(1), slots, now: () => new Date(Date.now() + 120_000) };
  expect(await withSlot(io, async () => "ran")).toBe("ran");
  expect(readdirSync(slots).filter((name) => /^\d+$/.test(name))).toEqual([]);
});

test("a claimant paused while it reclaims a slot is not fenced out, however long the pause: the next claimant waits until it resumes", async () => {
  const slots = fixture("hedge-panel-slots-");
  const scratch = fixture("hedge-panel-pause-");
  const pausing = join(scratch, "pause.ts");
  const inSection = join(scratch, "in-section");
  const reviewer = await exitedPid();
  writeFileSync(pausing, `import { writeFileSync } from "node:fs";
import { withSlot } from ${JSON.stringify(join(import.meta.dir, "proof-panel.ts"))};
const startTime = async (pid: number) => {
  if (pid === ${reviewer}) { writeFileSync(${JSON.stringify(inSection)}, ""); process.kill(process.pid, "SIGSTOP"); }
  return "Sun Oct 25 11:00:00 2026";
};
await withSlot({ env: {}, pause: () => new Promise((done) => setImmediate(done)), now: () => new Date(), startTime, slots: ${JSON.stringify(slots)}, slotCount: 1, pid: process.pid, limit: 60000 }, async () => {});
`);
  writeFileSync(join(slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer, reviewerStarted: "Sun Oct 25 10:00:00 2026" }));
  const paused = Bun.spawn(["bun", pausing], { stdout: "ignore", stderr: "inherit" });
  try {
    while (!existsSync(inSection)) await new Promise((done) => setImmediate(done));
    let waits = 0;
    let resumed = false;
    const io = { ...slotIO(1), slots, now: () => new Date(Date.now() + 3_600_000), pause: async () => { if (++waits > 20) { resumed = true; paused.kill("SIGCONT"); } await new Promise((done) => setImmediate(done)); } };

    expect(await withSlot(io, async () => resumed)).toBe(true);
    expect(await paused.exited).toBe(0);
  } finally { paused.kill("SIGKILL"); }
});

test("a claimant paused just as it starts to reclaim a slot never runs its work beside the next claimant's, however long the pause", async () => {
  const slots = fixture("hedge-panel-slots-");
  const scratch = fixture("hedge-panel-publish-");
  const pausing = join(scratch, "pause.ts");
  const at = (name: string) => join(scratch, name);
  const reviewer = await exitedPid();
  writeFileSync(pausing, `import { existsSync, writeFileSync } from "node:fs";
import { withSlot } from ${JSON.stringify(join(import.meta.dir, "proof-panel.ts"))};
let own = 0;
const startTime = async (pid: number) => {
  if (pid === process.pid && ++own === 2) { writeFileSync(${JSON.stringify(at("stopped"))}, ""); process.kill(process.pid, "SIGSTOP"); }
  return "Sun Oct 25 11:00:00 2026";
};
const pause = () => { writeFileSync(${JSON.stringify(at("child-waits"))}, ""); return new Promise<void>((done) => setImmediate(done)); };
await withSlot({ env: {}, pause, now: () => new Date(), startTime, slots: ${JSON.stringify(slots)}, slotCount: 1, pid: process.pid, limit: 60000 }, async () => {
  writeFileSync(${JSON.stringify(at("child-in"))}, "");
  while (!existsSync(${JSON.stringify(at("parent-done"))}) && !existsSync(${JSON.stringify(at("parent-waits"))})) await new Promise((done) => setImmediate(done));
  writeFileSync(${JSON.stringify(at("child-out"))}, "");
});
`);
  writeFileSync(join(slots, "0"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer, reviewerStarted: "Sun Oct 25 10:00:00 2026" }));
  const paused = Bun.spawn(["bun", pausing], { stdout: "ignore", stderr: "inherit" });
  const settled = (...names: string[]) => names.some((name) => existsSync(at(name))) || paused.exitCode !== null;
  try {
    while (!settled("stopped")) await new Promise((done) => setImmediate(done));
    let resumed = false;
    const startTime = async (pid: number) => {
      if (pid === reviewer && !resumed) {
        resumed = true;
        paused.kill("SIGCONT");
        while (!settled("child-in", "child-waits")) await new Promise((done) => setImmediate(done));
      }
      return "Sun Oct 25 11:00:00 2026";
    };
    const pause = () => { writeFileSync(at("parent-waits"), ""); return new Promise<void>((done) => setImmediate(done)); };
    const io = { ...slotIO(1), slots, startTime, pause, now: () => new Date(Date.now() + 3_600_000) };

    const together = await withSlot(io, async () => existsSync(at("child-in")) && !existsSync(at("child-out")));
    writeFileSync(at("parent-done"), "");
    expect(together).toBe(false);
    expect(await paused.exited).toBe(0);
    expect(existsSync(at("child-out"))).toBe(true);
  } finally { paused.kill("SIGKILL"); }
});

test("a process's start time stays the same while it runs and is unknown once it exits", async () => {
  const running = Bun.spawn(["sleep", "30"]);
  try {
    const started = await processStart(running.pid);
    expect(started).toBeString();
    expect(await processStart(running.pid)).toBe(started);
    expect(await processStart(process.pid)).not.toBe(started);
  } finally { running.kill("SIGKILL"); }
  expect(await processStart(await exitedPid())).toBeUndefined();
});

test("--wait stops the reviewer of a lens whose worker died before it restarts the lens", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  pr.panel.lostWorkers = true;
  await pr.hedge("review", "--lens", "correctness");
  pr.panel.lostWorkers = false;
  const slots = join(pr.home, ".local/state/hedge/proof/.panel-slots");
  mkdirSync(slots, { recursive: true });
  const reviewer = Bun.spawn(["sleep", "30"], { detached: true });
  try {
    writeFileSync(join(slots, "2"), JSON.stringify({ pid: await exitedPid(), token: "dead", reviewer: reviewer.pid, reviewerStarted: "Sun Oct 25 11:00:00 2026" }));
    expect((await pr.hedge("review", "--wait")).code).toBe(0);
    await reviewer.exited;
    expect(reviewer.signalCode).toBe("SIGKILL");
    expect(readdirSync(slots).filter((name) => !name.startsWith("."))).toEqual([]);
  } finally { reviewer.kill("SIGKILL"); }
});

test("only entries inside a lens's FINDINGS block need answers, not its summary", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "Summary:\n- the change is one line of copy\n\nFINDINGS:\n(none)\nCOVERED: feature.txt\n");
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.hedge("gate");
  expect(gate.output).not.toContain("unanswered findings");
  expect(gate.code).toBe(0);
});

test("a heading inside a lens's FINDINGS block hides none of its findings", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n## High severity\n- feature.txt:1 | high | the greeting names no member\n- feature.txt:1 | high | the greeting skips the team\nCOVERED: feature.txt\n");
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("review: round 1 has unanswered findings 1, 2, 3, 4, 5, 6;");
  expect(gate.code).toBe(1);
});

test("a reviewer stops when hedge cannot record it in its slot", async () => {
  let reviewer = 0;
  const started = async (pid: number) => { reviewer = pid; throw new Error("cannot write the slot"); };
  const env = { HEDGE_PROOF_REVIEWER: "cat >/dev/null; exec tail -f /dev/null", PATH: process.env.PATH };
  const answer = await askModel("reviewer", { role: "lookup", work: "Find files", provider: "claude", model: "lookup-model", effort: "medium" }, { prompt: "Review this.", cwd: fixture("hedge-reviewer-"), started }, env, 60_000);
  expect(answer).toMatchObject({ ok: false, cause: expect.stringContaining("cannot write the slot") });
  expect(reviewer).toBeGreaterThan(0);
  expect(() => process.kill(reviewer, 0)).toThrow();
});

async function authorRound(pr: Checkout, findings: string, ...args: string[]) {
  const reserved = JSON.parse((await pr.hedge("review-start", ...args)).output) as { id: string };
  writeFileSync(join(pr.repository, "findings.md"), findings);
  expect((await pr.hedge("review-finish", "--round", reserved.id, "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
}

test("the gate needs a finished --lens panel round: a single reviewer never covers HEAD, and a final read after the panel covers a new HEAD", async () => {
  const single = await checkout();
  await single.commit("feature.txt", "greet\n");
  await single.hedge("require", "--none", "--reason", "docs only");
  await authorRound(single, productionMajor("feature.txt:1", "greet"), "--scope", "full");
  await answerFixed(single, "1");
  const refused = await single.hedge("gate");
  expect(refused.code).toBe(1);
  expect(refused.output).toContain("review: no finished panel round on the PR; 1 single-reviewer review(s) do not count. Run hedge proof review, which runs the lenses of the PR's review tier");
  const before = await single.git("rev-parse", "HEAD");
  await single.commit("feature.txt", "greet the member\n");
  fakeModel(single, "REVIEWER", clean);
  await single.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", before);
  expect((await single.hedge("review", "--wait")).code).toBe(0);
  expect((await single.hedge("gate", "--commit", before)).output).toContain("review: HEAD not reviewed, last review covered");

  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await pr.hedge("gate")).code).toBe(0);
  await pr.commit("feature.txt", "greet the member\n");
  await authorRound(pr, "No findings.\n", "--scope", "final", "--base", reviewed);
  const after = await pr.hedge("gate");
  expect(after.code).toBe(0);
  expect(after.output).toContain("review: HEAD reviewed in final read 1 by gpt-6.1-sol");
});

test("review-finish refuses a panel round, so the author cannot replace the findings of lenses that failed", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(1);
  writeFileSync(join(pr.repository, "review.md"), "No findings.\n");
  const finish = () => pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "review.md");
  await expect(finish()).rejects.toThrow("Round 1 is a panel round");
  await expect(finish()).rejects.toThrow("hedge proof gap --kind panel");
  expect(existsSync(join(pr.pullRequest, "reviews/1/findings.md"))).toBe(false);
  expect((await pr.hedge("gate")).output).toContain("review: no finished panel round on the PR");

  reviewer.answer(clean);
  await pr.hedge("review");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expect(finish()).rejects.toThrow("Round 1 is a panel round");
  expect((await pr.hedge("gate")).code).toBe(0);
});

test("the gate counts a panel round only when its plan is published and every lens is done, whatever findings.md holds", async () => {
  const status = (directory: string, name: string, state: string) => writeFileSync(join(directory, `lenses/${name}.json`), JSON.stringify({ state, attempts: 1 }));
  const lens = (state: string) => (directory: string) => status(directory, "correctness", state);
  const tamper: [string, (directory: string) => void][] = [
    ["every lens failed", (directory) => { for (const name of ["correctness", "risk", "fresh-eyes"]) status(directory, name, "failed"); }],
    ["one lens failed", lens("failed")],
    ["one lens is still running", lens("running")],
    ["one lens is queued", lens("queued")],
    ["a lens has no status file", (directory) => rmSync(join(directory, "lenses/correctness.json"))],
    ["panel.json is empty", (directory) => writeFileSync(join(directory, "panel.json"), "")],
    ["panel.json is {}", (directory) => writeFileSync(join(directory, "panel.json"), "{}")],
    ["panel.json is not JSON", (directory) => writeFileSync(join(directory, "panel.json"), "{")],
    ["panel.json names no lens", (directory) => writeFileSync(join(directory, "panel.json"), JSON.stringify({ lenses: [] }))],
    ["panel.json lenses is not a list", (directory) => writeFileSync(join(directory, "panel.json"), JSON.stringify({ lenses: { name: "correctness" } }))],
    ["panel.json lenses holds null", (directory) => writeFileSync(join(directory, "panel.json"), JSON.stringify({ lenses: [null] }))],
    ["panel.json names a lens outside the lenses directory", (directory) => { writeFileSync(join(directory, "done.json"), JSON.stringify({ state: "done" })); writeFileSync(join(directory, "panel.json"), JSON.stringify({ lenses: [{ name: "../done" }] })); }],
    ["the author saved the findings", (directory) => { const path = join(directory, "round.json"); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), capturedBy: "author" })); }],
    ["the plan is staged but not published", (directory) => { const plan = readFileSync(join(directory, "panel.json")); rmSync(join(directory, "panel.json")); writeFileSync(join(directory, "panel.staged.json"), plan); }],
  ];
  for (const [label, change] of tamper) {
    const pr = await checkout();
    await pr.commit("feature.txt", "greet\n");
    await pr.hedge("require", "--none", "--reason", "docs only");
    fakeModel(pr, "REVIEWER", clean);
    await pr.hedge("review", "--lens", "correctness");
    expect((await pr.hedge("review", "--wait")).code).toBe(0);
    expect((await pr.hedge("gate")).code).toBe(0);
    change(join(pr.pullRequest, "reviews/1"));
    const gate = await pr.hedge("gate");
    expect({ label, code: gate.code }).toEqual({ label, code: 1 });
    expect({ label, line: gate.output.includes("review: no finished panel round on the PR") }).toEqual({ label, line: true });
    expect({ label, single: gate.output.includes("single-reviewer") }).toEqual({ label, single: false });
  }

  const staged = await checkout();
  await staged.commit("feature.txt", "greet\n");
  const reserved = JSON.parse((await staged.hedge("review-start", "--scope", "full")).output) as { directory: string };
  writeFileSync(join(reserved.directory, "panel.staged.json"), JSON.stringify({ lenses: [{ name: "correctness" }] }));
  writeFileSync(join(staged.repository, "review.md"), "No findings.\n");
  await expect(staged.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "review.md")).rejects.toThrow("Round 1 is a panel round");
}, 15_000);

test("after a valid panel, a later panel round whose findings the author saved never covers HEAD", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", lensMajor("greet"));
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await answerFixed(pr, "1", 3);
  reviewer.answer(clean);
  await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await pr.hedge("gate")).code).toBe(0);

  const path = join(pr.pullRequest, "reviews/2/round.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), capturedBy: "author" }));
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("review: HEAD not reviewed");
});

test("a finished panel round that Fleet captured does not hold a later final read as unfinished", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", lensMajor("greet"));
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await answerFixed(pr, "1", 3);
  reviewer.answer(clean);
  const fixed = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const path = join(pr.pullRequest, "reviews/1/round.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), capturedBy: "fleet" }));
  await pr.commit("feature.txt", "greet the new member\n");

  const read = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", fixed)).output) as { id: string };
  expect(read.id).toBe("final-1");
  expect(readdirSync(join(pr.pullRequest, "reviews")).sort()).toEqual(["1", "2", "final-1"]);
});

test("a panel gap holds the gate until the user accepts it, and still needs a review at HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reason = "A prune lane runs no QA swarm under the user's rules";
  await pr.hedge("gap", "--kind", "panel", "--reason", reason);
  expect((await pr.hedge("gate")).output).toContain(`review: HEAD not reviewed; panel gap from`);
  expect((await pr.hedge("gate")).code).toBe(1);

  await authorRound(pr, "No findings.\n", "--scope", "full");
  const unaccepted = await pr.hedge("gate");
  expect(unaccepted.code).toBe(3);
  expect(unaccepted.output).toMatch(new RegExp(`review: HEAD reviewed in round 1 by gpt-6\\.1-sol; panel gap from \\w{7}, not accepted: ${reason}`));

  pr.chooseGap("panel", reason);
  await acceptGap(pr, "panel");
  expect((await pr.hedge("gate")).code).toBe(0);
});

const lensMajor = (anchor: string) => `FINDINGS:\n- feature.txt:1 | major | Correctness | the greeting names no member | name the member | anchor: ${anchor}\nCOVERED: feature.txt\n`;

test("a round after the PR merged its base reads and demands only the files the PR changes", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", lensMajor("greet"));
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await answerFixed(pr, "1", 3);
  reviewer.answer(clean);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const fixed = await pr.commit("feature.txt", "greet the member\n");
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";

  await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("+greet the member");
  expect(brief).not.toContain("the base moves on");
  expect(brief).toContain("It leaves out 1 file(s) that a merge of the base brought in.");

  await pr.advanceBase("base.md", "the base moves again\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet every member\n");
  reviewer.answer("No findings.");
  await pr.hedge("review", "--scope", "final", "--base", fixed);
  const read = reviewer.prompts().at(-1)!;
  expect(read).toContain("+greet every member");
  expect(read).not.toContain("the base moves again");
  expect(read).toContain("It leaves out 1 file(s) that a merge of the base brought in.");
});

test("after a base merge, a round keeps the PR's renames and non-ASCII file names whole", async () => {
  const pr = await checkout();
  const greeting = "greet\nwelcome\nshow the rules\npoint to the help page\n";
  const reviewed = await pr.commit("feature.txt", greeting);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", lensMajor("greet"));
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await answerFixed(pr, "1", 3);
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.git("mv", "feature.txt", "grüße.txt");
  await pr.commit("grüße.txt", `${greeting}greet the member\n`);
  reviewer.answer("FINDINGS:\n(none)\nCOVERED: grüße.txt\n");

  await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", reviewed);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const brief = reviewer.prompts().at(-1)!;
  expect(brief).toContain("rename from feature.txt");
  expect(brief).toContain("+greet the member");
  expect(brief).not.toContain("the base moves on");
  expect(brief).toContain("It leaves out 1 file(s)");
});

test("a panel that fails to plan gives its round back, so the same command plans it again", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  const guide = join(pr.home, ".agents/skills/qa-swarm/PANEL.md");
  writeFileSync(guide, panelGuide.replace("Goal: <goal>", "Goal: the title"));
  await expect(pr.hedge("review", "--lens", "correctness")).rejects.toThrow("has no <goal>");

  writeFileSync(guide, panelGuide);
  const started = await pr.hedge("review", "--lens", "correctness");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1 });
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
});

test("a panel the user's override starts but that fails to plan keeps the answer for the same command", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", clean);
  const guide = join(pr.home, ".agents/skills/qa-swarm/PANEL.md");
  writeFileSync(guide, panelGuide.replace("Goal: <goal>", "Goal: the title"));
  pr.choose("Run one more round");
  const review = () => pr.hedge("review", "--lens", "correctness", "--override", `2026-10-25 "Run one more round"`);
  await expect(review()).rejects.toThrow("has no <goal>");

  writeFileSync(guide, panelGuide);
  const started = await review();
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ round: 1 });
});

const overrideReview = ["review", "--lens", "correctness", "--override", `2026-10-25 "Run one more round"`];

async function overridePanel() {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  pr.choose("Run one more round");
  return { pr, reviewer };
}

async function expectCountedPanel(pr: Checkout) {
  fakeModel(pr, "JUDGE", verdict());
  const gate = await pr.hedge("gate");
  expect(gate.output).toContain("review: HEAD reviewed in round 1");
  expect(gate.code).toBe(0);
  const decisions = (await pr.decide("list", "--pr", "example/product#42")).output.split("\n").filter((line) => line.startsWith("- "));
  const round = JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"));
  expect(decisions).toEqual([expect.stringContaining(`[${round.decision.id}]`)]);
}

test("a panel whose decision never reached the ledger starts no lens while the hub is down, and the same command records that decision and runs the round", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  void pr.hedgeAs(await exitedPid(), ...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "down";

  await expect(pr.hedge("review", "--wait")).rejects.toThrow("Run the same command again once the hub is back");
  await expect(pr.hedge(...overrideReview)).rejects.toThrow("Run the same command again once the hub is back");
  expect(existsSync(join(pr.pullRequest, "reviews/1/lenses/correctness.prompt.md"))).toBe(true);
  expect(reviewer.prompts()).toEqual([]);

  hub.state.hub = "up";
  expect((await pr.hedge(...overrideReview)).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

test("a retry that takes over the round of a command whose process is gone records that same decision and runs the round, and the late command then ends without a second panel", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  const first = pr.hedgeAs(await exitedPid(), ...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await pr.hedge(...overrideReview)).code).toBe(0);
  hub.releaseAppends();
  expect((await first).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  await expectCountedPanel(pr);
});

test("two retries at once after the first command's process is gone record one decision and run one panel, and a retry that finds the other at work names it", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  const first = pr.hedgeAs(await exitedPid(), ...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  const retries = await Promise.allSettled([pr.hedge(...overrideReview), pr.hedge(...overrideReview)]);
  const ends = retries.map((end) => end.status === "fulfilled" ? end.value.code : (end.reason as Error).message);
  expect(ends).toContain(0);
  for (const end of ends) expect([0, expect.stringContaining(`Process ${process.pid}, another hedge proof command`)]).toContainEqual(end);
  hub.releaseAppends();
  expect((await first).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  await expectCountedPanel(pr);
});

test("when the first command publishes a panel that a retry already published, it ends without starting the lenses again", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls after it lands an append");
  const first = pr.hedgeAs(await exitedPid(), ...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await pr.hedge(...overrideReview)).code).toBe(0);
  hub.releaseAppends();
  const late = await first;
  expect(late.code).toBe(0);
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

for (const resume of [overrideReview, ["review", "--wait"], ["review", "--wait", "--round", "1"]]) {
  test(`a panel whose process dies after its decision reached the ledger, before its plan exists, resumes with ${resume.join(" ")} and asks for no new answer`, async () => {
    const { pr, reviewer } = await overridePanel();
    const hub = hubAt(pr, "stalls after it lands an append");
    void pr.hedgeAs(await exitedPid(), ...overrideReview);
    await hub.appendStalled;
    hub.state.hub = "up";
    expect(reviewer.prompts()).toEqual([]);

    await pr.hedge(...resume);
    expect((await pr.hedge("review", "--wait")).code).toBe(0);
    expect(reviewer.prompts()).toHaveLength(pairLenses);
    await expectCountedPanel(pr);
  });
}

test("a panel whose plan fails to publish after its decision reached the ledger keeps its round, and the same command resumes it", async () => {
  const { pr } = await overridePanel();
  const hub = hubAt(pr, "up");
  const plan = join(pr.pullRequest, "reviews/1/panel.json");
  hub.state.afterAppend = () => mkdirSync(plan);
  await expect(pr.hedge(...overrideReview)).rejects.toThrow();
  hub.state.afterAppend = undefined;
  expect(existsSync(join(pr.pullRequest, "reviews/1/round.json"))).toBe(true);
  rmSync(plan, { recursive: true, force: true });

  expect((await pr.hedge(...overrideReview)).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

test("two --wait commands at once on a staged panel start each lens once, and both print the findings", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls after it lands an append");
  void pr.hedgeAs(await exitedPid(), ...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  pr.panel.beforeWorker = async () => { await opened; };

  const waits = [pr.hedge("review", "--wait"), pr.hedge("review", "--wait")];
  pr.panel.onPause = async () => { open(); await Promise.race(waits); };
  const ends = await Promise.all(waits);
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  expect(ends.map(({ code }) => code)).toEqual([0, 0]);
  for (const { output } of ends) expect(output).toContain("FINDINGS:\n(none)");
  await expectCountedPanel(pr);
});

test("--wait on a panel whose command still holds the round keeps polling until it ends, then runs the panel and prints its findings", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "stalls on appends");
  const first = pr.hedge(...overrideReview);
  await hub.appendStalled;
  hub.state.hub = "up";
  pr.panel.onPause = async () => { hub.releaseAppends(); await first.catch(() => undefined); };

  const waited = await pr.hedge("review", "--wait");
  expect(waited.code).toBe(0);
  expect(waited.output).toContain("FINDINGS:\n(none)");
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  await expectCountedPanel(pr);
});

test("--wait on a panel whose command still writes its briefs keeps polling until the panel is staged, then runs it and prints its findings", async () => {
  const { pr, reviewer } = await overridePanel();
  const hub = hubAt(pr, "drops appends");
  await expect(pr.hedge(...overrideReview)).rejects.toThrow("Not recorded");
  hub.state.hub = "up";
  const round = join(pr.pullRequest, "reviews/1");
  const staged = readFileSync(join(round, "panel.staged.json"), "utf8");
  rmSync(join(round, "panel.staged.json"));
  writeFileSync(join(round, "round.lock"), JSON.stringify({ pid: process.pid, token: "briefing", started: "Sun Oct 25 11:00:00 2026" }));
  pr.panel.onPause = async () => {
    writeFileSync(join(round, "panel.staged.json"), staged);
    rmSync(join(round, "round.lock"));
  };

  const waited = await pr.hedge("review", "--wait");
  expect(waited.code).toBe(0);
  expect(waited.output).toContain("FINDINGS:\n(none)");
  expect(reviewer.prompts()).toHaveLength(pairLenses);
  await expectCountedPanel(pr);
});

test("a hedge review with another scope refuses the round whose decision is not recorded yet and names it", async () => {
  const { pr } = await overridePanel();
  const reviewed = await pr.commit("feature.txt", "greet again\n");
  const hub = hubAt(pr, "drops appends");
  await expect(pr.hedge(...overrideReview)).rejects.toThrow("Not recorded");
  hub.state.hub = "up";

  const round = join(pr.pullRequest, "reviews/1");
  await expect(pr.hedge("review", "--scope", "final", "--base", reviewed, "--agent", "one last read")).rejects.toThrow(`Review round 1 at this HEAD is reserved with --scope full, and its decision is not recorded yet. Run its command again with --scope full to record it, or remove ${round} to drop it`);
  await expect(pr.hedge("review", "--lens", "correctness", "--scope", "final", "--base", reviewed, "--agent", "one last read")).rejects.toThrow("Review round 1 at this HEAD is reserved with --scope full");
  expect((await pr.hedge(...overrideReview)).code).toBe(0);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await expectCountedPanel(pr);
});

test("a review at a newer commit leaves alone the panel round that a command at an older commit still prepares and records", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHeadFixed(pr, "feature.txt:1", "greet");
  const older = await pr.commit("feature.txt", "greet the member\n");
  const reviewer = fakeModel(pr, "REVIEWER", clean);
  const hub = hubAt(pr, "stalls after it lands an append");
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  pr.choose("Run one more round");
  const first = pr.hedge("review", "--scope", "final", "--base", reviewed, "--lens", "correctness", "--override", `2026-10-25 "Run one more round"`);
  await hub.appendStalled;
  hub.state.hub = "up";
  const newer = await pr.commit("feature.txt", "greet the new member\n");

  const review = await pr.hedge("review", "--scope", "fixes", "--base", reviewed);
  expect(review.code).toBe(0);
  expect(JSON.parse(review.output.split("\n")[0]!)).toMatchObject({ round: 2, id: "2" });
  hub.releaseAppends();
  expect((await first).code).toBe(0);
  expect((await pr.hedge("review", "--wait", "--round", "final")).code).toBe(0);

  const round = (id: string) => JSON.parse(readFileSync(join(pr.pullRequest, "reviews", id, "round.json"), "utf8"));
  expect(round("final-1")).toMatchObject({ commit: older, recorded: true });
  expect(round("2")).toMatchObject({ commit: newer });
  const [single, panel] = reviewer.prompts();
  expect(panel).toContain("+greet the member");
  expect(panel).not.toContain("+greet the new member");
  expect(single).toContain("+greet the new member");
});

test("a late single-reviewer command, after a retry finished its round, prints the saved findings and runs no second reviewer", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings, the greeting is right.");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  const single = ["review", "--single", "--override", `2026-10-25 "Run one more round"`];
  const late = pr.hedgeAs(await exitedPid(), ...single);
  await hub.appendStalled;
  hub.state.hub = "up";
  expect((await pr.hedge(...single)).code).toBe(0);

  hub.releaseAppends();
  const ended = await late;
  expect(ended.code).toBe(0);
  expect(ended.output).toContain("No findings, the greeting is right.");
  expect(reviewer.prompts()).toHaveLength(1);
});

test("rerunning a failed lens rebuilds its brief and runs it in the checkout of now", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");
  const cwds = join(pr.home, "reviewer-cwds");
  pr.env.HEDGE_PROOF_REVIEWER = `pwd >> "${cwds}"; ${pr.env.HEDGE_PROOF_REVIEWER}`;
  writeFileSync(join(pr.repository, "incidents.md"), "No incident yet.\n");
  await pr.hedge("review", "--lens", "correctness", "--knowledge", "correctness=incidents.md");
  expect((await pr.hedge("review", "--wait")).code).toBe(1);

  const other = fixture("hedge-proof-other-checkout-");
  await pr.git("worktree", "add", "-q", "--detach", other, head);
  writeFileSync(join(other, "incidents.md"), "A greeting once leaked a member's email.\n");
  reviewer.answer(clean);
  await pr.hedgeIn(other, "review", "--lens", "correctness", "--knowledge", "correctness=incidents.md");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts().filter((prompt) => prompt.includes("A greeting once leaked a member's email."))).toHaveLength(1);
  expect(readFileSync(cwds, "utf8").trim().split("\n").at(-1)).toBe(realpathSync(other));
});

test("a Security lane lens runs on the security row of the model table at its effort, whoever wrote the PR, and :same moves it to the author's reviewer", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.env.HEDGE_MODELS = JSON.stringify([...models, { role: "security", work: "Deep security review", provider: "codex", model: "security-model", effort: "xhigh" }]);
  pr.env.HEDGE_PROOF_REVIEWER_MODEL = "candidate-model";
  const codex = recordingModel(pr, "codex", "Looks fine to me.");

  await pr.hedge("review", "--lens", "security", "--lens", "correctness");
  expect(new Set(codex.calls().map((call) => call.split(" -s ")[0]))).toEqual(new Set(['exec --json -m security-model -c model_reasoning_effort="xhigh"', 'exec --json -m candidate-model -c model_reasoning_effort="high"']));
  const directory = join(pr.pullRequest, "reviews/1");
  expect((await readPlan(directory))!.lenses.map(({ name, family, model, security }) => ({ name, family, model, security }))).toEqual([
    { name: "security", family: "gpt", model: "security-model", security: true },
    { name: "correctness", family: "gpt", model: "candidate-model", security: undefined },
    { name: "risk", family: "gpt", model: "candidate-model", security: undefined },
    { name: "fresh-eyes", family: "claude", model: "candidate-model", security: undefined },
  ]);
  expect((await pr.hedge("review", "--wait")).code).toBe(1);

  const claude = recordingModel(pr, "claude", clean);
  recordingModel(pr, "codex", clean);
  await pr.hedge("review", "--lens", "security:same", "--lens", "correctness");
  expect(claude.calls()).toEqual([expect.stringMatching(/^-p --model candidate-model --effort high /), expect.stringMatching(/^-p --model candidate-model --effort high /)]);
  const security = (await readPlan(directory))!.lenses[0]!;
  expect([security.family, security.model, security.security]).toEqual(["claude", "candidate-model", undefined]);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
});

test("a combined review never casts a lens whose row has no model family, whichever order the lenses come in", () => {
  const lens = (name: string, provider: string, family?: "gpt"): Lens => ({ name, title: name, ...(family ? { family } : {}), row: { role: "review", work: "Review", provider, model: `${provider}-model`, effort: "high" }, security: false, text: name, knowledge: "", context: true });
  const risk = lens("risk", "antigravity");
  const correctness = lens("correctness", "codex", "gpt");
  expect(combinedLens([risk, correctness], "gpt").row.provider).toBe("codex");
  expect(combinedLens([correctness, risk], "gpt").row.provider).toBe("codex");
});
