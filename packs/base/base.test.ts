import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPacks } from "../../src/pack/manifest.ts";
import { apply } from "../../src/reconciler/apply.ts";
import type { AiPlan, AvailableSource, MachineFile, Plan, Profile } from "../../src/pack/types.ts";
import { resolve } from "../../src/reconciler/resolve.ts";

const plans: AiPlan[] = ["claude", "codex", "both"];
const mac: MachineFile = { schema: 1, role: "mac" };
const devbox: MachineFile = { schema: 1, role: "devbox" };
let engine: AvailableSource;

beforeAll(async () => {
  const dir = join(import.meta.dir, "../..");
  engine = { ref: { name: "engine", repo: "PostHog/hedge", ref: "main" }, dir, packs: await loadPacks(dir) };
});

function plan(ai: AiPlan, machine = mac, settings: Profile["settings"] = {}, sources = [engine]): Plan {
  const profile: Profile = { schema: 1, dir: "/profile", engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs: sources.slice(1).flatMap((source) => source.packs.map((pack) => pack.manifest.name)), plan: ai, settings, workflows: {} };
  return resolve(profile, machine, sources);
}

const isAgentCli = (id: string) => /^(claude|codex)-cli/.test(id);

function agents(result: Plan) {
  const file = result.files.find((item) => item.target === ".agents/AGENTS.md");
  if (!file || !("content" in file)) throw new Error("no AGENTS.md");
  return file.content;
}

