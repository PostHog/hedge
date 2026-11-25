import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Hook, HookResult } from "../lib/hook.ts";
import { redactSecrets } from "./secret-guard.ts";

export type { HookResult };
export type RunHook = (path: string, provider: string, input: string) => Promise<HookResult>;

type Specific = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; [key: string]: unknown };
type Decision = { decision?: string; reason?: string; hookSpecificOutput?: Specific };

const strictness = ["allow", "ask", "deny"];

export async function dispatch(dir: string, provider: string, input: string, run: RunHook = runInProcessWithin(engineRoot)): Promise<HookResult> {
  const results: Array<HookResult & { name: string; json?: Decision }> = [];
  for (const name of listHooks(dir)) {
    const result = await run(join(dir, name), provider, input);
    results.push({ ...result, name, json: result.code === 0 ? parseDecision(result.stdout) : undefined });
  }
  const problems = results.filter((result) => result.code !== 0 && result.code !== 2).map((result) => `hedge hook ${result.name}: ${result.stderr.trim() || `exit ${result.code}`}\n`).join("");
  const blockJson = results.find((result) => result.json?.decision === "block")?.json;
  const protect = mergeSpecific(provider, results.flatMap((result) => (result.json?.hookSpecificOutput ? [result.json.hookSpecificOutput] : [])));
  const blocked = results.find((result) => result.code === 2);
  const answer = (decision: Decision): HookResult => ({ code: 0, stdout: `${JSON.stringify(decision)}\n`, stderr: problems });
  if (blockJson) return answer({ ...blockJson, hookSpecificOutput: denying(protect, blockJson.reason ?? "") });
  if (blocked && protect) return answer({ decision: "block", reason: blocked.stderr.trim(), hookSpecificOutput: denying(protect, blocked.stderr.trim()) });
  if (blocked) return { code: 2, stdout: "", stderr: problems + blocked.stderr };
  if (protect) return answer({ ...results.find((result) => result.json?.hookSpecificOutput)!.json, hookSpecificOutput: protect });
  const first = results.find((result) => result.code === 0 && result.stdout.trim());
  return { code: first || !problems ? 0 : 1, stdout: first?.stdout ?? "", stderr: problems };
}

const permissionVerdict = (output: Specific) => (typeof output.decision === "object" && output.decision !== null ? (output.decision as { behavior?: unknown }) : undefined);

function mergeSpecific(provider: string, outputs: Specific[]): Specific | undefined {
  if (outputs.length === 0) return undefined;
  const merged: Specific = Object.assign({}, ...[...outputs].reverse());
  const decided = outputs.filter((output) => strictness.includes(output.permissionDecision ?? ""));
  const strictest = decided.reduce<Specific | undefined>((best, output) => (!best || strictness.indexOf(output.permissionDecision!) > strictness.indexOf(best.permissionDecision!) ? output : best), undefined);
  if (strictest) {
    merged.permissionDecision = strictest.permissionDecision;
    merged.permissionDecisionReason = strictest.permissionDecisionReason;
  }
  if (provider === "codex" && merged.permissionDecision === "ask") {
    merged.permissionDecision = "deny";
    merged.permissionDecisionReason = `This call needs the person's approval, and Codex cannot ask for it here. ${merged.permissionDecisionReason ?? ""}`.trim();
  }
  if (merged.permissionDecision === "deny") delete merged.updatedInput;
  const verdicts = outputs.map(permissionVerdict).filter((verdict) => verdict?.behavior === "allow" || verdict?.behavior === "deny");
  const verdict = verdicts.find((item) => item?.behavior === "deny") ?? verdicts[0];
  if (verdict) merged.decision = verdict;
  if (outputs.some((output) => output.suppressOriginalPrompt === true)) merged.suppressOriginalPrompt = true;
  const contexts = outputs.map((output) => output.additionalContext).filter((context): context is string => typeof context === "string" && context.length > 0);
  if (contexts.length > 0) merged.additionalContext = redactSecrets(contexts.join("\n\n"));
  return merged;
}

function denying(specific: Specific | undefined, reason: string): Specific | undefined {
  if (!specific || (specific.hookEventName !== "PreToolUse" && specific.permissionDecision === undefined)) return specific;
  const kept = specific.permissionDecision === "deny" ? specific.permissionDecisionReason?.trim() : undefined;
  const denied: Specific = { ...specific, permissionDecision: "deny", permissionDecisionReason: reason.trim() || kept || "A Hedge hook blocked this tool call." };
  delete denied.updatedInput;
  return denied;
}

function parseDecision(stdout: string): Decision | undefined {
  try {
    const value = JSON.parse(stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function listHooks(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const engineRoot = resolve(dirname(realpathSync(import.meta.path)), "../../..");

const isInside = (root: string, path: string) => {
  const rest = relative(realpathSync(root), path);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
};

const failure = (error: unknown): HookResult => ({ code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` });

const hookTranspiler = new Bun.Transpiler({ loader: "ts" });

function exportsInProcessHook(source: string) {
  try {
    return hookTranspiler.scan(source).exports.includes("hedgeHook");
  } catch {
    return false;
  }
}

export const runInProcessWithin = (root: string): RunHook => async (path, provider, input) => {
  try {
    const real = realpathSync(path);
    if (!isInside(root, real) || !exportsInProcessHook(readFileSync(real, "utf8"))) return await runWithBun(path, provider, input);
    const { hedgeHook } = (await import(real)) as { hedgeHook?: Hook };
    if (typeof hedgeHook !== "function") return await runWithBun(path, provider, input);
    return await hedgeHook(provider, () => Promise.resolve(input), process.env.HOME ?? homedir());
  } catch (error) {
    return failure(error);
  }
};

async function runWithBun(path: string, provider: string, input: string): Promise<HookResult> {
  const child = Bun.spawn([process.execPath, path, provider], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

if (import.meta.main) {
  const [provider, event] = process.argv.slice(2);
  if ((provider !== "claude" && provider !== "codex") || !event || !/^[A-Za-z]+$/.test(event)) {
    process.stderr.write("Usage: run.sh claude|codex <event>\n");
    process.exit(1);
  }
  const result = await dispatch(join(process.env.HOME ?? homedir(), ".config/hedge/hooks", event), provider, await Bun.stdin.text());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
