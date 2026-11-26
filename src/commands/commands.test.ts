import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliOptions } from "../cli.ts";
import type { AvailableSource, PackManifest, ProfileFile } from "../pack/types.ts";
import { defaultSources } from "../setup/defaults.ts";
import { cachedCheckout, isolateGit, spawnGit, template, tempDirs } from "../testing/git.ts";
import { engineSource, resolveEngine } from "../testing/packs.ts";
import { settingsCommand } from "./settings.ts";

isolateGit();
const temp = tempDirs();
const activeHelpers: Array<{ kill(signal?: NodeJS.Signals): void }> = [];
afterEach(() => {
  for (const proc of activeHelpers.splice(0)) {
    try { proc.kill("SIGKILL"); } catch {}
  }
  temp.cleanup();
});

function fifoRead(path: string): Promise<string> {
  const proc = Bun.spawn(["cat", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  activeHelpers.push(proc);
  return new Response(proc.stdout).text();
}

const engineRoot = join(import.meta.dir, "../..");

const profiles = new Map<string, (target: string) => Promise<string>>();

function profileTemplate(settings: Record<string, unknown>) {
  const key = JSON.stringify(settings);
  const built = profiles.get(key) ?? template(async (home) => {
    const remote = join(home, "remote.git");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", remote);
    const dir = join(home, "profile");
    await spawnGit(home, "clone", "-q", remote, dir);
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: defaultSources, packs: ["pull-requests"], plan: "both", settings, workflows: {} };
    writeFileSync(join(dir, "hedge.json"), JSON.stringify(profile, null, 2) + "\n");
    await spawnGit(dir, "add", "hedge.json");
    await spawnGit(dir, "commit", "-q", "-m", "Start");
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
  });
  profiles.set(key, built);
  return built;
}

async function machineWithProfile(settings: Record<string, unknown> = {}) {
  const home = await profileTemplate(settings)(temp.make("home-"));
  const remote = join(home, "remote.git");
  const dir = join(home, "profile");
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: dir }));
  const elsewhere = async (change: (file: ProfileFile) => ProfileFile) => {
    const other = temp.make("other-");
    await spawnGit(other, "clone", "-q", remote, ".");
    writeFileSync(join(other, "hedge.json"), JSON.stringify(change(JSON.parse(readFileSync(join(other, "hedge.json"), "utf8"))), null, 2) + "\n");
    await spawnGit(other, "commit", "-q", "-am", "Elsewhere");
    await spawnGit(other, "push", "-q");
  };
  return { home, elsewhere, pushed: async () => JSON.parse(await spawnGit(home, "--git-dir", remote, "show", "main:hedge.json")) };
}

/** Puts a fetched source with a team pack in this machine's cache, and turns that pack on in the profile. */
async function withTeamPack(home: string, parts: Pick<PackManifest, "workflows" | "human" | "steps">) {
  const source = join(home, ".local/share/hedge/sources/team");
  await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
  mkdirSync(join(source, "packs/team"), { recursive: true });
  writeFileSync(join(source, "packs/team/pack.json"), JSON.stringify({ schema: 1, name: "team", summary: "Team rules.", ...parts }));
  const dir = join(home, "profile");
  const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")) as ProfileFile;
  writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...file.packs, "team"] }, null, 2) + "\n");
  await spawnGit(dir, "commit", "-q", "-am", "Team");
  await spawnGit(dir, "push", "-q");
}

const flow = (id: string, options: { yields?: string[]; default?: boolean } = {}) => ({ id, name: id, sentence: `${id}.`, default: options.default ?? true, yields: options.yields ?? [] });

const withYieldingPack = (home: string) => withTeamPack(home, { workflows: [flow("direct", { yields: ["routed"] }), flow("routed")] });

const humanStep = (id: string, probe: string, workflow?: string) => ({ id, say: `Set up ${id}.`, probe: ["sh", "-c", probe], ...(workflow ? { workflow } : {}) });

async function hedge(home: string, args: string[], applyCode = 0, options: Partial<CliOptions> = {}) {
  const lines: string[] = [];
  const applied: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), applyCode);
  const code = await main(args, { home, engineRoot, platform: "linux", print: (line) => lines.push(line), apply, ...options });
  return { code, output: lines.join("\n"), applied };
}

