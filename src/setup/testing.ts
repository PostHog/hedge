import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { main } from "../cli.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import type { ExecResult, Machine } from "./commands.ts";
import { quote } from "../hub/ssh.ts";
import { gitEnv, spawnGit } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { Stopped, type Terminal } from "./terminal.ts";
import { remoteLauncher } from "../hub/ssh.ts";

export const engineRoot = join(import.meta.dir, "../..");

/** Types each reply in turn; when the replies run out it acts like Ctrl-C. */
export function scripted(replies: string[]) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const terminal: Terminal = {
    print: (line) => void lines.push(line),
    async ask(prompt) {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply === undefined) throw new Stopped();
      lines.push(`${prompt}${reply}`);
      return reply;
    },
  };
  return { terminal, prompts, output: () => lines.join("\n") };
}

export type ClaudeSignedIn = { authMethod: string; apiKeySource?: string; reply: ExecResult };

const claudeUnauthorized: ExecResult = { code: 1, output: "Failed to authenticate. API Error: 401 OAuth access token is invalid", stdout: "" };

export const deadEnvironmentToken: ClaudeSignedIn = { authMethod: "oauth_token", reply: claudeUnauthorized };

const scopes = "  - Token scopes: 'admin:public_key', 'admin:ssh_signing_key', 'read:org', 'repo', 'workflow'";

/** The bare repo that stands in for github.com/<repo> under a test home. */
export const githubRepo = (home: string, repo: string) => join(home, "github-remotes", `${repo}.git`);

const topicsFile = (home: string, repo: string) => join(githubRepo(home, repo), "topics");

export const repoTopics = (home: string, repo: string) => (existsSync(topicsFile(home, repo)) ? readFileSync(topicsFile(home, repo), "utf8").split("\n").filter(Boolean) : []);

export const markRepo = (home: string, repo: string, topic: string) => writeFileSync(topicsFile(home, repo), [...repoTopics(home, repo), topic, ""].join("\n"));

export const ownedRepos = (home: string, owner: string) => {
  const dir = join(home, "github-remotes", owner);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".git")).map((name) => `${owner}/${name.slice(0, -4)}`).sort() : [];
};

