import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { AvailableSource, ProfileFile } from "../pack/types.ts";
import { defaultSources } from "../setup/defaults.ts";
import { cachedCheckout, isolateGit, spawnGit, template, tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine } from "../testing/packs.ts";
import { settingsCommand } from "./settings.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");

const profiles = new Map<string, (target: string) => Promise<string>>();

function profileTemplate(settings: Record<string, unknown>) {
  const key = JSON.stringify(settings);
  const built = profiles.get(key) ?? template(async (home) => {
    const remote = join(home, "remote.git");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", remote);
    const dir = join(home, "profile");
    await spawnGit(home, "clone", "-q", remote, dir);
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: defaultSources, packs: ["pull-requests"], plan: "both", settings, workflows: {} };
    writeFileSync(join(dir, "hedge.json"), JSON.stringify(profile, null, 2) + "\n");
    await spawnGit(dir, "add", "hedge.json");
    await spawnGit(dir, "commit", "-q", "-m", "Start");
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
  });
  profiles.set(key, built);
  return built;
}

async function machineWithProfile(settings: Record<string, unknown> = {}) {
  const home = await profileTemplate(settings)(temp.make("home-"));
  const remote = join(home, "remote.git");
  const dir = join(home, "profile");
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: dir }));
  const elsewhere = async (change: (file: ProfileFile) => ProfileFile) => {
    const other = temp.make("other-");
    await spawnGit(other, "clone", "-q", remote, ".");
    writeFileSync(join(other, "hedge.json"), JSON.stringify(change(JSON.parse(readFileSync(join(other, "hedge.json"), "utf8"))), null, 2) + "\n");
    await spawnGit(other, "commit", "-q", "-am", "Elsewhere");
    await spawnGit(other, "push", "-q");
  };
  return { home, elsewhere, pushed: async () => JSON.parse(await spawnGit(home, "--git-dir", remote, "show", "main:hedge.json")) };
}

/** Puts a fetched source with a pack whose first workflow yields to its second in this machine's cache, and turns that pack on in the profile. */
async function withYieldingPack(home: string) {
  const source = join(home, ".local/share/hedge/sources/team");
  await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
  mkdirSync(join(source, "packs/team"), { recursive: true });
  const flow = (id: string, yields: string[] = []) => ({ id, name: id, sentence: `${id}.`, default: true, yields });
  writeFileSync(join(source, "packs/team/pack.json"), JSON.stringify({ schema: 1, name: "team", summary: "Team rules.", workflows: [flow("direct", ["routed"]), flow("routed")] }));
  const dir = join(home, "profile");
  const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")) as ProfileFile;
  writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...file.packs, "team"] }, null, 2) + "\n");
  await spawnGit(dir, "commit", "-q", "-am", "Team");
  await spawnGit(dir, "push", "-q");
}

async function hedge(home: string, args: string[], applyCode = 0) {
  const lines: string[] = [];
  const applied: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), applyCode);
  const code = await main(args, { home, engineRoot, platform: "linux", print: (line) => lines.push(line), apply });
  return { code, output: lines.join("\n"), applied };
}