describe("hedge packs", () => {
  test("lists every pack, marks the ones that are on, and shows their workflows", async () => {
    const { home } = await machineWithProfile();
    const result = await hedge(home, ["packs"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ pull-requests  ");
    expect(result.output).toContain("      Workflows: draft-prs on, pr-care on, ship-words on");
    expect(result.output).toContain("  · memory  ");
    expect(result.output).toEndWith("Change them with hedge packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]....");
  });

  test("turns packs and workflows on and off, pushes the profile, and applies here", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["packs", "--add", "communication", "--workflows", "quality-loop=on,pr-care=off"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ Saved your packs in your profile and pushed it.");
    expect(result.output).toEndWith("This machine has it now. Your other machines pick it up at their next hedge update.");
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "quality-loop": true, "pr-care": false } });
    expect(result.applied).toEqual([join(home, "profile")]);

    const removed = await hedge(home, ["packs", "--remove", "communication", "--workflows", "pr-care=on"]);
    expect(removed.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests"], workflows: { "quality-loop": true } });
  });

  test("works on the packs and workflows another machine pushed, so a change here keeps theirs", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: [...file.packs, "memory"], workflows: { "pr-care": false } }));
    const result = await hedge(home, ["packs", "--add", "communication"]);
    expect(result.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "memory", "communication"], workflows: { "pr-care": false } });
  });

  test("shows a workflow's terms note in the list and again when it is turned on", async () => {
    const { home, pushed } = await machineWithProfile();
    const risk = JSON.parse(await Bun.file(join(engineRoot, "packs/hub/pack.json")).text()).workflows.find((workflow: { id: string }) => workflow.id === "own-account-balancing").risk;
    expect(risk).toContain("Anthropic");
    const before = await hedge(home, ["packs"]);
    expect(before.output).not.toContain("Terms note for own-account-balancing");

    const turnedOn = await hedge(home, ["packs", "--add", "hub", "--workflows", "own-account-balancing=on"]);
    expect(turnedOn.code).toBe(0);
    expect(turnedOn.output).toContain(`Before you use Own-account balancing: ${risk}`);
    expect(await pushed()).toMatchObject({ workflows: { "own-account-balancing": true } });

    const listed = await hedge(home, ["packs"]);
    expect(listed.output).toContain(`      Terms note for own-account-balancing: ${risk}`);
    const off = await hedge(home, ["packs", "--workflows", "own-account-balancing=off"]);
    expect(off.output).not.toContain("Before you use");
  });

  test("shows the terms note when re-adding a pack brings back a workflow that was left on", async () => {
    const { home, pushed } = await machineWithProfile();
    await hedge(home, ["packs", "--add", "hub", "--workflows", "own-account-balancing=on"]);
    const removed = await hedge(home, ["packs", "--remove", "hub"]);
    expect(removed.output).not.toContain("Before you use");
    expect(await pushed()).toMatchObject({ workflows: { "own-account-balancing": true } });

    const readded = await hedge(home, ["packs", "--add", "hub"]);
    expect(readded.output).toContain("Before you use Own-account balancing: ");
    const unrelated = await hedge(home, ["packs", "--add", "communication"]);
    expect(unrelated.output).not.toContain("Before you use");
  });

  test("keeps workflow choices of packs whose source is not on this machine, and takes --set like setup", async () => {
    const { home, pushed } = await machineWithProfile();
    const dir = join(home, "profile");
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...JSON.parse(await spawnGit(dir, "show", "HEAD:hedge.json")), workflows: { "team-dangerous": false } }, null, 2) + "\n");
    await spawnGit(dir, "commit", "-q", "-am", "Turn off a team workflow");
    const result = await hedge(home, ["packs", "--add", "communication", "--set", "pull-requests.freeReviews=3"]);
    expect(result.code).toBe(0);
    expect(await pushed()).toMatchObject({ packs: ["pull-requests", "communication"], workflows: { "team-dangerous": false }, settings: { "pull-requests.freeReviews": 3 } });
  });

  test("refuses to leave a pack without a pack it needs", async () => {
    const { home, pushed } = await machineWithProfile();
    expect((await hedge(home, ["packs", "--add", "orchestration"])).code).toBe(0);
    const result = await hedge(home, ["packs", "--remove", "pull-requests"]);
    expect(result.code).toBe(2);
    expect(result.output).toStartWith("hedge packs: Orchestration needs Quality gates. Add pull-requests, or remove orchestration.");
    expect((await pushed()).packs).toEqual(["pull-requests", "orchestration"]);
  });

  test("a change that does not apply here stays saved, and says how to finish", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["packs", "--add", "communication"], 1);
    expect(result.code).toBe(1);
    expect((await pushed()).packs).toEqual(["pull-requests", "communication"]);
    expect(result.output).toEndWith("The change is saved. Fix what it says above, then run hedge apply.");
  });

  test("says why a workflow is off when it yields, in the list and when a choice to turn it on has no effect", async () => {
    const { home } = await machineWithProfile();
    await withYieldingPack(home);
    expect((await hedge(home, ["packs"])).output).toContain("      Workflows: direct off: yields to workflow routed, routed on");
    const turnedOn = await hedge(home, ["packs", "--workflows", "direct=on"]);
    expect(turnedOn.code).toBe(0);
    expect(turnedOn.output).toContain("direct is on in your profile, but stays off: yields to workflow routed.");
    const swapped = await hedge(home, ["packs", "--workflows", "direct=on,routed=off"]);
    expect(swapped.output).not.toContain("stays off");
  });

  test("refuses unknown packs and workflows without touching the profile", async () => {
    const { home, pushed } = await machineWithProfile();
    for (const [args, message] of [
      [["--add", "nope"], "hedge packs: no pack named nope."],
      [["--remove", "base"], "hedge packs: the base pack is always on"],
      [["--workflows", "nope=on"], "hedge packs: --workflows: no workflow named nope"],
      [["--preset", "starter"], "hedge packs: usage: hedge packs"],
    ] as const) {
      const result = await hedge(home, ["packs", ...args]);
      expect(result.code).toBe(2);
      expect(result.output).toStartWith(message);
    }
    expect((await pushed()).packs).toEqual(["pull-requests"]);
  });
});

