import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";

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

function spawnControlledSupervisor(command: string[], options?: { scanGate?: string }) {
  const harness = `
import { hasOtherGroupMembers, supervise } from ${JSON.stringify(supervisorPath)};
const scanGate = ${JSON.stringify(options?.scanGate ?? "")};
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
  killGroup: (signal) => {
    try { process.kill(-process.pid, signal); } catch {}
  },
  hasOtherMembers: async () => {
    if (scanGate) {
      const gate = Bun.spawn(["cat", scanGate], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await gate.exited;
    }
    return await hasOtherGroupMembers(process.pid);
  },
  timer: (_ms, fire) => {
    const entry = { fire, cancelled: false };
    timers.push(entry);
    write("armed");
    return () => { entry.cancelled = true; };
  },
  onSignal: (signal, handler) => void process.on(signal, handler),
  reportResult: (code) => write("result:" + code),
  reportCleanup: () => {},
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
  const resultWaiters: Array<(code: number) => void> = [];
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
        } else if (line.startsWith("result:")) {
          reported = Number(line.slice("result:".length));
          for (const waiter of resultWaiters.splice(0)) waiter(reported);
        }
      }
    }
  })();
  const waitResult = () =>
    reported !== undefined ? Promise.resolve(reported) : new Promise<number>((resolve) => resultWaiters.push(resolve));
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
  return { proc, advance, drain, waitResult, cleanup };
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
    const [ready2, gate2, gone2] = [join(dir2, "ready"), join(dir2, "gate"), join(dir2, "gone")];
    mkfifo(ready2, gate2, gone2);
    const started2 = fifoRead(ready2);
    const holderGone2 = fifoRead(gone2);
    const stubbornChild = `trap "" HUP TERM; exec 3>${JSON.stringify(gone2)}; echo $$ > ${JSON.stringify(ready2)}; exec sleep 30`;
    const stubbornSup = spawnControlledSupervisor([
      "sh",
      "-c",
      'sh -c "$1" & cat "$2" >/dev/null; exit 0',
      "probe",
      stubbornChild,
      gate2,
    ]);
    try {
      const childPid = Number((await started2).trim());
      expect(childPid).toBeGreaterThan(0);
      await fifoWrite(gate2, "go\n");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await stubbornSup.advance();
      expect(await holderGone2).toBe("");
      expect(await stubbornSup.drain()).toBe(0);
    } finally {
      stubbornSup.cleanup();
    }
  });

  test("publishes the probe exit status while descendant scanning is still blocked, exits cleanly once none remain, and bounds stalled scans via the cleanup timer", async () => {
    const dir = temp.make("sup-scan-");
    const scanGate = join(dir, "scan-gate");
    mkfifo(scanGate);
    const sup = spawnControlledSupervisor(["sh", "-c", "exit 7"], { scanGate });
    try {
      expect(await sup.waitResult()).toBe(7);
      await fifoWrite(scanGate, "go\n");
      expect(await sup.proc.exited).toBe(7);
    } finally {
      sup.cleanup();
    }

    const dir2 = temp.make("sup-stalled-scan-");
    const stalledGate = join(dir2, "scan-gate");
    mkfifo(stalledGate);
    const stalled = spawnControlledSupervisor(["sh", "-c", "exit 7"], { scanGate: stalledGate });
    try {
      expect(await stalled.waitResult()).toBe(7);
      await stalled.advance();
      expect(await stalled.proc.exited).not.toBe(0);
    } finally {
      stalled.cleanup();
    }
  });
});
