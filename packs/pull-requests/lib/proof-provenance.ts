import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type Provenance = { commit: string; exitCode: 0; startedAt: string; finishedAt: string; cwd: string };
export type RunRecord = { command: string[]; provenance?: Provenance };

const sha = /^[0-9a-f]{40}$/;

export const runRecordPath = (pullRequest: string, commit: string, kind: string, digest: string) => join(pullRequest, "runs", commit, kind, `${digest}.json`);

const isCommand = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string");
const isInstant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
const provenanceFields = ["commit", "exitCode", "startedAt", "finishedAt", "cwd"] as const;

function provenanceOf(record: Record<string, unknown>, commit: string): Provenance | undefined | false {
  if (!provenanceFields.some((field) => field in record)) return undefined;
  const { commit: recorded, exitCode, startedAt, finishedAt, cwd } = record;
  const valid = recorded === commit && exitCode === 0 && isInstant(startedAt) && isInstant(finishedAt) && Date.parse(startedAt) <= Date.parse(finishedAt) && typeof cwd === "string";
  return valid ? { commit, exitCode: 0, startedAt, finishedAt, cwd } : false;
}

export async function runRecordOf(evidence: string, bytes?: Buffer): Promise<RunRecord | undefined> {
  const match = /^([0-9a-f]{64})\.log$/.exec(basename(evidence));
  const kindDirectory = dirname(evidence);
  const commit = basename(dirname(kindDirectory));
  if (!match || !sha.test(commit)) return undefined;
  try {
    const record = JSON.parse(await readFile(runRecordPath(dirname(dirname(kindDirectory)), commit, basename(kindDirectory), match[1]!), "utf8")) as Record<string, unknown>;
    if (!isCommand(record?.command)) return undefined;
    const provenance = provenanceOf(record, commit);
    if (provenance === false) return undefined;
    if (createHash("sha256").update(bytes ?? await readFile(evidence)).digest("hex") !== match[1]) return undefined;
    return { command: record.command, ...provenance ? { provenance } : {} };
  } catch { return undefined; }
}

export type Capture = { commit: string; runs: number; startedAt: string; finishedAt: string };

export async function runnerCapture(directory: string): Promise<Capture | undefined> {
  const names = await readdir(directory).catch(() => []);
  return captureOf(await Promise.all(names.map((name) => runRecordOf(join(directory, name)))));
}

export function captureOf(records: (RunRecord | undefined)[]): Capture | undefined {
  const provenances = records.map((record) => record?.provenance);
  if (!provenances.length || !provenances.every((provenance): provenance is Provenance => provenance !== undefined)) return undefined;
  const startedAt = provenances.map((provenance) => provenance.startedAt).sort()[0]!;
  const finishedAt = provenances.map((provenance) => provenance.finishedAt).sort().at(-1)!;
  return { commit: provenances[0]!.commit, runs: provenances.length, startedAt, finishedAt };
}

export const captureText = ({ commit, runs, startedAt, finishedAt }: Capture) =>
  `captured by the Hedge runner at ${commit.slice(0, 7)}: ${runs} run(s), each exit 0 on a clean tree, from ${startedAt} to ${finishedAt}`;
