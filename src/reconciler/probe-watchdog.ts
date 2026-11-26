import { closeSync, writeSync } from "node:fs";
import { discoverTargets, drainControlFd, emptySpared, killDeadSession, mergeSpared, parseSpareUpdate, probeResultReported, type SerializedSpared, signalTargets, type SparedSet, waitForFdClosed } from "./probe-supervisor.ts";

export type WatchEntry = {
  pid: number;
  fd: number;
  delayMs: number;
  tag?: string;
  reported?: boolean;
  resultFd?: number;
  spared?: SerializedSpared;
  spareFd?: number;
  spareRest?: string;
  holderPid?: number;
  holderFd?: number;
};
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

export async function watchEntries(
  entries: WatchEntry[],
  clock: WatchClock = realClock,
): Promise<void> {
  const started = clock.now();
  const pending = new Set(entries);
  const runnerDead = new Set<WatchEntry>();
  const runnerReported = new Map<WatchEntry, boolean>();
  const resultState = new Map<WatchEntry, "reported" | "closed">();
  const sparedByEntry = new Map<WatchEntry, SparedSet>();
  const spareRestByEntry = new Map<WatchEntry, string>();
  for (const entry of entries) {
    if (entry.reported) resultState.set(entry, "reported");
    const set = emptySpared();
    if (entry.spared) mergeSpared(set, entry.spared.pids, entry.spared.sids);
    sparedByEntry.set(entry, set);
    if (entry.spareRest) spareRestByEntry.set(entry, entry.spareRest);
  }
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
  const drainSpared = (entry: WatchEntry): SparedSet => {
    const set = sparedByEntry.get(entry) ?? emptySpared();
    if (entry.spareFd !== undefined) {
      const drained = drainControlFd(entry.spareFd, spareRestByEntry.get(entry) ?? "");
      spareRestByEntry.set(entry, drained.rest);
      for (const line of drained.lines) {
        const update = parseSpareUpdate(line);
        if (update) mergeSpared(set, update.pids, update.sids);
      }
      if (drained.closed) {
        close(entry.spareFd);
        entry.spareFd = undefined;
        spareRestByEntry.delete(entry);
      }
    }
    return set;
  };
  const closeEntry = (entry: WatchEntry) => {
    if (entry.fd >= 0) {
      close(entry.fd);
      entry.fd = -1;
    }
    if (entry.resultFd !== undefined) {
      close(entry.resultFd);
      entry.resultFd = undefined;
    }
    if (entry.holderFd !== undefined) {
      close(entry.holderFd);
      entry.holderFd = undefined;
    }
    if (entry.spareFd !== undefined) {
      drainSpared(entry);
      if (entry.spareFd !== undefined) {
        close(entry.spareFd);
        entry.spareFd = undefined;
      }
    }
  };
  const holderAlive = (entry: WatchEntry): boolean => {
    if (entry.holderFd === undefined) return false;
    if (drainControlFd(entry.holderFd).closed) {
      close(entry.holderFd);
      entry.holderFd = undefined;
      return false;
    }
    return true;
  };
  const sweepHolder = async (entry: WatchEntry, reported: boolean) => {
    if (!reported && entry.holderPid !== undefined && entry.holderPid !== entry.pid) {
      await killDeadSession(entry.holderPid, entry.tag, false, drainSpared(entry), false);
    }
  };
  const killLiveHolder = async (entry: WatchEntry, reported: boolean) => {
    try {
      if (entry.holderPid !== undefined && entry.holderPid !== entry.pid) {
        if (reported) {
          if (holderAlive(entry)) {
            try {
              process.kill(entry.holderPid, "SIGKILL");
            } catch {}
          }
        } else {
          const spared = drainSpared(entry);
          const targets = await discoverTargets(entry.holderPid, entry.tag, spared, false);
          if (holderAlive(entry)) {
            signalTargets(targets ?? { pids: [], groups: [], orphanPids: [] }, "SIGKILL", entry.holderPid);
            try {
              process.kill(entry.holderPid, "SIGKILL");
            } catch {}
          }
          await killDeadSession(entry.holderPid, entry.tag, false, spared, false);
        }
      }
    } finally {
      closeEntry(entry);
    }
  };
  const sweepDead = async (entry: WatchEntry, reported: boolean, waitHolder = false) => {
    if (reported) {
      if (waitHolder && entry.holderFd !== undefined && holderAlive(entry)) {
        await waitForFdClosed(entry.holderFd, 200);
        if (holderAlive(entry)) {
          await killLiveHolder(entry, true);
        }
      }
      return;
    }
    const spared = drainSpared(entry);
    await killDeadSession(entry.pid, entry.tag, false, spared, false);
    if (waitHolder && entry.holderFd !== undefined && holderAlive(entry)) {
      await waitForFdClosed(entry.holderFd, 200);
      if (holderAlive(entry)) {
        await killLiveHolder(entry, reported);
        return;
      }
    }
    await sweepHolder(entry, reported);
  };
  while (pending.size > 0) {
    const elapsed = clock.now() - started;
    let nextWake = Number.POSITIVE_INFINITY;
    const due: WatchEntry[] = [];
    const dueHolders: Array<{ entry: WatchEntry; reported: boolean }> = [];
    const dead: Array<{ entry: WatchEntry; reported: boolean }> = [];
    const deadRunners: Array<{ entry: WatchEntry; reported: boolean }> = [];
    const deadHolders: Array<{ entry: WatchEntry; reported: boolean }> = [];
    for (const entry of [...pending]) {
      drainSpared(entry);
      if (runnerDead.has(entry)) {
        const reported = runnerReported.get(entry) ?? false;
        if (!holderAlive(entry)) {
          closeEntry(entry);
          pending.delete(entry);
          deadHolders.push({ entry, reported });
          continue;
        }
        const left = entry.delayMs - elapsed;
        if (left <= 0) {
          pending.delete(entry);
          dueHolders.push({ entry, reported });
        } else if (left < nextWake) {
          nextWake = left;
        }
        continue;
      }
      if (!alive(entry.fd)) {
        const reported = resultReported(entry);
        if (entry.fd >= 0) {
          close(entry.fd);
          entry.fd = -1;
        }
        if (entry.resultFd !== undefined) {
          close(entry.resultFd);
          entry.resultFd = undefined;
        }
        runnerDead.add(entry);
        runnerReported.set(entry, reported);
        if (!holderAlive(entry)) {
          closeEntry(entry);
          pending.delete(entry);
          dead.push({ entry, reported });
        } else {
          deadRunners.push({ entry, reported });
          const left = entry.delayMs - elapsed;
          if (left <= 0) {
            pending.delete(entry);
            dueHolders.push({ entry, reported });
          } else if (left < nextWake) {
            nextWake = left;
          }
        }
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
    if (deadRunners.length > 0) {
      await Promise.all(
        deadRunners.map(async ({ entry, reported }) => {
          if (reported) return;
          await killDeadSession(entry.pid, entry.tag, false, drainSpared(entry), false);
        }),
      );
    }
    if (dead.length > 0) {
      await Promise.all(dead.map(({ entry, reported }) => sweepDead(entry, reported)));
    }
    if (deadHolders.length > 0) {
      await Promise.all(deadHolders.map(({ entry, reported }) => sweepHolder(entry, reported)));
    }
    if (dueHolders.length > 0) {
      await Promise.all(dueHolders.map(({ entry, reported }) => killLiveHolder(entry, reported)));
    }
    if (due.length > 0) {
      await Promise.all(
        due.map(async (entry) => {
          try {
            if (alive(entry.fd)) {
              const initialReported = resultReported(entry);
              if (!initialReported) {
                const spared = drainSpared(entry);
                const targets = await discoverTargets(entry.pid, entry.tag, spared, false);
                if (alive(entry.fd) && !resultReported(entry)) {
                  signalTargets(targets ?? { pids: [], groups: [], orphanPids: [] }, "SIGKILL", entry.pid);
                  try {
                    process.kill(entry.pid, "SIGKILL");
                  } catch {}
                  await sweepDead(entry, resultReported(entry), true);
                } else {
                  if (alive(entry.fd)) {
                    try {
                      process.kill(entry.pid, "SIGKILL");
                    } catch {}
                  }
                  await sweepDead(entry, resultReported(entry), true);
                }
              } else {
                if (alive(entry.fd)) {
                  try {
                    process.kill(entry.pid, "SIGKILL");
                  } catch {}
                }
                await sweepDead(entry, true, true);
              }
            } else {
              await sweepDead(entry, resultReported(entry), true);
            }
          } finally {
            closeEntry(entry);
          }
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
          ((item as WatchEntry).reported === undefined || typeof (item as WatchEntry).reported === "boolean") &&
          ((item as WatchEntry).resultFd === undefined || typeof (item as WatchEntry).resultFd === "number") &&
          ((item as WatchEntry).spareFd === undefined || typeof (item as WatchEntry).spareFd === "number") &&
          ((item as WatchEntry).spareRest === undefined || typeof (item as WatchEntry).spareRest === "string") &&
          ((item as WatchEntry).holderPid === undefined || typeof (item as WatchEntry).holderPid === "number") &&
          ((item as WatchEntry).holderFd === undefined || typeof (item as WatchEntry).holderFd === "number"),
      );
    }
  } catch {}
  await watchEntries(entries);
  process.exit(0);
}
