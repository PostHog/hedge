import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import type { LedgerEvent, ModeGrant } from "./decision-ledger.ts";
import { modeCommand, threadModeEnv, type ModeContext } from "./mode-cli.ts";
import { configuredMode, decidesAlone, grantedBy, lineage, resolveMode, withThreadMode } from "./mode.ts";
import type { ThreadWord } from "./proof-answers.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const settings = (values: Record<string, unknown>) => ({ HEDGE_SETTINGS: JSON.stringify(values) });
const thread = (id: string, parent?: string): ShellThread => ({ id, title: id, projectId: "p", status: "idle", ...parent ? { lineage: { parentThreadId: parent } } : {} });
const grant = (mode: ModeGrant["mode"], target: string, at = "2026-11-27T08:00:00.000Z"): ModeGrant => ({ type: "mode", mode, for: target, words: `2026-11-27 "mode ${mode}"`, thread: target, message: `m-${mode}-${at}`, machine: "box", at });

describe("the words that grant a mode", () => {
  test("a sentence that names one mode grants it, typed either way round or chosen on a card", () => {
    expect(grantedBy("mode full")).toBe("full");
    expect(grantedBy("Run this task in auto mode.")).toBe("auto");
    expect(grantedBy("MODE: Supervised")).toBe("supervised");
    expect(grantedBy("mode full (Recommended)")).toBe("full");
    expect(grantedBy("Fix the login bug. Mode full, please.")).toBe("full");
  });

  test("only an ask grants: a question, a condition, a description or a quoted label grants nothing", () => {
    expect(grantedBy("What does mode full do?")).toBeUndefined();
    expect(grantedBy("Use full mode if the tests pass.")).toBeUndefined();
    expect(grantedBy("Full mode is where the agent merges on its own.")).toBeUndefined();
    expect(grantedBy("The last line reads Mode: Full/Auto/Supervised.")).toBeUndefined();
    expect(grantedBy("Each mode has trigger words: mode full/auto/supervised.")).toBeUndefined();
    expect(grantedBy("Use mode full/auto as you like.")).toBeUndefined();
  });

  test("a request that describes every mode grants the one it asks for", () => {
    const request = "- full autonomy = the agent merges.\n- supervised mode: the most strict mode.\nThe agent always has a Mode: Full/Auto/Supervised last line.\nRun this task in auto mode.\nEach mode is a skill with trigger words: mode full/auto/supervised";
    expect(grantedBy(request)).toBe("auto");
    expect(grantedBy('2026-11-27 "Run this task in auto mode."')).toBe("auto");
  });

  test("a negated sentence, two asks for different modes, or no trigger grants nothing", () => {
    expect(grantedBy("Don't run this in full mode.")).toBeUndefined();
    expect(grantedBy("Not full mode.")).toBeUndefined();
    expect(grantedBy("Never mode full")).toBeUndefined();
    expect(grantedBy("Stop full mode")).toBeUndefined();
    expect(grantedBy("Full autonomy would be nice")).toBeUndefined();
    expect(grantedBy("Mode full. No wait, run it in auto mode.")).toBe("full");
    expect(grantedBy("Mode full. Mode auto.")).toBeUndefined();
    expect(grantedBy("full mode, but do not merge without full mode")).toBeUndefined();
  });
});

