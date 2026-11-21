import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellThread } from "../../src/integrations/t3/threads.ts";
import type { LinkedThread } from "../../src/integrations/t3/environments.ts";
import { startT3Stub, ToolRefusal, type T3Stub } from "../../src/integrations/t3/testing.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { guardSettle, type SettleDeps } from "./hooks/settle-guard.ts";
import { prCommand } from "./lib/pr.ts";
import { parseSettleCheck, settleCheckOver, settleCheckUsage } from "./lib/organize-guard.ts";
import { handoverPath, recordHandover, threadsOwningPrs } from "./lib/pr-owners.ts";
import { remoteLauncher } from "../../src/hub/ssh.ts";

const temp = tempDirs();
const stubs: T3Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
  temp.cleanup();
});

const pr = (n: number, state?: string) => ({ repository: "acme/app", number: n, url: `https://github.com/acme/app/pull/${n}`, ...(state ? { snapshot: { state } } : {}) });
const thread = (id: string, fields: Partial<ShellThread> = {}): ShellThread => ({ id, title: `Thread ${id}`, projectId: "p", status: "idle", ...fields });
const child = (id: string, root: string, fields: Partial<ShellThread> = {}) => thread(id, { lineage: { parentThreadId: root, rootThreadId: root }, ...fields });
const organize = (input: Record<string, unknown>, name = "mcp__t3-code__t3_thread_organize") => ({ tool_name: name, tool_input: input });

function homeWith(settings?: Record<string, unknown>) {
  const home = temp.make("hedge-settle-");
  if (settings) {
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/settings.json"), JSON.stringify(settings));
  }
  return home;
}

function deps(threads: ShellThread[] | undefined, states: Record<number, string | Error> = {}, self = "mcp:me"): SettleDeps & { asked: string[]; machines: (string | undefined)[] } {
  const asked: string[] = [];
  const machines: (string | undefined)[] = [];
  return {
    asked, self, machines,
    threads: async (_home, environmentId) => (machines.push(environmentId), threads),
    prState: async (url) => {
      asked.push(url);
      const state = states[Number(url.split("/").pop())] ?? "open";
      if (state instanceof Error) throw state;
      return state;
    },
  };
}

const reasonOf = (denial: Awaited<ReturnType<typeof guardSettle>>) => denial?.hookSpecificOutput.permissionDecisionReason;

