import { refText, type PrRef } from "./decision-ledger.ts";
import type { Run } from "./pr-ci.ts";
import { diffSize, forkPoint, type DiffSize } from "./proof-checkout.ts";
import { finishedReviews, summaryGaps, type GapProof, type ProofIdentity, type ProofSummary } from "./proof.ts";
import { bloatFigure, type BloatScore } from "./proof-bloat.ts";
import type { SanityPass } from "./proof-sanity.ts";

export const isCommitSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export type Sized = DiffSize & { commit: string; from: string };
export type Growth = { rounds: number; finalReads: number; first?: Sized; final?: Sized; sanity?: SanityPass; bloat?: BloatScore };
export type EndRow = { ref: PrRef; summary: ProofSummary; reason: (kind: string, reason: string) => string };

const isRound = (name: string) => /^\d+$/.test(name);

function sizeAt(identity: ProofIdentity, run: Run, from: string | undefined): Sized | undefined {
  const size = from === undefined ? undefined : diffSize(identity, run, from);
  return size && from !== undefined ? { ...size, commit: identity.commit, from } : undefined;
}

export async function measureGrowth(home: string, head: ProofIdentity, run: Run, baseSha: string | undefined): Promise<Growth> {
  const reviews = await finishedReviews(home, head);
  const rounds = reviews.filter(({ name }) => isRound(name)).sort((a, b) => Number(a.name) - Number(b.name));
  const opening = rounds[0];
  const start = opening?.scope !== "full" ? undefined : isCommitSha(opening.forkBase) ? forkPoint({ ...head, commit: opening.commit }, run, opening.forkBase) : opening.from;
  const first = !opening || !start ? undefined : start === opening.commit ? { production: 0, tests: 0, docs: 0, commit: start, from: start } : sizeAt({ ...head, commit: opening.commit }, run, start);
  const final = sizeAt(head, run, isCommitSha(baseSha) ? forkPoint(head, run, baseSha) : undefined);
  return { rounds: rounds.length, finalReads: reviews.length - rounds.length, ...first ? { first } : {}, ...final ? { final } : {} };
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const figure = (lines: number | undefined) => typeof lines === "number" ? lines.toLocaleString("en-US") : "unknown";
const span = (from: number | undefined, to: number | undefined) => `${figure(from)} → ${figure(to)}`;

function roundsCell(growth: Growth | undefined) {
  if (!growth) return "not measured";
  if (!growth.rounds && !growth.finalReads) return "no review";
  return [counted(growth.rounds, "round"), ...growth.finalReads ? [counted(growth.finalReads, "final read")] : []].join(", ");
}

function linesCell(growth: Growth | undefined) {
  if (!growth) return "not measured";
  const { first, final } = growth;
  const parts = (["tests", "docs"] as const).filter((part) => first?.[part] || final?.[part]);
  if (!growth.rounds) return [`${figure(final?.production)} at HEAD`, ...parts.map((part) => `${part} ${figure(final?.[part])}`)].join("; ");
  const ratio = typeof first?.production === "number" && typeof final?.production === "number" && first.production > 0 ? ` (×${(final.production / first.production).toFixed(1)})` : "";
  return [`${span(first?.production, final?.production)}${ratio}`, ...parts.map((part) => `${part} ${span(first?.[part], final?.[part])}`)].join("; ");
}

function sanityCell({ summary, reason }: EndRow) {
  const { sanity: pass, bloat } = summary.growth ?? {};
  const verdict = pass ? `${pass.verdict} at ${pass.commit === summary.commit ? "HEAD" : pass.commit.slice(0, 7)}: ${reason("sanity", pass.reason)}` : "not run";
  return bloat ? `${bloatFigure(bloat, summary.commit)}; ${verdict}` : verdict;
}

function acceptor(gap: GapProof) {
  const by = gap.accepted;
  if (!by) return "not accepted";
  if (by.by === "standing rule") return "a standing rule";
  return [by.mark, by.by, by.id].filter(Boolean).join(" ");
}

const skipped = ({ summary, reason }: EndRow) =>
  summaryGaps(summary).map(({ kind, gap }) => `${kind}: ${gap.reason ? reason(kind, gap.reason) : "no reason recorded"} (${acceptor(gap)})`);

export const oneLine = (text: string) => text.replace(/\r\n?|\n/g, " ");
const cell = (text: string) => oneLine(text.replace(/(?<!\\)(\\*)\|/g, (pipe, slashes: string) => slashes.length % 2 ? pipe : `${slashes}\\|`));

export function endTable(rows: EndRow[]) {
  return [
    "| PR | Review rounds | Production lines | Sanity pass | Skipped proofs |", "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${[refText(row.ref), roundsCell(row.summary.growth), linesCell(row.summary.growth), sanityCell(row), skipped(row).join("; ") || "none"].map(cell).join(" | ")} |`),
  ];
}
