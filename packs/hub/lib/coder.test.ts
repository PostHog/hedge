import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { withBoxLock } from "./box-lock.ts";
import { capture, captureWith, Coder, grant, reap, timedOut, type Box, type Capture, type Timer } from "./coder.ts";
import { appeared } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const ok = { code: 0, stdout: "", stderr: "" };
const settings = { coderUrl: "https://coder.example.com", template: "linux-box" };

function homeWith(files: Record<string, string>) {
  const home = temp.make("hedge-coder-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), content);
  }
  return home;
}

function recording() {
  const calls: string[][] = [];
  const capture: Capture = async (argv) => {
    calls.push(argv);
    return ok;
  };
  return { calls, capture };
}

test("the Coder session comes from the environment first, then Hedge's session files, then the Coder CLI's", () => {
  const both = { ".config/hedge/coder-session": "hedge-token\n", ".config/hedge/coder-url": "https://hedge.example.com\n", ".config/coderv2/session": "cli-token\n", ".config/coderv2/url": "https://cli.example.com\n" };
  const fromEnv = new Coder({ ...settings, home: homeWith(both), env: { CODER_SESSION_TOKEN: "env-token", CODER_URL: "https://env.example.com" } });
  expect([fromEnv.env.CODER_SESSION_TOKEN, fromEnv.env.CODER_URL]).toEqual(["env-token", "https://env.example.com"]);
  const fromHedge = new Coder({ ...settings, home: homeWith(both), env: {} });
  expect([fromHedge.env.CODER_SESSION_TOKEN, fromHedge.env.CODER_URL]).toEqual(["hedge-token", "https://hedge.example.com"]);
  const fromCli = new Coder({ ...settings, home: homeWith({ ".config/coderv2/session": "cli-token\n", ".config/coderv2/url": "https://cli.example.com\n" }), env: {} });
  expect([fromCli.env.CODER_SESSION_TOKEN, fromCli.env.CODER_URL]).toEqual(["cli-token", "https://cli.example.com"]);
});

test("without a Coder URL in the environment or a session file, the hub.coderUrl setting is the address", () => {
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "env-token" } });
  expect(coder.env.CODER_URL).toBe("https://coder.example.com");
});

test("without a coder CLI on PATH, it downloads one from the Coder address only when a command needs it, and installs it only once complete", async () => {
  const home = homeWith({});
  const { calls, capture: record } = recording();
  const capture: Capture = async (argv, options) => {
    if (argv[0] === "curl") writeFileSync(argv[3]!, "coder binary");
    return record(argv, options);
  };
  const coder = new Coder({ ...settings, home, env: { PATH: join(home, "empty") }, capture });
  expect(calls).toEqual([]);
  await coder.ssh("box-lane", "true");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  expect(calls[0]).toEqual(["curl", "-fsSL", "-o", expect.stringMatching(/\/\.local\/bin\/\.coder\.[0-9a-f-]{36}$/), `https://coder.example.com/bin/coder-linux-${arch}`]);
  expect(calls[1]).toEqual([join(home, ".local/bin/coder"), "ssh", "--disable-autostart", "--wait=no", "box-lane", "--", "true"]);
  expect(readFileSync(join(home, ".local/bin/coder"), "utf8")).toBe("coder binary");
});

test("a new box starts from the hub.boxTemplate template with the spawning devbox's parameters and the configured disk", async () => {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const answers: Record<string, unknown> = {
    "/api/v2/templates": [{ id: "tpl-other", name: "other", active_version_id: "v-other" }, { id: "tpl-1", name: "linux-box", active_version_id: "v-1" }],
    "/api/v2/templateversions/v-1/rich-parameters": [{ name: "region" }, { name: "disk_size" }],
    "/api/v2/users/me/workspace/devbox-1": { id: "ws-1", latest_build: { id: "build-1" } },
    "/api/v2/workspacebuilds/build-1/parameters": [{ name: "region", value: "eu" }, { name: "dropped", value: "x" }, { name: "disk_size", value: "50" }],
    "/api/v2/users/me/workspaces": { id: "ws-new" },
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://coder.example.com", "");
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(answers[path]);
  }) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  expect(await coder.create("box-lane", "devbox-1", 120)).toBe("ws-new");
  expect(requests.at(-1)).toEqual({
    path: "/api/v2/users/me/workspaces",
    body: { name: "box-lane", template_id: "tpl-1", rich_parameter_values: [{ name: "region", value: "eu" }, { name: "disk_size", value: "120" }], ttl_ms: 2 * 3_600_000 },
  });
});

test("the reaper deletes only boxes that stopped, failed, or were cancelled and went unused for the given days, and rechecks each before it deletes", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const box = (name: string, status: string, lastUsedAt: string): Box => ({ name, id: `ws-${name}`, template: "linux-box", status, lastUsedAt });
  const listed = [box("box-old", "stopped", daysAgo(4)), box("box-busy", "running", daysAgo(4)), box("box-recent", "stopped", daysAgo(1)), box("box-woke", "stopped", daysAgo(4)), box("box-failed", "failed", daysAgo(4)), box("box-canceled", "canceled", daysAgo(4))];
  const current = listed.map((entry) => (entry.name === "box-woke" ? { ...entry, status: "starting" } : entry));
  const removed: string[] = [];
  let reads = 0;
  const coder = { boxes: async () => (reads++ === 0 ? listed : current) };
  const remove = async (name: string) => {
    removed.push(name);
    return 0;
  };
  const print = () => {};
  await reap(coder, { days: 3, dryRun: true, now, print }, remove);
  expect(removed).toEqual([]);
  reads = 0;
  await reap(coder, { days: 3, dryRun: false, now, print }, remove);
  expect(removed).toEqual(["box-old", "box-failed", "box-canceled"]);
});

test("a grant mints a dated token, writes the URL and token on the devbox over stdin, and only then removes the older tokens", async () => {
  const now = Date.parse("2026-11-01T12:34:00Z");
  const tokens: string[][] = [];
  const coder = {
    env: { CODER_URL: "https://coder.example.com" },
    token: async (args: string[]) => {
      tokens.push(args);
      return args[0] === "list" ? JSON.stringify([{ id: "k1", token_name: "hedge-devbox-1-202610010000-abcd", expires_at: "2026-11-02T00:00:00Z" }, { id: "k2", token_name: "someone-else", expires_at: "2026-12-01T00:00:00Z" }]) : "new-secret\n";
    },
  };
  const written: Array<{ command: string; stdin?: string }> = [];
  const onDevbox = async (_target: string, command: string, stdin?: string) => {
    written.push({ command, stdin });
    return ok;
  };
  expect(await grant(coder, "devbox-1", { ifExpiring: true, now, onDevbox, print: () => {} })).toBe(0);
  expect(tokens[1]?.slice(0, 3)).toEqual(["create", "--name", expect.stringMatching(/^hedge-devbox-1-202611011234-[0-9a-f]{4}$/)]);
  expect(written.map((call) => call.stdin)).toEqual([undefined, "https://coder.example.com\n", "new-secret\n"]);
  expect(written.map((call) => call.command).join("\n")).not.toContain("new-secret");
  expect(tokens.at(-1)).toEqual(["remove", "hedge-devbox-1-202610010000-abcd"]);
});

