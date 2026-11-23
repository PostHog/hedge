import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { gradeOf } from "./proof-autonomy.ts";
import { isProductionFile, mergeRiskGrade } from "./proof-checkout.ts";
import { prDirectory, readJson, writeJson, type ProofIdentity } from "./proof.ts";

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
  const grade = mergeRiskGrade(body);
  const why = [
    ...["high", "unreadable", "none"].includes(grade) ? [`merge-risk grade ${grade}`] : [],
    ...changedFiles === undefined ? ["changed files unknown"] : [],
    ...criticalPaths instanceof Error ? ["critical-path list unreadable"] : onCriticalPaths(changedFiles ?? [], criticalPaths).map((file) => `critical path: ${file}`),
    ...inDangerAreas(changedFiles ?? []),
  ];
  return { path: why.length ? "strict" : "standard", why };
}

function criticalEntries(list: string) {
  return list.split("\n").map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/`/g, "").trim().split(/\s+/)[0] ?? "")
    .filter((entry) => entry && !entry.startsWith("#"));
}

function onCriticalPaths(files: string[], list: string | undefined) {
  const entries = list ? criticalEntries(list) : [];
  const matches = (file: string, entry: string) => entry.includes("*") ? new Bun.Glob(entry).match(file) : file === entry || file.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
  return files.filter((file) => entries.some((entry) => matches(file, entry)));
}

const inDangerAreas = (files: string[]) =>
  files.filter(isProductionFile).flatMap((file) => dangerAreas.filter(({ pattern }) => pattern.test(file)).map(({ area }) => `${area}: ${file}`));

const prTriagePath = (home: string, identity: ProofIdentity) => join(prDirectory(home, identity), "triage.json");
const roundTriagePath = (directory: string) => join(directory, "triage.json");

export async function recordTriage(home: string, identity: ProofIdentity, directory: string, setting: TriageSetting, path: PathOf): Promise<TriageMark> {
  const arm = armOf(setting, identity.repository, identity.pr);
  await writeFile(prTriagePath(home, identity), JSON.stringify({ setting, arm }) + "\n", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const mark = { arm, ...path };
  await writeJson(roundTriagePath(directory), { commit: identity.commit, ...mark });
  return mark;
}

export async function readTriage(directory: string): Promise<{ triage: TriageMark } | Record<string, never>> {
  const recorded = await readJson<(TriageMark & { commit: string }) | undefined>(roundTriagePath(directory), undefined);
  if (!recorded) return {};
  const { commit: _, ...mark } = recorded;
  return { triage: mark };
}
