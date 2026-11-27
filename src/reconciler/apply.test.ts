import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { providerConfigAdapter, type CommandRunner } from "../adapters/provider-config/adapter.ts";
import { keyHelper } from "../adapters/provider-config/proxy-route.ts";
import { apply, check, filesAdapter, humanStepsLeft, type Adapter } from "./apply.ts";
import { changeLedger, readLedger } from "./ledger.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    machine: { schema: 1, role: "linux" },
    os: "linux",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [{ target: ".agents/AGENTS.md", content: "rules\n" }],
    config: [],
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    models: [],
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    ...overrides,
  };
}

const exitCodes = (codes: Record<string, number>) => async (command: string[]) => codes[command.join(" ")] ?? 0;

describe("apply", () => {
  test("a step from before the rename that writes to FLEET_PROFILE_DIR writes to the profile this run applies, even when the shell still names an old one", async () => {
    const home = temp.make("home-");
    const [old, current] = [temp.make("old-profile-"), temp.make("profile-")];
    const saved = process.env.FLEET_PROFILE_DIR;
    process.env.FLEET_PROFILE_DIR = old;
    try {
      await apply(plan({ machine: { schema: 1, role: "linux", profileDir: current }, steps: [{ id: "mark", pack: "team", run: ["/bin/sh", "-c", 'touch "$FLEET_PROFILE_DIR/marked"'] }] }), { home, adapters: [] });
    } finally {
      if (saved === undefined) delete process.env.FLEET_PROFILE_DIR;
      else process.env.FLEET_PROFILE_DIR = saved;
    }
    expect(existsSync(join(old, "marked"))).toBe(false);
    expect(existsSync(join(current, "marked"))).toBe(true);
  });

  test("refuses to write while a setting is unanswered", async () => {
    const home = temp.make("home-");
    const report = await apply(plan({ unanswered: [{ key: "orchestration.tracker", question: "Which repo holds your maps?", type: "string" }] }), { home });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "unanswered:orchestration.tracker", pack: "orchestration", say: "Which repo holds your maps? Answer it with hedge set orchestration.tracker=<value>.", repair: "human" });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("keeps the last applied files while a pack's source is unreachable", async () => {
    const home = temp.make("home-");
    const team = { target: ".agents/skills/team", content: "team skill\n" };
    await apply(plan({ files: [plan().files[0]!, team] }), { home });
    const offline = plan({ packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/skills/team"), "utf8")).toBe("team skill\n");
    expect(report.findings).toContainEqual({ id: "pack:team", pack: "team", say: "The team pack is not applied: not found; unreachable sources: team" });
    expect((await apply(plan(), { home })).actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("--adopt-from keeps the other setup's claim while an outage keeps its file", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "old rules\n");
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    const state = JSON.stringify({ version: 1, groups: { core: { ".agents/AGENTS.md": { kind: "file", hash: "0".repeat(64) } } } });
    writeFileSync(join(home, ".local/state/hedge/state.json"), state);
    const offline = plan({ packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    await expect(apply(offline, { home, adoptFrom: ["core"] })).rejects.toThrow("Run hedge apply --adopt-from core again once it can apply .agents/AGENTS.md.");
    expect(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")).toBe(state);
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("old rules\n");
  });

  test("--adopt-from keeps the other setup's claim while an outage keeps a file in its linked folder", async () => {
    const home = temp.make("home-");
    const outside = temp.make("outside-");
    writeFileSync(join(outside, "other.md"), "theirs\n");
    symlinkSync(outside, join(home, "guides"));
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    const state = JSON.stringify({ version: 1, groups: { core: { "guides/other.md": { kind: "file", hash: "0".repeat(64) } } } });
    writeFileSync(join(home, ".local/state/hedge/state.json"), state);
    const inside = plan({ files: [{ target: "guides/new.md", content: "new\n" }] });
    const offline = { ...inside, packs: [...inside.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await expect(apply(offline, { home, adoptFrom: ["core"] })).rejects.toThrow("Run hedge apply --adopt-from core again once it can apply guides/new.md.");
    expect(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")).toBe(state);
    expect(lstatSync(join(home, "guides")).isSymbolicLink()).toBe(true);
  });

  test("keeps Hedge's own folder link while an outage keeps the file it now writes inside it", async () => {
    const home = temp.make("home-");
    const guides = temp.make("guides-");
    await apply(plan({ files: [{ target: "guides", source: guides }] }), { home });
    const inside = plan({ files: [{ target: "guides/new.md", content: "new\n" }] });
    const offline = { ...inside, packs: [...inside.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };
    await apply(offline, { home });
    expect(lstatSync(join(home, "guides")).isSymbolicLink()).toBe(true);
    await apply(inside, { home });
    expect(readFileSync(join(home, "guides/new.md"), "utf8")).toBe("new\n");
  });

  test("keeps skills whose source is unreachable, and shared files that would lose an unreachable pack's part", async () => {
    const home = temp.make("home-");
    const skill = temp.make("skill-");
    const rules = { target: ".agents/AGENTS.md", content: "rules\nteam rules\n" };
    const link = { target: ".agents/skills/team", source: skill };
    await apply(plan({ files: [rules, link] }), { home });
    rmSync(skill, { recursive: true });
    const offline = plan({
      packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }],
      dropped: [{ pack: "base", item: "skill team:review", reason: "its source is unreachable" }],
    });
    const report = await apply(offline, { home });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("rules\nteam rules\n");
    expect(lstatSync(join(home, ".agents/skills/team")).isSymbolicLink()).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ id: "outage", say: expect.stringContaining("Left .agents/AGENTS.md, .agents/skills/team as they are") }));
    const back = await apply(plan(), { home });
    expect(back.actions).toContainEqual({ target: ".agents/AGENTS.md", operation: "replace" });
    expect(back.actions).toContainEqual({ target: ".agents/skills/team", operation: "remove" });
  });

  test("routes --adopt to the adapter that owns the target and rejects unknown targets", async () => {
    const home = temp.make("home-");
    const seen: string[][] = [];
    const config: Adapter = { name: "config", targets: () => [".claude/settings.json"], apply: async (_plan, context) => (seen.push(context.adopt), { actions: [], findings: [] }) };
    const report = await apply(plan(), { home, adopt: [".claude/settings.json"], adapters: [filesAdapter, config] });
    expect(report.ok).toBe(true);
    expect(seen).toEqual([[".claude/settings.json"]]);
    expect(apply(plan(), { home, adopt: [".bashrc"] })).rejects.toThrow("nothing to adopt at .bashrc");
  });

  test("skips the rest of the failing pack when a pack step fails, and fails apply whatever the pack", async () => {
    const steps = [
      { id: "a", run: ["one"], pack: "hub" },
      { id: "b", run: ["two"], pack: "hub" },
      { id: "c", run: ["three"], pack: "posthog" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "one" ? 1 : 0) });
    expect(ran).toEqual(["one", "three"]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "step:a", pack: "hub", say: "Step a of the hub pack failed.", repair: "apply" }]);
  });

  test("fails apply when a check that Hedge repairs still fails after its repair, but not when it waits for a person", async () => {
    const gateway = { id: "gateway", say: "The gateway is not installed.", probe: ["gateway-installed"], repair: ["gateway-installed", "--repair"], pack: "hub" };
    const signIn = { id: "sign-in", say: "Sign in.", command: "service login", probe: ["signed-in"], pack: "hub" };
    const broken = await apply(plan({ human: [gateway] }), { home: temp.make("home-"), run: exitCodes({ "gateway-installed": 1, "gateway-installed --repair": 1 }) });
    const waiting = await apply(plan({ human: [signIn] }), { home: temp.make("home-"), run: exitCodes({ "signed-in": 1 }) });
    expect([broken.ok, broken.findings]).toEqual([false, [{ id: "human:gateway", pack: "hub", say: "The gateway is not installed.", repair: "human" }]]);
    expect(waiting.ok).toBe(true);
  });

  test("skips a step whose check already passes", async () => {
    const steps = [
      { id: "cli", run: ["install-cli"], check: ["cli-version"], pack: "base" },
      { id: "fresh", run: ["install-fresh"], check: ["fresh-version"], pack: "base" },
    ];
    const ran: string[] = [];
    const run = async (command: string[]) => (ran.push(command[0]!), command[0] === "fresh-version" ? 1 : 0);
    await apply(plan({ steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["cli-version", "fresh-version", "install-fresh", "fresh-version"]);
  });

  test("reports a step whose run exits 0 but whose check still fails, and fails the apply", async () => {
    const steps = [
      { id: "codex-cli", run: ["install-codex"], check: ["codex", "--version"], pack: "base" },
      { id: "after", run: ["install-after"], pack: "base" },
    ];
    const ran: string[] = [];
    const report = await apply(plan({ steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "codex" ? 127 : 0) });
    expect(ran).toEqual(["codex", "install-codex", "codex"]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "step:codex-cli", pack: "base", say: "Step codex-cli of the base pack ran, but does not pass its check.", repair: "apply" }]);
  });

  test("a step that waits for a sign-in runs only once its probe passes, and doctor does not report it", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [{ id: "devbox", run: ["devbox-start"], check: ["devbox-status"], after: "coder", pack: "team" }];
    const ran: string[] = [];
    const signedOut = async (command: string[]) => (ran.push(command[0]!), 1);
    const report = await apply(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(ran).toEqual(["coder"]);
    expect(report.findings).toEqual([]);
    const doctor = await check(plan({ human, steps }), { home: temp.make("home-"), run: signedOut });
    expect(doctor.findings.map((finding) => finding.id).filter((id) => !id.startsWith("files:"))).toEqual(["human:coder"]);
    ran.length = 0;
    await apply(plan({ human, steps }), { home: temp.make("home-"), run: async (command) => (ran.push(command[0]!), command[0] === "devbox-status" ? 1 : 0) });
    expect(ran).toEqual(["coder", "devbox-status", "devbox-start", "devbox-status"]);
  });

  test("a sign-in is probed when its first waiting step comes up, after the steps before it ran", async () => {
    const human = [{ id: "coder", say: "Sign in to Coder", probe: ["coder", "whoami"], pack: "team" }];
    const steps = [
      { id: "install-coder", run: ["install-coder"], check: ["coder-installed"], pack: "team" },
      { id: "devbox", run: ["devbox-start"], after: "coder", pack: "team" },
    ];
    let installed = false;
    const ran: string[] = [];
    const run = async (command: string[]) => {
      ran.push(command[0]!);
      if (command[0] === "install-coder") installed = true;
      if (command[0] === "coder-installed") return installed ? 0 : 1;
      if (command[0] === "coder") return installed ? 0 : 127;
      return 0;
    };
    await apply(plan({ human, steps }), { home: temp.make("home-"), run });
    expect(ran).toEqual(["coder-installed", "install-coder", "coder-installed", "coder", "devbox-start"]);
  });

  test("runs steps with the plan's home directory as HOME", async () => {
    const home = temp.make("home-");
    const steps = [{ id: "mark", run: ["sh", "-c", 'touch "$HOME/marked"'], check: ["sh", "-c", 'test -f "$HOME/marked"'], pack: "base" }];
    const report = await apply(plan({ steps }), { home });
    expect(report.findings).toEqual([]);
    expect(existsSync(join(home, "marked"))).toBe(true);
  });
});

describe("a step whose pack now has a new name", () => {
  const marker = 'test -f "$HOME/upstream"';
  const upstream = { id: "context-upstream", check: ["sh", "-c", marker], undo: ["sh", "-c", 'rm "$HOME/upstream"'] };
  const packs = (...names: string[]) => names.map((name) => ({ name, source: "engine", ref: "main", available: true }));
  const withMemory = plan({ aliases: { "context-library": "memory" }, packs: packs("base", "memory"), steps: [{ ...upstream, pack: "memory", run: ["sh", "-c", 'touch "$HOME/upstream"'] }] });
  const withoutMemory = plan({ aliases: { "context-library": "memory" } });
  const installed = async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, "upstream"), "");
    await changeLedger(home, "steps", "context-library/context-upstream", { ...upstream, pack: "context-library" });
    return home;
  };
  const ledgerText = (home: string) => readFileSync(join(home, ".local/state/hedge/steps.json"), "utf8");

  test("stays installed across the upgrade, and is still undone once its pack leaves the profile", async () => {
    const home = await installed();
    expect((await apply(withMemory, { home })).ok).toBe(true);
    expect(existsSync(join(home, "upstream"))).toBe(true);
    expect((await apply(withoutMemory, { home })).ok).toBe(true);
    expect(existsSync(join(home, "upstream"))).toBe(false);
    expect((await readLedger(home)).steps).toEqual([]);
  });

  test("a dry run reports no removal and leaves the upstream and the ledger as they were", async () => {
    const home = await installed();
    const before = ledgerText(home);
    const report = await apply(withMemory, { home, dryRun: true });
    expect(report.actions.filter((action) => action.operation === "remove")).toEqual([]);
    expect(existsSync(join(home, "upstream"))).toBe(true);
    expect(ledgerText(home)).toBe(before);
  });

  test("keeps the newer entry when the ledger already holds the new name too", async () => {
    const home = await installed();
    await changeLedger(home, "steps", "memory/context-upstream", { ...upstream, pack: "memory", undo: ["sh", "-c", 'rm "$HOME/upstream"; touch "$HOME/newer-undo"'] });
    expect((await apply(plan({ aliases: { "context-library": "memory" }, packs: packs("base", "memory") }), { home })).ok).toBe(true);
    expect(existsSync(join(home, "newer-undo"))).toBe(true);
    expect((await readLedger(home)).steps).toEqual([]);
  });

  test("keeps a step of a pack named constructor installed across applies, and undoes it once the pack leaves", async () => {
    const home = temp.make("home-");
    const step = { ...upstream, pack: "constructor", run: ["sh", "-c", 'touch "$HOME/upstream"'] };
    const constructorPlan = plan({ aliases: { "context-library": "memory" }, packs: packs("base", "constructor"), steps: [step] });
    expect((await apply(constructorPlan, { home })).ok).toBe(true);
    expect((await apply(constructorPlan, { home })).ok).toBe(true);
    expect(existsSync(join(home, "upstream"))).toBe(true);
    expect((await apply(plan({ aliases: { "context-library": "memory" } }), { home })).ok).toBe(true);
    expect(existsSync(join(home, "upstream"))).toBe(false);
  });
});

