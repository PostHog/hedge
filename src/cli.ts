import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { loadPacks } from "./pack/manifest.ts";
import { cachedSource, fetchSource, sourceCache, unpinnedSources, withoutUserinfo } from "./pack/sources.ts";
import { cannotTell } from "./pack/types.ts";
import type { AvailableSource, CatalogEntry, FetchedSource, Finding, LoadedPack, MachineFile, Plan, Profile, Report, SourceRef } from "./pack/types.ts";
import { loadMachine, loadProfile, pullProfile, saveMachine, thisMachine } from "./profile/profile.ts";
import { engineAdapters } from "./adapters/index.ts";
import { apply, check, filesAdapter, type Adapter, type Issuer, type Runner } from "./reconciler/apply.ts";
import { refresh } from "./refresh.ts";
import { listedPack, resolve } from "./reconciler/resolve.ts";
import { undoingPack, undoVariable } from "./reconciler/ledger.ts";
import { readNotice, update } from "./update.ts";
import { setup, type SetupOptions } from "./setup/setup.ts";
import { ttyTerminal, type Terminal } from "./setup/terminal.ts";
import { FlagError } from "./setup/flags.ts";
import type { ChangeContext } from "./commands/change.ts";
import { packsCommand } from "./commands/packs.ts";
import { setCommand, settingsCommand } from "./commands/settings.ts";
import { asksAddress, devboxCommand, printAddress } from "./commands/devbox.ts";
import { hubCommand } from "./commands/hub.ts";
import { triageCommand } from "./commands/triage.ts";
import { recordSetup } from "./commands/triage-record.ts";
import { realMachine } from "./setup/commands.ts";
import { credentialName, packContext, secretStore, type Clock } from "./runner/context.ts";
import { onHub } from "./hub/ssh.ts";
import { drift } from "./reconciler/drift.ts";
import { spawnRunner, type CommandRunner } from "./adapters/run.ts";
import { become, canBecome, type Become } from "./runner/become.ts";
import { bunScript } from "./runner/bun.ts";
import { trackCommand } from "./usage/usage.ts";
import { asHedge } from "./reconciler/engine-command.ts";
import { adoptLegacyEnv, customFleetEngine, fleetNotice, hedgeOnMac, inAnyLegacyPath, isOldJob, profileFile, renamedPath, underLegacyPath, withLegacyNames } from "./legacy.ts";
import { importFleet, isCopyOf } from "./import-fleet.ts";
import { fleetAdapter, type FleetAdapter } from "./adapters/fleet/adapter.ts";

/** env: the environment that tells a Coder workspace apart; tests pass their own. */
export type CliOptions = { home: string; engineRoot: string; launchedFrom?: string; platform: NodeJS.Platform; env?: Record<string, string | undefined>; print: (line: string) => void; fail?: (line: string) => void; run?: Runner; terminal?: Terminal; apply?: (profileDir: string, skip?: string[]) => Promise<number>; setup?: Pick<SetupOptions, "machine" | "fetchSource" | "doctor" | "env" | "timeZone" | "clock">; clock?: Clock; adapters?: () => Adapter[]; hostname?: () => string; stdin?: () => ReadableStream<Uint8Array>; capture?: CommandRunner; become?: Become; interactive?: boolean };

const usage = `Hedge: one setup for T3 Code, agents, and your workflows

  hedge setup [--preset <id>] [--add <pack>]... [--remove <pack>]...
              [--workflows <id=on|off,...>] [--set <pack.key=value>]...
              [--plan <claude|codex|both>] [--non-interactive | --chat]
                     Answer a few questions and set up this machine
  hedge apply [--profile <dir>] [--adopt <path>]... [--adopt-from <name>]... [--skip <pack>/<step>]... [--dry-run]
                     Put your profile's packs onto this machine
  hedge doctor [--profile <dir>] [--to-do]
                     Check this machine against your profile without changing it,
                     or print the steps left for you as JSON
  hedge update       Move the engine and your profile forward, then apply
  hedge refresh      Fetch the pack sources that follow a branch, and when one moved,
                     update the files, skills, guides, and instructions of your packs
  hedge packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]...
                     List your packs, or turn packs and workflows on and off
  hedge settings     List the settings of your packs
  hedge set [--set] <pack.key=value>...
                     Change settings
  hedge devbox [add|remove <ssh host>]
                     List your devboxes, make an SSH host one, or remove one you replaced
  hedge devbox address
                     Print this machine's T3 Connect address
  hedge hub here [<ssh name>]
                     Make this machine the hub of your profile
  hedge hub status   Show this machine's name and the hub
  hedge run <pack>/<id> [--repair]
                     Run a pack's service, test one of its checks, or run its repair
  hedge credential <pack>/<id> <node>
                     On the hub, print a served service's credential for a node
  hedge triage [--note <text>] [--print | --save <file> | --send]
                     Show a report of this machine's setup, then send it to the Hedge maintainer
  hedge <command>    Run a command that one of your packs ships`;

