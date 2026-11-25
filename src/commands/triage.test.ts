import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../cli.ts";
import { redact } from "./triage-redact.ts";
import { spawnRunner, type CommandRunner } from "../adapters/run.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { engineRoot, fakeMachine, hedgeSetup, scripted } from "../setup/testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const spell = (alphabet: string, length: number, start: number) => Array.from({ length }, (_, index) => alphabet[(start + index * 11) % alphabet.length]).join("");
const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mixed = `${letters}23456789`;
const capitals = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const lowers = "abcdefghijkmnopqrstuvwxyz";
const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ234567";

/** Secrets in the shapes real services issue, built at run time so no real-looking secret is in the repository. */
function secrets() {
  return {
    github: ["gh", "p_", spell(mixed, 36, 1)].join(""),
    githubPat: ["github", "_pat_", spell(mixed, 22, 2), "_", spell(mixed, 59, 3)].join(""),
    anthropic: ["sk", "-ant-api03-", spell(mixed, 90, 4)].join(""),
    openai: ["sk", "-proj-", spell(mixed, 48, 5)].join(""),
    slack: ["xo", "xb-", spell("0123456789", 12, 6), "-", spell(mixed, 24, 7)].join(""),
    aws: ["AK", "IA", spell(upper, 16, 8)].join(""),
    jwt: ["ey", "J", spell(mixed, 20, 9), ".", spell(mixed, 30, 10), ".", spell(mixed, 30, 11)].join(""),
    opaque: spell(mixed, 44, 12),
    opaqueLetters: spell(letters, 44, 13),
    cachedLetters: spell(letters, 44, 20),
    splitLetters: [spell(letters, 22, 21), "-", spell(letters, 21, 22)].join(""),
    containedLetters: spell(letters, 32, 23),
    containedSplit: [spell(letters, 16, 24), "-", spell(letters, 16, 25)].join(""),
    unevenSplit: [spell(capitals, 13, 26), spell(lowers, 4, 27), "_", spell(capitals, 3, 28), spell(lowers, 13, 29), "=="].join(""),
    padded: [spell(capitals, 8, 30), spell(lowers, 24, 31), "=="].join(""),
    longPart: [spell(capitals, 97, 32), spell(lowers, 31, 33), "_", spell(letters, 16, 34)].join(""),
    longLowerPart: [spell(lowers, 97, 35), spell(capitals, 31, 36), "_", spell(letters, 16, 37)].join(""),
    password: spell(mixed, 14, 14),
    privateKey: ["-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", spell(mixed, 64, 15).match(/.{16}/g)!.join("\n"), "\n-----END OPENSSH ", "PRIVATE KEY-----"].join(""),
    multiline: [spell(mixed, 10, 16), " river\npearl ", spell(mixed, 10, 17)].join(""),
    email: ["nora.", spell("abcdefgh", 5, 18), "@", "example-corp.io"].join(""),
  };
}

/** Each line of each secret, without the markers around a private key. */
const secretParts = (leaked: ReturnType<typeof secrets>) => Object.values(leaked).flatMap((secret) => secret.split("\n")).filter((line) => !line.startsWith("-----")).map((line) => line.replace(/^(?:pearl | river)/, ""));

type Sent = { command: string[]; input?: string };

function capture(sent: Sent[], gh: { code: number; stdout: string; stderr?: string } = { code: 0, stdout: "https://github.com/PostHog/hedge/issues/999\n" }): CommandRunner {
  const versions: Record<string, string> = { t3: "t3 0.0.42\n", claude: "2.1.300 (Claude Code)\n", codex: "codex-cli 0.170.0\n", gh: "gh version 2.80.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.80.0\n" };
  return async (command, options = {}) => {
    sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
    if (command[0] === "gh" && command[1] === "issue") return gh;
    if (command[0] === "git" && command.includes("user.name")) return { code: 0, stdout: "Nora Quill\n" };
    if (command[0] === "git" && command.includes("describe")) return { code: 0, stdout: "v1.4.0-3-gabc1234\n" };
    if (command[0] === "git" && command.includes("get-url")) return { code: 0, stdout: "https://github.com/nora/team-dotfiles.git\n" };
    const version = versions[command[0]!];
    return version ? { code: 0, stdout: version } : { code: 1, stdout: "", stderr: "not found" };
  };
}

/** A machine whose last setup failed, with secrets and private names in its transcript and errors. */
function failedMachine(home: string, leaked = secrets()) {
  const profileDir = join(home, "profile");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "v1", channel: "release" }, sources: [{ name: "team", repo: "secret-org/team-packs", ref: "main" }], packs: ["pull-requests", "team"], plan: "both", settings: { "memory.repo": "nora/agent-notes" }, workflows: {}, hub: "hub-big-box", devboxes: ["node-west-7"] }));
  mkdirSync(join(home, ".config/hedge"), { recursive: true });
  writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "noras-mbp", profileDir, devboxes: ["node-west-7", "q7"], setup: { done: ["bootstrap", "github", "packs"] } }));
  const state = join(home, ".local/state/hedge/logs");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "setup.log"),
    [
      "=== hedge setup at 2026-11-11T10:00:00.000Z",
      "Hedge setup · 4 of 8 · about 6 min left",
      "▶ Set up this Mac: hedge apply installs your packs",
      `  export GITHUB_TOKEN=${leaked.github}`,
      `  Authorization: Bearer ${leaked.jwt}`,
      `  ANTHROPIC_API_KEY="${leaked.anthropic}"`,
      `  OPENAI_API_KEY: ${leaked.openai}`,
      `  pat ${leaked.githubPat} slack ${leaked.slack} aws ${leaked.aws}`,
      `  opaque ${leaked.opaque} and ${leaked.opaqueLetters} in a log`,
      "  tapped /opt/homebrew/Library/Taps/homebrew/homebrew-core for AbstractSingletonProxyFactoryBean",
      `  cached /opt/homebrew/var/lib/someservice/sessions/cache/storage/tokens/current/${leaked.cachedLetters}`,
      `  refresh ${leaked.splitLetters} and HEDGE_ENGINE_DIR/scripts/build-page-and-site`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.containedLetters}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.containedSplit}`,
      `  refresh ${leaked.unevenSplit} done, then ${leaked.longPart}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.unevenSplit} and ${leaked.padded}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.longLowerPart}`,
      `  cloning https://nora:${leaked.password}@github.com/nora/hedge-profile.git`,
      `  Pairing URL: http://127.0.0.1:3773/pair#token=${leaked.password}`,
      leaked.privateKey,
      `  PASSWORD="${leaked.multiline}"`,
      "  mailto first%2Elast%40mail%2Eexample%2Ecom and git@example.com, cloned git@github.com:acme/tools.git",
      "  read /Users/Taylor Smith/.ssh/config and C:\\Users\\Taylor Smith\\.ssh\\id_ed25519",
      `  author ${leaked.email} at noras-mbp.local, Nora Quill`,
      `  ssh node-west-7.corp.internal (10.20.30.40) hedge doctor`,
      `  {"password":"${leaked.password} horse, battery staple"} and {'client_secret': '${leaked.opaque.slice(0, 12)}'}`,
      `  invited ${leaked.email.replace("@", "%40")} as Nora%20Quill and Nora+Quill, then ssh q7 true (Q7 stays)`,
      `  read C:\\Users\\NoraQ\\.ssh\\id_ed25519 and C:\\Users\\NoraQ\\.gitconfig`,
      "  pushed nora/team-dotfiles and cloned nora/agent-notes",
      "  Created the private repo nora/hedge-profile",
      "  cloned nora/fleet-profile-nora from before the rename",
      `  wrote ${home}/.claude/settings.json and /Users/nora/.zshrc`,
      "  fetched secret-org/team-packs at main",
      "  engine at 0123456789abcdef0123456789abcdef01234567",
      "hedge doctor: Everything matches. engine 0123456789abcdef0123456789abcdef01234567 v1.4.0 at git@github.com:nora/hedge-profile.git",
      "  - Token scopes: 'repo', 'read:org'",
      "hedge: hedge apply could not set up this machine. Fix what it says above, then run hedge setup again.",
    ].join("\n") + "\n",
  );
  writeFileSync(join(state, "setup-failed.json"), JSON.stringify({ at: "2026-11-11T10:03:00.000Z", step: "4 of 8: Set up this Mac", error: `hedge apply could not set up this machine on noras-mbp for ${leaked.email}.` }));
  return leaked;
}

