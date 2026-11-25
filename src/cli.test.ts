import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { main } from "./cli.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { spawnGit, tempDirs } from "./testing/git.ts";
import { repoUrl } from "./pack/sources.ts";
import type { SourceRef } from "./pack/types.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, hedge } = cliFixtures(temp);

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const key = relative(root, path);
      if (info.isDirectory()) {
        entries[key] = `dir ${info.mtimeMs}`;
        walk(path);
      } else entries[key] = info.isSymbolicLink() ? `link ${info.mtimeMs}` : `${info.mtimeMs} ${readFileSync(path, "utf8")}`;
    }
  };
  walk(root);
  return entries;
}

describe("hedge apply", () => {
  test("a check that waits for the person prints a To do, and neither apply nor doctor fails", async () => {
    const engine = temp.make("engine-");
    cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
    mkdirSync(join(engine, "packs/pool"), { recursive: true });
    writeFileSync(join(engine, "packs/pool/pack.json"), JSON.stringify({ schema: 1, name: "pool", summary: "A pool of accounts.", checks: [{ id: "pool", run: ["pool-check"], say: "Hedge cannot read the pool.", todo: "Add an account to the pool." }] }));
    const home = temp.make("home-");
    const profile = profileDir(["pool"]);
    const run = async (command: string[]) => (command.at(-1) === "pool-check" ? 4 : 0);
    const typed = async (args: string[]) => {
      const lines: string[] = [];
      const code = await main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line), run });
      return { code, lines };
    };
    const applied = await typed(["apply", "--profile", profile]);
    expect(applied.code).toBe(0);
    expect(applied.lines).toContain("To do: Add an account to the pool.");
    expect(applied.lines.at(-1)).toStartWith("Applied ");
    const doctor = await typed(["doctor", "--profile", profile]);
    expect(doctor.code).toBe(0);
    expect(doctor.lines.slice(-2)).toEqual(["To do: Add an account to the pool.", "Everything Hedge sets matches your profile. The To do lines above wait for you."]);
  });

  test("puts the base pack's rules on a fresh machine and remembers the profile", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    const result = await hedge(["apply", "--profile", profile], home);
    expect(result).toMatchObject({ code: 0 });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe(readFileSync(join(home, ".agents/AGENTS.md"), "utf8"));
    expect(readFileSync(join(home, ".gemini/AGENTS.md"), "utf8")).toBe(readFileSync(join(home, ".agents/AGENTS.md"), "utf8"));
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"))).toEqual({ schema: 1, role: "linux", profileDir: profile, name: hostname() });
    expect((await hedge(["apply"], home)).output).toContain("Applied 0 changes.");
  });

  test("a profile the parent passes down is checked by doctor, but never applied or remembered", async () => {
    const home = temp.make("home-");
    const remembered = profileDir([], "# Remembered\n");
    const passedDown = { HEDGE_PROFILE_DIR: profileDir([], "# Passed down\n") };
    expect((await hedge(["apply", "--profile", remembered], home)).code).toBe(0);

    const doctor = await hedge(["doctor"], home, repoRoot, passedDown);
    expect(doctor).toMatchObject({ code: 1 });
    expect(doctor.output).toContain(".agents/AGENTS.md needs to be updated.");

    expect((await hedge(["apply"], home, repoRoot, passedDown)).code).toBe(0);
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toContain("# Remembered");
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).not.toContain("# Passed down");
    expect(JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")).profileDir).toBe(remembered);
  });

  describe("in a Coder workspace", () => {
    const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"));
    const signer = (home: string) => readFileSync(join(home, ".agents/guides/skill-settings.md"), "utf8").match(/`identity\.signer`: `(\w+)`/)?.[1];
    const slice = ".config/systemd/user/hedge-heavy.slice";

    test("a fresh box gets role devbox, the coder signer, and the devbox workflows", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      expect(await hedge(["apply", "--profile", profile], home, repoRoot, { CODER: "true", CODER_AGENT_URL: "https://coder.example.test/" })).toMatchObject({ code: 0 });
      expect(machineFile(home)).toEqual({ schema: 1, role: "devbox", coder: true, profileDir: profile, name: hostname() });
      expect(signer(home)).toBe("coder");
      expect(existsSync(join(home, slice))).toBe(true);
    });

    test("the box stays a Coder devbox when a later run lacks the Coder variables, as cron does", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      await hedge(["apply", "--profile", profile], home, repoRoot, { CODER_AGENT_URL: "https://coder.example.test/" });
      expect(await hedge(["apply"], home)).toMatchObject({ code: 0 });
      expect(machineFile(home)).toMatchObject({ role: "devbox", coder: true });
      expect(signer(home)).toBe("coder");
    });

    test("a box saved as linux before becomes a devbox", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      await hedge(["apply", "--profile", profile], home);
      expect(machineFile(home).role).toBe("linux");
      await hedge(["apply"], home, repoRoot, { CODER: "true" });
      expect(machineFile(home)).toMatchObject({ role: "devbox", coder: true });
      expect(signer(home)).toBe("coder");
    });

    test("without the Coder variables, a Linux machine gets role linux and the ssh signer", async () => {
      const home = temp.make("home-");
      await hedge(["apply", "--profile", profileDir()], home, repoRoot, { CODER: "false" });
      expect(machineFile(home).role).toBe("linux");
      expect(machineFile(home).coder).toBeUndefined();
      expect(signer(home)).toBe("ssh");
      expect(existsSync(join(home, slice))).toBe(false);
    });
  });

  test("keeps a proxy URL in Claude Code's settings that Hedge has no record of, and doctor asks for no change to it", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const mine = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "proxy-key" }, model: "opus" };
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify(mine));
    const profile = profileDir();
    const doctor = await hedge(["doctor", "--profile", profile], home);
    expect(doctor.output).not.toContain("env.ANTHROPIC");
    const result = await hedge(["apply", "--profile", profile], home);
    expect(result.output).not.toContain("env.ANTHROPIC");
    expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"))).toMatchObject(mine);
  });

  test("keeps an unmanaged file and a local edit, and says so", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/AGENTS.md"), "my own codex rules\n");
    const profile = profileDir();
    const first = await hedge(["apply", "--profile", profile], home);
    expect(first.code).toBe(0);
    expect(first.output).toContain("Kept your .codex/AGENTS.md (Existing unmanaged item).");
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe("my own codex rules\n");

    writeFileSync(join(home, ".agents/AGENTS.md"), "my edit\n");
    writeFileSync(join(profile, "about-me.md"), "I like small diffs.\n");
    const second = await hedge(["apply"], home);
    expect(second.code).toBe(0);
    expect(second.output).toContain("Kept your .agents/AGENTS.md (Managed file changed locally).");
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("my edit\n");
    expect(readFileSync(join(home, ".claude/rules/hedge.md"), "utf8")).toContain("I like small diffs.");
  });

  test("--adopt takes Hedge's version and backs up the user's file", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/AGENTS.md"), "my own codex rules\n");
    const result = await hedge(["apply", "--profile", profileDir(), "--adopt", ".codex/AGENTS.md"], home);
    expect(result.code).toBe(0);
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
    const backups = join(home, ".local/state/hedge/backups");
    const [run] = readdirSync(backups);
    expect(readFileSync(join(backups, run ?? "", ".codex/AGENTS.md"), "utf8")).toBe("my own codex rules\n");
  });

  describe("on a machine that another Hedge set up", () => {
    function anotherHedge() {
      const home = temp.make("home-");
      const old = temp.make("old-hedge-");
      mkdirSync(join(old, "guides"));
      writeFileSync(join(old, "AGENTS.md"), "old rules\n");
      writeFileSync(join(old, "guides/old.md"), "old guide\n");
      mkdirSync(join(home, ".agents"), { recursive: true });
      symlinkSync(join(old, "AGENTS.md"), join(home, ".agents/AGENTS.md"));
      symlinkSync(join(old, "guides"), join(home, ".agents/guides"));
      writeFileSync(join(home, ".old-tool"), "old tool\n");
      const state = { version: 1, groups: { core: {
        ".agents/AGENTS.md": { kind: "link", source: join(old, "AGENTS.md") },
        ".agents/guides": { kind: "link", source: join(old, "guides") },
        ".old-tool": { kind: "file", hash: createHash("sha256").update("old tool\n").digest("hex") },
      } } };
      mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
      writeFileSync(join(home, ".local/state/hedge/state.json"), JSON.stringify(state));
      return { home, old, state };
    }
    const clash = "To do: Another Hedge setup keeps 4 of the files your profile writes, such as .agents/AGENTS.md, under the name core in ~/.local/state/hedge/state.json. Run hedge apply --adopt-from core to take them over. Hedge backs up that state and each file or linked folder it replaces in ~/.local/state/hedge/backups. A linked folder moves whole, with everything in it.";

    test("dry-run and doctor report the clash with the way out, and apply stops before it writes", async () => {
      const { home } = anotherHedge();
      const profile = profileDir();
      const before = snapshot(home);
      const preview = await hedge(["apply", "--dry-run", "--profile", profile], home);
      expect(preview).toMatchObject({ code: 1 });
      expect(preview.output).toContain(clash);
      expect(preview.output).toContain("Preview: Hedge could not apply your profile. Nothing was written.");
      const doctor = await hedge(["doctor", "--profile", profile], home);
      expect(doctor).toMatchObject({ code: 1 });
      expect(doctor.output).toContain(clash);
      expect(snapshot(home)).toEqual(before);

      const applied = await hedge(["apply", "--profile", profile], home);
      expect(applied).toMatchObject({ code: 1 });
      expect(applied.output).toContain(clash);
      expect(applied.output).toEndWith("Hedge could not apply your profile.");
      expect(existsSync(join(home, ".codex/AGENTS.md"))).toBe(false);
      expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
      expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("old rules\n");
    });

    test("--adopt-from backs up the other Hedge's state and files, takes its files over, and forgets the rest", async () => {
      const { home, old, state } = anotherHedge();
      const profile = profileDir();
      const result = await hedge(["apply", "--profile", profile, "--adopt-from", "core"], home);
      expect(result).toMatchObject({ code: 0 });
      expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
      expect(lstatSync(join(home, ".agents/guides")).isDirectory()).toBe(true);
      expect(readFileSync(join(home, ".agents/guides/skill-settings.md"), "utf8")).toContain("identity.signer");
      expect(readFileSync(join(home, ".old-tool"), "utf8")).toBe("old tool\n");
      expect(readFileSync(join(old, "guides/old.md"), "utf8")).toBe("old guide\n");
      expect(Object.keys(JSON.parse(readFileSync(join(home, ".local/state/hedge/state.json"), "utf8")).groups)).toEqual(["hedge"]);

      const backups = join(home, ".local/state/hedge/backups");
      const [run] = readdirSync(backups);
      const backup = join(backups, run ?? "");
      expect(readlinkSync(join(backup, ".agents/AGENTS.md"))).toBe(join(old, "AGENTS.md"));
      expect(readlinkSync(join(backup, ".agents/guides"))).toBe(join(old, "guides"));
      expect(JSON.parse(readFileSync(join(backup, ".local/state/hedge/state.json"), "utf8"))).toEqual(state);

      expect((await hedge(["apply"], home)).output).toContain("Applied 0 changes.");
    });

    describe("with the old Codex rules file, which the base pack's rules replace", () => {
      const oldRules = ".codex/rules/fleet.rules";
      const withOldRules = (shipped: string, onDisk: string) => {
        const { home, state } = anotherHedge();
        mkdirSync(join(home, ".codex/rules"), { recursive: true });
        writeFileSync(join(home, oldRules), onDisk);
        const groups = { core: { ...state.groups.core, [oldRules]: { kind: "file", hash: createHash("sha256").update(shipped).digest("hex") } } };
        writeFileSync(join(home, ".local/state/hedge/state.json"), JSON.stringify({ ...state, groups }));
        return home;
      };

      test("--adopt-from removes it while it is what the other Hedge wrote, and keeps a backup", async () => {
        const home = withOldRules("old codex rules\n", "old codex rules\n");
        const result = await hedge(["apply", "--profile", profileDir(), "--adopt-from", "core"], home);
        expect(result.code).toBe(0);
        expect(existsSync(join(home, oldRules))).toBe(false);
        expect(existsSync(join(home, ".codex/rules/hedge-base.rules"))).toBe(true);
        const backups = join(home, ".local/state/hedge/backups");
        expect(readFileSync(join(backups, readdirSync(backups)[0] ?? "", oldRules), "utf8")).toBe("old codex rules\n");
      });

      test("--adopt-from keeps it once someone changed it, and says so", async () => {
        const home = withOldRules("old codex rules\n", "my codex rules\n");
        const result = await hedge(["apply", "--profile", profileDir(), "--adopt-from", "core"], home);
        expect(result.code).toBe(0);
        expect(readFileSync(join(home, oldRules), "utf8")).toBe("my codex rules\n");
        expect(result.output).toContain(`Kept your ${oldRules}: it changed after the core setup wrote it, and Hedge no longer writes it. Remove it once you no longer need it.`);
      });
    });

    test("--adopt-from refuses a name the state does not hold, and this Hedge's own name", async () => {
      const { home } = anotherHedge();
      const profile = profileDir();
      for (const name of ["other", "constructor"]) {
        expect(await hedge(["apply", "--profile", profile, "--adopt-from", name], home)).toMatchObject({ code: 1, output: `hedge: nothing to adopt from ${name}: Hedge's state names no other setup by that name` });
      }
      expect(await hedge(["apply", "--profile", profile, "--adopt-from", "hedge"], home)).toMatchObject({ code: 1, output: "hedge: nothing to adopt from hedge: that is the name of this Hedge" });
    });
  });

  test("keeps a file whose folder is a link, and --adopt moves that link to the backups", async () => {
    const home = temp.make("home-");
    const elsewhere = temp.make("guides-");
    writeFileSync(join(elsewhere, "mine.md"), "my guide\n");
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".agents/guides"));
    const profile = profileDir();
    const kept = await hedge(["apply", "--profile", profile], home);
    expect(kept).toMatchObject({ code: 0 });
    expect(kept.output).toContain("Kept your .agents/guides/t3.md (its folder .agents/guides is a link or a file, not a real folder; adopting moves it to the backups). Run hedge apply --adopt .agents/guides/t3.md to take Hedge's version.");
    expect(readlinkSync(join(home, ".agents/guides"))).toBe(elsewhere);

    const adopted = await hedge(["apply", "--adopt", ".agents/guides/t3.md"], home);
    expect(adopted).toMatchObject({ code: 0 });
    expect(lstatSync(join(home, ".agents/guides")).isDirectory()).toBe(true);
    expect(readdirSync(join(home, ".agents/guides")).sort()).toEqual(["coding-standards.md", "skill-settings.md", "t3.md"]);
    const backups = join(home, ".local/state/hedge/backups");
    const [run] = readdirSync(backups);
    expect(readlinkSync(join(backups, run ?? "", ".agents/guides"))).toBe(elsewhere);
    expect(readFileSync(join(elsewhere, "mine.md"), "utf8")).toBe("my guide\n");
  });

  test("--dry-run previews without writing machine state", async () => {
    const home = temp.make("home-");
    const result = await hedge(["apply", "--dry-run", "--profile", profileDir()], home);
    expect(result.output).toContain("Preview: 15 changes to apply. Nothing was written.");
    expect(readdirSync(home)).toEqual([]);
  });

  test("refuses without a profile", async () => {
    expect(await hedge(["apply"], temp.make("home-"))).toMatchObject({ code: 1, output: expect.stringContaining("no profile on this machine") });
  });
});