test("a grant with --if-expiring keeps a token that lasts more than a week", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const coder = { env: {}, token: async () => JSON.stringify([{ id: "k1", token_name: "hedge-devbox-1-202610010000-abcd", expires_at: "2026-11-20T00:00:00Z" }]) };
  const onDevbox = async () => ({ ...ok, stdout: "k1\n" });
  const lines: string[] = [];
  expect(await grant(coder, "devbox-1", { ifExpiring: true, now, onDevbox, print: (line) => lines.push(line) })).toBe(0);
  expect(lines).toEqual(["hedge-devbox-1-202610010000-abcd: still valid until 2026-11-20T00:00:00Z"]);
});

test("the reaper goes on after a failed delete and fails at the end, so the nightly job does not report success", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const old = new Date(now - 4 * 86_400_000).toISOString();
  const listed: Box[] = ["box-a", "box-b", "box-c"].map((name) => ({ name, id: `ws-${name}`, template: "linux-box", status: "stopped", lastUsedAt: old }));
  const tried: string[] = [];
  const remove = async (name: string) => {
    tried.push(name);
    if (name === "box-b") throw new Error("coder delete failed");
    return name === "box-a" ? 1 : 0;
  };
  const lines: string[] = [];
  expect(await reap({ boxes: async () => listed }, { days: 3, dryRun: false, now, print: (line) => lines.push(line) }, remove)).toBe(1);
  expect(tried).toEqual(["box-a", "box-b", "box-c"]);
  expect(lines).toContain("box-b: coder delete failed");
  expect(await reap({ boxes: async () => listed }, { days: 3, dryRun: false, now, print: () => {} }, async () => 0)).toBe(0);
});

function sandboxBin(scripts: Record<string, string>) {
  const bin = temp.make("hedge-bin-");
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

test("the readiness calls pass their time limit down to the coder process", async () => {
  const limits: Array<number | undefined> = [];
  const capture: Capture = async (argv, options) => {
    limits.push(options?.timeoutMs);
    return { ...ok, stdout: argv.includes("list") ? "[]" : "" };
  };
  const bin = sandboxBin({ coder: "exit 0" });
  const coder = new Coder({ ...settings, home: homeWith({}), env: { PATH: bin, CODER_SESSION_TOKEN: "t" }, capture });
  await coder.sshAfterStartup("box-lane", "true", 4000);
  await coder.ssh("box-lane", "test -f x", undefined, 3000);
  await coder.boxes(2000);
  expect(limits).toHaveLength(3);
  for (const [index, limit] of [4000, 3000, 2000].entries()) {
    expect(limits[index]).toBeLessThanOrEqual(limit);
    expect(limits[index]).toBeGreaterThan(limit - 500);
  }
});

test("downloading the coder CLI never writes through a file planted at a temporary name", async () => {
  const home = homeWith({ victim: "keep\n" });
  const target = join(home, ".local/bin/coder");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(join(home, "victim"), `${target}.${process.pid}.partial`);
  const capture: Capture = async (argv) => {
    if (argv[0] === "curl") writeFileSync(argv[3]!, "coder binary");
    return ok;
  };
  const coder = new Coder({ ...settings, home, env: { PATH: join(home, "empty") }, capture });
  await coder.ssh("box-lane", "true");
  expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("coder binary");
});

function handTimer() {
  const pending: Array<{ ms: number; fire(): void }> = [];
  const timer: Timer = (ms, fire) => {
    const entry = { ms, fire };
    pending.push(entry);
    return () => {
      if (pending.includes(entry)) pending.splice(pending.indexOf(entry), 1);
    };
  };
  return { timer, pending, fire: () => pending.splice(0).forEach((entry) => entry.fire()) };
}

const announce = (file: string, what = "$$") => `echo ${what} > ${file}.tmp && /bin/mv ${file}.tmp ${file}`;
const hangs = "exec /bin/sleep 30";

test("a command with a time limit is killed when its timer fires, and reports the timeout", async () => {
  const ready = join(temp.make("hedge-ready-"), "ready");
  const bin = sandboxBin({ hang: `${announce(ready)}\n${hangs}` });
  const clock = handTimer();
  const result = captureWith(clock.timer)([join(bin, "hang")], { timeoutMs: 20 });
  await appeared(ready);
  expect(clock.pending.map((entry) => entry.ms)).toEqual([20]);
  clock.fire();
  expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 20 ms" });
});

test("a command that ends in time cancels its timer and keeps its output", async () => {
  const clock = handTimer();
  const bin = sandboxBin({ say: "echo said; echo warned >&2; exit 3" });
  expect(await captureWith(clock.timer)([join(bin, "say")], { timeoutMs: 1000 })).toEqual({ code: 3, stdout: "said\n", stderr: "warned\n" });
  expect(clock.pending).toEqual([]);
});

test("downloading the coder CLI counts against the call's time limit, so a hanging download cannot outlast a readiness wait", async () => {
  const ready = join(temp.make("hedge-ready-"), "ready");
  const bin = sandboxBin({ curl: `${announce(ready)}\n${hangs}` });
  const home = homeWith({});
  const clock = handTimer();
  const coder = new Coder({ ...settings, home, env: { PATH: bin, CODER_SESSION_TOKEN: "t" }, capture: captureWith(clock.timer) });
  const result = coder.sshAfterStartup("box-lane", "true", 50);
  await appeared(ready);
  expect(clock.pending[0]?.ms).toBeLessThanOrEqual(50);
  clock.fire();
  expect((await result).code).toBe(124);
  expect(readdirSync(join(home, ".local/bin"))).toEqual([]);
});

for (const locked of [false, true]) {
  test(`a timeout kills the whole process group, including a child the shell started without exec${locked ? ", also under a box lock" : ""}`, async () => {
    const held = join(temp.make("hedge-fifo-"), "held");
    expect(Bun.spawnSync(["mkfifo", held]).exitCode).toBe(0);
    const bin = sandboxBin({ spawner: `sh -c 'echo up; exec tail -f /dev/null' > ${held} 2>/dev/null &\nwait` });
    const reader = Bun.spawn(["cat", held], { stdout: "pipe" });
    const clock = handTimer();
    const run = () => captureWith(clock.timer)([join(bin, "spawner")], { timeoutMs: 50 });
    const result = locked ? withBoxLock(temp.make("hedge-lock-"), "box-a", { waitMs: 0 }, run) : run();
    const lines = reader.stdout.getReader();
    expect(new TextDecoder().decode((await lines.read()).value)).toBe("up\n");
    clock.fire();
    expect((await result).code).toBe(124);
    expect(await lines.read()).toEqual({ done: true, value: undefined });
    expect(await reader.exited).toBe(0);
  });
}

test("starting a box gives every Coder API request of the start one time limit", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    const path = url.replace("https://coder.example.com", "");
    const answers: Record<string, unknown> = { "/api/v2/templates": [{ id: "tpl-1", name: "linux-box", active_version_id: "v-1" }], "/api/v2/templateversions/v-1/rich-parameters": [] };
    return Response.json(answers[path] ?? { id: "ws-1" });
  }) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  await coder.start("ws-1", 60_000, { update: true });
  expect(signals).toHaveLength(3);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
});

