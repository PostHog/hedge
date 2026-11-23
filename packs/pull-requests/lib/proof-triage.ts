import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { gradeOf } from "./proof-autonomy.ts";
import { riskCalloutOf } from "./decision-ledger.ts";
import { isProductionFile, mergeRiskGrade } from "./proof-checkout.ts";
import { prDirectory, readJson, type ProofIdentity } from "./proof.ts";

export const triageSettings = ["off", "split", "on"] as const;
export type TriageSetting = (typeof triageSettings)[number];
export type Arm = "treated" | "control";
export type ReviewPath = "strict" | "standard" | "excluded";
export type PathOf = { path: ReviewPath; why: string[] };
export type TriageMark = { arm: Arm } & PathOf;

export const dangerAreas: { area: string; pattern: RegExp }[] = [
  { area: "guards", pattern: /guard/i },
  { area: "redaction", pattern: /redact|secret|scrub|sanitiz|mask/i },
  { area: "auth and permissions", pattern: /auth|permission|access|acl|rbac|role|credential|token|session|login|sign-?in|sso|password/i },
  { area: "parsers of untrusted input", pattern: /pars(e|er|ing)|deserializ|decod|webhook|ingest|upload|import/i },
  { area: "sends", pattern: /send|mail|notif|deliver|dispatch|outbox|sms|slack/i },
  { area: "migrations", pattern: /migrat|schema|\.sql$/i },
  { area: "data writes", pattern: /writ(e|er|ing)|persist|stor(e|age)|repositor|ledger|database|(^|[/_.-])db([/_.-]|$)|insert|upsert|delete/i },
];

export function triageSetting(env: Record<string, string | undefined>): TriageSetting {
  const value = optionalStringSetting("pull-requests.triage", env) ?? "off";
  if (!(triageSettings as readonly string[]).includes(value)) throw new Error(`pull-requests.triage is ${value}. Use off, split, or on`);
  return value as TriageSetting;
}

export function armOf(setting: TriageSetting, repository: string, pr: number): Arm {
  if (setting !== "split") return setting === "on" ? "treated" : "control";
  const hash = createHash("sha256").update(`${repository.toLowerCase()}#${pr}`).digest();
  return hash[0]! % 2 === 0 ? "treated" : "control";
}

export type PathInput = { body: string | undefined; changedFiles: string[] | undefined; criticalPaths: string | undefined | Error };

export function pathOf({ body, changedFiles, criticalPaths }: PathInput): PathOf {
  if (gradeOf(body).oneWay) return { path: "excluded", why: ["one-way door"] };
  const grade = body !== undefined && riskCalloutOf(body) === undefined ? "none" : mergeRiskGrade(body);
  const why = [
    ...["high", "unreadable", "none"].includes(grade) ? [`merge-risk grade ${grade}`] : [],
    ...changedFiles === undefined ? ["changed files unknown"] : [],
    ...criticalPaths instanceof Error ? ["critical-path list unreadable"] : onCriticalPaths(changedFiles ?? [], criticalPaths).map((file) => `critical path: ${file}`),
    ...inDangerAreas(changedFiles ?? []),
  ];
  return { path: why.length ? "strict" : "standard", why };
}

const pathLike = /[/.*]/;
const cleanEntry = (word: string) => word.replace(/^[\s"'(\[]+|[\s"'),:;\]]+$/g, "").replace(/^\.?\//, "");

function criticalEntries(list: string) {
  const quoted = [...list.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  const unquoted = list.replace(/`[^`\n]+`/g, " ");
  const cells = unquoted.split("\n").flatMap((line) => line.includes("|") ? line.split("|").map((cell) => cell.trim()) : []);
  const words = [...cells, ...unquoted.split(/[\s|]+/)];
  const listed = list.split("\n").flatMap((line) => /^\s*(?:[-*+]|\d+[.)])\s+([^\s`]+)/.exec(line)?.[1] ?? []);
  return [...quoted, ...words.filter((word) => pathLike.test(word)), ...listed].map(cleanEntry).filter(Boolean);
}

function matchesEntry(file: string, entry: string) {
  const directory = entry.replace(/\/\*\*?$|\/$/, "");
  if (directory !== entry || !entry.includes("*")) return file === directory || file.startsWith(`${directory}/`);
  return new Bun.Glob(entry).match(file);
}

function onCriticalPaths(files: string[], list: string | undefined) {
  const entries = list ? criticalEntries(list) : [];
  return files.filter((file) => entries.some((entry) => matchesEntry(file, entry)));
}

const inDangerAreas = (files: string[]) =>
  files.filter(isProductionFile).flatMap((file) => dangerAreas.filter(({ pattern }) => pattern.test(file)).map(({ area }) => `${area}: ${file}`));

const prTriagePath = (home: string, identity: ProofIdentity) => join(prDirectory(home, identity), "triage.json");
const savedArm = async (home: string, identity: ProofIdentity) => (await readJson<{ arm?: Arm } | undefined>(prTriagePath(home, identity), undefined))?.arm;

export async function armFor(home: string, identity: ProofIdentity, setting: TriageSetting): Promise<Arm> {
  const arm = armOf(setting, identity.repository, identity.pr);
  await mkdir(prDirectory(home, identity), { recursive: true, mode: 0o700 });
  try { await writeFile(prTriagePath(home, identity), JSON.stringify({ setting, arm }) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await savedArm(home, identity)) ?? arm;
  }
  return arm;
}

export async function readTriage(directory: string): Promise<{ triage: TriageMark } | Record<string, never>> {
  const triage = (await readJson<{ triage?: TriageMark } | undefined>(join(directory, "round.json"), undefined))?.triage;
  return triage ? { triage } : {};
}
