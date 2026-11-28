import { homedir } from "node:os";
import { modeCommand } from "../lib/mode-cli.ts";

try {
  process.exitCode = await modeCommand(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), cwd: process.cwd(), env: Bun.env, print: (text) => console.log(text) });
} catch (error) {
  console.error(Bun.env.HEDGE_DEBUG ? (error as Error).stack : `hedge: ${(error as Error).message}`);
  process.exitCode = 1;
}
