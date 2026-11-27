import { bunScript } from "../../../src/runner/bun.ts";
import { tierOf } from "./decision-ledger.ts";

type Env = Record<string, string | undefined>;
export type ReviewBotAction = "review" | "stamp" | "forecast";
export type ReviewBotRequest = { action: ReviewBotAction; repo: string; pr?: number; branch?: string; paths?: string; minutes: number; deep: boolean; request: boolean };

const usage = "Usage: hedge pr review|stamp --repo <owner/repo> --pr <number> [--deep] [--minutes <n>], or hedge pr forecast --repo <owner/repo> (--pr <number> [--request] | --branch <name> | --paths <file>)";
const fallbackSetting: Record<ReviewBotAction, string> = { review: "pull-requests.reviewFallback", stamp: "pull-requests.stampFallback", forecast: "pull-requests.reviewFallback" };
const defaultFallback: Record<ReviewBotAction, string> = {
  review: "Ask for a review the way the repo's docs say.",
  stamp: "Ask for an approval the way the repo's docs say.",
  forecast: "Ask for a review the way the repo's docs say.",
};
const noBot: Record<ReviewBotAction, string> = { review: "No review bot is on for this machine.", stamp: "No review bot is on for this machine.", forecast: "No review bot is on for this machine, so there is no forecast." };

export function parseReviewBotArgs(action: ReviewBotAction, args: string[]): ReviewBotRequest {
  const request: Partial<ReviewBotRequest> = { action, minutes: 15, deep: false, request: false };
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--deep" && action === "review") { request.deep = true; continue; }
    if (arg === "--request" && action === "forecast") { request.request = true; continue; }
    const value = rest.shift();
    if (arg === "--repo" && value && /^[^/\s]+\/[^/\s]+$/.test(value)) { request.repo = value; continue; }
    if (arg === "--pr" && value && /^\d+$/.test(value)) { request.pr = Number(value); continue; }
    if (arg === "--branch" && action === "forecast" && value && !value.startsWith("-")) { request.branch = value; continue; }
    if (arg === "--paths" && action === "forecast" && value) { request.paths = value; continue; }
    if (arg === "--minutes" && action !== "forecast" && value && /^[1-9]\d*$/.test(value)) { request.minutes = Number(value); continue; }
    throw new Error(usage);
  }
  const sources = [request.pr, request.branch, request.paths].filter((source) => source !== undefined).length;
  if (!request.repo || sources !== 1 || (request.request && !request.pr)) throw new Error(usage);
  return request as ReviewBotRequest;
}

function source(request: ReviewBotRequest): string[] {
  if (request.branch !== undefined) return ["--branch", request.branch];
  if (request.paths !== undefined) return ["--paths", request.paths];
  return ["--pr", String(request.pr)];
}

export function handlerArgs(request: ReviewBotRequest): string[] {
  if (request.action === "forecast") return ["forecast", "--repo", request.repo, ...source(request), ...(request.request ? ["--request"] : [])];
  return [request.action, "--repo", request.repo, ...source(request), "--minutes", String(request.minutes), ...(request.deep ? ["--deep"] : [])];
}

export async function askReviewBot(request: ReviewBotRequest, env: Env = Bun.env): Promise<number> {
  const handler = (JSON.parse(env.HEDGE_HANDLERS || "{}") as Record<string, string>)["review-bot"];
  if (handler) return runHandler(handler, handlerArgs(await deepWhenCritical(request, env)), env);
  const fallback = fallbackText(request.action, env);
  console.log(`${noBot[request.action]} ${fallback.replaceAll("{repo}", request.repo).replaceAll("{pr}", String(request.pr ?? request.branch ?? request.paths))}`);
  return 2;
}

const githubSeconds = 10;

async function pullBody(repo: string, pr: number, env: Env): Promise<string> {
  const deadline = AbortSignal.timeout(githubSeconds * 1000);
  const late = new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(new Error(`GitHub did not answer within ${githubSeconds} s.`)), { once: true }));
  const child = Bun.spawn(["gh", "api", `repos/${repo}/pulls/${pr}`], { env, stdout: "pipe", stderr: "pipe", signal: deadline, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.race([Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), late]);
  if (code) throw new Error(`gh api failed: ${stderr.trim() || `stopped by ${child.signalCode}`}`);
  return (JSON.parse(stdout) as { body: string | null }).body ?? "";
}

async function deepWhenCritical(request: ReviewBotRequest, env: Env): Promise<ReviewBotRequest> {
  if (request.action !== "review" || request.deep || request.pr === undefined) return request;
  try {
    if (tierOf(await pullBody(request.repo, request.pr, env)) !== "critical") return request;
    console.log("The merge-risk Tier is critical, so this asks for a Deep review.");
    return { ...request, deep: true };
  } catch (error) {
    console.log(`Could not read the merge-risk Tier, so this asks for a Standard review: ${(error as Error).message}`);
    return request;
  }
}

export async function runHandler(handler: string, args: string[], env: Env): Promise<number> {
  const child = Bun.spawn(bunScript(handler, ...args), { stdio: ["inherit", "inherit", "inherit"], env });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  try { return await child.exited; }
  finally { process.off("SIGINT", forward).off("SIGTERM", forward); }
}

function fallbackText(action: ReviewBotAction, env: Env): string {
  const value = (JSON.parse(env.HEDGE_SETTINGS || "{}") as Record<string, unknown>)[fallbackSetting[action]];
  return typeof value === "string" && value.trim() ? value : defaultFallback[action];
}