describe("a workflow that waits for a setting", () => {
  test("is named with the command that sets it, and the apply still passes", async () => {
    const home = temp.make("home-");
    const report = await apply(plan({ workflows: [{ id: "context-library", pack: "memory", active: false, reason: "waits for setting context-library.repo", unset: "context-library.repo" }] }), { home });
    expect(report.ok).toBe(true);
    expect(report.findings).toContainEqual({ id: "waits:context-library", pack: "memory", say: "Workflow context-library stays off until you set context-library.repo. Set it with hedge set context-library.repo=<value>." });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("rules\n");
  });
});

describe("a config entry that waits for a pack check", () => {
  const checks = [{ id: "proxy-up", run: ["proxy-check"], say: "The proxy is down.", pack: "base" }];
  const config = [
    { provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", after: "proxy-up", pack: "base" },
    { provider: "claude" as const, key: "apiKeyHelper", value: keyHelper, after: "proxy-up", pack: "base" },
  ];
  const proxy = (up: () => boolean) => async (command: string[]) => (command.join(" ") === "proxy-check" ? (up() ? 0 : 1) : 0);
  const settings = (home: string) => (existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : undefined);
  const down = { id: "check:proxy-up", pack: "base", say: "The proxy is down.", repair: "apply" as const };

  test("is written while its check passes, removed while it fails, and apply names the failed check", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus" }));
    let up = true;
    const options = { home, adapters: [providerConfigAdapter()], run: proxy(() => up) };
    expect((await apply(plan({ files: [], checks, config }), options)).findings).toEqual([]);
    expect(settings(home)).toEqual({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
    up = false;
    const failed = await apply(plan({ files: [], checks, config }), options);
    expect(failed.ok).toBe(true);
    expect(failed.findings).toEqual([down]);
    expect(settings(home)).toEqual({ model: "opus" });
    expect((await apply(plan({ files: [], checks, config }), options)).actions).toEqual([]);
    up = true;
    await apply(plan({ files: [], checks, config }), options);
    expect(settings(home)).toEqual({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
  });

  test("that is one part of Hedge's proxy route takes the other part out with it when its own check fails, in apply and in doctor", async () => {
    const home = temp.make("home-");
    const split = [config[0]!, { ...config[1]!, after: "helper-up" }];
    const both = [...checks, { id: "helper-up", run: ["helper-check"], say: "The helper is down.", pack: "base" }];
    const options = { home, adapters: [providerConfigAdapter()], run: async (command: string[]) => (command.join(" ") === "helper-check" ? 1 : 0) };
    const applied = await apply(plan({ files: [], checks: both, config: split }), options);
    expect(applied.findings.map((finding) => finding.id)).toEqual(["check:helper-up"]);
    expect(settings(home)).toBeUndefined();
    const doctor = await check(plan({ files: [], checks: both, config: split }), options);
    expect(doctor.findings.map((finding) => finding.id)).toEqual(["check:helper-up"]);
  });

  test("a check that cannot tell holds only Hedge's proxy route as it is; other config that waits on such a check leaves, and that check keeps its own words", async () => {
    const home = temp.make("home-");
    const withModel = [...config, { provider: "claude" as const, key: "model", value: "opus", after: "model-up", pack: "base" }];
    const both = [...checks, { id: "model-up", run: ["model-check"], say: "No model yet.", pack: "base" }];
    let code = 0;
    const options = { home, adapters: [providerConfigAdapter()], run: async (command: string[]) => (command[0]!.endsWith("-check") ? code : 0) };
    await apply(plan({ files: [], checks: both, config: withModel }), options);
    code = 3;
    const unsure = await apply(plan({ files: [], checks: both, config: withModel }), options);
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
    expect(unsure.findings).toEqual([
      { id: "check:proxy-up", pack: "base", say: "Hedge cannot tell yet whether proxy-up passes, so it keeps the proxy route that waits on it as it is. Run proxy-check to see why.", repair: "apply" },
      { id: "check:model-up", pack: "base", say: "No model yet.", repair: "apply" },
    ]);
  });

  test("two checks with one id: either passing writes the route, and a refusal beside a cannot-tell takes an installed route off", async () => {
    const twice = [{ ...checks[0]!, run: ["first-check"] }, { ...checks[0]!, run: ["second-check"] }];
    const routed = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper };
    const applyWith = (home: string, first: number, second: number) => apply(plan({ files: [], checks: twice, config }), { home, adapters: [providerConfigAdapter()], run: async (command: string[]) => (command[0] === "first-check" ? first : command[0] === "second-check" ? second : 0) });
    for (const first of [1, 3]) {
      const home = temp.make("home-");
      await applyWith(home, first, 0);
      expect(settings(home)).toEqual(routed);
    }
    const home = temp.make("home-");
    await applyWith(home, 0, 0);
    await applyWith(home, 1, 3);
    expect(settings(home)).toEqual({});
  });

  test("a route split across two checks leaves whole when one cannot tell and the other refuses", async () => {
    const home = temp.make("home-");
    const split = [config[0]!, { ...config[1]!, after: "helper-up" }];
    const both = [...checks, { id: "helper-up", run: ["helper-check"], say: "The helper is down.", pack: "base" }];
    const codes = { "proxy-check": 0, "helper-check": 0 };
    const options = { home, adapters: [providerConfigAdapter()], run: async (command: string[]) => codes[command[0] as keyof typeof codes] ?? 0 };
    await apply(plan({ files: [], checks: both, config: split }), options);
    Object.assign(codes, { "proxy-check": 3, "helper-check": 1 });
    await apply(plan({ files: [], checks: both, config: split }), options);
    expect(settings(home)).toEqual({});
  });

  const stepping = (codes: { before: number; after: number }) => {
    let ran = false;
    const seen: unknown[] = [];
    const run = (home: string) => async ([command]: string[]) => {
      if (command === "start-proxy") {
        seen.push(settings(home)?.env?.ANTHROPIC_BASE_URL);
        ran = true;
      }
      if (command === "proxy-check") return ran ? codes.after : codes.before;
      return 0;
    };
    return { run, seen };
  };
  const steps = [{ id: "start-proxy", run: ["start-proxy"], pack: "base" }];

  test("that exits 4 without a todo before a step and passes after it puts its config in within the same apply, and leaves no Fix", async () => {
    const home = temp.make("home-");
    const { run } = stepping({ before: 4, after: 0 });
    const applied = await apply(plan({ files: [], checks, config, steps }), { home, adapters: [providerConfigAdapter()], run: run(home) });
    expect(applied).toMatchObject({ ok: true, findings: [] });
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
  });

  test("with a todo, that exits 4 before a step and passes after it puts its config in within the same apply, and leaves no To do", async () => {
    const home = temp.make("home-");
    const { run } = stepping({ before: 4, after: 0 });
    const waiting = plan({ files: [], checks: [{ ...checks[0]!, todo: "Add an account to the proxy." }], config, steps });
    const options = { home, adapters: [providerConfigAdapter()], run: run(home) };
    expect((await check(waiting, options)).findings).toEqual([{ id: "check:proxy-up", pack: "base", say: "Add an account to the proxy.", todo: true }]);
    const applied = await apply(waiting, options);
    expect(applied).toMatchObject({ ok: true, findings: [] });
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
    expect(await check(waiting, options)).toMatchObject({ ok: true, findings: [] });
  });

  test("that passes before a step and fails after it never puts its config in, and apply names the failed check", async () => {
    const home = temp.make("home-");
    const { run, seen } = stepping({ before: 0, after: 1 });
    const applied = await apply(plan({ files: [], checks, config, steps }), { home, adapters: [providerConfigAdapter()], run: run(home) });
    expect(seen).toEqual([undefined]);
    expect(applied.findings).toEqual([down]);
    expect(settings(home)).toBeUndefined();
  });

  test("that an earlier apply wrote, and whose check fails before a step and passes after it, stays in place, and apply changes nothing", async () => {
    const home = temp.make("home-");
    await apply(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: proxy(() => true) });
    const { run, seen } = stepping({ before: 1, after: 0 });
    const applied = await apply(plan({ files: [], checks, config, steps }), { home, adapters: [providerConfigAdapter()], run: run(home) });
    expect(seen).toEqual(["http://127.0.0.1:8317"]);
    expect(applied).toMatchObject({ ok: true, actions: [], findings: [] });
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
  });

  test("doctor changes nothing, reports the failed check once, and fails", async () => {
    const home = temp.make("home-");
    await apply(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: proxy(() => true) });
    let probes = 0;
    const flaky = async (command: string[]) => (command.join(" ") === "proxy-check" ? (probes++ === 0 ? 1 : 0) : 0);
    const report = await check(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: flaky });
    expect(report.ok).toBe(false);
    expect(report.findings.filter((finding) => finding.id === down.id)).toEqual([down]);
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: keyHelper });
  });
});

