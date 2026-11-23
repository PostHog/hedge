import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Threads } from "../../../src/sdk/index.ts";
import type { CodexApp } from "./apps.ts";

type Named = Pick<CodexApp, "name" | "title">;
export type LostSignIn = { apps: Named[]; since: number };
export type SignInWatch = { lost(): Promise<LostSignIn[]>; threads: Threads; statePath: string; log(line: string): void };

export const checkSignInsEveryMs = 5 * 60_000;
const lostCodes = /\b(token_revoked|token_expired|refresh_token_reused|invalid_grant|invalid_auth|not_authed|account_inactive)\b/;
const marker = "sign-in-lost";
const keepAlerts = 50;

export const signInLost = (text: string) => lostCodes.test(text);

const titles = (apps: Named[]) => apps.map((app) => app.title).join(", ");

export const reAuthLine = (apps: Named[]) =>
  `${titles(apps)} ${apps.length > 1 ? "need" : "needs"} re-auth: on the hub, run: hedge mcp-gateway sign-in ${apps[0]!.name}. When calls still fail after it, reconnect ${titles(apps)} in ChatGPT, Settings, Apps.`;

export const markSignInLost = (codexHome: string) => writeFile(join(codexHome, marker), `${new Date().toISOString()}\n`, { mode: 0o600 });

export async function signInLostSince(codexHome: string): Promise<number | undefined> {
  const [lost, auth] = await Promise.all([marker, "auth.json"].map((file) => stat(join(codexHome, file)).catch(() => undefined)));
  return lost && auth && lost.mtimeMs > auth.mtimeMs ? lost.mtimeMs : undefined;
}

export async function watchSignIns(watch: SignInWatch, sleep: (ms: number) => Promise<void>): Promise<never> {
  for (;;) {
    await alertLostSignIns(watch).catch((error: Error) => watch.log(`Could not check the app sign-ins: ${error.message}`));
    await sleep(checkSignInsEveryMs);
  }
}

export async function alertLostSignIns(watch: SignInWatch): Promise<void> {
  const alerted = readAlerted(watch.statePath);
  for (const { apps, since } of await watch.lost()) {
    const key = `sign-in-lost-${apps[0]!.name}-${Math.floor(since)}`;
    if (alerted.includes(key)) continue;
    watch.log(reAuthLine(apps));
    try {
      await watch.threads.start({ key, title: `${titles(apps)} ${apps.length > 1 ? "need" : "needs"} re-auth`, prompt: lostPrompt(apps, since), modelRole: "lookup" });
      alerted.push(key);
    } catch (error) { watch.log(`Could not start the re-auth thread: ${(error as Error).message}`); }
  }
  mkdirSync(dirname(watch.statePath), { recursive: true, mode: 0o700 });
  writeFileSync(`${watch.statePath}.tmp`, `${JSON.stringify(alerted.slice(-keepAlerts))}\n`, { mode: 0o600 });
  renameSync(`${watch.statePath}.tmp`, watch.statePath);
}

function readAlerted(path: string): string[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function lostPrompt(apps: Named[], since: number): string {
  const name = apps[0]!.name;
  return `The ChatGPT sign-in that Hedge's MCP gateway uses for ${titles(apps)} stopped working at ${new Date(since).toISOString()}: every agent call to it fails with an auth error such as token_revoked. Get it working again:

1. On the hub, run hedge mcp-gateway sign-in ${name} in the background with a terminal, such as script -qfc "hedge mcp-gateway sign-in ${name}" <log file>. It prints a link and a one-time code that expires in 15 minutes.
2. Ask the person to open the link, sign in with the ChatGPT account that has ${titles(apps)} connected, and enter the code. Put the link and the code in one card.
3. When the command says the sign-in worked, make one read call through the hedge-hub MCP server to prove it.

When calls still fail after a new sign-in, ask the person to reconnect ${titles(apps)} in ChatGPT, Settings, Apps, then run hedge mcp-gateway reconnect ${name} on the hub.`;
}
