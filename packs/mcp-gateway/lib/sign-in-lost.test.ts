import { afterEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { gmail, googleDrive, slack, type CodexApp } from "./apps.ts";
import { alertLostSignIns, clearSignInLost, markSignInLost, reAuthLine, signInLost, signInLostSince } from "./sign-in-lost.ts";
import { appHome, lostSignIns } from "./upstreams.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function hub() {
  const home = temp.make("sign-in-watch-");
  for (const app of [slack, gmail]) {
    mkdirSync(appHome(home, app), { recursive: true });
    writeFileSync(join(appHome(home, app), "auth.json"), "{}");
    utimesSync(join(appHome(home, app), "auth.json"), 1000, 1000);
  }
  const started: Array<{ title: string; prompt: string }> = [];
  let down = false;
  const logged: string[] = [];
  const watch = {
    lost: () => lostSignIns({ home }),
    threads: { start: async (def: { title: string; prompt: string }) => { if (down) throw new Error("T3 is down"); started.push(def); return { id: `t${started.length}` }; }, send: async () => true },
    statePath: join(home, ".local/state/hedge/sign-in-watch.json"),
    log: (line: string) => void logged.push(line),
  };
  const fail = async (app: CodexApp, at?: number) => {
    await markSignInLost(appHome(home, app), app.name);
    if (at !== undefined) utimesSync(join(appHome(home, app), `sign-in-lost-${app.name}`), at, at);
  };
  const work = (app: CodexApp) => clearSignInLost(appHome(home, app), app.name);
  const signIn = (app: CodexApp, at: number) => utimesSync(join(appHome(home, app), "auth.json"), at, at);
  const titles = () => started.map(({ title }) => title);
  return { home, watch, started, titles, logged, fail, work, signIn, setDown: (value: boolean) => { down = value; } };
}

test("the auth errors of a dead sign-in count as lost, and other failures do not", () => {
  for (const text of ['HTTP 401: {"code":"token_revoked"}', '{"ok":false,"error":"invalid_auth"}', "not_authed", "account_inactive", "refresh_token_reused", "invalid_grant"]) expect(signInLost(text)).toBe(true);
  for (const text of ["channel_not_found", "HTTP 429 rate limited", "my_token_revoked_notes", "The Codex app backend exited."]) expect(signInLost(text)).toBe(false);
});

test("the re-auth line names the one step that signs the app in again", () => {
  expect(reAuthLine(slack)).toBe("Slack needs re-auth: on the hub, run: hedge mcp-gateway sign-in slack. When calls still fail after it, reconnect Slack in ChatGPT, Settings, Apps.");
});

test("calls that keep failing on one lost sign-in start one re-auth thread, and a sign-in that is lost again after a new one starts another", async () => {
  const { watch, started, titles, logged, fail, signIn } = hub();
  await fail(slack, 2000);
  await alertLostSignIns(watch);
  await fail(slack);
  await fail(slack);
  await alertLostSignIns(watch);
  expect(titles()).toEqual(["Slack needs re-auth"]);
  expect(started[0]!.prompt).toContain("hedge mcp-gateway sign-in slack");
  expect(logged).toEqual([reAuthLine(slack)]);
  signIn(slack, 3000);
  await alertLostSignIns(watch);
  expect(started).toHaveLength(1);
  await fail(slack);
  await alertLostSignIns(watch);
  expect(titles()).toEqual(["Slack needs re-auth", "Slack needs re-auth"]);
});

test("a call that works again clears the lost sign-in, so the next loss starts a new thread", async () => {
  const { home, watch, started, fail, work } = hub();
  await fail(slack, 2000);
  await alertLostSignIns(watch);
  await work(slack);
  expect(await signInLostSince(appHome(home, slack), "slack")).toBeUndefined();
  await alertLostSignIns(watch);
  expect(started).toHaveLength(1);
  await fail(slack);
  await alertLostSignIns(watch);
  expect(started).toHaveLength(2);
});

test("apps that share one ChatGPT sign-in get one thread each as each is lost, and one recovering starts none for the other", async () => {
  const { watch, titles, fail, work } = hub();
  await fail(googleDrive, 2000);
  await alertLostSignIns(watch);
  await fail(gmail, 2500);
  await alertLostSignIns(watch);
  await work(googleDrive);
  await alertLostSignIns(watch);
  expect(titles()).toEqual(["Google Drive needs re-auth", "Gmail needs re-auth"]);
});

test("a re-auth thread that T3 could not start is tried again at the next check", async () => {
  const { watch, titles, logged, fail, setDown } = hub();
  await fail(slack);
  setDown(true);
  await alertLostSignIns(watch);
  expect(logged).toEqual([reAuthLine(slack), "Could not start the re-auth thread: T3 is down"]);
  setDown(false);
  await alertLostSignIns(watch);
  expect(titles()).toEqual(["Slack needs re-auth"]);
});
