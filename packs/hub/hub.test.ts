import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { jobsAdapter } from "../../src/adapters/jobs/adapter.ts";
import { providerConfigAdapter } from "../../src/adapters/provider-config/adapter.ts";
import { apply, check } from "../../src/reconciler/apply.ts";
import { boxCommand } from "./lib/box-command.ts";
import { cliProxy, codexProviderTable, proxyUrl, type ProxyMachine } from "./lib/cli-proxy.ts";
import { clientKey, dataDir, hedgeApply, hedgeProxy, proxyMachine, proxyOnly, type Proxy } from "./lib/cli-proxy-testing.ts";
import { Coder } from "./lib/coder.ts";
import { fakeMachine } from "./lib/testing.ts";
import type { AvailableSource, MachineFile, MachineRole, Plan, Profile } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let sources: AvailableSource[];
let shipped: string[];
beforeAll(async () => {
  const engine = await engineSource();
  sources = [engine, ...skillSources(temp.make("skills-"), engine)];
  shipped = engine.packs.map((pack) => pack.manifest.name).filter((name) => name !== "base");
});

const answers = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux" };
const plan = (fields: Partial<Profile> = {}, machine: MachineFile = devbox) => resolveEngine(sources, { settings: answers, ...fields }, machine);
const withBoxes = (fields: Partial<Profile> = {}, machine: MachineFile = devbox) => resolveEngine([...sources, coderTeam()], { settings: answers, ...fields, workflows: { boxes: true, ...fields.workflows }, packs: [...(fields.packs ?? ["hub"]), "posthog"] }, machine);
function coderTeam(): AvailableSource {
  const dir = temp.make("team-");
  return { ref: { name: "team", repo: "example/team-packs", ref: "main" }, dir, packs: [{ dir, manifest: { schema: 1, name: "posthog", summary: "A team pack that brings Coder." } }] };
}

describe("without the Hub pack and the MCP gateway pack", () => {
  const pointsAtHub = /\bhub\b|tunnel|proxy|mcphub|ANTHROPIC_BASE_URL|127\.0\.0\.1|localhost/i;
  const roles: MachineRole[] = ["mac", "devbox", "linux"];

  function random(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  }

  function hubFree(result: Plan) {
    const { jobs, human, steps, checks, config, files, commands } = result;
    const contents = files.map((file) => ("content" in file ? file.content : ""));
    const items = JSON.stringify({ jobs, human, steps, checks, config, commands, targets: files.map((file) => file.target) }, (key, value) => (key === "roles" || (key === "on" && value === "hub") ? undefined : value));
    return !pointsAtHub.test(items) && !contents.some((text) => /mcphub|ANTHROPIC_BASE_URL|127\.0\.0\.1:(8317|3317)/.test(text));
  }

  test("no shipped pack plans an item that points at a hub, tunnel, or proxy, for any packs, workflows, role, or plan", () => {
    const next = random(27);
    const workflows = sources[0]!.packs.flatMap((pack) => (pack.manifest.name === "hub" ? [] : (pack.manifest.workflows ?? []).map((workflow) => workflow.id)));
    for (let run = 0; run < 40; run++) {
      const packs = shipped.filter((name) => name !== "hub" && name !== "mcp-gateway" && next() < 0.6);
      const overrides = Object.fromEntries(workflows.filter(() => next() < 0.3).map((id) => [id, next() < 0.5]));
      const machine: MachineFile = { schema: 1, role: roles[Math.floor(next() * roles.length)] ?? "mac" };
      const ai = (["claude", "codex", "both"] as const)[Math.floor(next() * 3)];
      const result = plan({ packs, workflows: overrides, plan: ai, devboxes: next() < 0.5 ? ["box"] : [], settings: { "memory.repo": "me/notes" } }, machine);
      expect(hubFree(result)).toBe(true);
    }
  });

  test("the property sees the gateway's keys once either pack is on", () => {
    expect(hubFree(plan({ packs: ["hub"] }))).toBe(false);
    expect(hubFree(plan({ packs: ["mcp-gateway"] }))).toBe(false);
  });
});

