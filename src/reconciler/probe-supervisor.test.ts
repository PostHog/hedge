import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { createPipe, discoverTargets, setCloexec, tagEnvVar } from "./probe-supervisor.ts";
import { watchEntries } from "./probe-watchdog.ts";

const temp = tempDirs();
const activeHelpers: Array<{ kill(signal?: NodeJS.Signals): void }> = [];

afterEach(() => {
  for (const proc of activeHelpers.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
  temp.cleanup();
});

const supervisorPath = join(import.meta.dir, "probe-supervisor.ts");

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

function spawnControlledSupervisor(command: string[]) {
  const harness = `
import { hasOtherGroupMember, killSession, supervise } from ${JSON.stringify(supervisorPath)};
const timers = [];
const write = (line) => process.stdout.write(line + "\\n");
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = "";
void (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
      const cmd = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (cmd === "tick") {
        const next = timers.find((entry) => !entry.cancelled);
        if (next) {
          next.cancelled = true;
          next.fire();
        }
      }
    }
  }
})();
await supervise(${JSON.stringify(command)}, {
  spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
  killGroup: (signal) => killSession(process.pid, signal),
  hasGroupMembers: hasOtherGroupMember,
  timer: (_ms, fire) => {
    const entry = { fire, cancelled: false };
    timers.push(entry);
    write("armed");
    return () => {
      if (!entry.cancelled) {
        entry.cancelled = true;
        write("disarmed");
      }
    };
  },
  onSignal: (signal, handler) => void process.on(signal, handler),
  reportResult: (code) => write("result:" + code),
  reportCleanup: () => write("cleanup"),
  exit: (code) => process.exit(code),
});
`;
  const proc = Bun.spawn([process.execPath, "-e", harness], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const armedWaiters: Array<() => void> = [];
  let armedCount = 0;
  let exited = false;
  let reported: number | undefined;
  void proc.exited.then(() => {
    exited = true;
    for (const waiter of armedWaiters.splice(0)) waiter();
  });
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line === "armed") {
          const waiter = armedWaiters.shift();
          if (waiter) waiter();
          else armedCount++;
        } else if (line === "disarmed") {
          if (armedCount > 0) armedCount--;
        } else if (line.startsWith("result:")) {
          reported = Number(line.slice("result:".length));
        }
      }
    }
  })();
  const waitArmed = () =>
    armedCount > 0
      ? (armedCount--, Promise.resolve(true))
      : exited
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => armedWaiters.push(() => resolve(!exited)));
  const advance = async () => {
    if (!(await waitArmed())) return;
    try {
      proc.stdin.write("tick\n");
      proc.stdin.flush();
    } catch {}
  };
  const drain = async () => {
    while (!exited) {
      if (!(await waitArmed())) break;
      try {
        proc.stdin.write("tick\n");
        proc.stdin.flush();
      } catch {
        break;
      }
    }
    const code = await proc.exited;
    return reported ?? code;
  };
  const cleanup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    proc.kill("SIGKILL");
  };
  return { proc, advance, drain, waitArmed, cleanup };
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
      const dir = temp.make("sup-esc-");
      const [ready, sawSig, sawTerm, gone] = [
        join(dir, "ready"),
        join(dir, "saw-sig"),
        join(dir, "saw-term"),
        join(dir, "gone"),
      ];
      mkfifo(ready, sawSig, sawTerm, gone);
      const started = fifoRead(ready);
      const gotSig = fifoRead(sawSig);
      const gotTerm = fifoRead(sawTerm);
      const holderGone = fifoRead(gone);
      const sup = spawnControlledSupervisor([
        "sh",
        "-c",
        `trap 'echo ${sig} > "$1"' ${trapName}; trap 'echo SIGTERM > "$2"' TERM; exec 3>"$3"; echo $$ > "$4"; while true; do sleep 30 & wait; done`,
        "probe",
        sawSig,
        sawTerm,
        gone,
        ready,
      ]);
      try {
        const pid = Number((await started).trim());
        expect(pid).toBeGreaterThan(0);

        sup.proc.kill(sig);
        expect((await gotSig).trim()).toBe(sig);
        expect(() => process.kill(pid, 0)).not.toThrow();

        await sup.advance();
        expect((await gotTerm).trim()).toBe("SIGTERM");
        expect(() => process.kill(pid, 0)).not.toThrow();

        await sup.advance();
        expect(await holderGone).toBe("");
        expect(await sup.proc.exited).not.toBe(0);
      } finally {
        sup.cleanup();
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
    const sup = spawnControlledSupervisor([
      "sh",
      "-c",
      'exec 4>"$1"; sh -c "$2" 4>&- & wait',
      "probe",
      leaderGone,
      childScript,
    ]);
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      sup.proc.kill("SIGTERM");
      expect(await leaderClosed).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await fifoWrite(gate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await childClosed).toBe("");

      expect(await sup.drain()).not.toBe(0);
    } finally {
      sup.cleanup();
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
    const sup = spawnControlledSupervisor([
      "sh",
      "-c",
      'exec 4>"$1"; sh -c "$2" 4>&- & wait',
      "probe",
      leaderGone,
      childScript,
    ]);
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      sup.proc.kill("SIGTERM");
      expect(await leaderClosed).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await sup.advance();
      expect(await childClosed).toBe("");
      expect(await sup.proc.exited).not.toBe(0);
    } finally {
      sup.cleanup();
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
    const childScript = `trap 'echo got-term > ${JSON.stringify(prematureTerm)}' TERM; trap 'echo child-int > ${JSON.stringify(childStarted)}; cat ${JSON.stringify(gate)} >/dev/null; echo child-done > ${JSON.stringify(childCleaned)}; exit 0' INT; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
    const leaderScript = `import { writeFileSync } from "node:fs";
process.on("SIGINT", () => { writeFileSync(${JSON.stringify(leaderCleaned)}, "leader-done\\n"); process.exit(130); });
await Bun.spawn(["sh", "-c", ${JSON.stringify(childScript)}], { stdio: ["ignore", "ignore", "ignore"] }).exited;`;
    const sup = spawnControlledSupervisor([process.execPath, "-e", leaderScript]);
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      sup.proc.kill("SIGINT");
      expect((await sawLeader).trim()).toBe("leader-done");
      expect((await sawChildInt).trim()).toBe("child-int");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(existsSync(prematureTerm)).toBe(false);

      await fifoWrite(gate, "go\n");
      expect((await sawChild).trim()).toBe("child-done");
      expect(await childClosed).toBe("");
      expect(existsSync(prematureTerm)).toBe(false);

      expect(await sup.drain()).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("lets stray descendants run SIGTERM cleanup on normal probe exit and kills descendants ignoring SIGHUP and SIGTERM while preserving exit status", async () => {
    const dir = temp.make("sup-normal-");
    const [ready, gate, trapGate, cleaned, gone] = [
      join(dir, "ready"),
      join(dir, "gate"),
      join(dir, "trap-gate"),
      join(dir, "cleaned"),
      join(dir, "gone"),
    ];
    mkfifo(ready, gate, trapGate, cleaned, gone);
    const started = fifoRead(ready);
    const sawCleaned = fifoRead(cleaned);
    const holderGone = fifoRead(gone);
    const trapChild = `trap 'cat ${JSON.stringify(trapGate)} >/dev/null; echo cleaned > ${JSON.stringify(cleaned)}; exit 0' TERM; exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
    const trapSup = spawnControlledSupervisor([
      "sh",
      "-c",
      'sh -c "$1" & cat "$2" >/dev/null; exit 0',
      "probe",
      trapChild,
      gate,
    ]);
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);
      await fifoWrite(gate, "go\n");
      await fifoWrite(trapGate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await holderGone).toBe("");
      expect(await trapSup.drain()).toBe(0);
    } finally {
      trapSup.cleanup();
    }

    const dir2 = temp.make("sup-orphan-");
    const [ready2, gate2, leaderGone2, gone2] = [
      join(dir2, "ready"),
      join(dir2, "gate"),
      join(dir2, "leader-gone"),
      join(dir2, "gone"),
    ];
    mkfifo(ready2, gate2, leaderGone2, gone2);
    const started2 = fifoRead(ready2);
    const leaderClosed2 = fifoRead(leaderGone2);
    const holderGone2 = fifoRead(gone2);
    const stubbornChild = `trap "" HUP TERM; exec 3>${JSON.stringify(gone2)}; echo $$ > ${JSON.stringify(ready2)}; exec sleep 30`;
    const stubbornSup = spawnControlledSupervisor([
      "sh",
      "-c",
      'exec 4>"$3"; sh -c "$1" 4>&- & cat "$2" >/dev/null; exit 0',
      "probe",
      stubbornChild,
      gate2,
      leaderGone2,
    ]);
    try {
      const childPid = Number((await started2).trim());
      expect(childPid).toBeGreaterThan(0);
      await fifoWrite(gate2, "go\n");
      expect(await leaderClosed2).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await stubbornSup.advance();
      expect(await holderGone2).toBe("");
      expect(await stubbornSup.drain()).toBe(0);
    } finally {
      stubbornSup.cleanup();
    }
  });

  test("kills a descendant spawned right as another stray child exits on SIGTERM", async () => {
    const dir = temp.make("sup-respawn-");
    const [ready, gate, grandReady, grandGone] = [
      join(dir, "ready"),
      join(dir, "gate"),
      join(dir, "grand-ready"),
      join(dir, "grand-gone"),
    ];
    mkfifo(ready, gate, grandReady, grandGone);
    const started = fifoRead(ready);
    const grandStarted = fifoRead(grandReady);
    const grandClosed = fifoRead(grandGone);
    const grandBin = join(dir, "grand.sh");
    writeFileSync(grandBin, '#!/bin/sh\ntrap "" HUP TERM\nexec 3>"$1"\necho $$ > "$2"\nexec sleep 30\n', { mode: 0o755 });
    const childScript = `trap '${grandBin} ${grandGone} ${grandReady} & exit 0' TERM; echo $$ > ${JSON.stringify(ready)}; sleep 30 & wait`;
    const sup = spawnControlledSupervisor(["sh", "-c", 'sh -c "$1" & cat "$2" >/dev/null; exit 0', "probe", childScript, gate]);
    try {
      expect(Number((await started).trim())).toBeGreaterThan(0);
      await fifoWrite(gate, "go\n");
      const grandPid = Number((await grandStarted).trim());
      expect(grandPid).toBeGreaterThan(0);
      expect(() => process.kill(grandPid, 0)).not.toThrow();
      await sup.advance();
      expect(await grandClosed).toBe("");
      expect(await sup.drain()).toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("wakes and escalates a probe that suspends itself with SIGSTOP and ignores SIGTERM", async () => {
    const dir = temp.make("sup-sigstop-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const sup = spawnControlledSupervisor(["sh", "-c", 'trap "" TERM; exec 3>"$1"; echo $$ > "$2"; kill -STOP $$', "probe", gone, ready]);
    try {
      expect(Number((await started).trim())).toBeGreaterThan(0);
      sup.proc.kill("SIGTERM");
      await sup.advance();
      expect(await closed).toBe("");
      expect(await sup.drain()).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("watchdog kills a probe whose TERM cleanup suspends its whole process group when the controlled clock reaches the deadline", async () => {
    const dir = temp.make("sup-watchdog-stop-");
    const [ready, gone, trapped] = [join(dir, "ready"), join(dir, "gone"), join(dir, "trapped")];
    mkfifo(ready, gone, trapped);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const sawTrap = fifoRead(trapped);
    const payload = JSON.stringify({
      command: ["sh", "-c", 'exec 3>"$1"; trap \'echo trapped > "$3"; kill -STOP 0\' TERM; echo $$ > "$2"; sleep 30 & wait', "probe", gone, ready, trapped],
      controlFd: 3,
    });
    const sup = Bun.spawn([process.execPath, supervisorPath, payload], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    let clockNow = 0;
    let wakeSleep: (() => void) | undefined;
    let sleepingResolve: (() => void) | undefined;
    const sleeping = new Promise<void>((resolve) => (sleepingResolve = resolve));
    const watchDone = watchEntries([{ pid: sup.pid, fd: aliveFd, delayMs: 250 }], {
      now: () => clockNow,
      sleep: () => {
        sleepingResolve?.();
        return new Promise<void>((resolve) => (wakeSleep = resolve));
      },
    });
    try {
      const probePid = Number((await started).trim());
      expect(probePid).toBeGreaterThan(0);
      await sleeping;
      writeSync(aliveFd, "SIGTERM\n");
      expect((await sawTrap).trim()).toBe("trapped");
      expect(() => process.kill(probePid, 0)).not.toThrow();
      clockNow = 250;
      wakeSleep?.();
      await watchDone;
      expect(await closed).toBe("");
      expect(await sup.exited).not.toBe(0);
    } finally {
      try {
        process.kill(-sup.pid, "SIGKILL");
      } catch {}
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
    }
  });

  test("watchdog still kills a tagged detached child when the supervisor dies and closes its control pipe early", async () => {
    const dir = temp.make("sup-watchdog-dead-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const tag = crypto.randomUUID();
    const detachedScript = `const c = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); c.unref(); await Bun.sleep(30_000);`;
    const payload = JSON.stringify({
      command: [process.execPath, "-e", detachedScript],
      controlFd: 3,
    });
    const sup = Bun.spawn([process.execPath, supervisorPath, payload], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
      env: { ...process.env, [tagEnvVar]: tag },
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    let workerPid = 0;
    try {
      workerPid = Number((await started).trim());
      expect(workerPid).toBeGreaterThan(0);
      sup.kill("SIGKILL");
      await sup.exited;
      await watchEntries([{ pid: sup.pid, fd: aliveFd, delayMs: 250, tag }], {
        now: () => 0,
        sleep: async () => {},
      });
      expect(await closed).toBe("");
    } finally {
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
    }
  });

  test("leaves an intentionally detached daemon alive on normal probe exit while still killing detached workers on stop", async () => {
    const dir = temp.make("sup-detached-normal-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const tag = crypto.randomUUID();
    const daemonScript = `const c = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "daemon", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); c.unref(); process.exit(0);`;
    const payload = JSON.stringify({ command: [process.execPath, "-e", daemonScript], controlFd: 3 });
    const sup = Bun.spawn([process.execPath, supervisorPath], {
      stdio: [new TextEncoder().encode(payload), "pipe", "ignore", "pipe"],
      env: { ...process.env, [tagEnvVar]: tag },
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    let daemonPid = 0;
    try {
      daemonPid = Number((await started).trim());
      expect(daemonPid).toBeGreaterThan(0);
      expect(await sup.exited).toBe(0);
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
      await closed.catch(() => {});
    }
  });

  test("stops ordinary descendants on SIGINT after a normal probe exit while keeping an intentionally detached daemon alive", async () => {
    const dir = temp.make("sup-post-result-sigint-");
    const [daemonReady, daemonGone, childReady, childGone, childSawTerm, childSawInt, exitGate, holdReady] = [
      join(dir, "daemon-ready"),
      join(dir, "daemon-gone"),
      join(dir, "child-ready"),
      join(dir, "child-gone"),
      join(dir, "child-saw-term"),
      join(dir, "child-saw-int"),
      join(dir, "exit-gate"),
      join(dir, "hold-ready"),
    ];
    mkfifo(daemonReady, daemonGone, childReady, childGone, childSawTerm, childSawInt, exitGate, holdReady);
    const daemonStarted = fifoRead(daemonReady);
    const daemonClosed = fifoRead(daemonGone);
    const childStarted = fifoRead(childReady);
    const childClosed = fifoRead(childGone);
    const sawTerm = fifoRead(childSawTerm);
    const sawInt = fifoRead(childSawInt);
    const holdStarted = fifoRead(holdReady);
    const daemonCmd = 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30';
    const childCmd = 'pid=; trap \'echo term > "$3"\' TERM; trap \'kill "$pid" 2>/dev/null; echo int > "$4"; exit 0\' INT; exec 3>"$1"; echo $$ > "$2"; while true; do sleep 30 3>&- & pid=$!; wait "$pid"; done';
    const probeScript = `const d = Bun.spawn(["sh", "-c", ${JSON.stringify(daemonCmd)}, "daemon", ${JSON.stringify(daemonGone)}, ${JSON.stringify(daemonReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
d.unref();
const c = Bun.spawn(["sh", "-c", ${JSON.stringify(childCmd)}, "child", ${JSON.stringify(childGone)}, ${JSON.stringify(childReady)}, ${JSON.stringify(childSawTerm)}, ${JSON.stringify(childSawInt)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
c.unref();
await Bun.file(${JSON.stringify(exitGate)}).text();
process.exit(0);`;
    const applyPath = join(import.meta.dir, "apply.ts");
    const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
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
    { id: "hold", pack: "team", say: "Hold.", probe: ["sh", "-c", 'echo $$ > "$1"; exec sleep 30', "hold", ${JSON.stringify(holdReady)}] },
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
await humanStepsLeft(plan, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 10_000 });`;
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
      expect((await sawTerm).trim()).toBe("term");
      runner.kill("SIGINT");
      expect((await sawInt).trim()).toBe("int");
      expect(await childClosed).toBe("");
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
    } finally {
      if (daemonPid > 0) try { process.kill(daemonPid, "SIGKILL"); } catch {}
      if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
      if (holdPid > 0) try { process.kill(holdPid, "SIGKILL"); } catch {}
      runner.kill("SIGKILL");
      await runner.exited.catch(() => {});
      await daemonClosed.catch(() => {});
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
    const payload = JSON.stringify({
      command: [shBin, "-c", `echo ran > ${JSON.stringify(marker)}`],
      controlFd: 3,
    });
    const sup = Bun.spawn([process.execPath, supervisorPath], {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    try {
      writeSync(aliveFd, "SIGTERM\n");
      const stdinSink = sup.stdin as { write: (data: string) => void; end: () => void };
      stdinSink.write(payload);
      stdinSink.end();
      expect(await sup.exited).not.toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
    }

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

  test("stops a detached tagged worker with oversized argv and a detached clean-env child on SIGTERM while sparing unrelated processes whose argv or other env mentions the tag", async () => {
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
    const tag = crypto.randomUUID();
    const unrelatedEnv: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== tagEnvVar) unrelatedEnv[k] = v;
    }
    unrelatedEnv.OTHER = `prefix ${tagEnvVar}=${tag}`;
    const unrelated = Bun.spawn(
      [shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; sleep 30 3>&- & wait', "unrelated", unrelatedGone, unrelatedReady, `${tagEnvVar}=${tag}`],
      { env: unrelatedEnv, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const largeArg = "x".repeat(70_000);
    const probeScript = `const tagged = Bun.spawn([${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; sleep 30 3>&- & wait', "tagged", ${JSON.stringify(taggedGone)}, ${JSON.stringify(taggedReady)}, ${JSON.stringify(largeArg)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
tagged.unref();
const clean = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "clean", ${JSON.stringify(cleanGone)}, ${JSON.stringify(cleanReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
clean.unref();
process.on("SIGTERM", () => process.exit(0));
await Bun.sleep(30_000);`;
    const payload = JSON.stringify({ command: [process.execPath, "-e", probeScript], controlFd: 3, graceMs: 0 });
    const sup = Bun.spawn([process.execPath, supervisorPath], {
      stdio: [new TextEncoder().encode(payload), "pipe", "ignore", "pipe"],
      env: { ...process.env, [tagEnvVar]: tag },
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    let unrelatedPid = 0;
    let taggedPid = 0;
    let cleanPid = 0;
    try {
      [unrelatedPid, taggedPid, cleanPid] = (await Promise.all([unrelatedStarted, taggedStarted, cleanStarted])).map((s) => Number(s.trim())) as [number, number, number];
      expect(unrelatedPid).toBeGreaterThan(0);
      expect(taggedPid).toBeGreaterThan(0);
      expect(cleanPid).toBeGreaterThan(0);
      writeSync(aliveFd, "SIGTERM\n");
      expect(await taggedClosed).toBe("");
      expect(await cleanClosed).toBe("");
      expect(await sup.exited).not.toBe(0);
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
    } finally {
      if (unrelatedPid > 0) try { process.kill(unrelatedPid, "SIGKILL"); } catch {}
      if (taggedPid > 0) try { process.kill(taggedPid, "SIGKILL"); } catch {}
      if (cleanPid > 0) try { process.kill(cleanPid, "SIGKILL"); } catch {}
      unrelated.kill("SIGKILL");
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
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

  test("ignores a non-regular FIFO planted at a spareFile path without blocking discovery", async () => {
    const dir = temp.make("sup-fifo-spare-");
    const fifoSpare = join(dir, "planted.spare");
    mkfifo(fifoSpare);
    const targets = await discoverTargets(process.pid, crypto.randomUUID(), fifoSpare);
    expect(targets).toBeDefined();
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

  test("watchdog kills a same-session clean-env worker when the supervisor dies early", async () => {
    const dir = temp.make("sup-watchdog-dead-envi-");
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    mkfifo(ready, gone);
    const started = fifoRead(ready);
    const closed = fifoRead(gone);
    const tag = crypto.randomUUID();
    const payload = JSON.stringify({
      command: [envBin, "-i", shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", gone, ready],
      controlFd: 3,
    });
    const sup = Bun.spawn([process.execPath, supervisorPath], {
      stdio: [new TextEncoder().encode(payload), "pipe", "ignore", "pipe"],
      env: { ...process.env, [tagEnvVar]: tag },
      detached: true,
    });
    const aliveFd = sup.stdio[3] as number;
    let workerPid = 0;
    try {
      workerPid = Number((await started).trim());
      expect(workerPid).toBeGreaterThan(0);
      sup.kill("SIGKILL");
      await sup.exited;
      await watchEntries([{ pid: sup.pid, fd: aliveFd, delayMs: 250, tag }], {
        now: () => 0,
        sleep: async () => {},
      });
      expect(await closed).toBe("");
    } finally {
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      sup.kill("SIGKILL");
      try {
        closeSync(aliveFd);
      } catch {}
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

  test("kills an adopted detached env -i worker when its Linux probe supervisor dies unexpectedly", async () => {
    if (process.platform !== "linux") return;
    const envBin = Bun.which("env") ?? "/usr/bin/env";
    const shBin = Bun.which("sh") ?? "/bin/sh";
    const { humanStepsLeft } = await import("./apply.ts");
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
await Bun.write(${JSON.stringify(helperDone)}, String(process.ppid) + "\\n");
await Bun.sleep(30_000);`;
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
          human: [{ id: "adopted", pack: "team", say: "Adopted.", probe: [process.execPath, "-e", probeScript] }],
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
        { home: dir, giveUp: new Promise<void>(() => {}), graceMs: 0 },
      );
      const [rawWorker, rawSupervisor] = await Promise.all([started, adopted]);
      workerPid = Number(rawWorker.trim());
      const supervisorPid = Number(rawSupervisor.trim());
      expect(workerPid).toBeGreaterThan(0);
      expect(supervisorPid).toBeGreaterThan(1);
      process.kill(supervisorPid, "SIGKILL");
      const res = await pending;
      expect(res.unchecked.map((step) => step.id)).toEqual(["adopted"]);
      expect(await closed).toBe("");
    } finally {
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
    const { spareEnvVar, spareFilePath, removeSpareFile } = await import("./probe-supervisor.ts");
    const spareFile = spareFilePath(crypto.randomUUID());
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
      const capture = captureWith((_ms, fire) => {
        fireTimeout = fire;
        return () => {};
      }, 0);
      const running = capture([process.execPath, "-e", outerScript], {
        env: { ...process.env, [spareEnvVar]: spareFile },
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
      removeSpareFile(spareFile);
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
});
