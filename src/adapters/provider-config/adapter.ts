import { join } from "node:path";
import { inside } from "../../files/install.ts";
import type { Action, Finding, Plan, Provider } from "../../pack/types.ts";
import { todoLines, type Adapter, type AdapterResult } from "../../reconciler/apply.ts";
import { spawnRunner, type CommandRunner } from "../run.ts";
import { codexHookTrust, isTrustOf } from "./codex-hooks.ts";
import { checkPath, get, json, keyPath, overlaps, remove, same, samePath, set, toml, type Document, type Field, type Format } from "./fields.ts";
import { declaredMarketplaces, reconcilePlugins } from "./plugins.ts";
import { proxyRoute } from "./proxy-route.ts";
import { claudeJson, isMcpServer, reconcileServers, wantedServers } from "./claude-servers.ts";
import { linkOnPath, optional, readState, withLock, writeWithBackups, type Write } from "./store.ts";

export type { CommandRunner } from "../run.ts";

/** owns says which of the provider's keys live in this file. */
type Target = { provider: Provider; path: string; format: Format; owns(path: string[]): boolean };
export type FieldRecord = { [target: string]: Field[] };
type Merged = { record: Field[]; kept: string[]; reason: string; after?: string; document: Document; todo?: string };
type FilesResult = AdapterResult & { plugins?: string[]; claudeEnabled?: Record<string, boolean>; marketplaces?: Record<string, string | null>; codexPlugins?: string[] };

export const recordTarget = ".config/hedge/provider-fields.json";
const claudeSettings = ".claude/settings.json";

/** Claude MCP servers live in ~/.claude.json, which Claude Code writes itself, so claude-servers.ts adds them through claude mcp. */
export const configTargets: Target[] = [
  { provider: "claude", path: claudeSettings, format: json, owns: (path) => !isMcpServer(path) },
  { provider: "codex", path: ".codex/config.toml", format: toml, owns: () => true },
];

const ownedBy = (target: Target) => (entry: { provider: Provider; key: string }) => entry.provider === target.provider && target.owns(keyPath(entry.key));

export function providerConfigAdapter(options: { run?: CommandRunner } = {}): Adapter {
  const run = options.run ?? spawnRunner;
  return {
    name: "config",
    targets: (plan) => [...configTargets.filter((target) => plan.config.some(ownedBy(target))).map((target) => target.path), ...(wantedServers(plan).length ? [claudeJson] : [])],
    async apply(plan, context) {
      const outage = sourceOutage(plan);
      const gated = gatedKeys(plan);
      const reconcile = async () => {
        const { plugins, claudeEnabled, marketplaces, codexPlugins, ...result } = await reconcileFiles(plan, context.home, context.dryRun, context.adopt, outage, gated);
        const written = result.findings.filter((finding) => finding.todo);
        try {
          result.findings.push(...(await reconcilePlugins(plan, context.home, context.dryRun, run, { outage, accepted: plugins, claudeEnabled, marketplaces, acceptedCodex: codexPlugins })));
          const servers = await reconcileServers(plan, context.home, { dryRun: context.dryRun, adopt: context.adopt.includes(claudeJson), outage, gated: gatedPath(gated, "claude"), run });
          result.actions.push(...servers.actions);
          result.findings.push(...servers.findings);
        } catch (error) {
          throw written.length ? new Error(`${(error as Error)?.message ?? error}${todoLines(written)}`) : error;
        }
        return result;
      };
      const result = context.dryRun ? await reconcile() : await withLock(context.home, reconcile);
      if (outage) result.findings.push({ id: "config:outage", pack: "engine", say: "Kept every provider setting and plugin that Hedge would remove until all your pack sources can be fetched.", repair: "apply" });
      return result;
    },
  };
}