describe("the Hub pack", () => {
  test("is off by default, and needs only itself", () => {
    expect(plan().workflows.filter((workflow) => workflow.pack === "hub" && workflow.active)).toEqual([]);
    expect(plan({ packs: ["hub"] }).packs.find((pack) => pack.name === "hub")).toMatchObject({ available: true });
  });

  test("asks setup for the hub's name, for the Coder address once a team pack brings Coder, and for the box template only while Boxes is on", () => {
    expect(resolveEngine(sources, { packs: ["hub"] }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias"]);
    expect(resolveEngine(sources, { packs: ["hub"], workflows: { boxes: true } }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias"]);
    const team = [...sources, coderTeam()];
    expect(resolveEngine(team, { packs: ["hub", "posthog"] }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias", "hub.coderUrl"]);
    expect(resolveEngine(team, { packs: ["hub", "posthog"], workflows: { boxes: true } }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias", "hub.coderUrl", "hub.boxTemplate"]);
    expect(resolveEngine(team, { packs: ["hub", "posthog"], workflows: { boxes: true }, settings: answers }, devbox).unanswered).toEqual([]);
  });

  test("keeps Boxes off by default, even when a team pack brings Coder, says why when someone turns it on, and turns it on only with Coder", () => {
    const boxes = (result: Plan) => result.workflows.find((workflow) => workflow.pack === "hub" && workflow.id === "boxes")?.active;
    const team = [...sources, coderTeam()];
    expect(boxes(resolveEngine(team, { packs: ["hub", "posthog"], settings: answers }, devbox))).toBe(false);
    expect(boxes(plan({ packs: ["hub"], workflows: { boxes: true } }))).toBe(false);
    expect(boxes(resolveEngine(team, { packs: ["hub", "posthog"], settings: answers, workflows: { boxes: true } }, devbox))).toBe(true);
    const workflow = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest.workflows!.find((item) => item.id === "boxes")!;
    expect(workflow.risk).toContain("quota");
  });

  test("declares every value the old hub code hardcoded as a setting with no default value", async () => {
    const manifest = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
    const declared = Object.fromEntries((manifest.settings ?? []).map((setting) => [setting.key, setting]));
    for (const key of ["hub.alias", "hub.coderUrl", "hub.boxTemplate", "hub.httpsHost", "hub.boxWarmCommand"]) {
      expect([key, key in declared, declared[key]?.default]).toEqual([key, true, undefined]);
    }
    const listed = new Set((manifest.workflows ?? []).flatMap((workflow) => workflow.settings ?? []));
    expect(Object.keys(declared).filter((key) => !listed.has(key))).toEqual([]);
  });

  test("plans the Boxes jobs and the Claude token step on the hub, only the forward restore on a devbox, and nothing when the workflow is off", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (machine: MachineFile, fields: Partial<Profile> = {}) => {
      const result = withBoxes(fields, machine);
      return { jobs: result.jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}${job.schedule.at ? ` at ${job.schedule.at}` : ""}`), human: result.human.filter((step) => step.pack === "hub" && step.workflow === "boxes").map((step) => step.id) };
    };
    expect(items(hub)).toEqual({
      jobs: ["box-sweep: hedge box sweep every 15m", "box-nightly: hedge box nightly every 1d at 02:47", "box-restore: hedge box restore every 5m"],
      human: ["box-claude-token"],
    });
    expect(items(devbox)).toEqual({ jobs: ["box-restore: hedge box restore every 5m"], human: [] });
    expect(items(mac)).toEqual({ jobs: [], human: [] });
    expect(items(hub, { workflows: { boxes: false } })).toEqual({ jobs: [], human: [] });
    expect(plan({ packs: ["hub"] }, hub).jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes")).toEqual([]);
  });

  test("plans the devbox token grants and the Coder session check on the hub whenever a team pack brings Coder, with Boxes off too", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (result: Plan) => [
      ...result.jobs.filter((job) => job.pack === "hub" && job.workflow === "devbox-tokens").map((job) => `job ${job.id}: ${job.command.join(" ")} every ${job.schedule.every} at ${job.schedule.at}`),
      ...result.checks.filter((item) => item.pack === "hub").map((item) => `check ${item.id}: ${item.run.join(" ")}`),
    ];
    const team = (fields: Partial<Profile>, machine: MachineFile) => resolveEngine([...sources, coderTeam()], { settings: answers, packs: ["hub", "posthog"], ...fields }, machine);
    const planned = ["job devbox-grants: hedge box grants every 1d at 02:47", "check coder-session: hedge box session"];
    expect(items(team({}, hub))).toEqual(planned);
    expect(items(team({ workflows: { boxes: false } }, hub))).toEqual(planned);
    expect(items(withBoxes({}, hub))).toEqual(planned);
    expect(items(team({ workflows: { "devbox-tokens": false } }, hub))).toEqual([]);
    expect(items(team({}, devbox))).toEqual([]);
    expect(items(plan({ packs: ["hub"] }, hub))).toEqual([]);
    expect(withBoxes({}, hub).jobs.find((job) => job.id === "box-nightly")?.command).toEqual(["hedge", "box", "nightly"]);
  });

  test("plans the nightly secret sweep on every machine, as a machine without a hub keeps its own store", () => {
    const sweeps = (machine: MachineFile) => plan({ packs: ["hub"] }, machine).jobs.filter((job) => job.id === "secret-sweep").map((job) => `${job.command.join(" ")} every ${job.schedule.every} at ${job.schedule.at}`);
    expect(sweeps({ schema: 1, role: "hub" })).toEqual(["hedge secret sweep every 1d at 02:47"]);
    expect(sweeps(devbox)).toEqual(["hedge secret sweep every 1d at 02:47"]);
    expect(sweeps(mac)).toEqual(["hedge secret sweep every 1d at 02:47"]);
  });

  test("hedge doctor on the hub names the fix when Coder rejects the hub's Coder session", async () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const home = temp.make("hub-session-");
    for (const dir of [".config/hedge", ".config/coderv2"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "hub" }));
    writeFileSync(join(home, ".config/coderv2/session"), `${["Ab3dE6gH9k", "x".repeat(22)].join("-")}\n`);
    const rejecting = (async () => Response.json({ message: "API key expired." }, { status: 401 })) as unknown as typeof fetch;
    const { machine } = fakeMachine(home, { self: "my-hub", isHub: true });
    const coder = new Coder({ home, env: {}, coderUrl: "https://coder.example.com", template: "linux", fetch: rejecting });
    const run = async (command: string[]) => (command.join(" ").endsWith("hedge box session") ? boxCommand(["session"], { machine: () => { throw new Error("Boxes is off."); }, coder: () => coder, tokens: () => ({ here: machine, hub: "my-hub", coder }), print: machine.print, readStdin: async () => "", hooks: {} }) : 0);
    const report = await check(resolveEngine([...sources, coderTeam()], { settings: answers, packs: ["hub", "posthog"], workflows: { "linked-hub": false } }, hub), { home, adapters: [], run });
    const finding = report.findings.find((item) => item.id === "check:coder-session");
    expect(report.ok).toBe(false);
    expect(finding?.say).toContain("coder login");
  });

  test("plans the disk watch job only on the hub and only while Disk watch is on, and the threads' folder defaults to home", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (machine: MachineFile, workflows: Record<string, boolean> = {}) => {
      const result = plan({ packs: ["hub"], workflows }, machine);
      return [
        ...result.jobs.filter((job) => job.pack === "hub" && job.workflow === "disk-watch").map((job) => `job ${job.id}: ${job.command.join(" ")} every ${job.schedule.every}`),
        ...result.checks.filter((check) => check.pack === "hub" && check.workflow === "disk-watch").map((check) => `check ${check.id}: ${check.run.join(" ")}`),
      ];
    };
    expect(items(hub)).toEqual(["job disk-watch: hedge disk-watch every 15m"]);
    expect(items(hub, { "disk-watch": false })).toEqual([]);
    expect(items(devbox)).toEqual([]);
    expect(items(mac)).toEqual([]);
    expect(plan({ packs: ["hub"], workflows: { "mcp-gateway": false, "linked-hub": false } }).settings).toMatchObject({ "hub.threadFolder": "~" });
  });

  test("the Boxes workflow's settings reach its commands, the relay port for a box's hub forward included", () => {
    const settings = withBoxes({ workflows: { "linked-hub": false } }).settings;
    expect(Object.keys(settings).filter((key) => key.startsWith("hub.box") || key === "hub.relayPort").sort()).toEqual([
      "hub.boxDiskGigabytes", "hub.boxIdleHours", "hub.boxKeepDirs", "hub.boxPoolSize", "hub.boxReapDays", "hub.boxTemplate", "hub.relayPort",
    ]);
  });

  test("the Claude token step tells the person to paste into hedge box token, and its probe passes only for a token file with mode 0600", () => {
    const step = withBoxes({}, { schema: 1, role: "hub" }).human.find((item) => item.id === "box-claude-token")!;
    expect(step).toMatchObject({ command: "claude setup-token", interactive: true, workflow: "boxes" });
    expect(step.say).toContain("hedge box token");
    const home = temp.make("hub-token-");
    const probe = () => Bun.spawnSync(step.probe, { env: { HOME: home, PATH: "/usr/bin:/bin" } }).exitCode;
    expect(probe()).not.toBe(0);
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/box-claude-token"), "sk-test\n", { mode: 0o644 });
    chmodSync(join(home, ".config/hedge/box-claude-token"), 0o644);
    expect(probe()).not.toBe(0);
    chmodSync(join(home, ".config/hedge/box-claude-token"), 0o600);
    expect(probe()).toBe(0);
  });
});

describe("the Dream workflow of the Memory pack", () => {
  const hub: MachineFile = { schema: 1, role: "hub" };
  const dreamOn = { packs: ["hub", "memory"], workflows: { dream: true }, settings: { ...answers, "memory.repo": "me/notes" } };
  const dreamJobs = (result: Plan) => result.jobs.filter((job) => job.workflow === "dream").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every} at ${job.schedule.at}`);

  test("is off by default, because each run spends model tokens, and says so in its risk", () => {
    const workflow = sources[0]!.packs.find((pack) => pack.manifest.name === "memory")!.manifest.workflows!.find((item) => item.id === "dream")!;
    expect(workflow).toMatchObject({ name: "Dream", default: false, needs: ["hub", "gh"], settings: ["hub.alias", "hub.dreamSessions"] });
    expect(workflow.risk).toMatch(/model/);
    expect(plan({ ...dreamOn, workflows: {} }, hub).workflows.find((item) => item.id === "dream")).toMatchObject({ active: false, reason: "turned off" });
  });

  test("plans the nightly job only on the hub, and only while Dream is on", () => {
    expect(dreamJobs(plan(dreamOn, hub))).toEqual(["dream: hedge dream run every 1d at 04:10"]);
    expect(dreamJobs(plan(dreamOn, devbox))).toEqual([]);
    expect(dreamJobs(plan(dreamOn, mac))).toEqual([]);
    expect(dreamJobs(plan({ ...dreamOn, workflows: {} }, hub))).toEqual([]);
  });

  test("gives hedge commands its session limit only while Dream is on, which is how the box hook knows to save digests", () => {
    expect(plan(dreamOn, hub).settings["hub.dreamSessions"]).toBe(150);
    expect(plan({ ...dreamOn, workflows: {} }, hub).settings["hub.dreamSessions"]).toBeUndefined();
  });

  test("passes the Memory pack's memory.repo only when the Memory pack is on", () => {
    expect(plan(dreamOn, hub).settings["memory.repo"]).toBe("me/notes");
    expect(plan({ ...dreamOn, packs: ["hub"] }, hub).settings["memory.repo"]).toBeUndefined();
  });

  test("ships the dream and hedge-hub skills with the Hub pack, which has no skills bound to a workflow", () => {
    const skills = (result: Plan) => result.files.map((file) => file.target).filter((target) => /^\.agents\/skills\/(dream|hedge-hub)$/.test(target)).sort();
    expect(skills(plan(dreamOn, hub))).toEqual([".agents/skills/dream", ".agents/skills/hedge-hub"]);
    expect(skills(plan({ packs: [] }, hub))).toEqual([]);
  });
});

describe("the Own-account balancing workflow", () => {
  const hub: MachineFile = { schema: 1, role: "hub" };
  const balancing = { packs: ["hub"], workflows: { "own-account-balancing": true } };
  const manifest = () => sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
  const proxyItems = (result: Plan) => ({
    jobs: result.jobs.filter((job) => job.workflow === "own-account-balancing").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}`),
    steps: result.steps.filter((step) => step.workflow === "own-account-balancing").map((step) => step.id),
    checks: result.checks.filter((check) => check.workflow === "own-account-balancing").map((check) => check.id),
    config: result.config.filter((entry) => entry.workflow === "own-account-balancing").map((entry) => `${entry.provider}:${entry.key}`),
  });
  const nothing = { jobs: [], steps: [], checks: [], config: [] };
  const codexRoute = ["codex:model_provider", "codex:model_providers.hedge-proxy"];

  test("is off by default, needs only the hub, and its risk quotes the Anthropic terms word for word", () => {
    const workflow = manifest().workflows!.find((item) => item.id === "own-account-balancing")!;
    expect(workflow).toMatchObject({ name: "Own-account balancing", default: false, needs: ["hub"] });
    for (const quote of [
      "https://www.anthropic.com/legal/aup",
      "Do Not Abuse Our Platform",
      "\"Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used\"",
      "https://www.anthropic.com/legal/consumer-terms",
      "\"You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.\"",
      "\"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.\"",
      "2026-11-05",
      "only for your own subscriptions, never for someone else's",
    ]) expect(workflow.risk).toContain(quote);
    expect(plan({ packs: ["hub"] }, hub).workflows.find((item) => item.id === "own-account-balancing")).toMatchObject({ active: false, reason: "turned off" });
  });

  test("with the workflow off, the Hub pack plans nothing new on any role", () => {
    for (const machine of [hub, devbox, mac]) expect(proxyItems(plan({ packs: ["hub"] }, machine))).toEqual(nothing);
    expect(plan({ packs: ["hub"] }, hub).settings["hub.proxyAccounts"]).toBeUndefined();
  });

  test("with it on, the hub gets the proxy, its balancer, and the route; a devbox gets only the route; the Mac gets nothing", () => {
    const route = { checks: ["cli-proxy-client", "cli-proxy-codex"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper", ...codexRoute] };
    expect(proxyItems(plan(balancing, hub))).toEqual({ jobs: ["cli-proxy-balance: hedge cli-proxy-balance every 5m"], steps: ["cli-proxy"], ...route, checks: ["cli-proxy-accounts", ...route.checks] });
    expect(proxyItems(plan(balancing, devbox))).toEqual({ jobs: [], steps: [], ...route });
    expect(proxyItems(plan(balancing, mac))).toEqual(nothing);
    expect(plan(balancing, hub).settings["hub.proxyAccounts"]).toBe(2);
  });

  test("each plan routes its own agents: Claude on the Claude plan, Codex on the Codex plan, both on both", () => {
    const routed = { jobs: [], steps: [] };
    expect(proxyItems(plan({ ...balancing, plan: "both" }, devbox))).toEqual({ ...routed, checks: ["cli-proxy-client", "cli-proxy-codex"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper", ...codexRoute] });
    expect(proxyItems(plan({ ...balancing, plan: "claude" }, devbox))).toEqual({ ...routed, checks: ["cli-proxy-client"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper"] });
    expect(proxyItems(plan({ ...balancing, plan: "codex" }, devbox))).toEqual({ ...routed, checks: ["cli-proxy-codex"], config: codexRoute });
    for (const ai of ["claude", "codex", "both"] as const) expect(proxyItems(plan({ ...balancing, plan: ai }, mac))).toEqual(nothing);
  });

  test("the hub runs the proxy and its balancer on every plan, the Codex plan included", () => {
    for (const ai of ["claude", "codex", "both"] as const) {
      const items = proxyItems(plan({ ...balancing, plan: ai }, hub));
      expect([items.steps, items.jobs]).toEqual([["cli-proxy"], ["cli-proxy-balance: hedge cli-proxy-balance every 5m"]]);
    }
  });

  test("the planned Codex provider is the table the route switch recognizes as Hedge's own", () => {
    expect(plan(balancing, devbox).config.find((entry) => entry.key === "model_providers.hedge-proxy")?.value).toEqual(codexProviderTable);
  });

  test("a devbox on the both plan gets a Codex config that uses the proxy's Responses route and reads the client key from its private file; a Mac gets none", async () => {
    const codexConfig = async (machine: MachineFile) => {
      const home = temp.make("hedge-codex-route-");
      const result = plan({ ...balancing, plan: "both" }, machine);
      const report = await apply({ ...result, config: result.config.filter((entry) => entry.pack === "hub"), steps: [], checks: result.checks.filter((check) => check.pack === "hub"), jobs: [], human: [] }, { home, adapters: [providerConfigAdapter()], run: async () => 0 });
      expect(report.ok).toBe(true);
      return existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : undefined;
    };
    expect(await codexConfig(devbox)).toEqual({
      model_provider: "hedge-proxy",
      model_providers: {
        "hedge-proxy": { name: "Hedge CLI proxy", base_url: "http://127.0.0.1:8317/v1", wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", "cat \"$HOME/.config/hedge/cli-proxy.key\""] } },
      },
    });
    expect(await codexConfig(mac)).toBeUndefined();
  });

  const connectedDevbox = (files: Record<string, string> = {}) => {
    const { machine, home, printed } = proxyMachine((prefix) => temp.make(prefix), { plan: "both" }, { models: ["claude-sonnet-5-5", "gpt-6.1-sol"] }, { role: "devbox" });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), text);
    }
    const on = proxyOnly(plan({ ...balancing, plan: "both" }, devbox));
    let profile = on;
    const applyNow = hedgeApply(machine, () => profile);
    const applyWith = (next: Plan) => {
      profile = next;
      const applied = applyNow();
      profile = on;
      return applied;
    };
    const applyOff = () => applyWith(proxyOnly(plan({ packs: ["hub"], plan: "both" }, devbox)));
    const codex = () => parse(readFileSync(join(home, ".codex/config.toml"), "utf8"));
    const claude = () => JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    const connectAndApply = async () => {
      expect(await cliProxy("connect", machine)).toBe(0);
      return applyNow();
    };
    return { machine, on, printed, applyWith, applyOff, codex, claude, connectAndApply };
  };
  const helper = 'cat "$HOME/.config/hedge/cli-proxy.key"';

  test("on a devbox, the hedge apply after connect routes Claude Code and Codex, and turning balancing off takes both routes off at the next apply", async () => {
    const { applyOff, codex, claude, connectAndApply } = connectedDevbox();
    expect((await connectAndApply()).code).toBe(0);
    expect(codex()).toEqual({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": codexProviderTable } });
    expect(claude()).toEqual({ env: { ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: helper });
    expect((await applyOff()).code).toBe(0);
    expect(codex()).toEqual({});
    expect(claude()).toEqual({});
  });

  test("after an earlier apply wrote only the hedge-proxy Codex table, the apply after connect selects it, and turning balancing off takes the table and the selector off together", async () => {
    const { on, applyWith, applyOff, codex, connectAndApply } = connectedDevbox({ ".config/hedge/cli-proxy.key": `${clientKey}\n` });
    expect((await applyWith({ ...on, config: on.config.filter((entry) => entry.key !== "model_provider") })).code).toBe(0);
    expect(codex()).toEqual({ model_providers: { "hedge-proxy": codexProviderTable } });
    expect((await connectAndApply()).code).toBe(0);
    expect(codex()).toEqual({ model_provider: "hedge-proxy", model_providers: { "hedge-proxy": codexProviderTable } });
    expect((await applyOff()).code).toBe(0);
    expect(codex()).toEqual({});
  });

  test("while Hedge owns only the hedge-proxy Codex table and you own the selector, turning balancing off takes both, and a To do names the selector", async () => {
    const { machine, on, applyWith, applyOff, codex } = connectedDevbox({ ".config/hedge/cli-proxy.key": `${clientKey}\n` });
    expect((await applyWith({ ...on, config: on.config.filter((entry) => entry.key !== "model_provider") })).code).toBe(0);
    writeFileSync(join(machine.home, ".codex/config.toml"), stringify({ model: "gpt-6.1-sol", model_provider: "hedge-proxy", model_providers: { "hedge-proxy": codexProviderTable } }));
    const off = await applyOff();
    expect(codex()).toEqual({ model: "gpt-6.1-sol" });
    expect(off.stdout).toContain("To do: Took Hedge's proxy route out of .codex/config.toml, and with it your model_provider, which only worked through that route.");
  });

  test("hedge apply after connect beside a hedge-proxy Codex table of your own with another name selects nothing, and turning balancing off leaves your table", async () => {
    const mine = { model_providers: { "hedge-proxy": { ...codexProviderTable, name: "Mine" } } };
    const { applyOff, codex, connectAndApply } = connectedDevbox({ ".codex/config.toml": stringify(mine) });
    expect((await connectAndApply()).stdout).toContain("Note: Kept your model_providers.hedge-proxy in .codex/config.toml.");
    expect(codex()).toEqual(mine);
    expect((await applyOff()).code).toBe(0);
    expect(codex()).toEqual(mine);
  });

  test("your own hedge-proxy selector with a Codex table of your own stays, selector and table, after connect and apply and after turning balancing off", async () => {
    const mine = { model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { ...codexProviderTable, name: "Mine" } } };
    const { applyOff, codex, connectAndApply } = connectedDevbox({ ".codex/config.toml": stringify(mine) });
    expect((await connectAndApply()).code).toBe(0);
    expect(codex()).toEqual(mine);
    expect((await applyOff()).code).toBe(0);
    expect(codex()).toEqual(mine);
  });

  test("Hedge's Claude route leaves with your own ANTHROPIC_AUTH_TOKEN beside it when balancing turns off, so the token never goes to Anthropic, and a To do names the token without its value", async () => {
    const { applyOff, claude, connectAndApply } = connectedDevbox({ ".claude/settings.json": JSON.stringify({ model: "opus", env: { ANTHROPIC_AUTH_TOKEN: "my-token" } }) });
    expect((await connectAndApply()).code).toBe(0);
    expect(claude()).toEqual({ model: "opus", env: { ANTHROPIC_AUTH_TOKEN: "my-token", ANTHROPIC_BASE_URL: proxyUrl }, apiKeyHelper: helper });
    const off = await applyOff();
    expect(claude()).toEqual({ model: "opus" });
    expect(off.stdout).toContain("To do: Took Hedge's proxy route out of .claude/settings.json, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.");
    expect(off.stdout).not.toContain("my-token");
  });

  test("sends Claude Code to the loopback proxy, and keeps the client key out of the settings: Claude reads it from a private file", () => {
    const config = plan(balancing, devbox).config.filter((entry) => entry.workflow === "own-account-balancing");
    expect(Object.fromEntries(config.filter((entry) => entry.provider === "claude").map((entry) => [entry.key, entry.value]))).toEqual({ "env.ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", apiKeyHelper: "cat \"$HOME/.config/hedge/cli-proxy.key\"" });
    expect(config.map((entry) => entry.pack)).toEqual(["hub", "hub", "hub", "hub"]);
  });

  test("each provider's route waits for its own check, so one provider down never moves the other", () => {
    const waits = Object.fromEntries(plan({ ...balancing, plan: "both" }, devbox).config.filter((entry) => entry.workflow === "own-account-balancing").map((entry) => [`${entry.provider}:${entry.key}`, entry.after]));
    expect(waits).toEqual({ "claude:env.ANTHROPIC_BASE_URL": "cli-proxy-client", "claude:apiKeyHelper": "cli-proxy-client", "codex:model_provider": "cli-proxy-codex", "codex:model_providers.hedge-proxy": "cli-proxy-codex" });
    const checks = plan({ ...balancing, plan: "both" }, devbox).checks.filter((check) => check.workflow === "own-account-balancing");
    expect(checks.map((check) => check.run.join(" "))).toEqual(["hedge cli-proxy check", "hedge cli-proxy check codex"]);
  });

  test("a profile key over one part of a provider's proxy route takes that provider's whole route out of the plan and says why", () => {
    const overrides = { config: [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com" }, { provider: "codex" as const, key: "model_providers", value: { work: { name: "Work" } } }] };
    const result = plan({ ...balancing, plan: "both", overrides }, devbox);
    const onRoute = (entry: { provider: string; key: string }) => ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper", "codex:model_provider", "codex:model_providers.hedge-proxy", "codex:model_providers"].includes(`${entry.provider}:${entry.key}`);
    expect(result.config.filter(onRoute).map((entry) => [`${entry.provider}:${entry.key}`, entry.pack])).toEqual([["claude:env.ANTHROPIC_BASE_URL", "profile"], ["codex:model_providers", "profile"]]);
    expect(result.dropped.filter((entry) => entry.reason.endsWith("leaves as one unit"))).toEqual([
      { pack: "hub", item: "config claude:apiKeyHelper", reason: "your profile sets claude:env.ANTHROPIC_BASE_URL, so Hedge's Claude Code proxy route leaves as one unit" },
      { pack: "hub", item: "config codex:model_provider", reason: "your profile sets codex:model_providers, so Hedge's Codex proxy route leaves as one unit" },
      { pack: "hub", item: "config codex:model_providers.hedge-proxy", reason: "your profile sets codex:model_providers, so Hedge's Codex proxy route leaves as one unit" },
    ]);
    expect(plan({ ...balancing, plan: "both" }, devbox).config.filter(onRoute)).toHaveLength(4);
  });

  describe("apply while the proxy does not answer or serves nothing", () => {
    const key = "c1".repeat(32);
    const routeOnly = (result: Plan): Plan => ({ ...result, config: result.config.filter((entry) => entry.pack === "hub"), checks: result.checks.filter((check) => check.pack === "hub"), steps: [], jobs: [], human: [] });
    const realCheck = (home: string, models: string[] | "down") => {
      const fetch = async () => (models === "down" ? Promise.reject(new TypeError("connection refused")) : Response.json({ data: models.map((id) => ({ id })) }));
      const machine: ProxyMachine = { home, uid: 1000, user: "me", devboxes: [], release: { version: "", url: "", sha256: "" }, run: async () => ({ code: 0, stdout: "", stderr: "" }), fetch, now: () => 0, sleep: async () => {}, readStdin: async () => "", randomKey: () => key, print: () => {} };
      return async (command: string[]) => {
        const words = command.join(" ");
        if (words.endsWith("hedge cli-proxy check codex")) return cliProxy("check", machine, "codex");
        return words.endsWith("hedge cli-proxy check") ? cliProxy("check", machine) : 0;
      };
    };
    const homeWith = (files: Record<string, string> = {}) => {
      const home = temp.make("hedge-route-gate-");
      for (const [path, text] of Object.entries({ ".config/hedge/cli-proxy.key": `${key}\n`, ...files })) {
        mkdirSync(join(home, path, ".."), { recursive: true });
        writeFileSync(join(home, path), text);
      }
      return home;
    };
    const offline = (result: Plan): Plan => ({ ...result, packs: [...result.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    const applied = async (home: string, models: string[] | "down", times = 2, shape: (result: Plan) => Plan = routeOnly) => {
      const reports = [];
      for (let run = 0; run < times; run++) reports.push(await apply(shape(routeOnly(plan({ ...balancing, plan: "both" }, devbox))), { home, adapters: [providerConfigAdapter()], run: realCheck(home, models) }));
      const claude = existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : {};
      const codex = existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : {};
      return { reports, claude, codex };
    };
    const both = ["claude-sonnet-5-5", "gpt-6.1-sol"];

    test("takes off the Claude route that an earlier apply wrote once the proxy serves no model, even while a pack source cannot be fetched", async () => {
      const home = homeWith({ ".claude/settings.json": JSON.stringify({ model: "opus" }) });
      expect((await applied(home, both, 1)).claude.apiKeyHelper).toBe('cat "$HOME/.config/hedge/cli-proxy.key"');
      const { claude, reports } = await applied(home, [], 2, offline);
      expect(claude).toEqual({ model: "opus" });
      expect(reports[1]!.actions).toEqual([]);
    });

    test("takes off the Codex route that an earlier apply wrote once the proxy serves no model, even while a pack source cannot be fetched", async () => {
      const home = homeWith({ ".codex/config.toml": stringify({ model: "gpt-6.1-sol" }) });
      expect((await applied(home, both, 1)).codex.model_provider).toBe("hedge-proxy");
      const { codex, reports } = await applied(home, [], 2, offline);
      expect(codex).toEqual({ model: "gpt-6.1-sol" });
      expect(reports[1]!.actions).toEqual([]);
    });

    test("keeps a key helper of your own that reads a file beside the proxy key", async () => {
      const mine = { apiKeyHelper: 'my-helper --cache "$HOME/.config/hedge/cli-proxy.key-cache"' };
      const { claude } = await applied(homeWith({ ".claude/settings.json": JSON.stringify(mine) }), "down");
      expect(claude).toEqual(mine);
    });

    test("a proxy that serves Claude but not Codex routes Claude only, and the next apply changes nothing", async () => {
      const { reports, claude, codex } = await applied(homeWith(), ["claude-sonnet-5-5"]);
      expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
      expect(codex).toEqual({});
      expect(reports[1]!.actions).toEqual([]);
    });

    test("a Hedge provider table you edited away from the proxy keeps Codex off the proxy on every apply", async () => {
      const mine = { model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { name: "Mine" } } };
      const { reports, codex } = await applied(homeWith({ ".codex/config.toml": stringify(mine) }), both, 4);
      expect(codex.model_providers).toEqual(mine.model_providers);
      expect(codex.model_provider).toBe("hedge-proxy");
      expect(reports.slice(1).map((report) => report.actions)).toEqual([[], [], []]);
    });

    test("a profile gateway in place of one part of Hedge's proxy route takes that provider's whole route out of the plan, so apply writes no Hedge key helper or proxy table beside it", async () => {
      const gateway = "https://gateway.example.com";
      const overrides = { config: [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: gateway }, { provider: "codex" as const, key: "model_provider", value: "work" }] };
      const resolved = plan({ ...balancing, plan: "both", overrides }, devbox);
      const shaped: Plan = { ...resolved, config: resolved.config.filter((entry) => entry.workflow === "own-account-balancing" || entry.pack === "profile"), checks: resolved.checks.filter((item) => item.pack === "hub"), steps: [], jobs: [], human: [] };
      const home = homeWith();
      const report = await apply(shaped, { home, adapters: [providerConfigAdapter()], run: realCheck(home, both) });
      expect(report.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: gateway } });
      expect(parse(readFileSync(join(home, ".codex/config.toml"), "utf8"))).toEqual({ model_provider: "work" });
      expect((await check(shaped, { home, adapters: [providerConfigAdapter()], run: realCheck(home, both) })).ok).toBe(true);
    });

    test("keeps the whole Claude route while one of its checks cannot tell and the other passes", async () => {
      const home = homeWith();
      const split = (result: Plan): Plan => ({ ...result, config: result.config.map((entry) => (entry.key === "apiKeyHelper" ? { ...entry, after: "answers" } : entry)), checks: [...result.checks, { pack: "hub", id: "answers", run: ["true"], say: "Always passes." }] });
      const routed = await applied(home, both, 1, split);
      expect((await applied(home, "down", 1, split)).claude).toEqual(routed.claude);
    });

    const gateway = (result: Plan): Plan => ({ ...result, config: [...result.config, { pack: "profile", provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com" }] });

    test("a profile gateway in place of one part of the route still takes the whole route off while the proxy does not answer", async () => {
      const home = homeWith();
      await applied(home, both, 1);
      expect((await applied(home, "down", 1, gateway)).claude).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } });
    });

    test("while the proxy does not answer, a gateway the profile no longer sets leaves, and Hedge puts no route in its place", async () => {
      const home = homeWith();
      await applied(home, both, 1, gateway);
      expect((await applied(home, "down", 1)).claude).toEqual({});
    });

    test("while the proxy does not answer, a route whose base URL you removed loses its key helper too", async () => {
      const home = homeWith();
      const { claude } = await applied(home, both, 1);
      writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ ...claude, env: {} }));
      expect((await applied(home, "down", 1)).claude).toEqual({ env: {} });
    });

    test("a proxy that answers routes both", async () => {
      const { claude, codex } = await applied(homeWith(), both);
      expect(claude.apiKeyHelper).toBe("cat \"$HOME/.config/hedge/cli-proxy.key\"");
      expect(codex.model_provider).toBe("hedge-proxy");
    });
  });

  describe("apply on a hub whose proxy holds none of your subscriptions", () => {
    const emptyHub = (ai: "claude" | "codex", credentials: Array<{ provider: string }> = []) => {
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: ai, devboxes: [] }, { credentials, models: [] });
      const result = proxyOnly(plan({ ...balancing, plan: ai }, hub));
      const options = { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) };
      return { home, result, options };
    };
    const login = (agent: string) => `~/.local/share/hedge-cli-proxy/cli-proxy-api -config ~/.local/share/hedge-cli-proxy/config.yaml -${agent}-login -no-browser`;

    test("installs the proxy, passes its step, keeps Claude Code on its own sign-in, and lists the login as a To do; doctor passes too", async () => {
      const { home, result, options } = emptyHub("claude");
      const fresh = await apply(result, options);
      expect(fresh.ok).toBe(true);
      expect(fresh.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:cli-proxy-client", true], ["check:cli-proxy-accounts", true]]);
      expect(fresh.findings.map((finding) => finding.say.endsWith(`: ${login("claude")}`))).toEqual([true, true]);
      expect(existsSync(join(home, ".local/share/hedge-cli-proxy/cli-proxy-api"))).toBe(true);
      const applied = await apply(result, options);
      expect(applied.ok).toBe(true);
      expect(applied.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:cli-proxy-client", true], ["check:cli-proxy-accounts", true]]);
      expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
      const doctor = await check(result, options);
      expect(doctor.ok).toBe(true);
      expect(doctor.findings.map((finding) => [finding.id, finding.todo])).toEqual([["check:cli-proxy-client", true], ["check:cli-proxy-accounts", true]]);
    });

    test("on the Codex plan, lists the Codex login as a To do and keeps Codex on its own sign-in", async () => {
      const { home, result, options } = emptyHub("codex");
      const fresh = await apply(result, options);
      expect(fresh.ok).toBe(true);
      expect(fresh.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:cli-proxy-codex", true], ["check:cli-proxy-codex-accounts", true]]);
      const applied = await apply(result, options);
      expect(applied.ok).toBe(true);
      expect(applied.findings.map((finding) => [finding.id, finding.todo])).toEqual([["check:cli-proxy-codex", true], ["check:cli-proxy-codex-accounts", true]]);
      expect(applied.findings.map((finding) => finding.say).join("\n")).toContain(login("codex"));
      expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
      expect((await check(result, options)).ok).toBe(true);
    });

    test("with one subscription of the 2 that hub.proxyAccounts asks for, apply routes Claude Code to the proxy that serves it and still lists the To do", async () => {
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: "claude", devboxes: [] }, { credentials: [{ provider: "claude" }] });
      const result = proxyOnly(plan({ ...balancing, plan: "claude" }, hub));
      const options = { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) };
      await apply(result, options);
      const applied = await apply(result, options);
      expect(applied).toMatchObject({ ok: true, findings: [{ id: "check:cli-proxy-accounts", todo: true }] });
      expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    });

    test("with one working subscription and a proxy that only its step starts, one apply routes Claude Code to the proxy, and doctor passes", async () => {
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: "claude", devboxes: [] }, { credentials: [{ provider: "claude" }], stopped: true });
      const result = proxyOnly(plan({ ...balancing, plan: "claude" }, hub));
      const options = { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) };
      const applied = await apply(result, options);
      expect(applied.ok).toBe(true);
      expect(applied.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:cli-proxy-accounts", true]]);
      expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
      const doctor = await check(result, options);
      expect(doctor.ok).toBe(true);
      expect(doctor.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:cli-proxy-accounts", true]]);
    });

    test("with a stopped proxy that its step starts but whose doctor finds a plugin Hedge did not install, apply fails the step and keeps Claude Code on its own sign-in", async () => {
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: "claude", devboxes: [] }, { credentials: [{ provider: "claude" }], stopped: true });
      mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
      writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      const result = proxyOnly(plan({ ...balancing, plan: "claude" }, hub));
      const applied = await apply(result, { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) });
      expect(applied.ok).toBe(false);
      expect(applied.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["step:cli-proxy", "apply"], ["check:cli-proxy-client", "apply"], ["check:cli-proxy-accounts", true]]);
      expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
    });

    const runningHub = (ai: "claude" | "codex", proxy: Proxy, files: Record<string, string> = {}) => {
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: ai, devboxes: [] }, proxy);
      for (const [path, text] of Object.entries({ ".config/hedge/cli-proxy.key": `${clientKey}\n`, ...files })) {
        mkdirSync(join(home, path, ".."), { recursive: true });
        writeFileSync(join(home, path), text);
      }
      const result = proxyOnly(plan({ ...balancing, plan: ai }, hub));
      const route = () => (existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).env?.ANTHROPIC_BASE_URL : undefined);
      const routes = new Set<unknown>();
      const reach = machine.fetch;
      machine.fetch = (input, init) => {
        if (String(input).startsWith(proxyUrl)) routes.add(route());
        return reach(input, init);
      };
      const hooks = { beforeInstall: () => {} };
      const served = hedgeProxy(machine, result.engineRoot);
      const run = async (command: string[]) => {
        if (command.at(-1) === "install") hooks.beforeInstall();
        return served(command);
      };
      return { home, result, routes, route, hooks, options: { home, adapters: [providerConfigAdapter()], run } };
    };
    const foreignPlugin = { ".local/share/hedge-cli-proxy/plugins/other.so": "plugin" };
    const unsafe: Array<[string, string | true | undefined]> = [["step:cli-proxy", "apply"], ["check:cli-proxy-client", "apply"], ["check:cli-proxy-accounts", true]];

    test("with a running proxy that has a plugin Hedge did not install from the start, apply fails and never routes Claude Code to the proxy", async () => {
      const { result, routes, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] }, foreignPlugin);
      const applied = await apply(result, options);
      expect(routes).toEqual(new Set([undefined]));
      expect(route()).toBeUndefined();
      expect(applied.ok).toBe(false);
      expect(applied.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual(unsafe);
    });

    test("after a successful apply, a plugin Hedge did not install appears while the proxy still lists the model: the next apply takes the route out by the time it ends, and fails", async () => {
      const { home, result, routes, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      expect((await apply(result, options)).ok).toBe(true);
      expect(route()).toBe("http://127.0.0.1:8317");
      mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
      writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      const failed = await apply(result, options);
      expect(route()).toBeUndefined();
      expect(failed.ok).toBe(false);
      expect(failed.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual(unsafe);
      routes.clear();
      expect((await apply(result, options)).ok).toBe(false);
      expect(routes).toEqual(new Set([undefined]));
      expect(route()).toBeUndefined();
    });

    test("on a routed hub with its own ANTHROPIC_AUTH_TOKEN, a plugin Hedge did not install fails the check, and the route leaves with the token, which a To do names without its value", async () => {
      const { home, result, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      expect((await apply(result, options)).ok).toBe(true);
      const settings = join(home, ".claude/settings.json");
      writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), env: { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_AUTH_TOKEN: "my-token" } }));
      mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
      writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      const failed = await apply(result, options);
      expect(route()).toBeUndefined();
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
      expect(failed.ok).toBe(false);
      const todo = failed.findings.find((finding) => finding.id === "route:.claude/settings.json");
      expect(todo).toEqual({ id: "route:.claude/settings.json", pack: "engine", say: "Took Hedge's proxy route out of .claude/settings.json, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.", todo: true });
      expect(JSON.stringify(failed.findings)).not.toContain("my-token");
    });

    test("a job the Jobs adapter refuses still lets apply take the route to a proxy that turned unsafe out, and apply fails with the job's reason", async () => {
      const { home, result, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      expect((await apply(result, options)).ok).toBe(true);
      expect(route()).toBe("http://127.0.0.1:8317");
      mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
      writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      const badJob: Plan = { ...result, jobs: [{ id: "bad id", command: ["hedge", "box", "sweep"], schedule: { every: "always" }, pack: "hub" }] };
      await expect(apply(badJob, { ...options, adapters: [jobsAdapter(), providerConfigAdapter()] })).rejects.toThrow("job id bad id of the hub pack may hold only");
      expect(route()).toBeUndefined();
    });

    test("a job the Jobs adapter refuses still lets apply take the route and the token beside it out, and the error that apply throws holds the To do that names the token", async () => {
      const { home, result, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      expect((await apply(result, options)).ok).toBe(true);
      const settings = join(home, ".claude/settings.json");
      writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), env: { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_AUTH_TOKEN: "my-token" } }));
      mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
      writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      const badJob: Plan = { ...result, jobs: [{ id: "bad id", command: ["hedge", "box", "sweep"], schedule: { every: "always" }, pack: "hub" }] };
      const failure = await apply(badJob, { ...options, adapters: [jobsAdapter(), providerConfigAdapter()] }).then(() => "", (error: Error) => error.message);
      expect(route()).toBeUndefined();
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
      expect(failure).toStartWith("job id bad id of the hub pack may hold only");
      expect(failure.split("\n")).toContain("To do: Took Hedge's proxy route out of .claude/settings.json, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.");
      expect(failure).not.toContain("my-token");
    });

    test("a job the Jobs adapter refuses and a provider record Hedge cannot read both reach the person, the job's reason first", async () => {
      const { home, result, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      mkdirSync(join(home, ".config/hedge"), { recursive: true });
      writeFileSync(join(home, ".config/hedge/provider-fields.json"), "{");
      const badJob: Plan = { ...result, jobs: [{ id: "bad id", command: ["hedge", "box", "sweep"], schedule: { every: "always" }, pack: "hub" }] };
      const failure = await apply(badJob, { ...options, adapters: [jobsAdapter(), providerConfigAdapter()] }).then(() => "", (error: Error) => error.message);
      expect(failure).toStartWith("job id bad id of the hub pack may hold only");
      expect(failure).toContain(" Hedge also could not set your provider settings: JSON Parse error");
    });

    test("a plugin Hedge did not install that appears while the proxy step runs leaves no route when apply ends", async () => {
      const { home, result, route, hooks, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      hooks.beforeInstall = () => {
        mkdirSync(join(dataDir(home), "plugins"), { recursive: true });
        writeFileSync(join(dataDir(home), "plugins/other.so"), "plugin");
      };
      const applied = await apply(result, options);
      expect(route()).toBeUndefined();
      expect(applied.ok).toBe(false);
      expect(applied.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual(unsafe);
    });

    test("with a running proxy that has a plugin Hedge did not install, a hedge-proxy Codex table of your own survives the failed step, and Codex keeps using it", async () => {
      const mine = { model_provider: "hedge-proxy", model_providers: { "hedge-proxy": { ...codexProviderTable, name: "Mine", base_url: "https://llm.example.com/v1" } } };
      const { home, result, options } = runningHub("codex", { credentials: [{ provider: "codex" }], models: ["gpt-6.1-sol"] }, { ...foreignPlugin, ".codex/config.toml": stringify(mine) });
      const applied = await apply(result, options);
      expect(applied.ok).toBe(false);
      expect(applied.findings.map((finding) => finding.id)).toContain("step:cli-proxy");
      expect(parse(readFileSync(join(home, ".codex/config.toml"), "utf8"))).toEqual(mine);
      await apply(result, options);
      expect(parse(readFileSync(join(home, ".codex/config.toml"), "utf8"))).toEqual(mine);
    });

    test("with a running proxy that passes its step, the route an earlier apply wrote stays in place through the next apply, which changes nothing", async () => {
      const { result, routes, route, options } = runningHub("claude", { credentials: [{ provider: "claude" }] });
      const first = await apply(result, options);
      expect(first.findings.map((finding) => finding.id)).toEqual(["check:cli-proxy-accounts"]);
      expect(route()).toBe("http://127.0.0.1:8317");
      routes.clear();
      const next = await apply(result, options);
      expect(next.ok).toBe(true);
      expect(next.actions).toEqual([]);
      expect(routes).toEqual(new Set(["http://127.0.0.1:8317"]));
      expect(route()).toBe("http://127.0.0.1:8317");
    });

    test("once the Codex pool empties, Hedge's hedge-proxy table leaves with your own selector beside it, so Codex starts on its own sign-in, and a To do names the selector", async () => {
      const proxy: Proxy = { credentials: [{ provider: "codex" }], models: ["gpt-6.1-sol"] };
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: "codex", devboxes: [] }, proxy);
      const result = proxyOnly(plan({ ...balancing, plan: "codex" }, hub));
      const options = { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) };
      const tableOnly = { ...result, config: result.config.filter((entry) => entry.key !== "model_provider") };
      await apply(tableOnly, options);
      await apply(tableOnly, options);
      const config = join(home, ".codex/config.toml");
      expect(parse(readFileSync(config, "utf8"))).toEqual({ model_providers: { "hedge-proxy": codexProviderTable } });
      writeFileSync(config, stringify({ model: "gpt-6.1-sol", model_provider: "hedge-proxy", model_providers: { "hedge-proxy": codexProviderTable } }));
      Object.assign(proxy, { credentials: [], models: [] });
      const emptied = await apply(result, options);
      expect(emptied.ok).toBe(true);
      expect(parse(readFileSync(config, "utf8"))).toEqual({ model: "gpt-6.1-sol" });
      expect(emptied.findings.map((finding) => [finding.id, finding.todo])).toEqual([["check:cli-proxy-codex", true], ["route:.codex/config.toml", true], ["check:cli-proxy-codex-accounts", true]]);
      expect(emptied.findings.find((finding) => finding.id === "route:.codex/config.toml")!.say).toBe("Took Hedge's proxy route out of .codex/config.toml, and with it your model_provider, which only worked through that route.");
    });

    test("takes Claude Code off the proxy once its pool empties, and lists the To do", async () => {
      const proxy: Proxy = { credentials: [{ provider: "claude" }] };
      const { machine, home } = proxyMachine((prefix) => temp.make(prefix), { plan: "claude", devboxes: [] }, proxy);
      const result = proxyOnly(plan({ ...balancing, plan: "claude" }, hub));
      const options = { home, adapters: [providerConfigAdapter()], run: hedgeProxy(machine, result.engineRoot) };
      await apply(result, options);
      await apply(result, options);
      expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).apiKeyHelper).toBeDefined();
      Object.assign(proxy, { credentials: [], models: [] });
      const emptied = await apply(result, options);
      expect(emptied.ok).toBe(true);
      expect(emptied.findings.map((finding) => [finding.id, finding.todo])).toEqual([["check:cli-proxy-client", true], ["check:cli-proxy-accounts", true]]);
      const settings = existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : {};
      expect([settings.env?.ANTHROPIC_BASE_URL, settings.apiKeyHelper]).toEqual([undefined, undefined]);
    });
  });
});
