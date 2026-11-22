import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { parseSetupFlags } from "../src/setup/flags.ts";
import { picksFrom } from "../src/setup/questions.ts";
import { loadCatalog } from "../src/setup/setup.ts";
import { engineRoot, fakeMachine, hedgeSetup, githubRepo, pushedAnswers, scripted } from "../src/setup/testing.ts";
import { isolateGit, tempDirs } from "../src/testing/git.ts";
import { pageData } from "../scripts/build-page.ts";
import { firstStart, installPrompt, promptData, setupSplit, startPrompt, toggleSelected, toggleStart, type PageData, type Start } from "./model.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());
let data: PageData;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
});

const root = join(import.meta.dir, "..");
const flip = (start: Start, ...names: string[]) => names.reduce((picked, name) => toggleStart(data, picked, name), start);
const select = (...names: string[]) => names.reduce((selected, name) => toggleSelected(data, selected, name), [] as string[]);
const everyPack = () => select(...data.packs.map((pack) => pack.name));
const line = (text: string, label: string) => text.match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1];
const step = (text: string, start: string) => text.split("\n").find((item) => /^\d+\. /.test(item) && item.includes(start));
const filledIn = (code: string): string => (/<[^<>\n]+>/.test(code) ? filledIn(code.replace(/<[^<>\n]+>/g, "value")) : code);
const parses = (code: string) => Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(filledIn(code)) }).exitCode === 0;
const remoteHereDocuments = (code: string) => [...code.matchAll(/\bssh(?:\s+-\S+)*\s+[^\s'"]+\s+sh -s <<'([A-Za-z_][A-Za-z0-9_]*)'\n([\s\S]*?)^\1$/gm)].map((match) => match[2]!);
const remoteCommands = (code: string) => [
  ...[...code.matchAll(/\bssh(?:\s+-\S+)*\s+[^\s'"]+\s+'([^']*)'/g)].map((match) => match[1]!),
  ...remoteHereDocuments(code),
];
const unparsedSnippets = (codes: string[]) => codes.filter((code) => !parses(code) || !remoteCommands(code).every(parses));
const sshSnippets = (note: string) =>
  [
    ...[...note.matchAll(/^( *)```sh\n([\s\S]*?)^ *```$/gm)].map((match) => match[2]!.replace(new RegExp(`^${match[1]!}`, "gm"), "")),
    ...[...note.replace(/^ *```[\s\S]*?^ *```$/gm, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!),
  ].filter((code) => /\bssh /.test(code));
const withHub = (code: string, hub: string) => code.replace(/(\bssh (?:-t )?)[^\s`'"]*<hub>[^\s`'"]*/g, `$1${hub}`);

async function hubWithHedge() {
  const home = temp.make("home-");
  expect((await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home))).code).toBe(0);
  const io = scripted([]);
  const hedge = (args: string[]) => main(args, { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  return { home, hedge, output: io.output };
}

async function hedgeCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "linux", print: (text) => (usage += `${text}\n`) });
  const commandFiles = (dir: string) => (existsSync(join(dir, "commands")) ? readdirSync(join(dir, "commands")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.slice(0, -3)) : []);
  const shipped = (await loadPacks(root)).flatMap(({ dir, code }) => [...Object.keys(code?.commands ?? {}), ...commandFiles(dir)]);
  return new Set([...[...usage.matchAll(/^ {2}hedge ([a-z][a-z-]*)/gm)].map((match) => match[1]!), ...shipped]);
}

describe("the Getting started prompt", () => {
  const readmePrompt = () => readFileSync(join(root, "README.md"), "utf8").match(/```text\n\s*(Set up Hedge[^\n]+)\n/)![1]!;

  test("is the README's prompt plus the four packs the hub's first setup turns on by default, and the Hub pack for once the hub runs", () => {
    expect(startPrompt(data, firstStart)).toBe(`${readmePrompt()}\n\nMy picks from the Hedge page:\n- Packs on the first setup: pull-requests, orchestration, communication, memory\n- Packs once the hub runs: hub`);
  });

  test("a pack that is switched off leaves the first setup, and comes back when it is switched on", () => {
    expect(line(startPrompt(data, flip(firstStart, "communication")), "Packs on the first setup")).toBe("pull-requests, orchestration, memory");
    expect(startPrompt(data, flip(firstStart, "communication", "communication"))).toBe(startPrompt(data, firstStart));
    expect(line(startPrompt(data, flip(firstStart, "communication")), "Packs once the hub runs")).toBe("hub");
  });

  test("switches only the packs of the first setup", () => {
    expect(startPrompt(data, flip(firstStart, "hub", "slack", "base"))).toBe(startPrompt(data, firstStart));
  });

  test("its first setup packs, as the guide's one by one command, are the packs setup turns on", async () => {
    const catalog = await loadCatalog(root, [], temp.make("home-"));
    for (const start of [firstStart, flip(firstStart, "orchestration"), flip(firstStart, "pull-requests"), flip(firstStart, "pull-requests", "communication")]) {
      const packs = setupSplit(data, start).first;
      const flags = ["--preset", "starter", ...(packs.includes("pull-requests") ? [] : ["--remove", "pull-requests"]), ...packs.filter((name) => name !== "pull-requests").flatMap((name) => ["--add", name])];
      expect(picksFrom(parseSetupFlags(flags), catalog).packs.toSorted()).toEqual(packs.toSorted());
    }
  });

  test("the data a page carries builds the same prompts as the full pack data", () => {
    const carried = JSON.parse(JSON.stringify(promptData(data)));
    expect(startPrompt(carried, flip(firstStart, "communication"))).toBe(startPrompt(data, flip(firstStart, "communication")));
    expect(installPrompt(carried, everyPack())).toBe(installPrompt(data, everyPack()));
  });
});

describe("the install prompt", () => {
  test("is empty until a pack is selected", () => {
    expect(installPrompt(data, [])).toBe("");
  });

  test("names the selected packs, finds the hub first, runs every command there, and names each setup note and one hedge packs command that adds them", () => {
    expect(installPrompt(data, select("guards", "memory", "communication"))).toBe(
      [
        "Add these Hedge packs to my setup with me: Communication, Guards, and Memory.",
        "",
        "Hedge runs on my hub and my nodes in the cloud, not on my Mac. Run each command of this prompt on the hub, over SSH with the `PATH` line of https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md when you run elsewhere. Install nothing from Hedge here. Ask me each choice with your question tool, and run every command yourself.",
        "",
        '1. Find my hub. List my cloud boxes as step 1 of https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md does, and run `hedge hub status` over SSH on each one that runs, until one names the hub. Do not ask a `hedge` on this Mac: an earlier setup can leave one here. The name after "The hub:" is the SSH name of the hub. In each SSH command of a note, put that whole name in place of the host that holds `<hub>`. When every box prints "The hub: not named", or no box runs Hedge, I have no hub yet. Tell me, and offer to set one up first with steps 5, 7, and 9 of https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md. To make a box that already runs Hedge the hub, skip step 5 for it.',
        "2. Run `hedge update` on the hub, so it has the newest engine and packs. Then run `hedge packs` there, and leave out each pack that is already on.",
        '3. Read the setup note of each pack. Ask me what it asks, and collect the flags that it names. Where a note names "the setup command" or "the command in item 2 of step 9", use the `hedge packs` command of this prompt. Do not run a step that a note puts after that command yet.',
        "   - Guards: ~/.local/share/hedge/engine/packs/guards/SETUP.md",
        "   - Memory: ~/.local/share/hedge/engine/packs/memory/SETUP.md",
        "4. Turn the packs on with one command on the hub, and add the flags that the notes name:",
        "   hedge packs --add communication --add guards --add memory",
        "5. Do the steps that each note puts after the command.",
        "6. Run `hedge doctor` on the hub, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
        "7. My nodes take the change at their next `hedge update`. To give it to one now, run `hedge update` there.",
      ].join("\n"),
    );
  });

  test("for one pack without a setup note, names that pack alone and no note", () => {
    const text = installPrompt(data, select("communication"));
    expect(text.split("\n")[0]).toBe("Add this Hedge pack to my setup with me: Communication.");
    expect(text).not.toMatch(/\bnotes?\b/);
    expect(text).toContain("4. Run `hedge doctor` on the hub");
    expect(text).toContain("3. Turn the packs on with one command on the hub:\n   hedge packs --add communication\n");
  });

  test("selecting a pack selects the packs it requires, and taking one back takes back the packs that require it", () => {
    expect(select("orchestration")).toEqual(["pull-requests", "orchestration"]);
    expect(select("orchestration", "memory", "pull-requests")).toEqual(["memory"]);
    expect(select("base")).toEqual([]);
  });

  test("for any selection, finds the hub with hedge hub status in the words it prints, sends a box without a hub to the setup guide's steps 5, 7, and 9, and never says Hedge runs on the machine it is pasted on", async () => {
    for (const selected of [select("communication"), select("mcp-gateway"), select("memory", "slack"), everyPack()]) {
      const text = installPrompt(data, selected);
      expect(step(text, "Find my hub")).toStartWith("1. Find my hub. List my cloud boxes as step 1 of https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md does, and run `hedge hub status` over SSH on each one that runs");
      expect(step(text, "Find my hub")).not.toMatch(/hedge-`|command -v hedge/);
      expect(text).toContain("offer to set one up first with steps 5, 7, and 9 of https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md");
      expect(text).not.toContain("Hedge already runs on this machine");
    }
    const box = await hubWithHedge();
    expect(await box.hedge(["hub", "status"])).toBe(0);
    expect(box.output()).toContain("\nThe hub: not named.");
    expect(await box.hedge(["hub", "here", "coder.hedge-hub"])).toBe(0);
    expect(await box.hedge(["hub", "status"])).toBe(0);
    expect(box.output()).toContain("\nThe hub: coder.hedge-hub");
    const guide = readFileSync(join(root, "SETUP.md"), "utf8");
    for (const heading of ["\n## 5. Create the hub and the nodes\n", "\n## 7. Set up Hedge on the hub\n", "\n## 9. Add the hub packs and the nodes\n"]) expect(guide).toContain(heading);
  });

  test("with the name that hedge hub status prints put in where it says, each setup note's SSH snippet and the command it runs on the hub parse with sh -n, and each SSH command outside a comment line names the hub as its host", async () => {
    const box = await hubWithHedge();
    expect(await box.hedge(["hub", "here", "coder.hedge-hub"])).toBe(0);
    expect(await box.hedge(["hub", "status"])).toBe(0);
    const hub = box.output().match(/The hub: (\S+)\.$/m)![1]!;
    const text = installPrompt(data, everyPack());
    expect(step(text, "Find my hub")).toContain('The name after "The hub:" is the SSH name of the hub. In each SSH command of a note, put that whole name in place of the host that holds `<hub>`.');
    const notes = [...[...text.matchAll(/^ {3}- [^:]+: ~\/\.local\/share\/hedge\/engine\/(\S+)$/gm)].map((match) => match[1]!), "packs/hub/SETUP.md"].map((path) => readFileSync(join(root, path), "utf8"));
    const filled = notes.flatMap(sshSnippets).map((code) => withHub(code, hub));
    expect(filled.filter((code) => code.includes("<hub>"))).toEqual([]);
    expect(unparsedSnippets(filled)).toEqual([]);
    expect(filled.flatMap(remoteCommands).length).toBeGreaterThan(filled.length / 2);
    const dangling = `ssh ${hub} 'hedge doctor &&'`;
    expect(unparsedSnippets([dangling])).toHaveLength(1);
    const recovery = sshSnippets(readFileSync(join(root, "packs/hub/SETUP.md"), "utf8"))
      .map((code) => withHub(code, hub))
      .find((code) => code.includes("sh -s <<"))!;
    expect(filled).toContain(recovery);
    const brokenRecovery = recovery.replace(/(sh -s <<[^\n]*\n)/, "$1fi\n");
    expect([unparsedSnippets([recovery]), unparsedSnippets([brokenRecovery])]).toEqual([[], [brokenRecovery]]);
    expect(filled.filter((code) => (code.match(/<</g) ?? []).length !== remoteHereDocuments(code).length)).toEqual([]);
    const run = filled.map((code) => code.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"));
    const hosts = run.flatMap((code) => [...code.matchAll(/\bssh((?:\s+-\S+)*)\s+([^\s'"]+)/g)].map((match) => match[2]!));
    expect(hosts.length).toBe(run.join("\n").match(/\bssh\s/g)!.length);
    expect(new Set(hosts)).toEqual(new Set([hub]));
  });

  test("names only hedge commands that exist", async () => {
    const known = await hedgeCommands();
    const used = [...installPrompt(data, everyPack()).matchAll(/\bhedge ([a-z][a-z-]*)\b/g)].map((match) => match[1]!);
    expect(new Set(used)).toEqual(new Set(["update", "packs", "hub", "doctor"]));
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });

  test("names the setup note of every pack that has one, at the path where a machine that runs Hedge keeps it", () => {
    const named = [...installPrompt(data, everyPack()).matchAll(/^ {3}- [^:]+: ~\/\.local\/share\/hedge\/engine\/(\S+)$/gm)].map((match) => match[1]!);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")) && data.packs.some((item) => item.name === pack && !item.always));
    expect(named.toSorted()).toEqual(held.map((pack) => `packs/${pack}/SETUP.md`).toSorted());
  });

  test("Memory's note leaves the memory repo to the command, and the command of the prompt shares the profile repo on a Hedge that already runs", async () => {
    const note = readFileSync(join(root, "packs/memory/SETUP.md"), "utf8").replace(/\s+/g, " ");
    expect(note).toContain("add nothing to the command. `hedge setup` and `hedge packs --add memory` set `context.repo` to their profile repo unless `<their GitHub login>/hedge-memory` or `fleet-memory` exists already.");
    const hub = await hubWithHedge();
    const command = installPrompt(data, select("memory")).match(/^ {3}hedge (packs .*)$/m)![1]!;
    expect(await hub.hedge(command.split(" "))).toBe(0);
    expect(existsSync(githubRepo(hub.home, "nora/hedge-memory"))).toBe(false);
    expect(await pushedAnswers(hub.home)).toMatchObject({ packs: expect.arrayContaining(["memory"]), settings: { "context.repo": "nora/nora-hedge" } });
  });

  test("its command turns the selected packs on in the profile of a machine that runs Hedge", async () => {
    const hub = await hubWithHedge();
    const selected = select("communication", "guards");
    const command = installPrompt(data, selected).match(/^ {3}hedge (packs .*)$/m)![1]!;
    expect(await hub.hedge(command.split(" "))).toBe(0);
    expect((await pushedAnswers(hub.home)).packs).toEqual(expect.arrayContaining(selected));
  });
});
