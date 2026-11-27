import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { ConfigEntry, Plan } from "../../pack/types.ts";
import { apply, check, filesAdapter } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import { stateLock, tryLock } from "../../lock.ts";
import { spawnRunner } from "../run.ts";
import { providerConfigAdapter, type CommandRunner } from "./adapter.ts";
import { snakeCase, trustedHash } from "./codex-hooks.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const claude = ".claude/settings.json";
const claudeJson = ".claude.json";
const codex = ".codex/config.toml";
const record = ".config/hedge/provider-fields.json";

function plan(config: Array<ConfigEntry & { pack?: string }> = []): Plan {
  return {
    machine: { schema: 1, role: "mac" },
    os: "darwin",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: config.map((entry) => ({ pack: "base", ...entry })),
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    models: [],
  };
}

function write(home: string, target: string, content: unknown) {
  mkdirSync(dirname(join(home, target)), { recursive: true });
  writeFileSync(join(home, target), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

const read = (home: string, target: string) => JSON.parse(readFileSync(join(home, target), "utf8"));
const pluginRecord = ".config/hedge/provider-plugins.json";
const earlierRecord = ".config/hedge/plugins.json";
const backups = (home: string) => {
  const root = join(home, ".local/state/hedge/backups");
  return existsSync(root) ? readdirSync(root).map((run) => join(root, run)) : [];
};

function claudeCli(installed: string[] = []) {
  const calls: string[][] = [];
  const run: CommandRunner = async (command) => {
    calls.push(command);
    if (command.join(" ") === "claude plugin list --json") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user", version: "1.0.0", enabled: true }))) };
    if (command[2] === "install") installed.push(command[3]!);
    if (command[2] === "uninstall") installed.splice(installed.indexOf(command[3]!), 1);
    return { code: 0, stdout: "" };
  };
  return { calls, run, adapter: providerConfigAdapter({ run }) };
}

const adapters = (run = claudeCli().run) => [filesAdapter, providerConfigAdapter({ run })];

describe("provider config", () => {
  test("removes a proxy base URL it recorded with a backup, and keeps every key Hedge has no record of", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }]), { home, adapters: adapters() });
    const before = { model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", MY_FLAG: "1" }, permissions: { allow: ["Bash(ls)"] } };
    write(home, claude, before);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus", env: { MY_FLAG: "1" }, permissions: { allow: ["Bash(ls)"] } });
    expect(report.actions).toContainEqual({ target: claude, operation: "replace", reason: "remove env.ANTHROPIC_BASE_URL" });
    const run = backups(home).at(-1);
    expect(JSON.parse(readFileSync(join(run!, claude), "utf8"))).toEqual(before);
  });

  test("takes the proxy route it recorded out together with a token of yours beside it, so the token never goes to Anthropic, and names the token without its value", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    await apply(plan(route), { home, adapters: adapters() });
    write(home, claude, { ...read(home, claude), model: "opus", env: { ...read(home, claude).env, ANTHROPIC_AUTH_TOKEN: "my-token", MY_FLAG: "1" } });

    const taken = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus", env: { MY_FLAG: "1" } });
    expect(taken.actions).toContainEqual({ target: claude, operation: "replace", reason: "remove env.ANTHROPIC_BASE_URL, apiKeyHelper, env.ANTHROPIC_AUTH_TOKEN" });
    expect(taken.findings).toContainEqual({ id: `route:${claude}`, pack: "engine", say: `Took Hedge's proxy route out of ${claude}, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.`, todo: true });
    expect(JSON.stringify(taken.findings)).not.toContain("my-token");
    expect((await apply(plan(), { home, adapters: adapters() })).actions).toEqual([]);
  });

  test("switching from Hedge's Claude proxy to a profile's own key helper in one apply sets that helper and owns it, so dropping it later removes it, and a helper you edited leaves with the route", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    const helper = [{ provider: "claude" as const, key: "apiKeyHelper", value: "team-helper", pack: "team" }];
    await apply(plan(route), { home, adapters: adapters() });

    const switched = await apply(plan(helper), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ apiKeyHelper: "team-helper" });
    expect(switched.findings.map((finding) => finding.id)).not.toContain(`route:${claude}`);
    expect((await apply(plan(helper), { home, adapters: adapters() })).actions).toEqual([]);
    const dropped = await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({});
    expect(dropped.actions).toContainEqual({ target: claude, operation: "replace", reason: "remove apiKeyHelper" });

    const edited = temp.make("home-");
    await apply(plan(route), { home: edited, adapters: adapters() });
    write(edited, claude, { ...read(edited, claude), apiKeyHelper: "my-helper", env: { ...read(edited, claude).env, ANTHROPIC_AUTH_TOKEN: "my-token" } });

    const taken = await apply(plan(helper), { home: edited, adapters: adapters() });

    expect(read(edited, claude)).toEqual({});
    expect(taken.findings.map((finding) => finding.say)).not.toContain(`Kept your apiKeyHelper in ${claude}. Run hedge apply --adopt ${claude} to take Hedge's value.`);
    expect(taken.findings).toContainEqual({ id: `route:${claude}`, pack: "engine", say: `Took Hedge's proxy route out of ${claude}, and with it your apiKeyHelper, env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.`, todo: true });
    expect(JSON.stringify(taken.findings)).not.toContain("my-helper");
    await apply(plan(helper), { home: edited, adapters: adapters() });
    expect(read(edited, claude)).toEqual({ apiKeyHelper: "team-helper" });
  });

  test("switching from Hedge's Claude proxy URL to a profile's own gateway takes a proxy token beside it out and names it in the To do", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    const gateway = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com", pack: "profile" }];
    await apply(plan(route), { home, adapters: adapters() });
    write(home, claude, { ...read(home, claude), env: { ...read(home, claude).env, ANTHROPIC_AUTH_TOKEN: "proxy-token" } });

    const switched = await apply(plan(gateway), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } });
    expect(switched.findings).toContainEqual({ id: `route:${claude}`, pack: "engine", say: `Took Hedge's proxy route out of ${claude}, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.`, todo: true });
    expect(JSON.stringify(switched.findings)).not.toContain("proxy-token");
    expect((await apply(plan(gateway), { home, adapters: adapters() })).actions).toEqual([]);
  });

  test("a proxy token you set by hand leaves with Hedge's route even when a profile sets a token of its own, and the next apply sets the profile's token", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    const token = [{ provider: "claude" as const, key: "env.ANTHROPIC_AUTH_TOKEN", value: "team-token", pack: "profile" }];
    await apply(plan(route), { home, adapters: adapters() });
    write(home, claude, { ...read(home, claude), env: { ...read(home, claude).env, ANTHROPIC_AUTH_TOKEN: "proxy-token" } });

    const taken = await apply(plan(token), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({});
    expect(taken.findings).toContainEqual({ id: `route:${claude}`, pack: "engine", say: `Took Hedge's proxy route out of ${claude}, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.`, todo: true });
    expect(taken.findings.map((finding) => finding.say).join("\n")).not.toContain("Kept your");
    expect(JSON.stringify(taken.findings)).not.toContain("proxy-token");
    await apply(plan(token), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: "team-token" } });
  });

  test("takes an ANTHROPIC_API_KEY and a key helper you edited out with Hedge's proxy URL, and names both without their values", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    await apply(plan(route), { home, adapters: adapters() });
    write(home, claude, { ...read(home, claude), apiKeyHelper: "my-helper --secret", env: { ...read(home, claude).env, ANTHROPIC_API_KEY: "my-key" } });

    const taken = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({});
    expect(taken.findings).toContainEqual({ id: `route:${claude}`, pack: "engine", say: `Took Hedge's proxy route out of ${claude}, and with it your apiKeyHelper, env.ANTHROPIC_API_KEY, which only worked through that route.`, todo: true });
    expect(JSON.stringify(taken.findings)).not.toContain("my-key");
    expect(JSON.stringify(taken.findings)).not.toContain("--secret");
    expect((await apply(plan(), { home, adapters: adapters() })).actions).toEqual([]);
  });

  test("when the plugin step throws after the settings write, for a malformed provider-plugins.json, the error still holds the To do that names the token taken out with the route", async () => {
    const home = temp.make("home-");
    const route = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude" as const, key: "apiKeyHelper", value: 'cat "$HOME/.config/hedge/cli-proxy.key"', pack: "hub" }];
    await apply(plan(route), { home, adapters: adapters() });
    write(home, claude, { ...read(home, claude), env: { ...read(home, claude).env, ANTHROPIC_AUTH_TOKEN: "my-token" } });
    write(home, pluginRecord, "{");

    const error = (await apply(plan(), { home, adapters: adapters() }).catch((thrown: Error) => thrown)) as Error;

    expect(read(home, claude)).toEqual({});
    expect(error.message).toContain(`\nTo do: Took Hedge's proxy route out of ${claude}, and with it your env.ANTHROPIC_AUTH_TOKEN, which only worked through that route.`);
    expect(error.message).not.toContain("my-token");
  });

  test("a profile that drops its own Claude gateway takes only that gateway out, field by field as on the base: your token stays, and a gateway URL you edited stays", async () => {
    const home = temp.make("home-");
    const gateway = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com", pack: "team" }];
    await apply(plan(gateway), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "my-token" } });

    const dropped = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: "my-token" } });
    expect(dropped.actions).toContainEqual({ target: claude, operation: "replace", reason: "remove env.ANTHROPIC_BASE_URL" });
    expect(dropped.findings.map((finding) => finding.id)).not.toContain(`route:${claude}`);
    await apply(plan(gateway), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "https://my-gateway.example.com", ANTHROPIC_AUTH_TOKEN: "my-token" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "https://my-gateway.example.com", ANTHROPIC_AUTH_TOKEN: "my-token" } });
  });

  test("a profile's own Claude gateway and key helper are set field by field: a key helper you edited stays, and the gateway is still set", async () => {
    const home = temp.make("home-");
    write(home, claude, { apiKeyHelper: "my-helper" });
    const gateway = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com", pack: "team" }, { provider: "claude" as const, key: "apiKeyHelper", value: "team-helper", pack: "team" }];

    const report = await apply(plan(gateway), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ apiKeyHelper: "my-helper", env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } });
    expect(report.findings.map((finding) => finding.say)).toContain(`Kept your apiKeyHelper in ${claude}. Run hedge apply --adopt ${claude} to take Hedge's value.`);
  });

  test("keeps a proxy base URL that Hedge has no record of", async () => {
    const home = temp.make("home-");
    const settings = { env: { ANTHROPIC_BASE_URL: "http://localhost:8317/", ANTHROPIC_AUTH_TOKEN: "token" } };
    write(home, claude, settings);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual(settings);
    expect(report.actions).toEqual([]);
  });

  test("keeps a route with Hedge's own proxy values that Hedge has no record of", async () => {
    const home = temp.make("home-");
    const unrecorded = { model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: 'cat "$HOME/.config/hedge/cli-proxy.key"' };
    write(home, claude, unrecorded);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual(unrecorded);
    expect(report.actions).toEqual([]);
  });

  test("keeps a base URL that points at a gateway the user chose", async () => {
    const home = temp.make("home-");
    const settings = { env: { ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "token" } };
    write(home, claude, settings);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual(settings);
    expect(report.actions).toEqual([]);
    expect(backups(home)).toEqual([]);
  });

  test("keeps a Codex provider table and its selector that Hedge has no record of, though it points at the proxy port", async () => {
    const home = temp.make("home-");
    const mine = { model: "gpt-5", model_provider: "my-proxy", model_providers: { "my-proxy": { name: "Mine", base_url: "http://127.0.0.1:8317/v1", request_max_retries: 9 }, "hedge-proxy": { base_url: "http://hub.example.test:8317/v1" } } };
    write(home, codex, stringify(mine));
    const hub = [{ provider: "codex" as const, key: "model_provider", value: "hedge-proxy", pack: "hub", after: "ready" }, { provider: "codex" as const, key: "model_providers.hedge-proxy", value: { base_url: "http://127.0.0.1:8317/v1" }, pack: "hub", after: "ready" }];
    const waiting = { ...plan(hub), checks: [{ id: "ready", run: ["ready"], say: "Not ready.", pack: "hub" }] };

    await apply(plan(), { home, adapters: adapters() });
    await apply(waiting, { home, adapters: adapters(), run: async () => 1 });

    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual(mine);
  });

  test("keeps a proxy key that a pack owns", async () => {
    const home = temp.make("home-");
    const config = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }];

    await apply(plan(config), { home, adapters: adapters() });
    await apply(plan(config), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(read(home, record)).toEqual({ [claude]: [{ path: ["env", "ANTHROPIC_BASE_URL"], value: "http://127.0.0.1:8317", pack: "hub" }] });
  });

  test("merges owned keys into existing settings and removes a key once no pack owns it", async () => {
    const home = temp.make("home-");
    write(home, claude, { theme: "dark", permissions: { allow: ["Bash(ls)"] } });
    write(home, codex, "# my notes\nmodel = \"gpt-5\"\n");
    const owned = plan([
      { provider: "claude", key: "permissions.defaultMode", value: "acceptEdits" },
      { provider: "codex", key: "features.web_search", value: true, pack: "pull-requests" },
    ]);

    await apply(owned, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ theme: "dark", permissions: { allow: ["Bash(ls)"], defaultMode: "acceptEdits" } });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model: "gpt-5", features: { web_search: true } });

    const second = await apply(owned, { home, adapters: adapters() });
    expect(second.actions).toEqual([]);

    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ theme: "dark", permissions: { allow: ["Bash(ls)"] } });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model: "gpt-5" });
    expect(read(home, record)).toEqual({});
  });

  test("keeps a local edit to an owned key until the user adopts Hedge's value", async () => {
    const home = temp.make("home-");
    const owned = plan([{ provider: "claude", key: "permissions.defaultMode", value: "acceptEdits" }]);
    await apply(owned, { home, adapters: adapters() });
    write(home, claude, { permissions: { defaultMode: "plan" } });

    const kept = await apply(owned, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ permissions: { defaultMode: "plan" } });
    expect(kept.findings).toContainEqual({ id: `kept:${claude}`, pack: "engine", say: `Kept your permissions.defaultMode in ${claude}. Run hedge apply --adopt ${claude} to take Hedge's value.` });
    expect((await check(owned, { home, adapters: adapters() })).ok).toBe(false);

    await apply(owned, { home, adopt: [claude], adapters: adapters() });
    expect(read(home, claude)).toEqual({ permissions: { defaultMode: "acceptEdits" } });
  });

  test("keeps a removed key that the user changed", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });
    write(home, claude, { model: "sonnet" });

    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "sonnet" });
    expect(read(home, record)).toEqual({ [claude]: [{ path: ["model"], value: "opus", pack: "base" }] });
  });

  test("removes a key that an earlier Hedge recorded without an owning pack", async () => {
    const home = temp.make("home-");
    write(home, claude, { env: { ENABLE_TOOL_SEARCH: "true", MINE: "1" } });
    write(home, record, { [claude]: [{ path: ["env", "ENABLE_TOOL_SEARCH"], value: "true" }] });

    await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { MINE: "1" } });
  });

  test("previews changes without writing, and check fails until they are applied", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://localhost:8317/" }]), { home, adapters: adapters() });

    const preview = await apply(plan(), { home, dryRun: true, adapters: adapters() });
    expect(preview.findings).toContainEqual({ id: `config:${claude}`, pack: "engine", say: `${claude} needs an update: remove env.ANTHROPIC_BASE_URL.`, repair: "apply" });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317/" } });
    expect((await check(plan(), { home, adapters: adapters() })).ok).toBe(false);

    await apply(plan(), { home, adapters: adapters() });
    expect((await check(plan(), { home, adapters: adapters() })).ok).toBe(true);
  });

  test("writes no Cursor config and leaves t3 entries to the T3 adapter", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "t3", key: "defaultThreadEnvMode", value: "worktree" }]), { home, adapters: adapters() });
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(join(home, ".t3"))).toBe(false);
  });

  test("trusts the Codex hooks a pack owns, and drops the trust with the hook", async () => {
    const home = temp.make("home-");
    const hook = { provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command: "hedge-guard", timeout: 10 }] }] };

    await apply(plan([hook]), { home, adapters: adapters() });

    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: Record<string, unknown> } };
    expect(config.hooks.state).toEqual({ [`${join(home, codex)}:user_prompt_submit:0:0`]: { trusted_hash: "sha256:9ad165f683c4ada17ea667bc5c38348688b4cbe210d860e271db1a625df17728" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(readFileSync(join(home, codex), "utf8").trim()).toBe("");
  });

  test("keeps a Codex hook and its trust while the check it waits for passes, even when its pack's step fails", async () => {
    const home = temp.make("home-");
    const hook = { provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command: "hedge-guard", timeout: 10 }] }], after: "ready" };
    const waiting = { ...plan([hook]), checks: [{ id: "ready", run: ["ready"], say: "Not ready.", pack: "base" }], steps: [{ id: "prepare", run: ["prepare"], check: ["prepared"], pack: "base" }] };
    const trustsEveryHook = () => {
      const { hooks } = parse(readFileSync(join(home, codex), "utf8")) as { hooks: Record<string, unknown> & { state: Record<string, { trusted_hash?: string }> } };
      const handlers = Object.entries(hooks).filter(([event]) => event !== "state").flatMap(([event, groups]) => (groups as Array<{ hooks: Array<Record<string, unknown>> }>).flatMap((group, index) => group.hooks.map((handler, at) => [event, group, handler, index, at] as const)));
      return handlers.length > 0 && handlers.every(([event, group, handler, index, at]) => hooks.state[`${join(home, codex)}:${snakeCase(event)}:${index}:${at}`]?.trusted_hash === trustedHash(event, group, handler));
    };
    await apply(waiting, { home, adapters: adapters(), run: async () => 0 });
    expect(trustsEveryHook()).toBe(true);
    const failed = await apply(waiting, { home, adapters: adapters(), run: async (command) => (command[0] === "ready" ? 0 : 1) });
    expect(failed.findings.map((finding) => finding.id)).toEqual(["step:prepare"]);
    expect(trustsEveryHook()).toBe(true);
  });

  test("leaves a settings file alone when it is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    mkdirSync(join(home, ".claude"));
    symlinkSync(join(dotfiles, "settings.json"), join(home, claude));

    const report = await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });

    expect(lstatSync(join(home, claude)).isSymbolicLink()).toBe(true);
    expect(read(dotfiles, "settings.json")).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(report.findings).toContainEqual({ id: `kept:${claude}`, pack: "engine", say: `Kept ${claude} because it is a link. Hedge would set model there. Make it a plain file in a plain folder to let Hedge change it.` });
  });

  test("leaves a settings file it cannot read as it is", async () => {
    const home = temp.make("home-");
    write(home, claude, "{ not json");

    const report = await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });

    expect(readFileSync(join(home, claude), "utf8")).toBe("{ not json");
    expect(report.findings.find((finding) => finding.id === `kept:${claude}`)?.repair).toBe("human");
  });

  test("leaves a settings file alone when its folder is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    symlinkSync(dotfiles, join(home, ".claude"));

    const report = await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });

    expect(read(dotfiles, "settings.json")).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(report.findings.map((finding) => finding.id)).toContain(`kept:${claude}`);
  });

  test("keeps a provider whose field a pack owns, and the selection that names it", async () => {
    const home = temp.make("home-");
    write(home, codex, 'model_provider = "hub"\n\n[model_providers.hub]\nbase_url = "http://127.0.0.1:8317/v1"\nname = "Hub"\n');
    await apply(plan([{ provider: "codex", key: "model_providers.hub.base_url", value: "http://127.0.0.1:8317/v1", pack: "hub" }]), { home, adapters: adapters() });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model_provider: "hub", model_providers: { hub: { base_url: "http://127.0.0.1:8317/v1", name: "Hub" } } });
  });

  test("keeps a parent when a pack now owns only a field under it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    await apply(plan([{ provider: "claude", key: "env.A", value: "1" }]), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
  });

  test("keeps a proxy URL the user changed after Hedge wrote it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }]), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } });
    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } });
  });

  test("keeps the user's keys when a pack narrows from a parent they edited", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1" } }]), { home, adapters: adapters() });
    write(home, claude, { env: { A: "mine" } });
    const narrowed = plan([{ provider: "claude", key: "env.MY_FLAG", value: "1" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(narrowed, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "mine", MY_FLAG: "1" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "mine" } });
  });

  test("keeps released keys when a pack narrows to a key the user added, then drops it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    write(home, claude, { env: { A: "1", B: "2", C: "user" } });
    const narrowed = plan([{ provider: "claude", key: "env.C", value: "user" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(narrowed, { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
  });

  test("keeps a released Codex table when a pack narrows to a field the user added, then drops it", async () => {
    const home = temp.make("home-");
    const sample = { name: "Sample", wire_api: "responses" };
    await apply(plan([{ provider: "codex", key: "model_providers", value: { sample } }]), { home, adapters: adapters() });
    writeFileSync(join(home, codex), `[model_providers.sample]\nname = "Sample"\nwire_api = "responses"\nenv_key = "KEY"\n`);
    const narrowed = plan([{ provider: "codex", key: "model_providers.sample.env_key", value: "KEY" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(readFileSync(join(home, codex), "utf8")).toContain('[model_providers.sample]\nname = "Sample"\nwire_api = "responses"');
    expect(readFileSync(join(home, codex), "utf8")).not.toContain("env_key");
  });

  test("releases an unedited parent when a pack narrows to a new field, and keeps it when that field leaves", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    await apply(plan([{ provider: "claude", key: "env.C", value: "3" }]), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
  });

  test("keeps a key helper Hedge did not write, though it names a file beside the proxy key", async () => {
    const home = temp.make("home-");
    const mine = { apiKeyHelper: 'my-helper --cache "$HOME/.config/hedge/cli-proxy.key-cache"' };
    write(home, claude, mine);
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual(mine);
  });

  test("removes nothing while a pack source cannot be fetched", async () => {
    const home = temp.make("home-");
    const hub = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }];
    await apply(plan(hub), { home, adapters: adapters() });
    const offline = { ...plan(), packs: [...plan().packs, { name: "hub", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };

    const report = await apply(offline, { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(read(home, record)[claude]).toHaveLength(1);
    expect(report.findings.map((finding) => finding.id)).toContain("config:outage");
  });

  test("while a source is out, removes a setting whose check fails, and keeps a setting the outage hides", async () => {
    const home = temp.make("home-");
    const proxy = { provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" };
    const model = { provider: "claude" as const, key: "model", value: "opus", pack: "team" };
    await apply(plan([proxy, model]), { home, adapters: adapters() });
    const offline = { ...plan(), packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "hub", item: "config claude:env.ANTHROPIC_BASE_URL", reason: "check proxy-ready does not pass", check: "proxy-ready" }] };

    await apply(offline, { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus" });
    expect(read(home, record)[claude]).toEqual([{ path: ["model"], value: "opus", pack: "team" }]);
  });

  test("while a source is out, removes a setting whose check fails though the pack now owns its parent key", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }, { provider: "claude", key: "model", value: "opus", pack: "team" }]), { home, adapters: adapters() });
    const offline = { ...plan(), packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "hub", item: "config claude:env", reason: "check proxy-ready does not pass", check: "proxy-ready" }] };

    await apply(offline, { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus" });
  });

  test("keeps the old hook trust while the user's own hook list is kept", async () => {
    const home = temp.make("home-");
    const hook = (command: string) => ({ provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command }] }] });
    await apply(plan([hook("guard-v1")]), { home, adapters: adapters() });
    const trusted = () => (parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state;
    const first = trusted();
    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: Record<string, unknown> };
    config.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "my-guard" }] }];
    write(home, codex, stringify(config));

    await apply(plan([hook("guard-v2")]), { home, adapters: adapters() });

    expect(trusted()).toEqual(first);
  });

  test("refuses a key that would reach the object prototype", async () => {
    const home = temp.make("home-");
    await expect(apply(plan([{ provider: "claude", key: "__proto__.polluted", value: true }]), { home, adapters: adapters() })).rejects.toThrow("not a usable settings key");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("stops while another Hedge run holds the lock, and writes nothing", async () => {
    const home = temp.make("home-");
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    const held = tryLock(join(home, stateLock))!;
    await expect(apply(plan(), { home, adapters: [claudeCli().adapter] })).rejects.toThrow("Another Hedge operation holds");
    held.release();
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
  });

  test("refuses two owned keys where one holds the other", async () => {
    const home = temp.make("home-");
    const config = [{ provider: "claude" as const, key: "env.B", value: "2" }, { provider: "claude" as const, key: "env", value: { A: "1" }, pack: "other" }];
    await expect(apply(plan(config), { home, adapters: adapters() })).rejects.toThrow("overlap");
    expect(existsSync(join(home, claude))).toBe(false);
  });

  test("writes no backup through a linked backups folder", async () => {
    const home = temp.make("home-");
    const elsewhere = temp.make("elsewhere-");
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "secret" } });
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".local/state/hedge/backups"));
    await expect(apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: [claudeCli().adapter] })).rejects.toThrow("is a link or not a directory");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(read(home, claude).env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
  });

  test("keeps the trust of a hook list the user edited after its pack left", async () => {
    const home = temp.make("home-");
    const hook = { provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command: "guard" }] }] };
    await apply(plan([hook]), { home, adapters: adapters() });
    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: { UserPromptSubmit: unknown[]; state: unknown } };
    const trust = config.hooks.state;
    config.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "mine" }] });
    write(home, codex, stringify(config));

    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });

    expect((parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: unknown } }).hooks.state).toEqual(trust);
  });

  test("names config files as adoptable targets", () => {
    const targets = providerConfigAdapter().targets(plan([{ provider: "claude", key: "a", value: 1 }, { provider: "codex", key: "b", value: 2 }, { provider: "t3", key: "c", value: 3 }]));
    expect(targets).toEqual([claude, codex]);
    expect(providerConfigAdapter().targets(plan([{ provider: "claude", key: "mcpServers.metabase", value: {} }]))).toEqual([claudeJson]);
  });
});

