import { basename } from "node:path";
import { commandsIn, nestedProgramsAt, parse, type Command, type Scope } from "./shell-words.ts";

type Fix = { exitAt: number; groupAt?: number };
type Finding = { what: string; how: string; fix?: Fix };
type Reach = "exit" | { printedBy: number } | { how: string; fix?: Fix };
type Program = { commands: Command[]; depths: number[] };

const maxNesting = 8;
const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const xargsValueOptions = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--process-slot-var", "--replace"]);
const openers = new Set(["{", "if", "while", "until"]);
const headers = new Set(["for", "select", "case"]);
const closers = new Set(["}", "fi", "done", "esac"]);
const separators = new Set([undefined, ";", "\n"]);
const statusRead = String.raw`\$(?:\?|\{\?\})`;
const plainWord = new RegExp(String.raw`^(?:[\w=:,./+%@-]|'[^'\\]*'|"(?:[^$\\"']|${statusRead})*"|${statusRead})*$`);
const failingCode = /^(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/;
const printsToTheAgent = /^(?:2>&1|1?>&2)$/;
const shellChangers = new Set(["exec", "enable", "alias", "shopt", "function", "eval", "source", ".", "trap", "setopt", "unsetopt", "emulate"]);
const traps = new Set(["trap"]);

function gitSubcommandAt(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    if (gitValueOptions.has(args[index])) index++;
    else if (!args[index].startsWith("-")) return index;
  }
  return args.length;
}

function xargsCommand(args: string[]): { what: string; rest: string[] } | undefined {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "--") {
      index++;
      break;
    }
    index += xargsValueOptions.has(args[index]) ? 2 : 1;
  }
  const [name, ...rest] = args.slice(index);
  return name === undefined ? undefined : statusMatters(basename(name), rest);
}

function statusMatters(name: string, args: string[]): { what: string; rest: string[] } | undefined {
  const [first, second, ...rest] = args;
  if ((name === "hedge" || name === "fleet") && first === "proof" && ["gate", "review", "save"].includes(second ?? "")) return { what: `${name} proof ${second}`, rest };
  if (name === "git") {
    const at = gitSubcommandAt(args);
    return args[at] === "push" || args[at] === "commit" ? { what: `git ${args[at]}`, rest: args.slice(at + 1) } : undefined;
  }
  if (name === "gh" && first === "pr" && (second === "ready" || second === "merge")) return { what: `gh pr ${second}`, rest };
  if (name === "gh" && first === "run" && second === "watch" && rest.includes("--exit-status")) return { what: "gh run watch --exit-status", rest };
  if (name === "xargs") return xargsCommand(args);
  return undefined;
}

function guardedName({ name, args }: Command): string | undefined {
  const found = statusMatters(name, args);
  const asksHelp = found?.rest.length === 1 && (found.rest[0] === "--help" || found.rest[0] === "-h");
  return asksHelp ? undefined : found?.what;
}

const parens = (scope: Scope): number => (scope.parent ? 1 + parens(scope.parent) : 0);

function depthsOf(commands: Command[]): number[] {
  let level = 0;
  return commands.map((command) => {
    level += command.keywords.filter((word) => openers.has(word)).length;
    if (closers.has(command.name)) level = Math.max(0, level - 1);
    const depth = level + parens(command.scope);
    if (headers.has(command.name)) level++;
    return depth;
  });
}

function setting(program: Program, before: number, read: (args: string[]) => boolean | undefined): boolean {
  const { commands, depths } = program;
  let on = false;
  let undoneLater = false;
  commands.slice(0, before).forEach((command, index) => {
    if (parens(command.scope) > 0) return;
    if (command.definesFunction || command.name === "function") undoneLater = true;
    if (named(command, shellChangers)) on = false;
    if (command.name !== "set") return;
    const alwaysRuns = depths[index] === 0 && command.keywords.length === 0 && !["|", "&&", "||"].includes(commands[index - 1]?.after ?? "");
    const value = read(command.args);
    const inForeground = () => command.after !== "|" && commands[listEnd(program, index, 0)].after !== "&";
    if (value === false) on = false;
    else if (value === true && alwaysRuns && command.redirects.length === 0 && inForeground()) on = true;
  });
  return on && !undoneLater;
}

const setsOption = (option: string) => (args: string[]) => {
  let on: boolean | undefined;
  args.forEach((arg, index) => {
    const flag = args[index - 1] ?? "";
    if (arg === option && /^[-+][A-Za-z]*o$/.test(flag)) on = flag.startsWith("-");
  });
  return on;
};

function statusReads(raw: string): number | undefined {
  if (!plainWord.test(raw)) return undefined;
  return raw.replace(/'[^']*'/g, "").match(new RegExp(statusRead, "g"))?.length ?? 0;
}

