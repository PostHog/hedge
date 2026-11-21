import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leanClaude, modelFor, modelTable, type ModelRow } from "./models.ts";

const rows: ModelRow[] = [
  { role: "lookup", work: "Find files", provider: "claude", model: "small-model", effort: "medium" },
  { role: "review", work: "Review Claude's code", provider: "codex", model: "large-model", effort: "high" },
];
const env = { HEDGE_MODELS: JSON.stringify(rows) };

test("reads the row of a role from the model table of the user's plan", () => {
  expect(modelFor("review", env)).toEqual(rows[1]!);
  expect(modelTable(env)).toEqual(rows);
});

test("refuses a role the table lacks, a missing table, and a malformed row", () => {
  expect(() => modelFor("review-codex", env)).toThrow("the model table of your AI plan has no review-codex row");
  expect(() => modelFor("lookup", {})).toThrow("run this command as hedge <command>, so it gets your model table");
  for (const provider of ["", "gemini cli", 3, "a".repeat(65), "constructor", "__proto__"]) expect(() => modelTable({ HEDGE_MODELS: JSON.stringify([{ ...rows[0], provider }]) })).toThrow("HEDGE_MODELS holds a malformed row");
});

test("reads a row of any T3 provider instance", () => {
  const neon: ModelRow = { role: "survey", work: "Read docs", provider: "antigravity", model: "gemini-4-neon", effort: "high" };
  expect(modelFor("survey", { HEDGE_MODELS: JSON.stringify([...rows, neon]) })).toEqual(neon);
  const longest = { ...neon, provider: "p".repeat(64) };
  expect(modelFor("survey", { HEDGE_MODELS: JSON.stringify([longest]) })).toEqual(longest);
});

test("an empty or relative CLAUDE_CONFIG_DIR never lets the checkout under review set a Claude reviewer's env or key helper", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-claude-env-"));
  const previous = process.cwd();
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://hub.example" } }));
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "settings.json"), JSON.stringify({ apiKeyHelper: "reviewed-code-helper", env: { ANTHROPIC_BASE_URL: "https://reviewed-code.example" } }));
    process.chdir(checkout);
    for (const configDir of ["", ".", "./"]) {
      const lean = leanClaude(["claude", "-p"], home, { CLAUDE_CONFIG_DIR: configDir });
      expect(lean.env.ANTHROPIC_BASE_URL).toBe("https://hub.example");
      expect(lean.argv).toEqual(["claude", "-p"]);
    }
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lean Claude call carries the apiKeyHelper of the user's settings, and only the helper command", () => {
  const root = mkdtempSync(join(tmpdir(), "lean-claude-key-"));
  try {
    const home = join(root, "home");
    const configDir = join(root, "config");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(configDir);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "fake-home-helper", model: "unrelated", env: { ANTHROPIC_BASE_URL: "https://hub.example" } }));
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ apiKeyHelper: "fake-config-helper" }));
    expect(leanClaude(["claude", "-p"], home, {}).argv).toEqual(["claude", "--settings", '{"apiKeyHelper":"fake-home-helper"}', "-p"]);
    expect(leanClaude(["claude", "-p"], home, { CLAUDE_CONFIG_DIR: configDir }).argv).toEqual(["claude", "--settings", '{"apiKeyHelper":"fake-config-helper"}', "-p"]);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ apiKeyHelper: 7 }));
    expect(leanClaude(["claude", "-p"], home, { CLAUDE_CONFIG_DIR: configDir }).argv).toEqual(["claude", "-p"]);
    expect(leanClaude(["claude", "-p"], join(root, "no-settings"), {})).toEqual({ argv: ["claude", "-p"], env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