describe("hedge packs on a machine that has not finished a pack's setup", () => {
  const needsSetup = "      Needs setup on this machine. Run hedge doctor for the steps.";

  test("marks a workflow whose human step does not pass here as needing setup, and its pack as not done, until the step passes", async () => {
    const { home } = await machineWithProfile();
    await withTeamPack(home, { workflows: [flow("allowlist"), flow("oom")], human: [humanStep("allowlist", 'test -f "$HOME/allowlist-done"', "allowlist"), humanStep("oom", "true", "oom")] });

    const before = await hedge(home, ["packs"]);
    expect(before.code).toBe(0);
    expect(before.output).toContain(`  ~ team  Team rules.\n      Workflows: allowlist needs setup, oom on\n${needsSetup}`);

    writeFileSync(join(home, "allowlist-done"), "");
    const after = await hedge(home, ["packs"]);
    expect(after.output).toContain("  ✓ team  Team rules.\n      Workflows: allowlist on, oom on");
    expect(after.output).not.toContain(needsSetup);
  });

  test("runs no human step of a workflow that is off, so it leaves the pack done", async () => {
    const { home } = await machineWithProfile();
    await withTeamPack(home, { workflows: [flow("allowlist", { default: false })], human: [humanStep("allowlist", 'touch "$HOME/probed"; exit 1', "allowlist")] });

    const result = await hedge(home, ["packs"]);
    expect(result.output).toContain("  ✓ team  Team rules.\n      Workflows: allowlist off");
    expect(result.output).not.toContain(needsSetup);
    expect(existsSync(join(home, "probed"))).toBe(false);
  });

  test("marks a pack whose own human step does not pass here, and keeps its workflows on", async () => {
    const { home } = await machineWithProfile();
    await withTeamPack(home, { workflows: [flow("allowlist")], human: [humanStep("sign-in", "exit 1")] });

    expect((await hedge(home, ["packs"])).output).toContain(`  ~ team  Team rules.\n      Workflows: allowlist on\n${needsSetup}`);
  });

  const blockedProbe = (trap: string) => `exec 3>"$HOME/gone"; trap ${trap} TERM; sleep 30 & echo $! > "$HOME/ready"; wait`;

  async function withBlockedProbe(home: string, trap = "-") {
    const [ready, gone] = [join(home, "ready"), join(home, "gone")];
    expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
    await withTeamPack(home, { workflows: [flow("allowlist")], human: [humanStep("allowlist", blockedProbe(trap), "allowlist")] });
    return { holderGone: fifoRead(gone), started: fifoRead(ready) };
  }

  const endHolder = async (started: Promise<string>) => {
    const pid = Number((await Promise.race([started, Promise.resolve("")])).trim());
    if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
    return pid > 0;
  };

  const notChecked = "  ? team  Team rules.\n      Workflows: allowlist not checked\n      Hedge could not check this pack's setup right now. Run hedge doctor.";

  test("says a human step that does not answer in time is not checked, even when it exits well once asked to stop, and stops every process it started", async () => {
    const { home } = await machineWithProfile();
    const trapped = join(home, "trapped");
    expect(Bun.spawnSync(["mkfifo", trapped]).exitCode).toBe(0);
    const { holderGone, started } = await withBlockedProbe(home, '"echo trapped > \\"$HOME/trapped\\"; exit 0"');
    const sawTrap = fifoRead(trapped);
    const timesOutOnceStarted = { now: () => 0, sleep: async () => void (await started) };
    try {
      expect((await hedge(home, ["packs"], 0, { clock: timesOutOnceStarted })).output).toContain(notChecked);
      expect(await holderGone).toBe("");
      expect((await sawTrap).trim()).toBe("trapped");
    } finally {
      await endHolder(started);
    }
  });

  test("lists the packs at the deadline even when a human step ignores the request to stop", async () => {
    const { home } = await machineWithProfile();
    const { started, holderGone } = await withBlockedProbe(home, '""');
    const timesOutOnceStarted = { now: () => 0, sleep: async () => void (await started) };
    try {
      expect((await hedge(home, ["packs"], 0, { clock: timesOutOnceStarted, probeGraceMs: 0 })).output).toContain(notChecked);
      expect(await holderGone).toBe("");
    } finally {
      await endHolder(started);
    }
  });

  test("reports a failing human step that exits nonzero while leaving its background helper running and stopping a slow probe at the deadline", async () => {
    const { home } = await machineWithProfile();
    const [childReady, ready, gone, slowReady, slowGone, allowDone] = [
      join(home, "child-ready"),
      join(home, "ready"),
      join(home, "gone"),
      join(home, "slow-ready"),
      join(home, "slow-gone"),
      join(home, "allow-done"),
    ];
    expect(Bun.spawnSync(["mkfifo", childReady, ready, gone, slowReady, slowGone, allowDone]).exitCode).toBe(0);
    const childBin = join(home, "helper-child.sh");
    writeFileSync(
      childBin,
      '#!/bin/sh\nexec 3>"$1"\necho $$ > "$2"\nexec sleep 30\n',
      { mode: 0o755 },
    );
    const fillers = Array.from({ length: 6 }, (_, i) => humanStep(`hold-${i}`, "exec sleep 30"));
    await withTeamPack(home, {
      workflows: [flow("allowlist"), flow("slow")],
      human: [
        humanStep("allowlist", `${JSON.stringify(childBin)} "$HOME/gone" "$HOME/child-ready" & pid=$(cat "$HOME/child-ready"); echo "$pid" > "$HOME/ready"; exit 7`, "allowlist"),
        humanStep("slow", 'exec 3>"$HOME/slow-gone"; echo $$ > "$HOME/slow-ready"; exec sleep 30', "slow"),
        ...fillers,
        humanStep("after-allow", 'echo done > "$HOME/allow-done"; exec sleep 30'),
      ],
    });
    const [started, holderGone, slowStarted, slowClosed, allowFinished] = [
      fifoRead(ready),
      fifoRead(gone),
      fifoRead(slowReady),
      fifoRead(slowGone),
      fifoRead(allowDone),
    ];
    const deadlineAfterAllowDone = {
      now: () => 0,
      sleep: async () => void (await Promise.all([started, slowStarted, allowFinished])),
    };
    try {
      const output = (await hedge(home, ["packs"], 0, { clock: deadlineAfterAllowDone })).output;
      expect(output).toContain("allowlist needs setup");
      expect(output).toContain("slow not checked");
      expect(await slowClosed).toBe("");
      const helperPid = Number((await started).trim());
      expect(helperPid).toBeGreaterThan(0);
      expect(() => process.kill(helperPid, 0)).not.toThrow();
    } finally {
      await endHolder(started);
      await endHolder(slowStarted);
      await holderGone.catch(() => {});
    }
  });

  test("resolves probe executables via PATH, allows execute-only binaries, and rejects no-shebang scripts and leading --, matching hedge doctor", async () => {
    const { home } = await machineWithProfile();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "set"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const noShebang = join(bin, "plain-script");
    writeFileSync(noShebang, "exit 0\n", { mode: 0o755 });
    const execOnly = join(bin, "exec-only-true");
    copyFileSync(Bun.which("true")!, execOnly);
    chmodSync(execOnly, 0o111);
    await withTeamPack(home, {
      workflows: [flow("external"), flow("builtin"), flow("noshebang"), flow("execonly"), flow("dashdash"), flow("largeargs"), flow("nonzero"), flow("selfterm")],
      human: [
        { id: "external", say: "Check external set.", probe: ["set", "--hedge-external-flag"], workflow: "external" },
        { id: "builtin", say: "Check builtin export.", probe: ["export", "HEDGE_BUILTIN=1"], workflow: "builtin" },
        { id: "noshebang", say: "Check plain script.", probe: [noShebang], workflow: "noshebang" },
        { id: "execonly", say: "Check execute-only binary.", probe: [execOnly], workflow: "execonly" },
        { id: "dashdash", say: "Check leading --.", probe: ["--", "true"], workflow: "dashdash" },
        { id: "largeargs", say: "Check large probe argv.", probe: [Bun.which("true")!, "a".repeat(70_000), "b".repeat(70_000)], workflow: "largeargs" },
        { id: "nonzero", say: "Check nonzero exit.", probe: ["sh", "-c", "exit 7"], workflow: "nonzero" },
        { id: "selfterm", say: "Check self-group SIGTERM.", probe: ["sh", "-c", 'trap "exit 42" TERM; kill -TERM 0'], workflow: "selfterm" },
      ],
    });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    try {
      const output = (await hedge(home, ["packs"])).output;
      expect(output).toContain(`  ~ team  Team rules.\n      Workflows: external on, builtin needs setup, noshebang needs setup, execonly on, dashdash needs setup, largeargs on, nonzero needs setup, selfterm needs setup\n${needsSetup}`);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      chmodSync(execOnly, 0o755);
    }
  });

  for (const [sig, trapName, exitCode] of [
    ["SIGINT", "INT", 130],
    ["SIGQUIT", "QUIT", 131],
  ] as const) {
    test(`forwards ${sig} to human steps so ${sig} cleanup traps run without being preempted by SIGTERM`, async () => {
      const { home } = await machineWithProfile();
      const [ready, fgGone, cleaned] = [join(home, "ready"), join(home, "fg-gone"), join(home, "cleaned")];
      expect(Bun.spawnSync(["mkfifo", ready, fgGone, cleaned]).exitCode).toBe(0);
      await withTeamPack(home, {
        workflows: [flow("allowlist")],
        human: [humanStep("allowlist", `trap "" TERM; sleep 30 & pid=$!; trap 'kill $pid 2>/dev/null; echo cleaned > "$HOME/cleaned"; exit ${exitCode}' ${trapName}; exec 3>"$HOME/fg-gone"; ps -o pgid= -p $$ | tr -d " " > "$HOME/ready"; wait`, "allowlist")],
      });
      const [fgClosed, sawClean, started] = [fifoRead(fgGone), fifoRead(cleaned), fifoRead(ready)];
      const listing = Bun.spawn([process.execPath, join(engineRoot, "src/cli.ts"), "packs"], { env: { ...Bun.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        await started;
        listing.kill(sig);
        expect((await sawClean).trim()).toBe("cleaned");
        expect(await fgClosed).toBe("");
        expect(await listing.exited).not.toBe(0);
      } finally {
        listing.kill("SIGKILL");
        const pgid = Number((await Promise.race([started, Promise.resolve("")])).trim());
        if (pgid > 0) try { process.kill(-pgid, "SIGKILL"); } catch {}
      }
    });
  }

  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    test(`stops foreground and background children of human steps when hedge packs receives ${sig}`, async () => {
      const { home } = await machineWithProfile();
      const { holderGone, started } = await withBlockedProbe(home);
      const listing = Bun.spawn([process.execPath, join(engineRoot, "src/cli.ts"), "packs"], { env: { ...Bun.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        await started;
        listing.kill(sig);
        expect(await holderGone).toBe("");
        expect(await listing.exited).not.toBe(0);
      } finally {
        listing.kill("SIGKILL");
        await endHolder(started);
      }
    });
  }

  test("stops a human step running in a separate process group or detached session at the deadline", async () => {
    const { home: pgidHome } = await machineWithProfile();
    const [pgidReady, pgidGone] = [join(pgidHome, "ready"), join(pgidHome, "gone")];
    expect(Bun.spawnSync(["mkfifo", pgidReady, pgidGone]).exitCode).toBe(0);
    const pgidScript = `import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
if (lib.symbols.setpgid(0, 0) !== 0) process.exit(2);
const c = Bun.spawn(["sh", "-c", 'exec 3>"$HOME/gone"; sleep 30 & echo $! > "$HOME/ready"; wait'], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
process.exit(await c.exited);`;
    await withTeamPack(pgidHome, {
      workflows: [flow("allowlist")],
      human: [{ id: "allowlist", say: "Allowlist.", workflow: "allowlist", probe: [process.execPath, "-e", pgidScript] }],
    });
    const [pgidStarted, pgidClosed] = [fifoRead(pgidReady), fifoRead(pgidGone)];
    const timesOutOncePgidStarted = { now: () => 0, sleep: async () => void (await pgidStarted) };
    try {
      expect((await hedge(pgidHome, ["packs"], 0, { clock: timesOutOncePgidStarted })).output).toContain(notChecked);
      expect(await pgidClosed).toBe("");
    } finally {
      await endHolder(pgidStarted);
    }

    const { home: sidHome } = await machineWithProfile();
    const [sidReady, sidGone] = [join(sidHome, "ready"), join(sidHome, "gone")];
    expect(Bun.spawnSync(["mkfifo", sidReady, sidGone]).exitCode).toBe(0);
    const sidScript = `const c = Bun.spawn(["sh", "-c", 'exec 3>"$HOME/gone"; echo $$ > "$HOME/ready"; exec sleep 30'], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
process.exit(await c.exited);`;
    await withTeamPack(sidHome, {
      workflows: [flow("allowlist")],
      human: [{ id: "allowlist", say: "Allowlist.", workflow: "allowlist", probe: [process.execPath, "-e", sidScript] }],
    });
    const [sidStarted, sidClosed] = [fifoRead(sidReady), fifoRead(sidGone)];
    const timesOutOnceSidStarted = { now: () => 0, sleep: async () => void (await sidStarted) };
    try {
      expect((await hedge(sidHome, ["packs"], 0, { clock: timesOutOnceSidStarted })).output).toContain(notChecked);
      expect(await sidClosed).toBe("");
    } finally {
      await endHolder(sidStarted);
    }
  });

  test("propagates pack-level human prerequisite timeouts to dependent workflows and prints both hints when another probe fails", async () => {
    const { home } = await machineWithProfile();
    const [ready, gone, allowDone] = [join(home, "ready"), join(home, "gone"), join(home, "allow-done")];
    expect(Bun.spawnSync(["mkfifo", ready, gone, allowDone]).exitCode).toBe(0);
    const fillers = Array.from({ length: 6 }, (_, i) => humanStep(`hold-${i}`, "exec sleep 30"));
    await withTeamPack(home, {
      workflows: [flow("allowlist"), flow("sync")],
      human: [
        humanStep("allowlist", "exit 1", "allowlist"),
        humanStep("sign-in", blockedProbe("-")),
        ...fillers,
        humanStep("after-allow", 'echo done > "$HOME/allow-done"; exec sleep 30'),
      ],
      steps: [{ id: "sync-step", workflow: "sync", after: "sign-in", run: ["true"] }],
    });
    const [holderGone, started, allowFinished] = [fifoRead(gone), fifoRead(ready), fifoRead(allowDone)];
    const timesOutOnceStarted = {
      now: () => 0,
      sleep: async () => void (await Promise.all([started, allowFinished])),
    };
    try {
      const output = (await hedge(home, ["packs"], 0, { clock: timesOutOnceStarted })).output;
      expect(output).toContain("  ~ team  Team rules.\n      Workflows: allowlist needs setup, sync not checked\n      Needs setup on this machine. Run hedge doctor for the steps.\n      Hedge could not check this pack's setup right now. Run hedge doctor.");
      expect(await holderGone).toBe("");
    } finally {
      await endHolder(started);
    }
  });

  test("propagates a failing prerequisite to a workflow whose only item is a served service on the hub, and not on a node", async () => {
    const { home } = await machineWithProfile();
    const source = join(home, ".local/share/hedge/sources/team");
    await cachedCheckout(source, { name: "team", repo: "team/packs", ref: "main" });
    mkdirSync(join(source, "packs/team"), { recursive: true });
    writeFileSync(
      join(source, "packs/team/pack.ts"),
      `export default {
  sdk: 1,
  name: "team",
  summary: "Team rules.",
  register(hedge) {
    const serviceOnly = hedge.workflow({ id: "service-only", name: "Service only", sentence: "Serves on the hub.", default: true });
    const signIn = hedge.check({ id: "sign-in", say: "Sign in.", test: async () => false, repair: { ask: "Sign in." } });
    hedge.service({ on: "hub", id: "svc", when: serviceOnly, after: signIn, serve: { port: 4599, health: "/health", credential: async () => "x" } });
  },
};
`,
    );
    const dir = join(home, "profile");
    const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...file, sources: [...file.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...file.packs, "team"] }, null, 2) + "\n");
    await spawnGit(dir, "commit", "-q", "-am", "Team pack.ts");
    await spawnGit(dir, "push", "-q");

    const onHub = await hedge(home, ["packs"]);
    expect(onHub.code).toBe(0);
    expect(onHub.output).toContain(`  ~ team  Team rules.\n      Workflows: service-only needs setup\n${needsSetup}`);

    writeFileSync(join(dir, "hedge.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")), hub: "hub-1", devboxes: ["node-2"] }, null, 2) + "\n");
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox", name: "node-2", profileDir: dir }));
    const onNode = await hedge(home, ["packs"]);
    expect(onNode.code).toBe(0);
    expect(onNode.output).toContain(`  ~ team  Team rules.\n      Workflows: service-only on\n${needsSetup}`);

    const { home: soloSvcHome } = await machineWithProfile();
    const soloSvcSource = join(soloSvcHome, ".local/share/hedge/sources/team");
    await cachedCheckout(soloSvcSource, { name: "team", repo: "team/packs", ref: "main" });
    mkdirSync(join(soloSvcSource, "packs/team"), { recursive: true });
    writeFileSync(
      join(soloSvcSource, "packs/team/pack.ts"),
      `export default {
  sdk: 1,
  name: "team",
  summary: "Team rules.",
  register(hedge) {
    const linuxSvc = hedge.workflow({ id: "linux-svc", name: "Linux svc", sentence: "Serves on Linux.", default: true });
    const signIn = hedge.check({ id: "sign-in", say: "Sign in.", test: async () => false, repair: { ask: "Sign in." } });
    hedge.service({ on: "hub", os: "linux", id: "svc", when: linuxSvc, after: signIn, serve: { port: 4599, health: "/health", credential: async () => "x" } });
  },
};
`,
    );
    const soloSvcDir = join(soloSvcHome, "profile");
    const soloSvcBase = JSON.parse(readFileSync(join(soloSvcDir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(join(soloSvcDir, "hedge.json"), JSON.stringify({ ...soloSvcBase, sources: [...soloSvcBase.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...soloSvcBase.packs, "team"] }, null, 2) + "\n");
    writeFileSync(join(soloSvcHome, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", profileDir: soloSvcDir }));
    const soloMacSvc = await hedge(soloSvcHome, ["packs"], 0, { platform: "darwin" });
    expect(soloMacSvc.code).toBe(0);
    expect(soloMacSvc.output).toContain(`  ~ team  Team rules.\n      Workflows: linux-svc on\n${needsSetup}`);

    const { home: osHome } = await machineWithProfile();
    await withTeamPack(osHome, {
      workflows: [flow("linux-wf"), flow("mac-wf")],
      human: [{ id: "sign-in", say: "Sign in.", probe: ["false"] }],
      steps: [
        { id: "linux-step", on: ["linux"], workflow: "linux-wf", after: "sign-in", run: ["true"] },
        { id: "mac-step", on: ["darwin"], workflow: "mac-wf", after: "sign-in", run: ["true"] },
      ],
    });
    const osDir = join(osHome, "profile");
    const osFile = JSON.parse(readFileSync(join(osDir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(join(osDir, "hedge.json"), JSON.stringify({ ...osFile, hub: "hub-1" }, null, 2) + "\n");
    writeFileSync(join(osHome, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "hub", name: "hub-1", profileDir: osDir }));
    const linuxHub = await hedge(osHome, ["packs"], 0, { platform: "linux" });
    expect(linuxHub.code).toBe(0);
    expect(linuxHub.output).toContain(`  ~ team  Team rules.\n      Workflows: linux-wf needs setup, mac-wf on\n${needsSetup}`);

    const soloMacProfile = JSON.parse(readFileSync(join(osDir, "hedge.json"), "utf8")) as ProfileFile;
    delete soloMacProfile.hub;
    writeFileSync(join(osDir, "hedge.json"), JSON.stringify(soloMacProfile, null, 2) + "\n");
    writeFileSync(join(osHome, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", profileDir: osDir }));
    const soloMac = await hedge(osHome, ["packs"], 0, { platform: "darwin" });
    expect(soloMac.code).toBe(0);
    expect(soloMac.output).toContain(`  ~ team  Team rules.\n      Workflows: linux-wf on, mac-wf needs setup\n${needsSetup}`);

    const { home: roleHome } = await machineWithProfile();
    const roleSource = join(roleHome, ".local/share/hedge/sources/team");
    await cachedCheckout(roleSource, { name: "team", repo: "team/packs", ref: "main" });
    mkdirSync(join(roleSource, "packs/team"), { recursive: true });
    writeFileSync(
      join(roleSource, "packs/team/pack.ts"),
      `export default {
  sdk: 1,
  name: "team",
  summary: "Team rules.",
  register(hedge) {
    const serverWf = hedge.workflow({ id: "server-wf", name: "server-wf", sentence: "Server.", default: true, needs: ["hub"] });
    const localWf = hedge.workflow({ id: "local-wf", name: "local-wf", sentence: "Local.", default: true, yields: ["server-wf"] });
    const signIn = hedge.check({ id: "sign-in", say: "Sign in.", test: async () => false, repair: { ask: "Sign in." } });
    hedge.service({ on: "hub", id: "svc", when: serverWf, after: signIn, serve: { port: 4599, health: "/health", credential: async () => "x" } });
    hedge.service({ on: "hub", id: "local-svc", when: localWf, serve: { port: 4599, health: "/health", credential: async () => "x" } });
  },
};
`,
    );
    const roleDir = join(roleHome, "profile");
    const roleFile = JSON.parse(readFileSync(join(roleDir, "hedge.json"), "utf8")) as ProfileFile;
    writeFileSync(
      join(roleDir, "hedge.json"),
      JSON.stringify({ ...roleFile, sources: [...roleFile.sources, { name: "team", repo: "team/packs", ref: "main" }], packs: [...roleFile.packs, "team"] }, null, 2) + "\n",
    );
    writeFileSync(join(roleHome, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", profileDir: roleDir }));
    const roleMac = await hedge(roleHome, ["packs"], 0, { platform: "darwin" });
    expect(roleMac.code).toBe(0);
    expect(roleMac.output).toContain("local-wf on");
    expect(roleMac.output).not.toContain("local-wf needs setup");
  });
});

describe("hedge packs with a profile that still names an old pack", () => {
  test("adds or removes exactly the name given and saves an old name as written, so removing recovery leaves Hub fully on", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "hub"] }));
    expect((await hedge(home, ["packs", "--add", "recovery", "--add", "context-library"])).code).toBe(0);
    expect((await pushed()).packs).toEqual(["pull-requests", "hub", "recovery", "context-library"]);
    const listed = (await hedge(home, ["packs"])).output;
    expect(listed).toContain("  · memory  ");
    expect(listed).toContain("      The old name context-library selects only: context-library. Add memory for the whole pack.\n      Workflows: shared-memory off, context-library off: waits for setting context-library.repo, dream off");
    expect(listed).not.toContain("Only part is on");
    expect(listed).not.toContain("context-library  ");
    expect((await hedge(home, ["packs", "--remove", "recovery"])).code).toBe(0);
    expect((await pushed()).packs).toEqual(["pull-requests", "hub", "context-library"]);
    expect((await hedge(home, ["packs"])).output).toContain("disk-watch on, linked-hub on");
  });

  test("keeps a workflow value the profile states when a change leaves it alone, even one that equals the default, and adds only choices that differ from it", async () => {
    const { home, elsewhere, pushed } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "guards"], workflows: { "shell-guards": true, "package-age": true } }));
    expect((await hedge(home, ["packs", "--add", "communication", "--workflows", "merge-gate=off"])).code).toBe(0);
    expect((await pushed()).workflows).toEqual({ "shell-guards": true, "package-age": true });
  });

  test("says a workflow stays off for a missing setting only when the same command does not set it", async () => {
    const { home, elsewhere } = await machineWithProfile();
    await elsewhere((file) => ({ ...file, packs: ["pull-requests", "context-library"], workflows: { "context-library": false } }));
    const warning = "context-library is on in your profile, but stays off: waits for setting context-library.repo.";
    expect((await hedge(home, ["packs", "--workflows", "context-library=on"])).output).toContain(warning);
    expect((await hedge(home, ["packs", "--workflows", "context-library=on", "--set", "context-library.repo=example/library"])).output).not.toContain(warning);
  });
});

