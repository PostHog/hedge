import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../../../src/pack/manifest.ts";
import type { AvailableSource, Profile } from "../../../src/pack/types.ts";
import { resolve } from "../../../src/reconciler/resolve.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { hook as nameAModel } from "./name-a-model.ts";

const reminder = "Name a model on this Agent call: an omitted model inherits the parent model. Agent takes haiku, sonnet, opus, or fable; a row with a GPT model runs on Codex, through T3's `delegate_task`.";
const pointer = "Cast it with the model table in ~/.agents/AGENTS.md.";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const table = "## Model selection\n\n| Work | Model | Effort |\n| --- | --- | --- |\n"
  + "| **Survey**: read docs | `claude-sonnet-5-5` | high |\n| **Review** of Claude's code | `gpt-6.2-sol` | high |";
const instructions = `# Agent rules\n\nIntro.\n\n${table}\n\n# Memory\n\nOther pack rules.\n\n## About me\n\nMore rules.\n`;

let engine: AvailableSource;
beforeAll(async () => {
  const dir = join(import.meta.dir, "../../..");
  engine = { ref: { name: "engine", repo: "PostHog/hedge", ref: "main" }, dir, packs: await loadPacks(dir) };
});

function renderedInstructions(models: NonNullable<Profile["overrides"]>["models"]) {
  const profile: Profile = { schema: 1, dir: "/profile", engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs: ["memory", "context-library"], plan: "both", settings: {}, workflows: {}, overrides: { models } };
  const file = resolve(profile, { schema: 1, role: "mac" }, [engine]).files.find((item) => item.target === ".agents/AGENTS.md");
  if (!file || !("content" in file)) throw new Error("no AGENTS.md");
  return file.content;
}

function homeWith(agentsMd: string | null) {
  const home = temp.make("model-cast-");
  if (agentsMd !== null) {
    mkdirSync(join(home, ".agents"));
    writeFileSync(join(home, ".agents/AGENTS.md"), agentsMd);
  }
  return home;
}

const event = (value: unknown) => async () => (typeof value === "string" ? value : JSON.stringify(value));
const quiet = { code: 0, stdout: "", stderr: "" };
const agentCall = (tool_input: unknown, tool_name = "Agent") => event({ hook_event_name: "PreToolUse", tool_name, tool_input });

describe("name a model", () => {
  test.each(["Agent", "Task"])("sends a Claude %s call without a model back with the Model selection table, and nothing past it", async (tool) => {
    for (const input of [{ prompt: "find the files" }, null]) {
      expect(await nameAModel("claude", agentCall(input, tool), homeWith(instructions))).toEqual({ code: 2, stdout: "", stderr: `${reminder}\n\n${table}\n` });
    }
  });

  test("on a home the engine rendered from several packs, the bounce holds the profile's table and no pack's rules", async () => {
    const agentsMd = renderedInstructions([{ role: "review", work: "Independent assessment of changes", provider: "codex", model: "gpt-6.2-sol", effort: "high" }]);
    expect(agentsMd).toContain("# Memory");
    const result = await nameAModel("claude", agentCall({}), homeWith(agentsMd));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("| Independent assessment of changes | `gpt-6.2-sol` | high |");
    expect(result.stderr.trimEnd().split("\n").at(-1)).toStartWith("|");
    expect(result.stderr).not.toContain("# Memory");
  });

  test("keeps every row when a profile's work text spans lines or holds a pipe", async () => {
    const agentsMd = renderedInstructions([
      { role: "lookup", work: "Lookups:\nfind files | logs\rand more", provider: "claude", model: "claude-haiku-5-5", effort: "medium" },
      { role: "implementation", work: "Build", provider: "codex", model: "gpt-6.2-sol", effort: "high", serviceTier: "fast\npriority" },
    ]);
    const result = await nameAModel("claude", agentCall({}), homeWith(agentsMd));
    expect(result.stderr).toContain("| Lookups: find files \\| logs and more | `claude-haiku-5-5` | medium |");
    expect(result.stderr).toContain("| Build | `gpt-6.2-sol` | high, fast priority tier |");
    expect(result.stderr).toContain("| Review of code Claude wrote | `gpt-6.2-sol` | high |");
  });

  test("names the table's place when the instructions or their table are missing", async () => {
    for (const agentsMd of [null, "# Agent rules\n\nNo table.\n", "## Model selection\n\nThe table moved.\n"]) {
      expect(await nameAModel("claude", agentCall({}), homeWith(agentsMd))).toEqual({ code: 2, stdout: "", stderr: `${reminder} ${pointer}\n` });
    }
  });

  test("lets a call with a model, another tool, Codex, and a broken event through", async () => {
    const home = homeWith(instructions);
    expect(await nameAModel("claude", agentCall({ model: "sonnet" }), home)).toEqual(quiet);
    expect(await nameAModel("claude", agentCall({}, "Bash"), home)).toEqual(quiet);
    expect(await nameAModel("codex", agentCall({}), home)).toEqual(quiet);
    for (const broken of ["not json", "null", "[]", "7"]) expect(await nameAModel("claude", event(broken), home)).toEqual(quiet);
  });
});