test("stop, delete, start and extend address the workspace by the id the pool recorded, through the Coder API, each with a time limit", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown; limited: boolean }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", path: url.replace("https://coder.example.com", ""), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), limited: init?.signal instanceof AbortSignal });
    return Response.json({});
  }) as unknown as typeof fetch;
  const { calls, capture } = recording();
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher, capture });
  await coder.stop("ws-1");
  await coder.remove("ws-2", 1000);
  await coder.start("ws-3", 1000);
  await coder.extend("ws-4", "2026-11-01T02:00:00.000Z");
  expect(requests).toEqual([
    { method: "POST", path: "/api/v2/workspaces/ws-1/builds", body: { transition: "stop" }, limited: true },
    { method: "POST", path: "/api/v2/workspaces/ws-2/builds", body: { transition: "delete" }, limited: true },
    { method: "POST", path: "/api/v2/workspaces/ws-3/builds", body: { transition: "start" }, limited: true },
    { method: "PUT", path: "/api/v2/workspaces/ws-4/extend", body: { deadline: "2026-11-01T02:00:00.000Z" }, limited: true },
  ]);
  expect(calls).toEqual([]);
});

test("creating a box has a time limit on every Coder API request", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const answers: Record<string, unknown> = {
    "/api/v2/templates": [{ id: "tpl-1", name: "linux-box", active_version_id: "v-1" }],
    "/api/v2/templateversions/v-1/rich-parameters": [],
    "/api/v2/users/me/workspace/devbox-1": { id: "ws-1", latest_build: { id: "build-1" } },
    "/api/v2/workspacebuilds/build-1/parameters": [],
    "/api/v2/users/me/workspaces": { id: "ws-new" },
  };
  const fetcher = (async (url: string, init?: RequestInit) => (signals.push(init?.signal ?? undefined), Response.json(answers[url.replace("https://coder.example.com", "")]))) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  expect(await coder.create("box-lane", "devbox-1", 120)).toBe("ws-new");
  expect(signals).toHaveLength(5);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
});

test("a call that hands its output through to the caller still has a time limit and kills its process group", async () => {
  const ready = join(temp.make("hedge-ready-"), "ready");
  const bin = sandboxBin({ hang: `${announce(ready)}\n${hangs}` });
  const clock = handTimer();
  const result = captureWith(clock.timer)([join(bin, "hang")], { timeoutMs: 30, inherit: true });
  await appeared(ready);
  expect(clock.pending.map((entry) => entry.ms)).toEqual([30]);
  clock.fire();
  expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
});

test("captures stdout cleanly under a box lock without waiting for the timeout", async () => {
  const result = await withBoxLock(temp.make("hedge-lock-"), "box-ok", { waitMs: 0 }, () =>
    captureWith(handTimer().timer)(["sh", "-c", 'printf "locked-ok"'], { timeoutMs: 5_000 }),
  );
  expect(result).toEqual({ code: 0, stdout: "locked-ok", stderr: "" });
});

test("strips a leading UTF-8 BOM from captured output so JSON callers parse it", async () => {
  const result = await captureWith(handTimer().timer)(["sh", "-c", 'printf "\\357\\273\\277{\\"ok\\":true}"'], { timeoutMs: 5_000 });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});

