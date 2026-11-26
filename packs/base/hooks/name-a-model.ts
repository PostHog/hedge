import { blocking, type Hook, quiet, runHook } from "../lib/hook.ts";
import { modelSelection } from "../lib/model-selection.ts";

const reminder = "Name a model on this Agent call: an omitted model inherits the parent model. Agent takes haiku, sonnet, opus, or fable; a row with a GPT model runs on Codex, through T3's `delegate_task`.";
const pointer = "Cast it with the model table in ~/.agents/AGENTS.md.";

type ToolEvent = { tool_name?: unknown; tool_input?: { model?: unknown } | null };

export const hook: Hook = async (provider, readInput, home) => {
  if (provider !== "claude") return quiet;
  let event: unknown;
  try {
    event = JSON.parse(await readInput());
  } catch {
    return quiet;
  }
  if (typeof event !== "object" || event === null) return quiet;
  const { tool_name, tool_input } = event as ToolEvent;
  if (typeof tool_name !== "string" || !/^(Agent|Task)$/.test(tool_name) || tool_input?.model) return quiet;
  const table = modelSelection(home);
  return blocking(table ? `${reminder}\n\n${table}` : `${reminder} ${pointer}`);
};

export { hook as hedgeHook };

if (import.meta.main) await runHook(hook);