describe("hedge doctor", () => {
  test("never writes, on a fresh machine and on a drifted one", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    const fresh = snapshot(home);
    const before = await hedge(["doctor", "--profile", profile], home);
    expect(before.code).toBe(1);
    expect(before.output).toContain("Fix: .agents/AGENTS.md needs to be created.");
    expect(snapshot(home)).toEqual(fresh);

    await hedge(["apply", "--profile", profile], home);
    expect(await hedge(["doctor"], home)).toMatchObject({ code: 0, output: "Everything matches your profile." });
    writeFileSync(join(home, ".agents/AGENTS.md"), "my edit\n");
    writeFileSync(join(profile, "about-me.md"), "New about me.\n");
    const drifted = snapshot(home);
    const after = await hedge(["doctor"], home);
    expect(after.output).toContain("Kept your .agents/AGENTS.md");
    expect(after.output).toContain("Fix: .codex/AGENTS.md needs to be updated.");
    expect(snapshot(home)).toEqual(drifted);
  });

  test("--to-do exits nonzero and lists no step for the person when a step that only Hedge repairs fails", async () => {
    const home = temp.make("home-");
    const root = temp.make("engine-");
    cpSync(join(repoRoot, "packs/base"), join(root, "packs/base"), { recursive: true });
    mkdirSync(join(root, "packs/box"), { recursive: true });
    const human = [
      { id: "gateway", say: "The gateway is not installed.", probe: ["gateway-installed"], repair: ["gateway-installed", "--repair"] },
      { id: "key", say: "Paste your key.", command: "box key", probe: ["key-pasted"] },
    ];
    writeFileSync(join(root, "packs/box/pack.json"), JSON.stringify({ schema: 1, name: "box", summary: "box pack.", human }));
    const profile = profileDir(["box"]);
    const lines: string[] = [];
    const options = { home, engineRoot: root, platform: "linux" as const, env: {}, print: (line: string) => void lines.push(line) };
    expect(await main(["apply", "--profile", profile], { ...options, run: async () => 0 })).toBe(0);
    lines.length = 0;
    const unmet = async (command: string[]) => (["gateway-installed", "key-pasted"].includes(command[0]!) ? 1 : 0);
    expect(await main(["doctor", "--to-do"], { ...options, run: unmet })).toBe(1);
    expect(lines.slice(0, -1)).toEqual(["Fix: The gateway is not installed."]);
    expect(JSON.parse(lines.at(-1)!)).toEqual([{ pack: "box", id: "key", say: "Paste your key.", command: "box key" }]);
  });
});

