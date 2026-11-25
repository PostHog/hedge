import type { CodexApp } from "./apps.ts";

const lostCodes = /\b(token_revoked|token_expired|refresh_token_reused|invalid_grant|invalid_auth|not_authed|account_inactive)\b/;

const texts = (said: unknown, depth = 0): string[] =>
  typeof said === "string" ? [said] : said && typeof said === "object" && depth < 32 ? Object.values(said).flatMap((inner) => texts(inner, depth + 1)) : [];
export const lostCode = (said: unknown) => texts(said).map((text) => text.match(lostCodes)?.[1]).find(Boolean);
export const signInLost = (said: unknown) => lostCode(said) !== undefined;

export const reAuthLine = (app: Pick<CodexApp, "name" | "title">) =>
  `${app.title} needs re-auth: on the hub, run: hedge mcp-gateway sign-in ${app.name}. When calls still fail after it, reconnect ${app.title} in ChatGPT, Settings, Apps.`;
