import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { changeOnFirstCommit, engineRoot, fakeMachine, hedgeSetup, githubRepo, machineFile, pushedAnswers, savedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const onMac = (home: string, args: string[], replies: string[] = []) => hedgeSetup(home, args, replies, fakeMachine(home), undefined, 0, "darwin");

async function grownProfile() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  const io = scripted([]);
  const packs = (args: string[]) => main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  expect(await packs(["--add", "communication", "--add", "hub", "--workflows", "pr-digest=on", "--set", "hub.alias=coder.hedge-hub"])).toBe(0);
  return home;
}

async function packsAfterSetup() {
  const home = temp.make("home-");
  expect((await onMac(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  return {
    home,
    packs: async (args: string[], options: Parameters<typeof fakeMachine>[2] = {}) => {
      const io = scripted([]);
      const code = await main(["packs", ...args], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home, {}, options).machine } });
      return { code, output: io.output() };
    },
  };
}

describe("hedge setup after a stop", () => {
  test("takes the profile's new commits before it applies", async () => {
    const home = temp.make("home-");
    const stopped = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", () => {
      throw new Error("apply stopped");
    });
    expect(stopped.code).toBe(1);
    const elsewhere = join(home, "elsewhere");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/nora-hedge"), elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "change about me");
    await spawnGit(elsewhere, "push", "-q", "origin", "main");

    let applied = "";
    const resumed = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", (dir) => {
      applied = readFileSync(join(dir, "about-me.md"), "utf8");
    });

    expect(resumed.code).toBe(0);
    expect(applied).toBe("# Changed on another machine\n");
  });

  test("goes on with the copy on this machine, and says so, when the profile's origin cannot be reached", async () => {
    const home = temp.make("home-");
    const stopped = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", () => {
      throw new Error("apply stopped");
    });
    expect(stopped.code).toBe(1);
    const profile = profilePath(home);
    await spawnGit(profile, "remote", "set-url", "origin", join(home, "gone.git"));
    writeFileSync(join(profile, "about-me.md"), "# Only on this machine\n");
    await spawnGit(profile, "commit", "-q", "-am", "change on this machine");

    let applied = "";
    const resumed = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", (dir) => {
      applied = readFileSync(join(dir, "about-me.md"), "utf8");
    });

    expect(resumed.output).toContain(`Your profile's origin could not be reached (`);
    expect(resumed.output).toContain(`Setup goes on with the copy in ${profile}.`);
    expect(applied).toBe("# Only on this machine\n");
    expect(resumed.code).toBe(0);
  });

  test("names an origin that cannot be reached without the sign-in in its address, also when the password holds an apostrophe", async () => {
    const home = temp.make("home-");
    const stopped = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", () => {
      throw new Error("apply stopped");
    });
    expect(stopped.code).toBe(1);
    const password = ["pretend", "pa'ss", "x"].join("-");
    const box = fakeMachine(home);
    const exec = box.machine.exec;
    box.machine.exec = async (command, ...rest) => (command.includes("fetch") ? { code: 128, stdout: "", output: `fatal: unable to access 'https://nora:${password}@git.example/nora/profile.git/': Could not resolve host: git.example` } : exec(command, ...rest));

    const resumed = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], box);

    expect(resumed.output).toContain("Your profile's origin could not be reached (fatal: unable to access 'https://git.example/nora/profile.git': Could not resolve host: git.example).");
    for (const part of password.split("'")) expect(resumed.output).not.toContain(part);
    expect(resumed.code).toBe(0);
  });
});