async function reconcileFiles(plan: Plan, home: string, dryRun: boolean, adopt: string[], outage: boolean, gated: string[]): Promise<FilesResult> {
  const previous = await readFieldRecord(home);
  const next: FieldRecord = {};
  const writes: Array<Write & { action: Action }> = [];
  const result: FilesResult = { actions: [], findings: [] };
  for (const target of configTargets) {
    const old = previous[target.path] ?? [];
    const keepOld = () => void (old.length && (next[target.path] = old));
    const before = await optional(inside(home, target.path));
    const link = await linkOnPath(home, target.path);
    const fields = owned(plan, target);
    let merged: Merged;
    try {
      merged = merge(target, before, old, fields, adopt.includes(target.path), { outage, gated: gatedPath(gated, target.provider), configPath: join(home, target.path) });
    } catch (error) {
      keepOld();
      result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} as it is: Hedge cannot read it (${(error as Error).message}). Fix the file, then run hedge apply.`, repair: "human" });
      continue;
    }
    if (merged.after !== undefined && link) {
      keepOld();
      result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} because ${link === inside(home, target.path) ? "it is a link" : `${link} is a link`}. Hedge would ${merged.reason} there. Make it a plain file in a plain folder to let Hedge change it.` });
      continue;
    }
    if (merged.record.length) next[target.path] = merged.record;
    if (target.path === claudeSettings && !link) {
      result.plugins = acceptedPlugins(merged.document);
      result.claudeEnabled = enabledState(merged.document);
      result.marketplaces = declaredMarketplaces(merged.document);
    }
    if (target.provider === "codex" && !link) result.codexPlugins = acceptedCodexPlugins(merged.document);
    if (merged.todo && !dryRun) result.findings.push({ id: `route:${target.path}`, pack: "engine", say: merged.todo, todo: true });
    if (merged.kept.length) result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept your ${merged.kept.join(", ")} in ${target.path}. Run hedge apply --adopt ${target.path} to take Hedge's value.` });
    if (merged.after !== undefined) writes.push({ target: target.path, before, after: merged.after, action: { target: target.path, operation: before === undefined ? "create" : "replace", reason: merged.reason } });
  }
  if (dryRun) {
    for (const write of writes) result.findings.push({ id: `config:${write.target}`, pack: "engine", say: `${write.target} needs an update: ${write.action.reason}.`, repair: "apply" });
    return result;
  }
  const recordText = `${JSON.stringify(next, null, 2)}\n`;
  const recordBefore = await readState(home, recordTarget);
  await writeWithBackups(home, recordBefore === recordText ? writes : [...writes, { target: recordTarget, before: recordBefore, after: recordText }]);
  result.actions.push(...writes.map((write) => write.action));
  return result;
}

function owned(plan: Plan, target: Target): Field[] {
  const fields = plan.config.filter(ownedBy(target)).map((entry) => ({ path: keyPath(entry.key), value: entry.value, pack: entry.pack }));
  fields.forEach((field, index) => {
    const other = fields.slice(index + 1).find((item) => overlaps(item.path, field.path));
    if (other) throw new Error(`${target.provider} keys ${field.path.join(".")} (${field.pack}) and ${other.path.join(".")} (${other.pack}) overlap. Each key owns its whole value, so a pack must own only one of them.`);
  });
  return fields;
}