describe("hedge packs", () => {
  test("lists every pack, marks the ones that are on, and shows their workflows", async () => {
    const { home } = await machineWithProfile();
    const result = await hedge(home, ["packs"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ pull-requests  ");
    expect(result.output).toContain("      Workflows: draft-prs on, pr-care on, ship-words on");
    expect(result.output).toContain("  · memory  ");
    expect(result.output).toEndWith("Change them with hedge packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]....");
  });

  test("turns packs and workflows on and off, pushes the profile, and applies here", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["packs", "--add", "communication", "--workflows", "quality-loop=on,pr-care=off"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ Saved your packs in your profile and pushed it.");
    expect(result.output).toEndWith("This machine has it now. Your other machines pick it up at their next hedge update.");
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "quality-loop": true, "pr-care": false } });
    expect(result.applied).toEqual([join(home, "profile")]);

    const removed = await hedge(home, ["packs", "--remove", "communication", "--workflows", "pr-care=on"]);
    expect(removed.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests"], workflows: { "quality-loop": true } });
  });

  test("works on the packs and workflows another machine pushed, so a change here keeps theirs", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: [...file.packs, "memory"], workflows: { "pr-care": false } }));
    const result = await hedge(home, ["packs", "--add", "communication"]);
    expect(result.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "memory", "communication"], workflows: { "pr-care": false } });
  });

  test("shows a workflow's terms note in the list and again when it is turned on", async () => {
    const { home, pushed } = await machineWithProfile();
    const risk = JSON.parse(await Bun.file(join(engineRoot, "packs/hub/pack.json")).text()).workflows.find((workflow: { id: string }) => workflow.id === "own-account-balancing").risk;
    expect(risk).toContain("Anthropic");
    const before = await hedge(home, ["packs"]);
    expect(before.output).not.toContain("Terms note for own-account-balancing");

    const turnedOn = await hedge(home, ["packs", "--add", "hub", "--workflows", "own-account-balancing=on"]);
    expect(turnedOn.code).toBe(0);
    expect(turnedOn.output).toContain(`Before you use Own-account balancing: ${risk}`);
    expect(await pushed()).toMatchObject({ workflows: { "own-account-balancing": true } });

    const listed = await hedge(home, ["packs"]);
    expect(listed.output).toContain(`      Terms note for own-account-balancing: ${risk}`);
    const off = await hedge(home, ["packs", "--workflows", "own-account-balancing=off"]);
    expect(off.output).not.toContain("Before you use");
  });

  test("shows the terms note when re-adding a pack brings back a workflow that was left on", async () => {
    const { home, pushed } = await machineWithProfile();
    await hedge(home, ["packs", "--add", "hub", "--workflows", "own-account-balancing=on"]);
    const removed = await hedge(home, ["packs", "--remove", "hub"]);
    expect(removed.output).not.toContain("Before you use");
    expect(await pushed()).toMatchObject({ workflows: { "own-account-balancing": true } });

    const readded = await hedge(home, ["packs", "--add", "hub"]);
    expect(readded.output).toContain("Before you use Own-account balancing: ");
    const unrelated = await hedge(home, ["packs", "--add", "communication"]);
    expect(unrelated.output).not.toContain("Before you use");
  });

  test("keeps workflow choices of packs whose source is not on this machine, and takes --set like setup", async () => {
    const { home, pushed } = await machineWithProfile();
    const dir = join(home, "profile");
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...JSON.parse(await spawnGit(dir, "show", "HEAD:hedge.json")), workflows: { "team-dangerous": false } }, null, 2) + "\n");
    await spawnGit(dir, "commit", "-q", "-am", "Turn off a team workflow");
    const result = await hedge(home, ["packs", "--add", "communication", "--set", "pull-requests.freeReviews=3"]);
    expect(result.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "team-dangerous": false }, settings: { "pull-requests.freeReviews": 3 } });
  });

  test("refuses to leave a pack without a pack it needs", async () => {
    const { home, pushed } = await machineWithProfile();
    expect((await hedge(home, ["packs", "--add", "orchestration"])).code).toBe(0);
    const result = await hedge(home, ["packs", "--remove", "pull-requests"]);
    expect(result.code).toBe(2);
    expect(result.output).toStartWith("hedge packs: Orchestration needs Quality gates. Add pull-requests, or remove orchestration.");
    expect((await pushed()).packs).toEqual(["pull-requests", "orchestration"]);
  });

  test("a change that does not apply here stays saved, and says how to finish", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["packs", "--add", "communication"], 1);
    expect(result.code).toBe(1);
    expect((await pushed()).packs).toEqual(["pull-requests", "communication"]);
    expect(result.output).toEndWith("The change is saved. Fix what it says above, then run hedge apply.");
  });

  test("says why a workflow is off when it yields, in the list and when a choice to turn it on has no effect", async () => {
    const { home } = await machineWithProfile();
    await withYieldingPack(home);
    expect((await hedge(home, ["packs"])).output).toContain("      Workflows: direct off: yields to workflow routed, routed on");
    const turnedOn = await hedge(home, ["packs", "--workflows", "direct=on"]);
    expect(turnedOn.code).toBe(0);
    expect(turnedOn.output).toContain("direct is on in your profile, but stays off: yields to workflow routed.");
    const swapped = await hedge(home, ["packs", "--workflows", "direct=on,routed=off"]);
    expect(swapped.output).not.toContain("stays off");
  });

  test("refuses unknown packs and workflows without touching the profile", async () => {
    const { home, pushed } = await machineWithProfile();
    for (const [args, message] of [
      [["--add", "nope"], "hedge packs: no pack named nope."],
      [["--remove", "base"], "hedge packs: the base pack is always on"],
      [["--workflows", "nope=on"], "hedge packs: --workflows: no workflow named nope"],
      [["--preset", "starter"], "hedge packs: usage: hedge packs"],
    ] as const) {
      const result = await hedge(home, ["packs", ...args]);
      expect(result.code).toBe(2);
      expect(result.output).toStartWith(message);
    }
    expect((await pushed()).packs).toEqual(["pull-requests"]);
  });

  test("marks a pack and its workflows as needing setup while a human probe fails, skips off workflows, and flips back when it passes", async () => {
    const { home } = await machineWithProfile();
    const source = join(home, ".local/share/hedge/sources/team");
    await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
    mkdirSync(join(source, "packs/team"), { recursive: true });
    writeFileSync(
      join(source, "packs/team/pack.json"),
      JSON.stringify({
        schema: 1,
        name: "team",
        summary: "Team tools.",
        workflows: [
          { id: "sync", name: "Sync", sentence: "Sync notes.", default: true },
          { id: "other", name: "Other", sentence: "Other flow.", default: true },
          { id: "off-flow", name: "Off", sentence: "Off flow.", default: false },
        ],
        human: [
          { id: "auth", say: "Sign in.", probe: ["sh", "-c", 'test -f "$HOME/.team-auth"'] },
          { id: "off-auth", say: "Off sign in.", workflow: "off-flow", probe: ["sh", "-c", "exit 1"] },
        ],
        steps: [{ id: "sync-step", run: ["true"], after: "auth", workflow: "sync" }],
      }),
    );
    const dir = join(home, "profile");
    const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...file.packs, "team"] }, null, 2) + "\n");
    await spawnGit(dir, "commit", "-q", "-am", "Team");
    await spawnGit(dir, "push", "-q");

    const failing = await hedge(home, ["packs"]);
    expect(failing.code).toBe(0);
    expect(failing.output).toContain("  ~ team  Team tools.");
    expect(failing.output).toContain("      Workflows: sync needs setup, other on, off-flow off");
    expect(failing.output).toContain("Some packs still need setup on this machine. Run hedge doctor to see what is left.");

    writeFileSync(join(home, ".team-auth"), "ok\n");
    const passing = await hedge(home, ["packs"]);
    expect(passing.code).toBe(0);
    expect(passing.output).toContain("  ✓ team  Team tools.");
    expect(passing.output).toContain("      Workflows: sync on, other on, off-flow off");
    expect(passing.output).not.toContain("Some packs still need setup");
  });

  test("marks hub-only served workflows only on the hub, renders CLI probe timeouts as not checked, and kills probes on SIGINT", async () => {
    const { home } = await machineWithProfile();
    const source = join(home, ".local/share/hedge/sources/team");
    await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
    mkdirSync(join(source, "packs/team"), { recursive: true });
    writeFileSync(
      join(source, "packs/team/pack.ts"),
      `import { readFileSync } from "node:fs";
import { join } from "node:path";
export default {
  sdk: 1,
  name: "team",
  summary: "Team tools.",
  register(hedge) {
    const serve = hedge.workflow({ id: "serve-flow", name: "Serve", default: true, sentence: "Served flow." });
    hedge.workflow({ id: "plain-flow", name: "Plain", default: true, sentence: "Plain flow." });
    const auth = hedge.check({
      id: "hub-auth",
      say: "Sign in on hub.",
      test: async () => {
        const homeDir = process.env.HOME!;
        const mode = readFileSync(join(homeDir, "probe-mode"), "utf8").trim();
        if (mode === "fail") return false;
        const suffix = mode === "hang2" ? "2" : "";
        await Bun.spawn(["sh", "-c", 'exec 3>"$HOME/hold' + suffix + '"; sleep 30 >&3 & echo ready > "$HOME/ready' + suffix + '"; wait'], { env: { ...Bun.env, HOME: homeDir }, stdout: "ignore", stderr: "ignore" }).exited;
        return false;
      },
    });
    hedge.service({ on: "hub", when: serve, id: "api", after: auth, serve: { port: 9123, health: "/health", credential: async () => "k" } });
  },
};
`,
    );
    const dir = join(home, "profile");
    const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, hub: "hub-box", devboxes: ["node-1"], sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...file.packs, "team"] }, null, 2) + "\n");
    await spawnGit(dir, "commit", "-q", "-am", "Team");
    await spawnGit(dir, "push", "-q");

    const setHost = (name: string) => writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", name, profileDir: dir }));
    writeFileSync(join(home, "probe-mode"), "fail\n");
    setHost("hub-box");
    const onHub = await hedge(home, ["packs"]);
    expect(onHub.code).toBe(0);
    expect(onHub.output).toContain("  ~ team  Team tools.");
    expect(onHub.output).toContain("      Workflows: serve-flow needs setup, plain-flow on");

    setHost("node-1");
    const onNode = await hedge(home, ["packs"]);
    expect(onNode.code).toBe(0);
    expect(onNode.output).toContain("  ~ team  Team tools.");
    expect(onNode.output).toContain("      Workflows: serve-flow on, plain-flow on");

    setHost("hub-box");
    writeFileSync(join(home, "probe-mode"), "hang\n");
    const ready = join(home, "ready");
    const hold = join(home, "hold");
    expect(await Bun.spawn(["mkfifo", ready, hold]).exited).toBe(0);
    const holdClosed = Bun.spawn(["cat", hold], { stdout: "ignore", stderr: "ignore" }).exited;
    const readySeen = Bun.spawn(["cat", ready], { stdout: "ignore", stderr: "ignore" }).exited;
    let expire: (() => void) | undefined;
    const lines: string[] = [];
    const pending = main(["packs"], {
      home,
      engineRoot,
      platform: "linux",
      print: (line) => lines.push(line),
      apply: async () => 0,
      clock: { now: () => 0, sleep: () => new Promise<void>((resolve) => { expire = resolve; }) },
    });
    expect(await readySeen).toBe(0);
    expire?.();
    expect(await pending).toBe(0);
    expect(await holdClosed).toBe(0);
    const timedOut = lines.join("\n");
    expect(timedOut).toContain("  ? team  Team tools.");
    expect(timedOut).toContain("      Workflows: serve-flow not checked, plain-flow on");
    expect(timedOut).toContain("Some setup checks did not finish in time. Run hedge doctor to check them.");

    writeFileSync(join(home, "probe-mode"), "hang2\n");
    const hold2 = join(home, "hold2");
    const ready2 = join(home, "ready2");
    expect(await Bun.spawn(["mkfifo", ready2, hold2]).exited).toBe(0);
    const hold2Closed = Bun.spawn(["cat", hold2], { stdout: "ignore", stderr: "ignore" }).exited;
    const ready2Seen = Bun.spawn(["cat", ready2], { stdout: "ignore", stderr: "ignore" }).exited;
    const cli = Bun.spawn([process.execPath, join(engineRoot, "src/cli.ts"), "packs"], { env: { ...Bun.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
    expect(await ready2Seen).toBe(0);
    cli.kill("SIGINT");
    await cli.exited;
    expect(await hold2Closed).toBe(0);
  });
});