describe("hedge setup while another machine changes the profile", () => {
  async function changeElsewhere(home: string, change: (profile: Record<string, unknown>) => void) {
    const elsewhere = temp.make("elsewhere-");
    await spawnGit(elsewhere, "clone", "-q", githubRepo(home, "nora/nora-hedge"), "profile");
    const file = join(elsewhere, "profile/hedge.json");
    const profile = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    change(profile);
    writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
    await spawnGit(join(elsewhere, "profile"), "commit", "-q", "-am", "change on another machine");
    await spawnGit(join(elsewhere, "profile"), "push", "-q", "origin", "main");
  }

  test("a rerun that changes one answer keeps what another machine changed meanwhile", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    await changeElsewhere(home, (profile) => {
      profile.plan = "both";
      profile.workflows = { ...(profile.workflows as object), "elsewhere-workflow": true };
    });

    const rerun = await hedgeSetup(home, ["--non-interactive", "--remove", "pull-requests"], []);

    expect(rerun.code).toBe(0);
    const pushed = await pushedAnswers(home);
    expect([pushed.plan, pushed.workflows?.["elsewhere-workflow"], pushed.packs?.includes("pull-requests")]).toEqual(["both", true, false]);
    expect(rerun.output).toContain("Sign in to ChatGPT");
  });

  test("a rerun that removes a pack keeps the pack another machine added meanwhile", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    await changeElsewhere(home, (profile) => void (profile.packs = [...(profile.packs as string[]), "guards"]));

    const rerun = await hedgeSetup(home, ["--non-interactive", "--remove", "pull-requests"], []);

    expect(rerun.code).toBe(0);
    expect((await pushedAnswers(home)).packs).toEqual(["guards"]);
  });

  test("a rerun checks its pack change against the packs another machine saved before it, and saves nothing", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    await changeElsewhere(home, (profile) => void (profile.packs = [...(profile.packs as string[]), "orchestration"]));

    const rerun = await hedgeSetup(home, ["--non-interactive", "--remove", "pull-requests"], []);

    expect(rerun.code).toBe(2);
    expect(rerun.output).toContain("hedge setup: Orchestration needs Quality gates. Add pull-requests, or remove orchestration.");
    expect((await pushedAnswers(home)).packs).toEqual(["pull-requests", "orchestration"]);
  });

  test("a rerun whose profile push comes after a non-profile push retries once with fetch and rebase and saves both", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    await changeOnFirstCommit(home, join(temp.make("elsewhere-"), "profile"), 'await Bun.write("about-me.md", "# Changed on another machine\\n");');
    const args = ["--non-interactive", "--remove", "pull-requests"];

    const retried = await hedgeSetup(home, args, []);

    expect(retried.code).toBe(0);
    expect((await pushedAnswers(home)).packs).toEqual([]);
    expect(await spawnGit(home, "--git-dir", githubRepo(home, "nora/nora-hedge"), "show", "main:about-me.md")).toBe("# Changed on another machine");
  });

  test("a rerun whose profile push comes after another machine's hedge.json change stops and keeps its commit, stops at the next start until the checkout is up to date, and saves after git pull --rebase", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    await changeOnFirstCommit(home, join(temp.make("elsewhere-"), "profile"), 'profile.plan = "both";');
    const args = ["--non-interactive", "--remove", "pull-requests"];
    const upToDate = `Commit or discard the changes in ${profilePath(home)} that are not committed. Bring it up to date with git -C ${profilePath(home)} pull --rebase`;

    const stopped = await hedgeSetup(home, args, []);

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: another machine pushed to your profile before setup could. ${upToDate}, or drop setup's commit, then run the same hedge setup command again.`);
    expect(JSON.parse(await spawnGit(profilePath(home), "show", "HEAD:hedge.json")).packs).toEqual([]);
    expect((await pushedAnswers(home)).packs).toEqual(["pull-requests"]);
    const next = await hedgeSetup(home, args, []);
    expect(next.code).toBe(1);
    expect(next.output).toContain(`hedge: ${profilePath(home)} and origin both have changes the other lacks. ${upToDate}, then run the same hedge setup command again.`);
    await spawnGit(profilePath(home), "pull", "-q", "--rebase");
    expect((await hedgeSetup(home, args, [])).code).toBe(0);
    expect((await pushedAnswers(home)).packs).toEqual([]);
    expect((await pushedAnswers(home)).plan).toBe("both");
  });

  function pushesAfterAnotherMachine(home: string, plan: string) {
    const box = fakeMachine(home);
    let published = false;
    const exec: typeof box.machine.exec = async (command, options) => {
      if (!published && command[0] === "git" && command[3] === "push") {
        published = true;
        await changeElsewhere(home, (profile) => void (profile.plan = plan));
      }
      return box.machine.exec(command, options);
    };
    return { ...box, machine: { ...box.machine, exec } };
  }

  test("a rerun whose profile push comes after another machine's says to drop setup's commit only when it made one", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const dir = profilePath(home);
    const pushAfterElsewhere = async (args: string[], plan: string) => {
      const before = await spawnGit(dir, "rev-parse", "HEAD");
      const result = await hedgeSetup(home, ["--non-interactive", ...args], [], pushesAfterAnotherMachine(home, plan));
      return { ...result, moved: (await spawnGit(dir, "rev-parse", "HEAD")) !== before };
    };
    const advice = (drop: boolean) => `hedge: another machine pushed to your profile before setup could. Commit or discard the changes in ${dir} that are not committed. Bring it up to date with git -C ${dir} pull --rebase${drop ? ", or drop setup's commit" : ""}, then run the same hedge setup command again.`;

    const args = ["--remove", "pull-requests"];

    const changed = await pushAfterElsewhere(args, "both");

    expect(changed.code).toBe(1);
    expect(changed.output).toContain(advice(true));
    expect(changed.moved).toBe(true);
    expect(JSON.parse(await spawnGit(dir, "show", "HEAD:hedge.json")).packs).toEqual([]);
    expect(await pushedAnswers(home)).toMatchObject({ plan: "both", packs: ["pull-requests"] });

    await spawnGit(dir, "pull", "-q", "--rebase");
    const rejecting = join(githubRepo(home, "nora/nora-hedge"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await hedgeSetup(home, ["--non-interactive", ...args], [])).output).toContain("pre-receive hook declined");
    rmSync(rejecting);

    const unchanged = await pushAfterElsewhere(args, "codex");

    expect(unchanged.code).toBe(1);
    expect(unchanged.output).toContain(advice(false));
    expect(unchanged.output).not.toContain("drop setup's commit");
    expect(unchanged.moved).toBe(false);
    expect(await spawnGit(dir, "status", "--porcelain")).toBe("");
    expect(await pushedAnswers(home)).toMatchObject({ plan: "codex", packs: ["pull-requests"] });
  });

  test("an apply-only resume runs the steps of the plan that another machine saved after the stop", async () => {
    const home = temp.make("home-");
    const stopped = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""], undefined, undefined, 0, "linux", () => {
      throw new Error("apply stopped");
    });
    expect(stopped.code).toBe(1);
    await changeElsewhere(home, (profile) => void (profile.plan = "codex"));

    const resumed = await hedgeSetup(home, [], [""]);

    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("Sign in to ChatGPT");
    expect(resumed.output).not.toContain("Sign in to Claude");
    expect((await pushedAnswers(home)).plan).toBe("codex");
  });
});

