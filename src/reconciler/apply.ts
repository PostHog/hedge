import { closeSync, existsSync, readdirSync, writeSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { install, plan as planFiles } from "../files/install.ts";
import { packName } from "../pack/manifest.ts";
import { cannotTell, waitsForPerson } from "../pack/types.ts";
import type { Action, CatalogEntry, Finding, HumanStep, Owned, PackCheck, Plan, Report } from "../pack/types.ts";
import { engineCommand } from "./engine-command.ts";
import { changeLedger, currentNames, ledgerKey, readLedger, renameLedger, undoVariable, type Ledger, type LedgerStep } from "./ledger.ts";
import { hublessReason, listedPack } from "./resolve.ts";
import { wholeRoutes } from "../adapters/provider-config/proxy-route.ts";
import { withLegacyNames } from "../legacy.ts";
import { bunScript } from "../runner/bun.ts";
import { appendTag, createPipe, drainControlFd, graceMs, interruptGraceMs, killDeadSession, killDeadSessionSync, killSessionSync, parseSpareLine, probeResultReported, setCloexec, supervisorEnv, tagEnvVar, waitForFdClosed, watchdogEnv } from "./probe-supervisor.ts";

export type AdapterContext = { home: string; dryRun: boolean; adopt: string[]; adoptFrom?: string[] };
export type AdapterResult = { actions: Action[]; findings: Finding[]; blocked?: boolean; failed?: boolean };
export type Adapter = {
  name: "files" | "config" | "jobs" | "identity" | "t3" | "fleet";
  /** The targets that --adopt may name for this adapter. */
  targets(plan: Plan): string[];
  apply(plan: Plan, context: AdapterContext): Promise<AdapterResult>;
};
export type Runner = (command: string[], env?: Record<string, string>, signal?: AbortSignal) => Promise<number>;
/** Fills this machine's credential for each served service: the hub issues its own, and a node pulls its own from the hub. Reports what failed. */
export type Issuer = (entries: CatalogEntry[], node: string) => Promise<Finding[]>;

export const filesGroup = "hedge";

/** Files the private Fleet wrote that a pack now replaces, which --adopt-from removes while they are unchanged. */
const retiredTargets = [".codex/rules/fleet.rules"];

/**
 * Files keeps whatever it cannot safely change: a local edit or an unmanaged
 * file (a conflict), and during a source outage every file it would replace or
 * remove, because the plan lacks the unreachable packs' parts. Held files keep
 * their ownership record, so a later apply still knows them.
 */
export const filesAdapter: Adapter = {
  name: "files",
  targets: (plan) => plan.files.map((file) => file.target),
  async apply(plan, { home, dryRun, adopt, adoptFrom = [] }) {
    const own = adopt.filter((target) => plan.files.some((file) => file.target === target));
    const choices = { adopt: own, release: adoptFrom, retire: retiredTargets };
    const first = await planFiles(home, plan.files, filesGroup, choices);
    const outage = unreachable(plan);
    const parked = outage.length ? first.filter((action) => action.operation === "remove" || action.operation === "replace") : [];
    const kept = first.filter((action) => action.operation === "conflict" && !action.owner);
    const claimed = first.filter((action) => action.operation === "conflict" && action.owner);
    if (claimed.length) return { actions: [...claimed, ...kept], findings: [...claimFindings(claimed), ...keptFindings(kept)], blocked: true };
    const hold = [...kept, ...parked].map((action) => action.target);
    const findings = [...keptFindings(kept), ...retiredFindings(first)];
    if (parked.length) {
      findings.push({ id: "outage", pack: "engine", say: `Left ${parked.map((action) => action.target).join(", ")} as they are until ${outage.join(", ")} can be fetched.`, repair: "apply" });
    }
    const preview = hold.length ? await planFiles(home, plan.files, filesGroup, { ...choices, hold }) : first;
    if (dryRun) {
      for (const action of preview.filter((item) => ["create", "replace", "remove"].includes(item.operation))) {
        findings.push({ id: `files:${action.target}`, pack: "engine", say: `${action.target} needs to ${action.operation === "create" ? "be created" : action.operation === "replace" ? "be updated" : "be removed"}.`, repair: "apply" });
      }
      return { actions: [...preview, ...kept], findings };
    }
    const { actions } = await install(home, plan.files, filesGroup, { ...choices, hold });
    return { actions: [...actions, ...kept], findings };
  },
};

function keptFindings(kept: Action[]): Finding[] {
  return kept.map((action) => ({
      id: `kept:${action.target}`,
      pack: "engine",
      say: `Kept your ${action.target} (${action.reason}). Run hedge apply --adopt ${action.target} to take Hedge's version.`,
  }));
}

function retiredFindings(actions: Action[]): Finding[] {
  return actions.filter((action) => action.operation === "keep" && action.reason).map((action) => ({ id: `kept:${action.target}`, pack: "engine", say: `Kept your ${action.target}: ${action.reason}. Remove it once you no longer need it.` }));
}

function claimFindings(claimed: Action[]): Finding[] {
  const owners = Map.groupBy(claimed, (action) => action.owner!);
  return [...owners].map(([owner, actions]) => ({
    id: `owner:${owner}`,
    pack: "engine",
    say: `Another Hedge setup keeps ${actions.length} of the files your profile writes, such as ${actions[0]!.target}, under the name ${owner} in ~/.local/state/hedge/state.json. Run hedge apply --adopt-from ${owner} to take them over. Hedge backs up that state and each file or linked folder it replaces in ~/.local/state/hedge/backups. A linked folder moves whole, with everything in it.`,
    repair: "human",
  }));
}

type ApplyOptions = { home: string; dryRun?: boolean; adopt?: string[]; adoptFrom?: string[]; skip?: string[]; adapters?: Adapter[]; run?: Runner; issue?: Issuer; progress?: (line: string) => void };
type Checked = Array<[Owned<PackCheck>, number]>;

/** Skipped steps, named pack/id, wait for a later apply: this run neither runs nor undoes them. */
export async function apply(plan: Plan, options: ApplyOptions): Promise<Report> {
  return (await reconcile(plan, options)).report;
}

async function reconcile(plan: Plan, options: ApplyOptions): Promise<{ report: Report; checks: Checked }> {
  const context = { home: options.home, dryRun: options.dryRun ?? false, adopt: options.adopt ?? [], adoptFrom: options.adoptFrom ?? [] };
  const adapters = options.adapters ?? [filesAdapter];
  const adoptable = new Set(adapters.flatMap((adapter) => adapter.targets(plan)));
  const unknown = context.adopt.filter((target) => !adoptable.has(target));
  if (unknown.length) throw new Error(`nothing to adopt at ${unknown.join(", ")}: no part of your profile writes it`);
  const report: Report = { ok: true, actions: [], findings: [], humanLeft: [] };
  report.findings.push(...packFindings(plan), ...hubFindings(plan), ...waitingFindings(plan), ...repeatFindings(plan));
  if (plan.unanswered.length) {
    report.ok = false;
    report.findings.push(...plan.unanswered.map((setting) => ({ id: `unanswered:${setting.key}`, pack: setting.key.split(".")[0] ?? "", say: `${setting.question} Answer it with hedge set ${setting.key}=<value>.`, repair: "human" as const })));
    return { report, checks: [] };
  }
  const run = viaEngine(plan, options.run ?? spawnRunner(options.home, plan.machine.profileDir));
  const node = plan.onHub || plan.pullsFromHub ? plan.machine.name : undefined;
  const issue = !context.dryRun && node && options.issue ? (ready: CatalogEntry[]) => options.issue!(ready, node) : undefined;
  const gated = await gate(plan, run, !context.dryRun, issue);
  report.findings.push(...gated.issued, ...gated.failed.map((step) => humanFinding(step, context.dryRun)));
  if (!context.dryRun && gated.failed.some(repairedByHedge)) report.ok = false;
  const afterSteps = adapters.filter((adapter) => adapter.name === "config");
  const configure = async () => {
    const checks: Checked = [];
    const runChecks = async (items: Plan["checks"]) => {
      for (const item of items) checks.push([item, await run(item.run)]);
      report.findings.push(...checks.filter(([item, code]) => code !== 0 && items.includes(item)).map(([item, code]) => checkFinding(item, code)));
    };
    const gates = plan.checks.filter((check) => plan.config.some((entry) => entry.pack === check.pack && entry.after === check.id));
    await runChecks(gates);
    const passing = (entry: Plan["config"][number]) => checks.some(([item, code]) => item.pack === entry.pack && item.id === entry.after && code === 0);
    const waiting = plan.config.filter((entry) => waitsForCheck(plan, entry));
    const kept = plan.config.filter((entry) => (waiting.includes(entry) ? passing(entry) : gated.plan.config.includes(entry)));
    const routes = wholeRoutes(kept, plan.config.filter((entry) => !kept.includes(entry)));
    const configured = { ...gated.plan, config: routes.config, dropped: [...gated.plan.dropped, ...waiting.filter((entry) => !passing(entry)).map(droppedConfig), ...routes.dropped] };
    for (const adapter of afterSteps) {
      const result = await adapter.apply(configured, context);
      report.actions.push(...result.actions);
      report.findings.push(...result.findings);
      if (result.failed || result.blocked) report.ok = false;
    }
    await runChecks(plan.checks.filter((check) => check.todo && !gates.includes(check)));
    return { report, checks };
  };
  for (const adapter of adapters.filter((each) => !afterSteps.includes(each))) {
    const result = await adapter.apply(gated.plan, context).catch(async (error: unknown) => {
      const from = report.findings.length;
      const also = await configure().then(() => undefined, (second: unknown) => second);
      const todos = todoLines(report.findings.slice(from));
      if (also === undefined && !todos) throw error;
      throw new Error(`${String((error as Error)?.message ?? error)}${also === undefined ? "" : ` Hedge also could not set your provider settings: ${String((also as Error)?.message ?? also)}`}${todos}`);
    });
    report.actions.push(...result.actions);
    report.findings.push(...result.findings);
    if (result.failed) report.ok = false;
    if (!result.blocked) continue;
    report.ok = false;
    if (!context.dryRun) return { report, checks: [] };
  }
  const before = context.dryRun ? currentNames(await readLedger(options.home), packOf(plan)) : await renameLedger(options.home, packOf(plan));
  const record = async (key: string, step?: LedgerStep) => {
    if (!context.dryRun) await changeLedger(options.home, "steps", key, step);
  };
  const failed = new Set<string>();
  const undo = async (items: UndoItem[]) => {
    for (const { step, cause } of items) {
      if (failed.has(step.pack)) continue;
      const undoing = undoRunner(run, step);
      const holds = await undoHeld(step, undoing);
      if (holds === "no") {
        await record(ledgerKey(step));
        continue;
      }
      if (holds !== "yes") {
        report.findings.push(undoFinding(step, cause, holds));
        if (holds === "unknown" && step.pack === "base") report.ok = false;
        continue;
      }
      const target = `step ${step.pack}/${step.id}`;
      if (context.dryRun) {
        report.actions.push({ target, operation: "remove", reason: `hedge apply would undo it: ${because(step, cause)}` });
        continue;
      }
      if ((await undoing(step.undo)) === 0 && !heldCodes.includes(await undoing(step.check))) {
        await record(ledgerKey(step));
        report.actions.push({ target, operation: "remove", reason: because(step, cause) });
        continue;
      }
      report.findings.push({ id: `undo:${step.id}`, pack: step.pack, say: `Hedge could not undo step ${step.id} of the ${step.pack} pack, ${whose(cause)}. The next hedge apply tries again.`, repair: "apply" });
      if (step.pack === "base") report.ok = false;
    }
  };
  const skipped = new Set(options.skip ?? []);
  const items = undoItems(plan, before.steps).filter((item) => !skipped.has(ledgerKey(item.step)));
  await undo(items.filter((item) => item.cause === "pack"));
  const waits = waiter(plan, run);
  const held = async (step: Plan["steps"][number]) => {
    if (step.undo && step.check) await record(ledgerKey(step), ledgerStep(plan, step));
  };
  const passes = async (step: Plan["steps"][number]) => step.check !== undefined && (await run(step.check)) === 0;
  for (const step of context.dryRun ? [] : plan.steps) {
    if (skipped.has(`${step.pack}/${step.id}`) || failed.has(step.pack) || (await waits(step))) continue;
    if (await passes(step)) {
      await held(step);
      continue;
    }
    options.progress?.(`  … ${step.pack}: ${step.id}`);
    const ran = (await run(step.run)) === 0;
    const holds = await passes(step);
    if (holds) await held(step);
    if (ran && (holds || !step.check)) continue;
    failed.add(step.pack);
    report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: ran ? `Step ${step.id} of the ${step.pack} pack ran, but does not pass its check.` : `Step ${step.id} of the ${step.pack} pack failed.`, repair: "apply" });
    report.ok = false;
  }
  for (const step of context.dryRun ? [] : plan.human) {
    if (step.undo && (gated.passed.includes(step) || (await run(step.probe)) === 0)) await changeLedger(options.home, "human", ledgerKey(step), { pack: step.pack, id: step.id, probe: step.left ?? step.probe, undo: step.undo });
  }
  for (const step of context.dryRun ? [] : leftHuman(plan, before)) {
    if (!heldCodes.includes(await run(step.probe, { [undoVariable]: ledgerKey(step) }))) await changeLedger(options.home, "human", ledgerKey(step));
  }
  await undo(items.filter((item) => item.cause !== "pack"));
  return configure();
}

