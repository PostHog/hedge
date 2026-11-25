import { refText, riskCalloutOf, type DecisionState, type PrRef } from "./decision-ledger.ts";
import type { PullRequest, Run } from "./pr-ci.ts";
import { acceptor, roundsCell } from "./proof-end-table.ts";
import { knownIssues, summaryGaps, type ProofSummary } from "./proof.ts";

export type Timeline = { opened?: string; ready?: string; draft?: true };
type CardInput = { ref: PrRef; summary: ProofSummary; body: string; timeline: Timeline; held?: string[] };

export function heldNames(summary: ProofSummary, decisions: DecisionState[]) {
  const ids = [...new Set(summaryGaps(summary).flatMap(({ gap }) => gap.accepted?.mark === "🤖" && gap.accepted.id ? [gap.accepted.id] : []))];
  return ids.map((id) => {
    const kinds = decisions.find((decision) => decision.id === id)?.scope.kinds ?? [];
    return kinds.length ? `${id} for ${kinds.join("/")}` : id;
  });
}

export function readTimeline(ref: PrRef, pull: PullRequest, run: Run): Timeline {
  if (!pull.createdAt) return {};
  if (pull.draft) return { opened: pull.createdAt, draft: true };
  const events = run(["gh", "api", "--paginate", `repos/${ref.repository}/issues/${ref.pr}/events`, "--jq", '.[] | select(.event == "ready_for_review") | .created_at']);
  if (events.code !== 0) return { opened: pull.createdAt };
  return { opened: pull.createdAt, ready: events.stdout.trim().split("\n").filter(Boolean).at(-1) ?? pull.createdAt };
}

const minutes = (from: string, to: string) => `${Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000))} min`;

function timesText({ opened, ready, draft }: Timeline, now?: Date) {
  if (!opened) return "minutes not known";
  if (draft) return "still a draft";
  if (!ready) return "ready time not known";
  return [`${minutes(opened, ready)} opened to ready`, ...now ? [`${minutes(ready, now.toISOString())} ready to card`] : []].join(", ");
}

function gradeText(body: string) {
  const callout = riskCalloutOf(body);
  if (callout === undefined) return "ungraded";
  const declaration = callout.split("\n").find((line) => /Merge risk:/i.test(line)) ?? "";
  const grade = /Merge risk:\**\s*(low|medium|high)\b/i.exec(declaration)?.[1]?.toLowerCase() ?? "no grade";
  return `${grade}, ${/\bone-way door\b/i.test(declaration) ? "one-way door" : "two-way door"}`;
}

const reads = (summary: ProofSummary) => {
  const cell = roundsCell(summary.growth);
  return cell === "not measured" ? "reads not measured" : cell;
};

const listedIssues = (body: string) => knownIssues(body).map((line) => line.replace(/^[-*]\s+/, ""));

export function mergeCardLine({ ref, summary, body, timeline, held = [] }: CardInput, now: Date) {
  const gaps = summaryGaps(summary).map(({ kind, gap }) => `${kind} (${acceptor(gap)})${gap.reason ? `: ${gap.reason.replace(/\s+/g, " ")}` : ""}`);
  const issues = listedIssues(body);
  return `merge card: ${refText(ref)}: ${[
    gradeText(body), reads(summary), `gaps: ${gaps.join("; ") || "none"}`, ...held.length ? [`held: ${held.join(", ")}`] : [],
    issues.length ? `${issues.length} known issue${issues.length === 1 ? "" : "s"}: ${issues.join("; ")}` : "no known issues",
    timesText(timeline, now),
  ].join(" · ")}`;
}

export function mergeCardBlock({ summary, body, timeline }: Omit<CardInput, "ref">) {
  const gaps = summaryGaps(summary).map(({ kind, gap }) => `${kind} (${acceptor(gap)})`);
  const issues = listedIssues(body).length;
  return `**Merge card:** ${[
    gradeText(body), reads(summary), `gaps: ${gaps.join(", ") || "none"}`,
    issues ? `${issues} known issue${issues === 1 ? "" : "s"}` : "no known issues",
    timesText(timeline),
  ].join(" · ")}`;
}
