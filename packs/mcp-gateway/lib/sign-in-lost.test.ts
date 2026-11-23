import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { gmail, googleCalendar, slack } from "./apps.ts";
import { alertLostSignIns, reAuthLine, signInLost, type LostSignIn } from "./sign-in-lost.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function watched(lost: LostSignIn[], fails = false) {
  const started: Array<{ key: string; title: string; prompt: string }> = [];
  const logged: string[] = [];
  const watch = {
    lost: async () => lost,
    threads: { start: async (def: { key: string; title: string; prompt: string }) => { if (fails) throw new Error("T3 is down"); started.push(def); return { id: `t${started.length}` }; }, send: async () => true },
    statePath: join(temp.make("sign-in-watch-"), "state", "sign-in-watch.json"),
    log: (line: string) => void logged.push(line),
  };
  return { watch, started, logged };
}

test("the auth errors of a dead sign-in count as lost, and other failures do not", () => {
  for (const text of ['HTTP 401: {"code":"token_revoked"}', '{"ok":false,"error":"invalid_auth"}', "not_authed", "account_inactive", "refresh_token_reused", "invalid_grant"]) expect(signInLost(text)).toBe(true);
  for (const text of ["channel_not_found", "HTTP 429 rate limited", "my_token_revoked_notes", "The Codex app backend exited."]) expect(signInLost(text)).toBe(false);
});

test("the re-auth line names the one step that signs every app of the account in again", () => {
  expect(reAuthLine([slack])).toBe("Slack needs re-auth: on the hub, run: hedge mcp-gateway sign-in slack. When calls still fail after it, reconnect Slack in ChatGPT, Settings, Apps.");
  expect(reAuthLine([gmail, googleCalendar])).toStartWith("Gmail, Google Calendar need re-auth: on the hub, run: hedge mcp-gateway sign-in gmail.");
});

test("a lost sign-in starts one re-auth thread, and later checks start none until it is lost again", async () => {
  const lost = [{ apps: [slack], since: 1_700_000_000_000 }];
  const { watch, started, logged } = watched(lost);
  await alertLostSignIns(watch);
  await alertLostSignIns(watch);
  expect(started.map(({ key, title }) => ({ key, title }))).toEqual([{ key: "sign-in-lost-slack-1700000000000", title: "Slack needs re-auth" }]);
  expect(started[0]!.prompt).toContain("hedge mcp-gateway sign-in slack");
  expect(logged).toEqual([reAuthLine([slack])]);
  lost[0]!.since = 1_700_000_900_000;
  await alertLostSignIns(watch);
  expect(started.map(({ key }) => key)).toEqual(["sign-in-lost-slack-1700000000000", "sign-in-lost-slack-1700000900000"]);
});

test("a re-auth thread that T3 could not start is tried again at the next check", async () => {
  const lost = [{ apps: [slack], since: 5 }];
  const down = watched(lost, true);
  await alertLostSignIns(down.watch);
  expect(down.logged).toEqual([reAuthLine([slack]), "Could not start the re-auth thread: T3 is down"]);
  const up = watched(lost);
  up.watch.statePath = down.watch.statePath;
  await alertLostSignIns(up.watch);
  expect(up.started.map(({ key }) => key)).toEqual(["sign-in-lost-slack-5"]);
});
