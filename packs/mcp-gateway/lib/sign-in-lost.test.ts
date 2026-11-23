import { afterEach, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { gmail, googleCalendar, slack } from "./apps.ts";
import { alertLostSignIns, clearSignInLost, markSignInLost, reAuthLine, signInLost, signInLostSince } from "./sign-in-lost.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function slackHome() {
  const home = temp.make("slack-codex-");
  writeFileSync(join(home, "auth.json"), "{}");
  utimesSync(join(home, "auth.json"), 1000, 1000);
  const started: Array<{ title: string; prompt: string }> = [];
  let down = false;
  const logged: string[] = [];
  const watch = {
    lost: async () => {
      const since = await signInLostSince(home, "slack");
      return since === undefined ? [] : [{ apps: [slack], since }];
    },
    threads: { start: async (def: { title: string; prompt: string }) => { if (down) throw new Error("T3 is down"); started.push(def); return { id: `t${started.length}` }; }, send: async () => true },
    statePath: join(temp.make("sign-in-watch-"), "state", "sign-in-watch.json"),
    log: (line: string) => void logged.push(line),
  };
  const signIn = (at: number) => utimesSync(join(home, "auth.json"), at, at);
  return { home, watch, started, logged, signIn, setDown: (value: boolean) => { down = value; } };
}

test("the auth errors of a dead sign-in count as lost, and other failures do not", () => {
  for (const text of ['HTTP 401: {"code":"token_revoked"}', '{"ok":false,"error":"invalid_auth"}', "not_authed", "account_inactive", "refresh_token_reused", "invalid_grant"]) expect(signInLost(text)).toBe(true);
  for (const text of ["channel_not_found", "HTTP 429 rate limited", "my_token_revoked_notes", "The Codex app backend exited."]) expect(signInLost(text)).toBe(false);
});

test("the re-auth line names the one step that signs every app of the account in again", () => {
  expect(reAuthLine([slack])).toBe("Slack needs re-auth: on the hub, run: hedge mcp-gateway sign-in slack. When calls still fail after it, reconnect Slack in ChatGPT, Settings, Apps.");
  expect(reAuthLine([gmail, googleCalendar])).toStartWith("Gmail, Google Calendar need re-auth: on the hub, run: hedge mcp-gateway sign-in gmail.");
});

test("calls that keep failing on one lost sign-in start one re-auth thread, and a sign-in that is lost again after a new one starts another", async () => {
  const { home, watch, started, logged, signIn } = slackHome();
  await markSignInLost(home, "slack");
  utimesSync(join(home, "sign-in-lost-slack"), 2000, 2000);
  await alertLostSignIns(watch);
  await markSignInLost(home, "slack");
  await markSignInLost(home, "slack");
  await alertLostSignIns(watch);
  expect(started.map(({ title }) => title)).toEqual(["Slack needs re-auth"]);
  expect(started[0]!.prompt).toContain("hedge mcp-gateway sign-in slack");
  expect(logged).toEqual([reAuthLine([slack])]);
  signIn(3000);
  await alertLostSignIns(watch);
  expect(started).toHaveLength(1);
  await markSignInLost(home, "slack");
  await alertLostSignIns(watch);
  expect(started.map(({ title }) => title)).toEqual(["Slack needs re-auth", "Slack needs re-auth"]);
});

test("a call that works again clears the lost sign-in, so the next loss starts a new thread", async () => {
  const { home, watch, started } = slackHome();
  await markSignInLost(home, "slack");
  utimesSync(join(home, "sign-in-lost-slack"), 2000, 2000);
  await alertLostSignIns(watch);
  await clearSignInLost(home, "slack");
  expect(await signInLostSince(home, "slack")).toBeUndefined();
  await alertLostSignIns(watch);
  expect(started).toHaveLength(1);
  await markSignInLost(home, "slack");
  await alertLostSignIns(watch);
  expect(started).toHaveLength(2);
});

test("a re-auth thread that T3 could not start is tried again at the next check", async () => {
  const { home, watch, started, logged, setDown } = slackHome();
  await markSignInLost(home, "slack");
  setDown(true);
  await alertLostSignIns(watch);
  expect(logged).toEqual([reAuthLine([slack]), "Could not start the re-auth thread: T3 is down"]);
  setDown(false);
  await alertLostSignIns(watch);
  expect(started.map(({ title }) => title)).toEqual(["Slack needs re-auth"]);
});