describe("hedge doctor and pack sources", () => {
  const redirected = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "PATH"] as const;
  const saved = Object.fromEntries(redirected.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of redirected) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  async function applied(source: (commit: string) => SourceRef, origin?: string) {
    const repo = temp.make("source-");
    await spawnGit(repo, "init", "-q", "-b", "main");
    await spawnGit(repo, "commit", "-q", "--allow-empty", "-m", "Start");
    const ref = source(await spawnGit(repo, "rev-parse", "HEAD"));
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: repoUrl(ref.repo) });
    const home = temp.make("home-");
    const profile = profileDir();
    const file = join(profile, "hedge.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sources: [ref] }));
    if (origin) await spawnGit(profile, "init", "-q"), await spawnGit(profile, "remote", "add", "origin", origin);
    expect(await hedge(["apply", "--profile", profile], home)).toMatchObject({ code: 0 });
    return home;
  }

  test("notes a source that follows a branch, and still passes", async () => {
    const home = await applied(() => ({ name: "team", repo: "someone/team", ref: "main" }));
    expect(await hedge(["doctor"], home)).toEqual({
      code: 0,
      output: "Note: The pack source team follows main. Pin its ref in hedge.json to a commit SHA, so each apply loads the same packs, even offline.\nEverything matches your profile.",
    });
  });

  test("says nothing of a source pinned to a commit", async () => {
    const home = await applied((commit) => ({ name: "team", repo: "someone/team", ref: commit }));
    expect(await hedge(["doctor"], home)).toEqual({ code: 0, output: "Everything matches your profile." });
  });

  test("still prints its report without git when a source it notes was never fetched", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    expect(await hedge(["apply", "--profile", profile], home)).toMatchObject({ code: 0 });
    const file = join(profile, "hedge.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sources: [{ name: "team", repo: "someone/team", ref: "main" }] }));
    process.env.PATH = temp.make("no-git-");
    expect((await hedge(["doctor"], home)).output).toContain("Note: The pack source team follows main.");
  });

  test("passes without git on a profile with no sources", async () => {
    const home = temp.make("home-");
    expect(await hedge(["apply", "--profile", profileDir()], home)).toMatchObject({ code: 0 });
    process.env.PATH = temp.make("no-git-");
    expect(await hedge(["doctor"], home)).toEqual({ code: 0, output: "Everything matches your profile." });
  });

  for (const origin of ["git@github.com:Someone/profile.git", "https://github.com/someone/Profile"]) {
    test(`says nothing of a source in the profile's own repository at ${origin}, which cannot pin its own commit`, async () => {
      const home = await applied(() => ({ name: "own", repo: "someone/profile", ref: "main" }), origin);
      expect(await hedge(["doctor"], home)).toEqual({ code: 0, output: "Everything matches your profile." });
    });
  }
});

