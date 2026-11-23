import { expect, test } from "bun:test";
import { slack } from "./apps.ts";
import { lostCode, reAuthLine, signInLost } from "./sign-in-lost.ts";

test("the auth errors of a dead sign-in count as lost, and other failures do not", () => {
  for (const text of ['HTTP 401: {"code":"token_revoked"}', '{"ok":false,"error":"invalid_auth"}', "not_authed", "account_inactive", "refresh_token_reused", "invalid_grant"]) expect(signInLost(text)).toBe(true);
  for (const text of ["channel_not_found", "HTTP 429 rate limited", "my_token_revoked_notes", "The Codex app backend exited."]) expect(signInLost(text)).toBe(false);
});

test("a code counts in any string of an error payload, also right after an escape character", () => {
  expect(lostCode(["Unauthorized", { detail: "HTTP 401\ftoken_revoked" }])).toBe("token_revoked");
});

test("a payload nested past any real error's depth is read only that deep, so its message still counts", () => {
  let nested: unknown = "token_revoked";
  for (let level = 0; level < 100_000; level++) nested = { inner: nested };
  expect(signInLost(["HTTP 401 token_revoked", nested])).toBe(true);
});

test("the re-auth line names the one step that signs the app in again", () => {
  expect(reAuthLine(slack)).toBe("Slack needs re-auth: on the hub, run: hedge mcp-gateway sign-in slack. When calls still fail after it, reconnect Slack in ChatGPT, Settings, Apps.");
});
