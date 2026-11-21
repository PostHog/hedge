import { join } from "node:path";
import type { Finding, Plan } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import { readFieldRecord, type FieldRecord } from "../provider-config/adapter.ts";
import { checkPath, get, isDocument, json, same, samePath, type Document, type Field } from "../provider-config/fields.ts";
import { readState, writeWithBackups, type Write } from "../provider-config/store.ts";
import { holds, isProviderInstance, reconcileKeys, type Reconciled } from "./keys.ts";
import type { T3Rpc } from "./port.ts";

export const settingsTarget = ".t3/userdata/settings.json";
export const desktopTarget = ".t3/userdata/desktop-settings.json";
export const recordTarget = ".config/hedge/t3-settings.json";

type Options = { adopt: string[]; dryRun: boolean; outage: boolean; rpc?: T3Rpc };

const finding = (id: string, say: string, repair?: Finding["repair"]): Finding => ({ id, pack: "engine", say, ...(repair ? { repair } : {}) });

const instancesKey = "providerInstances.";

export function settingsFields(plan: Plan): Field[] {
  return plan.config.filter((entry) => entry.provider === "t3").map((entry) => {
    const path = entry.key.startsWith(instancesKey) ? ["providerInstances", entry.key.slice(instancesKey.length)] : [entry.key];
    return { path: checkPath(path, `t3 key ${entry.key}`), value: entry.value, pack: entry.pack };
  });
}

function underHome(field: Field, home: string): Field {
  const value = field.value as { config?: { binaryPath?: unknown } };
  const binary = isProviderInstance(field.path) ? value.config?.binaryPath : undefined;
  if (typeof binary !== "string" || !binary.startsWith("~/")) return field;
  return { ...field, value: { ...value, config: { ...value.config, binaryPath: join(home, binary.slice(2)) } } };
}

export function desktopFields(plan: Plan): Field[] {
  if (plan.os !== "darwin") return [];
  return [
    { path: ["updateChannel"], value: "nightly", pack: "engine" },
    { path: ["updateChannelConfiguredByUser"], value: true, pack: "engine" },
  ];
}

export async function readT3Settings(rpc: T3Rpc): Promise<Document> {
  return (await rpc.call<{ settings: Document }>("server.getConfig", {})).settings;
}

export async function reconcileSettings(plan: Plan, home: string, options: Options): Promise<AdapterResult> {
  const result: AdapterResult = { actions: [], findings: [] };
  const previous = await readFieldRecord(home, recordTarget);
  const next: FieldRecord = {};
  const writes: Array<Write & { reason: string }> = [];
  for (const [target, fields] of [[settingsTarget, settingsFields(plan).map((field) => underHome(field, home))], [desktopTarget, desktopFields(plan)]] as const) {
    const old = previous[target] ?? [];
    let before: string | undefined;
    let current: Document;
    try {
      before = await readState(home, target);
      current = before === undefined ? {} : json.decode(before);
    } catch (error) {
      if (old.length) next[target] = old;
      result.findings.push(finding(`kept:${target}`, `Kept ${target} as it is: Hedge cannot read it (${(error as Error).message}). Fix the file, then run hedge apply.`, "human"));
      continue;
    }
    if (target === desktopTarget && current.updateChannelConfiguredByUser === true && current.updateChannel === undefined && !options.adopt.includes(target)) {
      if (old.length) next[target] = old;
      continue;
    }
    const adopt = options.adopt.includes(target) || (target === desktopTarget && current.updateChannelConfiguredByUser !== true);
    if (target === settingsTarget && options.rpc) {
      const effective = await readT3Settings(options.rpc);
      const merged = reconcileKeys(effectiveView(current, old, effective), old, fields, { adopt, outage: options.outage, matches: holds });
      keptFinding(target, merged, result);
      const sent = await throughServer(options.rpc, merged, effective, options.dryRun, result);
      const record = merged.record.flatMap((field) => (sent.refused.includes(field) ? heldBefore(field, effective, old) : [sent.stillOn.find((item) => samePath(item.path, field.path)) ?? field]));
      if (record.length) next[target] = record;
      continue;
    }
    const merged = reconcileKeys(current, old, fields, { adopt, outage: options.outage });
    keptFinding(target, merged, result);
    if (merged.record.length) next[target] = merged.record;
    const reason = [merged.changed.length ? `set ${merged.changed.join(", ")}` : "", merged.removed.length ? `remove ${merged.removed.join(", ")}` : "", merged.disabled.length ? `turn off ${merged.disabled.map(name).join(", ")}` : ""].filter(Boolean).join("; ");
    if (reason) writes.push({ target, before, after: json.encode(merged.document), reason });
  }
  if (options.dryRun) {
    for (const write of writes) result.findings.push(finding(`t3:${write.target}`, `${write.target} needs an update: ${write.reason}.`, "apply"));
    return result;
  }
  const recordBefore = await readState(home, recordTarget);
  const recordText = `${JSON.stringify(next, null, 2)}\n`;
  const recordChanged = recordBefore !== recordText && !(recordBefore === undefined && !Object.keys(next).length);
  await writeWithBackups(home, recordChanged ? [...writes, { target: recordTarget, before: recordBefore, after: recordText }] : writes);
  result.actions.push(...writes.map((write) => ({ target: write.target, operation: write.before === undefined ? ("create" as const) : ("replace" as const), reason: write.reason })));
  return result;
}