function reporter(command: Command | undefined, reachable: boolean, failingExit: boolean): "exit" | "printed" | undefined {
  if (!command || !reachable || command.keywords.length > 0 || command.rawPrefix.length > 0 || command.after === "|" || command.substitutions.length > 0) return undefined;
  const words = command.rawArgs.map(statusReads);
  if (words.some((word) => word === undefined)) return undefined;
  const statusCount = words.reduce((sum: number, word) => sum + (word ?? 0), 0);
  if (command.name === "exit") {
    if (command.redirects.length > 0 || words.length > 1) return undefined;
    const [raw] = command.rawArgs;
    if (raw === undefined) return "exit";
    if (failingExit && failingCode.test(command.args[0])) return "exit";
    return statusCount === 1 && ["", '""'].includes(raw.replace(new RegExp(statusRead), "")) ? "exit" : undefined;
  }
  const printed = command.name === "echo" && statusCount > 0;
  return printed && command.redirects.every((redirect) => printsToTheAgent.test(redirect)) ? "printed" : undefined;
}

function statementEnd({ commands, depths }: Program, start: number, depth: number): number {
  if (depths[start] <= depth && !headers.has(commands[start].name)) return start;
  const outside = depths.findIndex((each, index) => index > start && each <= depth);
  if (outside < 0) return commands.length - 1;
  return closers.has(commands[outside].name) && depths[outside] === depth ? outside : outside - 1;
}

function pipelineEnd(program: Program, start: number, depth: number): number {
  let end = statementEnd(program, start, depth);
  while (program.commands[end].after === "|" && end + 1 < program.commands.length) end = statementEnd(program, end + 1, depth);
  return end;
}

function listEnd(program: Program, start: number, depth: number): number {
  let end = pipelineEnd(program, start, depth);
  while (["&&", "||"].includes(program.commands[end].after ?? "") && end + 1 < program.commands.length) end = pipelineEnd(program, end + 1, depth);
  return end;
}

function closesOnly({ commands, depths }: Program, end: number, depth: number): boolean {
  if (!separators.has(commands[end].after) && commands[end].after !== ";;") return false;
  return commands.slice(end + 1).every((command, offset) => closers.has(command.name) && command.name !== "done" && depths[end + 1 + offset] < depth && separators.has(command.after));
}

const changedPrinting = "a command earlier in the call that changes how the shell prints, such as `exec >`,";
const separatorName = (after: string | undefined) => (after === "\n" ? "the next line after it" : `the \`${after}\` after it`);

function reachOf(program: Program, start: number): Reach {
  const { commands, depths } = program;
  const depth = depths[start];
  const reachable = (index: number) => depths[index] === depth && commands[listEnd(program, index, depth)].after !== "&";
  const reportedBy = (index: number, failingExit: boolean): Reach | undefined => {
    const found = reporter(commands[index], reachable(index), failingExit);
    if (found === "exit" && changesHowItPrints(commands.slice(0, index), commands[index])) return { how: changedPrinting };
    return found === "printed" ? { printedBy: index } : found;
  };
  let end = pipelineEnd(program, start, depth);
  const pipeEnd = end;
  if (end !== start && !setting(program, start, setsOption("pipefail"))) return { how: "a pipe" };
  if (depth > 0) return closesOnly(program, end, depth) || exitGroup(program, start, end) ? "exit" : { how: "the group or loop it runs in" };
  while (commands[end].after === "&&" && end + 1 < commands.length) end = pipelineEnd(program, end + 1, depth);
  const after = commands[end].after;
  const next = end + 1;
  if (after === undefined) return "exit";
  if (after === "&") return { how: "running it in the background with `&`" };
  if (after === "||") return reportedBy(next, true) ?? { how: "the `||` after it" };
  return reportedBy(next, false) ?? { how: separatorName(after), fix: exitFix(commands, start, pipeEnd) };
}

const stopsShell = ({ bare, rawPrefix, stdin, redirects, scope }: Command) => bare.join(" ") === "exit" && rawPrefix.length === 0 && stdin === undefined && redirects.length === 0 && parens(scope) === 0;

const pipelineStart = (commands: Command[], index: number): number => (index > 0 && commands[index - 1].after === "|" ? pipelineStart(commands, index - 1) : index);
function exitFix(commands: Command[], start: number, pipeEnd: number): Fix | undefined {
  const { after, afterAt } = commands[pipeEnd];
  if (after === undefined || afterAt === undefined || !(separators.has(after) || after === "&&")) return undefined;
  const before = commands[start - 1];
  if (start !== pipeEnd || before?.after === "|") return undefined;
  if (!["&&", "||"].includes(before?.after ?? "")) return { exitAt: afterAt };
  return before.afterAt === undefined ? undefined : { exitAt: afterAt, groupAt: before.afterAt + 2 };
}
function exitGroup(program: Program, start: number, end: number): boolean {
  const { commands, depths } = program;
  const first = pipelineStart(commands, start);
  const [exit, closer] = [commands[end + 1], commands[end + 2]];
  const opensHere = depths[first] === 1 && commands[first].keywords.join(" ") === "{";
  const closesAfterExit = exit !== undefined && stopsShell(exit) && exit.after === ";" && closer?.bare.join(" ") === "}" && closer.rawPrefix.length === 0;
  if (!opensHere || commands[end].after !== "||" || !closesAfterExit || closer.after === "|") return false;
  return commands[listEnd(program, end + 2, 0)].after !== "&" && !changesHowItPrints(commands.slice(0, end + 1), exit);
}