test("stops a descendant holding stdout open and returns at the time limit after the command exits", async () => {
  const dir = temp.make("hedge-pipe-");
  const [ready, gone, leaderGone] = [join(dir, "ready"), join(dir, "gone"), join(dir, "leader-gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, leaderGone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const commandExited = Bun.file(leaderGone).text();
  const clock = handTimer();
  const result = captureWith(clock.timer)(["sh", "-c", `exec 4>${JSON.stringify(leaderGone)}; { sleep 30 4>&- & } 3>${JSON.stringify(gone)}; echo $! > ${JSON.stringify(ready)}`], { timeoutMs: 30 });
  const childPid = Number((await started).trim());
  expect(await commandExited).toBe("");
  try {
    clock.fire();
    expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("terminates its detached child process group when the parent receives SIGTERM", async () => {
  const dir = temp.make("hedge-term-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const runner = Bun.spawn([process.execPath, "-e", `import { capture } from ${JSON.stringify(join(import.meta.dir, "coder.ts"))}; await capture(["sh", "-c", '{ sleep 30 & } 3>"$1"; echo $! > "$2"; wait', "probe", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { timeoutMs: 30_000 });`], { stdout: "ignore", stderr: "ignore" });
  const holderGone = Bun.file(gone).text();
  const childPid = Number((await Bun.file(ready).text()).trim());
  try {
    runner.kill("SIGTERM");
    expect(await holderGone).toBe("");
    expect(await runner.exited).not.toBe(0);
  } finally {
    runner.kill("SIGKILL");
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("terminates a descendant holding stdout open on SIGTERM even after the command leader exits", async () => {
  const dir = temp.make("hedge-term-pipe-");
  const [ready, gone, leaderGone] = [join(dir, "ready"), join(dir, "gone"), join(dir, "leader-gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, leaderGone]).exitCode).toBe(0);
  const runner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { capture } from ${JSON.stringify(join(import.meta.dir, "coder.ts"))}; await capture(["sh", "-c", 'exec 4>"$3"; { sleep 30 4>&- & } 3>"$1"; echo $! > "$2"', "probe", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}, ${JSON.stringify(leaderGone)}], { timeoutMs: 30_000 });`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const holderGone = Bun.file(gone).text();
  const leaderClosed = Bun.file(leaderGone).text();
  const childPid = Number((await Bun.file(ready).text()).trim());
  expect(await leaderClosed).toBe("");
  try {
    runner.kill("SIGTERM");
    expect(await holderGone).toBe("");
    expect(await runner.exited).not.toBe(0);
  } finally {
    runner.kill("SIGKILL");
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("stops cleanly on timeout without hanging when a separate-group descendant keeps stdout open", async () => {
  const dir = temp.make("hedge-detached-");
  const [ready, gone, leaderGone] = [join(dir, "ready"), join(dir, "gone"), join(dir, "leader-gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, leaderGone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const leaderClosed = Bun.file(leaderGone).text();
  const clock = handTimer();
  const leaderScript = `import { openSync, writeFileSync } from "node:fs";
openSync(${JSON.stringify(leaderGone)}, "w");
const child = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
child.unref();
process.exit(0);`;
  const result = captureWith(clock.timer)([process.execPath, "-e", leaderScript], { timeoutMs: 30 });
  const childPid = Number((await started).trim());
  expect(await leaderClosed).toBe("");
  try {
    clock.fire();
    expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (childPid > 0) try { process.kill(-childPid, "SIGKILL"); } catch {}
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("stops a nested capture descendant when the outer capture times out", async () => {
  const dir = temp.make("hedge-nested-tag-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const holderGone = Bun.file(gone).text();
  const started = Bun.file(ready).text();
  const clock = handTimer();
  const nestedScript = `import { capture } from ${JSON.stringify(join(import.meta.dir, "coder.ts"))};
await capture(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "worker", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { timeoutMs: 30_000 });`;
  let workerPid = 0;
  try {
    const outer = captureWith(clock.timer)([process.execPath, "-e", nestedScript], { timeoutMs: 30 });
    workerPid = Number((await started).trim());
    expect(workerPid).toBeGreaterThan(0);
    clock.fire();
    expect(await outer).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
  }
});

test("isolates capture supervisor from target BUN_OPTIONS and flushes oversized spawn errors", async () => {
  const okRes = await capture(["sh", "-c", "printf ok"], {
    env: { ...process.env, BUN_OPTIONS: "--preload /nonexistent-hedge-review-preload.ts" },
    timeoutMs: 5_000,
  });
  expect(okRes).toEqual({ code: 0, stdout: "ok", stderr: "" });

  const hugeMissing = `/${"a".repeat(256 * 1024)}/no-such-bin`;
  await expect(capture([hugeMissing], { timeoutMs: 5_000 })).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ENAMETOOLONG/) });
});

test("stops an env -i child in a separate process group after its timeout leader exits while stdout stays open", async () => {
  const timeoutBin = Bun.which("gtimeout") ?? Bun.which("timeout");
  if (!timeoutBin) return;
  const dir = temp.make("hedge-timeout-envi-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const clock = handTimer();
  let childPid = 0;
  try {
    const result = captureWith(clock.timer)(
      [timeoutBin, "10", "sh", "-c", 'env -i sh -c \'exec 3>"$1"; echo $$ > "$2"; exec sleep 30\' worker "$1" "$2" &', "leader", gone, ready],
      { timeoutMs: 30 },
    );
    childPid = Number((await started).trim());
    expect(childPid).toBeGreaterThan(0);
    clock.fire();
    expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("kills a background child holding stdout open after the command exits under a box lock", async () => {
  const dir = temp.make("hedge-lock-pipe-");
  const [ready, gone, leaderGone] = [join(dir, "ready"), join(dir, "gone"), join(dir, "leader-gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, leaderGone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const leaderClosed = Bun.file(leaderGone).text();
  const clock = handTimer();
  const result = withBoxLock(temp.make("hedge-lock-"), "box-pipe", { waitMs: 0 }, () =>
    captureWith(clock.timer)(
      ["sh", "-c", `exec 4>${JSON.stringify(leaderGone)}; { sleep 30 4>&- & } 3>${JSON.stringify(gone)}; echo $! > ${JSON.stringify(ready)}`],
      { timeoutMs: 30 },
    ),
  );
  const childPid = Number((await started).trim());
  expect(await leaderClosed).toBe("");
  try {
    clock.fire();
    expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("wakes and kills a command that suspends its own process group, both unlocked and under a box lock", async () => {
  for (const locked of [false, true]) {
    const lockHome = temp.make("hedge-lock-stop-");
    const dir = temp.make("hedge-stop-group-");
    const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
    expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
    const started = Bun.file(ready).text();
    const holderGone = Bun.file(gone).text();
    const clock = handTimer();
    const run = () =>
      captureWith(clock.timer)(
        ["sh", "-c", `exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; kill -STOP 0`],
        { timeoutMs: 30 },
      );
    const result = locked ? withBoxLock(lockHome, "box-stop", { waitMs: 0 }, run) : run();
    const cmdPid = Number((await started).trim());
    expect(cmdPid).toBeGreaterThan(0);
    try {
      clock.fire();
      expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
      expect(await holderGone).toBe("");
      if (locked) {
        expect(await withBoxLock(lockHome, "box-stop", { waitMs: 0 }, async () => "free")).toBe("free");
      }
    } finally {
      try { process.kill(cmdPid, "SIGCONT"); } catch {}
      try { process.kill(cmdPid, "SIGKILL"); } catch {}
    }
  }
});

test("kills a background child left in an unlocked command's own process group after its leader exits", async () => {
  const dir = temp.make("hedge-timeout-pgid-");
  const [ready, gone, leaderGone] = [join(dir, "ready"), join(dir, "gone"), join(dir, "leader-gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, leaderGone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const leaderClosed = Bun.file(leaderGone).text();
  const clock = handTimer();
  const pgidScript = `import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  getpgrp: { args: [], returns: FFIType.i32 },
  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
if (lib.symbols.getpgrp() !== process.pid && lib.symbols.setpgid(0, 0) !== 0) process.exit(2);
const c = Bun.spawn(["sh", "-c", ${JSON.stringify(`exec 4>${JSON.stringify(leaderGone)}; { sleep 30 4>&- & } 3>${JSON.stringify(gone)}; echo $! > ${JSON.stringify(ready)}`)}], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await c.exited);`;
  const result = captureWith(clock.timer)([process.execPath, "-e", pgidScript], { timeoutMs: 30 });
  const childPid = Number((await started).trim());
  expect(await leaderClosed).toBe("");
  try {
    clock.fire();
    expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("preserves command arguments and stdin under seven nested box locks without leaking locks to descendants", async () => {
  const lockHome = temp.make("hedge-lock-seven-");
  const dir = temp.make("hedge-lock-seven-child-");
  const ready = join(dir, "bg.pid");
  expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
  const bgStarted = Bun.file(ready).text();
  const nest = <T>(index: number, fn: () => Promise<T>): Promise<T> =>
    index > 7 ? fn() : withBoxLock(lockHome, `box-${index}`, { waitMs: 0 }, () => nest(index + 1, fn));
  let bgPid = 0;
  try {
    const [printed, piped] = await nest(1, async () => [
      await capture(["printf", "%s", "ok"], { timeoutMs: 10_000 }),
      await capture(
        ["sh", "-c", 'read line; printf "%s:%s" "$line" "$1"; sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$2"', "probe", "arg", ready],
        { stdin: "hello\n", timeoutMs: 10_000 },
      ),
    ]);
    bgPid = Number((await bgStarted).trim());
    expect(bgPid).toBeGreaterThan(0);
    expect(() => process.kill(bgPid, 0)).not.toThrow();
    expect(printed).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(piped).toEqual({ code: 0, stdout: "hello:arg", stderr: "" });
    for (let index = 1; index <= 7; index++) {
      expect(await withBoxLock(lockHome, `box-${index}`, { waitMs: 0 }, async () => "free")).toBe("free");
    }
  } finally {
    if (bgPid > 0) try { process.kill(bgPid, "SIGKILL"); } catch {}
  }
});

test("returns the command's own exit code when it signals its own process group", async () => {
  expect(await capture(["sh", "-c", 'trap "exit 42" TERM; kill -TERM 0'], { timeoutMs: 10_000 })).toEqual({ code: 42, stdout: "", stderr: "" });
  expect(await capture(["sh", "-c", 'trap "exit 42" USR1; kill -USR1 0'], { timeoutMs: 10_000 })).toEqual({ code: 42, stdout: "", stderr: "" });
});

test("skips running the command when the timer expires immediately", async () => {
  const dir = temp.make("hedge-sync-expire-");
  const marker = join(dir, "ran");
  const immediateCapture = captureWith((_ms, fire) => {
    fire();
    return () => {};
  });
  const result = await immediateCapture(["sh", "-c", 'echo ran > "$1"', "probe", marker], { timeoutMs: 50 });
  expect(result.code).toBe(124);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("rejects eight nested box locks cleanly before spawning a supervisor when no multi-digit shell is on PATH", async () => {
  const lockHome = temp.make("hedge-lock-eight-");
  const emptyBin = temp.make("hedge-empty-bin-");
  const nest = <T>(index: number, fn: () => Promise<T>): Promise<T> =>
    index > 8 ? fn() : withBoxLock(lockHome, `box-${index}`, { waitMs: 0 }, () => nest(index + 1, fn));
  await expect(nest(1, () => capture(["printf", "%s", "ok"], { env: { PATH: emptyBin }, timeoutMs: 10_000 }))).rejects.toThrow("cannot close 8 box lock descriptors");
});

test("preserves a __proto__ environment variable through supervised capture", async () => {
  const env: Record<string, string | undefined> = Object.create(null);
  env.PATH = process.env.PATH;
  env["__proto__"] = "keep-proto";
  const result = await capture(
    [process.execPath, "-e", 'process.stdout.write(Object.getOwnPropertyDescriptor(process.env, "__proto__")?.value ?? "")'],
    { env, timeoutMs: 10_000 },
  );
  expect(result).toEqual({ code: 0, stdout: "keep-proto", stderr: "" });
});

test("kills a repeatedly self-stopping detached capture group when the caller receives SIGTERM", async () => {
  const dir = temp.make("hedge-capture-term-stop-");
  const cwdA = temp.make("hedge-capture-preload-a-");
  const cwdB = temp.make("hedge-capture-preload-b-");
  writeFileSync(join(cwdA, "preload.ts"), "export {};\n");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const coderPath = join(import.meta.dir, "coder.ts");
  const callerScript = `import { captureWith } from ${JSON.stringify(coderPath)};
process.chdir(${JSON.stringify(cwdB)});
const fastCapture = captureWith((ms, fire) => { const t = setTimeout(fire, ms); return () => clearTimeout(t); }, 0);
await fastCapture(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; while true; do kill -STOP 0; done', "probe", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { timeoutMs: 30_000 });`;
  const caller = Bun.spawn([process.execPath, "-e", callerScript], {
    cwd: cwdA,
    env: { ...process.env, BUN_OPTIONS: "--preload=./preload.ts" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let targetPid = 0;
  try {
    targetPid = Number((await started).trim());
    expect(targetPid).toBeGreaterThan(0);
    caller.kill("SIGTERM");
    expect(await caller.exited).not.toBe(0);
    expect(await holderGone).toBe("");
  } finally {
    caller.kill("SIGKILL");
    if (targetPid > 0) {
      try { process.kill(targetPid, "SIGCONT"); } catch {}
      try { process.kill(targetPid, "SIGKILL"); } catch {}
    }
  }
});

test("kills a repeatedly self-stopping subprocess when its capture deadline expires", async () => {
  const dir = temp.make("hedge-capture-self-stop-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const clock = handTimer();
  let targetPid = 0;
  try {
    const running = captureWith(clock.timer, 0)(
      ["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; while true; do kill -STOP 0; done', "probe", gone, ready],
      { timeoutMs: 150 },
    );
    targetPid = Number((await started).trim());
    expect(targetPid).toBeGreaterThan(0);
    expect(() => process.kill(targetPid, 0)).not.toThrow();
    clock.fire();
    expect(await running).toEqual({ code: 124, stdout: "", stderr: "timed out after 150 ms" });
    expect(await holderGone).toBe("");
  } finally {
    if (targetPid > 0) {
      try { process.kill(targetPid, "SIGCONT"); } catch {}
      try { process.kill(targetPid, "SIGKILL"); } catch {}
    }
  }
});

test("lets a box-locked command finish its work when the caller receives SIGTERM outside a probe, including under an enclosing capture", async () => {
  const lockHome = temp.make("hedge-lock-sigterm-");
  const dir = temp.make("hedge-lock-sigterm-work-");
  const boxLockPath = join(import.meta.dir, "box-lock.ts");
  const coderPath = join(import.meta.dir, "coder.ts");
  for (const mode of ["direct", "nested-inner", "nested-outer"] as const) {
    const nested = mode !== "direct";
    const [ready, gate, doneFile, innerPidFile] = [
      join(dir, `ready-${mode}`),
      join(dir, `gate-${mode}`),
      join(dir, `done-${mode}`),
      join(dir, `inner-${mode}`),
    ];
    expect(Bun.spawnSync(["mkfifo", ready, gate, innerPidFile]).exitCode).toBe(0);
    const started = Bun.file(ready).text();
    const innerScript = `import { writeFileSync } from "node:fs";
import { withBoxLock } from ${JSON.stringify(boxLockPath)};
import { capture } from ${JSON.stringify(coderPath)};
writeFileSync(${JSON.stringify(innerPidFile)}, String(process.pid) + "\\n");
await withBoxLock(${JSON.stringify(lockHome)}, "box-1", { waitMs: 0 }, () =>
  capture(["sh", "-c", 'echo $$ > "$1"; cat "$2" >/dev/null; echo finished > "$3"', "locked", ${JSON.stringify(ready)}, ${JSON.stringify(gate)}, ${JSON.stringify(doneFile)}], { timeoutMs: 30_000 }),
);`;
    const outerScript = nested
      ? `import { capture } from ${JSON.stringify(coderPath)};
const r = await capture([process.execPath, "-e", ${JSON.stringify(innerScript)}], { timeoutMs: 30_000 });
process.exit(r.code);`
      : innerScript;
    const innerPidRead = Bun.file(innerPidFile).text();
    const caller = Bun.spawn([process.execPath, "-e", outerScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let workerPid = 0;
    let innerPid = 0;
    try {
      [innerPid, workerPid] = (await Promise.all([innerPidRead, started])).map((s) => Number(s.trim())) as [number, number];
      expect(innerPid).toBeGreaterThan(0);
      expect(workerPid).toBeGreaterThan(0);
      if (mode === "nested-outer") caller.kill("SIGTERM");
      else process.kill(innerPid, "SIGTERM");
      expect(await caller.exited).not.toBe(0);
      expect(() => process.kill(workerPid, 0)).not.toThrow();
      await expect(withBoxLock(lockHome, "box-1", { waitMs: 0 }, async () => "free")).rejects.toThrow("is busy");
      const writer = Bun.spawn(["sh", "-c", 'printf "go\\n" > "$1"', "writer", gate], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await writer.exited;
      expect(await withBoxLock(lockHome, "box-1", { waitMs: 5_000 }, async () => "acquired")).toBe("acquired");
      expect(readFileSync(doneFile, "utf8").trim()).toBe("finished");
    } finally {
      caller.kill("SIGKILL");
      if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
    }
  }
});

test("kills a detached child still holding stdout open after the command leader exits if the capture caller dies", async () => {
  const dir = temp.make("hedge-capture-stdout-orphan-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const holderGone = Bun.file(gone).text();
  const coderPath = join(import.meta.dir, "coder.ts");
  const orphanScript = `
    const child = Bun.spawn(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; sleep 60', "orphan", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
    process.exit(0);
  `;
  const callerScript = `import { capture } from ${JSON.stringify(coderPath)};
await capture([process.execPath, "-e", ${JSON.stringify(orphanScript)}], { timeoutMs: 30_000 });`;
  const caller = Bun.spawn([process.execPath, "-e", callerScript], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let orphanPid = 0;
  try {
    orphanPid = Number((await started).trim());
    expect(orphanPid).toBeGreaterThan(0);
    caller.kill("SIGKILL");
    await caller.exited;
    expect(await holderGone).toBe("");
  } finally {
    caller.kill("SIGKILL");
    if (orphanPid > 0) {
      try { process.kill(orphanPid, "SIGKILL"); } catch {}
    }
  }
});

test("captures large environments alongside held box locks without IPC descriptor shifts", async () => {
  const home = temp.make("hedge-capture-large-env-");
  const chunk = "x".repeat(40_000);
  const result = await withBoxLock(home, "box-env-check", { waitMs: 5_000 }, () =>
    capture(
      [process.execPath, "-e", 'process.stdout.write(String((process.env.BIG_1?.length ?? 0) + (process.env.BIG_2?.length ?? 0) + (process.env.BIG_3?.length ?? 0) + (process.env.BIG_4?.length ?? 0)))'],
      { env: { ...process.env, BIG_1: chunk, BIG_2: chunk, BIG_3: chunk, BIG_4: chunk }, timeoutMs: 10_000 },
    ),
  );
  expect(result).toEqual({ code: 0, stdout: String(chunk.length * 4), stderr: "" });
});

test("runs 64 concurrent captures under a 256 file-descriptor limit without EMFILE", async () => {
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
const results = await Promise.all(Array.from({ length: 64 }, (_, i) => capture(["sh", "-c", \`printf '%s' \${i}\`], { timeoutMs: 10_000 })));
const ok = results.length === 64 && results.every((r, i) => r.code === 0 && r.stdout === String(i));
process.exit(ok ? 0 : 1);`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -n 256 && exec "$1" -e "$2"', "fd-cap", process.execPath, script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("makes the captured command its own session and process-group leader like direct detached spawn", async () => {
  if (process.platform === "win32") return;
  const checkIds = `import { dlopen, FFIType } from "bun:ffi";
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
  getsid: { args: [FFIType.i32], returns: FFIType.i32 },
});
console.log(process.pid, libc.symbols.getpgid(0), libc.symbols.getsid(0));`;
  const info = await capture([process.execPath, "-e", checkIds], { timeoutMs: 5_000 });
  expect(info.code).toBe(0);
  const [pid, pgid, sid] = info.stdout.trim().split(/\s+/).map(Number);
  expect(pid).toBeGreaterThan(0);
  expect(pgid).toBe(pid);
  expect(sid).toBe(pid);
  if (process.platform === "linux" && Bun.which("setsid")) {
    const res = await capture(["setsid", "sh", "-c", "exit 42"], { timeoutMs: 5_000 });
    expect(res.code).toBe(0);
  }
});

test("kills the direct target on timeout even when TMPDIR is read-only", async () => {
  if (process.getuid?.() === 0) return;
  const { chmodSync, mkdirSync } = await import("node:fs");
  const coderPath = join(import.meta.dir, "coder.ts");
  const dir = temp.make("hedge-capture-readonly-tmp-");
  const roTmp = join(dir, "ro-tmp");
  mkdirSync(roTmp, { recursive: true, mode: 0o500 });
  const [ready, gone, trigger] = [join(dir, "ready"), join(dir, "gone"), join(dir, "trigger")];
  expect(Bun.spawnSync(["mkfifo", ready, gone, trigger]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const closed = Bun.file(gone).text();
  const driverScript = `import { captureWith } from ${JSON.stringify(coderPath)};
const run = captureWith((_, fire) => {
  void Bun.file(${JSON.stringify(trigger)}).text().then(() => fire());
  return () => {};
});
const res = await run(["sh", "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "target", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], {
  timeoutMs: 5_000,
});
process.exit(res.code === 124 ? 0 : 1);`;
  const driver = Bun.spawn([process.execPath, "-e", driverScript], {
    env: { ...process.env, TMPDIR: roTmp },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let childPid = 0;
  try {
    childPid = Number((await started).trim());
    expect(childPid).toBeGreaterThan(0);
    await Bun.write(trigger, "go\n");
    const [code, stderr] = await Promise.all([driver.exited, new Response(driver.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(await closed).toBe("");
  } finally {
    driver.kill("SIGKILL");
    await driver.exited.catch(() => {});
    try { chmodSync(roTmp, 0o700); } catch {}
    if (childPid > 0) try { process.kill(childPid, "SIGKILL"); } catch {}
  }
});

test("delivers a single SIGTERM to the captured command on both caller SIGTERM and probe deadline", async () => {
  const coderPath = join(import.meta.dir, "coder.ts");
  const applyPath = join(import.meta.dir, "../../../src/reconciler/apply.ts");
  const { humanStepsLeft } = await import(applyPath);
  for (const mode of ["signal", "deadline"] as const) {
    const dir = temp.make(`hedge-capture-single-term-${mode}-`);
    const [ready, sawTerm, gate, gone] = [join(dir, "ready"), join(dir, "saw-term"), join(dir, "gate"), join(dir, "gone")];
    const logFile = join(dir, "term.log");
    expect(Bun.spawnSync(["mkfifo", ready, sawTerm, gate, gone]).exitCode).toBe(0);
    const started = Bun.file(ready).text();
    const gotTerm = Bun.file(sawTerm).text();
    const closed = Bun.file(gone).text();
    const probeScript = `import { capture } from ${JSON.stringify(coderPath)};
await capture(["sh", "-c", 'trap "echo term >> \\"$3\\"; echo hit > \\"$4\\"" TERM; exec 3>"$1"; echo $$ > "$2"; (trap "" TERM; cat "$5" >/dev/null) 3>&- & w=$!; while kill -0 "$w" 2>/dev/null; do wait "$w"; done', "target", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}, ${JSON.stringify(logFile)}, ${JSON.stringify(sawTerm)}, ${JSON.stringify(gate)}], { timeoutMs: 10_000 });`;
    const plan = {
      schema: 1,
      engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
      machine: { role: "linux", profileDir: dir },
      packs: [{ name: "team", summary: "Team.", available: true, workflows: [] }],
      files: [],
      config: [],
      steps: [],
      checks: [],
      human: [{ id: "nested", pack: "team", say: "Nested.", probe: [process.execPath, "-e", probeScript] }],
      jobs: [],
      settings: {},
      dropped: [],
    };
    let targetPid = 0;
    if (mode === "signal") {
      const runnerScript = `import { humanStepsLeft } from ${JSON.stringify(applyPath)};
await humanStepsLeft(${JSON.stringify(plan)}, { home: ${JSON.stringify(dir)}, giveUp: new Promise(() => {}), graceMs: 1_500 });`;
      const runner = Bun.spawn([process.execPath, "-e", runnerScript], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        targetPid = Number((await started).trim());
        expect(targetPid).toBeGreaterThan(0);
        runner.kill("SIGTERM");
        expect((await gotTerm).trim()).toBe("hit");
        const release = Bun.spawn(["sh", "-c", 'printf "go\\n" > "$1"', "writer", gate], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        await release.exited;
        expect(await closed).toBe("");
        await runner.exited;
        expect(readFileSync(logFile, "utf8").trim().split("\n")).toEqual(["term"]);
      } finally {
        runner.kill("SIGKILL");
        if (targetPid > 0) try { process.kill(targetPid, "SIGKILL"); } catch {}
      }
    } else {
      let fireDeadline!: () => void;
      try {
        const pending = humanStepsLeft(plan, {
          home: dir,
          giveUp: new Promise<void>((resolve) => (fireDeadline = resolve)),
          graceMs: 1_500,
        });
        targetPid = Number((await started).trim());
        expect(targetPid).toBeGreaterThan(0);
        fireDeadline();
        await pending;
        expect((await gotTerm).trim()).toBe("hit");
        const release = Bun.spawn(["sh", "-c", 'printf "go\\n" > "$1"', "writer", gate], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        await release.exited;
        expect(await closed).toBe("");
        expect(readFileSync(logFile, "utf8").trim().split("\n")).toEqual(["term"]);
      } finally {
        if (targetPid > 0) try { process.kill(targetPid, "SIGKILL"); } catch {}
      }
    }
  }
});

test("stops a captured env -i target on caller death and timeout", async () => {
  const envBin = Bun.which("env") ?? "/usr/bin/env";
  const shBin = Bun.which("sh") ?? "/bin/sh";
  const coderPath = join(import.meta.dir, "coder.ts");

  const dir1 = temp.make("hedge-capture-caller-kill-envi-");
  const [ready1, gone1] = [join(dir1, "ready"), join(dir1, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready1, gone1]).exitCode).toBe(0);
  const started1 = Bun.file(ready1).text();
  const closed1 = Bun.file(gone1).text();
  const caller = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { capture } from ${JSON.stringify(coderPath)}; await capture([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "target", ${JSON.stringify(gone1)}, ${JSON.stringify(ready1)}], { timeoutMs: 30_000 });`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let targetPid1 = 0;
  try {
    targetPid1 = Number((await started1).trim());
    expect(targetPid1).toBeGreaterThan(0);
    caller.kill("SIGKILL");
    await caller.exited;
    expect(await closed1).toBe("");
  } finally {
    caller.kill("SIGKILL");
    if (targetPid1 > 0) try { process.kill(targetPid1, "SIGKILL"); } catch {}
  }

  const dir2 = temp.make("hedge-capture-timeout-envi-");
  const [ready2, gone2] = [join(dir2, "ready"), join(dir2, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready2, gone2]).exitCode).toBe(0);
  const started2 = Bun.file(ready2).text();
  const closed2 = Bun.file(gone2).text();
  const clock = handTimer();
  let targetPid2 = 0;
  try {
    const running = captureWith(clock.timer)(
      [envBin, "-i", shBin, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "target", gone2, ready2],
      { timeoutMs: 30_000 },
    );
    targetPid2 = Number((await started2).trim());
    expect(targetPid2).toBeGreaterThan(0);
    clock.fire();
    const res = await running;
    expect(res.code).toBe(124);
    expect(await closed2).toBe("");
  } finally {
    if (targetPid2 > 0) try { process.kill(targetPid2, "SIGKILL"); } catch {}
  }
});

test("rejects NUL bytes in captured arguments or environment and matches Bun.spawn PATH fallback", async () => {
  await expect(capture([], { timeoutMs: 5_000 })).rejects.toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  await expect(capture(["printf", "before\u0000after"], { timeoutMs: 5_000 })).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  await expect(capture(["printf", "ok"], { env: { ...process.env, BAD: "a\u0000b" }, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  expect(await capture(["printf", "ok"], { env: { PATH: "" }, timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "ok", stderr: "" });
  expect(await capture(["printf", "ok"], { env: {}, timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "ok", stderr: "" });
  const bunRes = await capture(["bun", "--version"], { timeoutMs: 5_000 });
  expect(bunRes.code).toBe(0);
  expect(bunRes.stdout.trim().length).toBeGreaterThan(0);
  await expect(capture(["printf", "ok"], { env: { PATH: "/nonexistent-hedge-path-only" }, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "ENOENT" });
});

test("captures a 31 KB target environment alongside a large caller environment without E2BIG", async () => {
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", 'process.stdout.write(String(process.env.TARGET_BIG?.length ?? 0))'], {
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TARGET_BIG: "t".repeat(31_000) },
  timeoutMs: 10_000,
});
if (res.code !== 0 || res.stdout !== "31000") {
  console.error(JSON.stringify(res));
  process.exit(1);
}`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -s 256 2>/dev/null || true; exec "$1" -e "$2"', "e2big-check", process.execPath, script], {
    env: { ...process.env, CALLER_BIG: "c".repeat(31_000) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("ignores oversized ambient HEDGE_* environment variables when capturing with a small explicit env", async () => {
  const trueBin = Bun.which("true") ?? "/usr/bin/true";
  const prev = process.env.HEDGE_OVERSIZED_AMBIENT_TEST;
  process.env.HEDGE_OVERSIZED_AMBIENT_TEST = "x".repeat(131_072);
  try {
    const res = await capture([trueBin], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000 });
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    if (prev === undefined) delete process.env.HEDGE_OVERSIZED_AMBIENT_TEST;
    else process.env.HEDGE_OVERSIZED_AMBIENT_TEST = prev;
  }
});

test("runs 64 concurrent config-pipe captures under a 256 file-descriptor limit without stalling", async () => {
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
const pad = "p".repeat(20_000);
const results = await Promise.all(
  Array.from({ length: 64 }, (_, i) =>
    capture(["sh", "-c", \`printf '%s' \${i}\`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PAD: pad }, timeoutMs: 10_000 }),
  ),
);
const ok = results.length === 64 && results.every((r, i) => r.code === 0 && r.stdout === String(i));
process.exit(ok ? 0 : 1);`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -n 256 && exec "$1" -e "$2"', "fd-pipe-cap", process.execPath, script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("stops a captured env -i target when its caller is killed with SIGKILL", async () => {
  if (process.platform === "win32") return;
  const envBin = Bun.which("env") ?? "/usr/bin/env";
  const shBin = Bun.which("sh") ?? "/bin/sh";
  const coderPath = join(import.meta.dir, "coder.ts");
  const dir = temp.make("hedge-capture-caller-kill-");
  const [ready, gone] = [join(dir, "ready"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const closed = Bun.file(gone).text();
  const runnerScript = `import { capture } from ${JSON.stringify(coderPath)};
await capture([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; echo $$ > "$2"; exec sleep 30', "target", ${JSON.stringify(gone)}, ${JSON.stringify(ready)}], { timeoutMs: 30_000 });`;
  const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let targetPid = 0;
  try {
    targetPid = Number((await started).trim());
    expect(targetPid).toBeGreaterThan(0);
    runner.kill("SIGKILL");
    await runner.exited;
    expect(await closed).toBe("");
  } finally {
    runner.kill("SIGKILL");
    await runner.exited.catch(() => {});
    if (targetPid > 0) try { process.kill(targetPid, "SIGKILL"); } catch {}
  }
});

test("does not leak ambient loader diagnostics into stderr for clean-env captures", async () => {
  if (process.platform === "win32") return;
  const printfBin = Bun.which("printf") ?? "/usr/bin/printf";
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
process.env.LD_PRELOAD = "/nonexistent/hedge-missing-preload.so";
process.env.DYLD_INSERT_LIBRARIES = "/nonexistent/hedge-missing-preload.dylib";
const res = await capture([${JSON.stringify(printfBin)}, "ok"], { env: {}, timeoutMs: 5_000 });
console.log(JSON.stringify(res));`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout.trim())).toEqual({ code: 0, stdout: "ok", stderr: "" });
});

test("runs near-ARG_MAX commands with an empty env without hitting E2BIG from supervisor env entries", async () => {
  if (process.platform !== "linux") return;
  const trueBin = Bun.which("true") ?? "/bin/true";
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
const a = "a".repeat(65_450);
const b = "b".repeat(65_450);
const res = await capture([${JSON.stringify(trueBin)}, a, b], { env: {}, timeoutMs: 5_000 });
process.exit(res.code === 0 ? 0 : 1);`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -s 256 && exec "$1" -e "$2"', "arg-limit", process.execPath, script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("rejects cleanly through capture when all file descriptors are exhausted", async () => {
  if (process.platform === "win32") return;
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { closeSync, openSync } from "node:fs";
import { capture } from ${JSON.stringify(coderPath)};
const fds: number[] = [];
try {
  for (;;) fds.push(openSync("/dev/null", "r"));
} catch {}
let failed = false;
try {
  await capture(["sh", "-c", "exit 0"], { timeoutMs: 5_000 });
} catch {
  failed = true;
} finally {
  for (const fd of fds) try { closeSync(fd); } catch {}
}
process.exit(failed ? 0 : 1);`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -n 64 && exec "$1" -e "$2"', "fd-exhaust-cap", process.execPath, script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("cleans up an adopted detached env -i worker on Linux when the capture caller times out or is killed", async () => {
  if (process.platform !== "linux") return;
  const envBin = Bun.which("env") ?? "/usr/bin/env";
  const shBin = Bun.which("sh") ?? "/bin/sh";
  const coderPath = join(import.meta.dir, "coder.ts");
  for (const mode of ["timeout", "sigkill"] as const) {
    const dir = temp.make(`hedge-capture-adopted-${mode}-`);
    const [workerReady, launcherDone, workerGone, resultFile] = [
      join(dir, "w-ready"),
      join(dir, "l-done"),
      join(dir, "w-gone"),
      join(dir, "result.json"),
    ];
    expect(Bun.spawnSync(["mkfifo", workerReady, launcherDone, workerGone]).exitCode).toBe(0);
    const workerStarted = Bun.file(workerReady).text();
    const workerClosed = Bun.file(workerGone).text();
    const launcherScript = `const w = Bun.spawn([${JSON.stringify(envBin)}, "-i", ${JSON.stringify(shBin)}, "-c", 'exec 3>"$1"; read _ < "$2"; echo $$ > "$3"; exec sleep 30', "worker", ${JSON.stringify(workerGone)}, ${JSON.stringify(launcherDone)}, ${JSON.stringify(workerReady)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
w.unref();
process.exit(0);`;
    const targetScript = `import { writeFileSync } from "node:fs";
const h = Bun.spawn([process.execPath, "-e", ${JSON.stringify(launcherScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await h.exited;
writeFileSync(${JSON.stringify(launcherDone)}, "reaped\\n");
await Bun.sleep(30_000);`;
    let workerPid = 0;
    if (mode === "timeout") {
      let fireTimeout!: () => void;
      const runCapture = captureWith((_ms, fire) => {
        fireTimeout = fire;
        return () => {};
      }, 0);
      try {
        const pending = runCapture([process.execPath, "-e", targetScript], { timeoutMs: 30_000 });
        workerPid = Number((await workerStarted).trim());
        expect(workerPid).toBeGreaterThan(0);
        fireTimeout();
        const res = await pending;
        expect(res.code).toBe(timedOut);
        expect(await workerClosed).toBe("");
      } finally {
        if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      }
    } else {
      const runnerScript = `import { capture } from ${JSON.stringify(coderPath)};
const res = await capture([process.execPath, "-e", ${JSON.stringify(targetScript)}], { timeoutMs: 30_000 });
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify(res));`;
      const runner = Bun.spawn([process.execPath, "-e", runnerScript], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        workerPid = Number((await workerStarted).trim());
        expect(workerPid).toBeGreaterThan(0);
        runner.kill("SIGKILL");
        expect(await runner.exited).not.toBe(0);
        expect(await workerClosed).toBe("");
      } finally {
        runner.kill("SIGKILL");
        await runner.exited.catch(() => {});
        if (workerPid > 0) try { process.kill(workerPid, "SIGKILL"); } catch {}
      }
    }
  }
});

test("preserves an empty environment for standalone and nested captures including undefined-only env objects", async () => {
  if (process.platform === "win32") return;
  const envBin = Bun.which("env") ?? "/usr/bin/env";
  const coderPath = join(import.meta.dir, "coder.ts");
  expect(await capture([envBin], { env: {}, timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await capture([envBin], { env: { FOO: undefined }, timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "", stderr: "" });
  const nestedScript = `import { capture } from ${JSON.stringify(coderPath)};
const a = await capture([${JSON.stringify(envBin)}], { env: {}, timeoutMs: 5_000 });
const b = await capture([${JSON.stringify(envBin)}], { env: { BAR: undefined }, timeoutMs: 5_000 });
console.log(JSON.stringify([a, b]));`;
  const outer = await capture([process.execPath, "-e", nestedScript], { timeoutMs: 10_000 });
  expect(outer.code).toBe(0);
  expect(JSON.parse(outer.stdout.trim())).toEqual([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  ]);
});

test("captures a command with a short explicit PATH even when ambient PATH exceeds ARG_MAX on Linux", async () => {
  if (process.platform !== "linux") return;
  const trueBin = Bun.which("true") ?? "/bin/true";
  const coderPath = join(import.meta.dir, "coder.ts");
  const script = `import { capture } from ${JSON.stringify(coderPath)};
process.env.PATH = "/usr/bin:" + "x".repeat(132_000);
const res = await capture([${JSON.stringify(trueBin)}], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000 });
process.exit(res.code === 0 ? 0 : 1);`;
  const proc = Bun.spawn(["sh", "-c", 'ulimit -s 256 && exec "$1" -e "$2"', "huge-path", process.execPath, script], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("forwards SIGTERM to a standalone capture so its cleanup handler runs before bounded escalation", async () => {
  if (process.platform === "win32") return;
  const shBin = Bun.which("sh") ?? "/bin/sh";
  const coderPath = join(import.meta.dir, "coder.ts");
  const dir = temp.make("hedge-standalone-grace-");
  const [ready, cleaned, gone] = [join(dir, "ready"), join(dir, "cleaned"), join(dir, "gone")];
  expect(Bun.spawnSync(["mkfifo", ready, cleaned, gone]).exitCode).toBe(0);
  const started = Bun.file(ready).text();
  const sawCleaned = Bun.file(cleaned).text();
  const closed = Bun.file(gone).text();
  const targetCmd = `trap 'echo cleaned > ${JSON.stringify(cleaned)}; exit 0' TERM; exec 3>${JSON.stringify(gone)}; echo $$ > ${JSON.stringify(ready)}; sleep 30 3>&- & wait`;
  const runner = Bun.spawn(
    [process.execPath, "-e", `import { capture } from ${JSON.stringify(coderPath)}; await capture([${JSON.stringify(shBin)}, "-c", ${JSON.stringify(targetCmd)}], { timeoutMs: 30_000 });`],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let targetPid = 0;
  try {
    targetPid = Number((await started).trim());
    expect(targetPid).toBeGreaterThan(0);
    runner.kill("SIGTERM");
    expect((await sawCleaned).trim()).toBe("cleaned");
    expect(await closed).toBe("");
    expect(await runner.exited).not.toBe(0);
  } finally {
    runner.kill("SIGKILL");
    await runner.exited.catch(() => {});
    if (targetPid > 0) try { process.kill(targetPid, "SIGKILL"); } catch {}
  }
});
