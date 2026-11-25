import { describe, expect, test } from "bun:test";
import { graceMs, interruptGraceMs, supervise, type StopSignal, type SupervisorHost } from "./probe-supervisor.ts";

function fakeHost() {
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const handlers = new Map<StopSignal, () => void>();
  const signals: NodeJS.Signals[] = [];
  const exits: number[] = [];
  let resolveTarget!: (code: number) => void;
  let spawned = false;

  const host: SupervisorHost = {
    spawn: () => {
      spawned = true;
      return { exited: new Promise<number>((resolve) => (resolveTarget = resolve)) };
    },
    killGroup: (signal) => void signals.push(signal),
    timer: (ms, fire) => {
      const entry = { ms, fire, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    onSignal: (signal, handler) => void handlers.set(signal, handler),
    exit: (code) => void exits.push(code),
  };

  const pending = () => timers.filter((entry) => !entry.cancelled);
  const fireNext = () => {
    const next = pending()[0];
    if (!next) throw new Error("no pending timer");
    next.cancelled = true;
    next.fire();
  };

  return { host, handlers, signals, exits, pending, fireNext, exitTarget: (code: number) => resolveTarget(code), wasSpawned: () => spawned };
}

describe("probe supervisor", () => {
  for (const sig of ["SIGINT", "SIGQUIT"] as const) {
    test(`escalates ${sig} to SIGTERM after ${interruptGraceMs}ms and SIGKILL after ${graceMs}ms when the probe ignores ${sig}`, async () => {
      const fake = fakeHost();
      const done = supervise(["probe"], fake.host);
      fake.handlers.get(sig)!();

      expect(fake.signals).toEqual([]);
      expect(fake.pending().map((entry) => entry.ms)).toEqual([interruptGraceMs]);

      fake.fireNext();
      expect(fake.signals).toEqual(["SIGTERM"]);
      expect(fake.pending().map((entry) => entry.ms)).toEqual([graceMs]);

      fake.fireNext();
      expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fake.exits).toEqual([143]);

      fake.exitTarget(137);
      await done;
      expect(fake.exits).toEqual([143]);
    });
  }

  test("preserves the remaining SIGTERM grace period for descendants even after the probe leader exits early", async () => {
    const fake = fakeHost();
    const done = supervise(["probe"], fake.host);
    fake.handlers.get("SIGTERM")!();

    expect(fake.pending().map((entry) => entry.ms)).toEqual([graceMs]);
    fake.exitTarget(143);
    await done;

    expect(fake.signals).toEqual([]);
    expect(fake.exits).toEqual([]);
    expect(fake.pending().map((entry) => entry.ms)).toEqual([graceMs]);

    fake.fireNext();
    expect(fake.signals).toEqual(["SIGKILL"]);
    expect(fake.exits).toEqual([143]);
  });

  test("sends SIGTERM and keeps the grace period for descendants when a probe finishes its SIGINT trap early", async () => {
    const fake = fakeHost();
    const done = supervise(["probe"], fake.host);
    fake.handlers.get("SIGINT")!();

    expect(fake.pending().map((entry) => entry.ms)).toEqual([interruptGraceMs]);
    fake.exitTarget(130);
    await done;

    expect(fake.signals).toEqual(["SIGTERM"]);
    expect(fake.exits).toEqual([]);
    expect(fake.pending().map((entry) => entry.ms)).toEqual([graceMs]);

    fake.fireNext();
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fake.exits).toEqual([143]);
  });

  test("exits immediately with the probe exit code when no stop signal arrived", async () => {
    const fake = fakeHost();
    const done = supervise(["probe"], fake.host);
    fake.exitTarget(0);
    await done;

    expect(fake.signals).toEqual([]);
    expect(fake.pending()).toEqual([]);
    expect(fake.exits).toEqual([0]);
  });
});
