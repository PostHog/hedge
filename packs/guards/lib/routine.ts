import { commandsIn, type Command } from "./shell-words.ts";

const printers = new Set(["cd", "echo", "printf", "pwd", "true", "exit", "}"]);
const tmpReaders = new Set(["cat", "head", "tail"]);
const gitSteps = new Set(["add", "commit", "push", "pull", "fetch", "status", "log", "diff", "show", "rev-parse", "ls-remote"]);
const proofSteps = new Set(["gate", "review", "save"]);
const runsAnotherProgram = /^--(?:receive-pack|upload-pack|exec|output|ext-diff)(?:=|$)/;
const tmpPath = /^\/tmp\/[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const duplicate = /^[12]?>&[12]$/;
const intoNowhere = /^(?:&|[12])?>>?\/dev\/null$/;
const intoTmp = /^(?:&|[12])?>>?(\/tmp\/.+)$/;

const insideTmp = (path: string) => tmpPath.test(path) && !path.split("/").includes("..");

function quiet(redirect: string): boolean {
  if (duplicate.test(redirect) || intoNowhere.test(redirect)) return true;
  const target = intoTmp.exec(redirect)?.[1];
  return target !== undefined && insideTmp(target);
}

const readsOnlyTmp = (args: string[]) => args.every((arg) => arg.startsWith("-") || /^\d+$/.test(arg) || insideTmp(arg));

function gitStep(args: string[]): boolean {
  let at = 0;
  while (args[at] === "-C") at += 2;
  return gitSteps.has(args[at] ?? "") && !args.some((arg) => runsAnotherProgram.test(arg));
}

function knownStep({ name, args }: Command): boolean {
  const [first, second = ""] = args;
  if (printers.has(name)) return true;
  if (tmpReaders.has(name)) return readsOnlyTmp(args);
  if (name === "git") return gitStep(args);
  if (name === "hedge" || name === "fleet") return first === "proof" && proofSteps.has(second);
  return name === "gh" && first === "run" && second === "watch";
}

function plain(command: Command): boolean {
  const ownName = command.bare[0] === command.name;
  const onlyGroups = [...command.rawPrefix, ...command.keywords].every((word) => word === "{");
  return ownName && onlyGroups && command.redirects.every(quiet);
}

/** Whether every command in a shell program is a push, commit, gate or CI watch, a read-only git step, or prints to the
 * agent, nested programs included: no other program, wrapper, variable prefix or file write outside /tmp. */
export function onlyRoutineSteps(program: string): boolean {
  try {
    const commands = commandsIn(program);
    return commands.length > 0 && commands.every((command) => plain(command) && knownStep(command));
  } catch {
    return false;
  }
}