describe("hedge packs with a profile that still names an old pack", () => {
  test("adds or removes exactly the name given and saves an old name as written, so removing recovery leaves Hub fully on", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "hub"] }));
    expect((await hedge(home, ["packs", "--add", "recovery", "--add", "context-library"])).code).toBe(0);
    expect((await pushed()).packs).toEqual(["pull-requests", "hub", "recovery", "context-library"]);
    const listed = (await hedge(home, ["packs"])).output;
    expect(listed).toContain("  · memory  ");
    expect(listed).toContain("      The old name context-library selects only: context-library. Add memory for the whole pack.\n      Workflows: shared-memory off, context-library off: waits for setting context-library.repo, dream off");
    expect(listed).not.toContain("Only part is on");
    expect(listed).not.toContain("context-library  ");
    expect((await hedge(home, ["packs", "--remove", "recovery"])).code).toBe(0);
    expect((await pushed()).packs).toEqual(["pull-requests", "hub", "context-library"]);
    expect((await hedge(home, ["packs"])).output).toContain("disk-watch on, linked-hub on");
  });

  test("keeps a workflow value the profile states when a change leaves it alone, even one that equals the default, and adds only choices that differ from it", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "guards"], workflows: { "shell-guards": true, "package-age": true } }));
    expect((await hedge(home, ["packs", "--add", "communication", "--workflows", "merge-gate=off"])).code).toBe(0);
    expect((await pushed()).workflows).toEqual({ "shell-guards": true, "package-age": true });
  });

  test("says a workflow stays off for a missing setting only when the same command does not set it", async () => {
    const { home, elsewhere } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "context-library"], workflows: { "context-library": false } }));
    const warning = "context-library is on in your profile, but stays off: waits for setting context-library.repo.";
    expect((await hedge(home, ["packs", "--workflows", "context-library=on"])).output).toContain(warning);
    expect((await hedge(home, ["packs", "--workflows", "context-library=on", "--set", "context-library.repo=example/library"])).output).not.toContain(warning);
  });
});

