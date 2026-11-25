import { closeSync, writeSync } from "node:fs";
import { killSessionSync } from "./probe-supervisor.ts";

type WatchEntry = { pid: number; targetPid?: number; fd: number; delayMs: number };

const alive = (fd: number) => {
  try {
    writeSync(fd, "\n");
    return true;
  } catch {
    return false;
  }
};

const close = (fd: number) => {
  try {
    closeSync(fd);
  } catch {}
};

async function isDirectChild(parentPid: number, childPid: number): Promise<boolean> {
  try {
    const ps = Bun.spawn(["ps", "-o", "ppid=", "-p", String(childPid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    return code === 0 && Number(text.trim()) === parentPid;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  let entries: WatchEntry[] = [];
  try {
    const parsed = JSON.parse(Bun.argv[2] ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (item): item is WatchEntry =>
          !!item &&
          typeof item === "object" &&
          typeof (item as WatchEntry).pid === "number" &&
          typeof (item as WatchEntry).fd === "number" &&
          typeof (item as WatchEntry).delayMs === "number",
      );
    }
  } catch {}
  const started = performance.now();
  const pending = new Set(entries);
  while (pending.size > 0) {
    const elapsed = performance.now() - started;
    let nextWake = Number.POSITIVE_INFINITY;
    for (const entry of [...pending]) {
      if (!alive(entry.fd)) {
        close(entry.fd);
        pending.delete(entry);
        continue;
      }
      const left = entry.delayMs - elapsed;
      if (left <= 0) {
        if (alive(entry.fd)) {
          const verifiedTarget =
            process.platform !== "linux" && typeof entry.targetPid === "number" && (await isDirectChild(entry.pid, entry.targetPid))
              ? entry.targetPid
              : undefined;
          if (alive(entry.fd)) {
            killSessionSync(entry.pid, "SIGKILL", verifiedTarget);
            try {
              process.kill(entry.pid, "SIGKILL");
            } catch {}
          }
        }
        close(entry.fd);
        pending.delete(entry);
      } else if (left < nextWake) {
        nextWake = left;
      }
    }
    if (pending.size > 0) await Bun.sleep(Math.min(25, Math.max(1, Math.ceil(nextWake))));
  }
  process.exit(0);
}