const named = (command: Command, names: Set<string>) => [command.name, ...command.prefix].some((word) => names.has(word));
const setsIfs = (command: Command) => command.env.has("IFS") || [...command.rawArgs, ...command.args].some((word) => word.includes("IFS"));
const readsUnquoted = (command: Command) => command.rawArgs.some((raw) => new RegExp(statusRead).test(raw.replace(/'[^']*'|"[^"]*"/g, "")));
const inThisShell = (commands: Command[]) => commands.filter((command) => parens(command.scope) === 0);

function changesHowItPrints(commands: Command[], reporter: Command): boolean {
  return inThisShell(commands).some((command) => command.definesFunction || named(command, shellChangers) || (readsUnquoted(reporter) && setsIfs(command)));
}

function hiddenIn(text: string, nesting: number): { found?: Finding; carries?: string } {
  if (nesting > maxNesting) throw new Error(`it nests more than ${maxNesting} shell programs`);
  const pipelines = parse(text);
  const guarded: (string | undefined)[] = [];
  for (const pipeline of pipelines) {
    for (const [index, command] of pipeline.entries()) {
      let what = guardedName(command);
      for (const inner of nestedProgramsAt(pipeline, index)) {
        const { found, carries } = hiddenIn(inner.program, nesting + 1);
        if (found) return { found };
        if (!carries) continue;
        const passesOn = !inner.substituted || (command.name === "" && command.substitutions.length === 1 && command.processSubstitutions.length === 0);
        if (!passesOn) return { found: { what: carries, how: "the `$(…)` substitution it runs in" } };
        what ??= carries;
      }
      guarded.push(what);
    }
  }
  const commands = pipelines.flat();
  const program = { commands, depths: depthsOf(commands) };
  let carries: string | undefined;
  for (const [index, command] of commands.entries()) {
    const what = guarded[index];
    if (!what || command.tested) continue;
    if (inThisShell(commands.slice(0, index)).some((each) => named(each, traps))) return { found: { what, how: "a `trap` earlier in the call" } };
    const reach = reachOf(program, index);
    if (reach !== "exit" && "how" in reach) return { found: { what, how: reach.how, fix: nesting === 0 ? reach.fix : undefined } };
    if (reach !== "exit" && nesting > 0) return { found: { what, how: "the nested shell or `$(…)` that prints it" } };
    if (reach !== "exit" && changesHowItPrints(commands.slice(0, reach.printedBy), commands[reach.printedBy])) return { found: { what, how: changedPrinting } };
    carries ??= what;
  }
  return { carries };
}

export const exitMaskReason = (what: string, how: string, person: string) => `Hedge blocked this command: ${how} hides the exit status of \`${what}\`, `
  + "so a failure reads as a success. These forms pass: run it alone or as the last command; chain the next step with `&&`; "
  + "end it with `|| exit` before the next step; "
  + `print its status on the next command, as in \`${what} … > /tmp/out.log 2>&1; echo "exit=$?"; cat /tmp/out.log\`; `
  + "for a pipe, start with `set -o pipefail;`. In place of a loop or group, write one command per item, joined with `&&`. "
  + "`set -e` does not count: the shell ignores it inside an `&&` list, and Claude Code runs each command in one. "
  + "A call with only `--help` or `-h` after the command passes too. "
  + `If you are not sure, stop and ask ${person}.`;

export function exitMaskRisk(command: string, person: string): string | undefined {
  const { found } = hiddenIn(command, 0);
  return found && exitMaskReason(found.what, found.how, person);
}

const maxRewrites = 64;
function exitingAt(text: string, at: number, groupAt: number | undefined): string {
  const spaced = /\s/.test(text[at - 1] ?? " ") ? "" : " ";
  const after = text[at] === "#" || text[at] === "&" ? " " : "";
  const exited = `${text.slice(0, at)}${spaced}|| exit${groupAt === undefined ? "" : "; }"}${after}${text.slice(at)}`;
  if (groupAt === undefined) return exited;
  return `${exited.slice(0, groupAt)} {${/\s/.test(exited[groupAt] ?? "") ? "" : " "}${exited.slice(groupAt)}`;
}

export function exitMaskRewrite(command: string): string | undefined {
  let text = command;
  try {
    if (commandsIn(command).some((each) => each.name === "function" || each.keywords.includes("!"))) return undefined;
    for (let step = 0; step < maxRewrites; step++) {
      const { found } = hiddenIn(text, 0);
      if (!found) return step === 0 ? undefined : text;
      if (!found.fix) return undefined;
      text = exitingAt(text, found.fix.exitAt, found.fix.groupAt);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