describe("hedge packs --add memory", () => {
  test("shares the profile repo via context.repo when no separate memory repo exists", async () => {
    const { home, packs } = await packsAfterSetup();
    const added = await packs(["--add", "memory"]);
    expect(added.code).toBe(0);
    expect(added.output).toContain("✓ Using nora/nora-hedge for memory and context");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "context.repo": "nora/nora-hedge" } });
  });

  test("reuses an existing hedge-memory repo via memory.repo", async () => {
    const { home, packs } = await packsAfterSetup();
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/hedge-memory"));
    const added = await packs(["--add", "memory"]);
    expect(added.code).toBe(0);
    expect(added.output).toContain("✓ Reusing your repo nora/hedge-memory");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": "nora/hedge-memory" } });
  });

  test("creates a private hedge-memory repo instead of sharing a public profile repo when adding memory", async () => {
    const { home, packs } = await packsAfterSetup();
    const result = await packs(["--add", "memory"], { publicRepos: ["nora/nora-hedge"] });
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ Created the private repo nora/hedge-memory");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(true);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": "nora/hedge-memory" } });
  });

  test("reuses the memory repo the profile names when the pack comes back", async () => {
    const { home, packs } = await packsAfterSetup();
    expect((await packs(["--add", "memory", "--set", "memory.repo=nora/custom-notes"])).code).toBe(0);
    expect((await packs(["--remove", "memory"])).code).toBe(0);
    const back = await packs(["--add", "memory"]);
    expect(back.output).toContain("✓ Reusing your repo nora/custom-notes");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": "nora/custom-notes" } });
  });

  test("makes no repo when the same command removes Memory again", async () => {
    const { home, packs } = await packsAfterSetup();
    const result = await packs(["--add", "memory", "--remove", "memory"], { createFails: "nora" });
    expect(result.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toEqual(["pull-requests"]);
  });

  test("uses a memory repo URL as it is, and looks nothing up on GitHub", async () => {
    const { home, packs } = await packsAfterSetup();
    const url = "git@example.com:nora/notes.git";
    const result = await packs(["--add", "memory", "--set", `memory.repo=${url}`], { lookupFails: "nora", createFails: "nora" });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`✓ Using your memory repo ${url}`);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "memory"], settings: { "memory.repo": url } });
  });

  test("refuses a public memory repo and changes nothing", async () => {
    const { home, packs } = await packsAfterSetup();
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/hedge-memory"));
    const before = savedAnswers(home);
    const result = await packs(["--add", "memory"], { publicRepos: ["nora/hedge-memory"] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: nora/hedge-memory is not private, and agents write notes about you there. Make it private, or name a private repo with --set memory.repo=<owner/name>.");
    expect(savedAnswers(home)).toEqual(before);
    expect(await pushedAnswers(home)).toEqual(before);
  });

  test("makes a missing repo named by its GitHub SSH URL, and saves the URL as named", async () => {
    const { home, packs } = await packsAfterSetup();
    const url = "git@github.com:nora/notes.git";
    const result = await packs(["--add", "memory", "--set", `memory.repo=${url}`]);
    expect(result.output).toContain("✓ Created the private repo nora/notes");
    expect(existsSync(githubRepo(home, "nora/notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": url });
  });

  test("saves owner/name for a GitHub scp form without a user, which the memory sync cannot read", async () => {
    const { home, packs } = await packsAfterSetup();
    const result = await packs(["--add", "memory", "--set", "memory.repo=github.com:nora/notes"]);
    expect(result.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/notes" });
  });

  test("refuses a public memory repo named by any form of its GitHub URL", async () => {
    const { home, packs } = await packsAfterSetup();
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/public-notes"));
    const before = savedAnswers(home);
    for (const url of ["https://github.com/nora/public-notes.git", "https://GitHub.com/nora/public-notes.git", "https://github.com:443/nora/public-notes", "http://www.github.com/nora/public-notes/", "ssh://git@github.com:22/nora/public-notes.git", "git@GITHUB.COM:nora/public-notes.git", "github.com:nora/public-notes"]) {
      const result = await packs(["--add", "memory", "--set", `memory.repo=${url}`], { publicRepos: ["nora/public-notes"] });
      expect({ url, code: result.code, refused: result.output.includes("hedge: nora/public-notes is not private") }).toEqual({ url, code: 1, refused: true });
    }
    expect(await pushedAnswers(home)).toEqual(before);
  });

  test("refuses a GitHub URL whose path is not owner/name", async () => {
    const { home, packs } = await packsAfterSetup();
    const before = savedAnswers(home);
    const url = "https://github.com/nora/notes/tree/main";
    const result = await packs(["--add", "memory", "--set", `memory.repo=${url}`]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`hedge: ${url} is on GitHub, but Hedge cannot read its owner/name. Set memory.repo=<owner/name>.`);
    expect(await pushedAnswers(home)).toEqual(before);
  });

  test("stops before it saves when GitHub refuses to make the repo", async () => {
    const { home, packs } = await packsAfterSetup();
    const before = savedAnswers(home);
    const result = await packs(["--add", "memory", "--set", "memory.repo=nora/custom-notes"], { createFails: "nora" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: gh repo create failed: GraphQL: you cannot create repos in nora");
    expect(savedAnswers(home)).toEqual(before);
    expect(await pushedAnswers(home)).toEqual(before);
  });
});

describe("a second hedge setup", () => {
  test("with no flags keeps the profile's packs, Hub pack, and workflows", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "communication", "hub"], workflows: { "pr-digest": true } });
  });

  test("with --add, --remove, or --workflows changes only what they name", async () => {
    const home = await grownProfile();
    const result = await onMac(home, ["--non-interactive", "--add", "memory", "--remove", "communication", "--workflows", "merge-gate=on", "--plan", "both"]);
    expect(result.output).toContain("✓ Quality gates, Hub, Memory");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "hub", "memory"], workflows: { "pr-digest": true, "merge-gate": true }, plan: "both" });
  });

  test("re-picking Everything, by flag or in the picker, keeps every workflow the profile turned off", async () => {
    const sets = ["--set", "orchestration.loopProject=~/code/app", "--set", "orchestration.qualityArea=src/api", "--set", "orchestration.ledgerRepo=me/ledger", "--set", "slack.userId=U012ABCDEF"];
    const kept = { "shell-guards": true, "package-age": true, "context-library": true, "quality-loop": false, "signal-loop": false, "pr-digest": false };
    const home = temp.make("home-");
    const fewer = ["--remove", "slack", "--remove", "incident-io"];
    await onMac(home, ["--non-interactive", "--preset", "everything", ...fewer, "--plan", "claude", "--devbox", "skip", ...sets]);
    const io = scripted([]);
    expect(await main(["packs", "--workflows", "quality-loop=off,signal-loop=off,pr-digest=off"], { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } })).toBe(0);
    expect((await pushedAnswers(home)).workflows).toEqual(kept);
    await onMac(home, ["--non-interactive", "--preset", "everything", ...fewer]);
    expect((await pushedAnswers(home)).workflows).toEqual(kept);
    const picked = await onMac(home, ["--add", "slack"], ["e", "3", ...Array(16).fill("")]);
    expect(picked.output).toContain("  3) Everything");
    expect(await pushedAnswers(home)).toMatchObject({ packs: expect.arrayContaining(["integrations", "slack"]), workflows: kept });
  });

  test("with --preset picks that preset again, in place of the profile's packs", async () => {
    const home = await grownProfile();
    await onMac(home, ["--non-interactive", "--preset", "starter"]);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests"], workflows: {} });
  });
});

