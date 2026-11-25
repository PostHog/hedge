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
    write("ready");
    return () => { entry.cancelled = true; };
  },
  onSignal: (signal, handler) => void process.on(signal, handler),
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
  const waitArmed = async () => {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl !== -1) {
        buffered = buffered.slice(nl + 1);
        return;
      }
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
    }
  };
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
  return { proc, advance, cleanup };
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

  test("exits with the probe command's exact exit status and cleans up any stray background child on normal exit", async () => {
    const exitSeven = Bun.spawn([process.execPath, supervisorPath, "sh", "-c", "exit 7"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    expect(await exitSeven.exited).toBe(7);

    const dir = temp.make("sup-orphan-");
    const [ready, gate, gone] = [join(dir, "ready"), join(dir, "gate"), join(dir, "gone")];
    mkfifo(ready, gate, gone);
    const started = readFile(ready, "utf8");
    const holderGone = readFile(gone, "utf8");
    const childScript = `exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; exec sleep 30`;
    const proc = Bun.spawn(
      [
        process.execPath,
        supervisorPath,
        "sh",
        "-c",
        'sh -c "$1" & cat "$2" >/dev/null; exit 0',
        "probe",
        childScript,
        gate,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
    );
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);
      await writeFile(gate, "go\n");
      expect(await proc.exited).toBe(0);
      expect(await holderGone).toBe("");
    } finally {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }
  });
});
