import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { changeOnFirstCommit as changeOnFirstCommitIn, fakeMachine, hedgeSetup, githubRepo, pushedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

async function nameHub(profile: string) {
  const answers = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  if (answers.hub) return;
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...answers, hub: "coder.hedge-hub" }, null, 2) + "\n");
  await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
  await spawnGit(profile, "push", "-q");
}

describe("hedge setup with a devbox", () => {
  test("asks the settings only a devbox needs once a devbox is added, saves them to the profile before the box applies it, and a run without a person lists them", async () => {
    const question = "? Which T3 project do the loops and the PR digest run in?";
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on"];
    const alone = temp.make("home-");
    expect((await hedgeSetup(alone, [...args, "--devbox", "skip"], ["", ""], fakeMachine(alone))).output).not.toContain(question);

    const home = temp.make("home-");
    const result = await hedgeSetup(home, [...args, "--devbox", "node-1"], ["", "", "~/code/app"], fakeMachine(home));
    expect(result.code).toBe(0);
    const output = result.output;
    expect(output.indexOf(question)).toBeGreaterThan(output.indexOf("  ✓ node-1"));
    expect(output.indexOf(question)).toBeLessThan(output.indexOf("▶ Install Hedge on node-1"));
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");

    const later = temp.make("home-");
    const waiting = await hedgeSetup(later, ["--non-interactive", ...args, "--devbox", "node-9"], [], fakeMachine(later));
    expect(waiting.code).toBe(2);
    expect(waiting.output).toContain("  --set orchestration.loopProject=<value>   Which T3 project do the loops and the PR digest run in?");
  });

  test("goes on to link T3 Code when hedge doctor on the devbox finds only to-dos that wait for the person's sign-ins", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--preset", "starter", "--plan", "both", "--add", "integrations", "--devbox", "node-1"], ["", ""], fakeMachine(home, {}, { node: { signedOut: true } }));
    expect(result.output).toContain("  ✓ Link T3 Code here and on node-1: done");
  });

  test("a devbox setting whose push failed is pushed on the next run before the box is installed", async () => {
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];
    const home = temp.make("home-");
    expect((await hedgeSetup(home, args, ["", ""], fakeMachine(home))).code).toBe(130);
    const rejecting = join(githubRepo(home, "nora/nora-hedge"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await hedgeSetup(home, args, ["~/code/app"], fakeMachine(home))).output).toContain("could not push answers");

    const blocked = await hedgeSetup(home, ["--non-interactive", ...args], [], fakeMachine(home));
    expect(blocked.output).toContain("could not push answers: ! [remote rejected] HEAD -> main (pre-receive hook declined). Fix that, then try again.");
    expect(blocked.output).not.toContain("▶ Install Hedge on node-1");

    rmSync(rejecting);
    expect((await hedgeSetup(home, ["--non-interactive", ...args], [], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  const devboxArgs = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "node-1"];

  const changeOnFirstCommit = (home: string, change: string) => changeOnFirstCommitIn(home, join(temp.make("elsewhere-"), "profile"), change);

  test("a devbox setting whose push comes after a non-profile push retries once with fetch and rebase and saves both", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'await Bun.write("about-me.md", "# Changed on another machine\\n");');

    const retried = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(retried.code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge", "orchestration.loopProject": "~/code/app" });
    expect(await spawnGit(home, "--git-dir", githubRepo(home, "nora/nora-hedge"), "show", "main:about-me.md")).toBe("# Changed on another machine");
  });

  test("stops when another machine changes the same devbox setting before the push, and after setup's commit is dropped the same command run again saves this run's answer", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    await changeOnFirstCommit(home, 'profile.settings = { ...profile.settings, "orchestration.loopProject": value };');

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: another machine pushed to your profile before setup could.`);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge", "orchestration.loopProject": "after" });
    await spawnGit(profilePath(home), "reset", "-q", "--keep", "@{upstream}");
    expect((await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge", "orchestration.loopProject": "~/code/app" });
  });

  test("a checkout with an unrelated staged file that diverged from origin gets advice that lets the same command run again save the devbox setting", async () => {
    const home = temp.make("home-");
    const dir = profilePath(home);
    expect((await hedgeSetup(home, devboxArgs, ["", ""], fakeMachine(home))).code).toBe(130);
    const elsewhere = join(temp.make("elsewhere-"), "profile");
    await spawnGit(home, "clone", "-q", githubRepo(home, "nora/nora-hedge"), elsewhere);
    writeFileSync(join(elsewhere, "about-me.md"), "# Changed on another machine\n");
    await spawnGit(elsewhere, "commit", "-q", "-am", "Change about me on another machine");
    await spawnGit(elsewhere, "push", "-q");
    writeFileSync(join(dir, "README.md"), "# Changed here\n");
    await spawnGit(dir, "commit", "-q", "-am", "Change the guide here");
    writeFileSync(join(dir, "notes.md"), "draft\n");
    await spawnGit(dir, "add", "notes.md");

    const stopped = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(`hedge: ${dir} and origin both have changes the other lacks. Commit or discard the changes in ${dir} that are not committed. Bring it up to date with git -C ${dir} pull --rebase, then run the same hedge setup command again.`);
    await spawnGit(dir, "rm", "-q", "-f", "notes.md");
    await spawnGit(dir, "pull", "-q", "--rebase");
    const rerun = await hedgeSetup(home, devboxArgs, ["~/code/app"], fakeMachine(home));
    expect(rerun.code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "context.repo": "nora/nora-hedge", "orchestration.loopProject": "~/code/app" });
    const onOrigin = (path: string) => spawnGit(home, "--git-dir", githubRepo(home, "nora/nora-hedge"), "show", `main:${path}`);
    expect([await onOrigin("about-me.md"), await onOrigin("README.md")]).toEqual(["# Changed on another machine", "# Changed here"]);
  });

  test("hedge setup --devbox lists the node in the profile, and the hub takes it before the node asks it for a credential and links it in T3 Code once the node runs T3", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home);
    const result = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "coder.hedge-node-1"], ["", "", ""], box, undefined, 0, "linux", nameHub);
    expect(result.code).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.hedge-node-1"]);
    expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
    expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
    expect(result.output).toContain("✓ The hub, coder.hedge-hub, took coder.hedge-node-1: its disk watch, tunnels and credentials include it now.");
    expect(box.hubLinked).toEqual(["coder.hedge-node-1"]);
    expect(result.output).toContain("✓ The hub, coder.hedge-hub, linked coder.hedge-node-1 in T3 Code.");
  });

  test("hedge setup run again has the hub take the node, then applies the node's profile and links it from the hub, when the hub could not take it on an earlier run that stopped or finished", async () => {
    for (const [polls, firstCode] of [[{ "box:github": 1 }, 2], [{}, 0]] as const) {
      const home = temp.make("home-");
      const args = ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "coder.hedge-node-1"];
      for (const hubUpdateFails of ["hedge update: the engine has local changes.", undefined]) {
        const failing = fakeMachine(home, polls, hubUpdateFails ? { hubUpdateFails } : { hubDown: true });
        expect((await hedgeSetup(home, args, [], failing, undefined, 0, "linux", nameHub)).code).toBe(firstCode);
      }
      const box = fakeMachine(home);
      expect((await hedgeSetup(home, args, [], box, undefined, 0, "linux", nameHub)).code).toBe(0);
      expect(box.hubUpdates).toEqual(["coder.hedge-hub"]);
      expect(box.credentials).toEqual([{ node: "coder.hedge-node-1", issued: true }]);
      expect(box.hubLinked).toEqual(["coder.hedge-node-1"]);
    }
  });
});