const changes = { packs: packsCommand, settings: settingsCommand, set: setCommand };
export const builtins: Record<string, string[]> = { apply: [], doctor: [], update: [], packs: [], settings: [], set: [], hub: ["here", "status"], devbox: ["add", "remove", "address"], run: [], credential: [], setup: [], triage: [] };


export async function main(argv: string[], options: CliOptions): Promise<number> {
  const [command, ...rest] = argv;
  const help = !command || command === "help" || command === "--help";
  if (options.env?.HEDGE_INERT === "1" || [options.engineRoot, options.launchedFrom].some((path) => path !== undefined && underLegacyPath(options.home, path))) return inert(argv, options);
  if (options.env) adoptLegacyEnv(options.env);
  if (help) return options.print(usage), 0;
  if (Object.hasOwn(builtins, command)) trackCommand(options.home, command, rest, builtins[command]!, options.env ?? {}, options.interactive);
  try {
    if (command === "import-fleet") return await bringOverFleet(options);
    if (command === "retire-fleet") return await retireFleet(rest, options);
    if (command === "apply" || command === "doctor") return await reconcile(command, rest, options);
    if (command === "update") return await runUpdate(rest, options);
    if (command === "refresh") return await runRefresh(rest, options);
    if (Object.hasOwn(changes, command) || command === "hub") return await change(command as keyof typeof changes | "hub", rest, options);
    if (command === "devbox") return await devbox(rest, options);
    if (command === "run") return await runItem(rest, options);
    if (command === "credential") return await credential(rest, options);
    if (command === "setup") return await runSetup(rest, options);
    if (command === "triage") return await triage(rest, options);
    return await runPackCommand(command, rest, options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    (options.fail ?? options.print)(`hedge: ${error.message}`);
    return 1;
  }
}

function inert(argv: string[], options: CliOptions) {
  (options.fail ?? options.print)(fleetNotice(options.platform));
  return isOldJob(argv) ? 0 : 1;
}

async function bringOverFleet(options: CliOptions) {
  for (const line of await importFleet(options.home)) options.print(`Hedge: ${line}.`);
  return 0;
}

const fleetOf = (options: CliOptions) => (options.adapters ?? engineAdapters)().find((adapter): adapter is FleetAdapter => adapter.name === "fleet") ?? fleetAdapter();

async function retireFleet(args: string[], options: CliOptions) {
  if (args.length > 1 || (args.length && args[0] !== "--dry-run")) return options.print("Usage: hedge retire-fleet [--dry-run]"), 2;
  const fleet = fleetOf(options);
  const custom = customFleetEngine(options.home, "hedge retire-fleet");
  if (custom) return (options.fail ?? options.print)(`Hedge: ${custom}`), 1;
  if (!fleet.installed(options.home)) return options.print("Hedge: this machine has no Fleet engine install, so there is nothing from before the rename to stop."), 0;
  if (args.length) return listFleet(fleet, options);
  const fail = options.fail ?? options.print;
  const result = await fleet.retire(options.home, options.platform);
  if (!result) return options.print(`Hedge: left the jobs from before the rename alone, because ${options.home} is not your account's home folder.`), 0;
  for (const item of result.retired) options.print(`Hedge: stopped and turned off the ${item} from before the rename, and kept its files.`);
  for (const note of result.notes) options.print(`Hedge: ${note}`);
  if (!result.retired.length && !result.left.length) options.print("Hedge: nothing from before the rename runs.");
  if (!result.left.length) return 0;
  for (const item of result.left) fail(`Hedge: ${item}. Hedge could not verify that it stopped.`);
  fail("Hedge: stop each one by hand, then run hedge retire-fleet again. Hedge starts nothing while Fleet still runs.");
  return 1;
}

async function listFleet(fleet: FleetAdapter, options: CliOptions) {
  const held = await fleet.holds(options.home, options.platform);
  for (const finding of held) options.print(`Hedge: ${finding.say}`);
  if (!held.length) options.print("Hedge: nothing from before the rename runs.");
  return 0;
}

/** Runs hedge setup and records its transcript. A failed step's message names hedge triage. */
async function runSetup(args: string[], options: CliOptions) {
  const record = recordSetup(options.home, options.terminal ?? { ...ttyTerminal(), print: options.print }, args);
  const fail = options.fail ?? options.print;
  const recorded: CliOptions = { ...options, print: (line) => (record.print(line), options.print(line)), fail: (line) => (record.print(line), fail(line)) };
  try {
    return await setup(args, { home: options.home, engineRoot: options.engineRoot, platform: options.platform, ...(options.env ? { env: options.env } : {}), terminal: record.terminal, apply: (dir, skip) => applyProfile(dir, recorded, skip), doctor: (dir) => reconcile("doctor", ["--profile", dir], recorded), ...options.setup });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    record.failed(error.message);
    fail(`hedge: ${error.message}`);
    fail("Stuck? Run hedge triage. It shows a report of this setup that you can send to the Hedge maintainer.");
    return 1;
  }
}

async function triage(args: string[], options: CliOptions) {
  let inspectedProfile: { dir: string; profile: Profile } | undefined;
  const doctor = async () => {
    const lines: string[] = [];
    const collect = (line: string) => void lines.push(line);
    try {
      await reconcile("doctor", [], { ...options, print: collect, fail: collect }, (info) => { inspectedProfile = info; });
    } catch (error) {
      collect(`hedge: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lines;
  };
  try {
    return await triageCommand(args, {
      home: options.home,
      engineRoot: options.engineRoot,
      platform: options.platform,
      terminal: options.terminal ?? { ...ttyTerminal(), print: options.print },
      capture: options.capture ?? spawnRunner,
      hostname: (options.hostname ?? hostname)(),
      doctorProfile: () => inspectedProfile,
      doctor,
    });
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`hedge triage: ${error.message}`);
    return 2;
  }
}

async function reconcile(command: "apply" | "doctor", args: string[], options: CliOptions, onProfile?: (info: { dir: string; profile: Profile }) => void) {
  const flags = parseFlags(args);
  const doctor = command === "doctor";
  if (flags.toDo && !doctor) throw new Error("unknown option --to-do");
  const preview = doctor || flags.dryRun;
  const holds = () => fleetOf(options).holds(options.home, options.platform);
  const held = await holds();
  if (held.length && !preview) return printReport({ ok: false, actions: [], findings: held, humanLeft: [] }, command, options.print, false), 1;
  const { plan, sources, refs, remember } = await loadPlan(options, flags.profile, { fetch: !preview, inherit: preview, onProfile }).catch((error: unknown) => {
    printFindings(held, options.print);
    throw error;
  });
  const stillHeld = preview ? [] : await holds();
  if (stillHeld.length) return printReport({ ok: false, actions: [], findings: stillHeld, humanLeft: [] }, command, options.print, false), 1;
  if (!preview) await remember();
  const adapters = (options.adapters ?? engineAdapters)();
  const issue: Issuer = (entries, node) => issueCredentials(entries, node, plan, sources, options);
  const report = doctor ? await check(plan, { home: options.home, adapters, run: options.run }) : await apply(plan, { home: options.home, adopt: flags.adopt, adoptFrom: flags.adoptFrom, skip: flags.skip, dryRun: flags.dryRun, adapters, run: options.run, issue, progress: options.print });
  if (flags.toDo) return printToDo(report, held, options.print);
  if (doctor) {
    const drifted = await drift(plan, report.humanLeft);
    report.findings.push(...drifted);
    if (drifted.some((finding) => finding.repair)) report.ok = false;
    report.findings.push(...(await unpinnedSources(refs, plan.machine.profileDir!)));
  }
  if (held.length) report.findings.unshift(...held), (report.ok = false);
  const notice = doctor ? await readNotice(options.home) : undefined;
  if (notice) report.findings.push({ id: "update:major", pack: "engine", say: notice });
  printReport(report, command, options.print, flags.dryRun);
  return report.ok ? 0 : 1;
}

async function devbox(args: string[], options: CliOptions) {
  const terminal = options.terminal ?? { ...ttyTerminal(), print: options.print };
  const machine = { ...realMachine, ...options.setup?.machine };
  if (asksAddress(args)) return await printAddress({ terminal, machine });
  const { plan } = await loadPlan(options, undefined, { fetch: false });
  try {
    return await devboxCommand(args, { home: options.home, terminal, machine, machineFile: plan.machine, plan });
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`hedge devbox: ${error.message}`);
    return 2;
  }
}

function changesProfile(command: keyof typeof changes | "hub", args: string[]) {
  return command === "set" || (command === "packs" && args.length > 0) || (command === "hub" && args[0] === "here");
}

function applyProfile(dir: string, options: CliOptions, skip: string[] = []) {
  return options.apply ? options.apply(dir, skip) : reconcile("apply", ["--profile", dir, ...skip.flatMap((step) => ["--skip", step])], options);
}

async function change(command: keyof typeof changes | "hub", args: string[], options: CliOptions) {
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, pull: changesProfile(command, args) });
  const profileDir = plan.machine.profileDir!;
  const profile = await loadProfile(profileDir);
  const context: ChangeContext = {
    profileDir,
    profile,
    plan,
    preview: (answers) => resolve({ ...profile, dir: profileDir, ...answers }, plan.machine, sources),
    packs: sources.flatMap((source) => ("error" in source ? [] : source.packs)),
    machine: { ...realMachine, ...options.setup?.machine },
    print: options.print,
    apply: () => applyProfile(profileDir, options),
  };
  try {
    return await (command === "hub" ? hubCommand(args, { ...context, home: options.home }) : changes[command](args, context));
  } catch (error) {
    if (!(error instanceof FlagError)) throw error;
    options.print(`hedge ${command}: ${error.message}`);
    return 2;
  }
}

const asksHelp = (args: string[]) => args.length === 1 && (args[0] === "--help" || args[0] === "-h");

async function runUpdate(args: string[], options: CliOptions) {
  if (args.length) return options.print("Usage: hedge update"), asksHelp(args) ? 0 : 2;
  if (options.platform !== "darwin") return updateEngine(options);
  const code = await updateEngine(options).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    (options.fail ?? options.print)(`hedge: ${error.message}`);
    return 1;
  });
  if (code !== 0) options.print(hedgeOnMac);
  return code;
}

async function updateEngine(options: CliOptions) {
  const machine = await loadMachine(options.home);
  if (!machine?.profileDir) throw new Error(options.platform === "darwin" ? "no profile on this machine." : "no profile on this machine. Run get.sh, or hedge apply --profile <dir>.");
  const profileDir = hedgeProfile(options, machine.profileDir);
  const profile = await loadProfile(profileDir);
  return update({
    home: options.home,
    engineDir: options.engineRoot,
    profileDir,
    engine: profile.engine,
    platform: options.platform,
    print: options.print,
    runApply: () => Bun.spawn(["sh", join(options.engineRoot, "hedge"), "apply", "--profile", profileDir], { stdio: ["inherit", "inherit", "inherit"], env: { ...Bun.env, HOME: options.home } }).exited,
  });
}

async function runRefresh(args: string[], options: CliOptions) {
  if (args.length) return options.print("Usage: hedge refresh"), 2;
  const machine = await loadMachine(options.home);
  if (!machine?.profileDir) throw new Error("no profile on this machine. Run get.sh, or hedge apply --profile <dir>.");
  const profileDir = hedgeProfile(options, machine.profileDir);
  const profile = await loadProfile(profileDir);
  const applyFiles = async (moved: FetchedSource[]) => {
    const { plan } = await loadPlan(options, profileDir, { fetch: false, fetched: moved });
    if (plan.unanswered.length) {
      for (const setting of plan.unanswered) options.print(`To do: ${setting.question} Answer it with hedge set ${setting.key}=<value>.`);
      return false;
    }
    const result = await filesAdapter.apply(plan, { home: options.home, dryRun: false, adopt: [], adoptFrom: [] });
    printReport({ ok: !result.blocked, actions: result.actions, findings: result.findings, humanLeft: [] }, "apply", options.print);
    return !result.blocked;
  };
  return refresh({ home: options.home, cache: sourceCache(options.home), sources: profile.sources, print: options.print, apply: applyFiles });
}

async function runPackCommand(name: string, args: string[], options: CliOptions) {
  const typed = ["hedge", name, ...args];
  const undone = options.env?.[undoVariable] ? await runUndo(name, args, options) : undefined;
  if (undone !== undefined) return undone;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, inherit: true });
  const command = plan.commands[name];
  if (!command) {
    const owner = sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => existsSync(join(pack.dir, "commands", `${name}.ts`)) || Object.hasOwn(pack.code?.commands ?? {}, name));
    const unloaded = sources.flatMap((source) => ("error" in source ? [`The pack source ${source.ref.name} at ${source.ref.ref} did not load: ${withoutUserinfo(source.error)}.`] : []));
    options.print(owner ? `hedge ${name} comes from the ${owner.manifest.title ?? owner.manifest.name} pack, which is off. Turn it on with hedge packs.` : [`hedge: unknown command ${name}`, ...unloaded].join("\n") + `\n\n${usage}`);
    return 2;
  }
  if (name !== "usage") trackCommand(options.home, name, args, command.subcommands ?? [], options.env ?? {}, options.interactive);
  if (command.on === "hub" && !plan.onHub) return runOnHub(name, args, plan, options);
  const workflow = command.workflow ? plan.workflows.find((entry) => entry.id === command.workflow) : undefined;
  if (workflow && !workflow.active) throw new Error(`hedge ${name} belongs to the ${workflow.id} workflow, which ${workflow.reason === "turned off" ? `is off. Turn it on with hedge packs --workflows ${workflow.id}=on.` : `is off on this machine: it ${workflow.reason}.`}`);
  const loaded = loadedPack(sources, command.pack);
  const run = loaded?.code?.commands[name]?.run;
  const repairs = plan.human.some((step) => step.command !== undefined && asHedge(step.command.trim().split(/\s+/)).join("\n") === typed.join("\n"));
  if (!run && !repairs && options.become) return options.become(bunScript(command.path, ...args), { ...Bun.env, ...packEnvironment(plan, options) });
  const exit = run ? await inPack(plan, loaded!, options, (ctx) => run(args, ctx)) : await spawnPackCommand(command.path, args, plan, options);
  return exit === 0 && repairs ? applyProfile(plan.machine.profileDir!, options) : exit;
}

/** Runs the undo, check or prerequisite of a ledger step whose pack is off, with that pack's own command on this machine, or returns undefined for another command line. When Hedge cannot run it here, it exits cannotTell, so the ledger keeps the step for a later apply. */
async function runUndo(name: string, args: string[], options: CliOptions): Promise<number | undefined> {
  let pack = "";
  const cannot = (why: string) => (options.print(`hedge ${name}: cannot run ${pack ? `the ${pack} pack's command` : "the command"} to undo its step: ${why}`), cannotTell);
  let loaded: Awaited<ReturnType<typeof loadPlan>>;
  try {
    const current = await loadPlan(options, undefined, { fetch: false, inherit: true });
    pack = (await undoingPack(options.home, options.env ?? {}, ["hedge", name, ...args], (old) => listedPack(current.plan, old))) ?? "";
    if (!pack) return undefined;
    loaded = await loadPlan(options, undefined, { fetch: false, inherit: true, withPack: pack });
  } catch (error) {
    return cannot((error as Error).message);
  }
  const { plan, sources } = loaded;
  const command = plan.commands[name];
  const owner = command?.pack === pack ? loadedPack(sources, pack) : undefined;
  if (!command || !owner) return cannot(`the ${pack} pack has no command ${name} here`);
  if (command.on === "hub" && !plan.onHub) return cannot("it runs on the hub");
  const run = owner.code?.commands[name]?.run;
  return run ? await inPack(plan, owner, options, (ctx) => run(args, ctx)) : await spawnPackCommand(command.path, args, plan, options);
}

/** A node of the profile, or a Mac on a profile with a hub, runs a hub command on the hub over the one SSH path, with this terminal. Any other machine is told where it runs. When ssh exits 255, it exits 1, so a caller can fall back to another way. */
async function runOnHub(name: string, args: string[], plan: Plan, options: CliOptions) {
  if (!plan.pullsFromHub) throw new Error(`hedge ${name} runs on the hub${plan.hub ? `, ${plan.hub}` : ""}. Run it there.`);
  const answer = await (options.capture ?? spawnRunner)(onHub(plan.hub!, [name, ...args]), { inherit: true });
  const fail = options.fail ?? options.print;
  for (const line of lines(answer.stdout)) options.print(line);
  for (const line of lines(answer.stderr ?? "")) fail(line);
  if (answer.code !== sshUnreachable) return answer.code;
  fail(`hedge ${name}: ssh to the hub ${plan.hub} exited 255. Either ssh could not reach the hub, or the command failed there with 255.`);
  return 1;
}

const sshUnreachable = 255;

const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);

async function spawnPackCommand(path: string, args: string[], plan: Plan, options: CliOptions) {
  let child: { kill(signal: NodeJS.Signals): void } | undefined;
  const forward = (signal: NodeJS.Signals) => child?.kill(signal);
  process.on("SIGINT", forward).on("SIGTERM", forward);
  try {
    const started = Bun.spawn(bunScript(path, ...args), { stdio: ["inherit", "inherit", "inherit"], env: { ...Bun.env, ...packEnvironment(plan, options) } });
    child = started;
    return await started.exited;
  } finally {
    process.off("SIGINT", forward).off("SIGTERM", forward);
  }
}

async function runItem(args: string[], options: CliOptions) {
  const [item = "", ...extra] = args;
  const slash = item.indexOf("/");
  const [pack, id] = slash < 0 ? ["", ""] : [item.slice(0, slash), item.slice(slash + 1)];
  const repairing = extra.length === 1 && extra[0] === "--repair";
  if (!pack || !id || (extra.length && !repairing)) return options.print("Usage: hedge run <pack>/<id> [--repair]"), 2;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false, inherit: true });
  const loaded = plan.packs.some((entry) => entry.name === pack && entry.available) ? loadedPack(sources, pack) : undefined;
  const code = loaded?.code;
  const job = plan.jobs.find((entry) => entry.pack === pack && entry.id === id);
  const service = job ? code?.services[id] : undefined;
  const check = plan.human.some((step) => step.pack === pack && step.id === id) ? code?.checks[id] : undefined;
  if (!service && !check) {
    const dropped = plan.dropped.find((entry) => entry.pack === pack && (entry.item === `job ${id}` || entry.item === `human ${id}`));
    return options.print(dropped ? `hedge run: ${item} does not run here: ${dropped.reason}` : `hedge run: your packs have no service or check ${item}`), 2;
  }
  const repair = repairing ? code?.repairs[id] : undefined;
  if (repairing && (!check || !repair)) return options.print(`hedge run: ${item} has no repair that Hedge runs`), 2;
  return inPack(plan, loaded!, options, async (ctx) => {
    if (repair) return await repair(ctx), 0;
    if (!service) return (await check!(ctx)) ? 0 : 1;
    const waits = job?.after ? plan.human.find((step) => step.pack === pack && step.id === job.after) : undefined;
    const ready = async () => !waits || (await code!.checks[waits.id]!(ctx));
    if (!(await ready())) {
      options.print(`hedge run: ${item} waits until ${waits!.id} passes. ${waits!.say}${waits!.command ? ` Run: ${waits!.command}` : ""}`);
      do await ctx.sleep(60_000);
      while (!(await ready()));
    }
    return await service(ctx), 0;
  });
}

/** Fills this machine's credential for each served service in the list: the hub asks the service when its pack's secret store holds none, and a node pulls its own from the hub at every apply. A failed issue's finding copies nothing the service threw, since its error may hold its key. */
async function issueCredentials(entries: CatalogEntry[], node: string, plan: Plan, sources: FetchedSource[], options: CliOptions): Promise<Finding[]> {
  if (plan.pullsFromHub) return pullCredentials(entries, node, plan.hub!, options);
  const findings: Finding[] = [];
  for (const entry of entries) {
    const loaded = loadedPack(sources, entry.pack);
    const issue = loaded?.code?.credentials[entry.id];
    const name = credentialName(entry.id);
    if (!issue) continue;
    const stored = await storedSecret(options.home, entry.pack, name);
    if (stored instanceof Error) {
      findings.push({ id: `credential:${entry.pack}/${entry.id}`, pack: entry.pack, say: stored.message, repair: "human" });
      continue;
    }
    if (stored) continue;
    try {
      await inPack(plan, loaded!, options, async (ctx) => {
        await ctx.secrets.write(name, await issued(issue(ctx, node)));
        return 0;
      });
    } catch {
      const service = `${entry.pack}/${entry.id}`;
      findings.push({ id: `credential:${service}`, pack: entry.pack, say: `Could not issue the credential of ${service}. Run hedge credential ${service} ${node} to see why. Hedge tries again at the next apply.`, repair: "apply" });
    }
  }
  return findings;
}

async function issued(value: Promise<string>) {
  const credential = await value;
  if (!credential) throw new Error("it gave no credential");
  return credential;
}

/** A stored secret that the store refuses, such as one that other users can read, comes back as the refusal, which names the file and never the value. */
const storedSecret = (home: string, pack: string, name: string) => secretStore(home, pack).read(name).catch((error: Error) => error);

const pullLimitMs = 90_000;

/** Asks the hub for this node's credential of each service and stores the answer. Each pull ends at a deadline, so a hub that connects but never answers cannot hold the apply. A failed pull keeps what the store holds, and its finding names the exit code and copies nothing the hub printed, since a service may print its key. */
async function pullCredentials(entries: CatalogEntry[], node: string, hub: string, options: CliOptions): Promise<Finding[]> {
  const capture = options.capture ?? spawnRunner;
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  const findings: Finding[] = [];
  for (const entry of entries) {
    const service = `${entry.pack}/${entry.id}`;
    const store = secretStore(options.home, entry.pack);
    const name = credentialName(entry.id);
    const stored = await storedSecret(options.home, entry.pack, name);
    const deadline = new AbortController();
    void clock.sleep(pullLimitMs).then(() => deadline.abort());
    const answer = await capture(onHub(hub, ["credential", service, node]), { signal: deadline.signal });
    const late = deadline.signal.aborted;
    deadline.abort();
    const value = answer.stdout.trim();
    if (answer.code === 0 && value) {
      if (stored !== value) await store.write(name, value);
      continue;
    }
    const reason = late ? `it did not answer within ${pullLimitMs / 1000} seconds` : answer.code === 255 ? `ssh exited 255. Run ssh ${hub} true to see why` : `hedge credential exited ${answer.code} there. Run hedge credential ${service} ${node} on the hub to see why`;
    const kept = stored instanceof Error ? stored.message : stored ? "Kept the one this machine has." : "Hedge tries again at the next apply.";
    findings.push({ id: `credential:${service}`, pack: entry.pack, say: `Could not pull the credential of ${service} from the hub ${hub} (${reason}). ${kept}`, repair: "apply" });
  }
  return findings;
}

/** On the hub: the credential that a served service issues for a node of the profile, printed for that node's pull. */
async function credential(args: string[], options: CliOptions) {
  const [item = "", node, ...extra] = args;
  const slash = item.indexOf("/");
  const [pack, id] = slash < 0 ? ["", ""] : [item.slice(0, slash), item.slice(slash + 1)];
  if (!pack || !id || !node || extra.length) return options.print("Usage: hedge credential <pack>/<id> <node>"), 2;
  const { plan, sources } = await loadPlan(options, undefined, { fetch: false });
  if (!plan.onHub) throw new Error(`hedge credential runs on the hub${plan.hub ? `, ${plan.hub}` : ""}.`);
  if (!plan.catalog?.some((entry) => entry.pack === pack && entry.id === id)) throw new Error(`the service catalog has no ${item}: its workflow or plan is off in your profile.`);
  const loaded = loadedPack(sources, pack)!;
  const issue = loaded.code!.credentials[id]!;
  const said = { ...options, print: options.fail ?? (() => {}) };
  return inPack(plan, loaded, said, async (ctx) => (options.print(await issued(issue(ctx, node))), 0));
}

function loadedPack(sources: FetchedSource[], name: string): LoadedPack | undefined {
  return sources.flatMap((source) => ("error" in source ? [] : source.packs)).find((pack) => pack.manifest.name === name);
}

async function inPack(plan: Plan, loaded: LoadedPack, options: CliOptions, work: (ctx: Awaited<ReturnType<typeof packContext>>) => Promise<number>) {
  const clock = options.clock ?? { now: Date.now, sleep: Bun.sleep };
  const ctx = await packContext({ home: options.home, plan, pack: loaded.manifest.name, code: loaded.code!, workflows: loaded.manifest.workflows ?? [], print: options.print, clock, stdin: options.stdin });
  const environment = packEnvironment(plan, options);
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const assign = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  };
  assign(environment);
  try { return await work(ctx); }
  finally { assign(saved); }
}

export function packEnvironment(plan: Plan, options: Pick<CliOptions, "home" | "engineRoot">): Record<string, string | undefined> {
  return withLegacyNames({ HOME: options.home, HEDGE_ENGINE_DIR: options.engineRoot, HEDGE_PROFILE_DIR: plan.machine.profileDir, HEDGE_SETTINGS: JSON.stringify(plan.settings), HEDGE_MODELS: JSON.stringify(plan.models), HEDGE_PLAN: plan.ai, HEDGE_HANDLERS: JSON.stringify(handlerPaths(plan)), HEDGE_HANDLER_SUBCOMMANDS: JSON.stringify(handlerSubcommands(plan)) });
}

function handlerPaths(plan: Plan) {
  return Object.fromEntries(Object.entries(plan.handlers).map(([seam, handler]) => [seam, handler.path]));
}

function handlerSubcommands(plan: Plan) {
  return Object.fromEntries(Object.entries(plan.handlers).flatMap(([seam, handler]) => (handler.subcommands ? [[seam, handler.subcommands]] : [])));
}

function hedgeProfile(options: CliOptions, dir: string): string {
  const legacy = underLegacyPath(options.home, dir);
  const selected = legacy ? hedgeCopy(options.home, dir) : dir;
  refuseLinkedProfile(selected);
  if (legacy) options.print(`Hedge: uses ${selected}, the copy of ${dir}, because ${dir} is in a Fleet path from before the rename.`);
  return selected;
}

function refuseLinkedProfile(dir: string) {
  if (inAnyLegacyPath(profileFile(dir))) throw new Error(`${profileFile(dir)} is in a Fleet path from before the rename, so Hedge does not use it. Make it a file of its own in ${dir}, or run get.sh to copy the profile.`);
}

function hedgeCopy(home: string, dir: string): string {
  const copy = renamedPath(home, dir);
  if (!copy || underLegacyPath(home, copy) || !existsSync(profileFile(copy)) || inAnyLegacyPath(profileFile(copy)) || !isCopyOf(dir, copy)) throw new Error(`${dir} is in a Fleet path from before the rename, so Hedge does not use it. Run get.sh to copy it, or pass --profile with a profile outside the Fleet paths.`);
  return copy;
}

/** withPack resolves the plan as if the profile also had that pack on, for the undo of one of its steps. */
async function loadPlan(options: CliOptions, profileFlag: string | undefined, mode: { fetch: boolean; inherit?: boolean; pull?: boolean; withPack?: string; fetched?: FetchedSource[]; onProfile?: (info: { dir: string; profile: Profile }) => void }): Promise<{ plan: Plan; sources: FetchedSource[]; refs: SourceRef[]; remember: () => Promise<void> }> {
  const saved = await loadMachine(options.home);
  const inherited = mode.inherit && !profileFlag ? options.env?.HEDGE_PROFILE_DIR : undefined;
  const given = profileFlag ? resolvePath(profileFlag) : inherited ? resolvePath(inherited) : saved?.profileDir;
  if (!given) throw new Error("no profile on this machine. Run get.sh, or pass --profile <dir>.");
  const profileDir = hedgeProfile(options, given);
  const machine: MachineFile = { ...thisMachine(saved, options.platform, options.env ?? {}, (options.hostname ?? hostname)()), profileDir };
  if (mode.pull) await pullProfile(profileDir), refuseLinkedProfile(profileDir);
  const loaded = await loadProfile(profileDir);
  mode.onProfile?.({ dir: profileDir, profile: loaded });
  const profile = mode.withPack && !loaded.packs.includes(mode.withPack) ? { ...loaded, packs: [...loaded.packs, mode.withPack] } : loaded;
  const cache = sourceCache(options.home);
  const known = (ref: SourceRef) => mode.fetched?.find((source) => source.ref.name === ref.name && !("error" in source));
  const engine: AvailableSource = { ref: { name: "engine", repo: profile.engine.repo, ref: profile.engine.ref }, dir: options.engineRoot, packs: await loadPacks(options.engineRoot) };
  const sources = [engine, ...(await Promise.all(profile.sources.map((ref) => known(ref) ?? (mode.fetch ? fetchSource(ref, cache, undefined, options.clock) : cachedSource(ref, cache, options.clock)))))];
  const plan = resolve(profile, machine, sources);
  const changed = saved?.profileDir !== profileDir || saved.role !== plan.machine.role || saved.coder !== plan.machine.coder || saved.name !== plan.machine.name;
  const remember = async () => {
    if (changed) await saveMachine(options.home, plan.machine);
  };
  return { plan, sources, refs: profile.sources, remember };
}

function parseFlags(args: string[]) {
  const flags: { profile?: string; adopt: string[]; adoptFrom: string[]; skip: string[]; dryRun: boolean; toDo: boolean } = { adopt: [], adoptFrom: [], skip: [], dryRun: false, toDo: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--profile") flags.profile = value();
    else if (arg === "--adopt") flags.adopt.push(value());
    else if (arg === "--adopt-from") flags.adoptFrom.push(value());
    else if (arg === "--skip") flags.skip.push(value());
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--to-do") flags.toDo = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return flags;
}

function printReport(report: Report, command: string, print: (line: string) => void, dryRun = false) {
  const changes = report.actions.filter((action) => action.operation !== "keep" && action.operation !== "conflict");
  if (command === "apply") for (const action of changes) print(`${action.operation} ${action.target}`);
  printFindings(report.findings, print);
  const waits = report.findings.some((finding) => finding.todo);
  if (command === "doctor") print(!report.ok ? "Run hedge apply to fix what Hedge can fix." : waits ? "Everything Hedge sets matches your profile. The To do lines above wait for you." : "Everything matches your profile.");
  else if (dryRun) print(report.ok ? `Preview: ${changes.length} change${changes.length === 1 ? "" : "s"} to apply. Nothing was written.` : "Preview: Hedge could not apply your profile. Nothing was written.");
  else print(report.ok ? `Applied ${changes.length} change${changes.length === 1 ? "" : "s"}.` : "Hedge could not apply your profile.");
}

function printToDo(report: Report, held: Report["findings"], print: (line: string) => void) {
  const asks = (finding: Report["findings"][number], step: Report["humanLeft"][number]) => finding.repair === "human" && finding.id === `human:${step.id}` && finding.pack === step.pack;
  const others = [...held, ...report.findings.filter((finding) => (finding.repair || finding.id.startsWith("kept:")) && !report.humanLeft.some((step) => asks(finding, step)))];
  const steps = report.humanLeft.filter((step) => report.findings.some((finding) => asks(finding, step)));
  printFindings(others, print);
  print(JSON.stringify(steps.map(({ pack, id, say, command }) => ({ pack, id, say, ...(command ? { command } : {}) }))));
  return others.length ? 1 : 0;
}

function printFindings(findings: Report["findings"], print: (line: string) => void) {
  for (const finding of findings) print(`${finding.repair === "human" || finding.todo ? "To do" : finding.repair ? "Fix" : "Note"}: ${finding.say}`);
}

if (import.meta.main) {
  const engineRoot = resolvePath(import.meta.dir, "..");
  if (Bun.argv[2] === "setup") {
    process.on("SIGINT", () => {
      console.log("\nStopped. Run hedge setup again to pick up where it stopped.");
      process.exit(130);
    });
  }
  const code = await main(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), engineRoot, launchedFrom: resolvePath(Bun.argv[1]!, "../.."), platform: process.platform, env: Bun.env, print: (line) => console.log(line), fail: (line) => console.error(line), ...(canBecome() ? { become } : {}) });
  process.exit(code);
}