async function triage(home: string, args: string[], replies: string[], sent: Sent[] = [], gh?: Parameters<typeof capture>[1]) {
  const io = scripted(replies);
  const code = await main(["triage", ...args], { home, engineRoot, platform: "darwin", env: {}, print: io.terminal.print, terminal: io.terminal, capture: capture(sent, gh), hostname: () => "noras-mbp.local", run: async () => 0 });
  return { code, output: io.output(), prompts: io.prompts, sent };
}

const savedReports = (home: string) => readdirSync(home).filter((name) => name.startsWith("hedge-triage-"));

describe("hedge triage", () => {
  test("shows what went wrong, the failed step, versions, doctor and the transcript, with every secret and name removed, and saves it on ↵", async () => {
    const home = temp.make("home-");
    const leaked = failedMachine(home);
    const result = await triage(home, [], ["setup hangs at step 4", ""]);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["What went wrong, in a few words? Press ↵ to skip: ", "Press ↵ to save it, or type a number: "]);
    const shown = result.output;
    expect(shown).toContain("# hedge triage: setup hangs at step 4");
    expect(shown).toContain("## What happened\n\nsetup hangs at step 4");
    expect(shown).toContain("- Role: mac");
    expect(shown).toContain("- Steps done: bootstrap, github, packs");
    expect(shown).toContain("- Failed at 2026-11-11T10:03:00.000Z, 4 of 8: Set up this Mac: hedge apply could not set up this machine on <this machine> for <email>.");
    expect(shown).toContain("- Engine: v1.4.0-3-gabc1234");
    expect(shown).toContain("- Profile engine pin: PostHog/hedge@v1 (release)");
    expect(shown).toContain("- Packs: pull-requests, team; plan both");
    expect(shown).toContain("- T3 Code: t3 0.0.42");
    expect(shown).toContain("- Claude Code: 2.1.300 (Claude Code)");
    expect(shown).toContain("- Codex: codex-cli 0.170.0");
    expect(shown).toContain("- gh: gh version 2.80.0 (2026-10-01)");
    expect(shown).toContain(`- Bun: ${Bun.version}`);
    expect(shown).toContain("- OS: not found (darwin ");
    expect(shown).toContain("## hedge doctor\n\n```text\nhedge: ");
    expect(shown).toContain("▶ Set up this Mac: hedge apply installs your packs");
    expect(shown).toContain("export GITHUB_TOKEN=<redacted>");
    expect(shown).toContain("opaque <secret> and <secret> in a log");
    expect(shown).toContain("tapped /opt/homebrew/Library/Taps/homebrew/homebrew-core for AbstractSingletonProxyFactoryBean");
    expect(shown).toContain("refresh <secret> and HEDGE_ENGINE_DIR/scripts/build-page-and-site");
    expect(shown).toContain("https://<credentials>@github.com/<profile repo>.git");
    expect(shown).toContain(`{"password":"<redacted>"} and {'client_secret': '<redacted>'}`);
    expect(shown).toContain("invited <email> as <name> and <name>, then ssh <devbox 2> true (Q7 stays)");
    expect(shown).toContain("read C:\\Users\\<user>\\.ssh\\id_ed25519 and C:\\Users\\<user>\\.gitconfig");
    expect(shown).toContain("pushed <profile repo> and cloned <private repo>");
    expect(shown).toContain("Created the private repo <profile repo>");
    expect(shown).toContain("cloned <profile repo> from before the rename");
    expect(shown).toContain("hedge doctor: Everything matches. engine 0123456789abcdef0123456789abcdef01234567 v1.4.0 at git@github.com:<profile repo>.git");
    expect(shown).toContain("ssh <devbox 1>.<host> (<ip>) hedge doctor");
    expect(shown).toContain("wrote ~/.claude/settings.json and /Users/<user>/.zshrc");
    expect(shown).toContain("<private key>\n  PASSWORD=\"<redacted>\"\n");
    expect(shown).toContain("mailto <email> and <email>, cloned git@github.com:acme/tools.git");
    expect(shown).toContain("read /Users/<user>/.ssh/config and C:\\Users\\<user>\\.ssh\\id_ed25519");
    expect(shown).toContain("fetched <team source> at main");
    expect(shown).toContain("at <this machine>, <name>");
    expect(shown).toContain("engine at 0123456789abcdef0123456789abcdef01234567");
    expect(shown).toContain("- Token scopes: 'repo', 'read:org'");
    expect(shown).toContain("Hedge removed tokens, keys, email addresses, hostnames and home paths from this report.");
    const report = shown.slice(0, shown.indexOf("Send this report"));
    for (const part of secretParts(leaked)) expect(report).not.toContain(part);
    for (const name of ["noras-mbp", "node-west-7", "hub-big-box", "10.20.30.40", "secret-org", "Nora Quill", "Nora%20Quill", "NoraQ", "horse", "Taylor", "Smith", "first", "mail%2E", "example.com", "team-dotfiles", "agent-notes", leaked.opaque.slice(0, 12), home]) expect(report).not.toContain(name);

    const [file] = savedReports(home);
    expect(shown).toContain(`✓ Saved the report to ${join(home, file!)}.`);
    const saved = readFileSync(join(home, file!), "utf8");
    expect(saved).toStartWith("# hedge triage: setup hangs at step 4\n\n## What happened");
    for (const part of secretParts(leaked)) expect(saved).not.toContain(part);
    expect(saved).not.toContain(home);
    expect(result.sent.some((call) => call.command[1] === "issue")).toBe(false);
  });

  test("with 1, opens a public issue on the engine repo, with the shown report on gh's standard input", async () => {
    const home = temp.make("home-");
    const leaked = failedMachine(home);
    const result = await triage(home, [], ["", "1"]);
    expect(result.code).toBe(0);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.command).toEqual(["gh", "issue", "create", "--repo", "PostHog/hedge", "--title", "hedge triage: setup failed: hedge apply could not set up this machine on <this machine> for <email>.", "--body-file", "-"]);
    expect(issue.input).toStartWith("## What happened\n\nNot described.\n\n## Setup");
    expect(result.output).toContain(issue.input!.split("\n").slice(0, 12).join("\n"));
    for (const part of secretParts(leaked)) expect(issue.input).not.toContain(part);
    expect(result.output).toEndWith("✓ Opened https://github.com/PostHog/hedge/issues/999");
    expect(savedReports(home)).toEqual([]);
  });

  test("names what setup saved before a profile exists: the machine name, draft sources, and the repos it created", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "ssh-silver-fox", setup: { done: ["bootstrap", "github"], draft: { sources: [{ name: "acme", repo: "acme/private-packs", ref: "main" }], settings: { "orchestration.ledgerRepo": "acme/loop-ledger" } } } }));
    mkdirSync(join(home, ".local/state/hedge/logs"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/logs/setup.log"), "  on ssh-silver-fox: fetched acme/private-packs, ledger acme/loop-ledger\n  ✓ Created the private repo acme/hedge-memory\n  Hedge creates the private repos acme/one and acme/two in your account\n");
    writeFileSync(join(home, ".local/state/hedge/logs/setup-failed.json"), JSON.stringify({ at: "2026-11-11T10:03:00.000Z", error: "could not push acme/private-packs from ssh-silver-fox" }));
    const result = await triage(home, ["--send"], []);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.command[6]).toBe("hedge triage: setup failed: could not push <acme source> from <this machine>");
    expect(issue.input).toContain("  on <this machine>: fetched <acme source>, ledger <private repo>\n  ✓ Created the private repo <memory repo>\n  Hedge creates the private repos <private repo> in your account\n");
    for (const name of ["silver-fox", "private-packs", "loop-ledger", "acme/"]) expect(`${issue.command[6]}\n${issue.input}`).not.toContain(name);
  });

  async function triageWithRealGit(home: string, args: string[]) {
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", ...args], { home, engineRoot, platform: "darwin", env: {}, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
    return { code, output: io.output(), sent };
  }

  test("redacts a private source alias and branch name from doctor's pinning advisory, even on a public repo or incomplete draft", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "ssh-silver-fox", setup: { done: ["bootstrap"], draft: { sources: [{ name: "secret-team", repo: "PostHog/hedge", ref: "internal-release" }, { name: "incomplete-team", repo: "acme/private-packs" }] } } }));
    mkdirSync(join(home, ".local/state/hedge/logs"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/logs/setup.log"), "Note: The pack source secret-team is not pinned to a commit SHA. branch internal-release\nNote: The pack source incomplete-team is not pinned to a commit SHA.\n");
    const result = await triageWithRealGit(home, ["--send"]);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.input).toContain("Note: The pack source <private source> is not pinned to a commit SHA. branch <branch>");
    for (const leaked of ["secret-team", "incomplete-team", "internal-release", "private-packs"]) expect(issue.input).not.toContain(leaked);
  });

  test("still redacts secrets, query credentials, credential-bearing source URLs, bracketed branches, key-like aliases, hostname branches, unpaired surrogates, and user paths", async () => {
    const home = temp.make("home-");
    const keyLikeAlias = ["sk", "-live-", spell(lowers, 16, 5)].join("");
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(
      join(home, ".config/hedge/machine.json"),
      JSON.stringify({
        schema: 1,
        role: "mac",
        name: "ssh-silver-fox",
        setup: {
          done: ["bootstrap"],
          draft: {
            sources: [
              { name: "team-a", repo: "PostHog/hedge", ref: "password" },
              { name: "team-b", repo: "PostHog/hedge", ref: "auth" },
              { name: "team-c", repo: "PostHog/hedge", ref: "users" },
              { name: "team-d", repo: "https://nora:topsecret@git.example.com/secret-owner/secret-repo.git", ref: "internal-release" },
              { name: "team-e", repo: "PostHog/hedge", ref: "bad\uD800ref" },
              { name: keyLikeAlias, repo: "acme/key-alias-packs", ref: "feature/customer.internal/private-project" },
              { name: "team-f", repo: "PostHog/hedge", ref: "feature/noras-mbp/embargoed-release" },
              { name: "team-g", repo: "PostHog/hedge", ref: "noras-mbp/top-secret" },
              { name: "team-h", repo: "PostHog/hedge", ref: "refs/heads/q" },
              { name: "team-i", repo: "PostHog/hedge", ref: "home/demo/private-release" },
              { name: "team-j", repo: "PostHog/hedge", ref: `${home.replace(/^\//, "")}/secret-home-branch` },
              { name: "team-k", repo: "/work/private project.git", ref: "main" },
              { name: "team-l", repo: "/work/repo", ref: "main" },
              { name: "noras-mbp", repo: "acme/host-alias-packs", ref: "main" },
              { name: "bad-numeric", repo: 12345, ref: "main" },
              { name: "team-m", repo: "session", ref: "main" },
              { name: "team-n", repo: "acme/team/secret:nested", ref: "main" },
              { name: "team-o", repo: "file:///work/private project.git", ref: "+feature/private-rollout" },
              { name: "team-p", repo: "PostHog/hedge", ref: "work/Users/home/team/private-release" },
            ],
          },
        },
      }),
    );
    mkdirSync(join(home, ".local/state/hedge/logs"), { recursive: true });
    writeFileSync(
      join(home, ".local/state/hedge/logs/setup.log"),
      [
        "PASSWORD=correct-horse-battery-staple",
        "SESSION=live-session-secret-value",
        "GET https://example.com/cb?auth=super-secret-value",
        "read /Users/alice/.ssh/config",
        "fetch https://nora:topsecret@git.example.com/secret-owner/secret-repo.git <internal-release>",
        "fetch acme/key-alias-packs at feature/customer.internal/private-project",
        "checkout feature/noras-mbp/embargoed-release and noras-mbp/top-secret",
        "quick remote ref q at refs/heads/q",
        "browse https://github.com/org/repo/tree/home/demo/private-release",
        `browse https://github.com/org/repo/tree${home}/secret-home-branch`,
        "TOKEN=/work/private project.git",
        "TOKEN=file:///work/private project.git",
        "TOKEN=prefix/work/repo/super-secret-suffix",
        "GET https://example.com/cb?token=prefix/work/repo/query-secret-suffix",
        "fetched acme/host-alias-packs from mirror",
        "unlabeled AbCdEfGhIj1234+/work/repo/KlMnOpQrSt5678 end",
        "Created the private repo acme/team/secret:nested",
        "feature/private-rollout moved, and work/users/home/team/private-release moved",
      ].join("\n") + "\n",
    );
    const result = await triageWithRealGit(home, ["--send"]);
    expect(result.code).toBe(0);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.input).toContain("<branch>=<redacted>");
    expect(issue.input).toContain("<team-m source>=<redacted>");
    expect(issue.input).toContain("https://example.com/cb?<branch>=<redacted>");
    expect(issue.input).toContain("read /<branch>/<user>/.ssh/config");
    expect(issue.input).toContain("fetch <team-d source> <<branch>>");
    expect(issue.input).toContain("fetch <<key> source> at <branch>");
    expect(issue.input).toContain("checkout <branch> and <branch>");
    expect(issue.input).toContain("quick remote ref <branch> at <branch>");
    expect(issue.input).toContain("browse https://github.com/org/repo/tree/<branch>");
    expect(issue.input).toContain("browse https://github.com/org/repo/tree<branch>");
    expect(issue.input).toContain("TOKEN=<redacted>\nTOKEN=<redacted>");
    expect(issue.input).toContain("https://example.com/cb?token=<redacted>");
    expect(issue.input).toContain("fetched <<this machine> source> from mirror");
    expect(issue.input).toContain("unlabeled <secret> end");
    expect(issue.input).toContain("Created the private repo <team-n source>");
    expect(issue.input).toContain("<branch> moved, and <branch> moved");
    for (const leaked of ["correct-horse-battery-staple", "live-session-secret-value", "super-secret-value", "alice", "topsecret", "secret-owner", "secret-repo", "internal-release", keyLikeAlias, "private-project", "customer.internal", "embargoed-release", "top-secret", "private-release", "secret-home-branch", "project.git", "/work/private", "super-secret-suffix", "query-secret-suffix", "noras-mbp", "AbCdEfGhIj1234", "KlMnOpQrSt5678", "secret:nested", "private-rollout"]) expect(issue.input).not.toContain(leaked);

    const urlRepo = "https://example.invalid/private-org/team-packs";
    const withAtSuffix = redact(`failed cloning ${urlRepo}@release.stable and mailto alice@example.com`, home, [
      { text: urlRepo, as: "<team source>" },
      { text: "alice", as: "<branch>", after: true },
    ]);
    expect(withAtSuffix).not.toContain("private-org");
    expect(withAtSuffix).not.toContain("team-packs");
    expect(withAtSuffix).not.toContain("example.com");
    expect(withAtSuffix).toContain("<team source>");
    expect(withAtSuffix).toContain("mailto <email>");

    const repeatedHostRef = "A.INTERNAL/".repeat(300);
    const repeatedLog = "a.internal/".repeat(20_000);
    const started = performance.now();
    const repeatedOut = redact(repeatedLog, home, [{ text: repeatedHostRef, as: "<branch>", after: true }]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(repeatedOut).toContain("<branch>");
    expect(repeatedOut).not.toContain("a.internal/".repeat(300));
  });

  test("redacts unpinned source aliases and repos from an inherited HEDGE_PROFILE_DIR without disclosing its alias or engine fork", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-profile-");
    await spawnGit(inherited, "init", "-q");
    await spawnGit(inherited, "remote", "add", "origin", "https://github.com/nora/inherited-profile.git");
    writeFileSync(join(inherited, "hedge.json"), JSON.stringify({ schema: 1, engine: { repo: "private-org/private-engine", ref: "secret-track", channel: "track" }, sources: [{ name: "inherited-secret", repo: "private-org/inherited-packs", ref: "main" }], packs: [], plan: "both", settings: {}, workflows: {} }));
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", "--send", "--note", "failed fetching private-org/inherited-packs"], { home, engineRoot, platform: "darwin", env: { HEDGE_PROFILE_DIR: inherited }, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
    expect(code).toBe(0);
    const issue = sent.find((call) => call.command[1] === "issue")!;
    expect(issue.input).toContain("failed fetching <private source>");
    expect(issue.input).toContain("The pack source <private source> is not pinned to a commit SHA.");
    expect(issue.input).toContain("- Profile engine pin: no profile");
    for (const leaked of ["inherited-secret", "private-org/inherited-packs", "private-org/private-engine", "secret-track", "nora/inherited-profile"]) expect(issue.input).not.toContain(leaked);
  });

  test("redacts private source aliases added to the saved profile between triage's initial read and doctor's read", async () => {
    const home = temp.make("home-");
    const profileDir = join(home, "profile");
    mkdirSync(profileDir, { recursive: true });
    await spawnGit(profileDir, "init", "-q");
    const profilePath = join(profileDir, "hedge.json");
    const nextProfilePath = join(profileDir, "hedge.next.json");
    const baseProfile = { schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [], packs: [], plan: "both", settings: {}, workflows: {} };
    const nextProfile = { ...baseProfile, sources: [{ name: "race-secret", repo: "PostHog/hedge", ref: "main" }] };
    expect(Bun.spawnSync(["mkfifo", profilePath]).exitCode).toBe(0);
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "noras-mbp", profileDir }));
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const swapProfile = (async () => {
      const fh = await open(profilePath, "w");
      try {
        await fh.writeFile(JSON.stringify(baseProfile));
        writeFileSync(nextProfilePath, JSON.stringify(nextProfile));
        renameSync(nextProfilePath, profilePath);
      } finally {
        await fh.close();
      }
    })();
    const [code] = await Promise.all([
      main(["triage", "--send"], { home, engineRoot, platform: "darwin", env: {}, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 }),
      swapProfile,
    ]);
    expect(code).toBe(0);
    const issue = sent.find((call) => call.command[1] === "issue")!;
    expect(issue.input).toContain("The pack source <private source> is not pinned to a commit SHA.");
    expect(issue.input).not.toContain("race-secret");
  });

  test("home-path redaction does not collide with internal redactor placeholders", () => {
    expect(redact("Saved /home/guest.0.0.~", "/home/guest", [{ text: "acme/secret", as: "<private repo>" }])).toBe("Saved ~.0.0.~");
    expect(redact("acme/secret at /home/guest.0.0.~", "/home/guest", [{ text: "acme/secret", as: "<private repo>" }])).toBe("<private repo> at ~.0.0.~");
  });

  test("nested replacement labels, partial IP/key masks, overlapping labels, and literal plus branches redact accurately", () => {
    const known = Array.from({ length: 200 }, (_, i) => ({ text: `private-org/repo-${i}`, as: `<<devbox ${i + 1}> source>`, after: true }));
    const line = "status ok for private-org/repo-0 while checking <<devbox 1> source> on host\n";
    const big = line.repeat(2_000);
    const out = redact(big, "/home/guest", known);
    expect(out).not.toContain("private-org/repo-0");
    expect(out).toContain("<<devbox 1> source>");

    const ipPath = "file:///mnt/10.20.30.40/Users/team/private-packs";
    const ipRedacted = redact("failed cloning file:///mnt/10.20.30.40/users/team/private-packs", "/home/guest", [{ text: ipPath, as: "<team source>" }]);
    expect(ipRedacted).toBe("failed cloning <team source>");

    const fakeKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
    const keyIpRef = `r/${fakeKey}/1.2.3.4/private`;
    const keyIpRedacted = redact(`failed fetching r/${fakeKey.toLowerCase()}/1.2.3.4/private`, "/home/guest", [{ text: keyIpRef, as: "<branch>", after: true }]);
    expect(keyIpRedacted).toBe("failed fetching <branch>");

    const overlapRedacted = redact("saw <name>/acme/secret-repo here", "/home/guest", [
      { text: "Nora Quill", as: "<name>" },
      { text: "name>/acme/secret-repo", as: "<private repo>", after: true },
    ]);
    expect(overlapRedacted).not.toContain("acme/secret-repo");
    expect(overlapRedacted).toContain("<private repo>");

    const splitByExempt = redact("fetch foo <token> confidential", "/home/guest", [
      { text: "foo <token", as: "<private source>", after: true },
      { text: "token> confidential", as: "<private source>", after: true },
    ]);
    expect(splitByExempt).toBe("fetch <private source>");

    const hostSources = Array.from({ length: 120 }, (_, i) => ({
      text: `https://APP${i}.INTERNAL/a/B.INTERNAL/c/D.INTERNAL/e/F.INTERNAL/g/H.INTERNAL/repo`,
      as: "<private source>",
      after: true,
    }));
    const nonMatchingLine = "GET https://OTHER.INTERNAL/a/B.INTERNAL/c/D.INTERNAL/e/F.INTERNAL/g/H.INTERNAL/repo\n";
    const matchingLine = "GET https://app42.internal/a/B.INTERNAL/c/D.INTERNAL/e/F.INTERNAL/g/H.INTERNAL/repo\n";
    const canonOut = redact(nonMatchingLine.repeat(200) + matchingLine, "/home/guest", hostSources);
    expect(canonOut).toContain("GET <private source>");
    expect(canonOut).not.toContain("app42.internal");
  });

  test("a qualified literal plus-prefixed branch ref does not redact the unrelated word release", async () => {
    const home = temp.make("home-plus-release-");
    const profileDir = join(home, "profile");
    mkdirSync(profileDir, { recursive: true });
    await spawnGit(profileDir, "init", "-q");
    writeFileSync(
      join(profileDir, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "release" },
        sources: [{ name: "team", repo: "PostHog/hedge", ref: "refs/heads/+release" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "noras-mbp", profileDir }));
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", "--send", "--note", "hit issue on refs/heads/+release"], { home, engineRoot, platform: "darwin", env: {}, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
    expect(code).toBe(0);
    const issue = sent.find((call) => call.command[1] === "issue")!;
    expect(issue.input).toContain("- Profile engine pin: PostHog/hedge@main (release)");
    expect(issue.input).not.toContain("+release");
  });

  test("a long title is cut after redaction, so no part of a secret reaches the issue", async () => {
    const home = temp.make("home-");
    const { email } = failedMachine(home);
    const result = await triage(home, ["--send", "--note", `${"y".repeat(90)} ${email} could not sign in`], []);
    const title = result.sent.find((call) => call.command[1] === "issue")!.command[6]!;
    expect(title).toStartWith(`hedge triage: ${"y".repeat(90)} <email> could …`);
    expect(title).not.toContain(email.split("@")[0]!);
  });

  test("when gh cannot open the issue, saves the report and names the page to paste it into", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const result = await triage(home, ["--send"], [], [], { code: 4, stdout: "", stderr: `To get started with GitHub CLI, please run:  gh auth login\nnot logged in at ${home} on noras-mbp as Nora Quill for secret-org/team-packs\n` });
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.output).toContain("Could not open the issue: not logged in at ~ on <this machine> as <name> for <team source>");
    const [file] = savedReports(home);
    expect(result.output).toEndWith(`Saved the report to ${join(home, file!)}. Open https://github.com/PostHog/hedge/issues/new and paste it there.`);
  });

  test("3 sends and saves nothing, --print only shows, and Ctrl-C stops without sending", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const neither = await triage(home, [], ["", "7", "3"]);
    expect(neither).toMatchObject({ code: 0 });
    expect(neither.output).toEndWith("Nothing was sent or saved.");
    const printed = await triage(home, ["--print", "--note", "agent asked"], []);
    expect(printed.code).toBe(0);
    expect(printed.prompts).toEqual([]);
    expect(printed.output).toContain("# hedge triage: agent asked");
    const stopped = await triage(home, [], [""]);
    expect(stopped.code).toBe(130);
    expect(stopped.output).toEndWith("Stopped. Nothing was sent.");
    expect(savedReports(home)).toEqual([]);
    expect([...neither.sent, ...printed.sent, ...stopped.sent].some((call) => call.command[1] === "issue")).toBe(false);
  });

  test("--save writes the report to the named file, and two modes at once are refused", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const path = join(home, "report.md");
    expect((await triage(home, ["--save", path], [])).code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("## Setup transcript");
    const both = await triage(home, ["--print", "--send"], []);
    expect(both.code).toBe(2);
    expect(both.output).toBe("hedge triage: pick one of --print, --save and --send");
  });

  test("on a machine without setup, says what it lacks instead of failing", async () => {
    const home = temp.make("home-");
    const result = await triage(home, ["--print"], []);
    expect(result.code).toBe(0);
    expect(result.output).toContain("- No machine file: hedge setup has not saved progress on this machine.");
    expect(result.output).toContain("- No failed setup run is recorded.");
    expect(result.output).toContain("- No setup timings recorded.");
    expect(result.output).toContain("- Profile engine pin: no profile");
    expect(result.output).toContain("hedge: no profile on this machine.");
    expect(result.output).toContain("No setup transcript on this machine.");
  });

  test("shows the setup timings and t_usable when setup wrote them", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const steps = [
      { id: "github", title: "Sign in to GitHub", start: "2026-11-11T10:00:05.000Z", end: "2026-11-11T10:01:10.000Z", blocked: true, outcome: "done" },
      { id: "apply", title: "Set up | this Mac", start: "2026-11-11T10:01:10.000Z", end: "2026-11-11T10:03:00.000Z", blocked: false, outcome: "failed", error: "exit 1" },
      { id: "check", start: "2026-11-11T10:03:00.000Z" },
    ];
    writeFileSync(join(home, ".local/state/hedge/logs/setup-timings.json"), JSON.stringify({ schema: 1, started: "2026-11-11T10:00:00.000Z", usable: "2026-11-11T10:04:12.000Z", steps }));
    const result = await triage(home, ["--print"], []);
    expect(result.output).toContain(["- t_usable: 4m 12s", "", "| Step | Took | Waited on you | Result |", "| --- | --- | --- | --- |", "| Sign in to GitHub | 1m 5s | yes | done |", "| Set up \\| this Mac | 1m 50s | no | failed: exit 1 |", "| check | still running | no |  |"].join("\n"));
  });

  test("before setup reaches t_usable, shows the steps it timed and no t_usable", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const github = { id: "github", title: "Sign in to GitHub", kind: "human", start: "2026-11-11T10:00:05.000Z", end: "2026-11-11T10:00:47.000Z", seconds: 42, blocked: true, outcome: "done" };
    writeFileSync(join(home, ".local/state/hedge/logs/setup-timings.json"), JSON.stringify({ schema: 1, started: "2026-11-11T10:00:00.000Z", usable: null, usableSeconds: null, blockedSteps: 1, steps: [github] }));
    const result = await triage(home, ["--print"], []);
    expect(result.output).toContain("- Failed at 2026-11-11T10:03:00.000Z, 4 of 8: Set up this Mac: hedge apply could not set up this machine on <this machine> for <email>.\n\n| Step | Took | Waited on you | Result |");
    expect(result.output).toContain("| Sign in to GitHub | 42s | yes | done |");
    expect(result.output).not.toContain("t_usable");
  });

  test("keeps a long transcript under GitHub's issue size by cutting its oldest lines", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const state = join(home, ".local/state/hedge/logs");
    writeFileSync(join(state, "setup.log"), Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(200)}`).join("\n"));
    const result = await triage(home, ["--send"], []);
    const body = result.sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toMatch(/## Setup transcript \(newest \d+ lines\)\n\n```text\nline \d+ x/);
    expect(body).toContain("line 399 ");
    expect(body).not.toContain("line 0 ");
    expect(body).toEndWith("Made by `hedge triage`.");
  });

  test("a huge dotted transcript line still gives a report that fits", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    writeFileSync(join(home, ".local/state/hedge/logs/setup.log"), `${"a.".repeat(1_048_576)}\nthe newest line\n`);
    const result = await triage(home, ["--send"], []);
    const body = result.sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("## Setup transcript (newest 1 lines)\n\n```text\nthe newest line\n```\n\nMade by `hedge triage`.");
    expect(body).toContain("## hedge doctor");
  }, 2_000);

  test("oversized tilde and token-like transcript lines still redact secrets on following lines cleanly", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const token = ["K9mP2xQ7", "vL4nR8wT", "1zB6yC3f", "H5jD0sA2"].join("");
    writeFileSync(
      join(home, ".local/state/hedge/logs/setup.log"),
      `${"~".repeat(1_000_000)}\n${"AbCd1234".repeat(200_000)}\nsecret ${token} on noras-mbp\n`,
    );
    const result = await triage(home, ["--send"], []);
    expect(result.code).toBe(0);
    const body = result.sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("## Setup transcript (newest 2 lines)\n\n```text\n<secret>\nsecret <secret> on <this machine>\n```\n\nMade by `hedge triage`.");
    expect(body).not.toContain(token);
    expect(body).not.toContain("noras-mbp");
  });

  test("keeps unpinned-source doctor advisories readable when a private source alias contains digits", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-profile-");
    await spawnGit(inherited, "init", "-q");
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [{ name: "product-team-release-12345", repo: "acme/private-packs", ref: "main" }], packs: [], plan: "both", settings: {}, workflows: {} }),
    );
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", "--send"], { home, engineRoot, platform: "darwin", env: { HEDGE_PROFILE_DIR: inherited }, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
    expect(code).toBe(0);
    const body = sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body).toContain("Note: The pack source <private source> is not pinned to a commit SHA.");
    expect(body).not.toContain("product-team-release-12345");
    expect(body).not.toContain("Note: <secret>");
  });

  test("redacts a random token containing a plus-encoded known path with spaces", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-profile-");
    await spawnGit(inherited, "init", "-q");
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [{ name: "team", repo: "/work repo", ref: "main" }], packs: [], plan: "both", settings: {}, workflows: {} }),
    );
    const left = "AbCdEfGhIj1234";
    const right = "KlMnOpQrSt5678";
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", "--send", "--note", `tok ${left}+/work+repo/${right} end`], { home, engineRoot, platform: "darwin", env: { HEDGE_PROFILE_DIR: inherited }, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
    expect(code).toBe(0);
    const body = sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body).toContain("tok <secret> end");
    expect(body).not.toContain(left);
    expect(body).not.toContain(right);
    expect(body).not.toContain("/work+repo");
  });

  test("redacts a longer overlapping private source repo even when an earlier shorter user name overlaps its prefix", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-profile-");
    await spawnGit(inherited, "init", "-q");
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({ schema: 1, engine: { repo: "PostHog/hedge", ref: "main", channel: "track" }, sources: [{ name: "team", repo: "Person/confidential-releases", ref: "main" }], packs: [], plan: "both", settings: {}, workflows: {} }),
    );
    const gitConfig = join(home, "gitconfig");
    writeFileSync(gitConfig, "[user]\n\tname = Demo Person\n");
    const prevGitConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    try {
      const code = await main(["triage", "--send", "--note", "Checked out Demo Person/confidential-releases"], { home, engineRoot, platform: "darwin", env: { HEDGE_PROFILE_DIR: inherited }, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 });
      expect(code).toBe(0);
    } finally {
      if (prevGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGitConfig;
    }
    const body = sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body).toContain("Checked out <private source>");
    expect(body).not.toContain("Demo");
    expect(body).not.toContain("confidential-releases");
  });

  test("still redacts secret values when a private source alias ends with a credential keyword and redacts Unicode case-folded private paths", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-profile-");
    await spawnGit(inherited, "init", "-q");
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [
          { name: "token", repo: "/tmp/ΚΟΣΜΟΣ.git", ref: "main" },
          { name: "sigma", repo: "/tmp/ΣΙΓΜΑ.git", ref: "main" },
          { name: "query-prefix", repo: "https://example.invalid/team/packs?auth=", ref: "main" },
          { name: "query-key", repo: "https://example.invalid/team/packs?key=seed", ref: "main" },
          { name: "ssh-source", repo: "git@git.example.com:acme/private-packs", ref: "main" },
        ],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(
      [
        "triage",
        "--send",
        "--note",
        `The pack source token=example-value from /tmp/κοσμος.git and /tmp/ςιγμα.git https://example.invalid/team/packs?key=seed.synthetic-key-val https://example.invalid/team/packs?auth=synthetic-auth-val ${encodeURIComponent("git@git.example.com:acme/private-packs")}`,
      ],
      { home, engineRoot, platform: "darwin", env: { HEDGE_PROFILE_DIR: inherited }, print: io.terminal.print, terminal: io.terminal, capture: runRealGit, hostname: () => "noras-mbp.local", run: async () => 0 },
    );
    expect(code).toBe(0);
    const issueCall = sent.find((call) => call.command[1] === "issue")!;
    const title = issueCall.command[issueCall.command.indexOf("--title") + 1]!;
    const body = issueCall.input!;
    expect(title).not.toContain("example-value");
    expect(title).toContain("The pack source <private source>=<redacted>");
    expect(body).not.toContain("example-value");
    expect(body).not.toContain("synthetic-key-val");
    expect(body).not.toContain("synthetic-auth-val");
    expect(body).not.toContain("private-packs");
    expect(body).toContain("The pack source <private source>=<redacted>");
    expect(body).toContain("<private source> <private source><redacted> <private source>");
    expect(body).not.toContain("κοσμος");
    expect(body).not.toContain("ςιγμα");
    expect(body).toContain("from <private source> and <private source>");
    expect(body).toContain("Note: The pack source <private source> is not pinned to a commit SHA.");
  });

  test("redacts a credential-suffixed machine hostname inside a source label", async () => {
    const home = temp.make("home-");
    const profileDir = join(home, "profile");
    mkdirSync(profileDir, { recursive: true });
    await spawnGit(profileDir, "init", "-q");
    writeFileSync(
      join(profileDir, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [{ name: "dev-credentials", repo: "acme/private-packs", ref: "main" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    mkdirSync(join(home, ".config/hedge"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "dev-credentials", profileDir }));
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(["triage", "--send", "--note", "fetched acme/private-packs from mirror"], {
      home,
      engineRoot,
      platform: "darwin",
      env: {},
      print: io.terminal.print,
      terminal: io.terminal,
      capture: runRealGit,
      hostname: () => "dev-credentials.local",
      run: async () => 0,
    });
    expect(code).toBe(0);
    const body = sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body).toContain("fetched <<this machine> source> from mirror");
    expect(body).not.toContain("dev-credentials");
  });

  test("still redacts a full JWT when an inherited source repo matches one of its segments", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-jwt-");
    await spawnGit(inherited, "init", "-q");
    const payloadSeg = "eyJzdWIiOiJ0ZXN0In0";
    const sigSeg = "syntheticSigSegment1234";
    const headerSeg = "eyJhbGciOiJIUzI1NiJ9";
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [{ name: "jwt-seg", repo: sigSeg, ref: "main" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const jwt = `${headerSeg}.${payloadSeg}.${sigSeg}`;
    const code = await main(["triage", "--send", "--note", `auth ${jwt} done`], {
      home,
      engineRoot,
      platform: "darwin",
      env: { HEDGE_PROFILE_DIR: inherited },
      print: io.terminal.print,
      terminal: io.terminal,
      capture: runRealGit,
      hostname: () => "noras-mbp.local",
      run: async () => 0,
    });
    expect(code).toBe(0);
    const issueCall = sent.find((call) => call.command[1] === "issue")!;
    const title = issueCall.command[issueCall.command.indexOf("--title") + 1]!;
    const body = issueCall.input!;
    expect(title).toContain("auth <token> done");
    expect(body).toContain("auth <token> done");
    for (const part of [headerSeg, payloadSeg, sigSeg]) {
      expect(title).not.toContain(part);
      expect(body).not.toContain(part);
    }
  });

  test("keeps full Bearer redaction when a source repo appears inside the token and redacts repos matching a source alias prefix", async () => {
    const home = temp.make("home-");
    const inherited = temp.make("inherited-bearer-");
    await spawnGit(inherited, "init", "-q");
    writeFileSync(
      join(inherited, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [
          { name: "team", repo: "vendor/repo", ref: "main" },
          { name: "vendor", repo: "vendor/draft-packs", ref: "main" },
          { name: "multi", repo: "foo bar", ref: "main" },
        ],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const sent: Sent[] = [];
    const io = scripted([]);
    const runRealGit: CommandRunner = async (command, options = {}) => {
      sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command[0] === "git") return spawnRunner(command, options);
      return capture([], undefined)(command, options);
    };
    const code = await main(
      ["triage", "--send", "--note", "Authorization: Bearer vendor/repo.A1; Bearer tok1234567890.foo bar; The pack source vendor/draft-packs"],
      {
        home,
        engineRoot,
        platform: "darwin",
        env: { HEDGE_PROFILE_DIR: inherited },
        print: io.terminal.print,
        terminal: io.terminal,
        capture: runRealGit,
        hostname: () => "noras-mbp.local",
        run: async () => 0,
      },
    );
    expect(code).toBe(0);
    const issueCall = sent.find((call) => call.command[1] === "issue")!;
    const title = issueCall.command[issueCall.command.indexOf("--title") + 1]!;
    const body = issueCall.input!;
    expect(title).toContain("Authorization: Bearer <token>; Bearer <token>; The pack source <private source>");
    expect(body).toContain("Authorization: Bearer <token>; Bearer <token>; The pack source <private source>");
    for (const leaked of [".A1", "tok1234567890", "foo bar", "draft-packs", "vendor/repo"]) {
      expect(title).not.toContain(leaked);
      expect(body).not.toContain(leaked);
    }

    const overlapHome = temp.make("home-overlap-rand-");
    const overlapProfile = temp.make("profile-overlap-rand-");
    writeFileSync(
      join(overlapProfile, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [{ name: "priv", repo: "/work/private dir", ref: "main" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const overlapSent: Sent[] = [];
    const overlapIo = scripted([]);
    const overlapCode = await main(
      ["triage", "--send", "--note", "aB3x9K2mP7qR4sT8uV1w+/work/private dir/tail"],
      {
        home: overlapHome,
        engineRoot,
        platform: "darwin",
        env: { HEDGE_PROFILE_DIR: overlapProfile },
        print: overlapIo.terminal.print,
        terminal: overlapIo.terminal,
        capture: async (command, options = {}) => {
          overlapSent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
          if (command[0] === "git") return spawnRunner(command, options);
          return capture([], undefined)(command, options);
        },
        hostname: () => "noras-mbp.local",
        run: async () => 0,
      },
    );
    expect(overlapCode).toBe(0);
    const overlapIssue = overlapSent.find((call) => call.command[1] === "issue")!;
    const overlapTitle = overlapIssue.command[overlapIssue.command.indexOf("--title") + 1]!;
    const overlapBody = overlapIssue.input!;
    expect(overlapBody).toContain("<secret><private source>/tail");
    for (const leaked of ["aB3x9K2mP7qR4sT8uV1w", "private dir"]) {
      expect(overlapTitle).not.toContain(leaked);
      expect(overlapBody).not.toContain(leaked);
    }

    const schemeHome = temp.make("home-scheme-source-");
    const schemeProfile = temp.make("profile-scheme-source-");
    writeFileSync(
      join(schemeProfile, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [{ name: "secret-alias", repo: "https", ref: "source" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const schemeSent: Sent[] = [];
    const schemeIo = scripted([]);
    const schemeCode = await main(
      ["triage", "--send", "--note", "https://alice:SyntheticUrlPass123@example.com/repo token Bearer secretToken12345"],
      {
        home: schemeHome,
        engineRoot,
        platform: "darwin",
        env: { HEDGE_PROFILE_DIR: schemeProfile },
        print: schemeIo.terminal.print,
        terminal: schemeIo.terminal,
        capture: async (command, options = {}) => {
          schemeSent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
          if (command[0] === "git") return spawnRunner(command, options);
          return capture([], undefined)(command, options);
        },
        hostname: () => "noras-mbp.local",
        run: async () => 0,
      },
    );
    expect(schemeCode).toBe(0);
    const schemeIssue = schemeSent.find((call) => call.command[1] === "issue")!;
    const schemeTitle = schemeIssue.command[schemeIssue.command.indexOf("--title") + 1]!;
    const schemeBody = schemeIssue.input!;
    expect(schemeTitle).toContain("<credentials>@example.com/repo token Bearer <token>");
    expect(schemeBody).toContain("<credentials>@example.com/repo token Bearer <token>");
    expect(schemeBody).toContain("The pack <branch> <private source> is not pinned to a commit SHA.");
    for (const leaked of ["SyntheticUrlPass123", "secretToken12345", "secret-alias"]) {
      expect(schemeTitle).not.toContain(leaked);
      expect(schemeBody).not.toContain(leaked);
    }

    const bearerPathProfile = temp.make("profile-bearer-path-");
    writeFileSync(
      join(bearerPathProfile, "hedge.json"),
      JSON.stringify({
        schema: 1,
        engine: { repo: "PostHog/hedge", ref: "main", channel: "track" },
        sources: [{ name: "bp", repo: "Bearer tok1234", ref: "main" }],
        packs: [],
        plan: "both",
        settings: {},
        workflows: {},
      }),
    );
    const bpSent: Sent[] = [];
    const bpIo = scripted([]);
    const bpCode = await main(
      ["triage", "--send", "--note", "Authorization: Bearer tok1234567890SECRET"],
      {
        home: temp.make("home-bp-"),
        engineRoot,
        platform: "darwin",
        env: { HEDGE_PROFILE_DIR: bearerPathProfile },
        print: bpIo.terminal.print,
        terminal: bpIo.terminal,
        capture: async (command, options = {}) => {
          bpSent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
          if (command[0] === "git") return spawnRunner(command, options);
          return capture([], undefined)(command, options);
        },
        hostname: () => "noras-mbp.local",
        run: async () => 0,
      },
    );
    expect(bpCode).toBe(0);
    const bpIssue = bpSent.find((call) => call.command[1] === "issue")!;
    const bpTitle = bpIssue.command[bpIssue.command.indexOf("--title") + 1]!;
    const bpBody = bpIssue.input!;
    expect(bpTitle).toContain("Authorization: Bearer <token>");
    expect(bpBody).toContain("Authorization: Bearer <token>");
    expect(bpTitle).not.toContain("tok1234567890SECRET");
    expect(bpBody).not.toContain("tok1234567890SECRET");

    const skKnown = [
      { text: "private-owner/SK-abcdefghijklmnop1234", as: "<private source>" },
      { text: "private-owner/EYJ12345678.12345678.12345678", as: "<private source>" },
      { text: "private-owner/SK-aaaaaaaaaaaaaaaa/SK-bbbbbbbbbbbbbbbb", as: "<private source>" },
      { text: "private-owner/SK-prefix-SK-abcdefghijklmnop1234", as: "<private source>" },
      { text: "abc", as: "<name>" },
      { text: "https://github.com/ABC/private-repo", as: "<private source>" },
    ];
    expect(redact("failed to clone https://github.com/private-owner/sk-abcdefghijklmnop1234.git", schemeHome, skKnown)).toBe(
      "failed to clone https://github.com/<private source>.git",
    );
    expect(redact("failed to clone https://github.com/private-owner/eyJ12345678.12345678.12345678.git", schemeHome, skKnown)).toBe(
      "failed to clone https://github.com/<private source>.git",
    );
    expect(redact("failed to clone https://github.com/private-owner/sk-aaaaaaaaaaaaaaaa/SK-bbbbbbbbbbbbbbbb.git", schemeHome, skKnown)).toBe(
      "failed to clone https://github.com/<private source>.git",
    );
    expect(redact("failed to clone https://github.com/private-owner/SK-prefix-sk-abcdefghijklmnop1234.git", schemeHome, skKnown)).toBe(
      "failed to clone https://github.com/<private source>.git",
    );
    expect(redact("clone https://github.com/abc/private-repo and abc", schemeHome, skKnown)).toBe(
      "clone <private source> and <name>",
    );

    const deepSk = `${"SK-prefix-".repeat(9)}SK-abcdefghijklmnop1234`;
    const deepSkLowerTail = `${"SK-prefix-".repeat(9)}sk-abcdefghijklmnop1234`;
    const caseKnown = [
      { text: "https://SERVER.INTERNAL/demo-owner/demo-pack", as: "<private source>" },
      { text: "https://GIT.INTERNAL/acme/private-packs", as: "<private source>" },
      { text: "git@SERVER.INTERNAL:acme/private-ssh", as: "<private source>" },
      { text: "/USERS/ALICE/private-local", as: "<private source>" },
      { text: `private-owner/${deepSk}`, as: "<private source>" },
      { text: "12", as: "<this machine>" },
      { text: "acme/private-packs", as: "<private source>" },
      { text: "https://github.com/acme/project.abcdefghijklmnopqrstuvwxyz0123456789", as: "<private source>" },
    ];
    expect(redact("clone https://server.internal/demo-owner/demo-pack", "/Users/alice", caseKnown)).toBe(
      "clone <private source>",
    );
    expect(redact("clone https://git.internal/acme/private-packs", "/Users/alice", caseKnown)).toBe(
      "clone <private source>",
    );
    expect(redact("clone GIT@server.internal:acme/private-ssh", "/Users/alice", caseKnown)).toBe(
      "clone <private source>",
    );
    expect(redact("path /Users/alice/private-local", "/Users/alice", caseKnown)).toBe(
      "path <private source>",
    );
    expect(redact(`clone https://github.com/private-owner/${deepSkLowerTail}.git`, "/Users/alice", caseKnown)).toBe(
      "clone https://github.com/<private source>.git",
    );
    const repeated = Array.from({ length: 15 }, () => "acme/private-packs").join(" ");
    expect(redact(`${repeated} on 12`, "/Users/alice", caseKnown)).toBe(
      `${Array.from({ length: 15 }, () => "<private source>").join(" ")} on <this machine>`,
    );
    expect(
      redact("clone https://github.com/acme/project.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "/Users/alice", caseKnown),
    ).toBe("clone <private source>");
    expect(
      redact("checkout /home/alice/project/confidential-release", "/home/alice", [
        { text: "/home/alice/project", as: "<private source>" },
        { text: "project/confidential-release", as: "<branch>", after: true },
      ]),
    ).toBe("checkout <branch>");
    expect(
      redact("private-owner/private-packs/release-candidate", "/Users/alice", [
        { text: "private-owner/private-packs", as: "<private source>" },
        { text: "private-packs/release-candidate", as: "<branch>", after: true },
      ]),
    ).toBe("<branch>");
    expect(
      redact("cloning ware", "/Users/alice", [
        { text: "ware", as: "<warehouse source>" },
        { text: "warehouse", as: "<branch>", after: true },
      ]),
    ).toBe("cloning <<branch> source>");
    expect(
      redact("hit a.internal/B.INTERNAL/c.internal/D.INTERNAL/secret-branch", "/Users/alice", [
        { text: "A.INTERNAL/b.internal/C.INTERNAL/d.internal/secret-branch", as: "<branch>", after: true },
      ]),
    ).toBe("hit <branch>");
    expect(
      redact("Created the private repo acme/team/secret:nested", "/Users/alice", [
        { text: "acme/team/secret:nested", as: "<custom source>" },
      ]),
    ).toBe("Created the private repo <custom source>");
  });
});

describe("hedge setup and triage", () => {
  test("a failed step records the transcript and the step, and its message names hedge triage", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    const failed = await hedgeSetup(home, args, [], fakeMachine(home), undefined, 1);
    expect(failed.code).toBe(1);
    expect(failed.output).toEndWith("hedge: hedge doctor found something to fix on this machine. Fix what it says above, then run hedge setup again.\nStuck? Run hedge triage. It shows a report of this setup that you can send to the Hedge maintainer.");
    expect(statSync(join(home, ".local/state/hedge/logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".local/state/hedge/logs/setup.log")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".local/state/hedge/logs/setup-failed.json")).mode & 0o777).toBe(0o600);
    const report = await triage(home, ["--print"], []);
    expect(report.output).toMatch(/- Failed at \S+, 9 of 9: Check everything: hedge doctor found something to fix on this machine\./);
    expect(report.output).toContain("=== hedge setup --non-interactive --preset starter --plan claude at ");
    expect(report.output).toContain("✗ hedge doctor found something to fix on this machine.");

    const passed = await hedgeSetup(home, args, [], fakeMachine(home));
    expect(passed.code).toBe(0);
    expect(passed.output).toContain("  Report          hedge triage sends a report of this setup to the Hedge maintainer.");
    expect(existsSync(join(home, ".local/state/hedge/logs/setup-failed.json"))).toBe(false);
    const after = await triage(home, ["--print"], []);
    expect(after.output).toContain("- No failed setup run is recorded.");
    expect(after.output).toContain("Welcome back. 8 of 9 done, picking up at Check everything.");
  });

  test("makes records that an earlier run left readable to others private", async () => {
    const home = temp.make("home-");
    const logs = join(home, ".local/state/hedge/logs");
    mkdirSync(logs, { recursive: true, mode: 0o755 });
    writeFileSync(join(logs, "setup.log"), "an earlier run\n", { mode: 0o644 });
    await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home));
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(join(logs, "setup.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(logs, "setup.log"), "utf8")).toStartWith("an earlier run\n=== hedge setup ");
  });

  test("setup goes on when it cannot write its records", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local"), { recursive: true });
    writeFileSync(join(home, ".local/state"), "a file where Hedge's state folder goes");
    const result = await hedgeSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home), undefined, 1);
    expect(result.code).toBe(1);
    expect(result.output).toContain("▶ Check everything");
    expect(result.output).toEndWith("Stuck? Run hedge triage. It shows a report of this setup that you can send to the Hedge maintainer.");
  });

});
