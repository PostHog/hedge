import { closeSync, writeSync } from "node:fs";
import { discoverTargets, probeResultReported, signalTargets } from "./probe-supervisor.ts";

export type WatchEntry = { pid: number; fd: number; delayMs: number; tag?: string; resultFd?: number };
export type WatchClock = { now: () => number; sleep: (ms: number) => Promise<void> };

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

const realClock: WatchClock = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export async function watchEntries(entries: WatchEntry[], clock: WatchClock = realClock): Promise<void> {
  const started = clock.now();
  const pending = new Set(entries);
  const resultState = new Map<WatchEntry, "reported" | "closed">();
  const resultReported = (entry: WatchEntry): boolean => {
    const known = resultState.get(entry);
    if (known === "reported") return true;
    if (known === "closed" || entry.resultFd === undefined) return false;
    const state = probeResultReported(entry.resultFd);
    if (state === "reported") {
      resultState.set(entry, "reported");
      close(entry.resultFd);
      entry.resultFd = undefined;
      return true;
    }
    if (state === "closed") {
      resultState.set(entry, "closed");
      close(entry.resultFd);
      entry.resultFd = undefined;
    }
    return false;
  };
  const closeEntry = (entry: WatchEntry) => {
    close(entry.fd);
    if (entry.resultFd !== undefined) {
      close(entry.resultFd);
      entry.resultFd = undefined;
    }
  };
  while (pending.size > 0) {
    const elapsed = clock.now() - started;
    let nextWake = Number.POSITIVE_INFINITY;
    const due: WatchEntry[] = [];
    const dead: WatchEntry[] = [];
    for (const entry of [...pending]) {
      if (!alive(entry.fd)) {
        const reported = resultReported(entry);
        closeEntry(entry);
        pending.delete(entry);
        if (entry.tag && !reported) dead.push(entry);
        continue;
      }
      const left = entry.delayMs - elapsed;
      if (left <= 0) {
        due.push(entry);
        pending.delete(entry);
      } else if (left < nextWake) {
        nextWake = left;
      }
    }
    if (dead.length > 0) {
      await Promise.all(
        dead.map(async (entry) => {
          const tagged = await discoverTargets(undefined, entry.tag);
          if (tagged) signalTargets(tagged, "SIGKILL");
        }),
      );
    }
    if (due.length > 0) {
      await Promise.all(
        due.map(async (entry) => {
          if (alive(entry.fd)) {
            const initialTag = entry.tag && !resultReported(entry) ? entry.tag : undefined;
            let targets = await discoverTargets(entry.pid, initialTag);
            if (alive(entry.fd)) {
              if (initialTag && resultReported(entry)) {
                targets = await discoverTargets(entry.pid, undefined);
              }
              if (alive(entry.fd)) {
                signalTargets(targets ?? { pids: [], groups: [], orphanPids: [] }, "SIGKILL", entry.pid);
                try {
                  process.kill(entry.pid, "SIGKILL");
                } catch {}
              } else if (entry.tag && !resultReported(entry)) {
                const tagged = await discoverTargets(undefined, entry.tag);
                if (tagged) signalTargets(tagged, "SIGKILL");
              }
            } else if (entry.tag && !resultReported(entry)) {
              const tagged = await discoverTargets(undefined, entry.tag);
              if (tagged) signalTargets(tagged, "SIGKILL");
            }
          } else if (entry.tag && !resultReported(entry)) {
            const tagged = await discoverTargets(undefined, entry.tag);
            if (tagged) signalTargets(tagged, "SIGKILL");
          }
          closeEntry(entry);
        }),
      );
      continue;
    }
    if (pending.size > 0) await clock.sleep(Math.min(25, Math.max(1, Math.ceil(nextWake))));
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
          typeof (item as WatchEntry).delayMs === "number" &&
          ((item as WatchEntry).resultFd === undefined || typeof (item as WatchEntry).resultFd === "number"),
      );
    }
  } catch {}
  await watchEntries(entries);
  process.exit(0);
}