async function withTeamSwitch() {
  const home = temp.make("home-");
  const team = temp.make("team-");
  mkdirSync(join(team, "packs/posthog"), { recursive: true });
  writeFileSync(join(team, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", workflows: [{ id: "team-reviews", name: "Team reviews", default: true, sentence: "Agents ask the team for reviews." }] }));
  const fetched = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, dir: team, packs: await loadPacks(team) });
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--workflows", "team-reviews=off", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home, {}, { org: true }), fetched)).code).toBe(0);
  expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog"], workflows: { "team-reviews": false } });
  return home;
}

describe("a rerun that changes picks", () => {
  test("after a stop before the GitHub sign-in, --remove applies to the saved packs, not to the default preset", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect(machineFile(home).setup.draft.packs).toEqual(["pull-requests"]);
    const resumed = await hedgeSetup(home, ["--non-interactive", "--remove", "pull-requests", "--plan", "claude", "--devbox", "skip"]);
    expect(resumed.output).not.toContain("hedge setup:");
    expect(await pushedAnswers(home)).toMatchObject({ packs: [] });
  });

  test("keeps a team workflow switch while the team's pack cannot be fetched", async () => {
    const home = await withTeamSwitch();
    const offline = async (ref: SourceRef): Promise<FetchedSource> => ({ ref, error: "offline" });
    await hedgeSetup(home, ["--non-interactive", "--add", "communication"], [], fakeMachine(home, {}, { org: true }), offline);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog", "communication"], workflows: { "team-reviews": false } });
  });

  test("one by one keeps the profile's workflow switches", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "guards", "--workflows", "oom-survival=on", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
    const edited = await hedgeSetup(home, ["--add", "communication"], ["e", "4", ...Array(16).fill("")]);
    expect(edited.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: expect.arrayContaining(["pull-requests", "guards", "communication"]), workflows: { "oom-survival": true } });
  });
});

