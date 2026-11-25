import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireHubRole, stateDir, writeStateFile } from "./hub-job.ts";
import type { Fetch } from "../../mcp-gateway/lib/client.ts";
import { refreshCodexCatalog } from "./codex-catalog.ts";
import { proxyUrl } from "../../../src/adapters/provider-config/proxy-route.ts";

export { proxyUrl };

export type UsageWindow = { id?: string; utilization: number; resetsAt?: number };
/** `extraUsage` is true when the account keeps answering past its windows and bills the overage. */
export type Usage = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; scoped: UsageWindow[]; extraUsage?: boolean };
export type Provider = "claude" | "codex";
export type Credential = { name: string; authIndex: string; provider: Provider; priority: number; usage?: Usage; quotaCooldown: boolean; blocked: string | false; loginExpired?: true; paused?: true };
/** `pausedPath` lists the subscriptions the balancer turned off, so it turns on only those again. */
export type Balance = { fetch: Fetch; managementKey: string; now: number; dryRun: boolean; ledger?: boolean; pausedPath?: string; allowExtraUsage?: ReadonlySet<string>; log(line: string): void };
export type LedgerSample = { at: number; auth: string; provider: Provider; window: string; remaining: number; resets_at?: number };
export type BalanceDeps = { home: string; env?: Record<string, string | undefined>; fetch: Fetch; now(): number; ledger: boolean; log(line: string): void };

type AuthFile = { name: string; provider?: string; disabled?: boolean; priority?: number; auth_index?: string; unavailable?: boolean; status?: string; status_message?: string; cooldowns?: { reason?: string }[]; id_token?: { chatgpt_account_id?: unknown } };
type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type CodexWindow = { used_percent?: number; reset_at?: number; limit_window_seconds?: number } | null | undefined;
type CodexLimit = { allowed?: boolean; limit_reached?: boolean; primary_window?: CodexWindow; secondary_window?: CodexWindow } | undefined;
type Call = (path: string, init?: RequestInit) => Promise<unknown>;

export const proxyDir = (home: string) => join(home, ".local/share/hedge-cli-proxy");
export const managementFile = (home: string) => join(proxyDir(home), "management.env");
export const codexCatalogPath = (home: string) => join(proxyDir(home), "codex-catalog.json");
export const modelRegistryPath = (home: string) => join(proxyDir(home), "models-catalog.json");
export const managementPattern = /^MANAGEMENT_PASSWORD=([0-9a-f]{64})\n$/;
const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
const providerNames: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
const signInBlocks = ["invalid_grant", "unauthorized", "authentication_error", "permission_error"];
const waitBlocks = ["transient_error", "transient_rate_limit", "cloudflare_challenge", "overloaded_error", "api_error", "model_not_supported", "not_found", "unknown"];
const knownBlocks = new Set([...signInBlocks, ...waitBlocks, "payment_required"]);
const accountPattern = /^[A-Za-z0-9_-]{1,128}$/;
const strategy = "fill-first";
const hour = 3_600_000;

