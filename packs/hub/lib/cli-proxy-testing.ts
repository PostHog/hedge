import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerConfigAdapter } from "../../../src/adapters/provider-config/adapter.ts";
import type { AiPlan, MachineFile, Plan } from "../../../src/pack/types.ts";
import { apply } from "../../../src/reconciler/apply.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../src/testing/packs.ts";
import { cliProxy, proxyUrl, type ProxyMachine } from "./cli-proxy.ts";
import { fakeRun, roleHome } from "./run-testing.ts";

export const clientKey = "c1".repeat(32);
export const otherKey = "d2".repeat(32);
export const archive = "fake release archive";
export const release = { version: "9.9.9", url: "https://example.com/proxy.tar.gz", sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex") };
export const dataDir = (home: string) => join(home, ".local/share/hedge-cli-proxy");

export type Proxy = { catalog?: unknown; registry?: unknown; strategy?: string; credentials?: Array<{ name?: string; auth_index?: string; provider: string; disabled?: boolean; status?: string; unavailable?: boolean; status_message?: string }>; models?: string[]; down?: boolean; stopped?: boolean; refuses?: boolean; modelList?: string; silentModels?: boolean; authFiles?: unknown };

export function fakeProxy(proxy: Proxy = {}) {
  const requests: Array<{ path: string; method: string; auth: string }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ path: url.pathname, method: init?.method ?? "GET", auth });
    if (proxy.catalog !== undefined && url.pathname.endsWith("/codex_client_models.json")) return Response.json(proxy.catalog);
    if (proxy.registry !== undefined && url.pathname.endsWith("/models.json")) return Response.json(proxy.registry);
    if (proxy.down || proxy.stopped || url.origin !== proxyUrl) throw new TypeError("connection refused");
    if (url.pathname === "/v1/models" && proxy.silentModels) throw new TypeError("connection refused");
    if (url.pathname === "/v1/models" && proxy.modelList !== undefined) return new Response(proxy.modelList, { status: 200 });
    if (url.pathname === "/v1/models") return auth === `Bearer ${clientKey}` && !proxy.refuses ? Response.json({ data: (proxy.models ?? ["claude-sonnet-5-5"]).map((id) => ({ id })) }) : new Response("no", { status: 401 });
    if (url.pathname === "/v0/management/routing/strategy") return Response.json({ strategy: proxy.strategy ?? "fill-first" });
    if (url.pathname === "/v0/management/auth-files" && proxy.authFiles !== undefined) return Response.json(proxy.authFiles);
    if (url.pathname === "/v0/management/auth-files") return Response.json({ files: proxy.credentials ?? [{ provider: "claude" }, { provider: "claude" }] });
    return new Response("missing", { status: 404 });
  };
  return { fetch, requests };
}

const startsProxy = (command: string[]) => ["systemctl --user restart hedge-cli-proxy.service", "systemctl --user enable --now hedge-cli-proxy.service"].includes(command.join(" "));

export function proxyMachine(make: (prefix: string) => string, fields: Partial<ProxyMachine> = {}, proxy: Proxy = {}, options: { role?: string; checksum?: string } = {}) {
  const home = fields.home ?? roleHome(make("hedge-cli-proxy-"), options.role ?? "hub");
  const fake = fakeRun((command) => {
    if (command[0] === "curl") writeFileSync(command[command.indexOf("-o") + 1]!, options.checksum ?? archive);
    if (command[0] === "install") writeFileSync(command.at(-1)!, "binary");
    const installed = existsSync(join(dataDir(home), "cli-proxy-api"));
    if (command[0]!.endsWith("cli-proxy-api")) return { stdout: installed ? `CLIProxyAPI Version: ${release.version}, Commit: x\n` : "", code: installed ? 0 : 127 };
    if (command[0] === "ss") return { stdout: "LISTEN 0 4096 127.0.0.1:8317 0.0.0.0:*\n" };
    if (startsProxy(command) && existsSync(join(home, ".config/systemd/user/hedge-cli-proxy.service"))) proxy.stopped = false;
    return undefined;
  });
  const { fetch, requests } = fakeProxy(proxy);
  const printed: string[] = [];
  const keys = [clientKey, otherKey];
  const machine: ProxyMachine = {
    home, uid: 1000, user: "me", accounts: 2, devboxes: ["devbox-1", "box-lane"], release, run: fake.run, fetch, now: () => 1_800_000_000_000, sleep: async () => {},
    readStdin: async () => `${clientKey}\n`, randomKey: () => keys.shift()!, print: (line) => printed.push(line), ...fields,
  };
  return { machine, home, calls: fake.calls, inputs: fake.inputs, requests, printed };
}

export const proxyOnly = (result: Plan): Plan => ({ ...result, files: [], jobs: [], human: [], steps: result.steps.filter((step) => step.id === "cli-proxy"), checks: result.checks.filter((check) => check.workflow === "own-account-balancing"), config: result.config.filter((entry) => entry.workflow === "own-account-balancing") });

export const hedgeProxy = (machine: ProxyMachine, engineRoot: string | undefined) => async (command: string[]) => {
  const [shell, launcher, group, mode, ...rest] = command;
  const agent = mode === "check" && rest.join(" ") === "codex" ? "codex" : "claude";
  const known = (["install", "doctor", "accounts", "check"] as const).find((name) => name === mode);
  if (shell !== "/bin/sh" || !engineRoot || launcher !== join(engineRoot, "hedge") || group !== "cli-proxy" || !known || (rest.length && agent !== "codex")) throw new Error(`The hub pack runs no ${command.join(" ")}`);
  return cliProxy(known, machine, agent).catch(() => 1);
};

const answers = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux" };

export async function balancingPlan(make: (prefix: string) => string, plan: AiPlan, on = true, machine: MachineFile = devbox): Promise<Plan> {
  const engine = await engineSource();
  return proxyOnly(resolveEngine([engine, ...skillSources(make("skills-"), engine)], { settings: answers, packs: ["hub"], workflows: { "own-account-balancing": on }, plan }, machine));
}

const label = (finding: { todo?: true; repair?: string }) => (finding.todo || finding.repair === "human" ? "To do" : finding.repair ? "Fix" : "Note");

export function hedgeApply(machine: ProxyMachine, plan: () => Plan) {
  const quiet: ProxyMachine = { ...machine, print: () => {} };
  return async () => {
    const report = await apply(plan(), { home: machine.home, adapters: [providerConfigAdapter()], run: hedgeProxy(quiet, plan().engineRoot) }).catch((error: Error) => error);
    if (report instanceof Error) return { code: 1, stdout: "", stderr: `hedge: ${report.message}\n` };
    return { report, code: report.ok ? 0 : 1, stdout: report.findings.map((finding) => `${label(finding)}: ${finding.say}\n`).join(""), stderr: "" };
  };
}
