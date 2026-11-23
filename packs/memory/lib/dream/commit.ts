import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Result } from "../../../hub/lib/coder.ts";
import { onceMoreOnSigningTimeout, signingTimedOut } from "./signing.ts";

type Git = (...args: string[]) => Promise<Result>;
type Hunk = { start: number; count: number; removed: string[]; added: string[] };
export type MemoryChange = { subject: string; why: string; prevalence: string; evidence: string; topics: string; coAuthor?: string; paths: string[] };
export type Committed = { code: number; message: string };

export const commitUsage = 'Usage: hedge dream commit "<Verb>: <memory name>" --why <text> --prevalence <text> --evidence <text> --topics <text> [--co-author "<name> <email>"] <path>...';

const recordFlags = ["--why", "--prevalence", "--evidence", "--topics"];
const valueFlags = [...recordFlags, "--co-author"];
const indexFile = /(^|\/)(MEMORY|INDEX)\.md$/;

export function parseChange(args: string[]): MemoryChange | undefined {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!valueFlags.includes(arg)) {
      if (arg.startsWith("--")) return undefined;
      positionals.push(arg);
      continue;
    }
    const value = args[++index];
    if (value === undefined || /[\r\n]/.test(value)) return undefined;
    values.set(arg, value.trim());
  }
  const [subject, ...paths] = positionals;
  const [why, prevalence, evidence, topics] = recordFlags.map((flag) => values.get(flag));
  if (!subject || !/^[A-Z][a-z]+: \S/.test(subject) || /[\r\n]/.test(subject) || !paths.length) return undefined;
  if (!why || !prevalence || !evidence || !topics) return undefined;
  return { subject, why, prevalence, evidence, topics, coAuthor: values.get("--co-author") || undefined, paths };
}

function messageOf(change: MemoryChange) {
  const trailer = change.coAuthor ? ["", `Co-Authored-By: ${change.coAuthor}`] : [];
  return [change.subject, "", change.why, `Prevalence: ${change.prevalence}`, `Evidence: ${change.evidence}`, `Topics: ${change.topics}`, ...trailer, ""].join("\n");
}

function hunksOf(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      hunks.push({ start: Number(header[1]), count: Number(header[2] ?? 1), removed: [], added: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (hunk && line.startsWith(" ")) throw new Error("git diff printed a context line in a zero-context diff");
    if (line.startsWith("-")) hunk?.removed.push(line.slice(1));
    else if (line.startsWith("+")) hunk?.added.push(line.slice(1));
  }
  return hunks;
}

function withPickedLines(staged: string, hunks: Hunk[], picked: (line: string) => boolean) {
  const lines = staged ? staged.replace(/\n$/, "").split("\n") : [];
  const kept: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const at = hunk.count === 0 ? hunk.start : hunk.start - 1;
    kept.push(...lines.slice(cursor, at));
    const unpicked = hunk.removed.filter((line) => !picked(line));
    for (const line of hunk.added) {
      if (picked(line)) kept.push(line);
      else if (unpicked.length) kept.push(unpicked.shift()!);
    }
    kept.push(...unpicked);
    cursor = at + hunk.count;
  }
  kept.push(...lines.slice(cursor));
  return kept.length ? `${kept.join("\n")}${staged && !staged.endsWith("\n") ? "" : "\n"}` : "";
}

function decoded(target: string) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

const linksIn = (line: string, dir: string) =>
  [...line.matchAll(/\]\((?:<([^>\n]+)>|([^)\s]+))/g)].map((match) => posix.normalize(posix.join(dir, decoded((match[1] ?? match[2]!).split("#")[0]!))));

async function stageIndexLines(must: (...args: string[]) => Promise<string>, scratch: string, index: string, covers: (path: string) => boolean) {
  const picked = (line: string) => linksIn(line, posix.dirname(index)).some(covers);
  const hunks = hunksOf(await must("diff", "-U0", "--inter-hunk-context=0", "--no-color", "--no-ext-diff", "--no-textconv", "--", index));
  if (!hunks.some((hunk) => [...hunk.removed, ...hunk.added].some(picked))) return false;
  const [mode] = (await must("ls-files", "-s", "--", index)).split(" ");
  writeFileSync(scratch, withPickedLines(await must("show", `:${index}`), hunks, picked));
  const blob = (await must("hash-object", "-w", "--no-filters", "--", scratch)).trim();
  await must("update-index", "--cacheinfo", `${mode},${blob},${index}`);
  return true;
}

const throughLinks = (path: string) => (existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : path);