describe("the settle guard", () => {
  test("refuses to settle or archive a thread that owns an open PR, under either T3 tool name, and names the person and the handover", async () => {
    const home = homeWith({ "guards.person": "Robin" });
    for (const name of ["mcp__t3-code__t3_thread_organize", "mcp__t3_code__t3_thread_organize"]) for (const action of ["settle", "archive"]) {
      const denial = await guardSettle(organize({ action }, name), home, deps([thread("mcp:me", { pullRequests: [pr(1)] })]));
      expect(denial?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(reasonOf(denial)).toBe("Hedge blocked this settle: the thread owns open PR(s) https://github.com/acme/app/pull/1, and no other open thread links them. "
        + "If Robin parked them, snooze the thread until the park date instead. "
        + "Or hand each over first: send the thread that takes it over a message with t3_thread_send that asks it to link the PR with link_pull_request, "
        + "then run `hedge pr handover --pr <PR URL> --to <thread id>`, which counts only while that thread stays open and links the PR. Or close or merge the PR.");
    }
  });

  test("lets other tools, other actions, and a call with no thread through without asking T3", async () => {
    const home = homeWith();
    const owner = [thread("mcp:me", { pullRequests: [pr(1)] })];
    let read = 0;
    const counting: SettleDeps = { ...deps(owner), threads: async () => (read++, owner) };
    for (const call of [
      organize({ action: "settle" }, "mcp__other__t3_thread_organize"),
      organize({ action: "settle" }, "mcp__t3-code__t3_thread_organize_all"),
      organize({ action: "pin" }),
      { tool_name: "Bash", tool_input: { command: "echo" } },
    ]) expect(await guardSettle(call, home, counting)).toBeUndefined();
    expect(await guardSettle({ tool_name: "mcp__t3-code__t3_thread_organize" }, home, counting)).toBeUndefined();
    expect(read).toBe(0);
  });

  test("refuses a settle or archive that names no thread outside a T3 thread, without asking T3, and lets such a snooze through", async () => {
    const home = homeWith();
    let read = 0;
    const counting: SettleDeps = { ...deps([thread("mcp:me")]), threads: async () => (read++, [thread("mcp:me")]) };
    for (const self of ["", undefined]) for (const action of ["settle", "archive"]) {
      expect(reasonOf(await guardSettle(organize({ action }), home, { ...counting, self }))).toBe(`Hedge blocked this ${action}: the call names no thread, and T3CODE_THREAD_ID is unset, so Hedge cannot tell which thread it ${action}s. Pass threadId, or ${action} in the T3 UI.`);
    }
    expect(await guardSettle(organize({ action: "snooze", snoozedUntil: "2026-11-20T08:00:00Z" }), home, { ...counting, self: "" })).toBeUndefined();
    expect(read).toBe(0);
  });

  test.each([
    ["an MCP thread", "mcp:1a8f8559-24c4-43f3-b4e2-c83dfbb3120b"],
    ["a project thread", "thread:project:p-1:abc123"],
    ["a delegated task", "thread:delegated-task:server%3Adelegate%3A7f3c"],
    ["a subagent", "thread:subagent:0123456789abcdef"],
    ["a fork", "server:fork-command:42:fork"],
  ])("checks %s by the full id T3 acts on, named or as the calling thread", async (_, id) => {
    const home = homeWith();
    const owning = [thread("mcp:me"), thread(id, { pullRequests: [pr(30)] })];
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: id }), home, deps(owning)))).toContain("open PR(s) https://github.com/acme/app/pull/30, and");
    expect(reasonOf(await guardSettle(organize({ action: "archive" }), home, deps(owning, {}, id)))).toContain("open PR(s) https://github.com/acme/app/pull/30, and");
    expect(await guardSettle(organize({ action: "settle", threadId: id }), home, deps([thread("mcp:me"), thread(id)]))).toBeUndefined();
  });

  test("refuses to settle or archive a thread id T3 does not list, since T3 acts only on a full id, and names the full id it matches", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me"), thread("mcp:1a8f8559-24c4-43f3-b4e2-c83dfbb3120b"), thread("thread:project:p-1:abc123"), thread("thread:project:p-2:abc123")];
    for (const action of ["settle", "archive"]) {
      expect(reasonOf(await guardSettle(organize({ action, threadId: "1a8f8559-24c4-43f3-b4e2-c83dfbb3120b" }), home, deps(threads)))).toBe(
        `Hedge blocked this ${action}: T3 did not list thread 1a8f8559-24c4-43f3-b4e2-c83dfbb3120b, so Hedge cannot check its pin or its PRs. `
        + `T3 takes only a full thread id: pass mcp:1a8f8559-24c4-43f3-b4e2-c83dfbb3120b, or ${action} in the T3 UI.`);
      for (const id of ["abc123", "mcp:gone", "thread:delegated-task:server:delegate:7f3c"]) {
        expect(reasonOf(await guardSettle(organize({ action, threadId: id }), home, deps(threads)))).toBe(
          `Hedge blocked this ${action}: T3 did not list thread ${id}, so Hedge cannot check its pin or its PRs. `
          + `T3 takes only a full thread id: pass the id t3_thread_list shows, with environmentId for a thread on another machine, or ${action} in the T3 UI.`);
      }
    }
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads, {}, "mcp:stale")))).toContain("T3 did not list thread mcp:stale");
  });

  test("reads the threads of the machine the call names", async () => {
    const check = deps([thread("mcp:lane", { pullRequests: [pr(2)] })]);
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:lane", environmentId: "env-2" }), homeWith(), check))).toContain("pull/2,");
    expect(check.machines).toEqual(["env-2"]);
  });

  test("checks the thread the call names before the calling thread", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me"), thread("mcp:lane", { pullRequests: [pr(2)] })];
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:lane" }), home, deps(threads)))).toContain("pull/2,");
    expect(await guardSettle(organize({ action: "settle" }), home, deps(threads))).toBeUndefined();
  });

  test("counts the open children's links, not a settled child's, and lets a child whose root is open settle", async () => {
    const home = homeWith();
    const threads = [
      thread("mcp:me"),
      child("mcp:kid", "mcp:me", { pullRequests: [pr(3)] }),
      child("mcp:done", "mcp:me", { settledAt: "2026-11-01T00:00:00Z", pullRequests: [pr(4)] }),
      thread("mcp:grandkid", { lineage: { parentThreadId: "mcp:kid", rootThreadId: "mcp:me" }, pullRequests: [pr(14)] }),
    ];
    const reason = reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)));
    expect(reason).toContain("pull/3, https://github.com/acme/app/pull/14,");
    expect(reason).not.toContain("pull/4");
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(threads))).toBeUndefined();
    const orphan = [thread("mcp:me", { archivedAt: "2026-11-01T00:00:00Z" }), child("mcp:kid", "mcp:me", { pullRequests: [pr(3)] })];
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(orphan)))).toContain("pull/3,");
    const parentOnly = [thread("mcp:me"), thread("mcp:kid", { lineage: { parentThreadId: "mcp:me" }, pullRequests: [pr(3)] })];
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:kid" }), home, deps(parentOnly))).toBeUndefined();
  });

  test("a fork owns the links of its own subagents, and the thread it forked from does not", async () => {
    const home = homeWith();
    const threads = [
      thread("mcp:root"),
      thread("mcp:me", { lineage: { parentThreadId: "mcp:root", rootThreadId: "mcp:root", relationshipToParent: "fork" } }),
      thread("mcp:kid", { lineage: { parentThreadId: "mcp:me", rootThreadId: "mcp:root", relationshipToParent: "subagent" }, pullRequests: [pr(3)] }),
      thread("mcp:grandkid", { lineage: { parentThreadId: "mcp:kid", rootThreadId: "mcp:root", relationshipToParent: "subagent" }, pullRequests: [pr(14)] }),
    ];
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)))).toContain("pull/3, https://github.com/acme/app/pull/14,");
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:root" }), home, deps(threads))).toBeUndefined();
  });

  test("lets a PR go that another open thread links, under any case or a trailing slash, but not one only a closed thread links", async () => {
    const home = homeWith();
    const shared = { ...pr(5), url: "https://github.com/Acme/App/pull/5/" };
    expect(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(5)] }), thread("mcp:next", { pullRequests: [shared] })]))).toBeUndefined();
    for (const closed of [{ settledAt: "x" }, { archivedAt: "x" }, { deletedAt: "x" }]) {
      expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(5)] }), thread("mcp:old", { ...closed, pullRequests: [pr(5)] })])))).toContain("pull/5,");
    }
  });

  test("asks GitHub only about PRs T3 last saw open, lets merged and closed ones go, and holds one GitHub cannot answer for", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me", { pullRequests: [pr(6, "merged"), pr(7, "closed"), pr(8, "open"), pr(9), pr(10), pr(11)] })];
    const check = deps(threads, { 8: "merged", 9: "closed", 10: new Error("gh api failed: HTTP 502\nmore"), 11: "open" });
    const reason = reasonOf(await guardSettle(organize({ action: "settle" }), home, check));
    expect(check.asked.map((url) => url.split("/").pop())).toEqual(["8", "9", "10", "11"]);
    expect(reason).toContain("open PR(s) https://github.com/acme/app/pull/10 (state unknown (gh api failed: HTTP 502)), https://github.com/acme/app/pull/11, and");
    expect(reason).not.toContain("pull/8");
  });

  function handover(home: string, from: string, pr: string, to: string) {
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(handoverPath(home), `${existsSync(handoverPath(home)) ? readFileSync(handoverPath(home), "utf8") : ""}${JSON.stringify({ pr: pr.toLowerCase(), from, to, at: "2026-11-12T10:00:00.000Z" })}\n`);
  }

  test("holds a PR handed over to an open thread until that thread links it", async () => {
    const home = homeWith();
    const me = thread("mcp:me", { pullRequests: [pr(12), pr(13)] });
    handover(home, "mcp:me", "https://github.com/Acme/App/pull/12", "mcp:next");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([me, thread("mcp:next")])))).toContain("open PR(s) https://github.com/acme/app/pull/12, https://github.com/acme/app/pull/13, and");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([me, thread("mcp:next", { pullRequests: [pr(12)] })])))).toContain("open PR(s) https://github.com/acme/app/pull/13, and");
    writeFileSync(handoverPath(home), `not json\n${JSON.stringify({ to: "x" })}\n${readFileSync(handoverPath(home), "utf8")}${JSON.stringify({ pr: "https://github.com/acme/app/pull/13", from: "me", to: "next", at: "x" })}\n`);
    expect(await guardSettle(organize({ action: "settle" }), home, deps([me, thread("mcp:next", { pullRequests: [pr(12), pr(13)] })]))).toBeUndefined();
  });

  test("holds the second settle of a handover chain until that thread hands the PR on to a thread that links it", async () => {
    const home = homeWith();
    const x = "https://github.com/acme/app/pull/20";
    const chain = (cLinks: boolean) => [
      thread("mcp:a", { settledAt: "2026-11-12T10:05:00Z", pullRequests: [pr(20)] }),
      thread("mcp:b", { pullRequests: [pr(20)] }),
      thread("mcp:c", cLinks ? { pullRequests: [pr(20)] } : {}),
    ];
    handover(home, "mcp:a", x, "mcp:b");
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:b" }), home, deps(chain(false))))).toContain("open PR(s) https://github.com/acme/app/pull/20, and");
    handover(home, "mcp:b", x, "mcp:c");
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:b" }), home, deps(chain(false))))).toContain("open PR(s) https://github.com/acme/app/pull/20, and");
    expect(await guardSettle(organize({ action: "settle", threadId: "mcp:b" }), home, deps(chain(true)))).toBeUndefined();
  });

  test.each([
    ["names a thread that does not exist", "mcp:me", "mcp:nobody"],
    ["names a settled thread", "mcp:me", "mcp:settled"],
    ["names an archived thread", "mcp:me", "mcp:archived"],
    ["names the settling thread itself", "mcp:me", "mcp:me"],
    ["another thread recorded", "mcp:other", "mcp:next"],
  ])("holds a PR whose recorded handover %s", async (_, from, to) => {
    const home = homeWith();
    handover(home, from, "https://github.com/acme/app/pull/21", to);
    const threads = [
      thread("mcp:me", { pullRequests: [pr(21)] }), thread("mcp:next"), thread("mcp:other"),
      thread("mcp:settled", { settledAt: "x" }), thread("mcp:archived", { archivedAt: "x" }),
    ];
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps(threads)))).toContain("pull/21,");
  });

  test("refuses the settle when T3 does not answer, and names a fallback person without settings", async () => {
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(), deps(undefined)))).toBe("Hedge blocked this settle: T3 did not answer; retry, or settle in the T3 UI.");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(), { ...deps([]), threads: async () => { throw new Error("gone"); } }))).toContain("T3 did not answer");
    for (const settings of [undefined, { "guards.person": "  " }, { "guards.person": 3 }]) {
      expect(reasonOf(await guardSettle(organize({ action: "settle" }), homeWith(settings), deps([thread("mcp:me", { pullRequests: [pr(1)] })])))).toContain("If the person who runs this machine parked them, snooze the thread");
    }
    const broken = homeWith({});
    writeFileSync(join(broken, ".local/state/hedge/settings.json"), "{");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), broken, deps([thread("mcp:me", { pullRequests: [pr(1)] })])))).toContain("If the person who runs this machine parked them, snooze the thread");
  });

  test("handover refuses anything but a GitHub PR URL and a thread id, and writes nothing", async () => {
    const home = homeWith();
    for (const args of [
      [], ["--pr", "https://github.com/acme/app/pull/1"], ["--pr", "https://github.com/acme/app/issues/1", "--to", "mcp:x"],
      ["--pr", "http://github.com/acme/app/pull/1", "--to", "mcp:x"], ["--pr", "https://github.com/acme/app/pull/1", "--to", "-x"],
      ["--to", "mcp:x", "--pr", "https://github.com/acme/app/pull/1", "extra"], ["--pr", "--to", "https://github.com/acme/app/pull/1", "mcp:x"],
      ["--pr", "https://github.com/acme/app/pull/1", "--to", "mcp x"], ["--pr", "https://github.com/acme/app/pull/1x", "--to", "mcp:x"], ["mcp:x", "--pr", "https://github.com/acme/app/pull/1", "mcp:y"],
    ]) await expect(prCommand(["handover", ...args], home)).rejects.toThrow("Usage: hedge pr handover --pr <PR URL> --to <thread id>");
    await expect(recordHandover(["--pr", "https://github.com/acme/app/pull/1", "--to", "mcp:x"], home, undefined, new Date(), async () => [thread("mcp:x", { pullRequests: [pr(1)] })])).rejects.toThrow("hedge pr handover runs inside a T3 thread");
    expect(() => statSync(handoverPath(home))).toThrow();
  });

  const hand = (home: string, to: string, threads: ShellThread[] | undefined, url = "https://github.com/acme/app/pull/22") =>
    recordHandover(["--pr", url, "--to", to], home, "mcp:me", new Date("2026-11-12T10:00:00Z"), async () => threads);
  const dismissed = { ...pr(22), source: "stack-dismissed" };
  const askToLink = "Send it a message with t3_thread_send that hands the PR over and asks it to link the PR with link_pull_request, then run the handover again.";

  test.each([
    ["T3 does not answer", undefined, "mcp:next", "hedge pr handover needs T3, and T3 did not answer; retry."],
    ["T3 does not list the thread", [thread("mcp:me")], "mcp:nobody", "T3 did not list thread mcp:nobody. Hand the PR to the full id t3_thread_list shows."],
    ["the thread is a bare id", [thread("mcp:me"), thread("mcp:next", { pullRequests: [pr(22)] })], "next", "T3 did not list thread next. Hand the PR to its full id mcp:next."],
    ["the thread is settled", [thread("mcp:me"), thread("mcp:next", { settledAt: "x", pullRequests: [pr(22)] })], "mcp:next", "Thread mcp:next is settled, archived, or deleted, so it cannot own the PR. Hand it to an open thread."],
    ["the thread is archived", [thread("mcp:me"), thread("mcp:next", { archivedAt: "x", pullRequests: [pr(22)] })], "mcp:next", "Thread mcp:next is settled, archived, or deleted, so it cannot own the PR. Hand it to an open thread."],
    ["the thread is the one that hands it over", [thread("mcp:me", { pullRequests: [pr(22)] })], "mcp:me", "Thread mcp:me is the thread that hands the PR over. Hand it to another open thread."],
    ["the thread does not link the PR", [thread("mcp:me"), thread("mcp:next", { pullRequests: [pr(23)] })], "mcp:next", `Thread mcp:next does not link https://github.com/acme/app/pull/22 yet. ${askToLink}`],
    ["the thread only dismissed the PR from a stack", [thread("mcp:me"), thread("mcp:next", { pullRequests: [dismissed] })], "mcp:next", `Thread mcp:next does not link https://github.com/acme/app/pull/22 yet. ${askToLink}`],
  ])("handover refuses when %s, and writes nothing", async (_, threads, to, message) => {
    const home = homeWith();
    await expect(hand(home, to, threads)).rejects.toThrow(message);
    expect(() => statSync(handoverPath(home))).toThrow();
  });

  test("handover records a PR the open receiving thread links, by its full id, privately and with lower-case URLs", async () => {
    const home = homeWith();
    const threads = [thread("mcp:me", { pullRequests: [pr(22)] }), thread("thread:project:p-1:next", { pullRequests: [pr(22)] })];
    expect(await hand(home, "thread:project:p-1:next", threads, "https://github.com/Acme/App/pull/22")).toEqual({ pr: "https://github.com/acme/app/pull/22", from: "mcp:me", to: "thread:project:p-1:next", at: "2026-11-12T10:00:00.000Z" });
    expect(statSync(handoverPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".local/state/hedge")).mode & 0o777).toBe(0o700);
  });

  test("a PR link the thread dismissed from a stack neither counts as owned nor as another thread's link", async () => {
    const home = homeWith();
    expect(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [dismissed] })]))).toBeUndefined();
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(22)] }), thread("mcp:next", { pullRequests: [dismissed] })])))).toContain("open PR(s) https://github.com/acme/app/pull/22, and");
    handover(home, "mcp:me", "https://github.com/acme/app/pull/22", "mcp:next");
    expect(reasonOf(await guardSettle(organize({ action: "settle" }), home, deps([thread("mcp:me", { pullRequests: [pr(22)] }), child("mcp:next", "mcp:me", { pullRequests: [dismissed] })])))).toContain("open PR(s) https://github.com/acme/app/pull/22, and");
  });

  test("lists each open top-level thread that owns an open PR for a box release", () => {
    expect(threadsOwningPrs([
      thread("mcp:a", { title: "Lane A", pullRequests: [pr(1), pr(2, "merged")] }),
      child("mcp:a1", "mcp:a", { pullRequests: [pr(3)] }),
      thread("mcp:b", { title: "Lane B" }),
      thread("mcp:c", { title: "Lane C", settledAt: "x", pullRequests: [pr(4)] }),
    ])).toEqual(["Lane A (owns open PR https://github.com/acme/app/pull/1, https://github.com/acme/app/pull/3)"]);
  });
});

