import { decidesAlone } from "./mode.ts";
import { agentRefusal, riskCalloutOf, tierOf, type AskClass, type Env, type Tier } from "./decision-ledger.ts";

export type Autonomy = "ask" | "end";
export type Grade = { tier: Tier; oneWay: boolean };

export const endTableNote = "the user reads it in hedge decision report, under Decisions";

export const shellQuoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export const gradeOf = (body: string | undefined): Grade =>
  body === undefined ? { tier: "ungraded", oneWay: false } : { tier: tierOf(body), oneWay: /\bone-way door\b/i.test(riskCalloutOf(body) ?? "") };

export const decidesAll = (env: Env, repository?: string) => decidesAlone(env, repository);

export function autonomyOf(env: Env, gradeAt: () => Grade, decisionClass: AskClass, kinds?: string[], repository?: string): Autonomy {
  if (!decidesAll(env, repository)) return "ask";
  return agentRefusal(gradeAt().tier, decisionClass, kinds, true) ? "ask" : "end";
}
