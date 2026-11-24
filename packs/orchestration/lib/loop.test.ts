import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

  test("exits 1 and says to start no lane while the limits say the loop is paused", async () => {
    const dir = ledger({ "limits.md": "Quality loop WIP: 2\nPaused: yes\n\n## Changes\n- 2026-11-14: paused: yes.\n" });
    expect(await loop(["check-pause", "--ledger", dir])).toMatchObject({ code: 1, out: expect.stringContaining("start no lane") });
  });

  test.each([
    ["a missing limits file", {}],
    ["a Paused value that is neither yes nor no", { "limits.md": "Paused: maybe\n" }],
  ])("fails closed with exit 3 on %s", async (_, files) => {
    const result = await loop(["check-pause", "--ledger", ledger(files)]);
    expect(result).toMatchObject({ code: 3, out: expect.stringContaining("start no lane") });
  });

  test("reads the ledger from the orchestration.loopLedger setting, with ~/ for the home directory", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, "ledger"));
    writeFileSync(join(home, "ledger/limits.md"), "Paused: yes\n");
    expect((await loop(["check-pause"], "~/ledger", home)).code).toBe(1);
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

  test("never hands out an id twice before the ledger records it", async () => {
    const home = temp.make("home-");
    const dir = ledger({ "lanes.md": lanes("L064") });
    const first = await loop(["next-id", "--kind", "lane", "--ledger", dir], undefined, home);
    const second = await loop(["next-id", "--kind", "lane", "--ledger", dir], undefined, home);
    expect([first.out, second.out]).toEqual(["L065", "L066"]);
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