describe("where a mode comes from", () => {
  test("a thread's grant beats the repository's default, which beats the profile's, which beats the older autonomy setting", () => {
    const all = { "pull-requests.threadMode": "full", "pull-requests.repoModes": "Own/Tools=supervised, own/*=auto", "pull-requests.mode": "auto", "pull-requests.autonomy": "ask" };
    expect(configuredMode(settings(all), "own/tools")).toEqual({ mode: "full", from: "this thread's grant" });
    const { "pull-requests.threadMode": _, ...rest } = all;
    expect(configuredMode(settings(rest), "own/tools").mode).toBe("supervised");
    expect(configuredMode(settings(rest), "own/other").mode).toBe("auto");
    expect(configuredMode(settings({ ...rest, "pull-requests.mode": "full" }), "else/where")).toEqual({ mode: "full", from: "the profile default" });
    expect(configuredMode(settings({ "pull-requests.autonomy": "end" })).mode).toBe("auto");
    expect(configuredMode(settings({ "pull-requests.autonomy": "ask" })).mode).toBe("supervised");
    expect(configuredMode(settings({})).mode).toBe("supervised");
  });

  test("a mode that is not one of the three refuses", () => {
    expect(() => configuredMode(settings({ "pull-requests.mode": "yolo" }))).toThrow("not one of supervised, auto, full");
    expect(() => configuredMode(settings({ "pull-requests.repoModes": "own/tools" }), "own/tools")).toThrow("owner/name=mode pairs");
  });

  test("a lane inherits the grant of the thread that started it, its own grant wins, the latest grant counts, and a thread on its own takes the defaults", () => {
    const threads = [thread("conductor"), thread("lane", "conductor"), thread("grill", "lane"), thread("side-fix")];
    const events: LedgerEvent[] = [grant("full", "conductor"), grant("supervised", "grill"), grant("auto", "grill", "2026-11-27T09:00:00.000Z")];
    const env = settings({ "pull-requests.mode": "auto", "pull-requests.repoModes": "own/tools=supervised" });
    expect(lineage(threads, "grill")).toEqual({ threads: ["grill", "lane", "conductor"], complete: true });
    expect(resolveMode(env, events, lineage(threads, "lane"), "own/tools")).toEqual({ mode: "full", from: "inherited from thread conductor, granted 2026-11-27 in thread conductor" });
    expect(resolveMode(env, events, lineage(threads, "grill")).mode).toBe("auto");
    expect(resolveMode(env, events, lineage(threads, "side-fix"), "own/tools")).toEqual({ mode: "supervised", from: "the default of own/tools" });
    expect(resolveMode(env, events, lineage(threads, "side-fix"))).toEqual({ mode: "auto", from: "the profile default" });
  });

  test("a lineage that loops, misses a parent, or names an unknown thread is incomplete", () => {
    expect(lineage([thread("a", "b"), thread("b", "a")], "a")).toEqual({ threads: ["a", "b"], complete: false });
    expect(lineage([thread("a", "gone")], "a")).toEqual({ threads: ["a"], complete: false });
    expect(lineage([], "x")).toEqual({ threads: ["x"], complete: false });
  });

  test("an incomplete lineage without a grant of its own never runs in mode full, and keeps a stricter default", () => {
    const env = settings({ "pull-requests.mode": "full", "pull-requests.repoModes": "own/tools=full, own/strict=supervised" });
    const broken = { threads: ["lane"], complete: false };
    expect(resolveMode(env, [], broken, "own/tools").mode).toBe("auto");
    expect(resolveMode(env, [], broken, "own/strict").mode).toBe("supervised");
    expect(resolveMode(env, [grant("full", "lane")], broken, "own/tools").mode).toBe("full");
    expect(configuredMode(withThreadMode(env, [], broken), "own/strict").mode).toBe("supervised");
    expect(configuredMode(withThreadMode(env, [], broken), "own/tools").mode).toBe("auto");
    expect(configuredMode(withThreadMode(env, [], broken), "else/where").mode).toBe("auto");
  });

  test("a ledger row whose words do not grant its mode counts for nothing", () => {
    const forged: ModeGrant = { ...grant("full", "lane"), words: '2026-11-27 "What does mode full do?"' };
    expect(resolveMode(settings({ "pull-requests.mode": "auto" }), [forged], { threads: ["lane"], complete: true }).mode).toBe("auto");
  });

  test("the proof commands decide alone by the thread's grant, never by a grant the environment brings in", () => {
    const env = settings({ "pull-requests.mode": "auto", "pull-requests.threadMode": "full" });
    expect(decidesAlone(withThreadMode(env, [grant("supervised", "lane")], { threads: ["lane"], complete: true }))).toBe(false);
    expect(configuredMode(withThreadMode(env, [], { threads: ["lane"], complete: true })).mode).toBe("auto");
  });
});