describe("a profile source that would run code it does not ship", () => {
  const withSource = (home: string, source: Record<string, string>) => {
    const profile = profileDir();
    const file = join(profile, "hedge.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sources: [source] }));
    return profile;
  };

  for (const args of [["apply", "--dry-run"], ["doctor"]]) {
    test(`hedge ${args.join(" ")} refuses a source name that leaves the source cache, and never runs the pack it points at`, async () => {
      const home = temp.make("home-");
      const marker = join(home, "pack-ran");
      mkdirSync(join(home, "evil/.git"), { recursive: true });
      mkdirSync(join(home, "evil/packs/evil"), { recursive: true });
      writeFileSync(join(home, "evil/packs/evil/pack.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\nexport default { sdk: 1, name: "evil", summary: "Evil.", register() {} };\n`);
      const result = await hedge([...args, "--profile", withSource(home, { name: "../../../../evil", repo: "someone/evil", ref: "main" })], home);
      expect(existsSync(marker)).toBe(false);
      expect(result.code).toBe(1);
      expect(result.output).toContain('source name "../../../../evil" must be lowercase words joined by dashes');
    });
  }

  test("hedge apply refuses a source ref that git would read as an option, and git runs no command from it", async () => {
    const home = temp.make("home-");
    const repo = temp.make("source-");
    await spawnGit(repo, "init", "-q", "-b", "main");
    await spawnGit(repo, "commit", "-q", "--allow-empty", "-m", "Start");
    const marker = join(home, "upload-pack-ran");
    const result = await hedge(["apply", "--profile", withSource(home, { name: "team", repo, ref: `--upload-pack=touch ${marker}; git-upload-pack` })], home);
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain("source team: repo and ref must not start with -");
  });
});