export const todoLines = (findings: Finding[]) => findings.filter((finding) => finding.todo).map((finding) => `\nTo do: ${finding.say}`).join("");

const waitsForCheck = (plan: Plan, entry: Plan["config"][number]) => entry.after !== undefined && !plan.human.some((step) => step.pack === entry.pack && step.id === entry.after);

const droppedConfig = (entry: Plan["config"][number]): Plan["dropped"][number] => ({ pack: entry.pack, item: `config ${entry.provider}:${entry.key}`, reason: `check ${entry.after} does not pass`, check: entry.after });

export async function check(plan: Plan, options: { home: string; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const run = viaEngine(plan, options.run ?? spawnRunner(options.home, plan.machine.profileDir));
  const { report, checks } = await reconcile(plan, { ...options, dryRun: true });
  for (const item of plan.checks) {
    if (report.findings.some((finding) => finding.id === `check:${item.id}` && finding.pack === item.pack)) continue;
    const code = checks.find(([ran]) => ran === item)?.[1] ?? (await run(item.run));
    if (code !== 0) report.findings.push(checkFinding(item, code));
  }
  const waits = waiter(plan, run);
  for (const step of plan.steps) {
    if (await waits(step)) continue;
    if (step.check && (await run(step.check)) !== 0) report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack does not pass its check.`, repair: "apply" });
  }
  const ledger = currentNames(await readLedger(options.home), packOf(plan));
  for (const { step, cause } of undoItems(plan, ledger.steps)) {
    if (report.actions.some((action) => action.target === `step ${step.pack}/${step.id}`)) report.findings.push({ id: `undo:${step.id}`, pack: step.pack, say: `${stillHolds(step, cause)} Run hedge apply to undo it.`, repair: "apply" });
  }
  report.findings.push(...(await leftByHand(plan, ledger, run)), ...secretsLeft(plan, options.home));
  for (const step of plan.human) {
    const reported = report.findings.some((finding) => finding.id === `human:${step.id}` && finding.pack === step.pack);
    if (!reported && (await run(step.probe)) === 0) continue;
    report.humanLeft.push(step);
    if (!reported) report.findings.push(humanFinding(step, true));
  }
  if (report.findings.some((finding) => finding.repair || finding.id.startsWith("kept:"))) report.ok = false;
  return report;
}

export type HumanStepsLeft = { failing: Array<Owned<HumanStep>>; unchecked: Array<Owned<HumanStep>> };

const probeConcurrency = 8;
const supervisorSpawnFailed = -1;

export async function humanStepsLeft(plan: Plan, options: { home: string; run?: Runner; giveUp: Promise<void>; graceMs?: number }): Promise<HumanStepsLeft> {
  const reported = new WeakMap<AbortSignal, number>();
  const waiters = new WeakMap<AbortSignal, (code: number) => void>();
  const probeBySignal = new WeakMap<AbortSignal, LiveProbe>();
  const live = new Set<LiveProbe>();
  const run = viaEngine(
    plan,
    options.run ??
      spawnRunner(
        options.home,
        plan.machine.profileDir,
        (sig, code) => {
          reported.set(sig, code);
          const wake = waiters.get(sig);
          if (wake) {
            waiters.delete(sig);
            wake(code);
          }
        },
        options.graceMs,
        live,
        probeBySignal,
      ),
  );
  let timedOut = false;
  const giveUpSettled = options.giveUp.then(() => {
    timedOut = true;
  });
  await Promise.race([giveUpSettled, Promise.resolve()]);
  if (timedOut) return { failing: [], unchecked: [...plan.human] };
  const outcomes = new Array<"passes" | "fails" | "unchecked">(plan.human.length).fill("unchecked");
  let next = 0;
  const checkOne = async (index: number) => {
    if (timedOut) return;
    const step = plan.human[index]!;
    const deadline = new AbortController();
    let aborted = false;
    let reportedAtDeadline = false;
    let settled = false;
    const result = run(step.probe, {}, deadline.signal).then(
      (code) => {
        settled = true;
        if (aborted && !reportedAtDeadline) return "unchecked" as const;
        return code === supervisorSpawnFailed ? ("unchecked" as const) : code === 0 ? ("passes" as const) : ("fails" as const);
      },
      (error) => {
        settled = true;
        if (aborted) return "unchecked" as const;
        throw error;
      },
    );
    const late = options.giveUp.then(async () => {
      if (settled) return "passes" as const;
      const code = reported.get(deadline.signal);
      if (code !== undefined) {
        reportedAtDeadline = true;
        aborted = true;
        deadline.abort();
        return code === 0 ? ("passes" as const) : ("fails" as const);
      }
      const active = probeBySignal.get(deadline.signal);
      const sawPipeResult = active?.resultFd !== undefined && probeResultReported(active.resultFd) === "reported";
      if (sawPipeResult && active) {
        active.targetExited = true;
        reportedAtDeadline = true;
      }
      aborted = true;
      deadline.abort();
      if (!sawPipeResult) return "unchecked" as const;
      const already = reported.get(deadline.signal);
      if (already !== undefined) return already === 0 ? ("passes" as const) : ("fails" as const);
      const codeArrived = new Promise<"passes" | "fails">((resolve) => {
        waiters.set(deadline.signal, (c) => resolve(c === 0 ? "passes" : "fails"));
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<"unchecked">((resolve) => {
        timer = setTimeout(() => resolve("unchecked"), 50);
      });
      try {
        return await Promise.race([codeArrived, result, cap]);
      } finally {
        waiters.delete(deadline.signal);
        if (timer) clearTimeout(timer);
      }
    });
    outcomes[index] = await Promise.race([result, late]);
  };
  const workers = Array.from({ length: Math.min(probeConcurrency, plan.human.length) }, async () => {
    while (next < plan.human.length && !timedOut) await checkOne(next++);
  });
  try {
    await Promise.all(workers);
  } finally {
    handOffWatchdog(live);
  }
  return { failing: plan.human.filter((_, index) => outcomes[index] === "fails"), unchecked: plan.human.filter((_, index) => outcomes[index] === "unchecked") };
}

function checkFinding(item: Owned<PackCheck>, code: number): Finding {
  const id = `check:${item.id}`;
  return code === waitsForPerson && item.todo ? { id, pack: item.pack, say: item.todo, todo: true } : { id, pack: item.pack, say: item.say, repair: "apply" };
}

const repairedByHedge = (step: HumanStep) => step.repair !== undefined && !step.command;

function humanFinding(step: Owned<HumanStep>, repairStillToRun: boolean): Finding {
  return { id: `human:${step.id}`, pack: step.pack, say: step.command ? `${step.say} Run: ${step.command}` : step.say, repair: repairStillToRun && repairedByHedge(step) ? "apply" : "human" };
}

/** Tests each check once, running a Hedge repair first when a human step's probe fails and repairs are on, then drops the items whose check fails. It tests the checks that served services wait for first, which only the hub can, and fills their credentials, so a repair that reads a credential sees it in the same apply. */
async function gate(plan: Plan, run: Runner, repair: boolean, issue?: (ready: CatalogEntry[]) => Promise<Finding[]>): Promise<{ plan: Plan; failed: Array<Owned<HumanStep>>; passed: Array<Owned<HumanStep>>; issued: Finding[] }> {
  const tested = new Map<Owned<HumanStep>, boolean>();
  const probe = async (step: Owned<HumanStep>) => {
    if ((await run(step.probe)) === 0) return true;
    return repair && step.repair !== undefined && (await run(step.repair)) === 0 && (await run(step.probe)) === 0;
  };
  const passes = async (step: Owned<HumanStep> | undefined) => {
    if (!step) return false;
    if (!tested.has(step)) tested.set(step, await probe(step));
    return tested.get(step)!;
  };
  const checkOf = (pack: string, id: string) => plan.human.find((step) => step.pack === pack && step.id === id);
  const ready: CatalogEntry[] = [];
  for (const entry of plan.catalog ?? []) if (!entry.after || plan.pullsFromHub || (await passes(checkOf(entry.pack, entry.after)))) ready.push(entry);
  const issued = issue ? await issue(ready) : [];
  if (repair) for (const step of plan.human) if (step.repair) await passes(step);
  const jobs: Plan["jobs"] = [];
  const dropped: Plan["dropped"] = [];
  for (const job of plan.jobs) {
    if (!job.after || (await passes(plan.human.find((step) => step.pack === job.pack && step.id === job.after)))) jobs.push(job);
    else dropped.push({ pack: job.pack, item: `job ${job.id}`, reason: `check ${job.after} does not pass`, check: job.after });
  }
  const config: Plan["config"] = [];
  for (const entry of plan.config) {
    if (waitsForCheck(plan, entry)) continue;
    if (!entry.after || (await passes(checkOf(entry.pack, entry.after)))) config.push(entry);
    else dropped.push(droppedConfig(entry));
  }
  const failed = [...tested].filter(([, passed]) => !passed).map(([step]) => step);
  const passed = [...tested].filter(([, passed]) => passed).map(([step]) => step);
  return { plan: { ...plan, jobs, config, dropped: [...plan.dropped, ...dropped] }, failed, passed, issued };
}

type Cause = { workflow: string } | "pack" | "plan";
type UndoItem = { step: LedgerStep; cause: Cause };
type Held = "yes" | "no" | "waits" | "unsure" | "unknown";

const heldCodes = [0, cannotTell];

function ledgerStep(plan: Plan, step: Plan["steps"][number]): LedgerStep {
  const prerequisite = step.after ? plan.human.find((human) => human.pack === step.pack && human.id === step.after)?.probe : undefined;
  return { pack: step.pack, id: step.id, check: step.left ?? step.check!, undo: step.undo!, ...(step.after ? { after: step.after } : {}), ...(prerequisite ? { prerequisite } : {}) };
}

/** The steps to undo: those whose workflow is off while their pack is on, and those the ledger holds that left the plan, except in a pack the profile lists but cannot load. A step the ledger holds is undone with the commands it had when it last held. */
function undoItems(plan: Plan, ledger: LedgerStep[]): UndoItem[] {
  const recorded = new Map(ledger.map((step) => [ledgerKey(step), step]));
  const fromPlan = (plan.undo ?? []).map((step) => ({ step: recorded.get(ledgerKey(step)) ?? { ...ledgerStep(plan, step), ...(step.prerequisite ? { prerequisite: step.prerequisite } : {}) }, cause: { workflow: step.workflow! } }));
  const planned = new Set([...plan.steps, ...(plan.undo ?? [])].map(ledgerKey));
  const listed = new Set(plan.packs.map((pack) => pack.name));
  const unloaded = new Set(plan.packs.filter((pack) => !pack.available).map((pack) => pack.name));
  const fromLedger = ledger.filter((step) => !planned.has(ledgerKey(step)) && !unloaded.has(step.pack)).map((step) => ({ step, cause: listed.has(step.pack) ? ("plan" as const) : ("pack" as const) }));
  return [...fromPlan, ...fromLedger];
}

const because = (step: LedgerStep, cause: Cause) => (cause === "pack" ? `the ${step.pack} pack is off` : cause === "plan" ? "this machine no longer plans it" : `workflow ${cause.workflow} is off`);
const whose = (cause: Cause) => (cause === "pack" ? "which is off" : cause === "plan" ? "now that this machine no longer plans it" : `whose workflow ${cause.workflow} is off`);
const though = (cause: Cause) => (cause === "pack" ? "the pack is off" : cause === "plan" ? "this machine no longer plans it" : `its workflow ${cause.workflow} is off`);

function stillHolds(step: LedgerStep, cause: Cause) {
  const what = `step ${step.id} of the ${step.pack} pack`;
  if (cause === "pack") return `The ${step.pack} pack is off, but ${what} still holds what it set.`;
  if (cause === "plan") return `This machine no longer plans ${what}, but it still holds what it set.`;
  return `The workflow ${cause.workflow} is off, but ${what} still holds what it set.`;
}

/** The human steps of the ledger that left the plan, except in a pack the profile lists but cannot load. */
function leftHuman(plan: Plan, ledger: Ledger) {
  const planned = new Set(plan.human.map(ledgerKey));
  const unloaded = new Set(plan.packs.filter((pack) => !pack.available).map((pack) => pack.name));
  return ledger.human.filter((step) => !planned.has(ledgerKey(step)) && !unloaded.has(step.pack));
}

/** The human steps of the ledger that left the plan and whose probe still passes, each with what a person does to remove it. */
async function leftByHand(plan: Plan, ledger: Ledger, run: Runner): Promise<Finding[]> {
  const listed = new Set(plan.packs.map((pack) => pack.name));
  const findings: Finding[] = [];
  for (const step of leftHuman(plan, ledger)) {
    if ((await run(step.probe, { [undoVariable]: ledgerKey(step) })) !== 0) continue;
    const cause = listed.has(step.pack) ? `This machine no longer plans the ${step.id} step of the ${step.pack} pack.` : `The ${step.pack} pack is off.`;
    findings.push({ id: `left:${step.id}`, pack: step.pack, say: `${cause} ${step.undo}` });
  }
  return findings;
}

/** A note for each folder of pack secrets whose pack is off: Hedge keeps them, because a credential is costly to make again. */
function secretsLeft(plan: Plan, home: string): Finding[] {
  const on = new Set(plan.packs.map((pack) => pack.name));
  const folder = join(home, ".config/hedge/secrets");
  const packs = existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory() && packName.test(entry.name) && !on.has(entry.name)).map((entry) => entry.name) : [];
  return packs.sort().map((pack) => ({ id: `secrets:${pack}`, pack, say: `The ${pack} pack is off. Its secrets stay in ~/.config/hedge/secrets/${pack}. Delete that folder when you no longer need them.` }));
}

async function undoHeld(step: LedgerStep, run: Runner): Promise<Held> {
  const code = await run(step.check);
  if (!heldCodes.includes(code)) return "no";
  const waits = step.after !== undefined && !(step.prerequisite && (await run(step.prerequisite)) === 0);
  if (code === 0) return waits ? "waits" : "yes";
  return waits ? "unsure" : "unknown";
}

function undoFinding(step: LedgerStep, cause: Cause, held: Exclude<Held, "yes" | "no">): Finding {
  const id = `undo:${step.id}`;
  if (held === "unknown") return { id, pack: step.pack, say: `Hedge cannot tell whether step ${step.id} of the ${step.pack} pack still holds what it set, though ${though(cause)}.`, repair: "apply" };
  const say = `Step ${step.id} of the ${step.pack} pack waits for ${step.after} before Hedge can undo it.`;
  return held === "waits" ? { id, pack: step.pack, say, repair: "human" } : { id, pack: step.pack, say };
}

/** Whether a pack step still waits for its human step. Each human step is probed once, when its first waiting step comes up, so earlier steps can install what the probe runs. */
function waiter(plan: Plan, run: Runner) {
  const passed = new Map<string, boolean>();
  return async (step: Plan["steps"][number]) => {
    if (!step.after) return false;
    const key = `${step.pack}:${step.after}`;
    if (!passed.has(key)) {
      const human = plan.human.find((item) => item.pack === step.pack && item.id === step.after);
      passed.set(key, human ? (await run(human.probe)) === 0 : false);
    }
    return !passed.get(key);
  };
}

/** The sources whose packs or skills this plan lacks because they could not be fetched. */
function unreachable(plan: Plan) {
  const packs = plan.packs.filter((pack) => !pack.available && pack.reason?.startsWith("not found; unreachable")).map((pack) => `the ${pack.name} pack`);
  const skills = plan.dropped.filter((item) => item.reason === "its source is unreachable").map((item) => `${item.item} of ${item.pack}`);
  return [...packs, ...skills];
}

const packOf = (plan: Plan) => (name: string) => listedPack(plan, name);

function waitingFindings(plan: Plan): Finding[] {
  return plan.workflows.filter((workflow) => workflow.unset).map((workflow) => ({ id: `waits:${workflow.id}`, pack: workflow.pack, say: `Workflow ${workflow.id} stays off until you set ${workflow.unset}. Set it with hedge set ${workflow.unset}=<value>.` }));
}

function packFindings(plan: Plan): Finding[] {
  return plan.packs
    .filter((pack) => !pack.available || pack.reason)
    .map((pack) => ({ id: `pack:${pack.name}`, pack: pack.name, say: pack.available ? `The ${pack.name} pack uses its last fetched files: ${pack.reason}` : `The ${pack.name} pack is not applied: ${pack.reason}` }));
}

function repeatFindings(plan: Plan): Finding[] {
  return (plan.repeatedHeadings ?? []).map((entry) => ({
    id: `repeats:${entry.guide}:${entry.section}:${entry.heading}`,
    pack: entry.pack,
    say: `Section "${entry.section}" of the ${entry.pack} pack repeats the heading "${entry.heading}" of ${entry.owner} in ~/.agents/guides/${entry.guide}.md. Agents then read two versions of one rule. Keep only what the guide does not say, under a heading of its own, or change the rule with a setting.`,
    todo: true as const,
  }));
}

function hubFindings(plan: Plan): Finding[] {
  const left = plan.dropped.filter((item) => item.reason === hublessReason).length;
  if (!left) return [];
  const items = left === 1 ? "1 item that runs" : `${left} items that run`;
  return [{ id: "hubless", pack: "engine", say: `Your profile lists devboxes but names no hub, so this machine leaves out ${items} on the hub. Run hedge hub here on the machine that should be the hub.` }];
}

function viaEngine(plan: Plan, run: Runner): Runner {
  return (command, env, signal) => run(engineCommand(command, plan.engineRoot), env, signal);
}

/** Names the step in HEDGE_UNDO, so a nested hedge runs the command of a pack that is off, but only for this step's undo, check and prerequisite. */
const undoRunner = (run: Runner, step: LedgerStep): Runner => (command) => run(command, { [undoVariable]: ledgerKey(step) });

/** Runs commands with the plan's home directory as HOME, so a step installs into the home it applies to, and with the plan's profile, so a nested hedge reads the profile this run applies or checks. */
function spawnRunner(home: string, profileDir: string | undefined, onResult?: (signal: AbortSignal, code: number) => void, cleanupGraceMs?: number, live?: Set<LiveProbe>, probeBySignal?: WeakMap<AbortSignal, LiveProbe>): Runner {
  return async (command, env = {}, signal) => {
    const childEnv = withLegacyNames({ ...Bun.env, HOME: home, ...(profileDir ? { HEDGE_PROFILE_DIR: profileDir } : {}), ...env });
    if (!signal) {
      try {
        return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: childEnv }).exited;
      } catch {
        return 127;
      }
    }
    return await runDetached(command, childEnv, signal, onResult, cleanupGraceMs, live, probeBySignal);
  };
}

const probeSupervisor = join(import.meta.dir, "probe-supervisor.ts");
const probeWatchdog = join(import.meta.dir, "probe-watchdog.ts");
const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
let activeSupervisors = 0;
const supervisorWaiters: Array<() => void> = [];

type LiveProbe = { pid: number; runnerPid?: number; tag: string; spareFile?: string; spareFd?: number; handedOff?: boolean; spareHandedOff?: boolean; targetPid?: number; targetExited?: boolean; aliveFd?: number; resultFd?: number; guardFd?: number; holderExitFd?: number; delayMs: number; stop: (name: NodeJS.Signals) => void };
type ActiveRunner = { stop: (name: NodeJS.Signals) => void };
const activeRunners = new Set<ActiveRunner>();
const allLiveProbes = new Set<LiveProbe>();
let interruptHandlersAttached = false;

function resolveProbeSpare(probe: LiveProbe): string | undefined {
  if (!probe.spareFile && probe.spareFd !== undefined) {
    const drained = drainControlFd(probe.spareFd);
    const path = drained.lines.map(parseSpareLine).find((p) => p !== undefined);
    if (path) {
      probe.spareFile = path;
      try {
        closeSync(probe.spareFd);
      } catch {}
      probe.spareFd = undefined;
    } else if (drained.closed) {
      try {
        closeSync(probe.spareFd);
      } catch {}
      probe.spareFd = undefined;
    }
  }
  return probe.spareFile;
}

function removeSpareAsync(filePath: string | undefined): void {
  if (!filePath) return;
  void rm(filePath, { force: true })
    .catch(() => {})
    .then(() => rmdir(dirname(filePath)).catch(() => {}));
}

function handOffWatchdog(probes: Iterable<LiveProbe>) {
  const batch: Array<{ pid: number; holderPid?: number; holderFd?: number; tag: string; spareFile?: string; spareFd?: number; probe: LiveProbe; targetPid?: number; targetExited?: boolean; fd: number; resultFd?: number; delayMs: number }> = [];
  for (const probe of probes) {
    if (probe.aliveFd === undefined) continue;
    let targetExited = Boolean(probe.targetExited);
    const resultFd = probe.resultFd;
    probe.resultFd = undefined;
    const holderFd = probe.holderExitFd;
    probe.holderExitFd = undefined;
    if (!targetExited && resultFd !== undefined && probeResultReported(resultFd) === "reported") {
      targetExited = true;
    }
    const spareFile = resolveProbeSpare(probe);
    const spareFd = spareFile ? undefined : probe.spareFd;
    if (spareFd !== undefined) probe.spareFd = undefined;
    const holderPid = probe.runnerPid !== undefined || holderFd !== undefined ? probe.pid : undefined;
    batch.push({
      pid: probe.runnerPid ?? probe.pid,
      ...(holderPid !== undefined ? { holderPid } : {}),
      ...(holderFd !== undefined ? { holderFd } : {}),
      tag: probe.tag,
      ...(spareFile ? { spareFile } : {}),
      ...(spareFd !== undefined ? { spareFd } : {}),
      probe,
      ...(probe.targetPid !== undefined ? { targetPid: probe.targetPid } : {}),
      ...(targetExited ? { targetExited: true } : {}),
      fd: probe.aliveFd,
      ...(resultFd !== undefined ? { resultFd } : {}),
      delayMs: probe.delayMs,
    });
    probe.aliveFd = undefined;
  }
  if (!batch.length) return;
  const extraFds: number[] = [];
  const payload = JSON.stringify(
    batch.map((entry) => {
      const fd = extraFds.length + 3;
      extraFds.push(entry.fd);
      let resultFd: number | undefined;
      if (!entry.targetExited && entry.resultFd !== undefined) {
        resultFd = extraFds.length + 3;
        extraFds.push(entry.resultFd);
      }
      let holderFd: number | undefined;
      if (entry.holderFd !== undefined) {
        holderFd = extraFds.length + 3;
        extraFds.push(entry.holderFd);
      }
      let spareFd: number | undefined;
      if (!entry.spareFile && entry.spareFd !== undefined) {
        spareFd = extraFds.length + 3;
        extraFds.push(entry.spareFd);
      }
      return {
        pid: entry.pid,
        ...(entry.holderPid !== undefined ? { holderPid: entry.holderPid } : {}),
        ...(holderFd !== undefined ? { holderFd } : {}),
        ...(entry.targetExited ? { reported: true } : { tag: entry.tag }),
        ...(entry.spareFile ? { spareFile: entry.spareFile } : {}),
        ...(spareFd !== undefined ? { spareFd } : {}),
        fd,
        ...(resultFd !== undefined ? { resultFd } : {}),
        delayMs: entry.delayMs,
      };
    }),
  );
  for (const fd of extraFds) setCloexec(fd, false);
  let handedOff = false;
  try {
    const watchdog = Bun.spawn(bunScript(probeWatchdog, payload), {
      env: watchdogEnv(),
      stdio: ["ignore", "ignore", "ignore", ...extraFds],
      detached: true,
    });
    watchdog.unref();
    handedOff = true;
    for (const entry of batch) {
      entry.probe.handedOff = true;
      if (entry.spareFile || entry.spareFd !== undefined) entry.probe.spareHandedOff = true;
    }
  } catch {
  } finally {
    if (!handedOff) {
      for (const entry of batch) {
        let spare = entry.spareFile;
        if (!spare && entry.spareFd !== undefined) {
          spare = drainControlFd(entry.spareFd).lines.map(parseSpareLine).find((p) => p !== undefined);
        }
        let stillAlive = false;
        try {
          writeSync(entry.fd, "\n");
          stillAlive = true;
        } catch {}
        const ownGroupOnly = Boolean(entry.targetExited);
        const sweepTag = ownGroupOnly ? undefined : entry.tag;
        if (stillAlive) {
          killSessionSync(entry.pid, "SIGKILL", sweepTag, spare, ownGroupOnly);
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {}
          if (entry.holderPid !== undefined && entry.holderPid !== entry.pid) {
            killSessionSync(entry.holderPid, "SIGKILL", sweepTag, spare, ownGroupOnly);
            try {
              process.kill(entry.holderPid, "SIGKILL");
            } catch {}
            killDeadSessionSync(entry.holderPid, sweepTag, false, spare, ownGroupOnly);
          }
        } else {
          killDeadSessionSync(entry.pid, sweepTag, false, spare, ownGroupOnly);
          if (entry.holderPid !== undefined && entry.holderPid !== entry.pid) {
            killSessionSync(entry.holderPid, "SIGKILL", sweepTag, spare, ownGroupOnly);
            try {
              process.kill(entry.holderPid, "SIGKILL");
            } catch {}
            killDeadSessionSync(entry.holderPid, sweepTag, false, spare, ownGroupOnly);
          }
        }
        removeSpareAsync(spare);
      }
    }
    for (const entry of batch) {
      try {
        closeSync(entry.fd);
      } catch {}
      if (entry.resultFd !== undefined) {
        try {
          closeSync(entry.resultFd);
        } catch {}
      }
      if (entry.holderFd !== undefined) {
        try {
          closeSync(entry.holderFd);
        } catch {}
      }
      if (entry.spareFd !== undefined) {
        try {
          closeSync(entry.spareFd);
        } catch {}
      }
    }
  }
}

function handleProcessInterrupt(name: NodeJS.Signals) {
  for (const runner of [...activeRunners]) runner.stop(name);
  for (const probe of [...allLiveProbes]) probe.stop(name);
  handOffWatchdog(allLiveProbes);
  detachInterruptHandlers();
  if (!process.listenerCount(name)) {
    if (name === "SIGQUIT") process.exit(131);
    process.kill(process.pid, name);
  }
}

function syncInterruptHandlers() {
  const needed = activeRunners.size > 0 || allLiveProbes.size > 0;
  if (needed && !interruptHandlersAttached) {
    interruptHandlersAttached = true;
    for (const name of stopSignals) process.on(name, handleProcessInterrupt);
  } else if (!needed && interruptHandlersAttached) {
    detachInterruptHandlers();
  }
}

function detachInterruptHandlers() {
  if (!interruptHandlersAttached) return;
  interruptHandlersAttached = false;
  for (const name of stopSignals) process.off(name, handleProcessInterrupt);
}

async function acquireSupervisorSlot(signal: AbortSignal): Promise<(() => void) | undefined> {
  if (signal.aborted) return undefined;
  if (activeSupervisors >= probeConcurrency) {
    const acquired = await new Promise<boolean>((resolve) => {
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const index = supervisorWaiters.indexOf(wake);
        if (index !== -1) supervisorWaiters.splice(index, 1);
        resolve(false);
      };
      supervisorWaiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (!acquired) return undefined;
  } else {
    activeSupervisors++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = supervisorWaiters.shift();
    if (next) next();
    else activeSupervisors--;
  };
}

async function readSupervisorResult(
  stdout: ReadableStream<Uint8Array>,
  onFirstCode: (code: number) => void,
  onTarget?: (pid: number) => void,
  onRunner?: (pid: number) => void,
): Promise<{ code?: number; cleanup: boolean; stopped: boolean }> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let code: number | undefined;
  let cleanup = false;
  let stopped = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("runner:")) {
          const pid = Number(line.slice("runner:".length));
          if (Number.isInteger(pid) && pid > 0) onRunner?.(pid);
        } else if (line.startsWith("target:")) {
          const pid = Number(line.slice("target:".length));
          if (Number.isInteger(pid) && pid > 0) onTarget?.(pid);
        } else if (code === undefined && /^\d+$/.test(line)) {
          code = Number(line);
          onFirstCode(code);
        } else if (line === "cleanup") {
          cleanup = true;
          return { code, cleanup, stopped };
        } else if (line === "stopped") {
          stopped = true;
          return { code, cleanup, stopped };
        }
      }
    }
  } catch {
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { code, cleanup, stopped };
}

async function runDetached(command: string[], env: Record<string, string | undefined>, signal: AbortSignal, onResult?: (signal: AbortSignal, code: number) => void, cleanupGraceMs?: number, live?: Set<LiveProbe>, probeBySignal?: WeakMap<AbortSignal, LiveProbe>) {
  if (!command.length) return 127;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let probe: LiveProbe | undefined;
  let stopSignal: NodeJS.Signals | undefined;
  let reaped = false;
  let reportedResult = false;
  const discoverySlackMs = process.platform === "darwin" ? 250 : 0;
  const delayFor = (name: NodeJS.Signals) => (cleanupGraceMs ?? graceMs) + (name === "SIGINT" || name === "SIGQUIT" ? interruptGraceMs : 0) + discoverySlackMs + 100;
  let lastSignal: NodeJS.Signals | undefined;
  const endGroup = (name: NodeJS.Signals = "SIGTERM") => {
    stopSignal ??= name;
    if (!child || reaped || lastSignal === name) return;
    lastSignal = name;
    if (probe) probe.delayMs = Math.max(probe.delayMs, delayFor(name));
    if (probe?.aliveFd !== undefined) {
      try {
        writeSync(probe.aliveFd, `${name}\n`);
      } catch {}
    }
    try {
      process.kill(-(probe?.runnerPid ?? child.pid), "SIGCONT");
    } catch {}
    if (!live && probe) handOffWatchdog([probe]);
  };
  const onAbort = () => endGroup("SIGTERM");
  const runner: ActiveRunner = { stop: endGroup };
  const release = () => {
    signal.removeEventListener("abort", onAbort);
    activeRunners.delete(runner);
    syncInterruptHandlers();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  activeRunners.add(runner);
  syncInterruptHandlers();
  const releaseSlot = await acquireSupervisorSlot(signal);
  if (!releaseSlot) {
    release();
    return supervisorSpawnFailed;
  }
  if (signal.aborted || stopSignal) {
    releaseSlot();
    release();
    return supervisorSpawnFailed;
  }
  let handedToExit = false;
  const useLinuxHolder = process.platform === "linux";
  const resultPipe = createPipe();
  if (resultPipe) setCloexec(resultPipe.readFd, true);
  let resultWriteClosed = false;
  const closeResultWrite = () => {
    if (!resultPipe || resultWriteClosed) return;
    resultWriteClosed = true;
    try {
      closeSync(resultPipe.writeFd);
    } catch {}
  };
  const guardPipe = useLinuxHolder ? createPipe() : undefined;
  if (guardPipe) setCloexec(guardPipe.readFd, true);
  let guardWriteClosed = false;
  const closeGuardWrite = () => {
    if (!guardPipe || guardWriteClosed) return;
    guardWriteClosed = true;
    try {
      closeSync(guardPipe.writeFd);
    } catch {}
  };
  const holderExitPipe = useLinuxHolder ? createPipe() : undefined;
  if (holderExitPipe) setCloexec(holderExitPipe.readFd, true);
  let holderExitWriteClosed = false;
  const closeHolderExitWrite = () => {
    if (!holderExitPipe || holderExitWriteClosed) return;
    holderExitWriteClosed = true;
    try {
      closeSync(holderExitPipe.writeFd);
    } catch {}
  };
  const sparePipe = createPipe();
  if (sparePipe) setCloexec(sparePipe.readFd, true);
  let spareWriteClosed = false;
  const closeSpareWrite = () => {
    if (!sparePipe || spareWriteClosed) return;
    spareWriteClosed = true;
    try {
      closeSync(sparePipe.writeFd);
    } catch {}
  };
  try {
    const tag = crypto.randomUUID();
    const fullTag = appendTag(env[tagEnvVar], tag);
    const targetEnv: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(env)) if (v !== undefined) targetEnv[k] = v;
    targetEnv[tagEnvVar] = tag;
    const extraStdio: number[] = [];
    let payloadResultFd: number | undefined;
    if (resultPipe) {
      payloadResultFd = 4 + extraStdio.length;
      extraStdio.push(resultPipe.writeFd);
    }
    let payloadGuardFd: number | undefined;
    if (guardPipe) {
      payloadGuardFd = 4 + extraStdio.length;
      extraStdio.push(guardPipe.writeFd);
    }
    let payloadHolderExitFd: number | undefined;
    if (holderExitPipe) {
      payloadHolderExitFd = 4 + extraStdio.length;
      extraStdio.push(holderExitPipe.writeFd);
    }
    let payloadSpareFd: number | undefined;
    if (sparePipe) {
      payloadSpareFd = 4 + extraStdio.length;
      extraStdio.push(sparePipe.writeFd);
    }
    const payload = {
      command,
      env: targetEnv,
      controlFd: 3,
      spareTag: tag,
      ...(env.HOME ? { spareHome: env.HOME } : {}),
      ...(payloadSpareFd !== undefined ? { spareFd: payloadSpareFd } : {}),
      ...(useLinuxHolder ? { holder: true } : {}),
      ...(payloadResultFd !== undefined ? { resultFd: payloadResultFd } : {}),
      ...(payloadGuardFd !== undefined ? { guardFd: payloadGuardFd } : {}),
      ...(payloadHolderExitFd !== undefined ? { holderExitFd: payloadHolderExitFd } : {}),
      ...(cleanupGraceMs === undefined ? {} : { graceMs: cleanupGraceMs }),
    };
    const encoded = JSON.stringify(payload);
    child = Bun.spawn(bunScript(probeSupervisor), {
      stdio: [new TextEncoder().encode(encoded), "pipe", "ignore", "pipe", ...extraStdio],
      env: supervisorEnv(fullTag),
      detached: true,
    });
    closeResultWrite();
    closeGuardWrite();
    closeHolderExitWrite();
    closeSpareWrite();
    const aliveFd = typeof child.stdio[3] === "number" ? child.stdio[3] : undefined;
    probe = {
      pid: child.pid,
      tag,
      aliveFd,
      ...(resultPipe ? { resultFd: resultPipe.readFd } : {}),
      ...(guardPipe ? { guardFd: guardPipe.readFd } : {}),
      ...(holderExitPipe ? { holderExitFd: holderExitPipe.readFd } : {}),
      ...(sparePipe ? { spareFd: sparePipe.readFd } : {}),
      delayMs: (cleanupGraceMs ?? graceMs) + discoverySlackMs + 100,
      stop: endGroup,
    };
    probeBySignal?.set(signal, probe);
    allLiveProbes.add(probe);
    live?.add(probe);
    syncInterruptHandlers();
    handedToExit = true;
    const owned = probe;
    const statusPromise = readSupervisorResult(
      child.stdout as ReadableStream<Uint8Array>,
      (code) => {
        reportedResult = true;
        owned.targetExited = true;
        onResult?.(signal, code);
      },
      (pid) => {
        owned.targetPid = pid;
      },
      (pid) => {
        owned.runnerPid = pid;
      },
    );
    let sawCleanExit = false;
    const cleanupDone = child.exited.then(
      async (supCode) => {
        reaped = true;
        await statusPromise.catch(() => {});
        const sawResult = reportedResult || Boolean(owned.targetExited) || (owned.resultFd !== undefined && probeResultReported(owned.resultFd) === "reported");
        sawCleanExit = sawResult && child?.signalCode === null;
        if (child?.signalCode !== null || (!sawResult && supCode !== 128 && supCode !== 143)) {
          if (owned.guardFd !== undefined) await waitForFdClosed(owned.guardFd, 500);
          const spareFile = resolveProbeSpare(owned);
          await killDeadSession(owned.pid, sawResult ? undefined : owned.tag, true, spareFile, sawResult);
          if (owned.runnerPid !== undefined) {
            await killDeadSession(owned.runnerPid, sawResult ? undefined : owned.tag, false, spareFile, sawResult);
          }
        }
      },
      () => {
        reaped = true;
      },
    ).finally(() => {
      if (owned.aliveFd !== undefined) {
        try {
          closeSync(owned.aliveFd);
        } catch {}
        owned.aliveFd = undefined;
      }
      if (owned.resultFd !== undefined) {
        try {
          closeSync(owned.resultFd);
        } catch {}
        owned.resultFd = undefined;
      }
      if (owned.guardFd !== undefined) {
        try {
          closeSync(owned.guardFd);
        } catch {}
        owned.guardFd = undefined;
      }
      if (owned.holderExitFd !== undefined) {
        try {
          closeSync(owned.holderExitFd);
        } catch {}
        owned.holderExitFd = undefined;
      }
      if (!owned.spareHandedOff && !sawCleanExit) {
        removeSpareAsync(resolveProbeSpare(owned));
      }
      if (owned.spareFd !== undefined) {
        try {
          closeSync(owned.spareFd);
        } catch {}
        owned.spareFd = undefined;
      }
      allLiveProbes.delete(owned);
      live?.delete(owned);
      syncInterruptHandlers();
      releaseSlot();
    });
    if (stopSignal || signal.aborted) endGroup(stopSignal ?? "SIGTERM");
    const status = await statusPromise;
    if (status.code !== undefined && status.cleanup) {
      child.unref();
      return status.code;
    }
    if (status.stopped) {
      child.unref();
      return status.code ?? supervisorSpawnFailed;
    }
    await cleanupDone;
    return status.code ?? supervisorSpawnFailed;
  } catch {
    closeResultWrite();
    closeGuardWrite();
    closeHolderExitWrite();
    closeSpareWrite();
    if (!handedToExit) {
      if (resultPipe) {
        try {
          closeSync(resultPipe.readFd);
        } catch {}
      }
      if (guardPipe) {
        try {
          closeSync(guardPipe.readFd);
        } catch {}
      }
      if (holderExitPipe) {
        try {
          closeSync(holderExitPipe.readFd);
        } catch {}
      }
      if (sparePipe) {
        try {
          closeSync(sparePipe.readFd);
        } catch {}
      }
      releaseSlot();
    }
    return supervisorSpawnFailed;
  } finally {
    release();
  }
}
