import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { defaultSources } from "./defaults.ts";
import { profileGuide, profilePath } from "./profile.ts";
import { fakeMachine, hedgeSetup, fakeGitHubHostKeys, githubRepo, machineFile, markRepo, ownedRepos, pushedAnswers, repoTopics } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const starter = ["--preset", "starter", "--plan", "claude"];
const pushedFiles = async (home: string, repo = "nora/nora-hedge") => (await spawnGit(githubRepo(home, repo), "ls-tree", "--name-only", "main")).split("\n");

function teamSource(): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team rules.", profileOrg: "acme" }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

const teamSetup = (home: string, args: string[], replies: string[], options: { createFails?: string; createFailsAfterMaking?: string; lookupFails?: string; publicRepos?: string[] } = {}) => hedgeSetup(home, args, replies, fakeMachine(home, {}, { org: true, ...options }), teamSource());

describe("hedge setup profile", () => {
  test("asks once, creates the private profile repo, and pushes the answers, the shim, about me, and the guide", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo nora/nora-hedge in your GitHub account and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo nora/nora-hedge");
    expect(await pushedFiles(home)).toEqual(["README.md", "about-me.md", "hedge.json", "install.sh"]);
    expect(await pushedAnswers(home)).toEqual({
      schema: 1,
      engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
      sources: defaultSources,
      settings: {},
      workflows: {},
      migrations: ["picks-turn-on"],
      packs: ["pull-requests"],
      plan: "claude",
    });
    const guide = await spawnGit(githubRepo(home, "nora/nora-hedge"), "show", "main:README.md");
    expect(guide).toContain("### Quality gates");
    expect(guide).toContain("| `pull-requests.freeReviews` |");
  });

  test("with a team pack that names a profile org, creates the profile there and says where", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo acme/nora-hedge in the acme GitHub org, private to the org, and pushes your answers there.");
    expect(result.output).toContain("  ✓ Created the private repo acme/nora-hedge in the acme org");
    expect(result.output).toContain("  Profile         acme/nora-hedge, private.");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
    expect(await pushedFiles(home, "acme/nora-hedge")).toEqual(["README.md", "about-me.md", "hedge.json", "install.sh"]);
    expect((await pushedAnswers(home, "acme/nora-hedge")).packs).toContain("posthog");
    expect(await spawnGit(githubRepo(home, "acme/nora-hedge"), "show", "main:README.md")).toContain("This repo lives in the acme org, where teammates may read it, so keep secrets out of it.");

    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await teamSetup(home, starter, [""]);
    expect(second.code).toBe(0);
    expect(second.output).toContain("  ✓ Reusing your repo acme/nora-hedge");
  });

  test("reuses a profile repo with the name from before the rename", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    renameSync(githubRepo(home, "nora/nora-hedge"), githubRepo(home, "nora/fleet-profile"));
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await hedgeSetup(home, starter, ["", ""]);

    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/fleet-profile");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
  });

  test("with a team pack, keeps an existing personal profile and says how to move it to the org", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await teamSetup(home, starter, [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/nora-hedge");
    expect(rerun.output).toContain("  · Your team keeps profiles in the acme org. To move yours there, run:");
    expect(rerun.output).toContain("      gh api -X POST repos/nora/nora-hedge/transfer -f new_owner=acme -f new_name=nora-hedge");
    expect(rerun.output).toContain(`      git -C ${profilePath(home)} remote set-url origin https://github.com/acme/nora-hedge.git`);
    expect(existsSync(githubRepo(home, "acme/nora-hedge"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack whose org refuses the repo, creates the profile in the user's account and says why", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFails: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  · The acme org did not let you create acme/nora-hedge (you cannot create repos in acme), so Hedge uses your own account.");
    expect(result.output).toContain("  ✓ Created the private repo nora/nora-hedge");
    expect(existsSync(githubRepo(home, "acme/nora-hedge"))).toBe(false);
    expect((await pushedAnswers(home)).packs).toContain("posthog");
  });

  test("with a team pack, refuses an org profile repo that someone made public, and pushes nothing", async () => {
    for (const repo of ["acme/nora-hedge", "acme/hedge-profile-nora"]) {
      const home = temp.make("home-");
      mkdirSync(githubRepo(home, repo), { recursive: true });
      await spawnGit(githubRepo(home, repo), "init", "-q", "--bare", "-b", "main");
      const result = await teamSetup(home, starter, [""], { publicRepos: [repo] });
      expect(result.code).toBe(1);
      expect(result.output).toContain(`hedge: ${repo} is not private. Make it private, then run hedge setup again.`);
      expect(existsSync(profilePath(home))).toBe(false);
    }
  });

  test("keeps the org profile this machine already uses after the team pack is removed", async () => {
    const home = temp.make("home-");
    expect((await teamSetup(home, starter, ["", ""])).code).toBe(0);
    const rerun = await teamSetup(home, ["--remove", "posthog"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo acme/nora-hedge");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
    expect((await pushedAnswers(home, "acme/nora-hedge")).packs).not.toContain("posthog");
  });

  async function branchCheckout(home: string, origin = "https://github.com/nora/dotfiles.git") {
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const dotfiles = githubRepo(home, "nora/dotfiles");
    await spawnGit(home, "clone", "-q", "--bare", githubRepo(home, "nora/nora-hedge"), dotfiles);
    await spawnGit(dotfiles, "branch", "hub", "main");
    const checkout = join(home, ".config/coderv2/dotfiles");
    const remotes = `url.${join(home, "github-remotes")}/.insteadOf`;
    await spawnGit(home, "clone", "-q", "--config", `${remotes}=https://github.com/`, "--config", `${remotes}=git@github.com:`, "-b", "hub", "https://github.com/nora/dotfiles.git", checkout);
    await spawnGit(checkout, "remote", "set-url", "origin", origin);
    rmSync(profilePath(home), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: checkout }));
    return { dotfiles, checkout };
  }

  test("uses the profile checkout this machine applies and its branch, and leaves the profile's main alone", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    const mainBefore = await spawnGit(dotfiles, "rev-parse", "main");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/dotfiles");
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "rev-parse", "main")).toBe(mainBefore);
    expect((await pushedAnswers(home)).plan).toBe("claude");
    expect(machineFile(home).profileDir).toBe(checkout);
    expect(existsSync(profilePath(home))).toBe(false);
  });

  test("stops before it saves when the checkout's branch tracks no remote branch, and never renames that branch or moves a local main", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "branch", "--unset-upstream");
    await spawnGit(checkout, "update-ref", "-d", "refs/remotes/origin/hub");
    await spawnGit(checkout, "checkout", "-q", "-b", "main");
    await spawnGit(checkout, "commit", "-q", "--allow-empty", "-m", "Only on this machine's main");
    await spawnGit(checkout, "checkout", "-q", "hub");
    const localMain = await spawnGit(checkout, "rev-parse", "main");
    const remoteMain = await spawnGit(dotfiles, "rev-parse", "main");
    const remoteHub = await spawnGit(dotfiles, "rev-parse", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks no remote branch, so setup does not know where to save your answers.`);
    expect(await spawnGit(checkout, "symbolic-ref", "--short", "HEAD")).toBe("hub");
    expect(await spawnGit(checkout, "rev-parse", "main")).toBe(localMain);
    expect([await spawnGit(dotfiles, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual([remoteMain, remoteHub]);
  });

  test("stops before it commits when the checkout's branch tracks a local branch, and moves neither branch", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "branch", "-q", "main", "origin/main");
    await spawnGit(checkout, "branch", "-q", "--set-upstream-to", "main");
    const before = [await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(checkout, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")];

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks the local branch main, not origin. Setup takes and saves your answers only on origin, the repo it checks. Run git -C ${checkout} branch --set-upstream-to origin/<branch>, then run hedge setup again.`);
    expect([await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(checkout, "rev-parse", "main"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual(before);
  });

  test("stops before it commits when the checkout's branch tracks a remote other than origin, and pushes nothing there", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    const mirror = githubRepo(home, "nora/public-mirror");
    await spawnGit(home, "clone", "-q", "--bare", dotfiles, mirror);
    await spawnGit(checkout, "remote", "add", "mirror", mirror);
    await spawnGit(checkout, "fetch", "-q", "mirror");
    await spawnGit(checkout, "branch", "-q", "--set-upstream-to", "mirror/hub");
    const ahead = join(temp.make("mirror-"), "clone");
    await spawnGit(home, "clone", "-q", "-b", "hub", mirror, ahead);
    await spawnGit(ahead, "commit", "-q", "--allow-empty", "-m", "Only on the mirror");
    await spawnGit(ahead, "push", "-q", "origin", "hub");
    const before = [await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(mirror, "rev-parse", "hub"), await spawnGit(dotfiles, "rev-parse", "hub")];

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`${checkout} is on the branch hub, which tracks mirror/hub, not origin.`);
    expect([await spawnGit(checkout, "rev-parse", "hub"), await spawnGit(mirror, "rev-parse", "hub"), await spawnGit(dotfiles, "rev-parse", "hub")]).toEqual(before);
  });

  test("takes the commits another machine pushed to the origin branch it tracks, and saves on top of them", async () => {
    const home = temp.make("home-");
    const { dotfiles } = await branchCheckout(home);
    const elsewhere = join(temp.make("elsewhere-"), "dotfiles");
    await spawnGit(home, "clone", "-q", "-b", "hub", dotfiles, elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "Change about me");
    await spawnGit(elsewhere, "push", "-q", "origin", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "show", "hub:about-me.md")).toBe("# Changed on another machine");
  });

  test("takes the commits another machine pushed when origin fetches into its own remote-tracking namespace", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(checkout, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin-view/*");
    const elsewhere = join(temp.make("elsewhere-"), "dotfiles");
    await spawnGit(home, "clone", "-q", "-b", "hub", dotfiles, elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "Change about me");
    await spawnGit(elsewhere, "push", "-q", "origin", "hub");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
    expect(await spawnGit(dotfiles, "show", "hub:about-me.md")).toBe("# Changed on another machine");
  });

  test("stops before it applies when another machine deleted the branch the checkout tracks on origin, and names why", async () => {
    const home = temp.make("home-");
    const { dotfiles, checkout } = await branchCheckout(home);
    await spawnGit(dotfiles, "branch", "-D", "hub");
    const applied = join(home, "applied");

    const rerun = await hedgeSetup(home, ["--non-interactive"], [], undefined, undefined, 0, "linux", () => writeFileSync(applied, ""));

    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: could not find refs/heads/hub of origin in ${checkout} after fetching origin: fatal: ambiguous argument '@{upstream}': unknown revision or path not in the working tree. Run git -C ${checkout} pull, then run hedge setup again.`);
    expect(existsSync(applied)).toBe(false);
  });

  test("adds the host keys of github.com, not of the host gh uses by default, before it reaches a profile over SSH, and keeps the lines already there", async () => {
    const home = temp.make("home-");
    const { dotfiles } = await branchCheckout(home, "git@github.com:nora/dotfiles.git");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/known_hosts"), "example.com ssh-ed25519 AAAAexample");

    const rerun = await hedgeSetup(home, ["--non-interactive", "--plan", "codex"], []);

    expect(rerun.code).toBe(0);
    expect(readFileSync(join(home, ".ssh/known_hosts"), "utf8")).toBe(["example.com ssh-ed25519 AAAAexample", ...fakeGitHubHostKeys.map((key) => `github.com ${key}`), ""].join("\n"));
    expect(JSON.parse(await spawnGit(dotfiles, "show", "hub:hedge.json")).plan).toBe("codex");
  });

  test("uses the org repo when its creation reports a failure but the repo was made", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFailsAfterMaking: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ Created the private repo acme/nora-hedge in the acme org");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
    expect((await pushedAnswers(home, "acme/nora-hedge")).packs).toContain("posthog");
  });

  test("stops when it cannot tell whether a failed org create made the repo, and creates no personal profile", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", ""], { createFailsAfterMaking: "acme", lookupFails: "acme" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: could not look up acme/nora-hedge: HTTP 502: Bad Gateway");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
  });

  test("treats a clone of the old personal profile as personal whatever the case of its owner, and keeps a public one", async () => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, "nora/hedge-profile"));
    expect((await hedgeSetup(home, starter, [""])).code).toBe(0);
    symlinkSync(githubRepo(home, "nora/hedge-profile").replace(/nora\/hedge-profile\.git$/, "nora"), join(home, "github-remotes", "NORA"));
    await spawnGit(profilePath(home), "remote", "set-url", "origin", "https://github.com/NORA/hedge-profile.git");
    const rerun = await teamSetup(home, ["--set", "pull-requests.freeReviews=2"], [""], { publicRepos: ["NORA/hedge-profile", "nora/hedge-profile"] });
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo NORA/hedge-profile");
  });

  test("heads a pack's section in the profile guide with its title", () => {
    const guide = profileGuide([{ schema: 1, name: "team", title: "Team Tools", summary: "Team rules.", settings: [{ key: "team.region", question: "Which region?", type: "string" }] }]);
    expect(guide).toContain("### Team Tools");
  });

  test("with Memory on and no separate memory repo, saves context.repo to the profile repo and makes no second repo", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo nora/nora-hedge in your GitHub account and pushes your answers, memory, and context there.");
    expect(result.output).toContain("  ✓ Using nora/nora-hedge for memory and context");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge" });
  });

  test("with Memory on and a typed profile name, saves context.repo to that typed name", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", "my-setup", ""]);
    expect(result.code).toBe(0);
    expect(ownedRepos(home, "nora")).toEqual(["nora/my-setup"]);
    expect((await pushedAnswers(home, "nora/my-setup")).settings).toEqual({ "context.repo": "nora/my-setup" });
  });

  test("with Memory on and context.repo naming the new profile repo, creates it once and does not prompt twice", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "context.repo=nora/nora-hedge"], ["", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  Hedge creates the private repo nora/nora-hedge in your GitHub account and pushes your answers, memory, and context there.");
    expect(ownedRepos(home, "nora")).toEqual(["nora/nora-hedge"]);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge" });
  });

  test("with Memory on and a team pack, shares the org profile repo via context.repo, or falls back to the personal profile repo", async () => {
    const orgHome = temp.make("home-");
    const inOrg = await teamSetup(orgHome, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""]);
    expect(inOrg.code).toBe(0);
    expect(inOrg.output).toContain("  Hedge creates the private repo acme/nora-hedge in the acme GitHub org, private to the org, and pushes your answers, memory, and context there.");
    expect(existsSync(githubRepo(orgHome, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(orgHome, "acme/nora-hedge")).settings).toEqual({ "context.repo": "acme/nora-hedge" });

    const fallbackHome = temp.make("home-");
    const fallback = await teamSetup(fallbackHome, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""], { createFails: "acme" });
    expect(fallback.code).toBe(0);
    expect(existsSync(githubRepo(fallbackHome, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(fallbackHome, "nora/nora-hedge")).settings).toEqual({ "context.repo": "nora/nora-hedge" });
  });

  test("with Memory on and an existing hedge-memory or fleet-memory repo, reuses it via memory.repo", async () => {
    for (const existing of ["nora/hedge-memory", "nora/fleet-memory"]) {
      const home = temp.make("home-");
      await spawnGit(home, "init", "-q", "--bare", githubRepo(home, existing));
      const result = await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude"]);
      expect(result.code).toBe(0);
      expect(result.output).toContain(`✓ Reusing your repo ${existing}`);
      expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": existing });
    }
  });

  test("with Memory on and an existing public personal hedge-profile repo, creates a private hedge-memory repo instead of sharing it", async () => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, "nora/hedge-profile"));
    const result = await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude"], [], fakeMachine(home, {}, { publicRepos: ["nora/hedge-profile"] }));
    expect(result.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(true);
    expect((await pushedAnswers(home, "nora/hedge-profile")).settings).toEqual({ "memory.repo": "nora/hedge-memory" });
  });

  test("with Memory on it refuses a memory repo that is public, before it creates anything", async () => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", githubRepo(home, "nora/hedge-memory"));
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], [""], fakeMachine(home, {}, { publicRepos: ["nora/hedge-memory"] }));
    expect(result.code).toBe(1);
    expect(result.output).toContain("hedge: nora/hedge-memory is not private, and agents write notes about you there. Make it private, or name a private repo with --set memory.repo=<owner/name>.");
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
  });

  test("with Memory on and a context repo it keeps memory in a private org context repo, and refuses a public one", async () => {
    const home = temp.make("home-");
    for (const repo of ["acme/context", "acme/open-context"]) await spawnGit(home, "init", "-q", "--bare", githubRepo(home, repo));
    const run = (repo: string) => hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude", "--set", `context.repo=${repo}`], [], fakeMachine(home, {}, { publicRepos: ["acme/open-context"] }));
    const refused = await run("acme/open-context");
    expect({ code: refused.code, refused: refused.output.includes("hedge: acme/open-context is not private, and agents write notes about you there. Make it private, or name a private repo with --set context.repo=<owner/name>.") }).toEqual({ code: 1, refused: true });
    expect(existsSync(githubRepo(home, "nora/nora-hedge"))).toBe(false);
    const kept = await run("acme/context");
    expect(kept.code).toBe(0);
    expect(kept.output).toContain("✓ Reusing your repo acme/context");
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "acme/context" });
  });

  test("with Memory on and a GitHub scp form without a user it saves the owner/name the memory sync can read", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=github.com:nora/notes"])).code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/notes" });
  });

  test("n creates nothing and keeps the draft for the next run", async () => {
    const home = temp.make("home-");
    const declined = await hedgeSetup(home, starter, ["", "n"]);
    expect(declined.code).toBe(130);
    expect(declined.output).toContain("  Nothing was created.");
    expect(declined.output).toEndWith("Stopped. Run hedge setup again to pick up at Make your profile.");
    expect(existsSync(join(home, "github-remotes"))).toBe(false);
    expect(machineFile(home).setup.draft).toMatchObject({ packs: ["pull-requests"], plan: "claude" });
  });

  test("a rerun on another machine reuses the repos without asking, and the new answers win", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], ["", ""])).code).toBe(0);
    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });

    const rerun = await hedgeSetup(home, ["--preset", "everyday", "--plan", "both"], [""]);
    expect(rerun.code).toBe(0);
    expect(rerun.prompts).toEqual(["Press ↵ to keep them, or e to change them: "]);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/nora-hedge");
    expect(rerun.output).not.toContain("Created the private repo");
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication", "memory"], plan: "both", settings: { "context.repo": "nora/nora-hedge" } });
    expect(await spawnGit(githubRepo(home, "nora/nora-hedge"), "rev-list", "--count", "main")).toBe("3");
  });

  test("uses a memory repo named on the command, and a second machine keeps the one the profile names", async () => {
    const home = temp.make("home-");
    const custom = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=nora/custom-notes"], ["", ""]);
    expect(custom.code).toBe(0);
    expect(custom.output).toContain("private repos nora/nora-hedge and nora/custom-notes");
    expect(existsSync(githubRepo(home, "nora/custom-notes"))).toBe(true);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });

    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude"], [""]);
    expect(second.code).toBe(0);
    expect(existsSync(githubRepo(home, "nora/hedge-memory"))).toBe(false);
    expect((await pushedAnswers(home)).settings).toEqual({ "memory.repo": "nora/custom-notes" });
  });

  test("pushes the start files a stopped run wrote but did not commit", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const dir = profilePath(home);
    await spawnGit(dir, "rm", "-q", "--cached", "README.md");
    await spawnGit(dir, "commit", "-q", "-m", "Lose the guide");
    await spawnGit(dir, "push", "-q");
    const rerun = await hedgeSetup(home, ["--set", "pull-requests.freeReviews=2"]);
    expect(rerun.code).toBe(0);
    expect(await pushedFiles(home)).toContain("README.md");
  });

  test("refuses a profile folder cloned from a repo with a longer name", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    await spawnGit(profilePath(home), "remote", "set-url", "origin", "https://github.com/nora/nora-hedge-public.git");
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const rerun = await hedgeSetup(home, starter, ["", ""]);
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: ${profilePath(home)} is a clone of nora/nora-hedge-public, not nora/nora-hedge.`);
  });

  test.each([["plain text", ["pretend", "pass", "x"]], ["text with an apostrophe", ["pretend", "pa'ss", "x"]], ["text with a double quote", ["pretend", 'pa"ss', "x"]], ["text with an at sign", ["pretend", "pa@ss", "x"]]])("names a profile folder that pushes outside GitHub as another remote, with no part of that address, when its sign-in, query and fragment hold a password that is %s", async (_, parts) => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, starter, ["", ""])).code).toBe(0);
    const password = parts.join("-");
    await spawnGit(profilePath(home), "config", "remote.origin.pushurl", `HTTPS://nora:${password}@git.example/nora/my mirror.git?access_token=${password}#${password}.`);
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const rerun = await hedgeSetup(home, starter, ["", ""]);
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain(`hedge: ${profilePath(home)} is a clone of another remote, not nora/nora-hedge.`);
    expect(rerun.output).not.toContain("git.example");
    for (const part of password.split(/['"@]/)) expect(rerun.output).not.toContain(part);
  });

  test("refuses to take over a folder that is not the profile", async () => {
    const home = temp.make("home-");
    mkdirSync(profilePath(home), { recursive: true });
    const result = await hedgeSetup(home, starter, ["", ""]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`hedge: ${profilePath(home)} exists and is not your profile. Move it away, then run hedge setup again.`);
  });
});

describe("hedge setup finds the profile before it makes one", () => {
  const allRepos = (home: string) => ["acme", "nora"].flatMap((owner) => ownedRepos(home, owner));
  const lookups: Array<{ name: string; repos: string[]; marked?: Record<string, string>; inUse?: string; team?: boolean; uses: string }> = [
    { name: "nothing yet: makes <login>-hedge in the account", repos: [], uses: "nora/nora-hedge" },
    { name: "nothing yet with a team pack: makes <login>-hedge in the org", repos: [], team: true, uses: "acme/nora-hedge" },
    { name: "the old personal name", repos: ["nora/hedge-profile"], uses: "nora/hedge-profile" },
    { name: "the personal name from before the rename", repos: ["nora/fleet-profile"], uses: "nora/fleet-profile" },
    { name: "a team org with an old-form profile", repos: ["acme/hedge-profile-nora"], team: true, uses: "acme/hedge-profile-nora" },
    { name: "a team org with both new and old names: prefers the new name", repos: ["acme/hedge-profile-nora", "acme/nora-hedge"], team: true, uses: "acme/nora-hedge" },
    { name: "a team org with the form from before the rename", repos: ["acme/fleet-profile-nora"], team: true, uses: "acme/fleet-profile-nora" },
    { name: "an old personal profile with a team pack", repos: ["nora/hedge-profile"], team: true, uses: "nora/hedge-profile" },
    { name: "the new and an old name: the new name", repos: ["nora/hedge-profile", "nora/nora-hedge"], uses: "nora/nora-hedge" },
    { name: "the new and an old name, the old one in use here: the one in use", repos: ["nora/hedge-profile", "nora/nora-hedge"], inUse: "nora/hedge-profile", uses: "nora/hedge-profile" },
    { name: "the org profile before the new name in the account", repos: ["nora/nora-hedge", "acme/hedge-profile-nora"], team: true, uses: "acme/hedge-profile-nora" },
    { name: "the new name in the account with a team pack", repos: ["nora/nora-hedge"], team: true, uses: "nora/nora-hedge" },
    { name: "a typed name in the account with a team pack", repos: ["nora/my-setup"], marked: { "nora/my-setup": "nora" }, team: true, uses: "nora/my-setup" },
    { name: "a typed name in the account", repos: ["nora/my-setup"], marked: { "nora/my-setup": "nora" }, uses: "nora/my-setup" },
    { name: "an old name before a typed name", repos: ["nora/hedge-profile", "nora/my-setup"], marked: { "nora/my-setup": "nora" }, uses: "nora/hedge-profile" },
    { name: "not an org repo with the person's topic", repos: ["acme/tools"], marked: { "acme/tools": "nora" }, team: true, uses: "acme/nora-hedge" },
    { name: "not a repo with another person's topic", repos: ["nora/lena-tools"], marked: { "nora/lena-tools": "lena" }, uses: "nora/nora-hedge" },
    { name: "not an unmarked repo with another name", repos: ["nora/dotfiles"], uses: "nora/nora-hedge" },
  ];

  test.each(lookups)("$name", async ({ repos, marked = {}, inUse, team, uses }) => {
    const home = temp.make("home-");
    for (const repo of repos) await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, repo));
    for (const [repo, login] of Object.entries(marked)) markRepo(home, repo, `hedge-for-${login}`);
    if (inUse) {
      await spawnGit(home, "clone", "-q", githubRepo(home, inUse), profilePath(home));
      await spawnGit(profilePath(home), "remote", "set-url", "origin", `https://github.com/${inUse}.git`);
    }
    const args = ["--non-interactive", ...starter];
    const result = team ? await teamSetup(home, args, []) : await hedgeSetup(home, args);
    expect(result.code).toBe(0);
    const made = !repos.includes(uses);
    expect(result.output).toContain(made ? `✓ Created the private repo ${uses}` : `✓ Reusing your repo ${uses}`);
    expect(allRepos(home)).toEqual([...new Set([...repos, uses])].sort());
    expect((await pushedAnswers(home, uses)).plan).toBe("claude");
    if (made) expect(repoTopics(home, uses)).toEqual(uses.startsWith("nora/") ? ["hedge-for-nora"] : []);
  });

  test("takes a typed name, and a later setup on another machine finds it without asking for it and makes no second profile", async () => {
    const home = temp.make("home-");
    const first = await hedgeSetup(home, starter, ["", "my-setup", ""]);
    expect(first.code).toBe(0);
    expect(first.prompts.slice(-2)).toEqual(["  Go ahead? (Y/n, or type another name for your profile repo) ", "  Go ahead? (Y/n, or type another name for your profile repo) "]);
    expect(first.output).toContain("  Hedge creates the private repo nora/nora-hedge in your GitHub account and pushes your answers there.");
    expect(first.output).toContain("  Hedge creates the private repo nora/my-setup in your GitHub account and pushes your answers there.");
    expect(first.output).toContain("  ✓ Created the private repo nora/my-setup");
    expect(repoTopics(home, "nora/my-setup")).toEqual(["hedge-for-nora"]);

    rmSync(join(home, ".config/hedge"), { recursive: true });
    rmSync(profilePath(home), { recursive: true });
    const second = await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "both"]);
    expect(second.code).toBe(0);
    expect(second.output).toContain("  ✓ Reusing your repo nora/my-setup");
    expect(ownedRepos(home, "nora")).toEqual(["nora/my-setup"]);
    expect((await pushedAnswers(home, "nora/my-setup")).plan).toBe("both");

    await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, "nora/nora-hedge"));
    const rerun = await hedgeSetup(home, ["--set", "pull-requests.freeReviews=2"]);
    expect(rerun.code).toBe(0);
    expect((await pushedAnswers(home, "nora/my-setup")).settings).toEqual({ "pull-requests.freeReviews": 2 });
  });

  test("with a team pack, says how to move an old or a typed personal profile to the org under <login>-hedge", async () => {
    for (const repo of ["nora/hedge-profile", "nora/my-setup"]) {
      const home = temp.make("home-");
      await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, repo));
      markRepo(home, repo, "hedge-for-nora");
      const result = await teamSetup(home, ["--non-interactive", ...starter], []);
      expect(result.code).toBe(0);
      expect(result.output).toContain(`      gh api -X POST repos/${repo}/transfer -f new_owner=acme -f new_name=nora-hedge`);
      expect(result.output).toContain(`      git -C ${profilePath(home)} remote set-url origin https://github.com/acme/nora-hedge.git`);
    }
  });

  test("adding Memory to an existing profile shares it via context.repo without asking to create a repo, and asks only yes or no when a missing custom memory repo is named", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", ...starter])).code).toBe(0);
    const shared = await hedgeSetup(home, ["--add", "memory"], [""]);
    expect(shared.code).toBe(0);
    expect(shared.prompts).toEqual(["Press ↵ to keep them, or e to change them: "]);
    expect(ownedRepos(home, "nora")).toEqual(["nora/nora-hedge"]);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge" });

    const customHome = temp.make("home-");
    expect((await hedgeSetup(customHome, ["--non-interactive", ...starter])).code).toBe(0);
    const result = await hedgeSetup(customHome, ["--add", "memory", "--set", "memory.repo=nora/custom-notes"], ["", "n"]);
    expect(result.code).toBe(130);
    expect(result.output).toContain("  Hedge creates the private repo nora/custom-notes in your GitHub account and pushes your answers there.");
    expect(result.prompts.at(-1)).toBe("  Go ahead? (Y/n) ");
    expect(ownedRepos(customHome, "nora")).toEqual(["nora/nora-hedge"]);
  });

  test.each([
    { name: "the new name in the account", repo: "nora/nora-hedge", marked: false, team: false },
    { name: "a typed name in the account", repo: "nora/my-setup", marked: true, team: false },
  ])("refuses a public profile under $name, and makes no second one", async ({ repo, marked, team }) => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, repo));
    if (marked) markRepo(home, repo, "hedge-for-nora");
    const args = ["--non-interactive", ...starter];
    const result = team ? await teamSetup(home, args, [], { publicRepos: [repo] }) : await hedgeSetup(home, args, [], fakeMachine(home, {}, { publicRepos: [repo] }));
    expect(result.code).toBe(1);
    expect(result.output).toContain(`hedge: ${repo} is not private. Make it private, then run hedge setup again.`);
    expect(allRepos(home)).toEqual([repo]);
  });

  test("refuses a typed name that an explicit memory repo takes", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--add", "memory", "--plan", "claude", "--set", "memory.repo=nora/custom-notes"], ["", "custom-notes", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  nora/custom-notes is the memory repo. Type another name, or press ↵ for nora/nora-hedge.");
    expect(ownedRepos(home, "nora")).toEqual(["nora/custom-notes", "nora/nora-hedge"]);
  });

  test("when it cannot mark a new profile, says how, and a later setup finds the marked repo", async () => {
    const home = temp.make("home-");
    const failed = await hedgeSetup(home, starter, ["", "my-setup", ""], fakeMachine(home, {}, { topicFails: true }));
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("hedge: Hedge made nora/my-setup but could not mark it as your profile (HTTP 403: Resource not accessible by integration). Run gh repo edit nora/my-setup --add-topic hedge-for-nora, then run hedge setup again.");
    markRepo(home, "nora/my-setup", "hedge-for-nora");
    const rerun = await hedgeSetup(home, ["--non-interactive", ...starter]);
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("  ✓ Reusing your repo nora/my-setup");
    expect(ownedRepos(home, "nora")).toEqual(["nora/my-setup"]);
  });

  test("refuses a typed name that a repo already has, and takes another", async () => {
    const home = temp.make("home-");
    await spawnGit(home, "init", "-q", "--bare", "-b", "main", githubRepo(home, "nora/dotfiles"));
    const result = await hedgeSetup(home, starter, ["", "dotfiles", "mine", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("  nora/dotfiles exists already. Type another name, or press ↵ for nora/nora-hedge.");
    expect(result.output).toContain("  ✓ Created the private repo nora/mine");
    expect(ownedRepos(home, "nora")).toEqual(["nora/dotfiles", "nora/mine"]);
  });

  test("with a team pack, asks only yes or no for the org repo, and takes no typed name", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, starter, ["", "tools", ""]);
    expect(result.prompts.filter((prompt) => prompt.startsWith("  Go ahead?"))).toEqual(["  Go ahead? (Y/n) ", "  Go ahead? (Y/n) "]);
    expect(result.code).toBe(0);
    expect(allRepos(home)).toEqual(["acme/nora-hedge"]);
    expect(repoTopics(home, "acme/nora-hedge")).toEqual([]);
  });

  test("with a team pack whose org refuses the repo, makes the new name in the account and marks it", async () => {
    const home = temp.make("home-");
    const result = await teamSetup(home, ["--non-interactive", ...starter], [], { createFails: "acme" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("  ✓ Created the private repo nora/nora-hedge");
    expect(repoTopics(home, "nora/nora-hedge")).toEqual(["hedge-for-nora"]);
  });
});
