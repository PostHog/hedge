import { afterEach, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { slack } from "./apps.ts";
import { clearSignInLost, markSignInLost, reAuthLine, signInLost, signInLostSince } from "./sign-in-lost.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

test("the auth errors of a dead sign-in count as lost, and other failures do not", () => {
  for (const text of ['HTTP 401: {"code":"token_revoked"}', '{"ok":false,"error":"invalid_auth"}', "not_authed", "account_inactive", "refresh_token_reused", "invalid_grant"]) expect(signInLost(text)).toBe(true);
  for (const text of ["channel_not_found", "HTTP 429 rate limited", "my_token_revoked_notes", "The Codex app backend exited."]) expect(signInLost(text)).toBe(false);
});

test("the re-auth line names the one step that signs the app in again", () => {
  expect(reAuthLine(slack)).toBe("Slack needs re-auth: on the hub, run: hedge mcp-gateway sign-in slack. When calls still fail after it, reconnect Slack in ChatGPT, Settings, Apps.");
});

test("a loss keeps the time of its first failure while calls keep failing, and a working call ends it", async () => {
  const home = temp.make("slack-codex-");
  expect(await signInLostSince(home, "slack")).toBeUndefined();
  await markSignInLost(home, "slack");
  utimesSync(join(home, "sign-in-lost-slack"), 2000, 2000);
  await markSignInLost(home, "slack");
  expect(await signInLostSince(home, "slack")).toBe(2_000_000);
  expect(await signInLostSince(home, "gmail")).toBeUndefined();
  await clearSignInLost(home, "slack");
  expect(await signInLostSince(home, "slack")).toBeUndefined();
});