describe("a pack check that waits for the person", () => {
  const checks = [{ id: "pool", run: ["pool-check"], say: "Hedge cannot read the pool.", todo: "Add an account to the pool.", pack: "base" }];
  const config = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", after: "pool", pack: "base" }];
  const waiting = { id: "check:pool", pack: "base", say: "Add an account to the pool.", todo: true as const };
  const settings = (home: string) => (existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : undefined);

  test("keeps the config that waits for it out, and apply and doctor say it as a To do that fails nothing", async () => {
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter()], run: exitCodes({ "pool-check": 4 }) };
    const applied = await apply(plan({ files: [], checks, config }), options);
    expect(applied.ok).toBe(true);
    expect(applied.findings).toEqual([waiting]);
    expect(settings(home)).toBeUndefined();
    const doctor = await check(plan({ files: [], checks, config }), options);
    expect(doctor.ok).toBe(true);
    expect(doctor.findings).toEqual([waiting]);
  });

  const installedPool = () => {
    let installed = false;
    let code = 4;
    const run = async (command: string[]) => {
      const words = command.join(" ");
      if (words === "install-pool") installed = true;
      if (words === "pool-installed") return installed ? 0 : 1;
      return words === "pool-check" ? (installed ? code : 1) : 0;
    };
    return { run, set: (next: number) => (code = next) };
  };
  const steps = [{ id: "install-pool", run: ["install-pool"], check: ["pool-installed"], pack: "base" }];

  test("that nothing waits for runs after the steps, so it reads what a step installed, and apply reports what it finds then", async () => {
    const { run, set } = installedPool();
    const home = temp.make("home-");
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [waiting] });
    set(1);
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [{ id: "check:pool", pack: "base", say: "Hedge cannot read the pool.", repair: "apply" }] });
    expect(await check(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: false, findings: [{ id: "check:pool", pack: "base", say: "Hedge cannot read the pool.", repair: "apply" }] });
    set(0);
    expect(await apply(plan({ files: [], checks, steps }), { home, run })).toMatchObject({ ok: true, findings: [] });
  });

  test("that config waits for and that fails before a step installs what it reads becomes a To do once the step ran, and the config stays out", async () => {
    const { run } = installedPool();
    const home = temp.make("home-");
    const applied = await apply(plan({ files: [], checks, steps, config }), { home, adapters: [providerConfigAdapter()], run });
    expect(applied).toMatchObject({ ok: true, findings: [waiting] });
    expect(settings(home)).toBeUndefined();
  });

  test("that config waits for and that fails before a step starts what it reads puts its config in once the step ran, and doctor then passes", async () => {
    const { run, set } = installedPool();
    set(0);
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter()], run };
    const applied = await apply(plan({ files: [], checks, steps, config }), options);
    expect(applied).toMatchObject({ ok: true, findings: [] });
    expect(applied.actions.map((action) => [action.target, action.operation])).toEqual([[".claude/settings.json", "create"]]);
    expect(settings(home)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(await check(plan({ files: [], checks, steps, config }), options)).toMatchObject({ ok: true, findings: [] });
  });

  const claudeCli = (ready: () => boolean) => {
    const installed: Array<{ id: string; scope: string }> = [];
    const run: CommandRunner = async (command) => {
      if (!ready()) return { code: 127, stdout: "" };
      const scope = command.includes("--scope") ? command[command.indexOf("--scope") + 1]! : "user";
      if (!["user", "project", "local"].includes(scope)) return { code: 1, stdout: "" };
      if (command[2] === "list") return { code: 0, stdout: JSON.stringify(installed) };
      if (command[2] === "install") installed.push({ id: command[3]!, scope });
      if (command[2] === "uninstall") installed.splice(installed.findIndex((entry) => entry.id === command[3] && entry.scope === scope), 1);
      return { code: 0, stdout: "" };
    };
    return { run, installed };
  };
  const context7 = "context7@claude-plugins-official";
  const plugin = { provider: "claude" as const, key: `enabledPlugins.${context7}`, value: true, pack: "base" };

  test("that config waits for and that passes once a step ran puts its config in after the step, so a plugin that waited for the step's Claude Code leaves no Fix and is installed for the user", async () => {
    const pool = installedPool();
    pool.set(0);
    let installed = false;
    const run = async (command: string[]) => {
      if (command.join(" ") === "install-pool") installed = true;
      return pool.run(command);
    };
    const claude = claudeCli(() => installed);
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter({ run: claude.run })], run };
    const applied = await apply(plan({ files: [], checks, steps, config: [...config, plugin] }), options);
    expect(applied).toMatchObject({ ok: true, findings: [] });
    expect(claude.installed).toEqual([{ id: context7, scope: "user" }]);
    expect(settings(home).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
    expect(await check(plan({ files: [], checks, steps, config: [...config, plugin] }), options)).toMatchObject({ ok: true, findings: [] });
    claude.installed.splice(0, 1, { id: context7, scope: "project" });
    expect((await check(plan({ files: [], checks, steps, config: [...config, plugin] }), options)).findings).toEqual([{ id: `plugin:${context7}`, pack: "engine", say: `The Claude plugin ${context7} needs to be installed.`, repair: "apply" }]);
  });

  test("that nothing waits for runs after the provider config, so it reads a plugin the same apply installed", async () => {
    const claude = claudeCli(() => true);
    const run = async (command: string[]) => (command.join(" ") === "pool-check" ? (claude.installed.length ? 0 : 4) : 0);
    const applied = await apply(plan({ files: [], checks, config: [plugin] }), { home: temp.make("home-"), adapters: [providerConfigAdapter({ run: claude.run })], run });
    expect(applied).toMatchObject({ ok: true, findings: [] });
    expect(claude.installed).toEqual([{ id: context7, scope: "user" }]);
  });

  test("that config waits for and that passes once a step ran keeps the notice that an edited plugin is yours now", async () => {
    const pool = installedPool();
    pool.set(0);
    const claude = claudeCli(() => true);
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter({ run: claude.run })], run: pool.run };
    await apply(plan({ files: [], config: [plugin] }), options);
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { [context7]: false } }));
    const applied = await apply(plan({ files: [], checks, steps, config }), options);
    expect(applied.findings).toEqual([{ id: `plugin:${context7}`, pack: "engine", say: `Kept the Claude plugin ${context7}, which no pack enables any more, because it changed outside Hedge. It is yours now.` }]);
    expect(settings(home).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
    expect(claude.installed).toEqual([{ id: context7, scope: "user" }]);
  });

  test("that config waits for and that passes once a step ran still reports a marketplace update that failed", async () => {
    const pool = installedPool();
    pool.set(0);
    const installed: Array<{ id: string; scope: string }> = [];
    const claude: CommandRunner = async (command) => {
      const words = command.slice(2).join(" ");
      if (words === "list --json") return { code: 0, stdout: JSON.stringify(installed) };
      if (words === "marketplace list --json") return { code: 0, stdout: JSON.stringify([{ name: "claude-plugins-official" }]) };
      if (words === "marketplace update claude-plugins-official") return { code: 1, stdout: "", stderr: "network down" };
      if (command[2] === "install") installed.push({ id: command[3]!, scope: "user" });
      return { code: 0, stdout: "" };
    };
    const home = temp.make("home-");
    const applied = await apply(plan({ files: [], checks, steps, config: [...config, plugin] }), { home, adapters: [providerConfigAdapter({ run: claude })], run: pool.run });
    expect(applied.findings).toEqual([{ id: "plugin-marketplace:claude-plugins-official", pack: "engine", say: "Could not update the Claude plugin marketplace claude-plugins-official: network down.", repair: "apply" }]);
    expect(installed).toEqual([{ id: context7, scope: "user" }]);
    expect(settings(home).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
  });

  test("doctor reads one result of a check that config waits for, for both the config and the finding", async () => {
    const home = temp.make("home-");
    const options = { home, adapters: [providerConfigAdapter()], run: exitCodes({}) };
    await apply(plan({ files: [], checks, config }), options);
    let probes = 0;
    const emptying = async (command: string[]) => (command.join(" ") === "pool-check" ? (probes++ === 0 ? 0 : 4) : 0);
    expect(await check(plan({ files: [], checks, config }), { ...options, run: emptying })).toMatchObject({ ok: true, findings: [] });
    probes = 0;
    const filling = async (command: string[]) => (command.join(" ") === "pool-check" ? (probes++ === 0 ? 4 : 0) : 0);
    const doctor = await check(plan({ files: [], checks, config }), { ...options, run: filling });
    expect(doctor.findings.map((finding) => [finding.id, finding.todo ?? finding.repair])).toEqual([["check:pool", true], ["config:.claude/settings.json", "apply"]]);
  });

  test("a check without a todo that exits 4 is a Fix, and a check with one stays a Fix for any other failing code", async () => {
    const home = temp.make("home-");
    const plain = [{ ...checks[0]!, todo: undefined }];
    expect((await check(plan({ files: [], checks: plain }), { home, run: exitCodes({ "pool-check": 4 }) })).findings).toEqual([{ id: "check:pool", pack: "base", say: "Hedge cannot read the pool.", repair: "apply" }]);
    expect((await check(plan({ files: [], checks, config }), { home, adapters: [providerConfigAdapter()], run: exitCodes({ "pool-check": 1 }) })).ok).toBe(false);
  });
});

