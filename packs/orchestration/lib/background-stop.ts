export type BackgroundTask = { id?: string; type?: string; status?: string };

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string };
type TurnLine = { message?: { content?: unknown }; toolUseResult?: { backgroundTaskId?: unknown } };

export const backgroundReason = (ids: string[], person: string) => `Hedge blocked this stop: background task ${ids.join(", ")} started this turn and still runs, `
  + "and nothing waits on it, so its result lands after the turn and nobody acts on it. "
  + `Call t3_background_wait with taskIds ${JSON.stringify(ids)}, then end the turn; T3 wakes this thread when it ends. `
  + "If the task is a server meant to outlive the turn, end the turn again. "
  + `If you are not sure, stop and ask ${person}.`;

const blocks = (line: TurnLine): Block[] => (Array.isArray(line.message?.content) ? (line.message.content as Block[]) : []);
const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((block: Block) => block?.text ?? "").join("\n") : "";
const isBackgroundWait = (name = "") => /^mcp__t3[-_]code__t3_background_wait$/.test(name);

function parse(raw: string): TurnLine | undefined {
  try {
    return JSON.parse(raw) as TurnLine;
  } catch {
    return undefined;
  }
}

export function unwaitedBackgroundTasks(turn: string[], inFlight: BackgroundTask[] | undefined): string[] {
  const running = new Set((inFlight ?? []).filter((task) => task.type === "shell" && ["running", "pending"].includes(task.status ?? "")).map((task) => task.id));
  const launches = new Set<string>();
  const started: string[] = [];
  const waited = new Set<string>();
  for (const line of turn.map(parse)) {
    if (!line) continue;
    for (const block of blocks(line)) {
      if (block.type === "tool_use" && block.name === "Bash" && block.input?.run_in_background === true && block.id) launches.add(block.id);
      if (block.type === "tool_use" && isBackgroundWait(block.name) && Array.isArray(block.input?.taskIds)) for (const id of block.input.taskIds) waited.add(String(id));
      if (block.type !== "tool_result" || !launches.has(block.tool_use_id ?? "")) continue;
      const id = line.toolUseResult?.backgroundTaskId ?? /running in background with ID: (\w+)/.exec(resultText(block.content))?.[1];
      if (id) started.push(String(id));
    }
  }
  return started.filter((id) => running.has(id) && !waited.has(id));
}
