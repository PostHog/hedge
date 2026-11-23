import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexApp } from "./apps.ts";

type Named = Pick<CodexApp, "name" | "title">;
export type LostSignIn = { app: Named; since: number };

const lostCodes = /\b(token_revoked|token_expired|refresh_token_reused|invalid_grant|invalid_auth|not_authed|account_inactive)\b/;
const marker = (app: string) => `sign-in-lost-${app}`;

const texts = (said: unknown): string[] =>
  typeof said === "string" ? [said] : said && typeof said === "object" ? Object.values(said).flatMap(texts) : [];
export const lostCode = (said: unknown) => texts(said).map((text) => text.match(lostCodes)?.[1]).find(Boolean);
export const signInLost = (said: unknown) => lostCode(said) !== undefined;

export const reAuthLine = (app: Named) =>
  `${app.title} needs re-auth: on the hub, run: hedge mcp-gateway sign-in ${app.name}. When calls still fail after it, reconnect ${app.title} in ChatGPT, Settings, Apps.`;

export async function markSignInLost(codexHome: string, app: string) {
  if ((await signInLostSince(codexHome, app)) === undefined) await writeFile(join(codexHome, marker(app)), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export const clearSignInLost = (codexHome: string, app: string) => rm(join(codexHome, marker(app)), { force: true });

export const signInLostSince = (codexHome: string, app: string): Promise<number | undefined> =>
  stat(join(codexHome, marker(app))).then((found) => found.mtimeMs, () => undefined);