async function newMachineWithProfile() {
  const home = temp.make("home-");
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "guards", "--workflows", "oom-survival=on", "--plan", "claude", "--devbox", "skip"])).code).toBe(0);
  return forgetMachine(home);
}

function forgetMachine(home: string) {
  rmSync(join(home, ".config/hedge"), { recursive: true });
  rmSync(profilePath(home), { recursive: true });
  return home;
}

describe("hedge setup on a new machine whose profile repo exists", () => {
  test("with no flags keeps the profile's packs and workflows", async () => {
    const home = await newMachineWithProfile();
    const result = await hedgeSetup(home, [], Array(8).fill(""));
    expect(result.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], workflows: { "oom-survival": true }, plan: "claude" });
  });

  test("with --add changes only the pack it names", async () => {
    const home = await newMachineWithProfile();
    expect((await hedgeSetup(home, ["--non-interactive", "--add", "communication", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards", "communication"], workflows: { "oom-survival": true }, plan: "claude" });
  });

  test("keeps the plan a run before the GitHub sign-in already set with --plan", async () => {
    const home = await newMachineWithProfile();
    const args = ["--non-interactive", "--preset", "starter", "--plan", "codex", "--devbox", "skip"];
    expect((await hedgeSetup(home, args, [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await hedgeSetup(home, args)).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests"], plan: "codex" });
  });

  test("keeps the plan a stopped run set with --plan when the next run leaves it out", async () => {
    const home = await newMachineWithProfile();
    expect((await hedgeSetup(home, ["--non-interactive", "--plan", "codex", "--devbox", "skip"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await hedgeSetup(home, ["--non-interactive", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], plan: "codex" });
  });

  test("takes the profile's plan when no run named one", async () => {
    const home = await newMachineWithProfile();
    expect((await hedgeSetup(home, ["--non-interactive", "--devbox", "skip"], [], fakeMachine(home, { github: 1 }))).code).toBe(2);
    expect((await hedgeSetup(home, ["--non-interactive", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "guards"], plan: "claude" });
  });

  test("keeps a workflow switch of a team source the person is no longer a member of", async () => {
    const home = forgetMachine(await withTeamSwitch());
    expect((await hedgeSetup(home, ["--non-interactive", "--add", "communication", "--devbox", "skip"])).code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "posthog", "communication"], workflows: { "team-reviews": false } });
  });
});
