import { homedir } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { loopLedgerSetting, runLoop } from "../lib/loop.ts";

await runCommand(() => runLoop(Bun.argv.slice(2), { home: homedir(), ledger: () => optionalStringSetting(loopLedgerSetting), print: (line) => console.log(line) }));