describe("check", () => {
  test("runs pack checks and human probes, and lists the human steps left", async () => {
    const human = [{ id: "github", say: "Sign in to GitHub.", command: "gh auth login --web", probe: ["gh", "auth", "status"], pack: "base" }];
    const checks = [{ id: "disk", run: ["df-check"], say: "Free some disk space.", pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human, checks }), { home, run: exitCodes({ "gh auth status": 1, "df-check": 0 }) });
    expect(report.ok).toBe(false);
    expect(report.humanLeft.map((step) => step.id)).toEqual(["github"]);
    expect(report.findings).toEqual([{ id: "human:github", pack: "base", say: "Sign in to GitHub. Run: gh auth login --web", repair: "human" }]);
  });

  test("names a failing check that Hedge can repair as a Fix for apply, even when nothing waits for it", async () => {
    const human = [{ id: "gateway", say: "The gateway is not installed.", probe: ["gateway-installed"], repair: ["gateway-installed", "--repair"], pack: "hub" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human }), { home, run: exitCodes({ "gateway-installed": 1 }) });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ id: "human:gateway", pack: "hub", say: "The gateway is not installed.", repair: "apply" }]);
  });

  test("keeps a failing check as a To do when its fix still needs a person's command, even with a Hedge repair", async () => {
    const human = [{ id: "service", say: "Sign in to the service.", command: "service login", interactive: true as const, probe: ["service-ready"], repair: ["service-ready", "--repair"], pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ human }), { home, run: exitCodes({ "service-ready": 1 }) });
    expect(report.findings).toEqual([{ id: "human:service", pack: "base", say: "Sign in to the service. Run: service login", repair: "human" }]);
  });

  test("runs each step's check", async () => {
    const steps = [{ id: "proxy", run: ["start-proxy"], check: ["proxy-health"], pack: "base" }];
    const home = temp.make("home-");
    await apply(plan(), { home });
    const report = await check(plan({ steps }), { home, run: exitCodes({ "proxy-health": 1 }) });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({ id: "step:proxy", pack: "base", say: "Step proxy of the base pack does not pass its check.", repair: "apply" });
  });

  test("fails while a kept file differs from the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "mine\n");
    const report = await check(plan(), { home, run: exitCodes({}) });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.id)).toEqual(["kept:.agents/AGENTS.md"]);
  });
});

