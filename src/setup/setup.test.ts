import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { fakeMachine, hedgeSetup, machineFile, pushedAnswers, savedAnswers } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const machine = machineFile;

describe("hedge setup questions", () => {
  test("asks packs and plans with defaults, shows progress, and moves the answers into the profile", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, [], ["", "", ""]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Hedge setup · 1 of 11 · about 16 min left");
    expect(result.output).toContain("Hedge setup · 4 of 11 · about 10 min left");
    expect(result.output).toContain("  1) Everyday  Quality gates, Orchestration, Communication, Memory (default)");
    expect(result.output).toContain("  ✓ Claude and ChatGPT");
    expect(machine(home)).toEqual({
      schema: 1,
      role: "linux",
      name: hostname(),
      profileDir: profilePath(home),
      devboxes: [],
      setup: { done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "claude", "apply-codex", "chatgpt", "check"] },
    });
    expect(savedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication", "memory"], workflows: {}, plan: "both" });
    expect(result.applied).toEqual([profilePath(home), profilePath(home)]);
    expect(result.skipped).toEqual([["base/codex-cli"], []]);
  });

  test("on a Mac, saves the mac role, offers a devbox, and sets up this Mac", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, [], ["", "", ""], undefined, undefined, 0, "darwin");
    expect(result.code).toBe(0);
    expect(result.output).toContain("▶ Set up this Mac: hedge apply installs your packs");
    expect(result.output).not.toContain("Set up this machine");
    expect(result.output).toContain("  This Mac ");
    expect(machine(home)).toMatchObject({ schema: 1, role: "mac", devboxes: [], setup: { done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "claude", "apply-codex", "chatgpt", "check"] } });
    expect(result.skipped).toEqual([["base/codex-cli"], []]);
  });

  test("keeps the name and role that apply saves, though setup writes its progress after apply", async () => {
    const home = temp.make("home-");
    const path = join(home, ".config/hedge/machine.json");
    const placeAsHub = () => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), name: "hub-1", role: "hub" }));
    const result = await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "codex"], [], undefined, undefined, 0, "linux", placeAsHub);
    expect(result.code).toBe(0);
    expect(machine(home)).toMatchObject({ name: "hub-1", role: "hub" });
  });

  test("Ctrl-C keeps every answer, and a rerun picks up at the next question", async () => {
    const home = temp.make("home-");
    const stopped = await hedgeSetup(home, [], ["2"]);
    expect(stopped.code).toBe(130);
    expect(stopped.output).toEndWith("Stopped. Run hedge setup again to pick up at Your AI plans.");
    expect(machine(home).setup).toEqual({ done: ["bootstrap", "github", "packs"], draft: { packs: ["pull-requests"], workflows: {} } });

    const resumed = await hedgeSetup(home, [], ["3", ""]);
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("Welcome back. 3 of 11 done, picking up at Your AI plans.");
    expect(resumed.prompts).toHaveLength(2);
    expect(machine(home).setup).toEqual({ done: ["bootstrap", "github", "packs", "plans", "profile", "apply", "devbox", "chatgpt", "check"] });
    expect(savedAnswers(home)).toMatchObject({ packs: ["pull-requests"], workflows: {}, plan: "codex" });
  });

  test("keeps picks carried from the page with one key, or changes them with e", async () => {
    const args = ["--preset", "everything", "--remove", "slack", "--remove", "incident-io", "--workflows", "pr-digest=off", "--set", "pull-requests.freeReviews=3", "--plan", "claude"];
    const home = temp.make("home-");
    const kept = await hedgeSetup(home, args, ["", ""]);
    expect(kept.code).toBe(0);
    expect(kept.output).toContain("  From your command: Quality gates, Orchestration, Communication, Integrations, Memory, Guards\n");
    expect(kept.output).toContain("  Workflows: pr-digest off");
    expect(kept.prompts).toEqual(["Press ↵ to keep them, or e to change them: ", "  Go ahead? (Y/n, or type another name for your profile repo) "]);
    expect(savedAnswers(home)).toMatchObject({
      settings: { "pull-requests.freeReviews": 3 },
      packs: ["pull-requests", "orchestration", "communication", "integrations", "memory", "guards"],
      workflows: { "quality-loop": true, "signal-loop": true },
      plan: "claude",
    });

    const other = temp.make("home-");
    const changed = await hedgeSetup(other, args, ["e", "2", ""]);
    expect(changed.code).toBe(0);
    expect(savedAnswers(other)).toMatchObject({ packs: ["pull-requests"], workflows: {} });
  });

  test("picks packs one by one", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, [], ["4", "y", "n", "", "y", "n", "n", "n", "n", "n", "n", "n", "", ""]);
    expect(result.code).toBe(0);
    expect(savedAnswers(home).packs).toEqual(["pull-requests", "communication", "memory"]);
    expect(result.output).toContain("The hub links your boxes");

    const needs = temp.make("home-");
    const picked = await hedgeSetup(needs, [], ["4", "n", "y", "n", "n", "n", "n", "n", "n", "n", "n", "n", "", ""]);
    expect(picked.output).toContain("  Orchestration needs Quality gates, so it is on too.");
    expect(savedAnswers(needs).packs).toEqual(["orchestration", "pull-requests"]);
  });

  test("--non-interactive never asks, and fails with a list of the answers it still needs", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "devbox" }));
    const missing = await hedgeSetup(home, ["--non-interactive", "--preset", "everything"]);
    expect(missing.code).toBe(2);
    expect(missing.prompts).toEqual([]);
    expect(missing.output).toContain("hedge setup --non-interactive needs these answers and sign-ins. Add the answers to the command and run it again:");
    expect(missing.output).toContain("  --set orchestration.loopProject=<value>");
    expect(missing.output).toContain("  --set orchestration.qualityArea=<value>");
    expect(missing.output).toContain("  --set orchestration.ledgerRepo=<value>");
    expect(missing.output).toContain("  --set slack.userId=<value>");
    expect(missing.output).not.toContain("memory.repo");
    expect(machine(home).setup.done).toEqual(["bootstrap", "github", "packs", "plans", "setting:orchestration.criticalPaths"]);
    expect(machine(home).profileDir).toBeUndefined();

    const sets = ["--set", "orchestration.loopProject=~/code/app", "--set", "orchestration.qualityArea=src/api", "--set", "orchestration.ledgerRepo=me/ledger", "--set", "slack.userId=U012ABCDEF"];
    const answered = await hedgeSetup(home, ["--non-interactive", "--preset", "everything", ...sets]);
    expect(answered.code).toBe(0);
    expect(answered.prompts).toEqual([]);
    expect(answered.output).toContain("Set up this machine");
    expect(savedAnswers(home).settings).toEqual({ "orchestration.loopProject": "~/code/app", "orchestration.qualityArea": "src/api", "orchestration.ledgerRepo": "me/ledger", "slack.userId": "U012ABCDEF", "context.repo": "nora/nora-hedge" });
  });

  test("--non-interactive names the command that starts each sign-in it cannot wait for, so an agent can run it", async () => {
    const github = temp.make("home-");
    const signedOut = await hedgeSetup(github, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(github, { github: 1 }));
    expect(signedOut.code).toBe(2);
    expect(signedOut.output).toContain("  Needs you: Sign in to GitHub\n  Run: gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,admin:public_key,admin:ssh_signing_key,workflow, and open https://github.com/login/device");
    expect(signedOut.output).toContain("  Sign in to GitHub: do it once in a terminal, then run hedge setup again");

    const claude = temp.make("home-");
    const noClaude = await hedgeSetup(claude, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(claude, { claude: 1 }));
    expect(noClaude.code).toBe(2);
    expect(noClaude.output).toContain("  Needs you: Sign in to Claude\n  In a terminal, run: claude auth login\n");
  });

  test("a rerun keeps answers saved before Ctrl-C marked their step done", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    const draft = { packs: ["pull-requests", "orchestration"], workflows: {}, plan: "claude", settings: { "orchestration.loopProject": "~/code/app", "orchestration.qualityArea": "src", "orchestration.ledgerRepo": "me/ledger" } };
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", setup: { done: ["bootstrap"], draft } }));
    const resumed = await hedgeSetup(home, ["--non-interactive"]);
    expect(resumed.code).toBe(0);
    expect(savedAnswers(home)).toMatchObject(draft);

    const asked = temp.make("home-");
    mkdirSync(join(asked, ".config/hedge"), { recursive: true });
    writeFileSync(join(asked, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "linux", setup: { done: ["bootstrap"], draft: { packs: ["pull-requests"], workflows: {} } } }));
    const kept = await hedgeSetup(asked, [], ["", "", ""]);
    expect(kept.output).toContain("  From your last answer: Quality gates");
    expect(savedAnswers(asked).packs).toEqual(["pull-requests"]);
  });

  test("picks from the command change answers a finished setup already has", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter"])).code).toBe(0);
    const changed = await hedgeSetup(home, ["--non-interactive", "--preset", "everyday", "--plan", "claude"]);
    expect(changed.code).toBe(0);
    expect(await pushedAnswers(home)).toMatchObject({ packs: ["pull-requests", "orchestration", "communication", "memory"], plan: "claude" });
    expect(changed.output).toContain("Set up this machine");

    const same = await hedgeSetup(home, ["--non-interactive", "--preset", "everyday", "--plan", "claude"]);
    expect(same.code).toBe(0);
    expect(same.output).not.toContain("Hedge setup ·");
  });

  test("refuses a pick that leaves a pack without a pack it needs", async () => {
    const home = temp.make("home-");
    const result = await hedgeSetup(home, ["--non-interactive", "--remove", "pull-requests"]);
    expect(result.code).toBe(2);
    expect(result.output).toStartWith("hedge setup: Orchestration needs Quality gates. Add pull-requests, or remove orchestration.");
  });

  test("refuses unknown packs, workflows, and settings before it asks anything; an unknown workflow waits for GitHub sign-in, which may find a team pack", async () => {
    const home = temp.make("home-");
    for (const [args, message] of [
      [["--add", "nope"], "hedge setup: no pack named nope."],
      [["--workflows", "nope=on"], "hedge setup: --workflows: no workflow named nope"],
      [["--workflows", "toString=on"], "hedge setup: --workflows: no workflow named toString"],
      [["--set", "pull-requests.freeReviews=many"], "hedge setup: pull-requests.freeReviews takes a number"],
      [["--set", "nope.key=1"], "hedge setup: --set nope.key: no pack has this setting"],
      [["--preset", "nope"], "hedge setup: --preset nope: choose starter, everyday, everything"],
    ] as const) {
      const result = await hedgeSetup(home, [...args]);
      expect(result.code).toBe(2);
      expect(result.output.split("\n").find((line) => line.startsWith("hedge setup:"))).toStartWith(message);
      expect(result.prompts).toEqual([]);
    }
  });

  test("--set on a finished setup changes the profile and pushes it", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const again = await hedgeSetup(home, ["--set", "pull-requests.freeReviews=5"]);
    expect(again.code).toBe(0);
    expect((await pushedAnswers(home)).settings).toEqual({ "pull-requests.freeReviews": 5 });
  });
});
