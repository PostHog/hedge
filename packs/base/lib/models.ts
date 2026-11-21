import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

type Env = Record<string, string | undefined>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRow = { role: string; work: string; provider: string; model: string; effort: Effort; serviceTier?: string };

const efforts = ["low", "medium", "high", "xhigh", "max"];
const reservedKeys = ["constructor", "prototype", "__proto__"];
const isT3Slug = (value: unknown) => typeof value === "string" && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !reservedKeys.includes(value);

export function modelTable(env: Env = Bun.env): ModelRow[] {
  if (!env.HEDGE_MODELS) throw new Error("run this command as hedge <command>, so it gets your model table");
  const rows = JSON.parse(env.HEDGE_MODELS) as unknown;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error("HEDGE_MODELS holds a malformed row");
  return rows;
}

export function modelFor(role: string, env: Env = Bun.env): ModelRow {
  const row = modelTable(env).find((candidate) => candidate.role === role);
  if (!row) throw new Error(`the model table of your AI plan has no ${role} row`);
  return row;
}

function isRow(value: unknown): value is ModelRow {
  const row = value as Partial<ModelRow>;
  return typeof row?.role === "string" && typeof row.model === "string" && typeof row.work === "string"
    && isT3Slug(row.provider) && efforts.includes(row.effort as string) && (row.serviceTier === undefined || typeof row.serviceTier === "string");
}

export function cliRow(row: ModelRow, command: string) {
  if (row.provider === "claude" || row.provider === "codex") return undefined;
  return `${command} with the claude or codex CLI, and the ${row.role} row names provider ${row.provider}. Give that row a Claude or Codex model.`;
}

export function modelSessionEnv(env: Record<string, string | undefined>) {
  const { T3CODE_THREAD_ID: _lane, ...rest } = env;
  return rest;
}

export function leanClaude(argv: string[], home: string, env: Env): { argv: string[]; env: Env } {
  // Only an absolute config dir counts: an empty or relative one would read settings from the checkout under review.
  const configured = env.CLAUDE_CONFIG_DIR;
  const path = join(configured && isAbsolute(configured) ? configured : join(home, ".claude"), "settings.json");
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { env?: Env; apiKeyHelper?: unknown } : {};
  const [binary = "claude", ...rest] = argv;
  const keyHelper = typeof settings.apiKeyHelper === "string" ? ["--settings", JSON.stringify({ apiKeyHelper: settings.apiKeyHelper })] : [];
  return { argv: [binary, ...keyHelper, ...rest], env: { ...env, ...settings.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } };
}
