import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { commandsIn, type Command } from "./shell-words.ts";

type Spec = { flag?: (arg: string) => boolean; valued?: Record<string, (value: string) => boolean>; operands: (operands: string[]) => boolean };

const expands = /[$`]/;
const anyText = () => true;
const number = (value: string) => /^[+-]?\d+$/.test(value);
const remoteName = /^[A-Za-z0-9][\w-]*$/;
const refName = /^(?![-.])[\w./@^~-]+$/;
const refspec = /^(?![-.])[\w./@-]+(?::[\w./@-]+)?$/;
const lease = /^[\w./-]+(?::[0-9a-f]{4,40})?$/;
const tmpPath = /^\/tmp\/[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const duplicate = /^[12]?>&[12]$/;
const intoNowhere = /^(?:&|[12])?>>?\/dev\/null$/;
const intoFile = /^(?:&|[12])?>>?(.+)$/;
const flags = (...names: string[]) => (arg: string) => names.includes(arg);
const plainPaths = (operands: string[]) => operands.every((operand) => !operand.startsWith("-"));
const toRemote = (rest: RegExp) => (operands: string[]) => operands.length === 0 || (remoteName.test(operands[0]!) && operands.slice(1).every((operand) => rest.test(operand)));

function staysInTmp(path: string): boolean {
  if (!tmpPath.test(path) || path.split("/").includes("..")) return false;
  const root = realpathSync("/tmp");
  let current = root;
  for (const part of path.split("/").slice(2)) {
    current = join(current, part);
    let link: boolean;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch {
      return true;
    }
    if (!link) continue;
    try {
      current = realpathSync(current);
    } catch {
      return false;
    }
    if (!current.startsWith(`${root}/`)) return false;
  }
  return true;
}

const tmpFiles = (operands: string[]) => operands.length > 0 && operands.every(staysInTmp);

const gitSpecs: Record<string, Spec> = {
  add: { flag: flags("-A", "--all", "-u", "--update"), operands: plainPaths },
  commit: {
    flag: flags("-a", "--all", "-q", "--quiet", "--no-edit", "--amend", "-s", "--signoff"),
    valued: { "-m": anyText, "--message": anyText, "-am": anyText, "-F": (file) => file === "-" || staysInTmp(file), "--file": (file) => file === "-" || staysInTmp(file) },
    operands: plainPaths,
  },
  push: { flag: flags("-u", "--set-upstream", "-q", "--quiet", "--force-with-lease"), valued: { "--force-with-lease": (value) => lease.test(value) }, operands: toRemote(refspec) },
  fetch: { flag: flags("-q", "--quiet", "-p", "--prune"), operands: toRemote(refspec) },
  status: { flag: flags("-s", "--short", "-b", "--branch", "-sb", "--porcelain", "--porcelain=v1", "--porcelain=v2"), operands: plainPaths },
  "rev-parse": { flag: flags("--short", "--abbrev-ref", "--show-toplevel", "--verify", "-q", "--quiet"), operands: (operands) => operands.every((operand) => refName.test(operand)) },
};

const readerSpecs: Record<string, Spec> = {
  cat: { operands: tmpFiles },
  head: { flag: (arg) => /^-\d+$/.test(arg) || arg === "-q", valued: { "-n": number, "-c": number }, operands: tmpFiles },
  tail: { flag: (arg) => /^-\d+$/.test(arg) || arg === "-q", valued: { "-n": number, "-c": number }, operands: tmpFiles },
};

function fits(args: string[], spec: Spec): boolean {
  const operands: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    if (spec.flag?.(arg)) continue;
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const accepts = spec.valued?.[name];
    const value = equals > 0 ? arg.slice(equals + 1) : args[++at];
    if (!accepts || value === undefined || !accepts(value)) return false;
  }
  return spec.operands(operands);
}

function gitStep(args: string[]): boolean {
  let at = 0;
  while (args[at] === "-C" && /^\/[\w./@+-]*$/.test(args[at + 1] ?? "")) at += 2;
  const spec = gitSpecs[args[at] ?? ""];
  return spec !== undefined && fits(args.slice(at + 1), spec);
}

function knownStep({ name, args, stdin }: Command): boolean {
  const [first, second = ""] = args;
  if (["cd", "pwd", "true", "exit", "}"].includes(name)) return true;
  if (name === "echo" || name === "printf") return true;
  if (name === "cat" && stdin && args.length === 0) return true;
  if (name in readerSpecs) return fits(args, readerSpecs[name]!);
  if (name === "git") return gitStep(args);
  if (name === "hedge" || name === "fleet") return first === "proof" && ["gate", "review"].includes(second);
  return name === "gh" && first === "run" && second === "watch";
}

function quiet(redirect: string): boolean {
  if (duplicate.test(redirect) || intoNowhere.test(redirect)) return true;
  const target = intoFile.exec(redirect)?.[1]?.replace(/^(["'])([^"'\\]*)\1$/, "$2");
  return target !== undefined && staysInTmp(target);
}

function withoutSubstitutions(arg: string, substitutions: string[]): string {
  return substitutions.reduce((rest, inner) => rest.replace(`$(${inner})`, "").replace(`\`${inner}\``, ""), arg);
}

function literal(command: Command): boolean {
  const args = command.args.every((arg, at) => !expands.test(withoutSubstitutions(arg, command.argSubstitutions[at] ?? [])));
  const stdin = command.stdin === undefined || command.stdin.literal === true || !expands.test(command.stdin.body);
  return args && stdin;
}

function plain(command: Command): boolean {
  const ownName = command.bare[0] === command.name;
  const onlyGroups = [...command.rawPrefix, ...command.keywords].every((word) => word === "{");
  return ownName && onlyGroups && literal(command) && command.redirects.every(quiet);
}

/** Whether every command in a shell program, nested ones included, is one of a fixed set of routine steps: a commit, or a
 * push, fetch or status of a named remote, with only the options listed here; a proof gate or review; a CI watch; or
 * printing, with reads and writes only of files that stay under /tmp. No other program, option, wrapper, variable prefix,
 * expansion, or remote URL. */
export function onlyRoutineSteps(program: string): boolean {
  try {
    const commands = commandsIn(program);
    return commands.length > 0 && commands.every((command) => plain(command) && knownStep(command));
  } catch {
    return false;
  }
}
