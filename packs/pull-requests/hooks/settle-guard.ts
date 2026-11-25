import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { guardSettle, liveDeps, type ToolCall } from "../lib/organize-guard.ts";

export { guardSettle, personName, type SettleDeps } from "../lib/organize-guard.ts";

export const hook: Hook = async (_provider, readInput, home) => {
  const call = await readInput().then((text) => JSON.parse(text) as ToolCall).catch((): ToolCall => ({}));
  return printing(await guardSettle(call, home, liveDeps()));
};

export { hook as hedgeHook };

if (import.meta.main) await runHook(hook);