function effectiveView(file: Document, old: Field[], effective: Document): Document {
  const keys = new Set([...Object.keys(file), ...old.map((field) => field.path[0]!)]);
  return Object.fromEntries([...keys].map((key) => [key, key in effective ? effective[key] : file[key]]).filter(([, value]) => value !== undefined));
}

const name = (field: Field) => field.path.join(".");
const instanceId = (field: Field) => field.path[1]!;
const off = { enabled: false };

function heldBefore(field: Field, effective: Document, old: Field[]): Field[] {
  if (isProviderInstance(field.path)) return old.filter((item) => samePath(item.path, field.path));
  const value = get(effective, field.path);
  return value === undefined ? [] : [{ ...field, value }];
}

function keptFinding(target: string, merged: Reconciled, result: AdapterResult) {
  if (merged.kept.length) result.findings.push(finding(`kept:${target}`, `Kept your ${merged.kept.join(", ")} in ${target}. Run hedge apply --adopt ${target} to take Hedge's value.`));
}

type Sent = { refused: Field[]; stillOn: Field[] };

const takes = (field: Field, actual: unknown) => (isProviderInstance(field.path) ? same : holds)(actual, field.value);

async function throughServer(rpc: T3Rpc, merged: Reconciled, effective: Document, dryRun: boolean, result: AdapterResult): Promise<Sent> {
  if (merged.removed.length) result.findings.push(finding("t3:dropped", `Hedge no longer sets ${merged.removed.join(", ")} in T3 Code. T3 Code keeps the current value; change it in T3 Code's settings if you like.`));
  const changed = merged.applied.filter((field) => !takes(field, get(effective, field.path)));
  const disabling = merged.disabled.filter((field) => isDocument(get(effective, field.path)) && !holds(get(effective, field.path), off));
  if (dryRun) {
    if (changed.length) result.findings.push(finding("t3:settings", `T3 Code needs these settings: ${changed.map(name).join(", ")}.`, "apply"));
    if (disabling.length) result.findings.push(finding("t3:instances", `T3 Code needs these provider instances turned off: ${disabling.map(instanceId).join(", ")}.`, "apply"));
    return { refused: [], stillOn: [] };
  }
  if (!changed.length && !disabling.length) return { refused: [], stillOn: [] };
  const patch = changed.filter((field) => !isProviderInstance(field.path));
  const sent: Field[] = [];
  let failure: unknown;
  try {
    if (patch.length) {
      await rpc.call("server.updateSettings", { patch: Object.fromEntries(patch.map((field) => [name(field), field.value])) });
      sent.push(...patch);
    }
    for (const field of changed.filter((item) => isProviderInstance(item.path))) {
      await upsertInstance(rpc, instanceId(field), field.value);
      sent.push(field);
    }
    for (const field of disabling) {
      await upsertInstance(rpc, instanceId(field), { ...(get(effective, field.path) as Document), ...off });
      sent.push(field);
    }
  } catch (error) {
    failure = error;
  }
  let lost: unknown;
  const after = await readT3Settings(rpc).catch((error: unknown) => {
    lost = error;
    return undefined;
  });
  const refused = changed.filter((field) => (after ? !takes(field, get(after, field.path)) : !sent.includes(field)));
  const stillOn = disabling.filter((field) => (after ? !holds(get(after, field.path), off) : !sent.includes(field)));
  const taken = changed.filter((field) => !refused.includes(field));
  const turnedOff = disabling.filter((field) => !stillOn.includes(field));
  if (taken.length) result.actions.push({ target: "t3 settings", operation: "replace", reason: `set ${taken.map(name).join(", ")}` });
  if (turnedOff.length) result.actions.push({ target: "t3 settings", operation: "replace", reason: `turn off ${turnedOff.map(name).join(", ")}` });
  if (refused.length) result.findings.push(finding("t3:settings", `T3 Code did not take ${refused.map(name).join(", ")}. Run hedge apply again; if it stays, set it in T3 Code's settings.`, "apply"));
  if (stillOn.length) result.findings.push(finding("t3:instances", `T3 Code did not turn off ${stillOn.map(instanceId).join(", ")}. Run hedge apply again; if it stays, turn it off in T3 Code's settings.`, "apply"));
  if (failure !== undefined || lost !== undefined) {
    result.failed = true;
    result.findings.push(finding("t3:server", failure !== undefined ? `T3 Code refused a settings write (${(failure as Error).message}). Run hedge apply again.` : `Hedge could not read back the settings T3 Code took (${(lost as Error).message}). Run hedge apply again.`, "apply"));
  }
  return { refused, stillOn };
}

async function upsertInstance(rpc: T3Rpc, instanceId: string, instance: unknown) {
  await rpc.call("server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId, instance } });
}