describe("Claude MCP servers", () => {
  const metabase = { type: "stdio", command: "hedge", args: ["posthog-mcp", "metabase"] };
  const server = { provider: "claude" as const, key: "mcpServers.metabase", value: metabase, pack: "posthog" };
  const claudeState = { numStartups: 41, oauthAccount: { emailAddress: "nora@example.com" }, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, projects: { "/work/app": { allowedTools: [] } }, mcpServers: { mine: { type: "http", url: "http://localhost:9000/mcp" } } };
  const serverRecord = ".config/hedge/claude-servers.json";

  /** Behaves like claude mcp add-json and remove at user scope: each call reads ~/.claude.json fresh and writes it whole. */
  function claudeMcp(options: { normalize?: (value: Record<string, unknown>) => unknown; missing?: boolean; beforeEachCall?: (home: string, command: string[]) => void; refuse?: (command: string[]) => boolean } = {}) {
    const calls: string[][] = [];
    const run: CommandRunner = async (command, runOptions) => {
      calls.push(command);
      if (options.missing) return { code: 127, stdout: "" };
      if (command[1] === "mcp") expect(runOptions?.clearEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
      if (options.refuse?.(command)) return { code: 1, stdout: "", stderr: "refused" };
      if (command[1] === "plugin") return { code: 0, stdout: command[2] === "list" ? "[]" : "" };
      const home = runOptions!.home!;
      options.beforeEachCall?.(home, command);
      const path = join(home, claudeJson);
      const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const servers = (state.mcpServers ??= {});
      const name = command[3]!;
      if (command[2] === "add-json") {
        if (servers[name]) return { code: 1, stdout: "", stderr: `MCP server ${name} already exists in user config` };
        const value = JSON.parse(command[4]!);
        servers[name] = options.normalize ? options.normalize(value) : value;
      } else if (command[2] === "remove") {
        if (!servers[name]) return { code: 1, stdout: "", stderr: `No MCP server named "${name}" in user scope` };
        delete servers[name];
      }
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
      return { code: 0, stdout: "" };
    };
    return { calls, run, adapters: [filesAdapter, providerConfigAdapter({ run })], mcp: () => calls.filter((call) => call[1] === "mcp") };
  }

  test("go in and out through claude mcp, so Claude Code writes ~/.claude.json and keeps its own keys and a server the user added", async () => {
    const home = temp.make("home-");
    write(home, claudeJson, claudeState);
    const cli = claudeMcp();

    const added = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([["claude", "mcp", "add-json", "metabase", JSON.stringify(metabase), "--scope", "user"]]);
    expect(read(home, claudeJson)).toEqual({ ...claudeState, mcpServers: { ...claudeState.mcpServers, metabase } });
    expect(added.actions).toContainEqual({ target: claudeJson, operation: "replace", reason: "set mcpServers.metabase" });
    expect(existsSync(join(home, claude))).toBe(false);
    expect(read(home, serverRecord)).toEqual({ servers: [{ name: "metabase", value: metabase, pack: "posthog", stored: metabase }] });

    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);

    const removed = await apply(plan(), { home, adapters: cli.adapters });
    expect(cli.mcp().at(-1)).toEqual(["claude", "mcp", "remove", "metabase", "--scope", "user"]);
    expect(read(home, claudeJson)).toEqual(claudeState);
    expect(removed.actions).toContainEqual({ target: claudeJson, operation: "replace", reason: "remove mcpServers.metabase" });
    expect(read(home, serverRecord)).toEqual({ servers: [] });
  });

  test("lose nothing Claude Code saves while Hedge applies, because Hedge never writes ~/.claude.json itself", async () => {
    const home = temp.make("home-");
    write(home, claudeJson, claudeState);
    const cli = claudeMcp({ beforeEachCall: (dir) => write(dir, claudeJson, { ...read(dir, claudeJson), numStartups: 42 }) });
    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(read(home, claudeJson)).toEqual({ ...claudeState, numStartups: 42, mcpServers: { ...claudeState.mcpServers, metabase } });
  });

  test("claim nothing from a failed add, and keep owning a server whose removal failed", async () => {
    const home = temp.make("home-");
    let refuse = true;
    const failing = claudeMcp({ refuse: (command) => refuse && command[2] === "remove" });
    await apply(plan([{ ...server, value: { type: "stdio", command: "old" } }]), { home, adapters: claudeMcp().adapters });
    const report = await apply(plan([server]), { home, adapters: failing.adapters });
    expect(failing.mcp().map((call) => call[2])).toEqual(["remove"]);
    expect(report.findings.map((finding) => finding.id)).toContain("claude-server:metabase");
    expect(read(home, serverRecord).servers).toEqual([{ name: "metabase", value: { type: "stdio", command: "old" }, pack: "posthog", stored: { type: "stdio", command: "old" } }]);
    refuse = false;
    await apply(plan([server]), { home, adapters: failing.adapters });
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);

    const raced = temp.make("home-");
    const theirs = { type: "stdio", command: "someone-else" };
    const racing = claudeMcp({ beforeEachCall: (dir, command) => void (command[2] === "add-json" && write(dir, claudeJson, { mcpServers: { metabase: theirs } })) });
    await apply(plan([server]), { home: raced, adapters: racing.adapters });
    expect(existsSync(join(raced, serverRecord))).toBe(false);
    const after = await apply(plan(), { home: raced, adapters: claudeMcp().adapters });
    expect(read(raced, claudeJson).mcpServers.metabase).toEqual(theirs);
    expect(after.actions).toEqual([]);
  });

  test("keep a server of the same name that the user wrote, until they adopt Hedge's", async () => {
    const home = temp.make("home-");
    const theirs = { type: "stdio", command: "my-metabase" };
    write(home, claudeJson, { mcpServers: { metabase: theirs } });
    const cli = claudeMcp();

    const report = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([]);
    expect(report.findings).toContainEqual({ id: `kept:${claudeJson}`, pack: "engine", say: `Kept your mcpServers.metabase in ${claudeJson}. Run hedge apply --adopt ${claudeJson} to take Hedge's value.` });

    await apply(plan([server]), { home, adapters: cli.adapters, adopt: [claudeJson] });
    expect(cli.mcp().map((call) => call[2])).toEqual(["remove", "add-json"]);
    expect(read(home, claudeJson)).toEqual({ mcpServers: { metabase } });

    write(home, claudeJson, { mcpServers: { metabase: theirs } });
    const edited = await apply(plan(), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(2);
    expect(read(home, claudeJson)).toEqual({ mcpServers: { metabase: theirs } });
    expect(edited.findings.map((finding) => finding.id)).not.toContain(`kept:${claudeJson}`);
  });

  test("settle on the shape Claude Code stores, and replace the server when the pack changes it", async () => {
    const home = temp.make("home-");
    const cli = claudeMcp({ normalize: (value) => ({ args: [], ...value }) });
    const bare = { ...server, value: { type: "stdio", command: "hedge" } };
    await apply(plan([bare]), { home, adapters: cli.adapters });
    await apply(plan([bare]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);
    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp().slice(1).map((call) => call[2])).toEqual(["remove", "add-json"]);
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);
  });

  test("keep a server name with dots as one key, and leave Claude's plugins to its settings file", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();
    const plugin = { provider: "claude" as const, key: "enabledPlugins.context7@claude-plugins-official", value: true };
    await apply(plan([plugin, { ...server, key: "mcpServers.team.metabase" }]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toContainEqual(["claude", "mcp", "add-json", "team.metabase", JSON.stringify(metabase), "--scope", "user"]);
    expect(read(home, claude)).toEqual({ enabledPlugins: { "context7@claude-plugins-official": true } });
    expect(cli.calls).toContainEqual(["claude", "plugin", "install", "context7@claude-plugins-official", "--scope", "user"]);
  });

  test("wait while Claude Code is missing, report a server it refuses, keep a server through an outage, and change nothing in doctor", async () => {
    const home = temp.make("home-");
    const missing = await apply(plan([server]), { home, adapters: claudeMcp({ missing: true }).adapters });
    expect(missing.findings).toContainEqual({ id: "claude-servers", pack: "engine", say: "Claude Code is not installed yet, so its MCP servers wait: metabase.", repair: "apply" });
    expect(existsSync(join(home, serverRecord))).toBe(false);

    write(home, claudeJson, { mcpServers: {} });
    const refusing: CommandRunner = async (command) => (command[1] === "mcp" ? { code: 1, stdout: "", stderr: "Invalid configuration: : Invalid input" } : { code: 0, stdout: "[]" });
    const refused = await apply(plan([server]), { home, adapters: [filesAdapter, providerConfigAdapter({ run: refusing })] });
    expect(refused.findings).toContainEqual({ id: "claude-server:metabase", pack: "engine", say: "Claude Code did not add the MCP server metabase: Invalid configuration: : Invalid input. Check its value in the posthog pack.", repair: "apply" });

    const cli = claudeMcp();
    await apply(plan([server]), { home, adapters: cli.adapters });
    const report = await check(plan([{ ...server, value: { ...metabase, args: [] } }]), { home, adapters: cli.adapters, run: async () => 0 });
    expect(report.findings).toContainEqual({ id: `config:${claudeJson}`, pack: "engine", say: `${claudeJson} needs an update: set mcpServers.metabase.`, repair: "apply" });
    const outage = plan();
    outage.packs = [{ name: "posthog", source: "posthog", ref: "main", available: false, reason: "not found; unreachable source posthog" }];
    await apply(outage, { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);
  });

  test("while a source is out, remove a server whose check fails", async () => {
    const home = temp.make("home-");
    const cli = claudeMcp();
    await apply(plan([server]), { home, adapters: cli.adapters });
    const outage = { ...plan(), packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "posthog", item: "config claude:mcpServers.metabase", reason: "check gateway-ready does not pass", check: "gateway-ready" }] };

    await apply(outage, { home, adapters: cli.adapters });

    expect(cli.mcp().at(-1)).toEqual(["claude", "mcp", "remove", "metabase", "--scope", "user"]);
    expect(read(home, claudeJson).mcpServers).toEqual({});
  });

  test("leave ~/.claude.json as it is while it is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "claude.json", claudeState);
    symlinkSync(join(dotfiles, "claude.json"), join(home, claudeJson));
    const cli = claudeMcp();
    const report = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([]);
    expect(read(dotfiles, "claude.json")).toEqual(claudeState);
    expect(report.findings.map((finding) => finding.id)).toContain(`kept:${claudeJson}`);
  });
});

