import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { onHub } from "../../src/hub/ssh.ts";
import { spawnAsync } from "../../src/testing/spawn.ts";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { isolateGit, tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { flush } from "./lib/usage-flush.ts";

isolateGit();
const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "hedge");
const temp = tempDirs();
afterEach(() => temp.cleanup());

const secret = () => ["sk", "ant", "api03", crypto.randomUUID().replaceAll("-", "")].join("-");
const projectKey = () => ["phc", "test", crypto.randomUUID().replaceAll("-", "")].join("_");
const spool = (home: string) => join(home, ".local/state/hedge/usage.jsonl");
const spooled = (home: string) => (existsSync(spool(home)) ? readFileSync(spool(home), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

type Received = { path: string; body: { api_key: string; batch: Array<{ event: string; properties: Record<string, unknown> }> } };
const received: Received[] = [];
let answers: number[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    received.push({ path: new URL(request.url).pathname, body: await request.json() });
    return new Response("{}", { status: answers.shift() ?? 200 });
  } });
});
afterAll(() => server.stop(true));
afterEach(() => void (received.length = 0, answers = []));

async function hedge(args: string[], home: string, env: Record<string, string> = {}, interactive = false) {
  const runHedgeSteps = async (command: string[], stepEnv: Record<string, string> = {}) => (command[1] === launcher ? (await hedge(command.slice(2), home, { HEDGE_PROFILE_DIR: join(home, "profile"), ...stepEnv })).code : 0);
  const lines: string[] = [];
  const code = await main(args, { home, engineRoot, platform: "linux", env: { ...env }, print: (line) => lines.push(line), fail: (line) => lines.push(line), run: runHedgeSteps, interactive });
  return { code, output: lines.join("\n") };
}

async function machine(packs: string[], settings: Record<string, string>, workflows: Record<string, boolean> = { "usage-events": true }) {
  const home = temp.make("home-");
  const profile = join(home, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs, plan: "both", settings, workflows }));
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
  const applied = await hedge(["apply", "--profile", profile], home);
  expect(applied.code).toBe(0);
  return home;
}

const destination = (key = projectKey()) => ({ "base.usageHost": `http://127.0.0.1:${server.port}`, "base.usageProjectKey": key });

