import { refText, riskCalloutOf, type PrRef } from "./decision-ledger.ts";
import type { PullRequest, Run } from "./pr-ci.ts";
import { gradeOf } from "./proof-autonomy.ts";
import { acceptor, roundsCell } from "./proof-end-table.ts";
import { knownIssues, summaryGaps, type ProofSummary } from "./proof.ts";

export type Timeline = { opened?: string; ready?: string; draft?: true };
type CardInput = { ref: PrRef; summary: ProofSummary; body: string; timeline: Timeline };

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
  const grade = /Merge risk:\**\s*(low|medium|high)\b/i.exec(callout)?.[1]?.toLowerCase() ?? "no grade";
  return `${grade}, ${gradeOf(body).oneWay ? "one-way door" : "two-way door"}`;
}

const reads = (summary: ProofSummary) => {
  const cell = roundsCell(summary.growth);
  return cell === "not measured" ? "reads not measured" : cell;
};

const listedIssues = (body: string) => knownIssues(body).map((line) => line.replace(/^[-*]\s+/, ""));

export function mergeCardLine({ ref, summary, body, timeline }: CardInput, now: Date) {
  const gaps = summaryGaps(summary).map(({ kind, gap }) => `${kind} (${acceptor(gap)})${gap.reason ? `: ${gap.reason.replace(/\s+/g, " ")}` : ""}`);
  const issues = listedIssues(body);
  return `merge card: ${refText(ref)}: ${[
    gradeText(body), reads(summary), `gaps: ${gaps.join("; ") || "none"}`,
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