describe("hedge settings and hedge set", () => {
  test("lists the settings of the packs that are on, with defaults marked", async () => {
    const { home } = await machineWithProfile({ "pull-requests.panelSlots": 4 });
    const result = await hedge(home, ["settings"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  pull-requests.freeReviews = 2 (default)");
    expect(result.output).toContain("  pull-requests.panelSlots = 4");
    expect(result.output).toContain("  pull-requests.mergeCommand = not set");
    expect(result.output).not.toContain("memory.repo");
    expect(result.output).toEndWith("Change one with hedge set <pack.key>=<value>.");
  });

  test("lists an engine setting once when a pack overrides its default, with the value that wins", async () => {
    const engine = await engineSource();
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const plan = resolveEngine([engine, team], { packs: ["team"] });
    const lines: string[] = [];
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [team.ref], packs: ["team"], plan: "both", settings: {}, workflows: {} } satisfies ProfileFile;
    const code = settingsCommand([], { profile, plan, packs: [...engine.packs, ...team.packs], print: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(lines.filter((line) => line.includes("identity.signer ="))).toEqual(["  identity.signer = 1password (default)"]);
    expect(lines).not.toContain("team:");
  });

  test("says Hedge needs an engine setting only when the declaration that wins needs it", async () => {
    const engine = await engineSource();
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], optional: true as const, ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const plan = resolveEngine([engine, team], { packs: ["team"] });
    expect(plan.settings["identity.signer"]).toBeUndefined();
    const lines: string[] = [];
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [team.ref], packs: ["team"], plan: "both", settings: {}, workflows: {} } satisfies ProfileFile;
    settingsCommand([], { profile, plan, packs: [...engine.packs, ...team.packs], print: (line) => lines.push(line) });
    expect(lines.filter((line) => line.includes("identity.signer ="))).toEqual(["  identity.signer = not set"]);
  });

  test("checks each value against its type, then pushes and applies it", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["set", "pull-requests.freeReviews=4", "--set", "memory.repo=me/notes"]);
    expect(result.code).toBe(0);
    expect((await pushed()).settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
    expect(result.output).toContain("✓ Saved pull-requests.freeReviews, memory.repo in your profile and pushed it.");
    expect(result.output).toContain("The memory pack is off, so its setting waits until you turn it on with hedge packs --add memory.");

    for (const [arg, message] of [
      ["pull-requests.freeReviews=many", "hedge set: pull-requests.freeReviews takes a number"],
      ["nope.key=1", "hedge set: nope.key: no pack has this setting."],
      ["freeReviews", "hedge set: freeReviews: write it as pack.key=value"],
    ]) {
      const refused = await hedge(home, ["set", arg!]);
      expect(refused.code).toBe(2);
      expect(refused.output).toStartWith(message!);
    }
    expect((await pushed()).settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
  });
});