/** Git with github.com rewritten to the bare repos; a clone keeps the rewrite, so later pushes from any code reach them too. */
async function realGit(home: string, args: string[], cwd?: string): Promise<ExecResult> {
  const remotes = `${join(home, "github-remotes")}/`;
  const run = async (command: string[]) => {
    const child = Bun.spawn(command, { cwd, env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: `${stdout}${stderr}`, stdout };
  };
  const rewrite = `url.${remotes}.insteadOf=https://github.com/`;
  return run(["git", "-c", rewrite, ...(args[0] === "clone" ? ["clone", "--config", rewrite, ...args.slice(1)] : args)]);
}

type T3Session = { sessionId: string; token: string; revoked: boolean };

type SignInName = "github" | "claude" | "chatgpt" | "coder" | "box:github" | "box:claude" | "box:chatgpt" | "box:t3" | "box:coder";

/** What coder whoami prints when signed in, as the Coder CLI writes it. */
export const coderWhoami = "Coder is running at https://coder.example.com, You're authenticated as nora !\n";
const coderUserId = "5b6f2a3e-8f4c-4d1a-9c7e-2f1b0a9d8e71";
const otherCoderUserId = "c0a8e4d2-1b3f-4e5a-8d6c-7f9e0a1b2c3d";
/** What coder whoami -o json prints when signed in, as the Coder CLI writes it. */
const coderWhoamiJson = (url: string, userId: string) => `${JSON.stringify([{ url: `${url}/`, username: "nora", user_id: userId, organization_ids: [], roles: {} }], null, 2)}\n`;
/** A Coder session that the person made on a box, outside Hedge. */
export const personCoderToken = ["person", "coder", "session"].join("-");
/** The one token coder tokens create prints, alone on its line. */
export const coderToken = ["hedge", "test", "coder", "token"].join("-");

const hostKeyAdded = (host: string) => `Warning: Permanently added '${host}' (ED25519) to the list of known hosts.\n`;

const enterpriseHostKeys = [["ssh-ed25519", ["AAAA", "enterprise", "ed"].join("")]].map((words) => words.join(" "));

export const fakeGitHubHostKeys = [["ssh-ed25519", ["AAAA", "github", "ed"].join("")], ["ecdsa-sha2-nistp256", ["AAAA", "github", "ecdsa"].join("")]].map((words) => words.join(" "));

export type HereLink = { environmentId: string; label: string; status?: string; expiresAt?: string };

export const boxHome = (home: string, host: string) => join(home, "boxes", host);
export const agentCoderPath = (home: string) => join(home, "tmp", "coder.agent1", "coder");
export const ownCoder = '#!/bin/sh\n# own\n[ "$1" = version ]\n';
export const servedCoderPath = (home: string) => join(home, "coder-network", "coder-cli");

export const boxMachineFile = (home: string, host: string) => JSON.parse(readFileSync(join(boxHome(home, host), ".config/hedge/machine.json"), "utf8"));

/** The command an SSH call runs on the box, without the PATH prefix. */
export const onBox = (command: string[]) => (command[0] === "ssh" ? command.at(-1)!.replace(/^PATH=[^;]*; /, "") : undefined);

/**
 * A machine signed in to GitHub as nora, whose sign-ins pass after a number
 * of 2 s polls: 0 means already signed in, and a sign-in that is never
 * started never passes. Its gh makes repos as bare repos under the home,
 * except in the org named by createFails (createFailsAfterMaking makes the
 * repo, then reports a 502; lookupFails answers a lookup of a repo that
 * exists there with a 502; topicFails refuses every topic edit; gh repo list
 * answers the topics that markRepo or a topic edit set), and
 * git runs for real with github.com rewritten to them. Its ssh reaches a fake
 * devbox whose sign-ins work the same way, and which, like real ssh, warns
 * on stderr that it added the host key the first time it reaches a host
 * other than a coder. one; Claude there signs in when its
 * foreground sign-in runs. A command on the box that reads or writes its
 * role file runs for real in a home folder of its own under the test home.
 * The hub takes the nodes the pushed profile lists at each hedge update;
 * until then it refuses a node's credential when the node applies its
 * profile, and its hedge peers link refuses the node.
 * T3 on each machine reports what the real CLI prints: the shared relayUrl,
 * and a tunnelHostname only when cliPrintsTunnel is set. Its server answers
 * link-state with the tunnel hostname to a session it issued and has not
 * revoked, unless serverWithoutLinkState names that side. Its runtime record
 * names a loopback server, process 4242, that runs unless runtimeOrigin,
 * runtimePid or serverGone say otherwise. Its environment sets a proxy that
 * takes every curl request which does not turn proxies off. The box's tunnel answers only after tunnelStartsAfter lookups, and the tunnel here only after hereTunnelStartsAfter.
 * Each box's T3 environment id is env-<host>, except on the hosts withoutT3, where T3 never ran.
 * T3 here lists hereLinks as its linked environments, and unlink forgets one, or fails with unlinkFails. T3 on the hub lists hubLinks. ssh never reaches the hosts named unreachable.
 * This machine is signed in to Coder at coderAt, https://coder.example.com unless set. A box answers Coder's build info, and serves the Coder CLI, only at boxReachesCoderAt, this machine's address unless set; coderRedirects makes the build info or the CLI answer with a redirect instead, which its curl follows when told to on the command line or in ~/.curlrc, unless -q comes first or --max-redirs is 0. Its curl refuses any other protocol than HTTPS when told --proto =https. coderCli makes the CLI download answer with another status than 200, with no body, or with a CLI whose version fails. Every shell command on the box runs with boxEnv, and one that dies of a signal exits 255, as ssh does when the remote command dies of one, since it ignores exit-signal. Its Coder sign-in runs in bash -c, as sshd runs it in a bash login shell, which runs the last command in place of itself. Its Coder CLI signs in with CODER_SESSION_TOKEN and CODER_URL from boxEnv, or else the session and url files in ~/.config/coderv2, when they hold a token this machine made and has not removed, and an address it reaches, or personCoderToken at any address, as another Coder user unless boxCoderSameUser. Without them a box is signed in as this machine's user while its box:coder sign-in passes. It waits for ever on a url or session FIFO, so it fails there. The Coder CLI it downloads runs coder login as the real one does: it takes CODER_SESSION_TOKEN as the session only with --use-token-as-session, else it makes a new one, and without the variable the person pastes one; it signs in only at an address the box reaches, with a token the server knows, and writes session, then url, for only their owner to read; like the real one, it keeps the mode of a session file that is there and logs the mode each session file has as it writes the token, which sessionModes returns. With coderLoginKilled, its coder login is killed with SIGKILL as it starts. Its coder config-ssh needs a known token too, fails with coderConfigSshFails, and writes ~/.ssh/config for CODER_URL, or else for the address in the url file, as the coder config-ssh of a signed-in box does, with a ProxyCommand that runs the Coder CLI that wrote it. Like a Coder workspace over SSH, the box has the Coder agent's CLI, which works as the downloaded one does, in a temporary folder on its PATH after ~/.local/bin; agentCoder broken makes it fail, and none takes it away. Here, coder tokens create and remove keep the list coderTokens returns; coderTokenRemoveFails makes a removal fail, and coderTokenRemoveHangs makes it write each TERM it gets to removalTerms and stay alive until it is killed. One fake timeout runs here and on the box: it takes only -s KILL, -k and a limit, arms its deadline on this machine's fake clock, and at the deadline signals the command's process group as GNU timeout does. With signInTimesOut, coder login on the box ignores TERM and stays alive with a child that holds the output. stuckSignIn and stuckRemoval wait for the pids of what hangs. With signInConnectionStalls, SSH setup takes 5 seconds of the fake clock, coder login on the box prints a line as it starts, signInAnnounced resolves with the time the SSH call started once that line comes through, and the connection stays open after the sign-in. passTime moves the clock on, fires the deadlines that have passed, waits until each signal is sent and each group it kills has ended, and ends a connection by its process group when the exec's timeoutMs has passed. openConnections counts the connections still open, and stopFakeProcesses kills what is left. hedge peers link on the hub renews the node's link in the list T3 on the hub returns.
 * With node set, every other command on a box runs on a Node.
 */
export function fakeMachine(home: string, polls: Partial<Record<SignInName, number>> = {}, options: { org?: boolean; createFails?: string; createFailsAfterMaking?: string; topicFails?: boolean; lookupFails?: string; publicRepos?: string[]; scopes?: string; failRun?: boolean; exits?: Partial<Record<SignInName, number>>; connectHere?: boolean; boxFiles?: Record<string, string>; hubDown?: boolean; hubUpdateFails?: string; boxCoderSameUser?: boolean; boxEnv?: Record<string, string>; coderRedirects?: Array<"probe" | "binary">; coderCli?: "non-200" | "empty" | "broken"; claude?: Partial<Record<"claude" | "box:claude", ClaudeSignedIn>>; startedAt?: number; cliPrintsTunnel?: boolean; serverWithoutLinkState?: Array<"box" | "here">; runtimeOrigin?: string; runtimePid?: unknown; serverGone?: boolean; boxConnect?: { authenticated: unknown; linked: unknown }; hereConnect?: { desired?: unknown; authenticated?: unknown; linked?: unknown }; t3Home?: string; devServerUrl?: string; tunnelStartsAfter?: number; hereTunnelStartsAfter?: number; withoutT3?: string[]; hereLinks?: HereLink[]; unreachable?: string[]; unlinkFails?: string; hereStatusFailures?: number; installers?: Record<string, string>; installerEnv?: Record<string, string>; hubLinks?: HereLink[]; boxReachesCoderAt?: string; agentCoder?: "broken" | "empty" | "raced" | "racedFolder" | "stalls" | "none"; coderAt?: string; coderTokenRemoveFails?: boolean; coderConfigSshFails?: boolean; coderLoginKilled?: boolean; signInTimesOut?: boolean; signInConnectionStalls?: boolean; coderTokenRemoveHangs?: boolean; node?: Node; codexProbe?: { output: string; loggedIn: boolean; statusError?: string; afterSignIn?: string }; codexConfig?: string; boxCodexAfterSignIn?: string } = {}) {
  const left: Record<SignInName, number> = { github: 0, claude: 0, chatgpt: 0, coder: 0, "box:github": 0, "box:claude": 0, "box:chatgpt": 0, "box:t3": 0, "box:coder": 0, ...polls };
  const started = new Set<SignInName>();
  const calls: Array<{ command: string[]; cwd?: string; timeoutMs?: number; input?: string }> = [];
  const coderTokens = new Set<string>();
  const serverTokens = join(home, "coder-server-tokens");
  const coderArgv = join(home, "coder-argv");
  const sessionModes = join(home, "coder-session-modes");
  const stuckSignIn = join(home, "stuck-sign-in");
  const stuckVersion = join(home, "stuck-version");
  const stuckRemoval = join(home, "stuck-removal");
  const removalTerms = join(home, "removal-terms");
  const tokenNameList = join(home, "coder-token-names");
  const removedTokens = join(home, "removed-coder-tokens");
  const deadlines = join(home, "deadlines");
  const timeoutBin = fakeTimeout(home, deadlines);
  const tokenNames = new Map<string, string>();
  const keepTokens = () => (writeFileSync(serverTokens, [...coderTokens].map((token) => `${token}\n`).join("")), writeFileSync(tokenNameList, [...tokenNames.keys()].map((name) => `${name}\n`).join("")));
  keepTokens();
  const hereCoder = hereCoderBin(home, tokenNameList, removedTokens, options.coderTokenRemoveFails ? "fails" : options.coderTokenRemoveHangs ? "hangs" : "removes", { stuck: stuckRemoval, terms: removalTerms });
  const coderAt = options.coderAt ?? "https://coder.example.com";
  const reachesCoderAt = options.boxReachesCoderAt ?? coderAt;
  const hubUpdates: string[] = [];
  const hubTook = new Set<string>();
  const credentials: Array<{ node: string; issued: boolean }> = [];
  const hubLinked: string[] = [];
  const starts: string[][] = [];
  const runs: Array<{ command: string[]; input: boolean }> = [];
  const sleeps: number[] = [];
  let now = options.startedAt ?? 0;
  const clock = { now: () => now };
  const opened: string[] = [];
  let devbox = false;
  const passes = (name: SignInName) => left[name] === 0;
  const codexSaved: Partial<Record<SignInName, string>> = {};
  let codexCredential = options.codexProbe?.loggedIn ? "kept" : undefined;
  const storeIn = (text: string) => /cli_auth_credentials_store\s*=\s*"([^"]*)"/.exec(text)?.[1];
  const configuredStore = (name: SignInName) => {
    const store = name === "chatgpt" && options.codexConfig !== undefined ? parseToml(options.codexConfig).cli_auth_credentials_store : undefined;
    return typeof store === "string" ? store : undefined;
  };
  const codexReads = (name: SignInName, line: string) => {
    const store = storeIn(line) ?? (line.includes("--ignore-user-config") ? "auto" : (configuredStore(name) ?? "auto"));
    const saved = codexSaved[name];
    return passes(name) && (saved === undefined || saved === store || (store === "auto" && saved === "file"));
  };
  const result = (ok: boolean, output = ""): ExecResult => ({ code: ok ? 0 : 1, output, stdout: output });
  const reached = new Set<string>();
  const claudeStatus = (name: "claude" | "box:claude") => {
    const signedIn = options.claude?.[name];
    return signedIn ? result(true, JSON.stringify({ loggedIn: true, authMethod: signedIn.authMethod, apiKeySource: signedIn.apiKeySource })) : result(passes(name), JSON.stringify({ loggedIn: passes(name) }));
  };
  const claudeReply = (name: "claude" | "box:claude") => options.claude?.[name]?.reply ?? (passes(name) ? result(true, "ok") : claudeUnauthorized);
  const ghStatus = (name: SignInName, granted: string) => (passes(name) ? result(true, `github.com\n${granted}\n`) : result(false, "You are not logged in"));
  const hereLinks = [...(options.hereLinks ?? [])];
  const hubLinks = [...(options.hubLinks ?? [])];
  const boxSessions: T3Session[] = [];
  const hereSessions: T3Session[] = [];
  const recorded = options.runtimeOrigin ?? "http://127.0.0.1:41773";
  const origin = URL.canParse(recorded) ? new URL(recorded).origin : recorded;
  const lookups = { box: 0, here: 0 };
  const startsAfter = { box: options.tunnelStartsAfter ?? 0, here: options.hereTunnelStartsAfter ?? 0 };
  const peerLinks: Record<"box" | "here", string[]> = { box: [], here: [] };
  const pending: Record<"box" | "here", number> = { box: 0, here: 0 };
  const pairingCodes = { box: "BOXCODE", here: "HERECODE" };
  const tunnels = { box: "box-1.relay.example", here: "here.relay.example" };
  const runtimeRecord = async (line: string, sideHome: string): Promise<ExecResult> => {
    const record = (at: string, origin: string) => {
      const file = `${at}/userdata/server-runtime.json`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, pid: "runtimePid" in options ? options.runtimePid : 4242, port: Number(new URL(origin).port || 80), origin }));
    };
    const raw = options.t3Home ?? "";
    const trimmed = raw.trim();
    const t3Reads = trimmed === "" ? join(sideHome, ".t3") : trimmed.startsWith("~") ? join(sideHome, trimmed.slice(1)) : resolve(sideHome, trimmed);
    if (raw !== "") record(isAbsolute(raw) ? raw : join(sideHome, raw), "http://127.0.0.1:6666");
    record(t3Reads, recorded);
    const env: Record<string, string> = { HOME: sideHome, PATH: process.env.PATH ?? "", ...(options.t3Home === undefined ? {} : { T3CODE_HOME: options.t3Home }), ...(options.devServerUrl ? { VITE_DEV_SERVER_URL: options.devServerUrl } : {}) };
    const child = Bun.spawn(["sh", "-c", line], { cwd: sideHome, env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: `${stdout}${stderr}`, stdout };
  };
  const t3 = (line: string, token: string, input: string | undefined, side: { name: "box" | "here"; home: string; linked: boolean; tunnel: string; sessions: T3Session[] }) => {
    const { sessions } = side;
    if (line.startsWith("t3 pair ")) return pending[side.name]++, result(true, `Pairing with test.\n\nPairing URL: http://127.0.0.1:3773/pair#token=x\nToken: ${token}\n`);
    if (line.startsWith("t3 environment link ")) {
      const other = side.name === "box" ? "here" : "box";
      const words = line.split(" ");
      const address = words[3];
      const code = words.includes("--pairing-code") ? words[words.indexOf("--pairing-code") + 1] : undefined;
      if (pending[other] === 0 || code !== pairingCodes[other] || address !== `https://${tunnels[other]}`) return result(false, "t3: the pairing code or the address does not match a pairing\n");
      pending[other]--;
      return (peerLinks[side.name] = [...new Set([...peerLinks[side.name], address])]), result(true, "linked");
    }
    if (side.name === "here" && line === "t3 environment list --json") return result(true, JSON.stringify(hereLinks.map((link) => ({ urls: [], access: "full-access", status: "reachable", ...link }))));
    const forgotten = side.name === "here" ? hereLinks.findIndex((link) => line === `t3 environment unlink ${link.environmentId}`) : -1;
    if (forgotten >= 0 && options.unlinkFails) return result(false, `${options.unlinkFails}\n`);
    if (forgotten >= 0) return hereLinks.splice(forgotten, 1), result(true, "Unlinked.");
    const status = side.name === "box" && options.boxConnect ? options.boxConnect : side.name === "here" && options.hereConnect ? options.hereConnect : { authenticated: side.linked, linked: side.linked };
    if (line === "t3 connect status --json" && side.name === "here" && (options.hereStatusFailures ?? 0) > 0) return options.hereStatusFailures!--, result(false, "t3: could not reach the T3 server\n");
    if (line === "t3 connect status --json") return result(true, JSON.stringify({ desired: side.linked, ...status, revoked: false, relayUrl: "https://relay.example", ...(options.cliPrintsTunnel && side.linked ? { tunnelHostname: side.tunnel } : {}) }));
    if (line.startsWith("sh -c ") && line.includes("server-runtime.json")) return runtimeRecord(line, side.home);
    const killed = line.match(/^sh -c 'kill -0 (\S+)'$/)?.[1];
    if (killed !== undefined) return result(!options.serverGone && killed === String("runtimePid" in options ? options.runtimePid : 4242));
    if (line.startsWith("curl ") && !line.startsWith("curl -q --noproxy '*' ")) return { code: 22, output: "curl: (22) The requested URL returned error: 502 from the proxy", stdout: "" };
    if (line === "t3 auth session issue --json --ttl 5m --label hedge --subject hedge --scope relay:read") {
      const session = { sessionId: `session-${sessions.length + 1}`, token: `t3-bearer-${side.tunnel}-${sessions.length + 1}`, revoked: false };
      sessions.push(session);
      return result(true, `${JSON.stringify({ sessionId: session.sessionId, token: session.token, scopes: ["relay:read"] })}\n`);
    }
    const revoked = sessions.find((session) => line === `t3 auth session revoke ${session.sessionId}`);
    if (revoked) return (revoked.revoked = true), result(true, "Revoked.");
    if (line === `curl -q --noproxy '*' -fsS --max-time 15 -H @- ${quote(`${origin}/api/connect/link-state`)}`) {
      const lines = input?.split("\n") ?? [];
      const live = sessions.some((session) => !session.revoked && lines.includes(`authorization: Bearer ${session.token}`));
      if (!lines.includes("x-t3-orchestration-protocol: 2")) return { code: 22, output: "curl: (22) The requested URL returned error: 400", stdout: "" };
      if (!live) return { code: 22, output: "curl: (22) The requested URL returned error: 401", stdout: "" };
      if (options.serverWithoutLinkState?.includes(side.name)) return { code: 22, output: "curl: (22) The requested URL returned error: 404", stdout: "" };
      return result(true, JSON.stringify({ linked: side.linked, relayUrl: "https://relay.example", managedTunnelActive: side.linked, linkRevoked: false, tunnelHostname: side.linked && ++lookups[side.name] > startsAfter[side.name] ? side.tunnel : null, linkableHere: false }));
    }
    return undefined;
  };
  const pushedProfile = async (): Promise<{ hub?: string; devboxes?: string[] }> => {
    try {
      return await pushedAnswers(home);
    } catch {
      return {};
    }
  };
  const onTheHub = async (line: string, host: string): Promise<ExecResult | undefined> => {
    const hedge = line.includes(`${remoteLauncher} `) ? line.slice(line.indexOf(`${remoteLauncher} `) + remoteLauncher.length + 1) : undefined;
    if (hedge === undefined) return undefined;
    if (options.hubDown) return { code: 255, output: "ssh: connect to host: Connection refused", stdout: "" };
    if (hedge === "update" && options.hubUpdateFails) return result(false, `${options.hubUpdateFails}\n`);
    if (hedge === "update") {
      hubUpdates.push(host);
      for (const node of (await pushedProfile()).devboxes ?? []) hubTook.add(node);
      return result(true, "✓ Up to date");
    }
    const linked = hedge.match(/^peers link (\S+)$/)?.[1];
    if (linked === undefined) return result(false, `unexpected on the hub: ${hedge}`);
    if (!hubTook.has(linked) || !passes("box:t3")) return result(false, `${linked}: not linked`);
    hubLinked.push(linked);
    const renewed = { environmentId: `env-${linked}`, label: linked.replace(/^coder\./, ""), status: "reachable", expiresAt: renewedUntil };
    hubLinks.splice(0, hubLinks.length, ...hubLinks.filter((link) => link.environmentId !== renewed.environmentId), renewed);
    return result(true, `linked ${linked}`);
  };
  const onBoxEnv = (host: string, bin?: string, env: Record<string, string> = {}) => ({ PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(":"), ...options.boxEnv, ...env, HOME: boxHome(home, host) });
  const agentCoder = () => {
    if (options.agentCoder === "none") return [];
    mkdirSync(dirname(agentCoderPath(home)), { recursive: true });
    const cli = options.agentCoder === "broken" ? "#!/bin/sh\nexit 1\n" : options.agentCoder === "empty" ? "" : downloadedCoder(reachesCoderAt, serverTokens, coderFails(), coderLogs, options.agentCoder === "raced" ? personInstallsCoder : options.agentCoder === "racedFolder" ? personMakesFolder : options.agentCoder === "stalls" ? stallsAsCopy(stuckVersion) : ":");
    writeFileSync(agentCoderPath(home), cli, { mode: 0o755 });
    return [dirname(agentCoderPath(home))];
  };
  const boxPath = (host: string, ...bins: string[]) => [join(boxHome(home, host), ".local/bin"), ...bins, ...agentCoder(), timeoutBin, "/usr/bin:/bin"].join(":");
  const signInEnv = (host: string) => onBoxEnv(host, undefined, { PATH: boxPath(host) });
  const forReal = async (line: string, host: string, input?: string, bin?: string, env: Record<string, string> = {}, shell = "sh"): Promise<ExecResult> => {
    const child = Bun.spawn([shell, "-c", line], { env: onBoxEnv(host, bin, env), stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: child.signalCode ? sshLostExit : code, output: `${stdout}${stderr}`, stdout };
  };
  const connections: Array<{ endsAt: number; ended: boolean; group?: number; end: () => void }> = [];
  let announced = (_startedAt: number) => {};
  const signInAnnounced = new Promise<number>((resolve) => (announced = resolve));
  const stalledConnection = async (line: string, host: string, run: { input?: string; timeoutMs?: number }): Promise<ExecResult> => {
    const startedAt = now;
    const connection: (typeof connections)[number] = { endsAt: run.timeoutMs === undefined ? Infinity : now + run.timeoutMs, ended: false, end: () => void (connection.ended = true) };
    connections.push(connection);
    await passTime(sshSetupMs);
    if (connection.ended) return { code: sshLostExit, output: "", stdout: "" };
    const child = Bun.spawn(["sh", "-c", 'bash -c "$1"; exec sleep 2147483647', "ssh", line], { detached: true, env: signInEnv(host), stdin: new Blob([run.input ?? ""]), stdout: "pipe", stderr: "pipe" });
    connection.group = child.pid;
    connection.end = () => ((connection.ended = true), killGroup(child.pid));
    const stderr = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let stdout = "";
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      if (stdout.includes(signInStartedLine)) announced(startedAt);
    }
    const code = await child.exited;
    connection.ended = true;
    return { code, output: `${stdout}${await stderr}`, stdout };
  };
  const armed = new Map<number, { fireAt: number[]; fired: number }>();
  const deadlineFiles = () => (existsSync(deadlines) ? readdirSync(deadlines) : []);
  const deadlineFile = (pid: number, kind: "armed" | "group" | "sent") => join(deadlines, `${pid}.${kind}`);
  const timeoutRuns = (pid: number) => existsSync(deadlineFile(pid, "armed")) && processRunning(pid) && readText(`/proc/${pid}/cmdline`).includes(join(timeoutBin, "timeout"));
  const armNew = () => {
    for (const file of deadlineFiles()) {
      const pid = Number(file.match(/^(\d+)\.armed$/)?.[1]);
      const [limit, grace] = readText(join(deadlines, file)).split(" ");
      if (!pid || armed.has(pid) || !limit) continue;
      const at = now + Number(limit) * 1000;
      armed.set(pid, { fireAt: grace === "-" ? [at] : [at, at + Number(grace) * 1000], fired: 0 });
    }
  };
  const fire = async (pid: number, deadline: { fireAt: number[]; fired: number }) => {
    await until(() => existsSync(deadlineFile(pid, "group")) || !timeoutRuns(pid));
    if (!timeoutRuns(pid)) return void (deadline.fired = deadline.fireAt.length);
    deadline.fired++;
    process.kill(pid, "SIGALRM");
    await until(() => readLines(deadlineFile(pid, "sent")).length >= deadline.fired || !processRunning(pid));
    if (readLines(deadlineFile(pid, "sent")).at(-1) !== "KILL") return;
    const group = Number(readText(deadlineFile(pid, "group")));
    await until(() => !processRunning(pid) && groupEnded(group));
    for (const kind of ["armed", "group", "sent"] as const) rmSync(deadlineFile(pid, kind), { force: true });
  };
  const passTime = async (ms: number) => {
    armNew();
    now += ms;
    for (const connection of connections) if (!connection.ended && connection.endsAt <= now) connection.end();
    for (const [pid, deadline] of armed) while (deadline.fired < deadline.fireAt.length && deadline.fireAt[deadline.fired]! <= now) await fire(pid, deadline);
  };
  fakeProcesses.push(async () => {
    const groups = [...connections.flatMap((connection) => (connection.ended || connection.group === undefined ? [] : [connection.group])), ...deadlineFiles().filter((file) => file.endsWith(".group")).map((file) => Number(readText(join(deadlines, file))))].filter(Boolean);
    const timeouts = deadlineFiles().flatMap((file) => Number(file.match(/^(\d+)\.armed$/)?.[1]) || []).filter(timeoutRuns);
    for (const connection of connections) connection.ended = true;
    groups.forEach(killGroup);
    for (const pid of timeouts) process.kill(pid, "SIGKILL");
    await until(() => groups.every(groupEnded) && !timeouts.some(processRunning));
  });
  const underTimeout = async (command: string[]): Promise<ExecResult> => {
    const child = Bun.spawn([join(timeoutBin, "timeout"), ...command.slice(1)], { env: { PATH: `${hereCoder}:/usr/bin:/bin` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    for (const name of readLines(removedTokens)) coderTokens.delete(tokenNames.get(name) ?? ""), tokenNames.delete(name);
    rmSync(removedTokens, { force: true });
    keepTokens();
    return { code, output: `${stdout}${stderr}`, stdout };
  };
  const prepared = new Set<string>();
  const onNode = (line: string, host: string) => {
    if (!prepared.has(host)) prepared.add(host), prepareNode(home, host, options.node!);
    return forReal(line, host, undefined, `${join(boxHome(home, host), ".local/bin")}:${nodeBin(home, host)}`, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitEnv.GIT_CONFIG_GLOBAL });
  };
  const boxCoderSession = (host: string) => {
    const config = join(boxHome(home, host), ".config/coderv2");
    const read = (name: string) => {
      const path = join(config, name);
      if (existsSync(path) && statSync(path).isFIFO()) throw new Error(`the Coder CLI waits for ever on the FIFO at ${path}`);
      return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
    };
    const [token, url] = [options.boxEnv?.CODER_SESSION_TOKEN || read("session"), options.boxEnv?.CODER_URL || read("url")];
    if (token === personCoderToken && url !== undefined) return { at: url, user: options.boxCoderSameUser ? coderUserId : otherCoderUserId };
    if (token !== undefined && coderTokens.has(token) && url === reachesCoderAt) return { at: url, user: coderUserId };
    return passes("box:coder") ? { at: coderAt, user: coderUserId } : undefined;
  };
  const coderLogs: CoderLogs = { argv: coderArgv, modes: sessionModes, stuck: stuckSignIn };
  const coderFails = (): CoderFails => ({ configSsh: Boolean(options.coderConfigSshFails), login: options.coderLoginKilled ? "killed" : options.signInTimesOut ? "stuck" : options.signInConnectionStalls ? "announces" : undefined });
  const coderOnPath = (host: string) => boxPath(host).split(":").map((bin) => join(bin, "coder")).find((cli) => existsSync(cli) && statSync(cli).isFile() && (statSync(cli).mode & 0o111) !== 0);
  const coderRuns = (host: string, cli: string) => Bun.spawnSync(["sh", "-c", '"$0" version', cli], { env: { HOME: boxHome(home, host), PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  const box = async (line: string, input: string | undefined, host: string): Promise<ExecResult> => {
    const hub = await onTheHub(line, host);
    if (hub) return hub;
    if (["coder whoami", "coder whoami -o json", "coder config-ssh --yes"].includes(line)) {
      const cli = coderOnPath(host);
      if (!cli) return result(false, "sh: 1: coder: not found");
      if (!coderRuns(host, cli)) return result(false, "");
      const signedIn = boxCoderSession(host);
      if (!signedIn) return result(false, "You are not logged in");
      if (line === "coder whoami") return result(true, coderWhoami.replace("https://coder.example.com", signedIn.at));
      if (line === "coder whoami -o json") return result(true, coderWhoamiJson(signedIn.at, signedIn.user));
      writeSshConfig(boxHome(home, host), signedIn.at, cli.replace(`${boxHome(home, host)}/`, "~/"));
      return result(true, "Updated \"~/.ssh/config\"");
    }
    const network = () => coderNetwork(home, reachesCoderAt, options.coderRedirects ?? [], options.coderCli, serverTokens, coderFails(), coderLogs);
    if (line.includes("/api/v2/buildinfo")) return forReal(line, host, input, network());
    if (line.includes("/bin/coder-linux-")) return forReal(line, host, input, undefined, { PATH: boxPath(host, network()) });
    if (line.includes("/.coder.XXXXXX")) return forReal(line, host, input, undefined, { PATH: boxPath(host) });
    if (line.includes("/coderv2")) return forReal(line, host, input, undefined, signInEnv(host), "bash");
    if (!options.node && line.includes(" doctor --profile ") && line.endsWith(" --to-do'")) return result(true, "[]\n");
    if (line === "t3 environment list --json") return result(true, JSON.stringify(hubLinks.map((link) => ({ urls: [], access: "full-access", status: "reachable", ...link }))));
    if (line.startsWith("gh auth status")) return ghStatus("box:github", scopes);
    if (line === "gh auth setup-git") return result(true);
    if (line === "claude auth status") return claudeStatus("box:claude");
    if (line === "claude -p ok") return claudeReply("box:claude");
    if (line.includes("codex exec") && options.boxCodexAfterSignIn && started.has("box:chatgpt") && passes("box:chatgpt")) return result(false, options.boxCodexAfterSignIn);
    if (line.includes("codex exec")) return result(codexReads("box:chatgpt", line), "ok");
    if (line === "codex login status") return passes("box:chatgpt") ? result(true, "Logged in using ChatGPT") : result(false, "Not logged in");
    if (line.includes('cat "${CODEX_HOME:-$HOME/.codex}/config.toml"')) return result(false, "cat: config.toml: No such file or directory");
    if (line.startsWith("sh -c 'if [ -f ")) return result(true, Object.entries(options.boxFiles ?? {}).map(([path, text]) => `=== file ${path}\n${text}\n`).join(""));
    if (line.includes("/.config/hedge/machine.json")) return forReal(line, host, input);
    if (line.includes("/userdata/logs/boot-service.log")) return forReal(line, host, input);
    if (line.startsWith("sh -c ") && line.includes("/userdata/environment-id")) return options.withoutT3?.includes(host) ? result(false, "cat: environment-id: No such file or directory") : result(true, `env-${host}\n`);
    return t3(line, pairingCodes.box, input, { name: "box", home: boxHome(home, host), linked: passes("box:t3"), tunnel: tunnels.box, sessions: boxSessions }) ?? (options.node ? onNode(line, host) : result(false, `unexpected on the box: ${line}`));
  };
  const machine: Machine = {
    async exec(command, run = {}) {
      calls.push({ command, ...run });
      const remote = onBox(command);
      if (remote !== undefined) {
        const host = command.at(-2)!;
        if (options.unreachable?.includes(host)) return { code: 255, output: `ssh: Could not resolve hostname ${host}`, stdout: "" };
        if (options.signInConnectionStalls && remote.includes("--use-token-as-session")) return stalledConnection(remote, host, run);
        const answer = await box(remote, run.input, host);
        const firstContact = !host.startsWith("coder.") && !reached.has(host);
        reached.add(host);
        return firstContact ? { ...answer, output: `${answer.output}${hostKeyAdded(host)}` } : answer;
      }
      const line = command.join(" ");
      if (line.startsWith("gh auth status")) return ghStatus("github", started.has("github") ? scopes : (options.scopes ?? scopes));
      if (line === "gh auth setup-git") return result(true);
      if (line.startsWith("gh api user/memberships/orgs/")) return options.org ? result(true, "active\n") : result(false, "Not Found");
      if (line === "claude auth status") return claudeStatus("claude");
      if (line === "claude -p ok") return claudeReply("claude");
      if (line.startsWith("codex exec") && options.codexProbe?.afterSignIn && codexCredential === "replaced") return result(false, options.codexProbe.afterSignIn);
      if (line.startsWith("codex exec")) return codexReads("chatgpt", line) ? result(true, "ok") : result(false, options.codexProbe?.output ?? "ok");
      if (line.startsWith("sh -c ") && line.endsWith("/config.toml\"")) return options.codexConfig === undefined ? result(false, "cat: config.toml: No such file or directory") : result(true, options.codexConfig);
      if (line === "codex login status" && options.codexProbe?.statusError) return result(false, options.codexProbe.statusError);
      if (line === "codex login status") return codexCredential ? result(true, "Logged in using ChatGPT") : result(false, "Not logged in");
      if (line === "coder whoami") return passes("coder") ? result(true, coderWhoami.replace("https://coder.example.com", coderAt)) : result(false, "You are not logged in");
      if (line === "coder whoami -o json") return passes("coder") ? result(true, coderWhoamiJson(coderAt, coderUserId)) : result(false, "You are not logged in");
      if (line.startsWith("coder tokens create --name ")) return passes("coder") ? (tokenNames.set(command[4]!, coderToken), coderTokens.add(coderToken), keepTokens(), result(true, `${coderToken}\n`)) : result(false, "You are not logged in");
      if (command[0] === "timeout") return underTimeout(command);
      if (line === "hogli devbox:status") return result(devbox);
      if (line === "hogli devbox:start") return (devbox = true), result(true, "up");
      if (line === "gh api user --jq .login") return result(true, "nora\n");
      if (line === "gh api --hostname github.com meta --jq .ssh_keys[]") return result(true, `${fakeGitHubHostKeys.join("\n")}\n`);
      if (line === "gh api meta --jq .ssh_keys[]") return result(true, `${enterpriseHostKeys.join("\n")}\n`);
      if (line.startsWith("gh repo view ") && existsSync(githubRepo(home, command[3]!)) && command[3]!.split("/")[0] === options.lookupFails) return result(false, "HTTP 502: Bad Gateway");
      if (line.startsWith("gh repo view ")) return existsSync(githubRepo(home, command[3]!)) ? result(true, line.endsWith("--json visibility --jq .visibility") ? `${options.publicRepos?.includes(command[3]!) ? "PUBLIC" : "PRIVATE"}\n` : "") : result(false, "Could not resolve to a Repository");
      if (line.startsWith("gh repo edit ") && options.topicFails) return result(false, "HTTP 403: Resource not accessible by integration");
      if (line.startsWith("gh repo edit ") && command[4] === "--add-topic") return existsSync(githubRepo(home, command[3]!)) ? (markRepo(home, command[3]!, command[5]!), result(true)) : result(false, "Could not resolve to a Repository");
      if (line.startsWith("gh repo list ")) return result(true, JSON.stringify(ownedRepos(home, command[3]!).map((repo) => ({ nameWithOwner: repo, repositoryTopics: repoTopics(home, repo).length ? repoTopics(home, repo).map((name) => ({ name })) : null }))));
      if (line.startsWith("gh repo create ")) {
        const owner = command[3]!.split("/")[0]!;
        if (owner === options.createFails) return result(false, `GraphQL: you cannot create repos in ${owner}`);
        const bare = githubRepo(home, command[3]!);
        mkdirSync(bare, { recursive: true });
        const made = await realGit(home, ["init", "-q", "--bare", "-b", "main", bare]);
        return owner === options.createFailsAfterMaking ? result(false, "HTTP 502: Bad Gateway") : made;
      }
      if (command[0] === "git") return realGit(home, command.slice(1), run.cwd);
      return t3(command.map(quote).join(" "), pairingCodes.here, run.input, { name: "here", home, linked: Boolean(options.connectHere), tunnel: tunnels.here, sessions: hereSessions }) ?? result(false, `unexpected ${line}`);
    },
    start(command) {
      starts.push(command);
      const remote = onBox(command);
      const word = (remote ?? command.join(" ")).split(" ")[0];
      const name = word === "gh" ? "github" : word === "claude" ? "claude" : word === "codex" ? "chatgpt" : word === "t3" ? "t3" : "coder";
      const signIn = (remote === undefined ? name : `box:${name}`) as SignInName;
      started.add(signIn);
      if (word === "codex") codexSaved[signIn] = storeIn(remote ?? command.join(" ")) ?? configuredStore(signIn) ?? "auto";
      if (signIn === "chatgpt") codexCredential = undefined;
      const exit = options.exits?.[signIn];
      if (exit !== undefined) return { stop: () => {}, exited: Promise.resolve(exit) };
      let kill = () => {};
      return { stop: () => kill(), exited: new Promise<number>((resolve) => (kill = () => resolve(143))) };
    },
    async run(command, run = {}) {
      runs.push({ command, input: run.input ?? false });
      const remote = onBox(command);
      if ((remote ?? command.join(" ")) === "claude auth login") left[remote === undefined ? "claude" : "box:claude"] = 0;
      const node = command.at(-2)!;
      const { hub } = remote?.includes(" --profile ") ? await pushedProfile() : {};
      if (hub && hub !== node && !options.hubDown) credentials.push({ node, issued: hubTook.has(node) });
      if (options.failRun) return 1;
      if (options.node && remote?.startsWith("sh -c ")) return (await onNode(remote, node)).code;
      if (remote?.includes('-o "$installer"') && options.installerEnv) return (await forReal(remote, node, undefined, undefined, options.installerEnv)).code;
      if (remote?.includes('-o "$installer"') && options.installers) return (await forReal(remote, node, undefined, installerBin(home, options.installers))).code;
      if (command.join(" ") === "sh -c coder login") left.coder = 0;
      return 0;
    },
    async sleep(ms) {
      sleeps.push(ms);
      await passTime(ms);
      for (const name of started) if (left[name] > 0) left[name]--;
      if (started.has("chatgpt") && passes("chatgpt") && codexCredential === undefined) codexCredential = "replaced";
    },
    async openUrl(url) {
      opened.push(url);
    },
    has: () => true,
  };
  return { machine, clock, codexCredential: () => codexCredential, calls, starts, runs, sleeps, opened, coderTokens: () => [...tokenNames.keys()], coderArgv: () => (existsSync(coderArgv) ? readFileSync(coderArgv, "utf8") : ""), sessionModes: () => readLines(sessionModes), stuckSignIn: () => linesOnceThere(stuckSignIn, 2), stuckVersion: () => linesOnceThere(stuckVersion, 1), stuckRemoval: () => linesOnceThere(stuckRemoval, 1), removalTerms: () => readLines(removalTerms), signInAnnounced, passTime, openConnections: () => connections.filter((connection) => !connection.ended).length, hubUpdates, credentials, hubLinked, sessions: () => [...hereSessions, ...boxSessions], hereLinks: () => hereLinks, peerLinks };
}

const renewedUntil = "2099-01-01T00:00:00.000Z";

const sshLostExit = 255;

type CoderFails = { configSsh: boolean; login: "killed" | "stuck" | "announces" | undefined };

type CoderLogs = { argv: string; modes: string; stuck: string };

const signInStartedLine = "coder login: signing in";

const sshSetupMs = 5_000;

const hangs = "sleep 2147483647";

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

const readLines = (path: string) => readText(path).split("\n").filter(Boolean);

export const until = async (done: () => boolean) => {
  while (!done()) await Bun.sleep(1);
};

const linesOnceThere = async (path: string, count: number) => (await until(() => readLines(path).length >= count), readLines(path).map(Number));

export const processRunning = (pid: number) => !/^$|^\d+ \(.*\) Z /.test(readText(`/proc/${pid}/stat`));

const groupEnded = (group: number) => !existsSync("/proc") || readdirSync("/proc").every((entry) => {
  const stat = /^\d+$/.test(entry) ? readText(`/proc/${entry}/stat`) : "";
  const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return !stat || state === "Z" || pgrp !== String(group);
});

const killGroup = (group: number) => {
  try {
    process.kill(-group, "SIGKILL");
  } catch {}
};

const fakeProcesses: Array<() => Promise<void>> = [];

export const stopFakeProcesses = async () => void (await Promise.all(fakeProcesses.splice(0).map((stop) => stop())));

const fakeTimeout = (home: string, deadlines: string) => {
  const bin = join(home, "fake-timeout");
  mkdirSync(bin, { recursive: true });
  mkdirSync(deadlines, { recursive: true });
  const lines = [
    "#!/bin/sh",
    "sig=TERM grace=",
    'refuse() { echo "timeout: $1" >&2; exit 125; }',
    'while :; do case "$1" in',
    '  -s) [ "$2" = KILL ] || refuse "Hedge sends no signal but KILL, not $2"; sig=KILL; shift 2 ;;',
    '  -k) case "$2" in "" | *[!0-9]*) refuse "invalid time interval $2" ;; esac; grace=$2; shift 2 ;;',
    '  -*) refuse "unrecognized option $1" ;;',
    "  *) break ;;",
    "esac; done",
    'case "$1" in "" | *[!0-9]*) refuse "invalid time interval $1" ;; esac',
    "limit=$1; shift",
    '[ $# -gt 0 ] || refuse "missing operand"',
    '[ "$limit" -gt 0 ] && command -v setsid >/dev/null || exec "$@"',
    `at='${deadlines}'/$$`,
    `printf '%s %s\\n' "$limit" "\${grace:--}" > "$at.new" && mv "$at.new" "$at.armed"`,
    "fired=0",
    `trap 'fired=$((fired + 1)); if [ $fired$sig = 1TERM ]; then kill -s TERM -- -$child; echo TERM >> "$at.sent"; else kill -s KILL -- -$child; echo KILL >> "$at.sent"; kill -s KILL $$; fi' ALRM`,
    "exec 3<&0",
    'setsid "$@" <&3 3<&- &',
    "child=$!",
    "exec 3<&-",
    'echo "$child" > "$at.group"',
    'while :; do wait "$child"; s=$?; kill -0 "$child" 2>/dev/null || break; done',
    'rm -f "$at.armed" "$at.sent"',
    'kill -s 0 -- "-$child" 2>/dev/null || rm -f "$at.group"',
    '[ "$fired" = 0 ] || exit 124',
    'exit "$s"',
  ];
  writeFileSync(join(bin, "timeout"), `${lines.join("\n")}\n`, { mode: 0o755 });
  return bin;
};

const hereCoderBin = (home: string, names: string, removed: string, removal: "removes" | "fails" | "hangs", logs: { stuck: string; terms: string }) => {
  const bin = join(home, "here-coder");
  mkdirSync(bin, { recursive: true });
  const removes = {
    removes: `echo "$3" >> '${removed}'`,
    fails: 'echo "error: Coder did not answer" >&2; exit 1',
    hangs: [`trap '' TERM`, `${hangs} &`, `trap "echo TERM >> '${logs.terms}'" TERM`, `echo $$ >> '${logs.stuck}'`, 'while kill -0 "$!" 2>/dev/null; do wait "$!"; done'].join("\n"),
  }[removal];
  const lines = ["#!/bin/sh", '[ "$1 $2 $#" = "tokens remove 3" ] || { echo "coder: unexpected $*" >&2; exit 1; }', `grep -qxF -- "$3" '${names}' || { echo "error: no token named $3" >&2; exit 1; }`, removes];
  writeFileSync(join(bin, "coder"), `${lines.join("\n")}\n`, { mode: 0o755 });
  return bin;
};

export const coderSshConfig = (address: string, cli = "~/.local/bin/coder") => `# coder ${address}\n  ProxyCommand ${cli} ssh --stdio %h\n`;
const writeSshConfig = (boxHomeDir: string, address: string, cli: string) => (mkdirSync(join(boxHomeDir, ".ssh"), { recursive: true }), writeFileSync(join(boxHomeDir, ".ssh/config"), coderSshConfig(address, cli)));

const loginStart = (login: CoderFails["login"], logs: CoderLogs) => {
  if (login === "killed") return "kill -9 $$";
  if (login === "announces") return `echo '${signInStartedLine}'`;
  if (login !== "stuck") return ":";
  return ["trap '' TERM", `${hangs} & echo $! >> '${logs.stuck}'`, `echo $$ >> '${logs.stuck}'`, `exec ${hangs}`].join("\n  ");
};

const asCopy = (then: string) => `case $0 in "$HOME"/.local/bin/.coder.*) [ -e "$HOME/.local/bin/coder" ] || { ${then}; } ;; esac`;
const personInstallsCoder = asCopy(`printf %s ${quote(ownCoder)} > "$HOME/.local/bin/coder"; chmod +x "$HOME/.local/bin/coder"`);
const personMakesFolder = asCopy('mkdir "$HOME/.local/bin/coder"');

const stallsAsCopy = (stuck: string) => `case $0 in "$HOME"/.local/bin/.coder.*) echo $$ >> '${stuck}'; exec ${hangs} ;; esac`;

const downloadedCoder = (reach: string, serverTokens: string, fails: CoderFails, logs: CoderLogs, onVersion = ":") => `#!/bin/sh
printf '%s\\n' "$*" >> '${logs.argv}'
d="\${CODER_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/coderv2}"
valid() { case "$1" in ${personCoderToken} | person-login | coder-made-session) return 0 ;; esac; grep -qxF -- "$1" '${serverTokens}'; }
case "$1" in
version) ${onVersion} ;;
login)
  shift; u=; own=
  ${loginStart(fails.login, logs)}
  for a; do case "$a" in --use-token-as-session) own=1 ;; --token=*) CODER_SESSION_TOKEN=\${a#--token=} ;; -*) echo "error: unknown flag $a" >&2; exit 2 ;; *) u=$a ;; esac; done
  [ "$u" = '${reach}' ] || { echo "error: dial $u: connection timed out" >&2; exit 1; }
  t=\${CODER_SESSION_TOKEN:-person-login}
  valid "$t" || { echo "error: get user: unauthorized" >&2; exit 1; }
  [ -z "$CODER_SESSION_TOKEN" ] || [ -n "$own" ] || t=coder-made-session
  umask 077 && mkdir -p "$d" && printf %s "$t" > "$d/session" && ls -ln "$d/session" | cut -c1-10 >> '${logs.modes}' && printf %s "$u" > "$d/url" ;;
config-ssh)
  t=\${CODER_SESSION_TOKEN:-$(cat "$d/session" 2>/dev/null)}
  valid "$t" || { echo "You are not logged in" >&2; exit 1; }
  ${fails.configSsh ? 'echo "error: could not write ~/.ssh/config" >&2; exit 1' : ":"}
  case $0 in "$HOME"/*) cli="~/\${0#"$HOME"/}" ;; *) cli=$0 ;; esac
  mkdir -p "$HOME/.ssh" && printf '# coder %s\\n  ProxyCommand %s ssh --stdio %%h\\n' "\${CODER_URL:-$(cat "$d/url")}" "$cli" > "$HOME/.ssh/config" ;;
*) exit 1 ;;
esac
`;

function coderNetwork(home: string, reach: string, redirects: Array<"probe" | "binary">, cli: "non-200" | "empty" | "broken" | undefined, serverTokens: string, fails: CoderFails, logs: CoderLogs) {
  const bin = dirname(servedCoderPath(home));
  mkdirSync(bin, { recursive: true });
  writeFileSync(servedCoderPath(home), cli === "empty" ? "" : cli === "broken" ? "#!/bin/sh\nexit 1\n" : downloadedCoder(reach, serverTokens, fails, logs), { mode: 0o755 });
  const lines = [
    "#!/bin/sh",
    `out=; url=; prev=; https=; w=; hops=; follow=`,
    `[ "$1" = -q ] || ! grep -qx location "$HOME/.curlrc" 2>/dev/null || follow=1`,
    `for a; do case "$prev" in -o) out=$a ;; -w) w=$a ;; --max-redirs) hops=$a ;; --proto) [ "$a" != =https ] || https=1 ;; *) case "$a" in -L | --location) follow=1 ;; -*) ;; *) url=$a ;; esac ;; esac; prev=$a; done`,
    `case "$url" in https://*) ;; *) [ -z "$https" ] || { echo "curl: (1) Protocol \"\${url%%:*}\" disabled" >&2; exit 1; } ;; esac`,
    `moved=; case "$url" in '${reach}'/api/v2/buildinfo) moved=${redirects.includes("probe") ? 1 : ""} ;; '${reach}'/bin/coder-linux-*) moved=${redirects.includes("binary") ? 1 : ""} ;; esac`,
    `[ -z "$moved" ] || [ -n "$follow" ] || { [ -z "$out" ] || : > "$out"; [ -z "$w" ] || printf 302; exit 0; }`,
    `[ -z "$moved" ] || [ "$hops" != 0 ] || { echo "curl: (47) Maximum (0) redirects followed" >&2; exit 47; }`,
    `case "$url" in '${reach}'/bin/coder-linux-*) cp '${join(bin, "coder-cli")}' "$out"; [ -z "$w" ] || printf ${cli === "non-200" ? 203 : 200}; exit 0 ;; '${reach}'/api/v2/buildinfo) [ -z "$w" ] || printf 200; exit 0 ;; esac`,
    `echo "curl: (28) Failed to connect to $url: Connection timed out" >&2`,
    "exit 28",
  ];
  writeFileSync(join(bin, "curl"), `${lines.join("\n")}\n`, { mode: 0o755 });
  return bin;
}

export type Node = { engineAt?: string; installs?: string; installFails?: boolean; olderEngine?: boolean; stepsFail?: boolean; oldSystemd?: boolean; allowlist?: boolean; signedOut?: boolean };

const thisCommit = () => Bun.spawnSync(["git", "-C", engineRoot, "rev-parse", "HEAD"]).stdout.toString().trim();

const nodeState = (home: string, host: string) => join(boxHome(home, host), ".node");

export const nodeHas = (home: string, host: string, state: string) => existsSync(join(nodeState(home, host), state));

export const nodeEngine = (home: string, host: string) => {
  const read = (name: string) => (existsSync(join(nodeState(home, host), name)) ? readFileSync(join(nodeState(home, host), name), "utf8").trim() : "");
  return { commit: read("engine-commit"), launcher: existsSync(join(boxHome(home, host), ".local/bin/hedge")) ? readFileSync(join(boxHome(home, host), ".local/bin/hedge"), "utf8") : "", runs: Bun.spawnSync(["sh", join(boxHome(home, host), ".local/bin/hedge"), "help"], { env: { ...process.env, HOME: boxHome(home, host) }, stdout: "ignore", stderr: "ignore" }).exitCode === 0 };
};

function prepareNode(home: string, host: string, node: Node) {
  const box = boxHome(home, host);
  const state = nodeState(home, host);
  mkdirSync(state, { recursive: true });
  const flag = (name: string, on: boolean | undefined) => (on ? writeFileSync(join(state, name), "") : rmSync(join(state, name), { force: true }));
  flag("older-engine", node.olderEngine);
  flag("install-fails", node.installFails);
  flag("steps-fail", node.stepsFail);
  flag("old-systemd", node.oldSystemd);
  flag("signed-out", node.signedOut);
  if (node.allowlist) writeFileSync(join(state, "allowlist"), "");
  writeFileSync(join(state, "installs-commit"), `${node.installs ?? thisCommit()}\n`);
  if (node.engineAt) {
    writeFileSync(join(state, "engine-commit"), `${node.engineAt}\n`);
    mkdirSync(join(box, ".local/bin"), { recursive: true });
    writeFileSync(join(box, ".local/bin/hedge"), nodeLauncher, { mode: 0o755 });
  }
}

export const nodeLauncher = `#!/bin/sh\n# Hedge\nexec sh "$HOME/.local/share/hedge/engine/hedge" "$@"\n`;

function nodeBin(home: string, host: string) {
  const box = boxHome(home, host);
  const bin = join(box, ".node/bin");
  const engine = join(box, ".local/share/hedge/engine");
  mkdirSync(bin, { recursive: true });
  mkdirSync(engine, { recursive: true });
  const write = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\nstate="$HOME/.node"\n${body}\n`, { mode: 0o755 });
  const git = Bun.which("git")!;
  write(join(bin, "sudo"), `[ "$1" != -n ] || shift\ncase "$*" in *guards/earlyoom.sh) touch "$state/earlyoom"; exit 0 ;; esac\nSUDO_USER=$(id -un) exec "$@"`);
  write(join(bin, "git"), `[ "$1 $3 $4" = "-C rev-parse HEAD" ] && [ "$2" = "${engine}" ] && { cat "$state/engine-commit" 2>/dev/null; exit; }\nexec ${git} "$@"`);
  write(join(bin, "gh"), `[ "$1 $2" = "repo clone" ] && exec ${git} clone -q "${join(home, "github-remotes")}/\${3#https://github.com/}" "$4"`);
  write(join(bin, "ssh"), `echo "ssh: connect to host $1: Connection refused" >&2\nexit 255`);
  write(join(bin, "curl"), `out=; for a; do [ "$prev" = -o ] && out=$a; prev=$a; done\ncp "${join(engine, "get.sh")}" "$out"`);
  write(join(engine, "hedge"), `[ ! -f "$state/packages-missing" ] || { echo "error: Cannot find package 'smol-toml'" >&2; exit 1; }\nexec ${process.execPath} ${join(import.meta.dir, "fixtures/node-engine.ts")} "$@"`);
  write(join(engine, "get.sh"), `engine="$HOME/.local/share/hedge/engine"\ncat "$state/installs-commit" > "$state/engine-commit"\n[ ! -f "$state/install-fails" ] || { touch "$state/packages-missing"; echo "Hedge: could not install the engine's packages in $engine." >&2; exit 1; }\nrm -f "$state/packages-missing"\nrm -rf "$engine/node_modules" && mkdir -p "$engine/node_modules" && touch "$engine/node_modules/.installed"\nmkdir -p "$HOME/.local/bin" && printf '%s' '${nodeLauncher}' > "$HOME/.local/bin/hedge" && chmod 755 "$HOME/.local/bin/hedge"\ncase " $* " in *" --install-only "*) exit 0 ;; esac\nwhile [ "$1" != --profile ]; do shift; done\nexec sh "$engine/hedge" apply "$@"`);
  return bin;
}

function installerBin(home: string, installers: Record<string, string>) {
  const bin = join(home, "box-installers");
  mkdirSync(bin, { recursive: true });
  for (const [ref, script] of Object.entries(installers)) writeFileSync(join(bin, `${ref}.sh`), script);
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nout=; url=\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -*) ;; *) url=$1 ;; esac; shift; done\nref=\${url%/get.sh}; ref=\${ref##*/}\ncp "${bin}/$ref.sh" "$out"\n`, { mode: 0o755 });
  return bin;
}

export const throughSsh = (home: string, host: string, printed: string, env: Record<string, string> = {}) => {
  const local = join(home, "fake-ssh");
  mkdirSync(local, { recursive: true });
  const onHost = [`HOME=${quote(boxHome(home, host))}`, `PATH=${quote(`${join(boxHome(home, host), ".node/bin")}:/usr/bin:/bin`)}`, ...Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`)].join(" ");
  writeFileSync(join(local, "ssh"), `#!/bin/sh\n[ "$1" != -t ] || shift\n[ "$1" = ${host} ] || exit 255\nshift\nexec env ${onHost} sh -c "$*"\n`, { mode: 0o755 });
  writeFileSync(join(local, "sudo"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  return Bun.spawnSync(["sh", "-c", printed], { env: { HOME: home, PATH: `${local}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "ignore", stderr: "ignore" }).exitCode;
};

export const remote = (box: ReturnType<typeof fakeMachine>) => [...box.calls.map((call) => onBox(call.command)), ...box.starts.map(onBox), ...box.runs.map((run) => onBox(run.command))].filter(Boolean) as string[];

export async function hedgeSetup(home: string, args: string[], replies: string[] = [], box = fakeMachine(home), fetchSource?: (ref: SourceRef, cache: string) => Promise<FetchedSource>, doctorCode = 0, platform: NodeJS.Platform = "linux", onApply: (dir: string) => void | Promise<void> = () => {}) {
  const io = scripted(replies);
  const applied: string[] = [];
  const skipped: string[][] = [];
  const doctored: string[] = [];
  const apply = async (dir: string, skip: string[] = []) => (applied.push(dir), skipped.push(skip), await onApply(dir), 0);
  const doctor = async (dir: string) => (doctored.push(dir), doctorCode);
  const code = await main(["setup", ...args], { home, engineRoot, platform, print: io.terminal.print, terminal: io.terminal, apply, setup: { machine: box.machine, clock: box.clock, doctor, env: {}, timeZone: "UTC", ...(fetchSource ? { fetchSource } : {}) } });
  return { code, prompts: io.prompts, output: io.output(), applied, skipped, doctored };
}

export async function setUpToAdd(home: string, host: string, setupArgs: string[] = []) {
  const setUp = await hedgeSetup(home, ["--preset", "starter", "--plan", "claude", ...setupArgs], ["", ""]);
  if (setUp.code !== 0) throw new Error(setUp.output);
  const io = scripted([]);
  const add = (box: ReturnType<typeof fakeMachine>) => main(["devbox", "add", host], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
  return { io, add };
}

export const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/hedge/machine.json"), "utf8"));

/** The answers in the profile clone on this machine. */
export const savedAnswers = (home: string) => JSON.parse(readFileSync(join(profilePath(home), "hedge.json"), "utf8"));

/** The answers as pushed to the fake github.com. */
export async function pushedAnswers(home: string, repo = "nora/nora-hedge") {
  return JSON.parse((await realGit(home, ["--git-dir", githubRepo(home, repo), "show", "main:hedge.json"])).output);
}

export async function changeOnFirstCommit(home: string, elsewhere: string, change: string) {
  await spawnGit(home, "clone", "-q", githubRepo(home, "nora/nora-hedge"), elsewhere);
  const publish = join(elsewhere, "..", "publish.ts");
  writeFileSync(publish, `const [file, value] = process.argv.slice(2);\nconst profile = await Bun.file(file).json();\n${change}\nawait Bun.write(file, JSON.stringify(profile, null, 2) + "\\n");\n`);
  const changeElsewhere = (value: string) => `'${process.execPath}' '${publish}' hedge.json ${value}`;
  const marker = join(elsewhere, "..", "published");
  const hook = `#!/bin/sh\n[ -e '${marker}' ] && exit 0\ntouch '${marker}'\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX\ncd '${elsewhere}' && git pull -q && ${changeElsewhere("after")} && git commit -q -am 'Change the profile on another machine' && git push -q\n`;
  writeFileSync(join(profilePath(home), ".git/hooks/post-commit"), hook, { mode: 0o755 });
}