describe("hedge mode", () => {
  const word = (text: string, source: ThreadWord["source"] = "typed", where = "conductor"): ThreadWord => ({ thread: where, id: `w-${text}`, text, answered: source === "question" ? "Which mode for the grilling session?" : "", at: "2026-11-27T08:00:00.000Z", source });
  const context = (words: ThreadWord[], threads: ShellThread[], printed: string[]): ModeContext => {
    const home = temp.make("mode-home-");
    return { home, cwd: home, env: settings({ "pull-requests.mode": "auto", "pull-requests.repoModes": "own/strict=supervised" }), print: (text) => printed.push(text), threadWords: async (id) => words.filter((one) => one.thread === id), threads: async () => threads, repository: () => "own/tools" };
  };
  const threads = [thread("conductor"), thread("lane", "conductor"), thread("side-fix")];

  test("set records the user's grant once, and show prints it for the thread and the lanes it started", async () => {
    const printed: string[] = [];
    const run = context([word("Ship the importer. Mode full.")], threads, printed);
    expect(await modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Ship the importer. Mode full."'], run)).toBe(0);
    expect(await modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Ship the importer. Mode full."'], run)).toBe(0);
    expect(printed.at(-1)).toContain("already recorded");
    const recorded = readFileSync(join(run.home, ".local/state/hedge/decisions.jsonl"), "utf8").trim().split("\n");
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!)).toEqual(expect.objectContaining({ type: "mode", mode: "full", for: "conductor", thread: "conductor", message: "w-Ship the importer. Mode full." }));
    await modeCommand(["show", "--thread", "lane"], run);
    expect(printed.at(-1)).toBe("Mode: Full\nfrom: inherited from thread conductor, granted 2026-11-27 in thread conductor\nlabel: mode:full");
    await modeCommand(["show", "--thread", "side-fix"], run);
    expect(printed.at(-1)).toStartWith("Mode: Auto\nfrom: the profile default");
  });

  test("set refuses words the user did not write, words that grant another mode, and a thread the words do not reach", async () => {
    const run = context([word("Run this in auto mode."), word("mode supervised", "question")], threads, []);
    await expect(modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "mode full"'], run)).rejects.toThrow("is not in a message of the user's");
    await expect(modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Run this in auto mode."'], run)).rejects.toThrow("grants mode auto");
    await expect(modeCommand(["set", "full", "--thread", "conductor"], run)).rejects.toThrow("only the user's words switch a mode");
    await expect(modeCommand(["set", "supervised", "--thread", "conductor", "--words", '2026-11-27 "mode supervised"', "--for", "side-fix"], run)).rejects.toThrow("was not started by thread conductor");
    expect(await modeCommand(["set", "supervised", "--thread", "conductor", "--words", '2026-11-27 "mode supervised"', "--for", "lane"], run)).toBe(0);
  });

  test("an older message never replaces a newer grant, on the thread or on a lane it started", async () => {
    const early = { ...word("Mode full."), at: "2026-11-27T08:00:00.000Z" };
    const late = { ...word("Mode supervised."), at: "2026-11-27T09:00:00.000Z" };
    const run = context([early, late], threads, []);
    expect(await modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Mode full."'], run)).toBe(0);
    expect(await modeCommand(["set", "supervised", "--thread", "conductor", "--words", '2026-11-27 "Mode supervised."'], run)).toBe(0);
    await expect(modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Mode full."', "--for", "lane"], run)).rejects.toThrow("newer than this message");
    await expect(modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "Mode full."'], run)).rejects.toThrow("newer than this message");
  });

  test("show takes the repository of the checkout when --repo is left out", async () => {
    const printed: string[] = [];
    const run = { ...context([], threads, printed), repository: () => "own/strict" };
    await modeCommand(["show", "--thread", "side-fix"], run);
    expect(printed.at(-1)).toStartWith("Mode: Supervised\nfrom: the default of own/strict");
    await modeCommand(["show", "--thread", "side-fix", "--repo", "own/tools"], run);
    expect(printed.at(-1)).toStartWith("Mode: Auto");
  });
});

test("the proof and decision commands drop a thread mode the environment brings in, with or without a thread", async () => {
  const home = temp.make("mode-env-");
  const env = await threadModeEnv(home, settings({ "pull-requests.mode": "supervised", "pull-requests.threadMode": "full" }), async () => []);
  expect(configuredMode(env).mode).toBe("supervised");
});
