import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { humanStepsLeft } from "./apply.ts";
import { createPipe, setCloexec } from "./probe-supervisor.ts";

const temp = tempDirs();
const activeHelpers: Array<{ kill(signal?: NodeJS.Signals): void }> = [];

function manualClock() {
  const pipe = createPipe();
  if (!pipe) throw new Error("could not create clock pipe");
  setCloexec(pipe.readFd, true);
  setCloexec(pipe.writeFd, true);
  let closed = false;
  return {
    readFd: pipe.readFd,
    tick() {
      if (closed) return;
      writeSync(pipe.writeFd, "\n");
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(pipe.writeFd);
      } catch {}
      try {
        closeSync(pipe.readFd);
      } catch {}
    },
  };
}

afterEach(() => {
  for (const proc of activeHelpers.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
  temp.cleanup();
});

const applyPath = join(import.meta.dir, "apply.ts");

function probePlan(id: string, probe: string[]): Plan {
  return {
    machine: { schema: 1, role: "linux" },
    os: process.platform === "darwin" ? "darwin" : "linux",
    ai: "both",
    packs: [],
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: [],
    human: [{ id, pack: "team", say: `${id}.`, probe }],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    models: [],
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
  };
}

function fifoRead(path: string): Promise<string> {
  const proc = Bun.spawn(["cat", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  activeHelpers.push(proc);
  return new Response(proc.stdout).text();
}

async function fifoWrite(path: string, content: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", 'printf "%s" "$2" > "$1"', "writer", path, content], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  activeHelpers.push(proc);
  await proc.exited;
}

function mkfifo(...paths: string[]) {
  expect(Bun.spawnSync(["mkfifo", ...paths]).exitCode).toBe(0);
}

describe("probe supervisor", () => {
  for (const [sig, trapName] of [
    ["SIGINT", "INT"],
    ["SIGQUIT", "QUIT"],
  ] as const) {
    test(`escalates real ${sig} through SIGTERM to SIGKILL on a probe that stays alive on ${sig} and SIGTERM`, async () => {
      const dir = temp.make(`sup-esc-${trapName.toLowerCase()}-`);
      const [ready, sawStop, sawTerm, gone] = [join(dir, "ready"), join(dir, "stop"), join(dir, "term"), join(dir, "gone")];
      mkfifo(ready, sawStop, sawTerm, gone);
      const started = fifoRead(ready);
      const gotStop = fifoRead(sawStop);
      const gotTerm = fifoRead(sawTerm);
      const holderGone = fifoRead(gone);
      const probeCmd = [
        "sh",
        "-c",
        `trap 'echo stop > "$3"' ${trapName}; trap 'echo term > "$4"' TERM; exec 3>"$1"; echo $$ > "$2"; while :; do sleep 30 3>&- & wait; done`,
        "probe",
        gone,
        ready,
        sawStop,
        sawTerm,
      ];
      const clock = manualClock();
      const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(probePlan("esc", probeCmd))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 10_000, interruptGraceMs: 10_000, clockFd: 3 });`;
      setCloexec(clock.readFd, false);
      const runner = Bun.spawn([process.execPath, "-e", runnerScript], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        stdio: ["ignore", "ignore", "ignore", clock.readFd],
      });
      setCloexec(clock.readFd, true);
      let pid = 0;
      try {
        pid = Number((await started).trim());
        expect(pid).toBeGreaterThan(0);

        runner.kill(sig);
        expect((await gotStop).trim()).toBe("stop");
        clock.tick();
        expect((await gotTerm).trim()).toBe("term");
        clock.tick();
        expect(await holderGone).toBe("");
        expect(await runner.exited).not.toBe(0);
      } finally {
        clock.close();
        runner.kill("SIGKILL");
        if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
        await runner.exited.catch(() => {});
      }
    });
  }

  test("keeps a real descendant alive to finish SIGTERM cleanup after the probe leader exits early", async () => {
    const dir = temp.make("sup-grace-");
    const [ready, leaderGone, gate, cleaned, childGone] = [
      join(dir, "ready"),
      join(dir, "leader-gone"),
      join(dir, "gate"),
      join(dir, "cleaned"),
      join(dir, "child-gone"),
    ];
    mkfifo(ready, leaderGone, gate, cleaned, childGone);
    const started = fifoRead(ready);
    const leaderClosed = fifoRead(leaderGone);
    const sawCleaned = fifoRead(cleaned);
    const childClosed = fifoRead(childGone);
    const childScript = `trap 'cat ${JSON.stringify(gate)} >/dev/null; echo cleaned > ${JSON.stringify(cleaned)}; exit 0' TERM; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
    const clock = manualClock();
    let fireDeadline!: () => void;
    let childPid = 0;
    try {
      const pending = humanStepsLeft(
        probePlan("grace", ["sh", "-c", 'exec 4>"$1"; sh -c "$2" 4>&- & wait', "probe", leaderGone, childScript]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 10_000, clockFd: clock.readFd },
      );
      childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["grace"]);
      expect(res.failing).toEqual([]);
      expect(await leaderClosed).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await fifoWrite(gate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await childClosed).toBe("");
    } finally {
      clock.close();
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  });

  test("stops a descendant that ignores SIGTERM once the grace clock expires after a cooperative leader exits", async () => {
    const dir = temp.make("sup-stubborn-");
    const [ready, leaderGone, childGone] = [join(dir, "ready"), join(dir, "leader-gone"), join(dir, "child-gone")];
    mkfifo(ready, leaderGone, childGone);
    const started = fifoRead(ready);
    const leaderClosed = fifoRead(leaderGone);
    const childClosed = fifoRead(childGone);
    const childScript = `trap "" TERM; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; exec sleep 30`;
    let fireDeadline!: () => void;
    let childPid = 0;
    try {
      const pending = humanStepsLeft(
        probePlan("stubborn", ["sh", "-c", 'exec 4>"$1"; sh -c "$2" 4>&- & wait', "probe", leaderGone, childScript]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["stubborn"]);
      expect(res.failing).toEqual([]);
      expect(await leaderClosed).toBe("");
      expect(await childClosed).toBe("");
    } finally {
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  });

  test("lets both the probe leader and its descendant finish SIGINT cleanup without premature SIGTERM", async () => {
    const dir = temp.make("sup-int-");
    const [ready, leaderCleaned, childStarted, gate, childCleaned, childGone] = [
      join(dir, "ready"),
      join(dir, "leader-cleaned"),
      join(dir, "child-started"),
      join(dir, "gate"),
      join(dir, "child-cleaned"),
      join(dir, "child-gone"),
    ];
    const prematureTerm = join(dir, "premature-term");
    mkfifo(ready, leaderCleaned, childStarted, gate, childCleaned, childGone);
    const started = fifoRead(ready);
    const sawLeader = fifoRead(leaderCleaned);
    const sawChildInt = fifoRead(childStarted);
    const sawChild = fifoRead(childCleaned);
    const childClosed = fifoRead(childGone);
    const gateWriter = Bun.spawn(["sh", "-c", 'read _ && printf "go\\n" > "$1"', "gate-writer", gate], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    activeHelpers.push(gateWriter);
    const childScript = `trap 'echo got-term > ${JSON.stringify(prematureTerm)}' TERM; trap 'echo child-int > ${JSON.stringify(childStarted)}; cat ${JSON.stringify(gate)} >/dev/null; echo child-done > ${JSON.stringify(childCleaned)}; exit 0' INT; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
    const leaderScript = `import { writeFileSync } from "node:fs";
process.on("SIGINT", () => { writeFileSync(${JSON.stringify(leaderCleaned)}, "leader-done\\n"); process.exit(130); });
await Bun.spawn(["sh", "-c", ${JSON.stringify(childScript)}], { stdio: ["ignore", "ignore", "ignore"] }).exited;`;
    const clock = manualClock();
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(probePlan("int", [process.execPath, "-e", leaderScript]))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 10_000, interruptGraceMs: 10_000, clockFd: 3 });`;
    setCloexec(clock.readFd, false);
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      stdio: ["ignore", "ignore", "ignore", clock.readFd],
    });
    setCloexec(clock.readFd, true);
    let childPid = 0;
    try {
      childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      runner.kill("SIGINT");
      expect((await sawLeader).trim()).toBe("leader-done");
      expect((await sawChildInt).trim()).toBe("child-int");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(existsSync(prematureTerm)).toBe(false);

      gateWriter.stdin.write("x\n");
      gateWriter.stdin.flush();
      expect((await sawChild).trim()).toBe("child-done");
      expect(await childClosed).toBe("");
      expect(existsSync(prematureTerm)).toBe(false);
      expect(await runner.exited).not.toBe(0);
    } finally {
      clock.close();
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      runner.kill("SIGKILL");
      await runner.exited.catch(() => {});
    }
  });

  test("preserves background helpers left by a probe that exits successfully before the deadline", async () => {
    const dir = temp.make("sup-normal-preserve-");
    const [ready, gate, gone] = [join(dir, "ready"), join(dir, "gate"), join(dir, "gone")];
    mkfifo(ready, gate, gone);
    const started = fifoRead(ready);
    const holderGone = fifoRead(gone);
    const helperChild = `exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; exec sleep 30`;
    let childPid = 0;
    try {
      const pending = humanStepsLeft(
        probePlan("normal-preserve", ["sh", "-c", 'sh -c "$1" & cat "$2" >/dev/null; exit 0', "probe", helperChild, gate]),
        { home: dir, giveUp: new Promise<void>(() => {}), graceMs: 0 },
      );
      childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);
      await fifoWrite(gate, "go\n");
      expect(await pending).toEqual({ failing: [], unchecked: [] });
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      await holderGone.catch(() => {});
    }
  });

  test("kills a descendant spawned during SIGTERM cleanup when a timed-out probe is stopped", async () => {
    const dir = temp.make("sup-respawn-timeout-");
    const [ready, grandReady, grandGone] = [
      join(dir, "ready"),
      join(dir, "grand-ready"),
      join(dir, "grand-gone"),
    ];
    mkfifo(ready, grandReady, grandGone);
    const started = fifoRead(ready);
    const grandStarted = fifoRead(grandReady);
    const grandClosed = fifoRead(grandGone);
    const grandBin = join(dir, "grand.sh");
    writeFileSync(grandBin, '#!/bin/sh\ntrap "" HUP TERM\nexec 3>"$1"\necho $$ > "$2"\nexec sleep 30\n', { mode: 0o755 });
    const probeScript = `trap '${grandBin} ${grandGone} ${grandReady} & exit 0' TERM; echo $$ > ${JSON.stringify(ready)}; sleep 30 & wait`;
    const clock = manualClock();
    let fireDeadline!: () => void;
    let grandPid = 0;
    try {
      const pending = humanStepsLeft(
        probePlan("respawn-timeout", ["sh", "-c", probeScript]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 10_000, clockFd: clock.readFd },
      );
      expect(Number((await started).trim())).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((s) => s.id)).toEqual(["respawn-timeout"]);
      grandPid = Number((await grandStarted).trim());
      expect(grandPid).toBeGreaterThan(0);
      clock.tick();
      expect(await grandClosed).toBe("");
    } finally {
      clock.close();
      if (grandPid > 0) try { process.kill(grandPid, "SIGKILL"); } catch {}
    }
  });

  test("wakes and escalates a probe that suspends itself with SIGSTOP and ignores SIGTERM", async () => {
    const dir = temp.make("sup-sigstop-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    let fireDeadline!: () => void;
    let probePid = 0;
    try {
      const pending = humanStepsLeft(
        probePlan("sigstop", ["sh", "-c", 'trap "" TERM; exec 3>"$1"; echo $$ > "$2"; kill -STOP $$', "probe", gone, ready]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      probePid = Number((await started).trim());
      expect(probePid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["sigstop"]);
      expect(res.failing).toEqual([]);
      expect(await closed).toBe("");
    } finally {
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
    }
  });

  test("stops a probe whose TERM cleanup suspends its whole process group when the caller exits via SIGINT", async () => {
    const dir = temp.make("sup-watchdog-stop-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [ready, gone, trapped] = [join(dir, "ready"), join(dir, "gone"), join(dir, "trapped")];
    mkfifo(ready, gone, trapped);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const sawTrap = fifoRead(trapped);
    const probeCmd = [shBin, "-c", 'exec 3>"$1"; trap "" INT; trap \'echo trapped > "$3"; kill -STOP 0\' TERM; echo $$ > "$2"; sleep 30 & wait', "probe", gone, ready, trapped];
    const clock = manualClock();
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: process.platform === "darwin" ? "darwin" : "linux",
  ai: "both",
  packs: [], workflows: [], files: [], config: [], owners: {}, jobs: [],
  human: [{ id: "stop-self", pack: "team", say: "Stop self.", probe: ${JSON.stringify(probeCmd)} }],
  steps: [], checks: [], commands: {}, handlers: {}, models: [], settings: {}, unanswered: [], ask: [], dropped: [],
}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0, interruptGraceMs: 0, clockFd: 3 });`;
    setCloexec(clock.readFd, false);
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      stdio: ["ignore", "ignore", "ignore", clock.readFd],
    });
    setCloexec(clock.readFd, true);
    let probePid = 0;
    try {
      probePid = Number((await started).trim());
      expect(probePid).toBeGreaterThan(0);
      runner.kill("SIGINT");
      clock.tick();
      expect((await sawTrap).trim()).toBe("trapped");
      clock.tick();
      expect(await closed).toBe("");
      expect(await runner.exited).not.toBe(0);
    } finally {
      clock.close();
      runner.kill("SIGKILL");
      if (probePid > 0) {
        try { process.kill(probePid, "SIGCONT"); } catch {}
        try { process.kill(probePid, "SIGKILL"); } catch {}
      }
    }
  });

  test("kills a detached worker when the humanStepsLeft caller dies unexpectedly", async () => {
    const dir = temp.make("sup-watchdog-dead-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const detachedScript = `const c = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
c.unref();
await Bun.sleep(30_000);`;
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(probePlan("dead-caller", [process.execPath, "-e", detachedScript]))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let workerPid = 0;
    try {
      workerPid = Number((await started).trim());
      expect(workerPid).toBeGreaterThan(0);
      runner.kill("SIGKILL");
      await runner.exited;
      expect(await closed).toBe("");
    } finally {
      runner.kill("SIGKILL");
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  });

  test("leaves an intentionally detached daemon alive on normal probe exit through humanStepsLeft while still killing detached workers on deadline", async () => {
    const dir = temp.make("sup-detached-normal-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [ready, ping, pong, gone] = [join(dir, "ready"), join(dir, "ping"), join(dir, "pong"), join(dir, "gone")];
    mkfifo(ready, ping, pong, gone);
    const started = fifoRead(ready);
    const ponged = fifoRead(pong);
    const closed = fifoRead(gone);
    const daemonScript = `const c = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; read _ < "$3"; echo alive > "$4"; exec sleep 30', "daemon", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}, ${JSON.stringify(ping)}, ${JSON.stringify(pong)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
c.unref();
process.exit(0);`;
    let daemonPid = 0;
    try {
      const pending = humanStepsLeft(probePlan("normal-daemon", [process.execPath, "-e", daemonScript]), {
        home: dir,
        giveUp: new Promise<void>(() => {}),
        graceMs: 0,
      });
      daemonPid = Number((await started).trim());
      expect(daemonPid).toBeGreaterThan(0);
      expect(await pending).toEqual({ failing: [], unchecked: [] });
      await fifoWrite(ping, "check\n");
      expect((await ponged).trim()).toBe("alive");
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      await closed.catch(() => {});
    }
  });

  test("preserves helpers left by a completed probe when SIGINT cancels another still-running probe", async () => {
    const dir = temp.make("sup-post-result-sigint-");
    const [daemonReady, daemonGone, childReady, childGone, exitGate, holdReady, holdGone, afterReady] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "child-ready"),
      join(dir, "child-gone"),
      join(dir, "exit-gate"),
      join(dir, "hold-ready"),
      join(dir, "hold-gone"),
      join(dir, "after-ready"),
    ];
    mkfifo(daemonReady, daemonGone, childReady, childGone, exitGate, holdReady, holdGone, afterReady);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const childStarted = fifoRead(childReady);
    const childClosed = fifoRead(childGone);
    const holdStarted = fifoRead(holdReady);
    const holdClosed = fifoRead(holdGone);
    const afterStarted = fifoRead(afterReady);
    const daemonCmd = 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30';
    const childCmd = 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30';
    const probeScript = `const d = Bun.spawn(["sh", "-c", ${JSON.stringify(daemonCmd)}, "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
const c = Bun.spawn(["sh", "-c", ${JSON.stringify(childCmd)}, "child", ${JSON.stringify(childGone)}, ${JSON.stringify(childReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
c.unref();
await Bun.spawn(["cat", ${JSON.stringify(exitGate)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
process.exit(0);`;
    const applyPath = join(import.meta.dir, "apply.ts");
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
const extraHolds = Array.from({ length: 6 }, (_, i) => ({ id: \`hold-\${i}\`, pack: "team", say: "Hold.", probe: ["sh", "-c", "exec sleep 30"] }));
const plan = {
  machine: { schema: 1, role: "linux" },
  os: process.platform,
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [
    { id: "fast", pack: "team", say: "Fast.", probe: [process.execPath, "-e", ${JSON.stringify(probeScript)}] },
    { id: "hold", pack: "team", say: "Hold.", probe: ["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "hold", ${JSON.stringify(holdGone)}, ${JSON.stringify(holdReady)}] },
    ...extraHolds,
    { id: "after", pack: "team", say: "After.", probe: ["sh", "-c", 'echo started > "$1"; exec sleep 30', "after", ${JSON.stringify(afterReady)}] },
  ],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  models: [],
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
};
await humanStepsLeft(plan, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let daemonPid = 0;
    let childPid = 0;
    let holdPid = 0;
    try {
      [daemonPid, childPid, holdPid] = (await Promise.all([daemonStarted, childStarted, holdStarted])).map((s) => Number(s.trim())) as [number, number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(childPid).toBeGreaterThan(0);
      expect(holdPid).toBeGreaterThan(0);
      await fifoWrite(exitGate, "go\n");
      expect((await afterStarted).trim()).toBe("started");
      runner.kill("SIGINT");
      expect(await holdClosed).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      if (holdPid > 0) try { process.kill(holdPid, "SIGKILL"); } catch {}
      runner.kill("SIGKILL");
      await runner.exited.catch(() => {});
      await daemonClosed.catch(() => {});
      await childClosed.catch(() => {});
    }
  });

  test("stops a detached clean-env worker whose intermediate helper exited when a probe times out, and skips launch if a stop is already buffered", async () => {
    const dir = temp.make("sup-subreaper-buffered-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const { humanStepsLeft } = await import("./apply.ts");
    if (process.platform === "linux") {
      const [workerReady, workerGone] = [join(dir, "worker-ready"), join(dir, "worker-gone")];
      mkfifo(workerReady, workerGone);
      const started = fifoRead(workerReady);
      const closed = fifoRead(workerGone);
      const helperScript = `const w = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(workerGone)}, ${JSON.stringify(workerReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
process.exit(0);`;
      const probeScript = `const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await h.exited;
await Bun.sleep(30_000);`;
      let fireDeadline!: () => void;
      let workerPid = 0;
      try {
        const pending = humanStepsLeft(
          {
            machine: { schema: 1, role: "linux" },
            os: "linux",
            ai: "both",
            packs: [],
            workflows: [],
            files: [],
            config: [],
            owners: {},
            jobs: [],
            human: [{ id: "escaped", pack: "team", say: "Escaped.", probe: [process.execPath, "-e", probeScript] }],
            steps: [],
            checks: [],
            commands: {},
            handlers: {},
            models: [],
            settings: {},
            unanswered: [],
            ask: [],
            dropped: [],
          },
          { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
        );
        workerPid = Number((await started).trim());
        expect(workerPid).toBeGreaterThan(0);
        fireDeadline();
        const res = await pending;
        expect(res.unchecked.map((step) => step.id)).toEqual(["escaped"]);
        expect(await closed).toBe("");
      } finally {
        if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      }
    }

    const marker = join(dir, "ran-marker");
    const preAborted = await humanStepsLeft(
      {
        machine: { schema: 1, role: "linux" },
        os: process.platform === "darwin" ? "darwin" : "linux",
        ai: "both",
        packs: [],
        workflows: [],
        files: [],
        config: [],
        owners: {},
        jobs: [],
        human: [{ id: "pre-aborted", pack: "team", say: "Pre-aborted.", probe: [shBin, "-c", `echo ran > ${JSON.stringify(marker)}`] }],
        steps: [],
        checks: [],
        commands: {},
        handlers: {},
        models: [],
        settings: {},
        unanswered: [],
        ask: [],
        dropped: [],
      },
      { home: dir, giveUp: Promise.resolve(), graceMs: 0 },
    );
    expect(preAborted.unchecked.map((step) => step.id)).toEqual(["pre-aborted"]);
    expect(await Bun.file(marker).exists()).toBe(false);

    const usr1Res = await humanStepsLeft(
      {
        machine: { schema: 1, role: "linux" },
        os: "linux",
        ai: "both",
        packs: [],
        workflows: [],
        files: [],
        config: [],
        owners: {},
        jobs: [],
        human: [{ id: "usr1", pack: "team", say: "USR1.", probe: [shBin, "-c", "trap 'exit 0' USR1; kill -USR1 0"] }],
        steps: [],
        checks: [],
        commands: {},
        handlers: {},
        models: [],
        settings: {},
        unanswered: [],
        ask: [],
        dropped: [],
      },
      { home: dir, giveUp: new Promise<void>(() => {}) },
    );
    expect(usr1Res).toEqual({ failing: [], unchecked: [] });
  });

  test("stops a detached worker with oversized argv and a detached clean-env child on deadline while sparing unrelated processes", async () => {
    const dir = temp.make("sup-real-detached-tag-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [unrelatedReady, unrelatedGone, taggedReady, taggedGone, cleanReady, cleanGone] = [
      join(dir, "unrelated-ready"),
      join(dir, "unrelated-gone"),
      join(dir, "tagged-ready"),
      join(dir, "tagged-gone"),
      join(dir, "clean-ready"),
      join(dir, "clean-gone"),
    ];
    mkfifo(unrelatedReady, unrelatedGone, taggedReady, taggedGone, cleanReady, cleanGone);
    const unrelatedStarted = fifoRead(unrelatedReady);
    const unrelatedClosed = fifoRead(unrelatedGone);
    const taggedStarted = fifoRead(taggedReady);
    const taggedClosed = fifoRead(taggedGone);
    const cleanStarted = fifoRead(cleanReady);
    const cleanClosed = fifoRead(cleanGone);
    const unrelated = Bun.spawn(
      [shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; sleep 30 3>&- & wait', "unrelated", unrelatedGone, unrelatedReady],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const largeArg = "x".repeat(70_000);
    const probeScript = `const tagged = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; sleep 30 3>&- & wait', "tagged", ${JSON.stringify(taggedGone)}, ${JSON.stringify(taggedReady)}, ${JSON.stringify(largeArg)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
tagged.unref();
const clean = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "clean", ${JSON.stringify(cleanGone)}, ${JSON.stringify(cleanReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
clean.unref();
process.on("SIGTERM", () => process.exit(0));
await Bun.sleep(30_000);`;
    let fireDeadline!: () => void;
    let unrelatedPid = 0;
    let taggedPid = 0;
    let cleanPid = 0;
    try {
      const pending = humanStepsLeft(probePlan("oversized-clean", [process.execPath, "-e", probeScript]), {
        home: dir,
        giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)),
        graceMs: 0,
      });
      [unrelatedPid, taggedPid, cleanPid] = (await Promise.all([unrelatedStarted, taggedStarted, cleanStarted])).map((s) => Number(s.trim())) as [number, number, number];
      expect(unrelatedPid).toBeGreaterThan(0);
      expect(taggedPid).toBeGreaterThan(0);
      expect(cleanPid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((s) => s.id)).toEqual(["oversized-clean"]);
      expect(await taggedClosed).toBe("");
      expect(await cleanClosed).toBe("");
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
    } finally {
      if (unrelatedPid > 0) try { process.kill(unrelatedPid, "SIGKILL"); } catch {}
      if (taggedPid > 0) try { process.kill(taggedPid, "SIGKILL"); } catch {}
      if (cleanPid > 0) try { process.kill(cleanPid, "SIGKILL"); } catch {}
      unrelated.kill("SIGKILL");
      await unrelatedClosed.catch(() => {});
    }
  });

  test("preserves an intentionally detached daemon on immediate SIGINT after normal probe exit through humanStepsLeft", async () => {
    const dir = temp.make("sup-human-sigint-daemon-");
    const [daemonReady, daemonGone, probeDone, holdReady, holdGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "probe-done"),
      join(dir, "hold-ready"),
      join(dir, "hold-gone"),
    ];
    mkfifo(daemonReady, daemonGone, probeDone, holdReady, holdGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const finished = fifoRead(probeDone);
    const holdStarted = fifoRead(holdReady);
    const holdClosed = fifoRead(holdGone);
    const daemonScript = `const c = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
c.unref();
process.exit(0);`;
    const applyPath = join(import.meta.dir, "apply.ts");
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
const extraHolds = Array.from({ length: 6 }, (_, i) => ({ id: \`hold-extra-\${i}\`, pack: "team", say: "Hold.", probe: ["sh", "-c", "exec sleep 30"] }));
await humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: process.platform,
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [
    { id: "fast", pack: "team", say: "Fast.", probe: [process.execPath, "-e", ${JSON.stringify(daemonScript)}] },
    { id: "hold", pack: "team", say: "Hold.", probe: ["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "hold", ${JSON.stringify(holdGone)}, ${JSON.stringify(holdReady)}] },
    ...extraHolds,
    { id: "after-fast", pack: "team", say: "After fast.", probe: ["sh", "-c", 'echo done > "$1"; exec sleep 30', "after", ${JSON.stringify(probeDone)}] },
  ],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  models: [],
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let daemonPid = 0;
    let holdPid = 0;
    try {
      [daemonPid, holdPid] = (await Promise.all([daemonStarted, holdStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(holdPid).toBeGreaterThan(0);
      expect((await finished).trim()).toBe("done");
      runner.kill("SIGINT");
      await runner.exited;
      expect(await holdClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (holdPid > 0) try { process.kill(holdPid, "SIGKILL"); } catch {}
      runner.kill("SIGKILL");
      await runner.exited.catch(() => {});
      await daemonClosed.catch(() => {});
    }
  });

  test("stops an abandoned nested capture command when its helper dies early", async () => {
    const dir = temp.make("sup-abandoned-nested-capture-");
    const [cmdReady, cmdGone, helperPidFile] = [join(dir, "cmd-ready"), join(dir, "cmd-gone"), join(dir, "helper-pid")];
    mkfifo(cmdReady, cmdGone, helperPidFile);
    const cmdStarted = fifoRead(cmdReady);
    const cmdClosed = fifoRead(cmdGone);
    const helperStarted = fifoRead(helperPidFile);
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const { humanStepsLeft } = await import("./apply.ts");
    const helperScript = `import { capture } from ${JSON.stringify(coderPath)};
await Bun.write(${JSON.stringify(helperPidFile)}, String(process.pid) + "\\n");
await capture(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "nested", ${JSON.stringify(cmdGone)}, ${JSON.stringify(cmdReady)}], { timeoutMs: 30_000 });`;
    const probeScript = `const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await h.exited;
await Bun.sleep(30_000);`;
    let fireDeadline!: () => void;
    let helperPid = 0;
    let cmdPid = 0;
    try {
      const pending = humanStepsLeft(
        {
          machine: { schema: 1, role: "linux" },
          os: process.platform === "darwin" ? "darwin" : "linux",
          ai: "both",
          packs: [],
          workflows: [],
          files: [],
          config: [],
          owners: {},
          jobs: [],
          human: [{ id: "abandoned", pack: "team", say: "Abandoned.", probe: [process.execPath, "-e", probeScript] }],
          steps: [],
          checks: [],
          commands: {},
          handlers: {},
          models: [],
          settings: {},
          unanswered: [],
          ask: [],
          dropped: [],
        },
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      [helperPid, cmdPid] = (await Promise.all([helperStarted, cmdStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(helperPid).toBeGreaterThan(0);
      expect(cmdPid).toBeGreaterThan(0);
      process.kill(helperPid, "SIGKILL");
      expect(await cmdClosed).toBe("");
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["abandoned"]);
    } finally {
      if (helperPid > 0) try { process.kill(helperPid, "SIGKILL"); } catch {}
      if (cmdPid > 0) try { process.kill(cmdPid, "SIGKILL"); } catch {}
    }
  });

  test("preserves a detached daemon left by a completed nested capture when the outer probe times out", async () => {
    const dir = temp.make("sup-nested-capture-daemon-");
    const [daemonReady, daemonGone, probeReady, probeGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "probe-ready"),
      join(dir, "probe-gone"),
    ];
    mkfifo(daemonReady, daemonGone, probeReady, probeGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const probeStarted = fifoRead(probeReady);
    const probeClosed = fifoRead(probeGone);
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const { humanStepsLeft } = await import("./apply.ts");
    const daemonScript = `const d = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const slow = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "slow", ${JSON.stringify(probeGone)}, ${JSON.stringify(probeReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await slow.exited;`;
    let fireDeadline!: () => void;
    let daemonPid = 0;
    let probePid = 0;
    try {
      const pending = humanStepsLeft(
        {
          machine: { schema: 1, role: "linux" },
          os: process.platform === "darwin" ? "darwin" : "linux",
          ai: "both",
          packs: [],
          workflows: [],
          files: [],
          config: [],
          owners: {},
          jobs: [],
          human: [{ id: "cert", pack: "team", say: "Cert.", probe: [process.execPath, "-e", probeScript] }],
          steps: [],
          checks: [],
          commands: {},
          handlers: {},
          models: [],
          settings: {},
          unanswered: [],
          ask: [],
          dropped: [],
        },
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      [daemonPid, probePid] = (await Promise.all([daemonStarted, probeStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(probePid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["cert"]);
      expect(await probeClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("preserves a surviving worker whose detached session leader exited after a completed nested capture", async () => {
    const dir = temp.make("sup-nested-capture-reparented-");
    const [workerReady, workerGone, probeReady, probeGone] = [
      join(dir, "worker-ready"),
      join(dir, "worker-gone"),
      join(dir, "probe-ready"),
      join(dir, "probe-gone"),
    ];
    mkfifo(workerReady, workerGone, probeReady, probeGone);
    const workerStarted = fifoRead(workerReady);
    const workerClosed = fifoRead(workerGone);
    const probeStarted = fifoRead(probeReady);
    const probeClosed = fifoRead(probeGone);
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const { humanStepsLeft } = await import("./apply.ts");
    const leaderScript = `const w = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(workerGone)}, ${JSON.stringify(workerReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
process.exit(0);`;
    const daemonScript = `const leader = Bun.spawn([process.execPath, "-e", ${JSON.stringify(leaderScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await leader.exited;
process.exit(0);`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const slow = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "slow", ${JSON.stringify(probeGone)}, ${JSON.stringify(probeReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await slow.exited;`;
    let fireDeadline!: () => void;
    let workerPid = 0;
    let probePid = 0;
    try {
      const pending = humanStepsLeft(
        {
          machine: { schema: 1, role: "linux" },
          os: process.platform === "darwin" ? "darwin" : "linux",
          ai: "both",
          packs: [],
          workflows: [],
          files: [],
          config: [],
          owners: {},
          jobs: [],
          human: [{ id: "cert", pack: "team", say: "Cert.", probe: [process.execPath, "-e", probeScript] }],
          steps: [],
          checks: [],
          commands: {},
          handlers: {},
          models: [],
          settings: {},
          unanswered: [],
          ask: [],
          dropped: [],
        },
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      [workerPid, probePid] = (await Promise.all([workerStarted, probeStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(workerPid).toBeGreaterThan(0);
      expect(probePid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["cert"]);
      expect(await probeClosed).toBe("");
      expect(() => process.kill(workerPid, 0)).not.toThrow();
    } finally {
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
      await workerClosed.catch(() => {});
    }
  });

  test("preserves a detached env -i daemon left by a completed nested capture when the outer probe times out", async () => {
    const dir = temp.make("sup-nested-capture-envi-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [daemonReady, daemonGone, probeReady, probeGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "probe-ready"),
      join(dir, "probe-gone"),
    ];
    mkfifo(daemonReady, daemonGone, probeReady, probeGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const probeStarted = fifoRead(probeReady);
    const probeClosed = fifoRead(probeGone);
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const { humanStepsLeft } = await import("./apply.ts");
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const slow = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "slow", ${JSON.stringify(probeGone)}, ${JSON.stringify(probeReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await slow.exited;`;
    let fireDeadline!: () => void;
    let daemonPid = 0;
    let probePid = 0;
    try {
      const pending = humanStepsLeft(
        {
          machine: { schema: 1, role: "linux" },
          os: process.platform === "darwin" ? "darwin" : "linux",
          ai: "both",
          packs: [],
          workflows: [],
          files: [],
          config: [],
          owners: {},
          jobs: [],
          human: [{ id: "cert", pack: "team", say: "Cert.", probe: [process.execPath, "-e", probeScript] }],
          steps: [],
          checks: [],
          commands: {},
          handlers: {},
          models: [],
          settings: {},
          unanswered: [],
          ask: [],
          dropped: [],
        },
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      [daemonPid, probePid] = (await Promise.all([daemonStarted, probeStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(probePid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["cert"]);
      expect(await probeClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("keeps a completed nested capture's detached env -i worker alive and exits cleanly even when TMPDIR is a FIFO", async () => {
    const dir = temp.make("sup-unusable-tmpdir-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const badTmp = join(dir, "tmp-fifo");
    mkfifo(badTmp);
    const [daemonReady, daemonGone, probeReady, probeGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "probe-ready"),
      join(dir, "probe-gone"),
    ];
    mkfifo(daemonReady, daemonGone, probeReady, probeGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const probeStarted = fifoRead(probeReady);
    const probeClosed = fifoRead(probeGone);
    const applyPath = join(import.meta.dir, "apply.ts");
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const slow = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "slow", ${JSON.stringify(probeGone)}, ${JSON.stringify(probeReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await slow.exited;`;
    const listScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
let fireDeadline;
const pending = humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: process.platform === "darwin" ? "darwin" : "linux",
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [{ id: "bad-tmp-probe", pack: "team", say: "Bad tmp.", probe: [process.execPath, "-e", ${JSON.stringify(probeScript)}] }],
  steps: [], checks: [], commands: {}, handlers: {}, models: [], settings: {}, unanswered: [], ask: [], dropped: [],
}, { home: ${JSON.stringify(dir)}, giveUp: new Promise((resolve) => (fireDeadline = resolve)), graceMs: 0 });
await Bun.spawn(["cat", ${JSON.stringify(join(dir, "trigger"))}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
fireDeadline();
const res = await pending;
console.log(JSON.stringify(res.unchecked.map((s) => s.id)));`;
    const triggerFifo = join(dir, "trigger");
    mkfifo(triggerFifo);
    const child = Bun.spawn([process.execPath, "-e", listScript], {
      env: { ...process.env, TMPDIR: badTmp },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    let daemonPid = 0;
    let probePid = 0;
    try {
      [daemonPid, probePid] = (await Promise.all([daemonStarted, probeStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(probePid).toBeGreaterThan(0);
      await fifoWrite(triggerFifo, "go\n");
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual(["bad-tmp-probe"]);
      expect(await probeClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
      child.kill("SIGKILL");
      await daemonClosed.catch(() => {});
    }
  });

  test("marks real subprocess probes unchecked when they exit 0 or nonzero only after the deadline fires", async () => {
    const dir = temp.make("sup-post-deadline-exit-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const { humanStepsLeft } = await import("./apply.ts");
    const [okReady, failReady, okExited, failExited] = [
      join(dir, "ok-ready"),
      join(dir, "fail-ready"),
      join(dir, "ok-exited"),
      join(dir, "fail-exited"),
    ];
    mkfifo(okReady, failReady, okExited, failExited);
    const okStarted = fifoRead(okReady);
    const failStarted = fifoRead(failReady);
    const okDone = fifoRead(okExited);
    const failDone = fifoRead(failExited);
    let fireDeadline!: () => void;
    const pending = humanStepsLeft(
      {
        machine: { schema: 1, role: "linux" },
        os: process.platform === "darwin" ? "darwin" : "linux",
        ai: "both",
        packs: [],
        workflows: [],
        files: [],
        config: [],
        owners: {},
        jobs: [],
        human: [
          { id: "late-ok", pack: "team", say: "Late ok.", probe: [shBin, "-c", 'trap \'echo ok > "$2"; exit 0\' TERM; echo ready > "$1"; sleep 30 & wait', "ok", okReady, okExited] },
          { id: "late-fail", pack: "team", say: "Late fail.", probe: [shBin, "-c", 'trap \'echo fail > "$2"; exit 7\' TERM; echo ready > "$1"; sleep 30 & wait', "fail", failReady, failExited] },
        ],
        steps: [],
        checks: [],
        commands: {},
        handlers: {},
        models: [],
        settings: {},
        unanswered: [],
        ask: [],
        dropped: [],
      },
      { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 300 },
    );
    await Promise.all([okStarted, failStarted]);
    fireDeadline();
    const res = await pending;
    expect(res.failing).toEqual([]);
    expect(res.unchecked.map((step) => step.id)).toEqual(["late-ok", "late-fail"]);
    expect((await okDone).trim()).toBe("ok");
    expect((await failDone).trim()).toBe("fail");
  });

  test("forwards a __proto__ environment variable to supervised probes", async () => {
    const dir = temp.make("sup-proto-env-");
    const applyPath = join(import.meta.dir, "apply.ts");
    const script = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
const res = await humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: process.platform,
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [
    {
      id: "proto",
      pack: "team",
      say: "Proto.",
      probe: [process.execPath, "-e", 'process.exit(Object.getOwnPropertyDescriptor(process.env, "__proto__")?.value === "keep-proto" ? 0 : 1)'],
    },
  ],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  models: [],
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}) });
process.exit(res.failing.length === 0 && res.unchecked.length === 0 ? 0 : 1);`;
    const env: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env["__proto__"] = "keep-proto";
    const child = Bun.spawn([process.execPath, "-e", script], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
  });

  test("kills a same-session clean-env worker when the humanStepsLeft caller dies unexpectedly", async () => {
    const dir = temp.make("sup-watchdog-dead-envi-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const probeScript = `const w = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
await Bun.sleep(30_000);`;
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(probePlan("dead-envi", [process.execPath, "-e", probeScript]))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let workerPid = 0;
    try {
      workerPid = Number((await started).trim());
      expect(workerPid).toBeGreaterThan(0);
      runner.kill("SIGKILL");
      await runner.exited;
      expect(await closed).toBe("");
    } finally {
      runner.kill("SIGKILL");
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  });

  test("preserves an inner completed capture's detached env -i worker when an enclosing capture is cancelled by a probe deadline", async () => {
    const dir = temp.make("sup-nested-enclosing-capture-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [daemonReady, daemonGone, outerReady, outerGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "outer-ready"),
      join(dir, "outer-gone"),
    ];
    mkfifo(daemonReady, daemonGone, outerReady, outerGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const outerStarted = fifoRead(outerReady);
    const outerClosed = fifoRead(outerGone);
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const { humanStepsLeft } = await import("./apply.ts");
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const outerScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const hold = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "outer", ${JSON.stringify(outerGone)}, ${JSON.stringify(outerReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await hold.exited;`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
await capture([process.execPath, "-e", ${JSON.stringify(outerScript)}], { timeoutMs: 30_000 });`;
    let fireDeadline!: () => void;
    let daemonPid = 0;
    let outerPid = 0;
    try {
      const pending = humanStepsLeft(
        {
          machine: { schema: 1, role: "linux" },
          os: process.platform === "darwin" ? "darwin" : "linux",
          ai: "both",
          packs: [],
          workflows: [],
          files: [],
          config: [],
          owners: {},
          jobs: [],
          human: [{ id: "enclosing", pack: "team", say: "Enclosing.", probe: [process.execPath, "-e", probeScript] }],
          steps: [],
          checks: [],
          commands: {},
          handlers: {},
          models: [],
          settings: {},
          unanswered: [],
          ask: [],
          dropped: [],
        },
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 0 },
      );
      [daemonPid, outerPid] = (await Promise.all([daemonStarted, outerStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(outerPid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["enclosing"]);
      expect(await outerClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (outerPid > 0) try { process.kill(outerPid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("kills an adopted detached env -i worker when the Linux humanStepsLeft caller dies unexpectedly", async () => {
    if (process.platform !== "linux") return;
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const dir = temp.make("sup-sigkill-adopted-");
    const [workerReady, workerGone, helperDone] = [join(dir, "worker-ready"), join(dir, "worker-gone"), join(dir, "helper-done")];
    mkfifo(workerReady, workerGone, helperDone);
    const started = fifoRead(workerReady);
    const closed = fifoRead(workerGone);
    const adopted = fifoRead(helperDone);
    const helperScript = `const w = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(workerGone)}, ${JSON.stringify(workerReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
process.exit(0);`;
    const probeScript = `const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await h.exited;
await Bun.write(${JSON.stringify(helperDone)}, "done\\n");
await Bun.sleep(30_000);`;
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(probePlan("adopted", [process.execPath, "-e", probeScript]))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let workerPid = 0;
    try {
      const [rawWorker, rawDone] = await Promise.all([started, adopted]);
      workerPid = Number(rawWorker.trim());
      expect(workerPid).toBeGreaterThan(0);
      expect(rawDone.trim()).toBe("done");
      runner.kill("SIGKILL");
      await runner.exited;
      expect(await closed).toBe("");
    } finally {
      runner.kill("SIGKILL");
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  });

  test("preserves a spared env -i worker during stalled capture fallback and on SIGINT watchdog handoff through humanStepsLeft", async () => {
    const dir = temp.make("sup-stalled-capture-spare-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [daemonReady, daemonGone, outerReady, outerGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "outer-ready"),
      join(dir, "outer-gone"),
    ];
    mkfifo(daemonReady, daemonGone, outerReady, outerGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const outerStarted = fifoRead(outerReady);
    const outerClosed = fifoRead(outerGone);
    const { captureWith, timedOut } = await import("../../packs/hub/lib/coder.ts");
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const outerScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  timeoutMs: 5_000,
});
if (res.code !== 0) process.exit(2);
const hold = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "outer", ${JSON.stringify(outerGone)}, ${JSON.stringify(outerReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await hold.exited;`;
    let fireTimeout!: () => void;
    let daemonPid = 0;
    let outerPid = 0;
    try {
      const capture = captureWith((_ms, fire) => {
        fireTimeout = fire;
        return () => {};
      }, 0);
      const running = capture([process.execPath, "-e", outerScript], {
        timeoutMs: 30_000,
      });
      [daemonPid, outerPid] = (await Promise.all([daemonStarted, outerStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(outerPid).toBeGreaterThan(0);
      fireTimeout();
      const result = await running;
      expect(result.code).toBe(timedOut);
      expect(await outerClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (outerPid > 0) try { process.kill(outerPid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }

    const intDir = temp.make("sup-sigint-spared-watchdog-");
    const [sparedReady, sparedGone, holdReady, holdGone] = [
      join(intDir, "spared-ready"),
      join(intDir, "spared-gone"),
      join(intDir, "hold-ready"),
      join(intDir, "hold-gone"),
    ];
    mkfifo(sparedReady, sparedGone, holdReady, holdGone);
    const sparedStarted = fifoRead(sparedReady);
    const sparedClosed = fifoRead(sparedGone);
    const holdStarted = fifoRead(holdReady);
    const holdClosed = fifoRead(holdGone);
    const applyPath = join(import.meta.dir, "apply.ts");
    const intDaemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "spared", ${JSON.stringify(sparedGone)}, ${JSON.stringify(sparedReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const intProbeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(intDaemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const hold = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "hold", ${JSON.stringify(holdGone)}, ${JSON.stringify(holdReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await hold.exited;`;
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: process.platform === "darwin" ? "darwin" : "linux",
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [{ id: "int-spare", pack: "team", say: "Int spare.", probe: [process.execPath, "-e", ${JSON.stringify(intProbeScript)}] }],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  models: [],
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
}, { home: ${JSON.stringify(intDir)}, giveUp: new Promise(() => {}), graceMs: 0 });`;
    const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let sparedPid = 0;
    let holdPid = 0;
    try {
      [sparedPid, holdPid] = (await Promise.all([sparedStarted, holdStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(sparedPid).toBeGreaterThan(0);
      expect(holdPid).toBeGreaterThan(0);
      runner.kill("SIGINT");
      await runner.exited;
      expect(await holdClosed).toBe("");
      expect(() => process.kill(sparedPid, 0)).not.toThrow();
    } finally {
      if (sparedPid > 0) try { process.kill(sparedPid, "SIGKILL"); } catch {}
      if (holdPid > 0) try { process.kill(holdPid, "SIGKILL"); } catch {}
      runner.kill("SIGKILL");
      await runner.exited.catch(() => {});
      await sparedClosed.catch(() => {});
    }
  });

  test("preserves a nested completed capture's detached env -i worker when a standalone outer capture times out", async () => {
    const dir = temp.make("sup-standalone-capture-spare-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [daemonReady, daemonGone, outerReady, outerGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "outer-ready"),
      join(dir, "outer-gone"),
    ];
    mkfifo(daemonReady, daemonGone, outerReady, outerGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const outerStarted = fifoRead(outerReady);
    const outerClosed = fifoRead(outerGone);
    const { captureWith, timedOut } = await import("../../packs/hub/lib/coder.ts");
    const { spareEnvVar } = await import("./probe-supervisor.ts");
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const outerScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const hold = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "outer", ${JSON.stringify(outerGone)}, ${JSON.stringify(outerReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await hold.exited;`;
    let fireTimeout!: () => void;
    let daemonPid = 0;
    let outerPid = 0;
    try {
      const cleanEnv: Record<string, string | undefined> = { ...process.env };
      delete cleanEnv[spareEnvVar];
      const capture = captureWith((_ms, fire) => {
        fireTimeout = fire;
        return () => {};
      }, 0);
      const running = capture([process.execPath, "-e", outerScript], {
        env: cleanEnv,
        timeoutMs: 30_000,
      });
      [daemonPid, outerPid] = (await Promise.all([daemonStarted, outerStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(outerPid).toBeGreaterThan(0);
      fireTimeout();
      const result = await running;
      expect(result.code).toBe(timedOut);
      expect(await outerClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (outerPid > 0) try { process.kill(outerPid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("preserves same-session helpers on normal probe exit while stopping separate-group helpers on timeout", async () => {
    const dir = temp.make("sup-separate-pgid-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [helperReady, helperGone, exitGate] = [
      join(dir, "helper-ready"),
      join(dir, "helper-gone"),
      join(dir, "exit-gate"),
    ];
    mkfifo(helperReady, helperGone, exitGate);
    const helperStarted = fifoRead(helperReady);
    const helperClosed = fifoRead(helperGone);
    const helperScript = `import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
if (lib.symbols.setpgid(0, 0) !== 0) process.exit(2);
const c = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "helper", ${JSON.stringify(helperGone)}, ${JSON.stringify(helperReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await c.exited;`;
    const probeScript = `const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
h.unref();
await Bun.spawn(["cat", ${JSON.stringify(exitGate)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
process.exit(0);`;
    let helperPid = 0;
    try {
      const pending = humanStepsLeft(probePlan("helper-ok", [process.execPath, "-e", probeScript]), {
        home: dir,
        giveUp: new Promise<void>(() => {}),
        graceMs: 0,
      });
      helperPid = Number((await helperStarted).trim());
      expect(helperPid).toBeGreaterThan(0);
      await fifoWrite(exitGate, "go\n");
      expect(await pending).toEqual({ failing: [], unchecked: [] });
      expect(() => process.kill(helperPid, 0)).not.toThrow();
    } finally {
      if (helperPid > 0) try { process.kill(helperPid, "SIGKILL"); } catch {}
      await helperClosed.catch(() => {});
    }

    const dir2 = temp.make("sup-separate-pgid-timeout-");
    const [tReady, tGone] = [join(dir2, "t-ready"), join(dir2, "t-gone")];
    mkfifo(tReady, tGone);
    const tStarted = fifoRead(tReady);
    const tClosed = fifoRead(tGone);
    const timeoutHelperScript = `import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
if (lib.symbols.setpgid(0, 0) !== 0) process.exit(2);
const c = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "helper", ${JSON.stringify(tGone)}, ${JSON.stringify(tReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await c.exited;`;
    const timeoutProbeScript = `const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(timeoutHelperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await h.exited;`;
    let fireDeadline!: () => void;
    let tPid = 0;
    try {
      const pending2 = humanStepsLeft(probePlan("helper-timeout", [process.execPath, "-e", timeoutProbeScript]), {
        home: dir2,
        giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)),
        graceMs: 0,
      });
      tPid = Number((await tStarted).trim());
      expect(tPid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending2;
      expect(res.unchecked.map((s) => s.id)).toEqual(["helper-timeout"]);
      expect(await tClosed).toBe("");
    } finally {
      if (tPid > 0) try { process.kill(tPid, "SIGKILL"); } catch {}
    }
  });

  test("preserves a completed probe's spared nested capture helper when a concurrent probe is cancelled", async () => {
    const dir = temp.make("sup-spare-concurrent-cancel-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const [daemonReady, daemonGone, queuedReady, holdReady, holdGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "queued-ready"),
      join(dir, "hold-ready"),
      join(dir, "hold-gone"),
    ];
    mkfifo(daemonReady, daemonGone, queuedReady, holdReady, holdGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const queuedStarted = fifoRead(queuedReady);
    const holdStarted = fifoRead(holdReady);
    const holdClosed = fifoRead(holdGone);
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const firstProbe = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
process.exit(res.code === 0 ? 0 : 2);`;
    const holdProbe = `${shBin} -c 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30' hold ${JSON.stringify(holdGone)} ${JSON.stringify(holdReady)}`;
    const idleProbe = [shBin, "-c", "exec sleep 30"];
    const queuedProbe = [shBin, "-c", 'echo ok > "$1"; exec sleep 30', "queued", queuedReady];
    const plan: Plan = {
      ...probePlan("first", [process.execPath, "-e", firstProbe]),
      human: [
        { id: "first", pack: "team", say: "First.", probe: [process.execPath, "-e", firstProbe] },
        { id: "second", pack: "team", say: "Second.", probe: [shBin, "-c", holdProbe] },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `hold-${i + 3}`, pack: "team", say: `Hold ${i + 3}.`, probe: idleProbe })),
        { id: "queued", pack: "team", say: "Queued.", probe: queuedProbe },
      ],
    };
    let fireDeadline!: () => void;
    let daemonPid = 0;
    let holdPid = 0;
    try {
      const pending = humanStepsLeft(plan, {
        home: dir,
        giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)),
        graceMs: 0,
      });
      [daemonPid, holdPid] = (await Promise.all([daemonStarted, holdStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(await queuedStarted).toBe("ok\n");
      fireDeadline();
      const res = await pending;
      expect(res.failing).toEqual([]);
      expect(res.unchecked.map((s) => s.id)).toEqual(["second", "hold-3", "hold-4", "hold-5", "hold-6", "hold-7", "hold-8", "queued"]);
      expect(await holdClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (holdPid > 0) try { process.kill(holdPid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("lets a surviving background helper run a second capture after the enclosing capture returns and preserves its daemon on outer timeout", async () => {
    const dir = temp.make("sup-post-return-nested-capture-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const [daemonReady, daemonGone, innerReady, midReturned, helperDone, outerHoldReady, outerHoldGone] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "inner-ready"),
      join(dir, "mid-returned"),
      join(dir, "helper-done"),
      join(dir, "outer-hold-ready"),
      join(dir, "outer-hold-gone"),
    ];
    mkfifo(daemonReady, daemonGone, innerReady, midReturned, helperDone, outerHoldReady, outerHoldGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const outerHoldStarted = fifoRead(outerHoldReady);
    const outerHoldClosed = fifoRead(outerHoldGone);
    const daemonScript = `const d = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
process.exit(0);`;
    const helperScript = `import { capture } from ${JSON.stringify(coderPath)};
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(innerReady)}, "ready\\n");
await Bun.spawn(["cat", ${JSON.stringify(midReturned)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
try {
  const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonScript)}], { timeoutMs: 5_000 });
  writeFileSync(${JSON.stringify(helperDone)}, String(res.code) + "\\n");
} catch (error) {
  writeFileSync(${JSON.stringify(helperDone)}, "err:" + String(error) + "\\n");
}`;
    const middleScript = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(helperScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
child.unref();
await Bun.spawn(["cat", ${JSON.stringify(innerReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
process.exit(0);`;
    const outerScript = `import { capture } from ${JSON.stringify(coderPath)};
import { writeFileSync } from "node:fs";
const mid = await capture([process.execPath, "-e", ${JSON.stringify(middleScript)}], { timeoutMs: 5_000 });
if (mid.code !== 0) process.exit(2);
writeFileSync(${JSON.stringify(midReturned)}, "go\\n");
const helperOut = await new Response(Bun.spawn(["cat", ${JSON.stringify(helperDone)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout).text();
if (helperOut.trim() !== "0") process.exit(3);
const hold = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "outer-hold", ${JSON.stringify(outerHoldGone)}, ${JSON.stringify(outerHoldReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await hold.exited;`;
    let fireTimeout!: () => void;
    let daemonPid = 0;
    let outerHoldPid = 0;
    try {
      const { captureWith, timedOut } = await import("../../packs/hub/lib/coder.ts");
      const { spareEnvVar } = await import("./probe-supervisor.ts");
      const cleanEnv: Record<string, string | undefined> = { ...process.env };
      delete cleanEnv[spareEnvVar];
      const capture = captureWith((_ms, fire) => {
        fireTimeout = fire;
        return () => {};
      }, 0);
      const running = capture([process.execPath, "-e", outerScript], { env: cleanEnv, timeoutMs: 30_000 });
      [daemonPid, outerHoldPid] = (await Promise.all([daemonStarted, outerHoldStarted])).map((s) => Number(s.trim())) as [number, number];
      expect(daemonPid).toBeGreaterThan(0);
      expect(outerHoldPid).toBeGreaterThan(0);
      fireTimeout();
      const res = await running;
      expect(res.code).toBe(timedOut);
      expect(await outerHoldClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (outerHoldPid > 0) try { process.kill(outerHoldPid, "SIGKILL"); } catch {}
      await daemonClosed.catch(() => {});
    }
  });

  test("reports a probe that kills its own process group with SIGKILL as failing rather than unchecked", async () => {
    const dir = temp.make("sup-self-kill-group-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const res = await humanStepsLeft(probePlan("self-kill", [shBin, "-c", "kill -KILL 0"]), {
      home: dir,
      giveUp: new Promise<void>(() => {}),
      graceMs: 0,
    });
    expect(res.failing.map((s) => s.id)).toEqual(["self-kill"]);
    expect(res.unchecked).toEqual([]);
  });

  test("skips running a real probe when giveUp is already resolved", async () => {
    const dir = temp.make("sup-already-resolved-");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const marker = join(dir, "ran");
    const res = await humanStepsLeft(
      probePlan("already-late", [shBin, "-c", `echo ran > ${JSON.stringify(marker)}`]),
      { home: dir, giveUp: Promise.resolve() },
    );
    expect(res.failing).toEqual([]);
    expect(res.unchecked.map((s) => s.id)).toEqual(["already-late"]);
    expect(existsSync(marker)).toBe(false);
  });

  test("preserves probe cleanup grace for single and double nested captured children when a probe receives SIGTERM", async () => {
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    for (const depth of [1, 2] as const) {
      const dir = temp.make(`sup-capture-grace-d${depth}-`);
      const [ready, trapped, gate, cleaned, gone] = [
        join(dir, "ready"),
        join(dir, "trapped"),
        join(dir, "gate"),
        join(dir, "cleaned"),
        join(dir, "gone"),
      ];
      mkfifo(ready, trapped, gate, cleaned, gone);
      const started = fifoRead(ready);
      const sawTrapped = fifoRead(trapped);
      const sawCleaned = fifoRead(cleaned);
      const closed = fifoRead(gone);
      const childCmd = `trap 'echo cleaning >&2; echo trapped > ${JSON.stringify(trapped)}; cat ${JSON.stringify(gate)} >/dev/null; echo cleaned > ${JSON.stringify(cleaned)}; exit 0' TERM; exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
      const innerCapture = `import { capture } from ${JSON.stringify(coderPath)};
await capture([${JSON.stringify(shBin)}, "-c", ${JSON.stringify(childCmd)}], { timeoutMs: 30_000 });`;
      const probeScript =
        depth === 1
          ? innerCapture
          : `import { capture } from ${JSON.stringify(coderPath)};
await capture([process.execPath, "-e", ${JSON.stringify(innerCapture)}], { timeoutMs: 30_000 });`;
      let fireDeadline!: () => void;
      let childPid = 0;
      try {
        const pending = humanStepsLeft(probePlan(`capture-grace-${depth}`, [process.execPath, "-e", probeScript]), {
          home: dir,
          giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)),
          graceMs: 10_000,
        });
        childPid = Number((await started).trim());
        expect(childPid).toBeGreaterThan(0);
        fireDeadline();
        const res = await pending;
        expect(res.unchecked.map((s) => s.id)).toEqual([`capture-grace-${depth}`]);
        expect((await sawTrapped).trim()).toBe("trapped");
        expect(() => process.kill(childPid, 0)).not.toThrow();
        await fifoWrite(gate, "go\n");
        expect((await sawCleaned).trim()).toBe("cleaned");
        expect(await closed).toBe("");
      } finally {
        if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      }
    }
  });

  test("stops detached and separate-group probe workers on timeout while preserving a completed nested capture's daemon even with read-only TMPDIR", async () => {
    if (process.getuid?.() === 0) return;
    const { chmodSync, mkdirSync } = await import("node:fs");
    const coderPath = join(import.meta.dir, "../../packs/hub/lib/coder.ts");
    const dir = temp.make("sup-readonly-tmpdir-");
    const roTmp = join(dir, "ro-tmp");
    mkdirSync(roTmp, { recursive: true, mode: 0o500 });
    const [detachedReady, detachedGone, jobReady, jobGone, daemonReady, daemonGone, triggerFifo] = [
      join(dir, "detached-ready"),
      join(dir, "detached-gone"),
      join(dir, "job-ready"),
      join(dir, "job-gone"),
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "trigger"),
    ];
    mkfifo(detachedReady, detachedGone, jobReady, jobGone, daemonReady, daemonGone, triggerFifo);
    const detachedStarted = fifoRead(detachedReady);
    const detachedClosed = fifoRead(detachedGone);
    const jobStarted = fifoRead(jobReady);
    const jobClosed = fifoRead(jobGone);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const daemonHelper = `const d = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();`;
    const jobScript = `import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
if (lib.symbols.setpgid(0, 0) !== 0) process.exit(2);
const j = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "job", ${JSON.stringify(jobGone)}, ${JSON.stringify(jobReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await j.exited;`;
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(daemonHelper)}], { timeoutMs: 5_000 });
if (res.code !== 0) process.exit(2);
const d = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "detached", ${JSON.stringify(detachedGone)}, ${JSON.stringify(detachedReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
const j = Bun.spawn([process.execPath, "-e", ${JSON.stringify(jobScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await j.exited;`;
    const driverScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
let fireDeadline;
const pending = humanStepsLeft(${JSON.stringify(probePlan("ro-tmp", [process.execPath, "-e", probeScript]))}, { home: ${JSON.stringify(dir)}, giveUp: new Promise((resolve) => (fireDeadline = resolve)), graceMs: 0 });
await Bun.spawn(["cat", ${JSON.stringify(triggerFifo)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
fireDeadline();
const res = await pending;
process.exit(res.unchecked.map((s) => s.id).join(",") === "ro-tmp" ? 0 : 1);`;
    const driver = Bun.spawn([process.execPath, "-e", driverScript], {
      env: { ...process.env, TMPDIR: roTmp },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let detachedPid = 0;
    let jobPid = 0;
    let daemonPid = 0;
    try {
      const [rawDetached, rawJob, rawDaemon] = await Promise.all([detachedStarted, jobStarted, daemonStarted]);
      detachedPid = Number(rawDetached.trim());
      jobPid = Number(rawJob.trim());
      daemonPid = Number(rawDaemon.trim());
      expect(detachedPid).toBeGreaterThan(0);
      expect(jobPid).toBeGreaterThan(0);
      expect(daemonPid).toBeGreaterThan(0);
      await fifoWrite(triggerFifo, "go\n");
      expect(await driver.exited).toBe(0);
      expect(await detachedClosed).toBe("");
      expect(await jobClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      try { chmodSync(roTmp, 0o700); } catch {}
      driver.kill("SIGKILL");
      if (detachedPid > 0) try { process.kill(detachedPid, "SIGKILL"); } catch {}
      if (jobPid > 0) try { process.kill(jobPid, "SIGKILL"); } catch {}
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      await driver.exited.catch(() => {});
      await daemonClosed.catch(() => {});
    }
  });

  test("stops a detached clean-env worker spawned during SIGTERM escalation on Linux while sparing unrelated processes", async () => {
    if (process.platform !== "linux") return;
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const dir = temp.make("sup-holder-sweep-");
    const [ready, workerReady, workerGone, unrelatedReady, unrelatedGone] = [
      join(dir, "ready"),
      join(dir, "worker-ready"),
      join(dir, "worker-gone"),
      join(dir, "unrelated-ready"),
      join(dir, "unrelated-gone"),
    ];
    mkfifo(ready, workerReady, workerGone, unrelatedReady, unrelatedGone);
    const started = fifoRead(ready);
    const workerStarted = fifoRead(workerReady);
    const workerClosed = fifoRead(workerGone);
    const unrelatedStarted = fifoRead(unrelatedReady);
    const unrelatedClosed = fifoRead(unrelatedGone);
    const unrelated = Bun.spawn(
      [shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "unrelated", unrelatedGone, unrelatedReady],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const probeScript = `process.on("SIGTERM", () => {
  const w = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(workerGone)}, ${JSON.stringify(workerReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  w.unref();
});
await Bun.write(${JSON.stringify(ready)}, String(process.pid) + "\\n");
await Bun.sleep(30_000);`;
    const clock = manualClock();
    let fireDeadline!: () => void;
    let probePid = 0;
    let workerPid = 0;
    try {
      expect(Number((await unrelatedStarted).trim())).toBeGreaterThan(0);
      const pending = humanStepsLeft(
        probePlan("holder-sweep", [process.execPath, "-e", probeScript]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 10_000, clockFd: clock.readFd },
      );
      probePid = Number((await started).trim());
      expect(probePid).toBeGreaterThan(0);
      fireDeadline();
      workerPid = Number((await workerStarted).trim());
      expect(workerPid).toBeGreaterThan(0);
      const res = await pending;
      expect(res.unchecked.map((s) => s.id)).toEqual(["holder-sweep"]);
      clock.tick();
      expect(await workerClosed).toBe("");
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      clock.close();
      if (probePid > 0) try { process.kill(probePid, "SIGKILL"); } catch {}
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      unrelated.kill("SIGKILL");
      await unrelated.exited.catch(() => {});
      await unrelatedClosed.catch(() => {});
    }
  });

  test("escalates cancellation on a group whose leader exited leaving a child while sparing an unrelated process group", async () => {
    if (process.platform === "win32") return;
    const dir = temp.make("sup-group-handoff-");
    const [unrelatedReady, unrelatedPing, unrelatedPong, unrelatedGone, childReady, childGone] = [
      join(dir, "u-ready"),
      join(dir, "u-ping"),
      join(dir, "u-pong"),
      join(dir, "u-gone"),
      join(dir, "c-ready"),
      join(dir, "c-gone"),
    ];
    mkfifo(unrelatedReady, unrelatedPing, unrelatedPong, unrelatedGone, childReady, childGone);
    const uStarted = fifoRead(unrelatedReady);
    const uPonged = fifoRead(unrelatedPong);
    const uClosed = fifoRead(unrelatedGone);
    const cStarted = fifoRead(childReady);
    const cClosed = fifoRead(childGone);
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const unrelated = Bun.spawn(
      [shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; read _ < "$3"; echo alive > "$4"; exec sleep 30', "unrelated", unrelatedGone, unrelatedReady, unrelatedPing, unrelatedPong],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const leaderScript = `const w = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'trap "" HUP TERM; exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "child", ${JSON.stringify(childGone)}, ${JSON.stringify(childReady)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
process.exit(0);`;
    const probeScript = `const sub = Bun.spawn([process.execPath, "-e", ${JSON.stringify(leaderScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await sub.exited;
await Bun.sleep(30_000);`;
    const clock = manualClock();
    let fireDeadline!: () => void;
    let childPid = 0;
    try {
      expect(Number((await uStarted).trim())).toBe(unrelated.pid);
      const pending = humanStepsLeft(
        probePlan("group-handoff", [process.execPath, "-e", probeScript]),
        { home: dir, giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)), graceMs: 10_000, clockFd: clock.readFd },
      );
      childPid = Number((await cStarted).trim());
      expect(childPid).toBeGreaterThan(0);
      fireDeadline();
      const res = await pending;
      expect(res.unchecked.map((s) => s.id)).toEqual(["group-handoff"]);
      clock.tick();
      expect(await cClosed).toBe("");
      await fifoWrite(unrelatedPing, "check\n");
      expect((await uPonged).trim()).toBe("alive");
    } finally {
      clock.close();
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      unrelated.kill("SIGKILL");
      await unrelated.exited.catch(() => {});
      await uClosed.catch(() => {});
    }
  });

  test("runs a near-ARG_MAX probe under a 256 KiB stack limit without failing setup checks due to supervisor env entries", async () => {
    if (process.platform !== "linux") return;
    const trueBin = Bun.which("true") ?? "/bin/true";
    const dir = temp.make("sup-arg-limit-");
    const script = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
const baseEnv = { ...process.env, HOME: ${JSON.stringify(dir)} };
const envBytes = Object.entries(baseEnv).reduce((sum, [k, v]) => sum + k.length + (v?.length ?? 0) + 10, 0);
const half = Math.floor((131_072 - envBytes - ${trueBin.length} - 120) / 2);
const a = "a".repeat(half);
const b = "b".repeat(half);
const direct = Bun.spawnSync([${JSON.stringify(trueBin)}, a, b], { env: baseEnv });
if (direct.exitCode !== 0) process.exit(2);
const res = await humanStepsLeft({
  machine: { schema: 1, role: "linux" },
  os: "linux",
  ai: "both",
  packs: [],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [{ id: "arg-limit", pack: "team", say: "Arg limit.", probe: [${JSON.stringify(trueBin)}, a, b] }],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  models: [],
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}) });
process.exit(res.failing.length === 0 && res.unchecked.length === 0 ? 0 : 1);`;
    const proc = Bun.spawn(["sh", "-c", 'ulimit -s 256 && exec "$1" -e "$2"', "probe-arg-limit", process.execPath, script], {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });

  test("refuses to signal an unverified process group or PID whose member identity was missing", async () => {
    if (process.platform === "win32") return;
    const { signalDeadTargets, signalTargets } = await import("./probe-supervisor.ts");
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const dir = temp.make("sup-unverified-pgrp-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const unrelated = Bun.spawn(
      [shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "unrelated", gone, ready],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
      const pid = Number((await started).trim());
      expect(pid).toBe(unrelated.pid);
      const unverified = {
        pids: [pid],
        groups: [pid],
        orphanPids: [pid],
        hasSessionGroup: true,
        groupMembers: new Map(),
        pidIdentities: new Map(),
      };
      signalTargets(unverified, "SIGKILL", undefined, undefined);
      signalDeadTargets(unverified, pid, undefined, undefined);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      await unrelated.exited.catch(() => {});
      await closed.catch(() => {});
    }
  });
});