describe("Codex plugins", () => {
  const github = "github@openai-curated-remote";
  const wants = (id = github) => ({ provider: "codex" as const, key: `plugins.${id}.enabled`, value: true });
  type Entry = { version: string; enabled: boolean };

  function codexCli(start: Record<string, Entry> = {}, faults: { addFails?: "before" | "after" | "chatgpt"; onAdd?: () => void; listFailsAfterAdd?: boolean; status?: { code: number; stderr: string } } = {}) {
    const installed = new Map(Object.entries(start));
    const calls: string[][] = [];
    const limited: string[][] = [];
    let added = false;
    const run: CommandRunner = async (command, options) => {
      calls.push(command);
      if (options?.signal) limited.push(command);
      const words = command.join(" ");
      if (words === "claude plugin list --json") return { code: 0, stdout: "[]" };
      if (words === "codex plugin list --json") return added && faults.listFailsAfterAdd ? { code: 1, stdout: "", stderr: "Codex app server stopped\n" } : { code: 0, stdout: JSON.stringify({ installed: [...installed].map(([pluginId, entry]) => ({ pluginId, ...entry })) }) };
      if (command[0] === "codex" && command[2] === "add") {
        added = true;
        faults.onAdd?.();
        if (faults.addFails === "before") return { code: 1, stdout: "", stderr: "sign in to ChatGPT first\n" };
        if (faults.addFails === "chatgpt") return { code: 1, stdout: "", stderr: "Error: chatgpt authentication required for remote plugin catalog\n" };
        installed.set(command[3]!, { version: "1.0.0", enabled: true });
        return { code: faults.addFails === "after" ? 1 : 0, stdout: "{}" };
      }
      if (words === "codex login status") return { stdout: "", ...(faults.status ?? { code: 0, stderr: "Logged in using ChatGPT\n" }) };
      if (command[0] === "codex" && command[2] === "remove") installed.delete(command[3]!);
      return { code: 0, stdout: "{}" };
    };
    return { calls, limited, installed, run, adapter: providerConfigAdapter({ run }), changes: () => calls.filter((call) => call[0] === "codex" && call[1] === "plugin" && call[2] !== "list") };
  }

  test("installs an enabled plugin once, records Hedge's ownership, and removes it when no pack enables it", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ plugins: { [github]: { enabled: true } } });
    expect(read(home, pluginRecord)).toEqual({ claude: [], codex: [{ id: github, version: "1.0.0", enabled: true }] });

    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.changes().at(-1)).toEqual(["codex", "plugin", "remove", github, "--json"]);
    expect([...cli.installed.keys()]).toEqual([]);
    expect(read(home, pluginRecord)).toEqual({ claude: [] });
  });

  test("never adopts or removes a plugin the user installed, whether a pack enables it or not", async () => {
    const home = temp.make("home-");
    const cli = codexCli({ [github]: { version: "2.0.0", enabled: true }, "notes@team-market": { version: "1.0.0", enabled: true } });
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.changes()).toEqual([]);
    expect([...cli.installed.keys()].sort()).toEqual([github, "notes@team-market"]);
    expect(existsSync(join(home, pluginRecord))).toBe(false);
  });

  test("records an install as pending before Codex runs it, so an install cut off midway is finished or removed later", async () => {
    const home = temp.make("home-");
    const seen: unknown[] = [];
    const cut = codexCli({}, { onAdd: () => { seen.push(read(home, pluginRecord)); throw new Error("the machine went down"); } });
    await apply(plan([wants()]), { home, adapters: [cut.adapter] }).catch(() => {});
    expect(seen).toEqual([{ claude: [], codex: [{ id: github, version: "", enabled: false, pending: true }] }]);
    expect(read(home, pluginRecord).codex).toEqual([{ id: github, version: "", enabled: false, pending: true }]);

    const finished = codexCli({ [github]: { version: "1.0.0", enabled: true } });
    await apply(plan([wants()]), { home, adapters: [finished.adapter] });
    expect(finished.changes()).toEqual([]);
    expect(read(home, pluginRecord).codex).toEqual([{ id: github, version: "1.0.0", enabled: true }]);

    const other = temp.make("home-");
    await apply(plan([wants()]), { home: other, adapters: [codexCli({}, { onAdd: () => { throw new Error("the machine went down"); } }).adapter] }).catch(() => {});
    const later = codexCli({ [github]: { version: "1.0.0", enabled: false } });
    await apply(plan(), { home: other, adapters: [later.adapter] });
    expect(later.changes()).toEqual([["codex", "plugin", "remove", github, "--json"]]);
  });

  test("owns a plugin that Codex installed even though its command failed, and says the command failed", async () => {
    const home = temp.make("home-");
    const cli = codexCli({}, { addFails: "after" });
    const report = await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(report.findings.map((finding) => finding.say)).toContainEqual(expect.stringContaining(`Could not install the Codex plugin ${github}`));
    expect(read(home, pluginRecord).codex).toEqual([{ id: github, version: "1.0.0", enabled: true }]);
  });

  test("an install that Codex refused leaves no plugin, and a plugin the user installs later stays theirs", async () => {
    const home = temp.make("home-");
    const refused = codexCli({}, { addFails: "before" });
    const report = await apply(plan([wants()]), { home, adapters: [refused.adapter] });
    expect(report.findings.map((finding) => finding.say)).toContainEqual(`Could not install the Codex plugin ${github}: sign in to ChatGPT first. Hedge tries again at the next apply.`);
    const user = codexCli({ [github]: { version: "1.0.0", enabled: false } });
    await apply(plan([]), { home, adapters: [user.adapter] });
    expect(user.changes()).toEqual([]);
    expect([...user.installed.keys()]).toEqual([github]);
  });

  test("leaves the plugins that need Codex's ChatGPT sign-in to the person as one step, in apply and in doctor, until Codex is signed in to ChatGPT", async () => {
    const home = temp.make("home-");
    const convex = "convex@openai-curated-remote";
    const both = plan([wants(), wants(convex)]);
    const waits = { id: "plugins:codex:chatgpt", pack: "engine", say: `Sign Codex in to ChatGPT with codex login. Hedge installs the Codex plugins ${github}, ${convex} at the next hedge apply.`, todo: true as const };
    const signedOut = codexCli({}, { addFails: "chatgpt", status: { code: 1, stderr: "Not logged in\n" } });
    const applied = await apply(both, { home, adapters: [signedOut.adapter] });
    expect(applied.findings.filter((finding) => finding.id.includes("codex"))).toEqual([waits]);
    const doctor = await check(both, { home, adapters: [signedOut.adapter] });
    expect([doctor.findings, doctor.ok]).toEqual([[waits], true]);
    const signedIn = await check(both, { home, adapters: [codexCli().adapter] });
    expect([signedIn.findings.map((finding) => finding.say), signedIn.ok]).toEqual([[`The Codex plugin ${github} needs to be installed.`, `The Codex plugin ${convex} needs to be installed.`], false]);
  });

  test("doctor keeps a missing plugin a Fix when codex login status fails, or Codex is signed in another way, and gives the status a time limit", async () => {
    const needs = { id: `plugin:codex:${github}`, pack: "engine", say: `The Codex plugin ${github} needs to be installed.`, repair: "apply" as const };
    for (const status of [{ code: 124, stderr: "Error: could not read the keyring\n" }, { code: 143, stderr: "Not logged in\n" }, { code: 0, stderr: "Logged in using an API key - sk-***\n" }]) {
      const cli = codexCli({}, { status });
      expect((await check(plan([wants()]), { home: temp.make("home-"), adapters: [cli.adapter] })).findings.filter((finding) => finding.id.startsWith("plugin"))).toEqual([needs]);
      expect(cli.limited).toEqual([["codex", "login", "status"]]);
    }
  });

  test("keeps a plugin id with dots as one key", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants("foo.bar@market")]), { home, adapters: [cli.adapter] });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ plugins: { "foo.bar@market": { enabled: true } } });
    expect(cli.changes()).toEqual([["codex", "plugin", "add", "foo.bar@market", "--json"]]);
  });

  test("keeps owning an install that Codex ran when Codex cannot list its plugins afterwards", async () => {
    const home = temp.make("home-");
    const report = await apply(plan([wants()]), { home, adapters: [codexCli({}, { listFailsAfterAdd: true }).adapter] });
    expect(report.findings.map((finding) => finding.say)).toContainEqual(expect.stringContaining(`Could not install the Codex plugin ${github}`));
    const later = codexCli({ [github]: { version: "1.0.0", enabled: true } });
    await apply(plan(), { home, adapters: [later.adapter] });
    expect(later.changes()).toEqual([["codex", "plugin", "remove", github, "--json"]]);
  });

  test("keeps a plugin whose enabled state changed outside Hedge, says so, and gives it to the user once no pack enables it", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    cli.installed.set(github, { version: "1.0.0", enabled: false });
    const kept = await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(kept.findings.map((finding) => finding.say)).toContainEqual(`Kept the Codex plugin ${github} as you left it: it is disabled now, and Hedge installed it enabled.`);
    const yours = { id: `plugin:codex:${github}`, pack: "engine", say: `Kept the Codex plugin ${github}, which no pack enables any more, because it changed outside Hedge. It is yours now.` };
    writeFileSync(join(home, codex), stringify({ plugins: { [github]: { enabled: false } } }));
    const doctor = await check(plan(), { home, adapters: [cli.adapter] });
    expect(doctor.findings).toEqual([yours]);
    expect(doctor.ok).toBe(true);
    const released = await apply(plan(), { home, adapters: [cli.adapter] });
    expect(released.findings).toContainEqual(yours);
    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(Object.fromEntries(cli.installed)).toEqual({ [github]: { version: "1.0.0", enabled: false } });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ plugins: { [github]: { enabled: false } } });
  });

  test("keeps the plugins Hedge installed while a pack source is out, and removes them once it is back", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    const outage = plan();
    outage.packs = [{ name: "team", source: "team", ref: "main", available: false, reason: "not found; unreachable source team" }];
    await apply(outage, { home, adapters: [cli.adapter] });
    expect([...cli.installed.keys()]).toEqual([github]);
    expect(read(home, pluginRecord).codex).toHaveLength(1);
    await apply(plan(), { home, adapters: [cli.adapter] });
    expect([...cli.installed.keys()]).toEqual([]);
  });

  test("follows a version the marketplace updated without installing again", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    cli.installed.set(github, { version: "1.1.0", enabled: true });
    const report = await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(report.findings.filter((finding) => finding.id.startsWith("plugin"))).toEqual([]);
    expect(cli.changes()).toHaveLength(1);
    expect(read(home, pluginRecord).codex).toEqual([{ id: github, version: "1.1.0", enabled: true }]);
  });

  test("installs nothing when a plugin of the same name from another marketplace is installed", async () => {
    const home = temp.make("home-");
    const cli = codexCli({ "github@team-market": { version: "3.0.0", enabled: true } });
    const report = await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(cli.changes()).toEqual([]);
    expect(report.findings.map((finding) => finding.say)).toContainEqual(`Did not install the Codex plugin ${github}: github@team-market is already installed under the same name. Remove one of them.`);
  });

  test("installs nothing the user turned off in config.toml, and nothing while Codex is missing", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, codex), stringify({ plugins: { [github]: { enabled: false } } }));
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    expect(cli.changes()).toEqual([]);
    const missing = providerConfigAdapter({ run: async (command) => (command[0] === "codex" ? { code: 127, stdout: "" } : { code: 0, stdout: "[]" }) });
    const report = await apply(plan([wants("cloudflare@openai-curated-remote")]), { home: temp.make("home-"), adapters: [missing] });
    expect(report.findings).toContainEqual({ id: "plugins:codex", pack: "engine", say: "Codex is not installed yet, so its plugins wait: cloudflare@openai-curated-remote.", repair: "apply" });
  });

  test("a check reports the install it needs and changes nothing", async () => {
    const home = temp.make("home-");
    const cli = codexCli();
    await apply(plan([wants()]), { home, adapters: [cli.adapter] });
    const report = await check(plan([wants(), wants("posthog@openai-curated-remote")]), { home, adapters: [cli.adapter] });
    expect(report.findings.map((finding) => finding.id)).toContain("plugin:codex:posthog@openai-curated-remote");
    expect(cli.changes()).toHaveLength(1);
    expect(read(home, pluginRecord).codex).toHaveLength(1);
  });

  test("leaves the plugins the earlier Hedge installed alone until a pack enables one again, then owns that one, and never writes the earlier Hedge's record", async () => {
    const home = temp.make("home-");
    const slack = "slack@openai-curated-remote";
    const context7 = "context7@claude-plugins-official";
    write(home, earlierRecord, { version: 1, installed: [
      { provider: "codex", id: github, version: "1.0.0", enabled: true },
      { provider: "codex", id: slack, version: "1.0.0", enabled: true },
      { provider: "claude", id: context7, version: "1.0.0", enabled: true },
    ] });
    const earlier = readFileSync(join(home, earlierRecord));
    const cli = codexCli({ [github]: { version: "1.0.0", enabled: true }, [slack]: { version: "1.0.0", enabled: true } });
    const claudeInstalled = [context7];
    const run: CommandRunner = async (command, options) => {
      if (command[0] !== "claude") return cli.run(command, options);
      cli.calls.push(command);
      return command[2] === "list" ? { code: 0, stdout: JSON.stringify(claudeInstalled.map((id) => ({ id, scope: "user", version: "1.0.0", enabled: true }))) } : { code: 0, stdout: "" };
    };
    const adapter = providerConfigAdapter({ run });
    const changes = () => cli.calls.filter((call) => call[2] !== "list");

    await apply(plan([wants()]), { home, adapters: [adapter] });
    expect(changes()).toEqual([]);
    expect([...cli.installed.keys()].sort()).toEqual([github, slack]);

    await apply(plan(), { home, adapters: [adapter] });
    expect(changes()).toEqual([["codex", "plugin", "remove", github, "--json"]]);
    expect([...cli.installed.keys()]).toEqual([slack]);
    expect(claudeInstalled).toEqual([context7]);
    expect(readFileSync(join(home, earlierRecord)).equals(earlier)).toBe(true);
  });

  test("keeps a Claude plugin the earlier Hedge installed when its enabled state changed outside Hedge", async () => {
    const home = temp.make("home-");
    const context7 = "context7@claude-plugins-official";
    write(home, earlierRecord, { version: 1, installed: [{ provider: "claude", id: context7, version: "1.0.0", enabled: true }] });
    write(home, claude, { enabledPlugins: { [context7]: false } });
    const cli = claudeCli([context7]);
    await apply(plan([{ provider: "claude", key: `enabledPlugins.${context7}`, value: true }]), { home, adapters: [cli.adapter] });
    const report = await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.calls.some((call) => call[2] === "uninstall")).toBe(false);
    expect(report.findings.map((finding) => finding.say)).toContainEqual(`Kept the Claude plugin ${context7}, which no pack enables any more, because it changed outside Hedge. It is yours now.`);
  });

  test("runs Codex outside any CODEX_HOME, so its plugins land in the home Hedge applies to", async () => {
    const home = temp.make("home-");
    const elsewhere = temp.make("codex-home-");
    const bin = temp.make("bin-");
    write(bin, "codex", `#!/bin/sh
dir="\${CODEX_HOME:-$HOME/.codex}/plugins"
case "$2" in
  list) printf '{"installed":['; sep=; for f in "$dir"/*; do [ -e "$f" ] || continue; printf '%s{"pluginId":"%s","version":"1.0.0","enabled":true}' "$sep" "\${f##*/}"; sep=,; done; echo ']}' ;;
  add) mkdir -p "$dir" && : >"$dir/$3" && echo '{}' ;;
  remove) rm -f "$dir/$3" && echo '{}' ;;
  *) exit 2 ;;
esac
`);
    chmodSync(join(bin, "codex"), 0o755);
    const run: CommandRunner = (command, options) => spawnRunner(command[0] === "codex" ? [join(bin, "codex"), ...command.slice(1)] : ["false"], options);
    const before = Bun.env.CODEX_HOME;
    Bun.env.CODEX_HOME = elsewhere;
    try {
      await apply(plan([wants()]), { home, adapters: [providerConfigAdapter({ run })] });
    } finally {
      if (before === undefined) delete Bun.env.CODEX_HOME;
      else Bun.env.CODEX_HOME = before;
    }
    expect(readdirSync(join(home, ".codex/plugins"))).toEqual([github]);
    expect(existsSync(join(elsewhere, "plugins"))).toBe(false);
  });

  test("refuses a plugin record it cannot read, and changes no plugin", async () => {
    const home = temp.make("home-");
    write(home, pluginRecord, { claude: [], codex: [{ id: github, version: 1, enabled: true }] });
    const cli = codexCli({ [github]: { version: "1.0.0", enabled: true } });
    await expect(apply(plan(), { home, adapters: [cli.adapter] })).rejects.toThrow("is not a plugin record");
    expect(cli.changes()).toEqual([]);
  });
});

