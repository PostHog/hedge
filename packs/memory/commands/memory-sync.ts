import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { forgetOldShown } from "../lib/notes.ts";

export function memoryUrl(repo: string) {
  return repo.includes("://") || repo.includes("@") ? repo : `https://github.com/${repo}.git`;
}

export async function syncMemory(env: Record<string, string | undefined> = Bun.env) {
  const repo = stringSetting("memory.repo", env);
  if (!repo) throw new Error("memory.repo is empty. Set it with hedge set memory.repo=<owner>/<repo>.");
  const subtree = stringSetting("memory.subtree", env);
  const child = Bun.spawn(["sh", join(import.meta.dir, "../sync/sync.sh")], { stdio: ["inherit", "inherit", "inherit"], env: { ...env, HEDGE_MEMORY_URL: memoryUrl(repo), HEDGE_MEMORY_SUBTREE: subtree } });
  const code = await child.exited;
  const home = env.HOME ?? homedir();
  try {
    forgetOldShown(home);
  } catch (error) {
    console.error(`Memory: cannot forget old shown-memory logs: ${error instanceof Error ? error.message : error}`);
  }
  return code;
}

if (import.meta.main) await runCommand(() => syncMemory(), "hedge memory-sync");
