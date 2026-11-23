import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { hedgeMachine, runHedge } from "../../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

async function balancingDevbox() {
  const home = temp.make("hedge-cli-proxy-cli-");
  const profile = await hedgeMachine(home, { "hub.alias": "my-hub" });
  const hedge = JSON.parse(readFileSync(join(profile, "hedge.json"), "utf8"));
  writeFileSync(join(profile, "hedge.json"), JSON.stringify({ ...hedge, packs: ["hub"], workflows: { "own-account-balancing": true } }));
  return home;
}

test("through hedge, the hub-only modes and the balancer refuse on a devbox, and the checks without a key wait for the person and change nothing", async () => {
  const home = await balancingDevbox();
  const install = await runHedge(["cli-proxy", "install"], { HOME: home });
  expect([install.code, install.stderr]).toEqual([1, "hedge cli-proxy: hedge cli-proxy install runs only on the hub. This machine's role is linux. Run hedge hub here on the hub, or run this there.\n"]);
  const balance = await runHedge(["cli-proxy-balance"], { HOME: home });
  expect([balance.code, balance.stderr]).toEqual([1, "hedge cli-proxy-balance: hedge cli-proxy-balance runs only on the hub. This machine's role is linux. Run hedge hub here on the hub, or run this there.\n"]);
  const usage = await runHedge(["cli-proxy", "connect", "extra"], { HOME: home });
  expect(usage.code).toBe(2);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: 'cat "$HOME/.config/hedge/cli-proxy.key"' }));
  const check = await runHedge(["cli-proxy", "check"], { HOME: home });
  expect(check.code).toBe(4);
  expect(check.stdout).toContain("hedge apply keeps Claude Code on its own sign-in until the proxy serves it.");
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).apiKeyHelper).toBe('cat "$HOME/.config/hedge/cli-proxy.key"');
  const codex = await runHedge(["cli-proxy", "check", "codex"], { HOME: home });
  expect([codex.code, codex.stdout]).toEqual([4, expect.stringContaining("hedge apply keeps Codex on its own sign-in until the proxy serves it.")]);
  for (const args of [["check", "claude"], ["route"]]) expect((await runHedge(["cli-proxy", ...args], { HOME: home })).code).toBe(2);
});

test("through hedge, the hub's proxy keeps its panel off until the Proxy panel workflow is on, and that workflow needs Own-account balancing", async () => {
  const home = await balancingDevbox();
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")), role: "hub" }));
  const profilePath = join(home, "profile/hedge.json");
  const turn = (workflows: Record<string, boolean>) => writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath, "utf8")), workflows }));
  const plan = async () => (await runHedge(["cli-proxy", "plan"], { HOME: home })).stdout;
  expect(await plan()).toContain("  Keep the management panel off. Turn on the Proxy panel workflow to serve it.\n");
  turn({ "own-account-balancing": true, "proxy-panel": true });
  expect(await plan()).toContain("  Serve the management panel 1.27.3-fleet.3 at http://127.0.0.1:8317/management.html, loopback only, with 35 days of quota history from the quota-ledger plugin 0.1.0.\n");
  turn({ "proxy-panel": true });
  expect(await plan()).not.toContain("Serve the management panel");
});

test("through hedge, plan and install on a hub without the proxy binary yet name the install instead of stopping at the missing file", async () => {
  const home = await balancingDevbox();
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")), role: "hub" }));
  const plan = await runHedge(["cli-proxy", "plan"], { HOME: home });
  expect([plan.code, plan.stderr, plan.stdout]).toEqual([0, "", expect.stringContaining(`  Install CLIProxyAPI 8.0.46 at ${join(home, ".local/share/hedge-cli-proxy/cli-proxy-api")}.\n`)]);
});

function fakeProxy(dir: string) {
  const log = join(dir, "proxy-calls.log");
  const preload = join(dir, "fake-proxy.ts");
  writeFileSync(preload, `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
const usage = { seven_day: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" } };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "http://127.0.0.1:8317") return real(input, init);
  appendFileSync(${JSON.stringify(log)}, \`\${init?.method ?? "GET"} \${url.pathname}\\n\`);
  const path = url.pathname.replace("/v0/management/", "");
  if (path === "routing/strategy") return Response.json({ strategy: "fill-first" });
  if (path === "auth-files") return Response.json({ files: [{ name: "a.json", provider: "claude", auth_index: "1", priority: 1 }] });
  if (path === "api-call") return Response.json({ status_code: 200, body: JSON.stringify(usage) });
  if (path === "quota-ledger/samples") return Response.json({ accepted: 1 });
  return new Response("missing", { status: 404 });
}) as typeof fetch;
`);
  return { env: { BUN_OPTIONS: `--preload ${preload}`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("through hedge, cli-proxy-balance posts quota history to the ledger only while the Proxy panel workflow is on", async () => {
  const home = await balancingDevbox();
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8")), role: "hub" }));
  mkdirSync(join(home, ".local/share/hedge-cli-proxy"), { recursive: true });
  writeFileSync(join(home, ".local/share/hedge-cli-proxy/management.env"), `MANAGEMENT_PASSWORD=${"d2".repeat(32)}\n`);
  const profilePath = join(home, "profile/hedge.json");
  const turn = (workflows: Record<string, boolean>) => writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(readFileSync(profilePath, "utf8")), workflows }));
  for (const [panel, posted] of [[false, false], [true, true]] as const) {
    turn({ "own-account-balancing": true, ...(panel ? { "proxy-panel": true } : {}) });
    const proxy = fakeProxy(temp.make("hedge-fake-proxy-"));
    const run = await runHedge(["cli-proxy-balance"], { HOME: home, ...proxy.env });
    expect([panel, run.code, run.stderr]).toEqual([panel, 0, ""]);
    expect([panel, proxy.calls()]).toEqual([panel, expect.stringContaining("GET /v0/management/auth-files\n")]);
    expect([panel, proxy.calls().includes("POST /v0/management/quota-ledger/samples\n")]).toEqual([panel, posted]);
  }
});
