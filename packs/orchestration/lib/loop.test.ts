import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { runLoop, type LoopIo } from "./loop.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const command = join(import.meta.dir, "../commands/loop.ts");
const lanes = (...ids: string[]) => ["# Lanes", "", "| ID | Loop | Row or signal | State |", "| --- | --- | --- | --- |", ...ids.map((id) => `| ${id} | quality | backlog #1 | settled |`)].join("\n");
const signals = (...ids: string[]) => ["# Signals", "", "| ID | Source | Status |", "| --- | --- | --- |", ...ids.map((id) => `| ${id} | errors | candidate, see L999 |`)].join("\n");

function ledger(files: Record<string, string>) {
  const dir = temp.make("ledger-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

async function runCommand(args: string[], home: string, settings: Record<string, unknown>) {
  const child = Bun.spawn([process.execPath, command, ...args], { env: { PATH: Bun.env.PATH, HOME: home, HEDGE_SETTINGS: JSON.stringify(settings), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, out: (await new Response(child.stdout).text()).trim() };
}

async function loop(args: string[], setting?: string, home = temp.make("home-")) {
  const out: string[] = [];
  const io: LoopIo = { home, ledger: () => setting, print: (line) => out.push(line) };
  const code = await runLoop(args, io);
  return { code, out: out.join("\n") };
}

describe("hedge loop check-pause", () => {
  test("exits 0 while the ledger's limits say the loop runs", async () => {
    const dir = ledger({ "limits.md": "Quality loop WIP: 2\nPaused: no\n" });
    expect(await loop(["check-pause", "--ledger", dir])).toMatchObject({ code: 0, out: expect.stringContaining("start lanes up to the WIP limits") });
  });

  test("exits 0 for a bold no with a note after it", async () => {
    expect((await loop(["check-pause", "--ledger", ledger({ "limits.md": "- **Paused:** no (since the planning)\n" })])).code).toBe(0);
  });

  test.each([
    ["a plain line", "Quality loop WIP: 2\nPaused: yes\n\n## Changes\n- 2026-11-14: paused: yes.\n"],
    ["a list item", "- Paused: yes (until Friday)\n"],
    ["bold", "**Paused:** yes\n"],
  ])("exits 1 and says to start no lane while the limits say the loop is paused in %s", async (_, limits) => {
    const dir = ledger({ "limits.md": limits });
    expect(await loop(["check-pause", "--ledger", dir])).toMatchObject({ code: 1, out: expect.stringContaining("start no lane") });
  });

  test.each([
    ["a missing limits file", {}],
    ["a Paused value that is neither yes nor no", { "limits.md": "Paused: maybe\n" }],
    ["a limits file without a Paused line", { "limits.md": "Quality loop WIP: 2\n" }],
    ["Paused lines that disagree after a merge", { "limits.md": "Paused: no\nQuality loop WIP: 2\nPaused: yes\n" }],
    ["markup inside a no", { "limits.md": "Paused: n_o\n" }],
    ["a no followed by another value", { "limits.md": "Paused: no: yes\n" }],
  ])("fails closed with exit 3 on %s", async (_, files) => {
    const result = await loop(["check-pause", "--ledger", ledger(files)]);
    expect(result).toMatchObject({ code: 3, out: expect.stringContaining("start no lane") });
  });

  test("the command reads the ledger from the orchestration.loopLedger setting, with ~/ for the home directory", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, "ledger"));
    writeFileSync(join(home, "ledger/limits.md"), "Paused: yes\n");
    expect(await runCommand(["check-pause"], home, { "orchestration.loopLedger": "~/ledger" })).toMatchObject({ code: 1, out: expect.stringContaining(join(home, "ledger/limits.md")) });
  });

  test("takes --ledger=<dir> as well as --ledger <dir>", async () => {
    const dir = ledger({ "limits.md": "Paused: no\n" });
    expect((await loop(["check-pause", `--ledger=${dir}`], ledger({ "limits.md": "Paused: yes\n" }))).code).toBe(0);
  });

  test("refuses an argument it does not know instead of ignoring it", async () => {
    await expect(loop(["check-pause", "--legder", ledger({ "limits.md": "Paused: no\n" })])).rejects.toThrow("unknown argument --legder");
  });

  test("refuses --kind, which only next-id takes", async () => {
    await expect(loop(["check-pause", "--kind", "signal", "--ledger", ledger({ "limits.md": "Paused: no\n" })])).rejects.toThrow("unknown argument --kind");
  });

  test("names the setting when no ledger is given", async () => {
    await expect(loop(["check-pause"])).rejects.toThrow("orchestration.loopLedger");
  });
});

describe("hedge loop next-id", () => {
  test("prints the lane and signal ids after the highest ones in the ledger", async () => {
    const dir = ledger({ "lanes.md": lanes("L009", "L064", "L010"), "signals.md": signals("S228", "S230") });
    expect((await loop(["next-id", "--kind", "lane", "--ledger", dir])).out).toBe("L065");
    expect((await loop(["next-id", "--kind", "signal", "--ledger", dir])).out).toBe("S231");
  });

  test("counts a follow-up lane with a letter after its number", async () => {
    const dir = ledger({ "lanes.md": lanes("L064", "L065b") });
    expect((await loop(["next-id", "--kind", "lane", "--ledger", dir])).out).toBe("L066");
  });

  test("never hands out an id twice before the ledger records it", async () => {
    const home = temp.make("home-");
    const dir = ledger({ "lanes.md": lanes("L064") });
    const first = await loop(["next-id", "--kind", "lane", "--ledger", dir], undefined, home);
    const second = await loop(["next-id", "--kind", "lane", "--ledger", dir], undefined, home);
    expect([first.out, second.out]).toEqual(["L065", "L066"]);
  });

  test("counts a row written with a space before its first pipe", async () => {
    const dir = ledger({ "lanes.md": `${lanes("L064")}\n  | L070 | signal | S231 | running |` });
    expect((await loop(["next-id", "--kind", "lane", "--ledger", dir])).out).toBe("L071");
  });

  test.each([
    ["the same origin", "https://example.com/acme/ledger.git"],
    ["an SSH origin", "git@example.com:acme/ledger.git"],
    ["an ssh:// origin", "ssh://git@example.com/acme/ledger"],
  ])("never hands out one id to two checkouts of the same ledger repository on one machine, with %s", async (_, secondOrigin) => {
    const home = temp.make("home-");
    const first = temp.make("checkout-");
    mkdirSync(join(first, "quality-loop"));
    writeFileSync(join(first, "quality-loop/lanes.md"), lanes("L064"));
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://example.com/acme/ledger.git"]]) spawnSync("git", ["-C", first, ...args]);
    const second = temp.make("checkout-");
    cpSync(first, second, { recursive: true });
    spawnSync("git", ["-C", second, "remote", "set-url", "origin", secondOrigin]);
    const one = await loop(["next-id", "--kind", "lane", "--ledger", join(first, "quality-loop")], undefined, home);
    const two = await loop(["next-id", "--kind", "lane", "--ledger", join(second, "quality-loop")], undefined, home);
    expect([one.out, two.out]).toEqual(["L065", "L066"]);
  });

  test("starts at 001 in an empty ledger", async () => {
    expect((await loop(["next-id", "--kind", "signal", "--ledger", ledger({ "signals.md": signals() })])).out).toBe("S001");
  });

  test("gives every one of many parallel callers its own id", async () => {
    const home = temp.make("home-");
    const dir = ledger({ "lanes.md": lanes("L064") });
    const callers = Array.from({ length: 12 }, () => Bun.spawn([process.execPath, command, "next-id", "--kind", "lane", "--ledger", dir], { env: { PATH: Bun.env.PATH, HOME: home, HEDGE_SETTINGS: "{}", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe" }));
    const ids = await Promise.all(callers.map(async (caller) => (await new Response(caller.stdout).text()).trim()));
    expect(ids.toSorted()).toEqual(Array.from({ length: 12 }, (_, index) => `L0${65 + index}`));
  });

  test("refuses a kind it does not know", async () => {
    await expect(loop(["next-id", "--kind", "lanes", "--ledger", ledger({})])).rejects.toThrow("--kind lane or --kind signal");
  });
});
