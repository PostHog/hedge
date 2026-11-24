import type { Run } from "./pr-ci.ts";

export type Gh = (args: string[]) => Promise<string>;

export const runGh: Gh = async (args) => {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`gh ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
};

export const ghThrough = (run: Run): Gh => async (args) => {
  const result = run(["gh", ...args]);
  if (result.code) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim().split("\n")[0] || "no output"}`);
  return result.stdout.trim();
};
