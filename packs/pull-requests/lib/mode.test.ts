import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import type { LedgerEvent, ModeGrant } from "./decision-ledger.ts";
import { modeCommand, threadModeEnv, type ModeContext } from "./mode-cli.ts";
import { configuredMode, decidesAlone, fullHeldAtAuto, grantedBy, lineage, modeQuestion, resolveMode, withHeardFull, withThreadMode } from "./mode.ts";
import type { ThreadWord } from "./proof-answers.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const settings = (values: Record<string, unknown>) => ({ HEDGE_SETTINGS: JSON.stringify(values) });
const thread = (id: string, parent?: string): ShellThread => ({ id, title: id, projectId: "p", status: "idle", ...parent ? { lineage: { parentThreadId: parent } } : {} });
const grant = (mode: ModeGrant["mode"], target: string, at = "2026-11-27T08:00:00.000Z"): ModeGrant => ({ type: "mode", mode, for: target, words: `2026-11-27 "mode ${mode}"`, thread: target, message: `m-${mode}-${at}`, machine: "box", at });

describe("the answer that grants a mode", () => {
  test("only a mode option, as the question tool returns it, grants that mode", () => {
    expect(grantedBy("mode full")).toBe("full");
    expect(grantedBy("Mode Auto (Recommended)")).toBe("auto");
    expect(grantedBy('2026-11-27 "mode supervised"')).toBe("supervised");
    expect(modeQuestion("lane-1")).toBe("Which mode should thread lane-1 run in?");
  });

  test("any other text grants nothing, however close", () => {
    for (const text of ["Mode full.", "Run this task in full mode.", "Mode full, please", "full mode", "Use this text for the heading. `Mode full`.", "Mode full. Scratch that, keep the current settings.", "mode full/auto", "mode fullest"]) {
      expect(grantedBy(text)).toBeUndefined();
    }
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

  test("an incomplete lineage without a grant of its own runs supervised, whatever the defaults say", () => {
    const env = settings({ "pull-requests.mode": "full", "pull-requests.repoModes": "own/tools=full, own/strict=supervised" });
    const broken = { threads: ["lane"], complete: false };
    expect(resolveMode(env, [], broken, "own/tools").mode).toBe("supervised");
    expect(resolveMode(env, [], broken, "own/strict").mode).toBe("supervised");
    expect(resolveMode(env, [grant("full", "lane")], broken, "own/tools").mode).toBe("full");
    for (const repository of ["own/strict", "own/tools", "else/where"]) expect(configuredMode(withThreadMode(env, [], broken), repository).mode).toBe("supervised");
  });

  test("full defaults from settings the hook did not apply are held at auto", () => {
    const held = fullHeldAtAuto(JSON.stringify({ "pull-requests.mode": "full", "pull-requests.repoModes": "own/tools=full, own/strict=supervised" }));
    expect(configuredMode({ HEDGE_SETTINGS: held }, "own/tools").mode).toBe("auto");
    expect(configuredMode({ HEDGE_SETTINGS: held }, "own/strict").mode).toBe("supervised");
    expect(configuredMode({ HEDGE_SETTINGS: held }, "else/where").mode).toBe("auto");
    for (const unreadable of ["{", "[]", "", "null", undefined]) expect(fullHeldAtAuto(unreadable)).toBe("{}");
  });

  test("the merge gate counts a full grant only when its thread still holds the card answer it names", async () => {
    const chain = { threads: ["lane", "conductor"], complete: true };
    const full = grant("full", "conductor");
    const auto = grant("auto", "conductor", "2026-11-26T08:00:00.000Z");
    const answer = (changes: Partial<ThreadWord> = {}): ThreadWord => ({ thread: "conductor", id: full.message, text: "mode full", answered: modeQuestion("conductor"), at: full.at, source: "question", ...changes });
    const modeWith = async (...answers: ThreadWord[]) => resolveMode(settings({ "pull-requests.mode": "supervised" }), await withHeardFull([auto, full], chain, async (thread) => thread === "conductor" ? answers : []), chain).mode;
    expect(await modeWith(answer())).toBe("full");
    expect(await modeWith()).toBe("auto");
    expect(await modeWith(answer({ source: "typed" }))).toBe("auto");
    expect(await modeWith(answer({ answered: modeQuestion("elsewhere") }))).toBe("auto");
    expect(await modeWith(answer({ text: "mode auto" }))).toBe("auto");
    expect(await modeWith(answer({ id: "other" }))).toBe("auto");
    expect(resolveMode(settings({}), await withHeardFull([full], chain, async () => { throw new Error("T3 is down"); }), chain).mode).toBe("supervised");
  });

  test("a ledger row whose words do not grant its mode counts for nothing", () => {
    const forged: ModeGrant = { ...grant("full", "lane"), words: '2026-11-27 "Run the tests for full mode."' };
    expect(resolveMode(settings({ "pull-requests.mode": "auto" }), [forged], { threads: ["lane"], complete: true }).mode).toBe("auto");
  });

  test("the proof commands decide alone by the thread's grant, never by a grant the environment brings in", () => {
    const env = settings({ "pull-requests.mode": "auto", "pull-requests.threadMode": "full" });
    expect(decidesAlone(withThreadMode(env, [grant("supervised", "lane")], { threads: ["lane"], complete: true }))).toBe(false);
    expect(configuredMode(withThreadMode(env, [], { threads: ["lane"], complete: true })).mode).toBe("auto");
  });
});

describe("hedge mode", () => {
  const card = (choice: string, question: string, id = choice, at = "2026-11-27T08:00:00.000Z", where = "conductor"): ThreadWord => ({ thread: where, id, text: choice, answered: question, at, source: "question" });
  const typed = (text: string, where = "conductor"): ThreadWord => ({ thread: where, id: `t-${text}`, text, answered: "", at: "2026-11-27T08:00:00.000Z", source: "typed" });
  const context = (words: ThreadWord[], threads: ShellThread[], printed: string[]): ModeContext => {
    const home = temp.make("mode-home-");
    return { home, cwd: home, env: settings({ "pull-requests.mode": "auto", "pull-requests.repoModes": "own/strict=supervised" }), print: (text) => printed.push(text), threadWords: async (id) => words.filter((one) => one.thread === id), threads: async () => threads, repository: () => "own/tools" };
  };
  const threads = [thread("conductor"), thread("lane", "conductor"), thread("lane-2", "conductor"), thread("side-fix")];
  const set = (run: ModeContext, mode: string, choice: string, message: string, where = "conductor", target?: string) =>
    modeCommand(["set", mode, "--thread", where, "--message", message, "--words", `2026-11-27 "${choice}"`, ...target ? ["--for", target] : []], run);

  test("set records the user's answer once, and show prints it for the thread and the lanes it started", async () => {
    const printed: string[] = [];
    const run = context([card("mode full", "Which mode should thread conductor run in? The importer is ready to build.", "m1")], threads, printed);
    expect(await set(run, "full", "mode full", "m1")).toBe(0);
    expect(await set(run, "full", "mode full", "m1")).toBe(0);
    expect(printed.at(-1)).toContain("already recorded");
    const recorded = readFileSync(join(run.home, ".local/state/hedge/decisions.jsonl"), "utf8").trim().split("\n");
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]!)).toEqual(expect.objectContaining({ type: "mode", mode: "full", for: "conductor", thread: "conductor", message: "m1" }));
    await modeCommand(["show", "--thread", "lane"], run);
    expect(printed.at(-1)).toBe("Mode: Full\nfrom: inherited from thread conductor, granted 2026-11-27 in thread conductor\nlabel: mode:full");
    await modeCommand(["show", "--thread", "side-fix"], run);
    expect(printed.at(-1)).toStartWith("Mode: Auto\nfrom: the profile default");
  });

  test("typed words, an answer to another question, another option, or a missing quote switch nothing", async () => {
    const run = context([
      typed("mode full"),
      card("mode full", "Which mode should we demonstrate in the docs?", "docs"),
      card("mode full", "Which mode should thread lane run in?", "lane-card"),
      card("mode auto", "Which mode should thread conductor run in?", "auto-card"),
    ], threads, []);
    await expect(modeCommand(["set", "full", "--thread", "conductor", "--words", '2026-11-27 "mode full"', "--message", "t-mode full"], run)).rejects.toThrow("is a typed message");
    await expect(set(run, "full", "mode full", "docs")).rejects.toThrow('does not start with "Which mode should thread conductor run in?"');
    await expect(set(run, "full", "mode full", "lane-card")).rejects.toThrow('does not start with "Which mode should thread conductor run in?"');
    await expect(set(run, "full", "mode auto", "auto-card")).rejects.toThrow('not "mode full"');
    await expect(modeCommand(["set", "full", "--thread", "conductor"], run)).rejects.toThrow("only the user's answer switches a mode");
  });

  test("an answer for a lane counts only on a question that names that lane, asked in a thread that started it", async () => {
    const run = context([
      card("mode full", "Which mode should thread lane run in?", "lane-card"),
      card("mode full", "Which mode should thread lane-2 run in?", "lane-2-card"),
      card("mode supervised", "Which mode should thread side-fix run in?", "side-card"),
    ], threads, []);
    await expect(set(run, "full", "mode full", "lane-card", "conductor", "lane-2")).rejects.toThrow('does not start with "Which mode should thread lane-2 run in?"');
    await expect(set(run, "supervised", "mode supervised", "side-card", "conductor", "side-fix")).rejects.toThrow("was not started by thread conductor");
    expect(await set(run, "full", "mode full", "lane-card", "conductor", "lane")).toBe(0);
    expect(await set(run, "full", "mode full", "lane-2-card", "conductor", "lane-2")).toBe(0);
  });

  test("without --message, the same option chosen for two lanes on one day finds each lane's own card, and two cards for one lane ask for the id", async () => {
    const printed: string[] = [];
    const run = context([
      card("mode supervised", "Which mode should thread lane run in?", "lane-card", "2026-11-27T08:00:00.000Z"),
      card("mode supervised", "Which mode should thread lane-2 run in?", "lane-2-card", "2026-11-27T09:00:00.000Z"),
      card("mode supervised", "Which mode should thread conductor run in?", "conductor-1", "2026-11-27T10:00:00.000Z"),
      card("mode supervised", "Which mode should thread conductor run in?", "conductor-2", "2026-11-27T11:00:00.000Z"),
    ], threads, printed);
    const unnamed = (target: string) => modeCommand(["set", "supervised", "--thread", "conductor", "--words", '2026-11-27 "mode supervised"', "--for", target], run);
    expect(await unnamed("lane")).toBe(0);
    expect(await unnamed("lane-2")).toBe(0);
    const recorded = readFileSync(join(run.home, ".local/state/hedge/decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(recorded.map(({ for: lane, message }) => [lane, message])).toEqual([["lane", "lane-card"], ["lane-2", "lane-2-card"]]);
    await expect(unnamed("conductor")).rejects.toThrow("Pass --message with the id of the one they meant: conductor-1, conductor-2");
  });

  test("an older answer never replaces a newer grant, and an answer for one lane never blocks another", async () => {
    const printed: string[] = [];
    const run = context([
      card("mode full", "Which mode should thread conductor run in?", "early", "2026-11-27T08:00:00.000Z"),
      card("mode supervised", "Which mode should thread conductor run in?", "late", "2026-11-27T09:00:00.000Z"),
      card("mode full", "Which mode should thread lane run in?", "lane-early", "2026-11-27T07:00:00.000Z"),
      card("mode auto", "Which mode should thread lane-2 run in?", "lane-2-late", "2026-11-27T10:00:00.000Z"),
    ], threads, printed);
    expect(await set(run, "full", "mode full", "early")).toBe(0);
    expect(await set(run, "supervised", "mode supervised", "late")).toBe(0);
    expect(await set(run, "full", "mode full", "early")).toBe(0);
    expect(printed.at(-1)).toBe("Mode: Supervised for thread conductor, the answer for mode full already recorded\nlabel: mode:supervised. Put it on the thread's tracking issue in place of the other mode labels.");
    expect(await set(run, "auto", "mode auto", "lane-2-late", "conductor", "lane-2")).toBe(0);
    await expect(set(run, "full", "mode full", "lane-early", "conductor", "lane")).rejects.toThrow("newer than this one");
    await modeCommand(["show", "--thread", "lane-2"], run);
    expect(printed.at(-1)).toStartWith("Mode: Auto\nfrom: granted");
  });

  test("a card names its thread in either T3 id form", async () => {
    const run = context([card("mode full", "Which mode should thread lane run in?", "bare"), card("mode full", "Which mode should thread `t3:lane` run in?", "code")], [thread("conductor"), thread("t3:lane", "conductor")], []);
    expect(await set(run, "full", "mode full", "bare", "conductor", "t3:lane")).toBe(0);
    expect(await set(run, "full", "mode full", "code", "conductor", "lane")).toBe(0);
  });

  test("show reads the repository from the checkout's GitHub origin, with or without a trailing slash", async () => {
    for (const origin of ["https://github.com/own/strict/", "git@github.com:own/strict.git"]) {
      const printed: string[] = [];
      const { repository: _, ...run } = context([], threads, printed);
      Bun.spawnSync(["git", "init", "-q", run.cwd]);
      Bun.spawnSync(["git", "-C", run.cwd, "remote", "add", "origin", origin]);
      await modeCommand(["show", "--thread", "side-fix"], run);
      expect(printed.at(-1)).toStartWith("Mode: Supervised\nfrom: the default of own/strict");
    }
  });

  test("show takes --repo over the checkout's repository", async () => {
    const printed: string[] = [];
    const run = { ...context([], threads, printed), repository: () => "own/strict" };
    await modeCommand(["show", "--thread", "side-fix", "--repo", "own/tools"], run);
    expect(printed.at(-1)).toStartWith("Mode: Auto");
  });
});

test("the proof and decision commands drop a thread mode the environment brings in, with or without a thread", async () => {
  const home = temp.make("mode-env-");
  const env = await threadModeEnv(home, settings({ "pull-requests.mode": "supervised", "pull-requests.threadMode": "full" }), async () => []);
  expect(configuredMode(env).mode).toBe("supervised");
});