function merge(target: Target, text: string | undefined, previous: Field[], wanted: Field[], adopt: boolean, options: { outage: boolean; gated: (path: string[]) => boolean; configPath: string }): Merged {
  const current: Document = text === undefined ? {} : target.format.decode(text);
  const original = target.format.encode(current);
  const record: Field[] = [];
  const kept: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const route = proxyRoute[target.provider];
  const routeOnDisk = (route?.fields ?? []).filter((item) => same(get(current, item.path), item.value));
  const onRoute = (field: Field) => route?.fields.some((item) => samePath(item.path, field.path) && same(item.value, field.value)) ?? false;
  const oldOf = (field: Field) => previous.find((item) => samePath(item.path, field.path));
  const keeps = (field: Field) => {
    const value = get(current, field.path);
    const old = oldOf(field);
    return !same(value, field.value) && value !== undefined && !(old && same(value, old.value)) && !adopt;
  };
  const routeHeld = wanted.some((field) => onRoute(field) && keeps(field));
  const reconcile = (fields: Field[]) => {
    const applied: Field[] = [];
    for (const field of fields) {
      const old = oldOf(field);
      if (keeps(field) || (routeHeld && onRoute(field))) {
        if (keeps(field)) kept.push(field.path.join("."));
        if (old) record.push(old);
        continue;
      }
      const value = get(current, field.path);
      if (!same(value, field.value)) {
        set(current, field.path, field.value);
        changed.push(field.path.join("."));
      }
      record.push(field);
      applied.push(field);
    }
    return applied;
  };
  const applied = reconcile(wanted);
  const trust: Field[] = [];
  const departed = previous.filter((field) => !wanted.some((item) => overlaps(item.path, field.path)) && !isHookTrust(field));
  const keepsEdit = (field: Field) => get(current, field.path) !== undefined && !same(get(current, field.path), field.value);
  if (target.provider === "codex") {
    const isEvent = (field: Field) => field.path[0] === "hooks" && field.path.length === 2;
    const keptEvents = [...wanted.filter((field) => isEvent(field) && !applied.includes(field)), ...departed.filter((field) => isEvent(field) && (options.outage || keepsEdit(field)))].map((field) => field.path[1]!);
    trust.push(...reconcile(codexHookTrust(applied, options.configPath)));
    const retained = previous.filter((field) => keptEvents.some((event) => isTrustOf(field, options.configPath, event)) && !trust.some((item) => samePath(item.path, field.path)));
    record.push(...retained);
    trust.push(...retained);
  }
  const all = [...wanted, ...trust];
  for (const field of previous) {
    if (all.some((item) => overlaps(item.path, field.path))) continue;
    if ((options.outage && !options.gated(field.path)) || keepsEdit(field)) record.push(field);
    else if (get(current, field.path) !== undefined) {
      remove(current, field.path);
      removed.push(field.path.join("."));
    }
  }
  const routeLeft = routeOnDisk.filter((item) => !same(get(current, item.path), item.value)).map((item) => item.path);
  const setByPack = (path: string[]) => wanted.some((field) => overlaps(field.path, path) && same(get(current, path), get({ value: field.value }, ["value", ...path.slice(field.path.length)])));
  const beside = (route?.beside(current, routeLeft) ?? []).filter((path) => !setByPack(path));
  for (const path of beside) {
    remove(current, path);
    removed.push(path.join("."));
  }
  const reason = [changed.length ? `set ${changed.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  const after = target.format.encode(current);
  const todo = beside.length ? `Took Hedge's proxy route out of ${target.path}, and with it your ${beside.map((path) => path.join(".")).join(", ")}, which only worked through that route.` : undefined;
  return { record: record.filter((field) => !beside.some((path) => overlaps(path, field.path))), kept: kept.filter((path) => !beside.some((item) => item.join(".") === path)), reason, after: after === original ? undefined : after, document: current, ...(todo ? { todo } : {}) };
}

function acceptedPlugins(document: Document) {
  const enabled = get(document, ["enabledPlugins"]);
  return enabled && typeof enabled === "object" ? Object.entries(enabled).flatMap(([id, on]) => (on === true ? [id] : [])) : [];
}

function enabledState(document: Document): Record<string, boolean> {
  const enabled = get(document, ["enabledPlugins"]);
  return enabled && typeof enabled === "object" ? Object.fromEntries(Object.entries(enabled).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : {};
}

function acceptedCodexPlugins(document: Document) {
  const plugins = get(document, ["plugins"]);
  return plugins && typeof plugins === "object" ? Object.entries(plugins).flatMap(([id, entry]) => (get(entry as Document, ["enabled"]) === true ? [id] : [])) : [];
}

const isHookTrust = (field: Field) => field.path[0] === "hooks" && field.path[1] === "state";

/** The provider:key of each config entry the gate dropped because its check fails. An outage never keeps these. */
function gatedKeys(plan: Plan) {
  return plan.dropped.flatMap((entry) => (entry.check && entry.item.startsWith("config ") ? [entry.item.slice("config ".length)] : []));
}

/** Whether a path overlaps a config key of this provider that the gate dropped, so an outage does not keep it. */
function gatedPath(gated: string[], provider: Provider) {
  const paths = gated.filter((key) => key.startsWith(`${provider}:`)).map((key) => keyPath(key.slice(provider.length + 1)));
  return (path: string[]) => paths.some((item) => overlaps(item, path));
}

/** True while an enabled pack is missing because its source cannot be fetched. Its settings must not look departed. */
export function sourceOutage(plan: Plan) {
  return plan.packs.some((pack) => !pack.available && (pack.reason ?? "").startsWith("not found; unreachable"));
}

export async function readFieldRecord(home: string, target = recordTarget): Promise<FieldRecord> {
  const text = await readState(home, target);
  if (text === undefined) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${target} is not a field record`);
  const record: FieldRecord = {};
  for (const [file, fields] of Object.entries(value)) {
    if (!Array.isArray(fields) || fields.some((field) => !Array.isArray(field?.path) || field.path.some((key: unknown) => typeof key !== "string"))) throw new Error(`${target} holds an invalid field path`);
    for (const field of fields) checkPath(field.path, `${target} path ${field.path.join(".")}`);
    record[file] = fields;
  }
  return record;
}
