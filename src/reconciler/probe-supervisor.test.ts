import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { supervise, tagEnvVar, type StopSignal } from "./probe-supervisor.ts";
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

  test("excludes tagged detached daemons when SIGTERM arrives while checking group members after reporting a normal result", async () => {
    const signalHandlers = new Map<StopSignal, () => void>();
    const killCalls: Array<{ signal: NodeJS.Signals; includeTagged?: boolean }> = [];
    let finishCheck!: (hasMembers: boolean) => void;
    let fireHard!: () => void;
    const checking = new Promise<boolean>((resolve) => (finishCheck = resolve));
    const done = supervise(["probe"], {
      spawn: () => ({ pid: 42, exited: Promise.resolve(0) }),
      killGroup: (signal, includeTagged) => {
        killCalls.push({ signal, includeTagged });
      },
      hasGroupMembers: () => checking,
      timer: (_ms, fire) => {
        fireHard = fire;
        return () => {};
      },
      onSignal: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      reportResult: () => {},
      reportCleanup: () => {},
      exit: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    signalHandlers.get("SIGTERM")?.();
    fireHard();
    finishCheck(false);
    await done;
    expect(killCalls).toEqual([
      { signal: "SIGTERM", includeTagged: false },
      { signal: "SIGKILL", includeTagged: false },
    ]);
  });
});