describe("Claude plugins", () => {
  const enabled = { provider: "claude" as const, key: "enabledPlugins.context7@claude-plugins-official", value: true };

  test("keeps a plugin Hedge installed when the user turned it off, once no pack enables it", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();
    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    write(home, claude, { enabledPlugins: { "context7@claude-plugins-official": false } });
    const report = await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.calls.some((call) => call[2] === "uninstall")).toBe(false);
    expect(report.findings.map((finding) => finding.say)).toContainEqual(expect.stringContaining("It is yours now"));
    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.calls.some((call) => call[2] === "uninstall")).toBe(false);
  });

  test("installs an enabled plugin once, and uninstalls it when no pack enables it", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();

    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls.filter((call) => call[2] === "install")).toEqual([["claude", "plugin", "install", "context7@claude-plugins-official", "--scope", "user"]]);

    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.calls.at(-1)).toEqual(["claude", "plugin", "uninstall", "context7@claude-plugins-official", "--scope", "user", "--keep-data"]);
  });

  test("never uninstalls a plugin the user installed", async () => {
    const home = temp.make("home-");
    const cli = claudeCli(["context7@claude-plugins-official"]);

    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    await apply(plan(), { home, adapters: [cli.adapter] });

    expect(cli.calls.some((call) => call[2] === "install" || call[2] === "uninstall")).toBe(false);
  });

  test("runs Claude Code with the target home", async () => {
    const home = temp.make("home-");
    const homes = new Set<string | undefined>();
    const adapter = providerConfigAdapter({ run: async (_command, options) => (homes.add(options?.home), { code: 0, stdout: "[]" }) });
    await apply(plan([enabled]), { home, adapters: [adapter] });
    expect([...homes]).toEqual([home]);
  });

  test("does not own a plugin whose install failed, so a later user install stays", async () => {
    const home = temp.make("home-");
    const installed: string[] = [];
    const calls: string[][] = [];
    const adapter = providerConfigAdapter({
      run: async (command) => {
        calls.push(command);
        if (command[2] === "list") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user", version: "1", enabled: true }))) };
        return { code: command[2] === "install" ? 1 : 0, stdout: "" };
      },
    });
    await apply(plan([enabled]), { home, adapters: [adapter] });
    installed.push("context7@claude-plugins-official");
    await apply(plan(), { home, adapters: [adapter] });
    expect(calls.some((call) => call[2] === "uninstall")).toBe(false);
  });

  test("keeps a plugin id with dots as one key", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();
    await apply(plan([{ provider: "claude", key: "enabledPlugins.my.tool@team.market", value: true }]), { home, adapters: [cli.adapter] });
    expect(read(home, claude)).toEqual({ enabledPlugins: { "my.tool@team.market": true } });
    expect(cli.calls).toContainEqual(["claude", "plugin", "install", "my.tool@team.market", "--scope", "user"]);
  });

  test("installs nothing the user turned off in their settings", async () => {
    const home = temp.make("home-");
    write(home, claude, { enabledPlugins: { "context7@claude-plugins-official": false } });
    const cli = claudeCli();
    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls.some((call) => call[2] === "install")).toBe(false);
    expect(read(home, claude)).toEqual({ enabledPlugins: { "context7@claude-plugins-official": false } });
  });

  test("installs nothing while the settings file is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", {});
    mkdirSync(join(home, ".claude"));
    symlinkSync(join(dotfiles, "settings.json"), join(home, claude));
    const cli = claudeCli();
    const report = await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toEqual([]);
    expect(report.findings.map((finding) => finding.id)).toContain("plugins:claude");
  });

  test("installs nothing while the settings folder is a link, even when the settings already match", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { enabledPlugins: { [enabled.key.slice("enabledPlugins.".length)]: true } });
    symlinkSync(dotfiles, join(home, ".claude"));
    const cli = claudeCli();
    const report = await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toEqual([]);
    expect(report.findings.map((finding) => finding.id)).toContain("plugins:claude");
  });

  test("reports plugins as pending while Claude Code is not installed", async () => {
    const home = temp.make("home-");
    const adapter = providerConfigAdapter({ run: async () => ({ code: 127, stdout: "" }) });

    const report = await apply(plan([enabled]), { home, adapters: [adapter] });

    expect(report.findings).toContainEqual({ id: "plugins:claude", pack: "engine", say: "Claude Code is not installed yet, so its plugins wait: context7@claude-plugins-official.", repair: "apply" });
  });

  describe("on a fresh machine, where Claude Code has fetched no marketplace", () => {
    const official = { provider: "claude" as const, key: "enabledPlugins.posthog@claude-plugins-official", value: true };
    const team = { provider: "claude" as const, key: "enabledPlugins.tool@team-market", value: true };
    const teamDeclared = { extraKnownMarketplaces: { "team-market": { source: { source: "github", repo: "team/market" } } } };

    function freshClaude(published: Record<string, { name: string; plugins: string[] }>, faults: { update?: string; silentAdd?: boolean } = {}) {
      const fetched = new Map<string, string[]>();
      const installed: string[] = [];
      const run: CommandRunner = async (command) => {
        const [, , verb, ...rest] = command;
        const missing = (name: string) => ({ code: 1, stdout: "", stderr: `✘ Failed to update marketplace(s): Marketplace '${name}' not found.\n` });
        if (verb === "list") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user", version: "1.0.0", enabled: true }))) };
        if (verb === "marketplace" && rest[0] === "list") return { code: 0, stdout: JSON.stringify([...fetched.keys()].map((name) => ({ name, source: "github" }))) };
        if (verb === "marketplace" && rest[0] === "add") {
          const marketplace = published[rest[1]!];
          if (!marketplace && faults.silentAdd) return { code: 1, stdout: "", stderr: "" };
          if (!marketplace) return { code: 1, stdout: "", stderr: `✘ Failed to add marketplace: Failed to clone ${rest[1]} (SSH authentication failed).\n\nOriginal error: denied\n` };
          fetched.set(marketplace.name, [...marketplace.plugins]);
          return { code: 0, stdout: "" };
        }
        if (verb === "marketplace" && rest[0] === "update") {
          const marketplace = Object.values(published).find((item) => item.name === rest[1]);
          if (!marketplace || !fetched.has(marketplace.name)) return missing(rest[1]!);
          if (faults.update) return { code: 1, stdout: "", stderr: `✘ Failed to update marketplace(s): ${faults.update}\n` };
          fetched.set(marketplace.name, [...marketplace.plugins]);
          return { code: 0, stdout: "" };
        }
        if (verb === "install") {
          const [plugin, marketplace] = rest[0]!.split("@") as [string, string];
          if (!fetched.get(marketplace)?.includes(plugin)) return { code: 1, stdout: "", stderr: `✘ Failed to install plugin "${rest[0]}": Plugin "${plugin}" not found in marketplace "${marketplace}".\n` };
          installed.push(rest[0]!);
          return { code: 0, stdout: "" };
        }
        return { code: 0, stdout: "" };
      };
      return { installed, fetched, adapter: providerConfigAdapter({ run }) };
    }

    const officialMarketplace = { "anthropics/claude-plugins-official": { name: "claude-plugins-official", plugins: ["posthog", "slack"] } };

    test("adds Claude Code's official marketplace before it installs a plugin from it", async () => {
      const home = temp.make("home-");
      const cli = freshClaude(officialMarketplace);

      const report = await apply(plan([official]), { home, adapters: [cli.adapter] });

      expect(cli.installed).toEqual(["posthog@claude-plugins-official"]);
      expect(report.findings).toEqual([]);
    });

    test("adds the marketplace that Claude's settings declare before it installs a plugin from it", async () => {
      const home = temp.make("home-");
      write(home, claude, teamDeclared);
      const cli = freshClaude({ "team/market": { name: "team-market", plugins: ["tool"] } });

      const report = await apply(plan([team]), { home, adapters: [cli.adapter] });

      expect(cli.installed).toEqual(["tool@team-market"]);
      expect(report.findings).toEqual([]);
    });

    test("adds a marketplace that a pack declares in the same apply", async () => {
      const home = temp.make("home-");
      const cli = freshClaude({ "team/market": { name: "team-market", plugins: ["tool"] } });
      const declared = { provider: "claude" as const, key: "extraKnownMarketplaces.team-market", value: teamDeclared.extraKnownMarketplaces["team-market"] };

      await apply(plan([declared, team]), { home, adapters: [cli.adapter] });

      expect(cli.installed).toEqual(["tool@team-market"]);
    });

    test("refreshes a marketplace whose local copy predates the plugin", async () => {
      const home = temp.make("home-");
      const published = { "anthropics/claude-plugins-official": { name: "claude-plugins-official", plugins: [] as string[] } };
      const cli = freshClaude(published);
      cli.fetched.set("claude-plugins-official", []);
      published["anthropics/claude-plugins-official"].plugins.push("posthog");

      await apply(plan([official]), { home, adapters: [cli.adapter] });

      expect(cli.installed).toEqual(["posthog@claude-plugins-official"]);
    });

    test("says which marketplace could not be added and which plugins wait for it", async () => {
      const home = temp.make("home-");
      write(home, claude, teamDeclared);
      const cli = freshClaude({});

      const report = await apply(plan([team]), { home, adapters: [cli.adapter] });

      expect(report.findings).toEqual([
        { id: "plugin-marketplace:team-market", pack: "engine", say: "Could not add the Claude plugin marketplace team-market from team/market: Failed to add marketplace: Failed to clone team/market (SSH authentication failed). Its plugins wait: tool@team-market.", repair: "apply" },
      ]);
    });

    test("keeps the credentials in a marketplace address out of its report", async () => {
      const home = temp.make("home-");
      const password = ["pass", "word", "123"].join("-");
      const address = `https://proof:${password}@git.example.test/market.git?token=${password}`;
      write(home, claude, { extraKnownMarketplaces: { "team-market": { source: { source: "url", url: address } } } });
      const cli = freshClaude({});

      const report = await apply(plan([team]), { home, adapters: [cli.adapter] });

      expect(report.findings.map((finding) => finding.say)).toEqual([
        "Could not add the Claude plugin marketplace team-market from https://git.example.test/market.git: Failed to add marketplace: Failed to clone https://git.example.test/market.git (SSH authentication failed). Its plugins wait: tool@team-market.",
      ]);
    });

    test("leaves the official marketplace alone when the settings pin it to a ref", async () => {
      const home = temp.make("home-");
      const pinned = { extraKnownMarketplaces: { "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official", ref: "release" } } } };
      write(home, claude, pinned);
      const cli = freshClaude(officialMarketplace);

      await apply(plan([official]), { home, adapters: [cli.adapter] });

      expect([...cli.fetched.keys()]).toEqual([]);
      expect(read(home, claude).extraKnownMarketplaces).toEqual(pinned.extraKnownMarketplaces);
    });

    test("says why a marketplace could not be updated, and still installs from the copy it has", async () => {
      const home = temp.make("home-");
      const cli = freshClaude(officialMarketplace, { update: "network is unreachable" });
      cli.fetched.set("claude-plugins-official", ["posthog"]);

      const report = await apply(plan([official]), { home, adapters: [cli.adapter] });

      expect(cli.installed).toEqual(["posthog@claude-plugins-official"]);
      expect(report.findings).toEqual([{ id: "plugin-marketplace:claude-plugins-official", pack: "engine", say: "Could not update the Claude plugin marketplace claude-plugins-official: Failed to update marketplace(s): network is unreachable.", repair: "apply" }]);
    });

    test("reports a plugin from an undeclared marketplace whose name an object already has", async () => {
      const home = temp.make("home-");
      const cli = freshClaude({});

      const report = await apply(plan([{ provider: "claude", key: "enabledPlugins.tool@constructor", value: true }]), { home, adapters: [cli.adapter] });

      expect(report.findings.map((finding) => finding.say)).toEqual(["Could not install the Claude plugin tool@constructor."]);
    });

    test("names the exit code when a failed add printed nothing", async () => {
      const home = temp.make("home-");
      write(home, claude, teamDeclared);
      const cli = freshClaude({}, { silentAdd: true });

      const report = await apply(plan([team]), { home, adapters: [cli.adapter] });

      expect(report.findings.map((finding) => finding.say)).toEqual(["Could not add the Claude plugin marketplace team-market from team/market: exit 1. Its plugins wait: tool@team-market."]);
    });

    test("leaves a marketplace pinned to a ref alone, since claude plugin marketplace add cannot pin it", async () => {
      const home = temp.make("home-");
      const pinned = { extraKnownMarketplaces: { "team-market": { source: { source: "github", repo: "team/market", ref: "release" } } } };
      write(home, claude, pinned);
      const cli = freshClaude({ "team/market": { name: "team-market", plugins: ["tool"] } });

      await apply(plan([team]), { home, adapters: [cli.adapter] });

      expect([...cli.fetched.keys()]).toEqual([]);
      expect(read(home, claude).extraKnownMarketplaces).toEqual(pinned.extraKnownMarketplaces);
    });
  });
});