describe("the Usage events workflow", () => {
  test("is off by default, and once on flushes every five minutes and asks for a destination, since it has none by default", async () => {
    const engine = await engineSource();
    const sources = [engine, ...skillSources(temp.make("skills-"), engine)];
    const off = resolveEngine(sources, {}, devbox);
    expect(off.jobs.map((job) => job.id)).not.toContain("usage-flush");
    expect(Object.keys(off.settings).filter((key) => key.startsWith("base.usage"))).toEqual([]);
    const on = resolveEngine(sources, { workflows: { "usage-events": true } }, devbox);
    expect(on.jobs).toContainEqual(expect.objectContaining({ id: "usage-flush", command: ["hedge", "usage", "flush"], schedule: { every: "5m" } }));
    expect(on.unanswered.map((setting) => setting.key)).toEqual(["base.usageHost", "base.usageProjectKey"]);
  });

  test("names a pack command's own first words, which its pack declares in pack.json or pack.ts", async () => {
    const engine = await engineSource();
    const sources = [engine, ...skillSources(temp.make("skills-"), engine)];
    const plan = resolveEngine(sources, { packs: ["pull-requests", "slack"] }, devbox);
    expect(plan.commands.pr?.subcommands).toContain("review");
    expect(plan.commands["slack-trigger"]?.subcommands).toContain("launch");
    expect(plan.commands.proof?.subcommands).not.toContain("box4817");
  });

  test("turning the workflow off deletes the spooled events and the batch that waits to be sent", async () => {
    const home = await machine([], destination());
    await hedge(["settings"], home);
    writeFileSync(join(home, ".local/state/hedge/usage.sending.jsonl"), "{}\n");
    writeFileSync(join(home, ".local/state/hedge/usage.sending.jsonl.new"), "{}\n");
    writeFileSync(join(home, "profile/hedge.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "profile/hedge.json"), "utf8")), workflows: {} }));
    expect((await hedge(["apply", "--profile", join(home, "profile")], home)).code).toBe(0);
    await hedge(["settings"], home);
    for (const file of ["usage.jsonl", "usage.sending.jsonl", "usage.sending.jsonl.new"]) expect(existsSync(join(home, ".local/state/hedge", file))).toBe(false);
  });

  test("a machine with the workflow off spools nothing, though the profile names a destination", async () => {
    const home = await machine(["memory"], { "memory.repo": "me/notes", ...destination() }, {});
    await hedge(["settings"], home);
    expect(existsSync(spool(home))).toBe(false);
    expect((await hedge(["usage", "flush"], home)).code).toBe(1);
    expect(received).toEqual([]);
  });
});

describe("usage events", () => {
  test("carry command names and plain subcommands, never arguments, prompts, file contents, or secrets", async () => {
    const key = projectKey();
    const home = await machine([], destination(key));
    const token = secret();
    const prompt = `Please read /home/someone/customer-notes.md and use ${token}`;
    await hedge(["settings", token], home, { CLAUDECODE: "1" });
    await hedge(["run", "/home/someone/customer-notes.md"], home, {}, true);
    await hedge(["packs", "--add", prompt], home);
    await hedge([token], home);
    await hedge(["hub", "box4817"], home);
    await hedge(["hub", "status"], home);
    await hedge(["devbox", "list"], home);
    await hedge(["settings-snapshot", "box4817"], home);
    await hedge(["settings-snapshot", "--check"], home);

    const events = spooled(home).map(({ event, properties }) => ({ event, ...properties }));
    expect(events.map(({ event, command, subcommand, caller }) => ({ event, command, subcommand, caller }))).toEqual([
      { event: "hedge command", command: "settings", subcommand: "", caller: "agent" },
      { event: "hedge command", command: "run", subcommand: "", caller: "person" },
      { event: "hedge command", command: "packs", subcommand: "", caller: "job" },
      { event: "hedge command", command: "hub", subcommand: "", caller: "job" },
      { event: "hedge command", command: "hub", subcommand: "status", caller: "job" },
      { event: "hedge command", command: "devbox", subcommand: "", caller: "job" },
      { event: "hedge command", command: "settings-snapshot", subcommand: "", caller: "job" },
      { event: "hedge command", command: "settings-snapshot", subcommand: "", caller: "job" },
    ]);

    expect((await hedge(["usage", "flush"], home)).code).toBe(0);
    const sent = JSON.stringify(received);
    for (const leak of [token, "customer", "Please read", "4817"]) expect(sent).not.toContain(leak);
    expect(received.map((request) => [request.path, request.body.api_key, request.body.batch.length])).toEqual([["/batch/", key, 8]]);
    expect(received[0]!.body.batch[0]!.properties).toMatchObject({ distinct_id: expect.stringMatching(/^hedge-/), $process_person_profile: false });
    expect(existsSync(spool(home))).toBe(false);
  });

  test("a flush sends each event once", async () => {
    const home = await machine([], destination());
    await hedge(["settings"], home);
    await hedge(["usage", "flush"], home);
    await hedge(["usage", "flush"], home);
    expect(received.map((request) => request.body.batch.map((event) => [event.event, event.properties.distinct_id]))).toEqual([[["hedge command", expect.stringMatching(/^hedge-/)]]]);
  });

  test("a machine that cannot send keeps at most 5 MB of events", async () => {
    const home = await machine([], destination());
    writeFileSync(join(home, ".local/state/hedge/usage.sending.jsonl"), "x".repeat(4_999_990));
    await hedge(["settings"], home);
    await hedge(["packs"], home);
    expect(spooled(home).map((line) => line.properties.command)).toEqual(["settings"]);
  });
});

describe("a command a node forwards to the hub", () => {
  test("counts once: the hub does not record the call Hedge forwarded to it", async () => {
    const hub = await machine([], destination());
    const engine = join(hub, ".local/share/hedge/engine");
    mkdirSync(engine, { recursive: true });
    writeFileSync(join(engine, "hedge"), `exec "${process.execPath}" "${join(engineRoot, "src/cli.ts")}" "$@"\n`);
    const forwarded = onHub("hub-1", ["settings"]).at(-1)!;
    const ran = await spawnAsync(["sh", "-c", forwarded], { env: { HOME: hub, PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    expect(ran.exitCode).toBe(0);
    expect(spooled(hub)).toEqual([]);
    await hedge(["settings"], hub);
    expect(spooled(hub)).toHaveLength(1);
  });
});

describe("hedge usage flush", () => {
  const to = () => ({ host: `http://127.0.0.1:${server.port}`, projectKey: projectKey() });
  const io = () => ({ send: fetch });

  test("keeps the events when the send fails, and sends them with the next events on the next flush", async () => {
    const home = await machine([], destination());
    await hedge(["settings"], home);
    answers = [500];
    await expect(flush(home, to(), io())).rejects.toThrow("answered 500. The events stay in the spool for the next flush.");
    await hedge(["packs"], home);
    received.length = 0;
    expect(await flush(home, to(), io())).toBe(2);
    expect(received[0]!.body.batch.map((event) => event.properties.command).sort()).toEqual(["packs", "settings"]);
  });

  test("sends a batch that a flush left between its two steps once, whichever step it stopped at", async () => {
    const event = (command: string) => `${JSON.stringify({ event: "hedge command", properties: { command, machine: "m" }, timestamp: "2026-11-12T00:00:00.000Z" })}\n`;
    const state = (home: string) => join(home, ".local/state/hedge");
    for (const stoppedAfterAppend of [false, true]) {
      const home = await machine([], destination());
      writeFileSync(join(state(home), "usage.sending.jsonl"), event("waiting") + (stoppedAfterAppend ? event("arrived") : ""));
      writeFileSync(join(state(home), "usage.sending.jsonl.new"), event("arrived"));
      writeFileSync(join(state(home), "usage.jsonl"), event("newest"));
      received.length = 0;
      expect(await flush(home, to(), io())).toBe(3);
      expect(received[0]!.body.batch.map((item) => item.properties.command).sort()).toEqual(["arrived", "newest", "waiting"]);
      for (const file of ["usage.jsonl", "usage.sending.jsonl", "usage.sending.jsonl.new"]) expect(existsSync(join(state(home), file))).toBe(false);
    }
  });

  test("refuses a host that would send the project key in the clear", async () => {
    const home = await machine([], { ...destination(), "base.usageHost": "http://analytics.example.test" });
    await hedge(["settings"], home);
    expect((await hedge(["usage", "flush"], home)).code).toBe(1);
    expect(received).toEqual([]);
    expect(spooled(home)).toHaveLength(1);
  });
});