describe("a leading hedge in a pack's commands", () => {
  const launcher = ["/bin/sh", "/engine/hedge"];
  const team = {
    engineRoot: "/engine",
    files: [],
    human: [{ id: "login", pack: "team", say: "Sign in.", command: "hedge login", probe: ["hedge", "whoami"] }],
    steps: [{ id: "start", pack: "team", run: ["hedge", "start"], check: ["hedge", "status"], after: "login" }],
    checks: [{ id: "healthy", pack: "team", run: ["hedge", "health"], say: "Unhealthy." }],
  };
  const recorder = (codes: Record<string, number> = {}) => {
    const calls: string[] = [];
    return { calls, run: async (command: string[]) => (calls.push(command.join(" ")), codes[command.join(" ")] ?? 0) };
  };

  test("runs this engine's launcher in apply", async () => {
    const { calls, run } = recorder({ "/bin/sh /engine/hedge status": 1 });
    await apply(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "whoami"], [...launcher, "status"], [...launcher, "start"], [...launcher, "status"]].map((command) => command.join(" ")));
  });

  test("runs this engine's launcher in check", async () => {
    const { calls, run } = recorder();
    await check(plan(team), { home: temp.make("home-"), run });
    expect(calls).toEqual([[...launcher, "health"], [...launcher, "whoami"], [...launcher, "status"], [...launcher, "whoami"]].map((command) => command.join(" ")));
  });

  test("leaves other commands and a plan without an engine as they are", async () => {
    const { calls, run } = recorder();
    await check(plan({ ...team, engineRoot: undefined, checks: [{ id: "gh", pack: "team", run: ["gh", "hedge"], say: "No gh." }] }), { home: temp.make("home-"), run });
    expect(calls).toEqual(["gh hedge", "hedge whoami", "hedge status", "hedge whoami"]);
  });
});

