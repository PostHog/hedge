import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const decisionPhrases = /\b(should I|shall I|do you want|would you like|want me to|which (option|one|would you|do you)|your call|your decision|decision needed|need(s)? your (decision|go|answer|input|approval|ok)|let me know (if|whether|which|how)|reply with|pick (one|an option)|waiting (on|for) your|the decision is (on|in) (the|your|this)|please (send|approve|confirm|decide|pick)|once you (decide|confirm|approve)|for your (go|answer|decision|ok|approval))\b/i;
const nothingNeeded = /[^.?!\n]*\b(nothing|no)\b[^.?!\n]*\b(needs? (you|your)|your (decision|input|answer|go))\b[^.?!\n]*[.!]?/gi;
const tailLength = 700;

export function asksForDecision(message: string): boolean {
  const prose = message.replace(/```[\s\S]*?```/g, "").replace(/^>.*$/gm, "").replace(nothingNeeded, "").trim();
  const tail = prose.slice(-tailLength);
  if (decisionPhrases.test(tail)) return true;
  const lastLines = tail.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3);
  return lastLines.some((line) => /\?(\*\*|_|\))*$/.test(line));
}

export const fallbackPerson = "the person";

function readSettings(home: string): Record<string, unknown> {
  const file = join(home, ".local/state/hedge/settings.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function personName(home: string): string {
  const person = readSettings(home)["guards.person"];
  return typeof person === "string" && person.trim() ? person.trim() : fallbackPerson;
}

const plain = (text: string) => text.replaceAll("\uFE0F", "");

export function proseTitles(home: string): string[] {
  const value = readSettings(home)["orchestration.proseTitles"];
  return typeof value === "string" ? value.split(",").map((start) => plain(start).trim()).filter(Boolean) : [];
}

export const asksInProse = (title: string | undefined, starts: string[]) => title !== undefined && starts.some((start) => plain(title).startsWith(start));
