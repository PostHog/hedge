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

  test("a negated sentence, a message that names two modes, or no trigger grants nothing", () => {
    expect(grantedBy("Don't run this in full mode.")).toBeUndefined();
    expect(grantedBy("Not full mode.")).toBeUndefined();
    expect(grantedBy("Never mode full")).toBeUndefined();
    expect(grantedBy("Stop full mode")).toBeUndefined();
    expect(grantedBy("Full autonomy would be nice")).toBeUndefined();
    expect(grantedBy("supervised mode is the strict one. Run this task in auto mode.")).toBeUndefined();
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
    expect(lineage(threads, "grill")).toEqual(["grill", "lane", "conductor"]);
    expect(resolveMode(env, events, lineage(threads, "lane"), "own/tools")).toEqual({ mode: "full", from: "inherited from thread conductor, granted 2026-11-27 in thread conductor" });
    expect(resolveMode(env, events, lineage(threads, "grill")).mode).toBe("auto");
    expect(resolveMode(env, events, lineage(threads, "side-fix"), "own/tools")).toEqual({ mode: "supervised", from: "the default of own/tools" });
    expect(resolveMode(env, events, lineage(threads, "side-fix"))).toEqual({ mode: "auto", from: "the profile default" });
  });

  test("a lineage that loops ends, and an unknown thread is its own chain", () => {
    expect(lineage([thread("a", "b"), thread("b", "a")], "a")).toEqual(["a", "b"]);
    expect(lineage([], "x")).toEqual(["x"]);
  });

  test("the proof commands decide alone by the thread's grant, never by a grant the environment brings in", () => {
    const env = settings({ "pull-requests.mode": "auto", "pull-requests.threadMode": "full" });
    expect(decidesAlone(withThreadMode(env, [grant("supervised", "lane")], ["lane"]))).toBe(false);
    expect(configuredMode(withThreadMode(env, [], ["lane"])).mode).toBe("auto");
  });
});

describe("hedge mode", () => {
  const word = (text: string, source: ThreadWord["source"] = "typed", where = "conductor"): ThreadWord => ({ thread: where, id: `w-${text}`, text, answered: source === "question" ? "Which mode for the grilling session?" : "", at: "2026-11-27T08:00:00.000Z", source });
  const context = (words: ThreadWord[], threads: ShellThread[], printed: string[]): ModeContext => {
    const home = temp.make("mode-home-");
    return { home, cwd: home, env: settings({ "pull-requests.mode": "auto" }), print: (text) => printed.push(text), threadWords: async (id) => words.filter((one) => one.thread === id), threads: async () => threads };
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
});

test("the proof and decision commands drop a thread mode the environment brings in, with or without a thread", async () => {
  const home = temp.make("mode-env-");
  const env = await threadModeEnv(home, settings({ "pull-requests.mode": "supervised", "pull-requests.threadMode": "full" }), async () => []);
  expect(configuredMode(env).mode).toBe("supervised");
});