const plural = (paths: string[], one: string, many: string) => `${paths.join(", ")} ${paths.length > 1 ? many : one}`;

export async function commitChange(change: MemoryChange, cwd: string, git: (args: string[]) => Promise<Result>): Promise<Committed> {
  const here = existsSync(cwd) ? realpathSync(cwd) : cwd;
  const toplevel = await git(["-C", here, "rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0) return { code: 1, message: `${here} is not a Git checkout.` };
  const top = toplevel.stdout.trim();
  const g: Git = (...args) => git(["--literal-pathspecs", "-C", top, ...args]);
  const must = async (...args: string[]) => {
    const answer = await g(...args);
    if (answer.code !== 0) throw new Error(`git ${args[0]} failed: ${answer.stderr.trim()}`);
    return answer.stdout;
  };
  const list = async (...args: string[]) => (await must(...args)).split("\0").filter(Boolean);
  const named = change.paths.map((path) => relative(top, throughLinks(resolve(here, path))).split(sep).join("/"));
  const outside = named.filter((path) => !path || path.startsWith("..") || isAbsolute(path));
  if (outside.length) return { code: 1, message: `${plural(outside, "is", "are")} outside the worktree ${top}.` };
  const covers = (path: string) => named.some((name) => path === name || path.startsWith(`${name}/`));

  const unnamedStaged = (await list("diff", "--cached", "--name-only", "-z", "--no-renames", "--ignore-submodules=none")).filter((path) => !covers(path));
  if (unnamedStaged.length) return { code: 1, message: `the index holds staged changes you did not name: ${unnamedStaged.join(", ")}. Name them, or unstage them with git restore --staged.` };
  const unnamedDeleted = (await list("diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none", "--diff-filter=D", "HEAD", "--", ...named)).filter((path) => !named.includes(path));
  if (unnamedDeleted.length) return { code: 1, message: `${plural(unnamedDeleted, "is deleted, and you did not name it", "are deleted, and you did not name them")}. Name each deleted file to commit its deletion.` };
  const changed = [...await list("diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none", "HEAD", "--", ...named), ...await list("ls-files", "-z", "-o", "--exclude-standard", "--", ...named)];
  const unchanged = named.filter((name) => !changed.some((path) => path === name || path.startsWith(`${name}/`)));
  if (unchanged.length) return { code: 1, message: `${plural(unchanged, "has", "have")} no change to commit.` };
  const linksNamed = (index: string) => readFileSync(join(top, index), "utf8").split("\n").some((line) => linksIn(line, posix.dirname(index)).some(covers));
  const newIndexes = (await list("ls-files", "-z", "-o", "--exclude-standard")).filter((path) => indexFile.test(path) && !covers(path) && linksNamed(path));
  if (newIndexes.length) return { code: 1, message: `${plural(newIndexes, "is new and links to a named file", "are new and link to a named file")}. Name it too.` };

  const tracked = await list("ls-files", "-z", "--", ...named);
  const addable = named.filter((name) => existsSync(join(top, name)) || tracked.some((path) => path === name || path.startsWith(`${name}/`)));
  const scratch = (await must("rev-parse", "--path-format=absolute", "--git-path", "hedge-dream-commit")).trim();
  const before = (await must("rev-parse", "HEAD")).trim();
  const staged = (await must("write-tree")).trim();
  const unstage = async () => {
    await g("read-tree", staged);
    await g("update-index", "-q", "--refresh");
  };
  const commit = async () => {
    const answer = await g("commit", "-q", "-F", scratch);
    const landed = answer.code !== 0 && (await must("rev-parse", "HEAD")).trim() !== before;
    return landed ? { code: 0, stdout: "", stderr: "" } : answer;
  };
  try {
    if (addable.length) await must("add", "-A", "--", ...addable);
    for (const index of (await list("diff", "--name-only", "-z", "--no-renames")).filter((path) => indexFile.test(path) && !covers(path))) {
      await stageIndexLines(must, scratch, index, covers);
    }
    writeFileSync(scratch, messageOf(change));
    const committed = await onceMoreOnSigningTimeout(commit);
    if (committed.code !== 0) {
      await unstage();
      const reason = committed.stderr.trim().split("\n").at(-1) ?? "";
      return { code: 1, message: signingTimedOut(committed) ? "signing the commit timed out twice. Commit again." : `git commit failed: ${reason}` };
    }
  } catch (error) {
    await unstage();
    throw error;
  } finally {
    rmSync(scratch, { force: true });
  }
  return { code: 0, message: (await must("log", "-1", "--format=%h %s")).trim() };
}
