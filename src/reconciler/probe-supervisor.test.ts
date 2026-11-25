import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { graceMs, interruptGraceMs } from "./probe-supervisor.ts";

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
  timer: (ms, fire) => {
    const entry = { ms, fire, cancelled: false };
    timers.push(entry);
    write("armed " + ms);
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
  const nextLine = async () => {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffered += decoder.decode(value, { stream: true });
    }
  };
  const tick = () => {
    proc.stdin.write("tick\n");
    proc.stdin.flush();
  };
  const cleanup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    proc.kill("SIGKILL");
  };
  return { proc, nextLine, tick, cleanup };
}

function mkfifo(...paths: string[]) {
  expect(Bun.spawnSync(["mkfifo", ...paths]).exitCode).toBe(0);
}

describe("probe supervisor", () => {
  for (const sig of ["SIGINT", "SIGQUIT"] as const) {
    test(`escalates real ${sig} through SIGTERM to SIGKILL on a probe ignoring ${sig} under a controlled clock`, async () => {
      const dir = temp.make("sup-esc-");
      const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
      mkfifo(ready, gone);
      const started = readFile(ready, "utf8");
      const holderGone = readFile(gone, "utf8");
      const sup = spawnControlledSupervisor([
        "sh",
        "-c",
        `trap "" INT QUIT TERM; exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; exec sleep 30`,
      ]);
      try {
        const pid = Number((await started).trim());
        expect(pid).toBeGreaterThan(0);

        sup.proc.kill(sig);
        expect(await sup.nextLine()).toBe(`armed ${interruptGraceMs}`);
        expect(() => process.kill(pid, 0)).not.toThrow();

        sup.tick();
        expect(await sup.nextLine()).toBe(`armed ${graceMs}`);
        expect(() => process.kill(pid, 0)).not.toThrow();

        sup.tick();
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
    const childScript = `trap 'cat ${JSON.stringify(gate)} >/dev/null; echo cleaned > ${JSON.stringify(cleaned)}; exit 0' TERM; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 & wait`;
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
      expect(await sup.nextLine()).toBe(`armed ${graceMs}`);
      expect(await leaderClosed).toBe("");
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await writeFile(gate, "go\n");
      expect((await sawCleaned).trim()).toBe("cleaned");
      expect(await childClosed).toBe("");

      sup.tick();
      expect(await sup.proc.exited).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("lets a real probe finish its SIGINT trap and gives its descendant grace time on SIGTERM", async () => {
    const dir = temp.make("sup-int-");
    const [ready, leaderCleaned, gate, childCleaned, childGone] = [
      join(dir, "ready"),
      join(dir, "leader-cleaned"),
      join(dir, "gate"),
      join(dir, "child-cleaned"),
      join(dir, "child-gone"),
    ];
    mkfifo(ready, leaderCleaned, gate, childCleaned, childGone);
    const started = readFile(ready, "utf8");
    const sawLeader = readFile(leaderCleaned, "utf8");
    const sawChild = readFile(childCleaned, "utf8");
    const childClosed = readFile(childGone, "utf8");
    const childScript = `trap "" INT; trap 'cat ${JSON.stringify(gate)} >/dev/null; echo child-done > ${JSON.stringify(childCleaned)}; exit 0' TERM; exec 3>${JSON.stringify(childGone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 & wait`;
    const sup = spawnControlledSupervisor([
      "sh",
      "-c",
      'trap \'echo leader-done > "$1"; exit 130\' INT; sh -c "$2" & wait',
      "probe",
      leaderCleaned,
      childScript,
    ]);
    try {
      const childPid = Number((await started).trim());
      expect(childPid).toBeGreaterThan(0);

      sup.proc.kill("SIGINT");
      expect(await sup.nextLine()).toBe(`armed ${interruptGraceMs}`);
      expect((await sawLeader).trim()).toBe("leader-done");
      expect(await sup.nextLine()).toBe(`armed ${graceMs}`);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await writeFile(gate, "go\n");
      expect((await sawChild).trim()).toBe("child-done");
      expect(await childClosed).toBe("");

      sup.tick();
      expect(await sup.proc.exited).not.toBe(0);
    } finally {
      sup.cleanup();
    }
  });

  test("exits with the probe command's exact exit status when no stop signal arrives", async () => {
    const proc = Bun.spawn([process.execPath, supervisorPath, "sh", "-c", "exit 7"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    expect(await proc.exited).toBe(7);
  });
});
