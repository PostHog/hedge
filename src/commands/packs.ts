import type { HumanStep, Owned, Plan } from "../pack/types.ts";
import { oldNameOnly } from "../pack/aliases.ts";
import { keptWorkflows, workflowDefaults } from "../profile/profile.ts";
import { FlagError, parseSetupFlags } from "../setup/flags.ts";
import { memoryRepo, namedMemory, newMemoryRepo, shareableProfileOrigin } from "../setup/profile.ts";
import { catalogAliases, changedPacks, settingsFrom, title, unmetNeeds } from "../setup/questions.ts";
import { activePacks, type ChangeContext, manifests, saveAndApply } from "./change.ts";

const usage = "hedge packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]...";

/** Lists the packs, or turns packs and workflows on and off. */
export async function packsCommand(args: string[], context: ChangeContext): Promise<number> {
  const flags = parseSetupFlags(args);
  if (flags.preset !== undefined || flags.plan !== undefined || flags.devbox !== undefined || flags.nonInteractive) throw new FlagError(`usage: ${usage}`);
  if (!flags.add.length && !flags.remove.length && !Object.keys(flags.workflows).length && !Object.keys(flags.set).length) return await listPacks(context), 0;

  const known = manifests(context);
  const aliases = catalogAliases(context);
  const names = new Set(known.filter((manifest) => manifest.name !== "base").map((manifest) => manifest.name));
  for (const name of [...flags.add, ...flags.remove]) {
    if (name === "base") throw new FlagError("the base pack is always on");
    if (!names.has(name) && !aliases.has(name)) throw new FlagError(`no pack named ${name}. Packs: ${[...names].join(", ")}`);
  }
  const defaults = workflowDefaults(known);
  for (const id of Object.keys(flags.workflows)) if (!Object.hasOwn(defaults, id)) throw new FlagError(`--workflows: no workflow named ${id}`);
  const settings = settingsFrom(flags, { packs: context.packs });

  const packs = changedPacks(context.profile.packs, flags.add, flags.remove);
  const listed = (list: string[], name: string) => list.some((item) => (aliases.get(item)?.pack ?? item) === name);
  const [unmet] = unmetNeeds(packs, { packs: context.packs });
  if (unmet) throw new FlagError(`${title(unmet.pack, context.packs)} needs ${unmet.needs.map((name) => title(name, context.packs)).join(", ")}. Add ${unmet.needs.join(", ")}, or remove ${unmet.pack}.`);
  const workflows = keptWorkflows(context.profile.workflows, flags.workflows, known);
  for (const manifest of known) {
    for (const workflow of manifest.workflows ?? []) {
      if (!workflow.risk) continue;
      const wasOn = listed(context.profile.packs, manifest.name) && (context.profile.workflows[workflow.id] ?? workflow.default);
      const isOn = listed(packs, manifest.name) && (workflows[workflow.id] ?? workflow.default);
      if (isOn && (!wasOn || flags.workflows[workflow.id] === true)) context.print(`Before you use ${workflow.name}: ${workflow.risk}`);
    }
  }
  if (flags.add.includes("memory") && packs.includes("memory")) {
    const { named, kind } = namedMemory({ ...context.profile.settings, ...settings });
    const existing = await memoryRepo(context.machine, named, undefined, kind);
    if (existing) {
      await existing.make(context.print);
      if (existing.repo !== named) settings[existing.key] = existing.repo;
    } else {
      const profile = await shareableProfileOrigin(context.machine, context.profileDir);
      if (profile) {
        context.print(`✓ Using ${profile} for memory and context`);
        settings["context.repo"] = profile;
      } else {
        const created = await newMemoryRepo(context.machine);
        await created.make(context.print);
        settings[created.key] = created.repo;
      }
    }
  }
  const after = context.preview({ packs, workflows, settings: { ...context.profile.settings, ...settings } }).workflows;
  for (const [id, on] of Object.entries(flags.workflows)) {
    const state = after.find((workflow) => workflow.id === id);
    if (on && state && !state.active && state.reason) context.print(`${id} is on in your profile, but stays off: ${state.reason}.`);
  }
  return saveAndApply(context, { packs, workflows, settings }, "your packs");
}

function affectedWorkflows(plan: Plan, steps: Array<Owned<HumanStep>>): Set<string> {
  const ids = new Set<string>();
  const gated = [
    ...plan.jobs,
    ...plan.steps,
    ...plan.config,
    ...(plan.onHub ? (plan.catalog ?? []) : []),
  ];
  for (const step of steps) {
    if (step.workflow) ids.add(step.workflow);
    for (const item of gated) {
      if (item.workflow && item.after === step.id && item.pack === step.pack) ids.add(item.workflow);
    }
  }
  return ids;
}

async function listPacks(context: ChangeContext) {
  const on = new Set(activePacks(context).map((manifest) => manifest.name));
  const aliases = catalogAliases(context);
  const partly = oldNameOnly(aliases, context.profile.packs);
  const missing = context.plan.packs.filter((pack) => !pack.available);
  const left = context.humanLeft ? await context.humanLeft() : { failing: [], unchecked: [] };
  const failingPacks = new Set(left.failing.map((step) => step.pack));
  const uncheckedPacks = new Set(left.unchecked.map((step) => step.pack));
  const failingWorkflows = affectedWorkflows(context.plan, left.failing);
  const uncheckedWorkflows = affectedWorkflows(context.plan, left.unchecked);
  const workflowState = (workflow: Plan["workflows"][number]) => {
    if (!workflow.active) return workflow.reason && workflow.reason !== "turned off" ? `off: ${workflow.reason}` : "off";
    if (failingWorkflows.has(workflow.id)) return "needs setup";
    if (uncheckedWorkflows.has(workflow.id)) return "not checked";
    return "on";
  };
  context.print("Your packs:");
  for (const manifest of manifests(context)) {
    const needsSetup = on.has(manifest.name) && failingPacks.has(manifest.name);
    const notChecked = on.has(manifest.name) && !needsSetup && uncheckedPacks.has(manifest.name);
    const mark =
      needsSetup ? "~"
      : notChecked ? "?"
      : manifest.name === "base" || (on.has(manifest.name) && !partly.has(manifest.name)) ? "✓"
      : "·";
    context.print(`  ${mark} ${manifest.name}  ${manifest.summary}`);
    if (on.has(manifest.name) && partly.has(manifest.name))
      for (const name of context.profile.packs.filter((name) => aliases.get(name)?.pack === manifest.name)) context.print(`      The old name ${name} selects only: ${aliases.get(name)!.workflows.join(", ")}. Add ${manifest.name} for the whole pack.`);
    const workflows = context.plan.workflows.filter((workflow) => workflow.pack === manifest.name);
    if (on.has(manifest.name) && workflows.length) context.print(`      Workflows: ${workflows.map((workflow) => `${workflow.id} ${workflowState(workflow)}`).join(", ")}`);
    if (on.has(manifest.name)) for (const workflow of manifest.workflows ?? []) if (workflow.risk) context.print(`      Terms note for ${workflow.id}: ${workflow.risk}`);
  }
  for (const pack of missing) context.print(`  ! ${pack.name}  is in your profile, but ${pack.reason ?? "its source is not here"}`);
  if (left.failing.length) context.print("Some packs still need setup on this machine. Run hedge doctor to see what is left.");
  if (left.unchecked.length) context.print("Some setup checks did not finish in time. Run hedge doctor to check them.");
  context.print("");
  context.print(`Change them with ${usage}.`);
}
