import { isAbsolute, relative, resolve } from "node:path";
import { legacyProfileFileName, profileFileName } from "../legacy.ts";
import type { Finding, HumanStep, Owned, Plan } from "../pack/types.ts";
import { withoutRepoEnv } from "../repo-env.ts";

const healthLimitMs = 3000;
const baseProfilePaths = [profileFileName, legacyProfileFileName, "about-me.md", "overrides", "guards", "packs", "install.sh", "README.md"];

/** What doctor adds to tell nodes apart from the hub: the profile commit this machine follows, and on the hub and its named nodes each served service that does not answer at loopback. A solo machine has no nodes to drift from. The hub skips a service whose install step is still left, which doctor names already. */
export async function drift(plan: Plan, left: Array<Owned<HumanStep>>): Promise<Finding[]> {
  const findings: Finding[] = [];
  const commit = plan.machine.profileDir ? await profileCommit(plan.machine.profileDir, plan) : undefined;
  if (commit) findings.push({ id: "drift:profile", pack: "engine", say: `Your profile is at commit ${commit}. Every node of it should show the same commit.` });
  const isHub = plan.onHub && plan.hub !== undefined;
  if (!isHub && !plan.reachesHub) return findings;
  const tested = (plan.catalog ?? []).filter((entry) => !(entry.after && left.some((step) => step.pack === entry.pack && step.id === entry.after)));
  const answered = await Promise.all(tested.map((entry) => answers(`http://127.0.0.1:${entry.port}${entry.health}`)));
  const where = plan.reachesHub ? `Check this machine's forward to the hub ${plan.hub}, and the service on the hub.` : "Check the service on this machine.";
  tested.forEach((entry, index) => {
    if (answered[index]) return;
    findings.push({ id: `drift:${entry.pack}/${entry.id}`, pack: entry.pack, say: `${entry.pack}/${entry.id} does not answer at http://127.0.0.1:${entry.port}${entry.health}. ${where}`, repair: "human" });
  });
  return findings;
}

async function answers(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(healthLimitMs) })).ok;
  } catch {
    return false;
  }
}

function profilePaths(dir: string, plan: Plan) {
  const root = resolve(dir);
  const linked = plan.files.flatMap((file) => {
    if (!("source" in file) || !file.source) return [];
    const rel = relative(root, resolve(file.source));
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [rel] : [];
  });
  return [...new Set([...baseProfilePaths, ...linked])];
}

async function profileCommit(dir: string, plan: Plan) {
  return (await gitOutput(dir, ["log", "-1", "--format=%h", "--", ...profilePaths(dir, plan)])) ?? (await gitOutput(dir, ["rev-parse", "--short", "HEAD"]));
}

async function gitOutput(dir: string, args: string[]) {
  try {
    const child = Bun.spawn(["git", "-C", dir, ...args], { env: withoutRepoEnv(), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? out.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}
