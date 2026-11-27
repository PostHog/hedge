import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { boxHome, coderSshConfig, coderToken, engineRoot, fakeMachine, hedgeSetup, machineFile, personCoderToken, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("hedge devbox add", () => {
  const addNode2 = async (home: string, box: ReturnType<typeof fakeMachine>) => {
    const io = scripted([]);
    const code = await main(["devbox", "add", "node-2"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
    return { code, output: io.output() };
  };

  test("hedge devbox add refuses a profile that pins an engine from before the rename, and installs nothing on the box", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const answers = join(machineFile(home).profileDir, "hedge.json");
    const profile = JSON.parse(readFileSync(answers, "utf8"));
    writeFileSync(answers, JSON.stringify({ ...profile, engine: { ...profile.engine, ref: "v0.0.9", channel: "release" } }));
    git(machineFile(home).profileDir, "commit", "-q", "-am", "pin the engine from before the rename");
    const box = fakeMachine(home, {}, { installers: { "v0.0.9": 'mkdir -p "$HOME/.local/share/fleet/engine" && echo installed > "$HOME/.local/share/fleet/engine/get.sh"\n' } });

    const result = await addNode2(home, box);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Your profile pins the engine at v0.0.9, from before Fleet became Hedge, so Hedge does not install it on node-2.");
    expect(existsSync(join(boxHome(home, "node-2"), ".local/share/fleet"))).toBe(false);
  });

  test("hedge devbox add refuses a box whose ~/.config/hedge leads into Fleet's folder, and leaves Fleet's machine file as it was", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const config = join(boxHome(home, "node-2"), ".config");
    mkdirSync(join(config, "fleet"), { recursive: true });
    writeFileSync(join(config, "fleet/machine.json"), '{"schema":1,"role":"devbox"}\n');
    symlinkSync(join(config, "fleet"), join(config, "hedge"));

    const result = await addNode2(home, fakeMachine(home));

    expect(result.code).toBe(1);
    expect(result.output).toContain("~/.config/hedge or its machine.json on node-2 is a link, so Hedge does not write through it.");
    expect(readFileSync(join(config, "fleet/machine.json"), "utf8")).toBe('{"schema":1,"role":"devbox"}\n');
  });

  test("hedge devbox add makes a host a devbox later, and a failed install stops with what to do", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const failing = fakeMachine(home, {}, { failRun: true });
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: failing.machine } })).toBe(1);
    expect(io.output()).toContain("hedge: Hedge did not install on the devbox. Fix what it says above, then run hedge devbox add node-2 again.");

    const box = fakeMachine(home);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toEndWith("node-2 is your devbox now. It runs your profile, and T3 Code here and there can reach each other.");
    expect(machineFile(home).devboxes).toEqual(["node-2"]);
    expect(machineFile(home).setup.done).toContain("devbox:node-2:link");

    expect(await main(["devbox"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("Your devboxes: node-2");
    expect(await main(["devbox", "drop", "node-2"], options)).toBe(2);
    expect(await main(["devbox", "add", "-oProxyCommand=x"], options)).toBe(2);
    expect((await hedgeSetup(temp.make("home-"), ["--devbox", "-oProxyCommand=x"])).output).toStartWith("hedge setup: --devbox takes an SSH host");
  });

  test("when this machine has no tunnel address for the node to link back to, hedge devbox add fails and links back once run again after the address is there", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const hub: { connectHere: boolean; serverWithoutLinkState: Array<"box" | "here"> } = { connectHere: true, serverWithoutLinkState: ["here"] };
    const box = fakeMachine(home, {}, hub);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain("Hedge could not find this machine's tunnel address. Update T3 Code here, then run hedge devbox add node-2 again so node-2 links back.");
    expect(box.peerLinks.box).toEqual([]);

    hub.serverWithoutLinkState = [];
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(box.peerLinks.box).toEqual(["https://here.relay.example"]);
    expect(box.peerLinks.here).toEqual(["https://box-1.relay.example"]);
  });

  test("when t3 connect status fails here, hedge devbox add fails without taking T3 Connect as off, and links back once run again", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, {}, { connectHere: true, hereStatusFailures: 1 });
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain("T3 Code here did not answer t3 connect status. Check that T3 Code runs here, then run hedge devbox add node-2 again.");
    expect(io.output()).not.toContain("T3 Connect is off here");
    expect(box.peerLinks.box).toEqual([]);

    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(box.peerLinks.box).toEqual(["https://here.relay.example"]);
    expect(box.peerLinks.here).toEqual(["https://box-1.relay.example"]);
  });

  test.each([
    ["linked without credentials", { authenticated: false, linked: true }],
    ["no linked field", { authenticated: true }],
    ["T3 Connect is on but not linked yet", { desired: true, authenticated: true, linked: false }],
  ])("when t3 connect status here says %s, hedge devbox add fails without taking T3 Connect as off, and links back once run again", async (_, hereConnect) => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const hub: { connectHere: boolean; hereConnect?: typeof hereConnect } = { connectHere: true, hereConnect };
    const box = fakeMachine(home, {}, hub);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain("T3 Connect here is not ready");
    expect(io.output()).toContain("run t3 up --connect here, then run hedge devbox add node-2 again.");
    expect(io.output()).not.toContain("T3 Connect is off here");
    expect(box.peerLinks.box).toEqual([]);

    delete hub.hereConnect;
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(box.peerLinks.box).toEqual(["https://here.relay.example"]);
  });

  const linkedButNotDesired = { desired: false, authenticated: true, linked: true };

  test("a hub that is linked with a live tunnel while t3 connect status says desired false still counts as on: hedge devbox add links the node back", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const box = fakeMachine(home, {}, { connectHere: true, hereConnect: linkedButNotDesired });
    expect(await main(["devbox", "add", "node-2"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).not.toContain("T3 Connect is off here");
    expect(box.peerLinks.box).toEqual(["https://here.relay.example"]);
  });

  test("a machine that is linked with a live tunnel while t3 connect status says desired false prints its address with hedge devbox address", async () => {
    const home = temp.make("home-");
    const io = scripted([]);
    const box = fakeMachine(home, {}, { connectHere: true, hereConnect: linkedButNotDesired });
    const code = await main(["devbox", "address"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
    expect([code, io.output()]).toEqual([0, "https://here.relay.example"]);
  });

  test("hedge devbox address prints this machine's T3 Connect address from its live T3 server when the T3 CLI does not print it, and says when there is none", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const address = async (box: ReturnType<typeof fakeMachine>) => {
      const io = scripted([]);
      const code = await main(["devbox", "address"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
      return [code, io.output()];
    };
    expect(await address(fakeMachine(home, {}, { connectHere: true }))).toEqual([0, "https://here.relay.example"]);
    expect(await address(fakeMachine(home, {}, { connectHere: true, hereTunnelStartsAfter: 3 }))).toEqual([0, "https://here.relay.example"]);
    expect(await address(fakeMachine(home))).toEqual([1, "hedge: T3 Connect is off on this machine. Turn it on with t3 up --connect."]);
    const without = fakeMachine(home, {}, { connectHere: true, serverWithoutLinkState: ["here"] });
    expect(await address(without)).toEqual([1, "hedge: T3 Connect is on here, but T3 Code gives no tunnel address for this machine yet."]);
  });

  test("hedge devbox address prints this machine's T3 Connect address when this machine has no Hedge profile", async () => {
    const home = temp.make("home-");
    const io = scripted([]);
    const code = await main(["devbox", "address"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: fakeMachine(home, {}, { connectHere: true }).machine } });
    expect([code, io.output()]).toEqual([0, "https://here.relay.example"]);
  });

  test("when ChatGPT's sign-in fails on a node, hedge devbox add says to run hedge devbox add for that node again, not hedge setup", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "codex"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, { "box:chatgpt": 99 }, { exits: { "box:chatgpt": 1 } });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: box.machine } })).toBe(1);
    expect(io.output()).toContain(`codex login -c cli_auth_credentials_store="file" --device-auth ended with code 1, but Sign in to ChatGPT on coder.hedge-node-1 still does not pass its check. Fix what it says above, then run hedge devbox add coder.hedge-node-1 again.`);
    expect(io.output()).toContain("and open the link it prints. Then run hedge devbox add coder.hedge-node-1 again.");
    expect(io.output()).not.toContain("hedge setup again");
  });

  test("when a node's ChatGPT check fails after its sign-in ended, hedge devbox add keeps that sign-in and says to run hedge devbox add for that node again", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "codex"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const box = fakeMachine(home, { "box:chatgpt": 1 }, { exits: { "box:chatgpt": 0 }, boxCodexAfterSignIn: "ERROR: You hit your spend cap.\n" });
    await main(["devbox", "add", "coder.hedge-node-1"], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine } });
    expect(io.output()).toContain("Codex is signed in, but its test request failed: You hit your spend cap. Setup keeps that sign-in and starts no new one. To replace it, run codex logout first. Fix that, then run hedge devbox add coder.hedge-node-1 again.");
    expect(io.output()).not.toContain("hedge setup again");
  });

  test("hedge devbox add signs a Coder workspace in to Coder and writes its SSH config, so it reaches the hub and the other nodes by their coder. names", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("  ✓ Sign in to Coder on coder.hedge-node-1: done");
    const sshConfig = (host: string) => readFileSync(join(boxHome(home, host), ".ssh/config"), "utf8");
    expect(sshConfig("coder.hedge-node-1")).toBe(coderSshConfig("https://coder.example.com"));
    const coderFile = (name: string) => join(boxHome(home, "coder.hedge-node-1"), ".config/coderv2", name);
    expect([readFileSync(coderFile("url"), "utf8"), readFileSync(coderFile("session"), "utf8")]).toEqual(["https://coder.example.com", coderToken]);
    expect([statSync(coderFile("url")).mode & 0o777, statSync(coderFile("session")).mode & 0o777]).toEqual([0o600, 0o600]);
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(coderToken);
    expect(io.output()).not.toContain(coderToken);

    const again = fakeMachine(home);
    expect(await main(["devbox", "add", "coder.hedge-node-2"], { ...options, setup: { machine: again.machine } })).toBe(0);
    expect(again.coderTokens()).toEqual([]);
    expect(sshConfig("coder.hedge-node-2")).toBe(coderSshConfig("https://coder.example.com"));
  });

  test("hedge devbox add again signs the workspace in anew when its Coder session has expired", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: fakeMachine(home, { "box:coder": 1 }).machine } })).toBe(0);
    const expired = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: expired.machine } })).toBe(0);
    expect([expired.coderTokens().length, readFileSync(join(boxHome(home, "coder.hedge-node-1"), ".ssh/config"), "utf8")]).toEqual([1, coderSshConfig("https://coder.example.com")]);
  });

  test("hedge devbox add keeps a workspace's Coder session when it reaches the same deployment at another address", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const config = join(boxHome(home, "coder.hedge-node-1"), ".config/coderv2");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "url"), "http://coder.internal");
    writeFileSync(join(config, "session"), personCoderToken);
    const internal = fakeMachine(home, {}, { boxCoderSameUser: true });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: internal.machine } })).toBe(0);
    expect(readFileSync(join(boxHome(home, "coder.hedge-node-1"), ".ssh/config"), "utf8")).toBe(coderSshConfig("http://coder.internal"));
    expect(internal.coderTokens()).toEqual([]);
  });

  test("hedge devbox add stops with what to run when this machine is not signed in to Coder, and leaves other SSH hosts alone", async () => {
    const home = temp.make("home-");
    expect((await hedgeSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const signedOut = fakeMachine(home, { coder: 1, "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.hedge-node-1"], { ...options, setup: { machine: signedOut.machine } })).toBe(1);
    expect(io.output()).toContain("Coder is not signed in on this machine. Run coder login <your Coder address> here, then hedge devbox add coder.hedge-node-1 again.");

    const plain = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: plain.machine } })).toBe(0);
    expect(existsSync(join(boxHome(home, "node-2"), ".ssh/config"))).toBe(false);
    expect(io.output()).not.toContain("Sign in to Coder on node-2");
  });
});