describe("the Base pack", () => {
  test.each(plans)("gives a stable AGENTS.md for plan %s", (ai) => {
    expect(agents(plan(ai))).toMatchSnapshot();
    expect(agents(plan(ai, devbox))).toBe(agents(plan(ai)));
  });

  test("names only the models of the chosen plan", () => {
    expect(new Set(plan("claude").models.map((row) => row.provider))).toEqual(new Set(["claude"]));
    expect(new Set(plan("codex").models.map((row) => row.provider))).toEqual(new Set(["codex"]));
    expect(new Set(plan("both").models.map((row) => row.provider))).toEqual(new Set(["claude", "codex"]));
    for (const ai of plans) expect(plan(ai).models.map((row) => row.role)).toEqual(expect.arrayContaining(["lookup", "survey", "research", "implementation", "review"]));
  });

  test("asks nothing at setup and declares the settings the Base commands read", () => {
    for (const ai of plans) {
      const result = plan(ai, devbox);
      expect(result.unanswered).toEqual([]);
      expect(result.settings).toEqual({ "base.heavySlots": 2, "base.diskFloorGigabytes": 10, "base.startFloorGigabytes": 25, "identity.signer": "ssh", "context.path": "~/dev/context", "base.t3TimeZone": "" });
    }
  });

  test("signs with the Coder key in a Coder workspace and with an SSH key everywhere else", () => {
    const coder: MachineFile = { schema: 1, role: "devbox", coder: true };
    expect(plan("both", coder).settings["identity.signer"]).toBe("coder");
    expect(plan("both", devbox).settings["identity.signer"]).toBe("ssh");
    expect(plan("both", mac).settings["identity.signer"]).toBe("ssh");
    expect(plan("both", coder, { "identity.signer": "1password" }).settings["identity.signer"]).toBe("1password");
  });

  test("lets a pack override the signer default", () => {
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const result = plan("both", { schema: 1, role: "devbox", coder: true }, {}, [engine, team]);
    expect(result.settings["identity.signer"]).toBe("1password");
    expect(result.ask.filter((setting) => setting.key === "identity.signer")).toEqual([]);
  });

  test("keeps Base's signer when a pack's override sits in a workflow that is off", () => {
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const workflows = [{ id: "team-signing", name: "Team signing", sentence: "Signs with 1Password.", default: false, settings: ["identity.signer"] }];
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer], workflows }, dir: "/team/packs/team" }] };
    const coder: MachineFile = { schema: 1, role: "devbox", coder: true };
    expect(plan("both", coder, {}, [engine, team]).settings["identity.signer"]).toBe("coder");
    expect(plan("both", coder, { "identity.signer": "ssh" }, [engine, team]).settings["identity.signer"]).toBe("ssh");
    const on = resolve({ schema: 1, dir: "/profile", engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs: ["team"], plan: "both", settings: {}, workflows: { "team-signing": true } }, coder, [engine, team]);
    expect(on.settings["identity.signer"]).toBe("1password");
  });

  test("installs Codex hooks, Codex config, and the Codex CLI only when the plan has Codex", () => {
    const codex = (result: Plan) => result.config.filter((entry) => entry.provider === "codex").map((entry) => entry.key);
    expect(codex(plan("claude"))).toEqual([]);
    expect(codex(plan("codex"))).toEqual(["hooks.UserPromptSubmit", "hooks.PreToolUse", "hooks.PostToolUse", "hooks.SessionStart", "hooks.Stop", "model", "model_reasoning_effort"]);
    expect(plan("both", devbox).steps.map((step) => step.id).filter(isAgentCli)).toEqual(["claude-cli", "codex-cli"]);
    expect(plan("claude", devbox).steps.map((step) => step.id).filter(isAgentCli)).toEqual(["claude-cli"]);
    expect(plan("codex", devbox).steps.map((step) => step.id).filter(isAgentCli)).toEqual(["codex-cli"]);
  });

  test("installs the agent CLIs on a Mac too, Codex from its release package, so a clean Mac without Node or Homebrew can sign in", () => {
    expect(plan("both").steps.map((step) => step.id).filter(isAgentCli)).toEqual(["claude-cli", "codex-cli"]);
    expect(plan("claude").steps.map((step) => step.id).filter(isAgentCli)).toEqual(["claude-cli"]);
    expect(plan("codex").steps.map((step) => step.id).filter(isAgentCli)).toEqual(["codex-cli"]);
    expect(plan("both").steps.find((step) => step.id === "codex-cli")).toMatchObject({ run: ["hedge", "install-codex"] });
  });

  test.each(plans)("installs a pinned Node.js on Linux for plan %s, and a Node install that fails leaves the agent CLIs installed and passing their checks", async (ai) => {
    const devboxPlan = plan(ai, devbox);
    const installed = new Set<string>();
    const launched = (command: string[]) => JSON.stringify(command[0] === "hedge" ? ["/bin/sh", join(engine.dir, "hedge"), ...command.slice(1)] : command);
    const checks = new Map(devboxPlan.steps.flatMap((step) => (step.check ? [[launched(step.check), step.id] as const] : [])));
    const runs = new Map(devboxPlan.steps.map((step) => [launched(step.run), step.id] as const));
    const run = async (command: string[]) => {
      const checked = checks.get(JSON.stringify(command));
      if (checked) return installed.has(checked) ? 0 : 1;
      const step = runs.get(JSON.stringify(command));
      if (step === "node-runtime") return 1;
      if (step) installed.add(step);
      return 0;
    };
    const home = mkdtempSync(join(tmpdir(), "base-home-"));
    try {
      const report = await apply(devboxPlan, { home, run });
      const agentClis = devboxPlan.steps.map((step) => step.id).filter(isAgentCli);
      expect(agentClis.length).toBeGreaterThan(0);
      expect(agentClis.filter((id) => installed.has(id))).toEqual(agentClis);
      expect(report.findings.filter((finding) => finding.id.startsWith("step:")).map((finding) => finding.id)).toEqual(["step:node-runtime"]);
      expect(plan(ai).steps.map((step) => step.id)).not.toContain("node-runtime");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("gives each plan one T3 default model from its own provider", () => {
    const model = (ai: AiPlan) => plan(ai).config.filter((entry) => entry.key === "defaultModelSelection").map((entry) => (entry.value as { instanceId: string }).instanceId);
    expect(model("claude")).toEqual(["claudeAgent"]);
    expect(model("codex")).toEqual(["codex"]);
    expect(model("both")).toEqual(["claudeAgent"]);
  });

  const checkedTools = {
    claude: ["Bash", "Agent", "Task", "AskUserQuestion", "mcp__t3-code__t3_thread_organize", "mcp__github__merge_pull_request", "mcp__playwright__browser_click"],
    codex: ["Bash", "exec_command", "shell", "shell_command", "local_shell", "request_user_input", "mcp__t3-code__t3_thread_organize", "mcp__github__merge_pull_request"],
  };
  const unchecked = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "apply_patch", "update_plan", "view_image", "Bashful", "XBash", "Agents"];

  test.each(["claude", "codex"] as const)("starts %s's PreToolUse hooks only for shell, agent, question, and MCP tools", (provider) => {
    const entry = plan("both").config.find((item) => item.provider === provider && item.key === "hooks.PreToolUse");
    const groups = entry?.value as Array<{ matcher?: string }>;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => typeof group.matcher === "string" && group.matcher.length > 0)).toBe(true);
    const starts = (tool: string) => groups.some((group) => group.matcher === undefined || new RegExp(group.matcher).test(tool));
    expect(checkedTools[provider].filter(starts)).toEqual(checkedTools[provider]);
    expect(unchecked.filter(starts)).toEqual([]);
  });

  test("links hooks everywhere and the heavy slice only on a devbox", () => {
    const linked = (result: Plan) => result.files.filter((item) => item.target.startsWith(".config/")).map((item) => item.target);
    expect(linked(plan("both", devbox))).toContain(".config/systemd/user/hedge-heavy.slice");
    expect(linked(plan("both"))).not.toContain(".config/systemd/user/hedge-heavy.slice");
    expect(linked(plan("codex"))).not.toContain(".config/hedge/hooks/PreToolUse/name-a-model.ts");
    expect(linked(plan("claude"))).toEqual(expect.arrayContaining([".config/hedge/hooks/run.sh", ".config/hedge/hooks/PostToolUse/secret-guard.ts", ".config/hedge/hooks/PreToolUse/name-a-model.ts"]));
  });

  test("runs the update and prune jobs on every machine and keeps linked machines to devboxes", () => {
    for (const machine of [mac, devbox]) expect(plan("both", machine).jobs.map((job) => job.id)).toEqual(["hedge-update", "agent-update", "source-refresh", "worktree-prune"]);
    expect(plan("both").workflows.find((workflow) => workflow.id === "linked-machines")).toMatchObject({ active: false, reason: "needs devbox" });
    expect(plan("both", devbox).config.some((entry) => entry.key === "linkedEnvironmentsEnabled")).toBe(true);
  });

  test("names no person, host, or private path in anything it writes", () => {
    for (const ai of plans) {
      const text = JSON.stringify(plan(ai, devbox)) + agents(plan(ai));
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/\/dev\/fleet\b|\.ts\.net|\bU0[A-Z0-9]{8,}\b/);
    }
  });
});