describe("hedge settings and hedge set", () => {
  test("lists the settings of the packs that are on, with defaults marked", async () => {
    const { home } = await machineWithProfile({ "pull-requests.panelSlots": 4 });
    const result = await hedge(home, ["settings"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  pull-requests.freeReviews = 2 (default)");
    expect(result.output).toContain("  pull-requests.panelSlots = 4");
    expect(result.output).toContain("  pull-requests.mergeCommand = not set");
    expect(result.output).not.toContain("memory.repo");
    expect(result.output).toEndWith("Change one with hedge set <pack.key>=<value>.");
  });

  test("lists an engine setting once when a pack overrides its default, with the value that wins", async () => {
    const engine = await engineSource();
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], default: "1password", ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const plan = resolveEngine([engine, team], { packs: ["team"] });
    const lines: string[] = [];
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [team.ref], packs: ["team"], plan: "both", settings: {}, workflows: {} } satisfies ProfileFile;
    const code = settingsCommand([], { profile, plan, packs: [...engine.packs, ...team.packs], print: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(lines.filter((line) => line.includes("identity.signer ="))).toEqual(["  identity.signer = 1password (default)"]);
    expect(lines).not.toContain("team:");
  });

  test("says Hedge needs an engine setting only when the declaration that wins needs it", async () => {
    const engine = await engineSource();
    const signer = { key: "identity.signer", question: "Which key signs?", type: "choice" as const, choices: [{ value: "1password", label: "1Password" }], optional: true as const, ask: "never" as const };
    const team: AvailableSource = { ref: { name: "team", repo: "team/packs", ref: "main" }, dir: "/team", packs: [{ manifest: { schema: 1, name: "team", summary: "Team rules.", settings: [signer] }, dir: "/team/packs/team" }] };
    const plan = resolveEngine([engine, team], { packs: ["team"] });
    expect(plan.settings["identity.signer"]).toBeUndefined();
    const lines: string[] = [];
    const profile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [team.ref], packs: ["team"], plan: "both", settings: {}, workflows: {} } satisfies ProfileFile;
    settingsCommand([], { profile, plan, packs: [...engine.packs, ...team.packs], print: (line) => lines.push(line) });
    expect(lines.filter((line) => line.includes("identity.signer ="))).toEqual(["  identity.signer = not set"]);
  });

  test("checks each value against its type, then pushes and applies it", async () => {
    const { home, pushed } = await machineWithProfile();
    const result = await hedge(home, ["set", "pull-requests.freeReviews=4", "--set", "memory.repo=me/notes"]);
    expect(result.code).toBe(0);
    expect((await pushed()).settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
    expect(result.output).toContain("✓ Saved pull-requests.freeReviews, memory.repo in your profile and pushed it.");
    expect(result.output).toContain("The memory pack is off, so its setting waits until you turn it on with hedge packs --add memory.");

    for (const [arg, message] of [
      ["pull-requests.freeReviews=many", "hedge set: pull-requests.freeReviews takes a number"],
      ["nope.key=1", "hedge set: nope.key: no pack has this setting."],
      ["freeReviews", "hedge set: freeReviews: write it as pack.key=value"],
    ]) {
      const refused = await hedge(home, ["set", arg!]);
      expect(refused.code).toBe(2);
      expect(refused.output).toStartWith(message!);
    }
    expect((await pushed()).settings).toEqual({ "pull-requests.freeReviews": 4, "memory.repo": "me/notes" });
  });
});