export async function management(fetch: Fetch, key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${proxyUrl}/v0/management/${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The CLI proxy management API ${path} returned ${response.status}.`);
  return response.json();
}

export function quotaStatus({ usage, provider }: Credential): "available" | "exhausted" | "unknown" {
  const windows = usage ? [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((window) => window !== undefined) : [];
  if (provider === "claude" ? !usage?.sevenDay : !windows.length) return "unknown";
  if (!windows.every((window) => Number.isFinite(window.utilization) && window.utilization >= 0)) return "unknown";
  return windows.some((window) => window.utilization >= 100) ? "exhausted" : "available";
}

export function shortId(file: { name?: string; auth_index?: string }): string {
  const index = typeof file.auth_index === "string" && /^[A-Za-z0-9_-]+$/.test(file.auth_index) ? file.auth_index : createHash("sha256").update(file.name ?? "").digest("hex");
  return index.slice(0, 8);
}

const label = ({ name, authIndex, provider }: Credential) => `${providerNames[provider]} subscription ${shortId({ name, auth_index: authIndex })}`;
const hasCapacity = (credential: Credential) => quotaStatus(credential) === "available";
const weeklyReset = ({ usage }: Credential) => usage?.sevenDay?.resetsAt ?? Number.POSITIVE_INFINITY;

export function priorities(credentials: Credential[]): Map<string, number> {
  const ladder = credentials.filter(hasCapacity).sort((a, b) => weeklyReset(a) - weeklyReset(b) || a.name.localeCompare(b.name));
  return new Map(credentials.map((credential) => {
    const rank = ladder.indexOf(credential);
    return [credential.name, rank === -1 ? 0 : ladder.length - rank];
  }));
}

export function pauseChanges(credentials: Credential[], allowExtraUsage?: ReadonlySet<string>): { pause: Credential[]; resume: Credential[] } {
  const claude = credentials.filter((credential) => credential.provider === "claude");
  return {
    pause: claude.filter((credential) => !credential.paused && !allowExtraUsage?.has(credential.authIndex) && credential.usage?.extraUsage && quotaStatus(credential) === "exhausted"),
    resume: claude.filter((credential) => credential.paused && (allowExtraUsage?.has(credential.authIndex) || hasCapacity(credential))),
  };
}

function readStringSet(path: string | undefined, onInvalid?: () => void): Set<string> {
  if (!path) return new Set();
  try {
    const values = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(values)) {
      const strings = values.filter((value): value is string => typeof value === "string");
      if (!onInvalid || strings.length === values.length) return new Set(strings);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
  }
  onInvalid?.();
  return new Set();
}

export async function balance(options: Balance): Promise<void> {
  const call = (path: string, init?: RequestInit) => management(options.fetch, options.managementKey, path, init);
  const current = ((await call("routing/strategy")) as { strategy?: string }).strategy;
  if (current !== strategy) {
    options.log(`routing strategy ${current || "unset"} -> ${strategy}`);
    if (!options.dryRun) await call("routing/strategy", { method: "PUT", body: JSON.stringify({ value: strategy }) });
  }
  const { files } = (await call("auth-files")) as { files: AuthFile[] };
  const pausedBefore = readStringSet(options.pausedPath);
  const enabled = files.filter((file) => (file.provider === "claude" || file.provider === "codex") && file.auth_index && (!file.disabled || (file.provider === "claude" && pausedBefore.has(file.name))));
  const all = await Promise.all(enabled.map(async (file): Promise<Credential> => {
    const provider = file.provider as Provider;
    const usage = provider === "codex" ? await readCodexUsage(call, file.auth_index!, codexAccount(file)) : await readUsage(call, file.auth_index!);
    return { name: file.name, authIndex: file.auth_index!, provider, priority: file.priority ?? 0, quotaCooldown: quotaCooldown(file), blocked: blocked(file), usage, ...(loginExpired(file) ? { loginExpired: true as const } : {}), ...(file.disabled ? { paused: true as const } : {}) };
  }));
  const { pause, resume } = options.pausedPath ? pauseChanges(all, options.allowExtraUsage) : { pause: [], resume: [] };
  for (const credential of pause) options.log(`${label(credential)}: paused, a window is full and it bills extra usage past it`);
  for (const credential of resume) {
    const reason = hasCapacity(credential) ? "every window has capacity again" : "extra usage is allowed for this subscription";
    options.log(`${label(credential)}: resumed, ${reason}`);
  }
  const credentials = all.filter((credential) => (!credential.paused || resume.includes(credential)) && !pause.includes(credential));
  const fallbackResumes = new Set(resume.filter((credential) => !hasCapacity(credential)));
  if (!options.dryRun && options.pausedPath) {
    for (const credential of [...pause, ...resume]) {
      const disabled = pause.includes(credential);
      if (fallbackResumes.has(credential) && credential.priority !== 0) {
        await call("auth-files/fields", { method: "PATCH", body: JSON.stringify({ name: credential.name, priority: 0 }) });
      }
      await call("auth-files/status", { method: "PATCH", body: JSON.stringify({ name: credential.name, disabled }) });
      if (disabled) pausedBefore.add(credential.name);
      else pausedBefore.delete(credential.name);
      writeStateFile(options.pausedPath, [...pausedBefore].sort());
    }
    const paused = all.filter((credential) => !credentials.includes(credential)).map((credential) => credential.name).sort();
    if (paused.length !== pausedBefore.size) writeStateFile(options.pausedPath, paused);
  }
  const claude = credentials.filter((credential) => credential.provider === "claude");
  if (!credentials.length) options.log("The proxy holds no enabled Claude or Codex subscription.");
  const planned = new Map([...credentials.map((credential) => [credential.name, credential.priority] as const), ...priorities(claude)]);
  const changed = claude.filter((credential) => !fallbackResumes.has(credential) && planned.get(credential.name) !== credential.priority);
  if (options.dryRun || changed.length || credentials.some((credential) => !credential.usage)) {
    for (const credential of credentials) options.log(describe(credential, planned.get(credential.name)!, options.now));
    for (const credential of all.filter((item) => !credentials.includes(item) && !pause.includes(item))) options.log(describe(credential, undefined, options.now));
  }
  for (const credential of credentials) {
    if (credential.blocked) options.log(`${label(credential)}: blocked (${credential.blocked}). The proxy skips it ${until(credential.blocked)}.`);
  }
  if (options.dryRun) return;
  for (const credential of changed) await call("auth-files/fields", { method: "PATCH", body: JSON.stringify({ name: credential.name, priority: planned.get(credential.name) }) });
  for (const credential of credentials.filter((item) => item.quotaCooldown && hasCapacity(item))) {
    await call("reset-quota", { method: "POST", body: JSON.stringify({ auth_index: credential.authIndex }) });
    options.log(`${label(credential)}: cleared quota cooldown after live usage confirmed capacity`);
  }
  const samples = options.ledger ? ledgerSamples(all, options.now) : [];
  if (samples.length) await call("quota-ledger/samples", { method: "POST", body: JSON.stringify({ samples }) }).catch((error: Error) => options.log(`quota history not recorded: ${error.message}`));
}

export function ledgerSamples(credentials: Credential[], now: number): LedgerSample[] {
  return credentials.flatMap(({ name, provider, usage }) => [usage?.fiveHour, usage?.sevenDay, ...(usage?.scoped ?? [])].flatMap((window) => (window?.id
    ? [{ at: now, auth: name, provider, window: window.id, remaining: Math.min(100, Math.max(0, 100 - window.utilization)), ...(window.resetsAt === undefined ? {} : { resets_at: window.resetsAt }) }]
    : [])));
}

function codexWindowId(seconds: number | undefined): string | undefined {
  if (seconds === 18_000) return "five-hour";
  if (seconds === 604_800) return "weekly";
  if (seconds !== undefined && seconds >= 28 * 86_400 && seconds <= 31 * 86_400) return "monthly";
  return undefined;
}

/** The proxy keeps the last error message after a login works again, so only a subscription that is also failing counts as expired. */
export function loginExpired(file: { status?: string; unavailable?: boolean; status_message?: string }): boolean {
  return (file.status === "error" || file.unavailable === true) && /invalid[_ ]grant/i.test(file.status_message ?? "");
}

function quotaCooldown(file: AuthFile): boolean {
  if (!file.unavailable) return false;
  if (file.cooldowns?.length) return file.cooldowns.every(({ reason }) => reason === "quota" || reason === "credential_quota");
  return statusType(file) === "rate_limit_error";
}

function statusType(file: AuthFile): unknown {
  try { return JSON.parse(file.status_message ?? "").error?.type; }
  catch { return undefined; }
}

const knownBlock = (code: unknown) => (typeof code === "string" && knownBlocks.has(code) ? code : "unavailable");

function blocked(file: AuthFile): string | false {
  if (!file.unavailable || quotaCooldown(file)) return false;
  const reasons = (file.cooldowns ?? []).filter(({ reason }) => reason !== "quota" && reason !== "credential_quota").map(({ reason }) => knownBlock(reason));
  return reasons.length ? [...new Set(reasons)].join(", ") : knownBlock(statusType(file));
}

function until(codes: string): string {
  const list = codes.split(", ");
  if (list.some((code) => signInBlocks.includes(code))) return "until you sign it in again on the hub";
  if (list.includes("payment_required")) return "until its plan's billing is fixed";
  return "until the block clears";
}

function codexAccount(file: AuthFile): string | undefined {
  const account = file.id_token?.chatgpt_account_id;
  return typeof account === "string" && accountPattern.test(account) ? account : undefined;
}

async function readCodexUsage(call: Call, authIndex: string, account: string | undefined): Promise<Usage | undefined> {
  try {
    const header = { Authorization: "Bearer $TOKEN$", ...(account ? { "Chatgpt-Account-Id": account } : {}) };
    const response = (await call("api-call", { method: "POST", body: JSON.stringify({ auth_index: authIndex, method: "GET", url: codexUsageUrl, header }) })) as { status_code: number; body: string };
    if (response.status_code !== 200) return undefined;
    const raw = JSON.parse(response.body) as { rate_limit?: CodexLimit; additional_rate_limits?: { rate_limit?: CodexLimit }[] };
    const usage: Usage = { scoped: [] };
    for (const [index, limit] of [raw.rate_limit, ...(raw.additional_rate_limits ?? []).map((item) => item?.rate_limit)].entries()) {
      if (typeof limit?.allowed !== "boolean" || typeof limit.limit_reached !== "boolean" || !limit.primary_window) return undefined;
      for (const value of [limit.primary_window, limit.secondary_window]) {
        if (value == null) continue;
        const read = codexWindow(value);
        if (!read) return undefined;
        const id = index === 0 ? codexWindowId(value.limit_window_seconds) : undefined;
        const window = id ? { ...read, id } : read;
        if (index === 0 && value.limit_window_seconds === 18_000 && !usage.fiveHour) usage.fiveHour = window;
        else if (index === 0 && value.limit_window_seconds === 604_800 && !usage.sevenDay) usage.sevenDay = window;
        else usage.scoped.push(window);
      }
      if (!limit.allowed || limit.limit_reached) usage.scoped.push({ utilization: 100 });
    }
    return usage;
  } catch { return undefined; }
}

function codexWindow(raw: NonNullable<CodexWindow>): UsageWindow | undefined {
  if (typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent) || raw.used_percent < 0) return undefined;
  return { utilization: raw.used_percent, ...(typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) ? { resetsAt: raw.reset_at * 1000 } : {}) };
}

async function readUsage(call: Call, authIndex: string): Promise<Usage | undefined> {
  try {
    const header = { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" };
    const response = (await call("api-call", { method: "POST", body: JSON.stringify({ auth_index: authIndex, method: "GET", url: usageUrl, header }) })) as { status_code: number; body: string };
    if (response.status_code !== 200) return undefined;
    const usage = JSON.parse(response.body) as Record<string, RawWindow> & { extra_usage?: { is_enabled?: unknown } | null };
    const scoped: UsageWindow[] = [];
    for (const [key, raw] of Object.entries(usage)) {
      if (!key.startsWith("seven_day_") || key === "seven_day_breakdown" || raw == null) continue;
      const window = usageWindow(raw as RawWindow);
      if (!window) return undefined;
      scoped.push({ ...window, id: key.replaceAll("_", "-") });
    }
    const named = (window: UsageWindow | undefined, id: string) => window && { ...window, id };
    return { fiveHour: named(usageWindow(usage.five_hour), "five-hour"), sevenDay: named(usageWindow(usage.seven_day), "seven-day"), scoped, extraUsage: usage.extra_usage?.is_enabled === true };
  } catch { return undefined; }
}

function usageWindow(raw: RawWindow): UsageWindow | undefined {
  if (typeof raw?.utilization !== "number" || !Number.isFinite(raw.utilization) || raw.utilization < 0) return undefined;
  const resetsAt = Date.parse(raw.resets_at ?? "");
  return { utilization: raw.utilization, ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) };
}

function describe(credential: Credential, priority: number | undefined, now: number): string {
  const change = priority === undefined ? "paused" : credential.priority === priority ? `priority ${priority}` : `priority ${credential.priority} -> ${priority}`;
  if (!credential.usage) return `${label(credential)}: ${change}, usage unreadable${credential.loginExpired ? ": its login expired. Sign it in again on the hub; hedge cli-proxy doctor names the command" : ""}`;
  const window = (span: string, value?: UsageWindow) => (value ? `${span} ${value.utilization}% resets in ${value.resetsAt === undefined ? "unknown" : duration(value.resetsAt - now)}` : `${span} unknown`);
  return `${label(credential)}: ${change}, ${window("7d", credential.usage.sevenDay)}, ${window("5h", credential.usage.fiveHour)}`;
}

function duration(milliseconds: number): string {
  const hours = Math.max(0, Math.round(milliseconds / hour));
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
}

export async function readManagementKey(home: string): Promise<string> {
  const text = await readFile(managementFile(home), "utf8").catch(() => "");
  const key = managementPattern.exec(text)?.[1];
  if (!key) throw new Error(`${managementFile(home)} holds no management key. Run hedge cli-proxy install.`);
  return key;
}

export async function balanceCommand(args: string[], deps: BalanceDeps): Promise<number> {
  requireHubRole(deps.home, "cli-proxy-balance");
  const managementKey = await readManagementKey(deps.home);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: hedge cli-proxy-balance [--dry-run]");
  if (!args.includes("--dry-run")) await refreshCodexCatalog({ path: codexCatalogPath(deps.home), registryPath: modelRegistryPath(deps.home), fetch: deps.fetch, now: deps.now, log: deps.log }).catch((error) => deps.log(`Codex catalog: ${(error as Error).message}`));
  const pausedPath = join(stateDir(deps.home, deps.env ?? process.env), "cli-proxy-paused.json");
  const allowExtraUsage = readStringSet(join(proxyDir(deps.home), "allow-extra-usage.json"), () => {
    deps.log("Cannot read allow-extra-usage.json as a JSON array of Auth Index values. Using the default billing guard.");
  });
  await balance({ fetch: deps.fetch, managementKey, now: deps.now(), dryRun: args.includes("--dry-run"), ledger: deps.ledger, pausedPath, allowExtraUsage, log: deps.log });
  return 0;
}
