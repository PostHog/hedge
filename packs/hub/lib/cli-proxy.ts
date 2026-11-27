import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { codexCatalogPath, loginExpired, modelRegistryPath, management, managementFile, managementPattern, proxyDir, proxyUrl, readManagementKey, shortId } from "./cli-proxy-balance.ts";
import { requireHubRole } from "./hub-job.ts";
import { quote, readRole } from "./machine.ts";
import { changedFiles, ownedFiles, readIfThere, removeUnits, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { refuseLinks, writePrivateFile, type Fetch } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { isKeptForBoxes } from "../../../src/hub/names.ts";
import { cannotTell, waitsForPerson } from "../../../src/pack/types.ts";
import { codexProvider, codexProviderTable, keyHelper } from "../../../src/adapters/provider-config/proxy-route.ts";
import { refreshCodexCatalog } from "./codex-catalog.ts";
import { must, proxyPort } from "./run.ts";

export { codexProvider, codexProviderTable, keyHelper, proxyPort, proxyUrl };
export type ProxyMode = "plan" | "install" | "doctor" | "accounts" | "catalog" | "connect" | "disconnect" | "check" | "remove" | "left";
export type Release = { version: string; url: string; sha256: string };
export type Panel = { page: Release; plugin: Release; historyDays: number };
export type AiPlan = "claude" | "codex" | "both";
export type ProxyMachine = {
  home: string; uid: number; user: string; plan?: AiPlan; accounts?: number; panel?: Panel; devboxes: string[]; release: Release; run: Run; fetch: Fetch;
  now(): number; sleep(ms: number): Promise<void>; readStdin(): Promise<string>; randomKey(): string; print(line: string): void;
};

export const keyPath = (home: string) => join(home, ".config/hedge/cli-proxy.key");
const fleetKeyHelper = 'cat "$HOME/.config/fleet/cli-proxy.key"';
const ownHelper = (helper: unknown) => helper === keyHelper || helper === fleetKeyHelper;
export const panelUrl = `${proxyUrl}/management.html`;
const marker = "# Managed by Hedge CLI proxy.";
const what = "CLI proxy";
const service = "hedge-cli-proxy.service";
const keyPattern = /^([0-9a-f]{64})\n?$/;
const address = `127.0.0.1:${proxyPort}`;
const answerTries = 20;
const claudeCodeVersion = "2.1.322";

function layout(home: string) {
  const dir = proxyDir(home);
  return { dir, binary: join(dir, "cli-proxy-api"), config: join(dir, "config.yaml"), auth: join(dir, "auth"), management: managementFile(home), unit: join(home, ".config/systemd/user", service), key: keyPath(home), restart: join(dir, "restart-pending"),
    page: join(dir, "static/management.html"), plugins: join(dir, "plugins"), plugin: join(dir, "plugins/quota-ledger.so"), ledger: join(dir, "quota-ledger/samples.jsonl"), catalog: codexCatalogPath(home), registry: modelRegistryPath(home) };
}
type Layout = ReturnType<typeof layout>;
const loginCommand = (paths: Layout, agent: Agent) => `${paths.binary} -config ${paths.config} -${agent}-login -no-browser`;
const pooled = (plan: AiPlan | undefined): Agent => (plan === "codex" ? "codex" : "claude");
const subscription = { claude: "Claude", codex: "Codex" };
const subscriptions = (count: number, agent: Agent) => `${count} ${subscription[agent]} subscription${count === 1 ? "" : "s"}`;

function panelLines(paths: Layout, panel: Panel | undefined) {
  if (!panel) return { control: ["  disable-control-panel: true"], plugins: [], unit: [] };
  if (!Number.isInteger(panel.historyDays) || panel.historyDays < 1) throw new Error(`hub.proxyHistoryDays must be a whole number of days, 1 or more: ${panel.historyDays}`);
  return {
    control: ["  disable-control-panel: false", "  disable-auto-update-panel: true"],
    plugins: ["plugins:", "  enabled: true", `  dir: "${paths.plugins}"`, "  configs:", "    quota-ledger:", "      enabled: true", `      path: "${paths.ledger}"`, `      retention-days: ${panel.historyDays}`],
    unit: [`Environment=MANAGEMENT_STATIC_PATH=${paths.page}`],
  };
}

function wanted(paths: Layout, key: string, panel: Panel | undefined): Managed[] {
  if (/["%\s\\]/.test(paths.dir)) throw new Error(`Move your home to a path without spaces, quotes, % or backslashes: ${paths.dir}`);
  const shown = panelLines(paths, panel);
  const config = [
    marker, `host: "127.0.0.1"`, `port: ${proxyPort}`, "tls:", "  enable: false", "remote-management:", "  allow-remote: false", `  secret-key: ""`, ...shown.control,
    `auth-dir: "${paths.auth}"`, "api-keys:", `  - "${key}"`, "debug: false", "commercial-mode: true", "logging-to-file: false", "usage-statistics-enabled: true", "request-retry: 3",
    "quota-exceeded:", "  switch-project: true", "  switch-preview-model: true", "routing:", `  strategy: "fill-first"`, "  session-affinity: true", `  session-affinity-ttl: "1h"`,
    "claude-header-defaults:", `  user-agent: "claude-cli/${claudeCodeVersion} (external, cli)"`, "models:", `  codex-catalog: "${paths.catalog}"`, `  catalog: "${paths.registry}"`, ...shown.plugins, "",
  ].join("\n");
  const unit = [
    marker, "[Unit]", "Description=Hedge CLI proxy for your own subscriptions", "After=network-online.target", "Wants=network-online.target", "", "[Service]",
    `EnvironmentFile=${paths.management}`, ...shown.unit, `ExecStart=${paths.binary} -config ${paths.config}`, `WorkingDirectory=${paths.dir}`, "UMask=0077", "Restart=on-failure", "RestartSec=5", "NoNewPrivileges=true",
    "", "[Install]", "WantedBy=default.target", "",
  ].join("\n");
  return [{ path: paths.config, content: config }, { path: paths.unit, content: unit }];
}

async function readSecret(home: string, path: string, pattern: RegExp): Promise<string | undefined> {
  await refuseLinks(home, path, `${what} path`);
  const text = await readIfThere(path);
  if (text === undefined) return undefined;
  const value = pattern.exec(text)?.[1];
  if (!value) throw new Error(`Keep unmanaged ${what} file: ${path}`);
  return value;
}

async function savedKey(home: string): Promise<string | undefined> {
  await refuseLinks(home, keyPath(home), `${what} path`);
  return keyPattern.exec((await readIfThere(keyPath(home))) ?? "")?.[1];
}

async function binaryReady(machine: ProxyMachine, paths: Layout): Promise<boolean> {
  if (!existsSync(paths.binary)) return false;
  const help = await machine.run([paths.binary, "--help"]);
  return `${help.stdout}${help.stderr}`.includes(`CLIProxyAPI Version: ${machine.release.version}`);
}

const sha256 = async (path: string) => new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");

async function download(machine: ProxyMachine, release: Release, place: (file: string, folder: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "hedge-cli-proxy-"));
  try {
    const file = join(folder, "download");
    await must(machine.run, ["curl", "-fsSL", release.url, "-o", file]);
    if ((await sha256(file)) !== release.sha256) throw new Error(`Checksum mismatch for ${release.url}.`);
    await place(file, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function ensureBinary(machine: ProxyMachine, paths: Layout): Promise<void> {
  if (await binaryReady(machine, paths)) return;
  await writePrivateFile(paths.restart, "\n");
  await download(machine, machine.release, async (archive, folder) => {
    await must(machine.run, ["tar", "-xzf", archive, "-C", folder]);
    await must(machine.run, ["install", "-m", "0755", join(folder, "cli-proxy-api"), paths.binary]);
  });
}

const assetReady = async (path: string, release: Release) => existsSync(path) && (await sha256(path)) === release.sha256;

async function ensureAsset(machine: ProxyMachine, release: Release, path: string, restart?: string): Promise<void> {
  if (await assetReady(path, release)) return;
  if (restart) await writePrivateFile(restart, "\n");
  await download(machine, release, async (file) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await copyFile(file, temp);
      await chmod(temp, 0o600);
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  });
}

async function ensurePanel(machine: ProxyMachine, paths: Layout, panel: Panel): Promise<void> {
  await ensureAsset(machine, panel.page, paths.page);
  await ensureAsset(machine, panel.plugin, paths.plugin, paths.restart);
}

// Runs only after the proxy restarted with the control panel off: while the panel is on,
// CLIProxyAPI downloads a missing management.html itself, unpinned and unchecked.
async function closePanel(machine: ProxyMachine, paths: Layout): Promise<void> {
  for (const path of [paths.page, paths.plugin]) await rm(path, { force: true });
  const others = await foreignPlugins(paths);
  if (others.length) machine.print(`Kept plugins Hedge did not install: ${others.join(", ")}. Remove them: hedge cli-proxy doctor fails while they are there.`);
}

async function foreignPlugins(paths: Layout): Promise<string[]> {
  const names = await readdir(paths.plugins, { recursive: true }).catch(() => [] as string[]);
  const found: string[] = [];
  for (const name of names.map(String).sort()) {
    const path = join(paths.plugins, name);
    if (path !== paths.plugin && name.toLowerCase().endsWith(".so") && !(await lstat(path)).isDirectory()) found.push(path);
  }
  return found;
}

async function refuseLinkedLayout(home: string, paths: Layout): Promise<void> {
  for (const path of [paths.auth, paths.binary, paths.config, paths.management, paths.restart, paths.unit, paths.key, paths.page, paths.plugin, paths.ledger, paths.catalog, paths.registry]) await refuseLinks(home, path, `${what} path`);
}

async function install(machine: ProxyMachine, paths: Layout): Promise<void> {
  await refuseLinkedLayout(machine.home, paths);
  const savedClient = await readSecret(machine.home, paths.key, keyPattern);
  const savedManagement = await readSecret(machine.home, paths.management, managementPattern);
  const key = savedClient ?? machine.randomKey();
  const managementKey = savedManagement ?? machine.randomKey();
  const changed = await changedFiles(machine.home, wanted(paths, key, machine.panel), marker, what);
  for (const dir of [paths.dir, paths.auth, dirname(paths.key)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  if (changed.length || !savedManagement) await writePrivateFile(paths.restart, "\n");
  await ensureBinary(machine, paths);
  if (machine.panel) await ensurePanel(machine, paths, machine.panel);
  if (!savedClient) await writePrivateFile(paths.key, `${key}\n`);
  if (!savedManagement) await writePrivateFile(paths.management, `MANAGEMENT_PASSWORD=${managementKey}\n`);
  await writeCatalog(machine, paths, false);
  await writeFiles(changed);
  await must(machine.run, ["sudo", "-n", "loginctl", "enable-linger", machine.user]);
  const systemctl = (...args: string[]) => must(machine.run, ["systemctl", "--user", ...args]);
  await systemctl("daemon-reload");
  if ((await readIfThere(paths.restart)) !== undefined) await systemctl("restart", service);
  await rm(paths.restart, { force: true });
  await systemctl("enable", "--now", service);
  if (!machine.panel) await closePanel(machine, paths);
}

async function writeCatalog(machine: ProxyMachine, paths: Layout, force: boolean): Promise<void> {
  await refreshCodexCatalog({ path: paths.catalog, registryPath: paths.registry, fetch: machine.fetch, now: machine.now, log: machine.print, force });
  if (!existsSync(paths.catalog)) machine.print(`CLI proxy: Warning: Hedge could not write ${paths.catalog}, so Codex does not offer the ultrafast tier. hedge cli-proxy-balance tries again every 5 minutes.`);
  if (!existsSync(paths.registry)) machine.print(`CLI proxy: Warning: Hedge could not write ${paths.registry}, so the proxy does not route the models upstream does not list yet. hedge cli-proxy-balance tries again every 5 minutes.`);
}

async function catalog(machine: ProxyMachine, paths: Layout): Promise<number> {
  for (const path of [paths.catalog, paths.registry]) await refuseLinks(machine.home, path, `${what} path`);
  await writeCatalog(machine, paths, true);
  return existsSync(paths.catalog) && existsSync(paths.registry) ? 0 : 1;
}

async function doctor(machine: ProxyMachine, paths: Layout): Promise<void> {
  await refuseLinkedLayout(machine.home, paths);
  const key = await readSecret(machine.home, paths.key, keyPattern);
  if (!key) throw new Error(`${paths.key} holds no proxy key. Run hedge cli-proxy install.`);
  const managementKey = await readManagementKey(machine.home);
  await requireInstalled(machine.home, wanted(paths, key, machine.panel), marker, what, "hedge cli-proxy install");
  if (!(await binaryReady(machine, paths))) throw new Error(`CLIProxyAPI ${machine.release.version} is not installed. Run hedge cli-proxy install.`);
  for (const check of ["is-enabled", "is-active"]) await must(machine.run, ["systemctl", "--user", check, "--quiet", service]);
  const listeners = async () => (await must(machine.run, ["ss", "-H", "-ltn", `sport = :${proxyPort}`])).trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/)[3]);
  for (let attempt = 0; attempt < 50 && !(await listeners()).includes(address); attempt++) await machine.sleep(100);
  const bound = await listeners();
  if (!bound.includes(address) || bound.some((local) => local !== address)) throw new Error(`The CLI proxy must listen on loopback only, at ${address}.`);
  const danger = await unsafe(machine, paths);
  if (danger) throw new Error(danger);
  await panelDoctor(machine, paths, managementKey);
  const strategy = ((await management(machine.fetch, managementKey, "routing/strategy")) as { strategy?: string }).strategy;
  if (strategy !== "fill-first") throw new Error(`The proxy routes with ${strategy ?? "no strategy"}, not fill-first. Run hedge cli-proxy-balance to restore it.`);
  const { agent, count, short, expired, enabled } = await pool(machine, paths, managementKey);
  const models = await listModels(machine.fetch, key);
  const pooledAgents: Agent[] = machine.plan === "both" ? ["claude", "codex"] : [agent];
  const reason = typeof models === "string" ? models : pooledAgents.map((provider) => (enabled(provider) ? unserved(models, provider) : undefined)).find(Boolean);
  if (reason) throw new Error(reason);
  const beside = machine.plan === "both" ? ` and ${subscriptions(enabled("codex"), "codex")}` : "";
  const balancer = agent === "claude" ? "puts the one whose weekly quota resets first on top" : "frees each one whose quota cooldown its live usage disproves";
  machine.print(`CLI proxy: CLIProxyAPI ${machine.release.version} runs at ${proxyUrl}, loopback only, with ${count} of your own ${subscription[agent]} subscriptions${beside}. Every 5 minutes the balancer ${balancer}.`);
  if (short) machine.print(`CLI proxy: To do: ${short}`);
  for (const file of expired) {
    const provider = file.provider as Agent;
    machine.print(`CLI proxy: Warning: the ${subscription[provider]} subscription ${shortId(file)} cannot refresh its login, so the proxy cannot use it and the balancer cannot read its usage. Sign it in again with: ${loginCommand(paths, provider)}. Or disable it in the management panel.`);
  }
  if (!existsSync(paths.catalog)) machine.print(`CLI proxy: Warning: ${paths.catalog} is missing, so Codex does not offer the ultrafast tier. Run hedge cli-proxy catalog.`);
  if (!existsSync(paths.registry)) machine.print(`CLI proxy: Warning: ${paths.registry} is missing, so the proxy does not route the models upstream does not list yet. Run hedge cli-proxy catalog.`);
  if (machine.panel) machine.print(`Open the management panel at ${panelUrl} on the hub, or on a devbox through its tunnel, and sign in with the MANAGEMENT_PASSWORD in ${paths.management}.`);
  for (const devbox of machine.devboxes.filter((name) => !isKeptForBoxes(name))) machine.print(`Connect ${devbox}: ssh ${devbox} ${quote('sh "$HOME/.local/share/hedge/engine/hedge" cli-proxy connect && sh "$HOME/.local/share/hedge/engine/hedge" apply')} < ~/.config/hedge/cli-proxy.key`);
}

async function pool(machine: ProxyMachine, paths: Layout, managementKey: string) {
  const files = ((await management(machine.fetch, managementKey, "auth-files")) as { files?: Array<AuthFile | null> } | null)?.files;
  if (!Array.isArray(files) || !files.every((file): file is AuthFile => typeof file?.provider === "string")) throw new Error("The proxy answers with a list of subscriptions that Hedge cannot read.");
  const expired = files.filter((file) => (file.provider === "claude" || file.provider === "codex") && !file.disabled && loginExpired(file));
  const enabled = (agent: Agent) => files.filter((file) => file.provider === agent && !file.disabled && !expired.includes(file)).length;
  const agent = pooled(machine.plan);
  const count = enabled(agent);
  const floor = machine.accounts ?? 2;
  const lapsed = expired.filter((file) => file.provider === agent).length;
  const meanwhile = count ? "" : ` Until the proxy holds one, ${agent === "claude" ? "Claude Code" : "Codex"} keeps its own sign-in on each machine.`;
  const short = count < floor ? `Add at least ${floor} of your own ${subscription[agent]} subscriptions that work to the proxy; found ${count}${lapsed ? `, and ${lapsed} whose login expired, which you can sign in again` : ""}.${meanwhile} Run on the hub, once for each subscription: ${loginCommand(paths, agent)}` : undefined;
  return { agent, count, floor, short, expired, enabled };
}

async function accounts(machine: ProxyMachine, paths: Layout): Promise<number> {
  await refuseLinkedLayout(machine.home, paths);
  const { agent, count, floor, short } = await pool(machine, paths, await readManagementKey(machine.home));
  machine.print(short ? `CLI proxy: To do: ${short}` : `CLI proxy: ${subscriptions(count, agent)} of yours work, and hub.proxyAccounts asks for ${floor}.`);
  return short ? waitsForPerson : 0;
}

async function unsafe(machine: ProxyMachine, paths: Layout): Promise<string | undefined> {
  const others = await foreignPlugins(paths);
  if (others.length) return `Remove the plugins Hedge did not install: ${others.join(", ")}. While the Proxy panel is on, anyone with the management key can install plugins from CLIProxyAPI's plugin store, and the proxy runs them on the hub.`;
  const linked = [paths.page, paths.plugin].filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink());
  if (linked.length) return `${linked.join(" and ")} ${linked.length === 1 ? "is a link" : "are links"}, which Hedge does not follow or replace. Remove ${linked.length === 1 ? "it" : "them"}, then run hedge cli-proxy install.`;
  if (!machine.panel) {
    const left = [paths.page, paths.plugin].filter((path) => lstatSync(path, { throwIfNoEntry: false }));
    return left.length ? `The Proxy panel is off, but ${left.join(" and ")} ${left.length === 1 ? "is" : "are"} still there, so the proxy may still serve or run ${left.length === 1 ? "it" : "them"}. Run hedge cli-proxy install.` : undefined;
  }
  for (const [path, release, name] of [[paths.page, machine.panel.page, "management panel"], [paths.plugin, machine.panel.plugin, "quota-ledger plugin"]] as const) {
    if (!existsSync(path)) return `${path} is missing. Run hedge cli-proxy install.`;
    if (!(await assetReady(path, release))) return `${path} does not match the pinned ${name} ${release.version}. It may have come from an unpinned source, such as CLIProxyAPI's own panel download. Run hedge cli-proxy install.`;
  }
}

async function panelDoctor(machine: ProxyMachine, paths: Layout, managementKey: string): Promise<void> {
  const page = await machine.fetch(panelUrl, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  await page?.body?.cancel();
  if (!machine.panel) {
    if (page?.ok) throw new Error(`The management panel answers at ${panelUrl}, but the Proxy panel workflow is off. Run hedge cli-proxy install.`);
    return;
  }
  if (!page?.ok) throw new Error(`The management panel does not load at ${panelUrl}. Run hedge cli-proxy install.`);
  await management(machine.fetch, managementKey, `quota-ledger/samples?since=${machine.now()}`).catch(() => {
    throw new Error("The quota-ledger plugin does not answer, so the panel has no quota history. Run hedge cli-proxy install.");
  });
}

type AuthFile = { name?: string; auth_index?: string; provider?: string; disabled?: boolean; unavailable?: boolean; status?: string; status_message?: string };

const silent = `The proxy at ${proxyUrl} does not answer.`;

async function listModels(fetch: Fetch, key: string): Promise<string[] | string> {
  const response = await fetch(`${proxyUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!response) return silent;
  if (!response.ok) return `The proxy at ${proxyUrl} refuses this machine's key (HTTP ${response.status}).`;
  const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
  const ids = Array.isArray(body?.data) ? (body.data as Array<{ id?: unknown } | null>).map((model) => model?.id) : undefined;
  if (!ids?.every((id): id is string => typeof id === "string" && id.length > 0)) return `The proxy at ${proxyUrl} answers without a model list.`;
  return ids;
}

const servedModel = { claude: (id: string) => id.includes("claude"), codex: (id: string) => id.startsWith("gpt-") };
const missingModel = {
  claude: `The proxy at ${proxyUrl} lists no Claude model. On the hub, run hedge cli-proxy doctor.`,
  codex: `The proxy at ${proxyUrl} lists no Codex model. Add one of your own Codex subscriptions to the hub's proxy.`,
};

function unserved(models: string[] | string, provider: "claude" | "codex"): string | undefined {
  if (typeof models === "string") return models;
  return models.some(servedModel[provider]) ? undefined : missingModel[provider];
}

async function answering(machine: ProxyMachine, key: string): Promise<string[] | string> {
  let models = await listModels(machine.fetch, key);
  for (let attempt = 1; attempt < answerTries && models === silent; attempt++) {
    await machine.sleep(1000);
    models = await listModels(machine.fetch, key);
  }
  return models;
}

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function readClaude(home: string) {
  const path = join(home, ".claude/settings.json");
  await refuseLinks(home, path, "Claude settings path");
  const text = await readIfThere(path);
  const settings = text === undefined ? {} : (JSON.parse(text) as Settings);
  if (!isObject(settings) || (settings.env !== undefined && !isObject(settings.env))) throw new Error(`${path} is not a Claude settings object. Fix it, then run this again.`);
  return { path, text, settings };
}

async function leaveClaude(home: string): Promise<void> {
  const { path, text, settings } = await readClaude(home);
  if (text === undefined) return;
  const before = JSON.stringify(settings);
  const env = settings.env ?? {};
  if (env.ANTHROPIC_BASE_URL === proxyUrl) delete env.ANTHROPIC_BASE_URL;
  if (settings.env && !Object.keys(env).length) delete settings.env;
  if (ownHelper(settings.apiKeyHelper)) delete settings.apiKeyHelper;
  if (JSON.stringify(settings) !== before) await replaceUnchanged(path, text, `${JSON.stringify(settings, null, 2)}\n`);
}

async function replaceUnchanged(path: string, before: string | undefined, after: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.${randomUUID()}.partial`;
  await writeFile(partial, after, { mode: 0o600, flag: "wx" });
  try {
    if ((existsSync(path) ? readFileSync(path, "utf8") : undefined) !== before) throw new Error(`${path} changed while Hedge wrote it. Run this again.`);
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
}

const codexUrl = codexProviderTable.base_url;
const fleetProvider = "fleet-proxy";
const fleetProviderTable = { name: "Fleet CLI proxy", base_url: codexUrl, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", fleetKeyHelper] } };

function withoutFleetProvider(config: Record<string, unknown>): boolean {
  const providers = config.model_providers as Record<string, unknown> | undefined;
  if (!Bun.deepEquals(providers?.[fleetProvider], fleetProviderTable)) return false;
  delete providers![fleetProvider];
  if (!Object.keys(providers!).length) delete config.model_providers;
  if (config.model_provider !== fleetProvider) return false;
  delete config.model_provider;
  return true;
}

async function readCodex(home: string) {
  const path = join(home, ".codex/config.toml");
  await refuseLinks(home, path, "Codex config path");
  const text = await readIfThere(path);
  let config: unknown = {};
  try { if (text !== undefined) config = parse(text); }
  catch { config = undefined; }
  if (!isObject(config) || (config.model_providers !== undefined && !isObject(config.model_providers))) throw new Error(`${path} is not a Codex config. Fix it, then run this again.`);
  const fleetRouted = withoutFleetProvider(config);
  const providers = config.model_providers as Record<string, unknown> | undefined;
  const table = providers?.[codexProvider];
  const url = isObject(table) ? table.base_url : undefined;
  const routed = config.model_provider === codexProvider && (url === undefined || url === codexUrl);
  return { path, text, config, providers, routed: routed || fleetRouted, untouched: Bun.deepEquals(table, codexProviderTable) };
}

const readableCodex = (home: string) => readCodex(home).catch(() => undefined);

async function sendCodexHome(home: string): Promise<boolean> {
  const read = await readableCodex(home);
  if (!read) return false;
  const { path, text, config, providers, routed, untouched } = read;
  if (routed && config.model_provider === codexProvider) delete config.model_provider;
  if (untouched) delete providers![codexProvider];
  if (providers && !Object.keys(providers).length) delete config.model_providers;
  if (routed || untouched) await replaceUnchanged(path, text, Object.keys(config).length ? `${stringify(config)}\n` : "");
  return routed;
}

export type Agent = "claude" | "codex";

const applyWaits = (name: string) => `hedge apply keeps ${name} on its own sign-in until the proxy serves it.`;
const applyHolds = (name: string) => `hedge apply keeps the ${name} settings as they are until it answers.`;

async function check(machine: ProxyMachine, agent: Agent): Promise<number> {
  const hub = readRole(machine.home) === "hub";
  const danger = hub ? await unsafe(machine, layout(machine.home)) : undefined;
  const key = await savedKey(machine.home);
  const noKey = `This machine has no proxy key at ${keyPath(machine.home)}. On the hub, hedge cli-proxy doctor prints the connect command.`;
  const models = key ? await listModels(machine.fetch, key) : noKey;
  const reason = danger ?? (agent === "claude" ? unserved(models, "claude") : await codexUnserved(machine.home, models));
  const name = agent === "claude" ? "Claude Code" : "Codex";
  machine.print(reason ? `${reason} ${reason === silent ? applyHolds(name) : applyWaits(name)}` : `${name} reaches your own-account proxy at ${proxyUrl}.`);
  if (!reason) return 0;
  if (reason === silent) return cannotTell;
  return reason === missingModel[agent] || (reason === noKey && !hub) ? waitsForPerson : 1;
}

async function codexUnserved(home: string, models: string[] | string): Promise<string | undefined> {
  const config = await readableCodex(home);
  const table = config?.providers?.[codexProvider];
  if (table !== undefined && !reachesProxy(table)) return ownTable(config!.path);
  return unserved(models, "codex");
}

const reachesProxy = (table: unknown) => isObject(table) && (["base_url", "wire_api", "auth"] as const).every((field) => Bun.deepEquals(table[field], codexProviderTable[field]));
const ownTable = (path: string) => `${path} has its own ${codexProvider} provider table, which does not reach the proxy with this machine's key.`;

const agentNames = { claude: "Claude Code", codex: "Codex", both: "Claude Code and Codex" };

async function connect(machine: ProxyMachine): Promise<void> {
  if (readRole(machine.home) === "hub") throw new Error("The hub has its own key. Run hedge cli-proxy install there.");
  const key = (await machine.readStdin()).trim();
  if (!keyPattern.test(key)) throw new Error("Pass the proxy key from the hub on standard input: 64 hexadecimal characters.");
  const models = await answering(machine, key);
  if (typeof models === "string") throw new Error(`${models} Nothing changed.`);
  await refuseLinks(machine.home, keyPath(machine.home), `${what} path`);
  await mkdir(dirname(keyPath(machine.home)), { recursive: true, mode: 0o700 });
  await writePrivateFile(keyPath(machine.home), `${key}\n`);
  const agents = agentNames[machine.plan ?? "claude"];
  machine.print(`Saved the proxy key. Run hedge apply now: it sends ${agents} to your own-account proxy at ${proxyUrl}, or says why it cannot yet. Then restart open ${agents} sessions.`);
}

async function disconnect(machine: ProxyMachine): Promise<void> {
  if (readRole(machine.home) === "hub") throw new Error("On the hub, turn the workflow off instead: hedge packs --workflows own-account-balancing=off");
  await leaveClaude(machine.home);
  const codex = await sendCodexHome(machine.home);
  await refuseLinks(machine.home, keyPath(machine.home), `${what} path`);
  await rm(keyPath(machine.home), { force: true });
  machine.print("Claude Code no longer uses the proxy. To sign in again, run claude and enter /login, then restart open Claude Code sessions.");
  if (codex) machine.print(`Codex no longer uses the proxy. To sign in again, run codex login -c 'cli_auth_credentials_store="file"' --device-auth, then restart open Codex sessions.`);
  machine.print("hedge apply keeps this machine on its own sign-in while it has no proxy key.");
}

async function plan(machine: ProxyMachine, paths: Layout): Promise<void> {
  if (readRole(machine.home) !== "hub") {
    const key = await savedKey(machine.home);
    const agents = machine.plan === "codex" ? "Codex uses" : machine.plan === "both" ? "Claude Code and Codex use" : "Claude Code uses";
    return machine.print(key ? `CLI proxy plan (no changes): this machine has a proxy key, and ${agents} the proxy at ${proxyUrl} through the hub's tunnel while the proxy serves them.` : "CLI proxy plan (no changes): this machine has no proxy key. On the hub, hedge cli-proxy doctor prints the connect command.");
  }
  machine.print("CLI proxy plan (no changes):");
  if (!(await binaryReady(machine, paths))) machine.print(`  Install CLIProxyAPI ${machine.release.version} at ${paths.binary}.`);
  machine.print(`  Run it at ${proxyUrl}, loopback only, with fill-first routing and session affinity, as ${service}.`);
  machine.print(`  Serve Codex upstream's model catalog with the ultrafast tier added, from ${paths.catalog}.`);
  machine.print(`  Route by upstream's model registry with the models it does not list yet added, from ${paths.registry}.`);
  machine.print(`  Keep the client key in ${paths.key} and the management key in ${paths.management}, both mode 600.`);
  machine.print(machine.panel
    ? `  Serve the management panel ${machine.panel.page.version} at ${panelUrl}, loopback only, with ${machine.panel.historyDays} days of quota history from the quota-ledger plugin ${machine.panel.plugin.version}.`
    : "  Keep the management panel off. Turn on the Proxy panel workflow to serve it.");
  const agent = pooled(machine.plan);
  machine.print(agent === "claude" ? "  Every 5 minutes, hedge cli-proxy-balance puts the subscription whose weekly quota resets first on top." : "  Every 5 minutes, hedge cli-proxy-balance frees each subscription whose quota cooldown its live usage disproves.");
  machine.print(`  Add at least ${machine.accounts ?? 2} of your own ${subscription[agent]} subscriptions with: ${loginCommand(paths, agent)}`);
}

export async function cliProxy(mode: ProxyMode, machine: ProxyMachine, agent: Agent = "claude"): Promise<number> {
  if (machine.uid === 0) throw new Error("Run hedge cli-proxy as the person who runs Claude Code, not root.");
  const paths = layout(machine.home);
  if (mode === "install" || mode === "doctor" || mode === "accounts" || mode === "catalog") requireHubRole(machine.home, `cli-proxy ${mode}`);
  if (mode === "catalog") return catalog(machine, paths);
  if (mode === "accounts") return accounts(machine, paths);
  if (mode === "plan") await plan(machine, paths);
  if (mode === "install") await install(machine, paths);
  if (mode === "doctor") await doctor(machine, paths);
  if (mode === "connect") await connect(machine);
  if (mode === "disconnect") await disconnect(machine);
  if (mode === "check") return check(machine, agent);
  if (mode === "left") return (await ownedFiles(machine.home, [paths.unit], marker, what)).length ? 0 : 1;
  if (mode === "remove") await removeUnits(machine.home, [paths.unit], marker, what, machine.run);
  return 0;
}