describe("humanStepsLeft", () => {
  test("separates failing probes from timed-out probes and closes a child-held FIFO when the deadline expires", async () => {
    const home = temp.make("home-");
    const ready = join(home, "ready");
    const hold = join(home, "hold");
    expect(await Bun.spawn(["mkfifo", ready, hold]).exited).toBe(0);
    const holdClosed = Bun.spawn(["cat", hold], { stdout: "ignore", stderr: "ignore" }).exited;
    const readySeen = Bun.spawn(["cat", ready], { stdout: "ignore", stderr: "ignore" }).exited;
    const human = [
      { id: "ok", pack: "team", say: "Ok.", probe: ["sh", "-c", "exit 0"] },
      { id: "missing", pack: "team", say: "Sign in.", probe: ["sh", "-c", "exit 1"] },
      { id: "slow", pack: "team", say: "Slow.", probe: ["sh", "-c", 'exec 3>"$HOME/hold"; sleep 30 >&3 & echo ready > "$HOME/ready"; wait'] },
    ];
    let expire: (() => void) | undefined;
    const pending = humanStepsLeft(plan({ human }), {
      home,
      sleep: () => new Promise<void>((resolve) => { expire = resolve; }),
    });
    expect(await readySeen).toBe(0);
    expire?.();
    const left = await pending;
    expect(left.failing.map((step) => step.id)).toEqual(["missing"]);
    expect(left.unchecked.map((step) => step.id)).toEqual(["slow"]);
    expect(await holdClosed).toBe(0);
  });
});