describe("the installed settle guard", () => {
  const hookPath = join(import.meta.dir, "hooks", "settle-guard.ts");

  async function run(home: string, input: unknown, env: Record<string, string> = {}) {
    const bin = temp.make("hedge-gh-");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  "api repos/acme/app/pulls/1") echo '{"state":"open","merged_at":null}' ;;\n  "api repos/acme/app/pulls/2") echo '{"state":"closed","merged_at":"2026-11-01T00:00:00Z"}' ;;\n  *) echo "unexpected $*" >&2; exit 9 ;;\nesac\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const child = Bun.spawn([process.execPath, hookPath, "claude"], { stdin: new Blob([typeof input === "string" ? input : JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, T3CODE_THREAD_ID: "mcp:me", ...env } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  }

  test("reads this machine's T3 and GitHub, refuses an open PR, and lets a merged one go", async () => {
    const stub = await startT3Stub({ shell: { projects: [], threads: [thread("mcp:me", { pullRequests: [pr(1)] }), thread("mcp:other", { pullRequests: [pr(2)] })] } });
    stubs.push(stub);
    const refused = await run(stub.home, organize({ action: "settle" }));
    expect(refused.code).toBe(0);
    expect(JSON.parse(refused.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("open PR(s) https://github.com/acme/app/pull/1, and") });
    expect((await run(stub.home, organize({ action: "settle", threadId: "mcp:other" })))).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  test("hedge pr handover reads this machine's T3, and records a PR the receiving thread links", async () => {
    const stub = await startT3Stub({ shell: { projects: [], threads: [thread("mcp:me", { pullRequests: [pr(1)] }), thread("mcp:next", { pullRequests: [pr(1)] }), thread("mcp:idle")] } });
    stubs.push(stub);
    const log = console.log;
    console.log = () => {};
    try {
      const handTo = (to: string) => prCommand(["handover", "--pr", "https://github.com/acme/app/pull/1", "--to", to], stub.home, { T3CODE_THREAD_ID: "mcp:me" }, new Date("2026-11-12T10:00:00Z"));
      await expect(handTo("mcp:idle")).rejects.toThrow("Thread mcp:idle does not link https://github.com/acme/app/pull/1 yet.");
      expect(await handTo("mcp:next")).toBe(0);
    } finally {
      console.log = log;
    }
    expect(stub.toolCalls).toEqual([]);
    expect(readFileSync(handoverPath(stub.home), "utf8")).toContain('"to":"mcp:next"');
  });

  test("refuses a settle without T3, or outside a T3 thread with no thread named, and stays quiet on input it cannot read", async () => {
    const home = homeWith();
    const refused = await run(home, organize({ action: "settle" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("T3 did not answer") });
    const unnamed = await run(home, organize({ action: "settle" }), { T3CODE_THREAD_ID: "" });
    expect(JSON.parse(unnamed.stdout).hookSpecificOutput.permissionDecisionReason).toContain("the call names no thread, and T3CODE_THREAD_ID is unset");
    expect(await run(home, "not json")).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  const linkedThread = (threadId: string, prs: number[], fields: Partial<LinkedThread> = {}): LinkedThread => ({
    threadId, projectId: "p", title: `Remote ${threadId}`, status: "idle", model: "m", parentThreadId: null, settled: false, snoozedUntil: null,
    pullRequests: prs.map((n) => ({ host: "github.com", ...pr(n) })), itemCount: 1, createdAt: "", updatedAt: "", ...fields,
  });

  async function machines(remote: LinkedThread[] | Error) {
    const stub = await startT3Stub({
      shell: { projects: [], threads: [thread("mcp:me", { pullRequests: [pr(1)] }), thread("mcp:other")] },
      environmentId: "env-here",
      links: [{ environmentId: "env-there", label: "box", urls: [], access: "full", linkedAt: "", expiresAt: "", lastReachedAt: null, lastError: null, status: "reachable" }],
      tools(name, args: any) {
        if (name !== "t3_thread_list" || args.environmentId !== "env-there") return undefined;
        if (remote instanceof Error) throw new ToolRefusal("environment_unreachable", remote.message);
        return { threads: remote, nextCursor: null };
      },
    });
    stubs.push(stub);
    return stub.home;
  }

  test("treats this machine's own environment id as this machine", async () => {
    const home = await machines([]);
    const refused = await run(home, organize({ action: "settle", environmentId: "env-here" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
  });

  test("reads PR ownership on the linked machine a call names, and refuses when that machine does not answer", async () => {
    const home = await machines([linkedThread("mcp:far", [1]), linkedThread("mcp:shared", [2]), linkedThread("mcp:keeper", [2])]);
    const refused = await run(home, organize({ action: "settle", threadId: "mcp:far", environmentId: "env-there" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
    expect(await run(home, organize({ action: "settle", threadId: "mcp:shared", environmentId: "env-there" }))).toEqual({ stdout: "", stderr: "", code: 0 });
    const down = await machines(new Error("the machine did not answer"));
    const unread = await run(down, organize({ action: "settle", threadId: "mcp:far", environmentId: "env-there" }));
    expect(JSON.parse(unread.stdout).hookSpecificOutput.permissionDecisionReason).toBe("Hedge blocked this settle: T3 did not answer; retry, or settle in the T3 UI.");
  });

  test("on a linked machine, refuses to settle or snooze a thread pinned there", async () => {
    const home = await machines([linkedThread("mcp:kept", [], { pinned: true }), linkedThread("mcp:loose", [])]);
    for (const action of ["settle", "snooze"]) {
      const refused = await run(home, organize({ action, threadId: "mcp:kept", environmentId: "env-there" }));
      expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("pinned this thread to keep it in view");
      expect(await run(home, organize({ action, threadId: "mcp:loose", environmentId: "env-there" }))).toEqual({ stdout: "", stderr: "", code: 0 });
    }
  });

  test("on a linked machine, a fork owns its PRs while the thread it forked from stays open", async () => {
    const home = await machines([linkedThread("mcp:source", []), linkedThread("mcp:fork", [1], { parentThreadId: "mcp:source", relationshipToParent: "fork" })]);
    const refused = await run(home, organize({ action: "settle", threadId: "mcp:fork", environmentId: "env-there" }));
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
  });
});

describe("the organize guard on a pinned thread", () => {
  const pinned = { pinnedAt: "2026-11-13T15:13:00.339Z" };

  test("refuses to settle or snooze a pinned thread, and names the person", async () => {
    const home = homeWith({ "guards.person": "Robin" });
    for (const action of ["settle", "snooze"]) {
      const reason = reasonOf(await guardSettle(organize({ action, threadId: "mcp:lane" }), home, deps([thread("mcp:lane", pinned)])));
      expect(reason).toBe("Hedge blocked this call: Robin pinned this thread to keep it in view, so leave it open. Only Robin snoozes it, in T3.");
    }
  });

  test("lets an archive of a pinned thread, and a snooze of an unpinned one, through", async () => {
    const home = homeWith();
    expect(await guardSettle(organize({ action: "archive", threadId: "mcp:lane" }), home, deps([thread("mcp:lane", pinned)]))).toBeUndefined();
    expect(await guardSettle(organize({ action: "snooze", threadId: "mcp:lane" }), home, deps([thread("mcp:lane", { pullRequests: [pr(1)] })]))).toBeUndefined();
  });

  test("lets a snooze through when T3 does not answer, and still refuses a settle then", async () => {
    const home = homeWith();
    expect(await guardSettle(organize({ action: "snooze", threadId: "mcp:lane" }), home, deps(undefined))).toBeUndefined();
    expect(reasonOf(await guardSettle(organize({ action: "settle", threadId: "mcp:lane" }), home, deps(undefined)))).toContain("T3 did not answer");
  });
});

describe("the organize guard on another machine", () => {
  function peerHome(environmentId = "env-peer", here = "env-here") {
    const home = homeWith({ "guards.person": "Robin" });
    mkdirSync(join(home, ".config/hedge/peer-links"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/peer-links/devbox-2.json"), JSON.stringify({ environmentId, port: 47001 }));
    mkdirSync(join(home, ".t3/userdata"), { recursive: true });
    writeFileSync(join(home, ".t3/userdata/environment-id"), `${here}\n`);
    return home;
  }
  function peer(answer: { code: number; stdout: string }) {
    const calls: { alias: string; command: string }[] = [];
    return { calls, settleCheck: settleCheckOver(async (alias, command) => (calls.push({ alias, command }), answer)) };
  }
  const remote = (action: string, environmentId = "env-peer") => organize({ action, threadId: "mcp:lane", environmentId });

  test("asks the peer's Hedge, and denies with its refusal", async () => {
    const ask = peer({ code: 0, stdout: `${JSON.stringify({ refusal: "Hedge blocked this settle: the thread owns open PR(s) x." })}\n` });
    const check = { ...deps([thread("mcp:lane")]), settleCheck: ask.settleCheck };
    expect(reasonOf(await guardSettle(remote("settle"), peerHome(), check))).toBe("Hedge blocked this settle: the thread owns open PR(s) x.");
    expect(ask.calls).toEqual([{ alias: "devbox-2", command: `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" sh ${remoteLauncher} pr settle-check --action settle --thread mcp:lane` }]);
  });

  test("lets the call through when the peer's Hedge finds nothing to refuse", async () => {
    const check = { ...deps([thread("mcp:lane", { pullRequests: [pr(1)] })]), settleCheck: peer({ code: 0, stdout: '{"refusal":null}\n' }).settleCheck };
    expect(await guardSettle(remote("snooze"), peerHome(), check)).toBeUndefined();
  });

  test("reads the machine's threads through T3 when the peer's Hedge does not answer, is older, or answers with something else", async () => {
    const answers = [{ code: 255, stdout: "" }, { code: 1, stdout: "hedge pr: Usage: hedge pr <subcommand>\n" }, { code: 0, stdout: "Unknown command settle-check\n" }, { code: 0, stdout: '{"refusal":false}\n' }, { code: 0, stdout: '{"refusal":" "}\n' }];
    for (const answer of answers) {
      const owning = { ...deps([thread("mcp:lane", { pullRequests: [pr(1)] })]), settleCheck: peer(answer).settleCheck };
      expect(reasonOf(await guardSettle(remote("settle"), peerHome(), owning))).toContain("open PR(s) https://github.com/acme/app/pull/1, and");
      const pinned = { ...deps([thread("mcp:lane", { pinnedAt: "2026-11-13T15:13:00.339Z" })]), settleCheck: peer(answer).settleCheck };
      expect(reasonOf(await guardSettle(remote("snooze"), peerHome(), pinned))).toContain("Robin pinned this thread");
      const free = { ...deps([thread("mcp:lane")]), settleCheck: peer(answer).settleCheck };
      expect(await guardSettle(remote("settle"), peerHome(), free)).toBeUndefined();
    }
  });

  test("refuses a snooze when neither the peer's Hedge nor T3 answers, or T3 does not list the thread, since nothing can show it is not pinned", async () => {
    const check = { ...deps(undefined), settleCheck: peer({ code: 255, stdout: "" }).settleCheck };
    expect(reasonOf(await guardSettle(remote("snooze"), peerHome(), check))).toBe("Hedge blocked this snooze: T3 did not answer; retry, or snooze in the T3 UI.");
    const missing = { ...deps([thread("mcp:other")]), settleCheck: peer({ code: 255, stdout: "" }).settleCheck };
    expect(reasonOf(await guardSettle(remote("snooze"), peerHome(), missing))).toContain("T3 did not list thread mcp:lane");
  });

  test("reads the machine's threads through T3 when no peer has its environment, or when it is this machine", async () => {
    for (const [home, environmentId] of [[peerHome("env-other"), "env-peer"], [peerHome("env-peer", "env-peer"), "env-peer"]] as const) {
      const ask = peer({ code: 0, stdout: '{"refusal":null}\n' });
      const check = { ...deps([thread("mcp:lane", { pullRequests: [pr(2)] })]), settleCheck: ask.settleCheck };
      expect(reasonOf(await guardSettle(remote("settle", environmentId), home, check))).toContain("pull/2,");
      expect(ask.calls).toEqual([]);
    }
  });

  test("never sends a thread id that a shell could read as more than one word", async () => {
    const ask = peer({ code: 0, stdout: '{"refusal":null}\n' });
    const check = { ...deps([]), settleCheck: ask.settleCheck };
    await guardSettle(organize({ action: "settle", threadId: "mcp:x'; rm -rf ~; '", environmentId: "env-peer" }), peerHome(), check);
    expect(ask.calls).toEqual([]);
  });

  test("hedge pr settle-check takes one action and one thread", () => {
    expect(parseSettleCheck(["--action", "snooze", "--thread", "mcp:lane"])).toEqual({ action: "snooze", threadId: "mcp:lane" });
    for (const args of [[], ["--action", "pin", "--thread", "mcp:lane"], ["--action", "settle", "--thread", "a b"], ["--action", "settle"]]) {
      expect(() => parseSettleCheck(args)).toThrow(settleCheckUsage);
    }
  });
});
