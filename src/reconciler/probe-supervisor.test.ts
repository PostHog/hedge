import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const supervisorPath = join(import.meta.dir, "probe-supervisor.ts");

function spawnControlledSupervisor(command: string[]) {
  const harness = `
import { supervise } from ${JSON.stringify(supervisorPath)};
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
  timer: (_ms, fire) => {
    const entry = { fire, cancelled: false };
    timers.push(entry);
    write("armed");
    return () => { entry.cancelled = true; };
  },
  onSignal: (signal, handler) => void process.on(signal, handler),
  reportResult: (code) => write("result " + code),
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
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((resolve) => (resolveResult = resolve));
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
        } else if (line.startsWith("result ")) {
          resolveResult(Number(line.slice("result ".length)));
        }
      }
    }
  })();
  const waitArmed = () =>
    armedCount > 0
      ? (armedCount--, Promise.resolve())
      : new Promise<void>((resolve) => armedWaiters.push(resolve));
  const advance = async () => {
    await waitArmed();
    proc.stdin.write("tick\n");
    proc.stdin.flush();
  };
  const cleanup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    proc.kill("SIGKILL");
  };
  return { proc, result, advance, cleanup };
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
      const started = readFile(ready, "utf8");
      const gotSig = readFile(sawSig, "utf8");
      const gotTerm = readFile(sawTerm, "utf8");
      const holderGone = readFile(gone, "utf8");
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
    const started = readFile(ready, "utf8");
    const leaderClosed = readFile(leaderGone, "utf8");
    const sawCleaned = readFile(cleaned, "utf8");
    const childClosed = readFile(childGone, "utf8");
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

      await writeFile(gate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await childClosed).toBe("");

      await sup.advance();
      expect(await sup.proc.exited).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("stops a descendant that ignores SIGTERM once the grace clock expires after a cooperative leader exits", async () => {
    const dir = temp.make("sup-stubborn-");
    const [ready, leaderGone, childGone] = [join(dir, "ready"), join(dir, "leader-gone"), join(dir, "child-gone")];
    mkfifo(ready, leaderGone, childGone);
    const started = readFile(ready, "utf8");
    const leaderClosed = readFile(leaderGone, "utf8");
    const childClosed = readFile(childGone, "utf8");
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
    const started = readFile(ready, "utf8");
    const sawLeader = readFile(leaderCleaned, "utf8");
    const sawChildInt = readFile(childStarted, "utf8");
    const sawChild = readFile(childCleaned, "utf8");
    const childClosed = readFile(childGone, "utf8");
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

      await writeFile(gate, "go\n");
      expect((await sawChild).trim()).toBe("child-done");
      expect(await childClosed).toBe("");
      expect(existsSync(prematureTerm)).toBe(false);

      await sup.advance();
      await sup.advance();
      expect(await sup.proc.exited).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("reports exact probe exit code, lets stray descendants run SIGTERM cleanup, and kills descendants ignoring SIGHUP and SIGTERM", async () => {
    const exitSeven = Bun.spawn([process.execPath, supervisorPath, JSON.stringify(["sh", "-c", "exit 7"])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    expect((await new Response(exitSeven.stdout).text()).trim()).toBe("7");
    try {
      process.kill(-exitSeven.pid, "SIGKILL");
    } catch {}

    const leadingDash = Bun.spawn([process.execPath, supervisorPath, JSON.stringify(["--", "true"])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    expect((await new Response(leadingDash.stdout).text()).trim()).toBe("127");
    expect(await leadingDash.exited).toBe(127);

    const dir = temp.make("sup-normal-");
    const [ready, gate, trapGate, cleaned, gone] = [
      join(dir, "ready"),
      join(dir, "gate"),
      join(dir, "trap-gate"),
      join(dir, "cleaned"),
      join(dir, "gone"),
    ];
    mkfifo(ready, gate, trapGate, cleaned, gone);
    const started = readFile(ready, "utf8");
    const sawCleaned = readFile(cleaned, "utf8");
    const holderGone = readFile(gone, "utf8");
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
      await writeFile(gate, "go\n");
      expect(await trapSup.result).toBe(0);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await writeFile(trapGate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await holderGone).toBe("");
      await trapSup.advance();
      expect(await trapSup.proc.exited).not.toBe(0);
    } finally {
      trapSup.cleanup();
    }

    const dir2 = temp.make("sup-orphan-");
    const [ready2, gate2, gone2] = [join(dir2, "ready"), join(dir2, "gate"), join(dir2, "gone")];
    mkfifo(ready2, gate2, gone2);
    const started2 = readFile(ready2, "utf8");
    const holderGone2 = readFile(gone2, "utf8");
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
      await writeFile(gate2, "go\n");
      expect(await stubbornSup.result).toBe(0);
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await stubbornSup.advance();
      expect(await holderGone2).toBe("");
      expect(await stubbornSup.proc.exited).not.toBe(0);
    } finally {
      stubbornSup.cleanup();
    }
  });
});
