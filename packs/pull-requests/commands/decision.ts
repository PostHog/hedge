import { homedir } from "node:os";
import { threadModeEnv } from "../lib/mode-cli.ts";
import { decisionCommand } from "../lib/decision-cli.ts";

try {
  const home = Bun.env.HOME ?? homedir();
  process.exitCode = await decisionCommand(Bun.argv.slice(2), { home, cwd: process.cwd(), env: await threadModeEnv(home, Bun.env), print: (text) => console.log(text) });
} catch (error) {
  console.error(Bun.env.HEDGE_DEBUG ? (error as Error).stack : `hedge: ${(error as Error).message}`);
  process.exitCode = 1;
}
