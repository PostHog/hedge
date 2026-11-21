import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileFile } from "../pack/types.ts";
import { defaultSources } from "../setup/defaults.ts";
import { isolateGit, spawnGit, template, tempDirs } from "../testing/git.ts";
import { loadMachine, loadProfile, picksTurnOn, ProfileError, saveAnswers, saveMachine, thisMachine } from "./profile.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const profile: ProfileFile = {
  schema: 1,
  engine: { repo: "PostHog/hedge", ref: "v0.1.0", channel: "release" },
  sources: [],
  packs: ["orchestration"],
  plan: "both",
  settings: {},
  workflows: {},
};

const profileRepos = new Map<string, (target: string) => Promise<string>>();

function profileRepo(file: unknown = profile) {
  const text = JSON.stringify(file, null, 2) + "\n";
  const built = profileRepos.get(text) ?? template(async (dir) => {
    await spawnGit(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "hedge.json"), text);
    await spawnGit(dir, "add", ".");
    await spawnGit(dir, "commit", "-q", "-m", "Start");
  });
  profileRepos.set(text, built);
  return built(temp.make("profile-"));
}

describe("profile", () => {
  test("rejects a schema it does not know", async () => {
    const dir = await profileRepo({ ...profile, schema: 3 });
    expect(loadProfile(dir)).rejects.toThrow(new ProfileError(`${join(dir, "hedge.json")}: unknown schema 3`));
  });

  test("loads about-me.md when it exists", async () => {
    const dir = await profileRepo();
    writeFileSync(join(dir, "about-me.md"), "I like small PRs.\n");
    expect((await loadProfile(dir)).aboutMe).toBe("I like small PRs.\n");
  });

  test("keeps answers it was not given", async () => {
    const dir = await profileRepo({ ...profile, settings: { "orchestration.tracker": "me/hedge-profile" } });
    await saveAnswers(dir, { plan: "claude" });
    const saved = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"));
    expect(saved).toMatchObject({ plan: "claude", settings: { "orchestration.tracker": "me/hedge-profile" } });
  });
});

describe("a source pinned by an older engine default", () => {
  const retired = { name: "agent-skills", repo: "Silthus/agent-skills", ref: "997eb88e03cb322941f387ab577207335d77c414" };
  const current = defaultSources.find((source) => source.name === "agent-skills")!;

  test("follows the current default pin", async () => {
    const dir = await profileRepo({ ...profile, sources: [retired] });
    expect((await loadProfile(dir)).sources).toEqual([current]);
  });

  test("keeps a pin the person chose, and a source of the same name from another repo", async () => {
    const chosen = { ...retired, ref: "main" };
    const fork = { ...retired, repo: "someone/agent-skills" };
    expect((await loadProfile(await profileRepo({ ...profile, sources: [chosen] }))).sources).toEqual([chosen]);
    expect((await loadProfile(await profileRepo({ ...profile, sources: [fork] }))).sources).toEqual([fork]);
  });
});

describe("a pick that turns its main workflow on", () => {
  const older = { ...profile, packs: ["slack", "guards", "memory", "incident-io"], workflows: { "shell-guards": true } };

  test("leaves that workflow off in an older profile that never set it, writes that once at the next save, and then keeps the person's choice", async () => {
    const dir = await profileRepo(older);
    const kept = { "shell-guards": true, "slack-thread": false, "page-owner": false, "context-library": false, "package-age": false };
    expect(await loadProfile(dir)).toMatchObject({ workflows: kept, migrations: [picksTurnOn] });
    expect(JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"))).toEqual(older);
    await saveAnswers(dir, { plan: "claude" });
    expect(JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"))).toMatchObject({ plan: "claude", workflows: kept, migrations: [picksTurnOn] });
    await saveAnswers(dir, { workflows: { ...kept, "slack-thread": true } });
    expect((await loadProfile(dir)).workflows).toEqual({ ...kept, "slack-thread": true });
  });

  test("leaves a workflow the profile already set, and a pack it does not list, as they are", async () => {
    const dir = await profileRepo({ ...profile, packs: ["slack"], workflows: { "slack-thread": true } });
    expect((await loadProfile(dir)).workflows).toEqual({ "slack-thread": true });
  });

  test("turns a workflow that moved to another pack off once, when the profile does not list the pack it came from", async () => {
    const moved = { ...profile, packs: ["pull-requests", "hub", "memory"], workflows: { "quality-loop": true, "pr-digest": true, "provider-recovery": true, "context-library": true } };
    expect((await loadProfile(await profileRepo(moved))).workflows).toEqual({ "quality-loop": false, "pr-digest": false, "provider-recovery": false, "context-library": false });
    const listed = { ...moved, packs: ["pull-requests", "orchestration", "hub", "recovery", "memory", "context-library"] };
    expect((await loadProfile(await profileRepo(listed))).workflows).toEqual(listed.workflows);
  });

  test("keeps every choice when the base engine saves the profile in between, which drops off values and keeps the migration mark", async () => {
    const dir = temp.make("profile-");
    await spawnGit(dir, "init", "-q", "-b", "main");
    await saveAnswers(dir, { ...profile, packs: ["slack", "guards"] });
    await saveAnswers(dir, { workflows: { ...(await loadProfile(dir)).workflows, "shell-guards": false } });
    const file = JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8"));
    const baseSave = { ...file, packs: [...file.packs, "incident-io"], workflows: Object.fromEntries(Object.entries(file.workflows).filter(([, on]) => on)) };
    writeFileSync(join(dir, "hedge.json"), JSON.stringify(baseSave, null, 2) + "\n");
    expect((await loadProfile(dir)).workflows).toEqual({ "slack-thread": true, "shell-guards": false, "package-age": true, "page-owner": false });
    await saveAnswers(dir, { workflows: { ...(await loadProfile(dir)).workflows, "page-owner": true } });
    expect(JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")).workflows).toEqual({ "slack-thread": true, "shell-guards": false, "package-age": true, "page-owner": true });
  });

  test("leaves a damaged profile for the check to refuse", async () => {
    expect(loadProfile(await profileRepo({ ...profile, packs: ["guards"], workflows: [] }))).rejects.toThrow("workflows must map ids to true or false");
    expect(loadProfile(await profileRepo({ ...profile, packs: ["guards"], migrations: "picks-turn-on" }))).rejects.toThrow("migrations must list names");
  });

  test("turns the workflow on in a profile that a new setup starts", async () => {
    const dir = temp.make("profile-");
    await spawnGit(dir, "init", "-q", "-b", "main");
    await saveAnswers(dir, { ...profile, packs: ["slack", "guards"] });
    expect(await loadProfile(dir)).toMatchObject({ packs: ["slack", "guards"], workflows: { "slack-thread": true, "shell-guards": true, "package-age": true }, migrations: [picksTurnOn] });
  });

  test("turns the workflow on in a profile whose first save names packs and no workflows", async () => {
    const dir = temp.make("profile-");
    await spawnGit(dir, "init", "-q", "-b", "main");
    await saveAnswers(dir, { schema: 1, engine: profile.engine, sources: [], packs: ["slack", "guards"], plan: "both", settings: {} });
    expect(await loadProfile(dir)).toMatchObject({ packs: ["slack", "guards"], workflows: { "slack-thread": true, "shell-guards": true, "package-age": true }, migrations: [picksTurnOn] });
  });
});

describe("saving answers", () => {
  test("commits only hedge.json and leaves other staged files staged", async () => {
    const dir = await profileRepo();
    writeFileSync(join(dir, "notes.txt"), "private\n");
    await spawnGit(dir, "add", "notes.txt");
    await saveAnswers(dir, { plan: "claude" });
    expect(await spawnGit(dir, "show", "--name-only", "--format=", "HEAD")).toBe("hedge.json");
    expect(await spawnGit(dir, "diff", "--cached", "--name-only")).toBe("notes.txt");
  });

  test("merges settings key by key", async () => {
    const dir = await profileRepo({ ...profile, settings: { "team.one": 1, "team.two": 2 } });
    await saveAnswers(dir, { settings: { "team.one": 3 } });
    expect((await loadProfile(dir)).settings).toEqual({ "team.one": 3, "team.two": 2 });
  });

  test("refuses to rewrite a profile of an unknown schema", async () => {
    const dir = await profileRepo({ ...profile, schema: 9 });
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("unknown schema 9");
    expect(JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")).schema).toBe(9);
  });

  test("fails when Git cannot stage hedge.json", async () => {
    const dir = await profileRepo();
    await spawnGit(dir, "rm", "-q", "--cached", "hedge.json");
    writeFileSync(join(dir, ".gitignore"), "hedge.json\n");
    await spawnGit(dir, "add", ".gitignore");
    await spawnGit(dir, "commit", "-q", "-m", "Ignore");
    expect(saveAnswers(dir, { plan: "claude" })).rejects.toThrow("could not stage hedge.json");
  });

  test("pushes when asked, even when nothing changed", async () => {
    const remote = temp.make("remote-");
    await spawnGit(remote, "init", "-q", "--bare", "-b", "main");
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", remote);
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
    await saveAnswers(dir, { plan: "claude" });
    await saveAnswers(dir, { plan: "claude" }, { push: true });
    expect(await spawnGit(remote, "rev-parse", "main")).toBe(await spawnGit(dir, "rev-parse", "HEAD"));
  });

  async function profileBehind() {
    const remote = temp.make("remote-");
    await spawnGit(remote, "init", "-q", "--bare", "-b", "main");
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", remote);
    await spawnGit(dir, "push", "-q", "-u", "origin", "main");
    const other = temp.make("other-");
    await spawnGit(other, "clone", "-q", remote, ".");
    const elsewhere = async (change: (file: Record<string, unknown>) => Record<string, unknown>) => {
      const file = JSON.parse(readFileSync(join(other, "hedge.json"), "utf8"));
      writeFileSync(join(other, "hedge.json"), JSON.stringify(change(file), null, 2) + "\n");
      await spawnGit(other, "commit", "-q", "-am", "Elsewhere");
      await spawnGit(other, "push", "-q");
    };
    return { dir, remote, elsewhere };
  }

  test("takes what another machine pushed before it saves, so a change here keeps the hub named on the hub", async () => {
    const { dir, remote, elsewhere } = await profileBehind();
    await elsewhere((file) => ({ ...file, hub: "coder.hedge-hub" }));
    await saveAnswers(dir, { packs: ["hub"] }, { push: true });
    expect(JSON.parse(await spawnGit(remote, "show", "main:hedge.json"))).toMatchObject({ hub: "coder.hedge-hub", packs: ["hub"] });
    expect(await spawnGit(remote, "rev-parse", "main")).toBe(await spawnGit(dir, "rev-parse", "HEAD"));
  });

  test("a change computed before another machine pushed the same answer refuses to replace it, and says to run the command again", async () => {
    const { dir, remote, elsewhere } = await profileBehind();
    const loaded = await loadProfile(dir);
    await elsewhere((file) => ({ ...file, packs: [...(file.packs as string[]), "memory"] }));
    const error = await saveAnswers(dir, { packs: [...loaded.packs, "hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe(`${dir}: another machine changed packs in your profile while this command ran. Run the command again to change them on top of that.`);
    expect(JSON.parse(await spawnGit(remote, "show", "main:hedge.json")).packs).toEqual(["orchestration", "memory"]);
    expect(await spawnGit(dir, "status", "--porcelain")).toBe("");
  });

  test("a change that clashes with one another machine pushed says why and how to recover, and leaves the profile as it was", async () => {
    const { dir, elsewhere } = await profileBehind();
    await saveAnswers(dir, { plan: "codex" });
    await elsewhere((file) => ({ ...file, plan: "claude" }));
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe(`${dir}: could not take the changes another machine pushed. ${dir} and its remote both have changes the other lacks. Run git -C ${dir} pull --rebase, then try again.`);
    expect(await spawnGit(dir, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "hedge.json"), "utf8")).plan).toBe("codex");
  });

  test("a profile with changes it has not committed takes nothing and saves nothing, and says to commit or discard them", async () => {
    const { dir, remote, elsewhere } = await profileBehind();
    await elsewhere((file) => ({ ...file, hub: "coder.hedge-hub" }));
    writeFileSync(join(dir, "about-me.md"), "Hi\n");
    await spawnGit(dir, "add", "about-me.md");
    const before = await spawnGit(dir, "rev-parse", "HEAD");
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe(`${dir}: could not take the changes another machine pushed, because ${dir} has changes that are not committed. Commit or discard them, then try again.`);
    expect(await spawnGit(dir, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.parse(await spawnGit(remote, "show", "main:hedge.json")).packs).toEqual(["orchestration"]);
  });

  test("a profile whose Git stashes changes on its own before a pull still refuses them, and keeps hedge.json readable", async () => {
    const { dir, elsewhere } = await profileBehind();
    await spawnGit(dir, "config", "rebase.autoStash", "true");
    await elsewhere((file) => ({ ...file, plan: "claude" }));
    const edited = JSON.stringify({ ...profile, plan: "codex" }, null, 2) + "\n";
    writeFileSync(join(dir, "hedge.json"), edited);
    const error = await saveAnswers(dir, { packs: ["hub"] }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toContain(`because ${dir} has changes that are not committed.`);
    expect(readFileSync(join(dir, "hedge.json"), "utf8")).toBe(edited);
  });

  test("a failed push never shows the credentials in the remote's URL", async () => {
    const dir = await profileRepo();
    await spawnGit(dir, "remote", "add", "origin", "http://nora:hunter2@127.0.0.1:1/nora/hedge-profile.git?access_token=EXAMPLE_TOKEN");
    await spawnGit(dir, "config", "branch.main.remote", "origin");
    await spawnGit(dir, "config", "branch.main.merge", "refs/heads/main");
    const error = await saveAnswers(dir, { plan: "claude" }, { push: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toContain("http://127.0.0.1:1/nora/hedge-profile.git");
    expect((error as Error).message).not.toMatch(/hunter2|EXAMPLE_TOKEN|nora:/);
  });

  test("rejects a profile with invalid fields", async () => {
    expect(loadProfile(await profileRepo({ ...profile, workflows: { maps: "false" } }))).rejects.toThrow("workflows must map ids to true or false");
    expect(loadProfile(await profileRepo({ schema: 1 }))).rejects.toThrow("engine needs a repo");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { models: [{ role: "review", model: "x" }] } }))).rejects.toThrow("overrides.models must list rows");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "claude", key: "model", value: "x", plans: {} }] } }))).rejects.toThrow("overrides.config[0]: plans must list claude, codex, or both");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "nope", key: "model", value: "x" }] } }))).rejects.toThrow("overrides.config[0]: needs a provider and a key");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "claude", key: "model", value: "x", after: "ready" }] } }))).rejects.toThrow("overrides.config[0]: after names a pack's check, so only a pack's own config item can wait for one");
    expect(loadProfile(await profileRepo({ ...profile, overrides: { config: [{ provider: "t3", key: "providerInstances.muse", value: { driver: "muse", enabled: "yes" } }] } }))).rejects.toThrow("overrides.config[0]: a T3 provider instance needs a driver and enabled");
  });

  test("takes a model row of any T3 provider instance in its overrides", async () => {
    const neon = { role: "survey", work: "Read docs", provider: "antigravity", model: "gemini-4-neon", effort: "high" as const };
    expect((await loadProfile(await profileRepo({ ...profile, overrides: { models: [neon] } }))).overrides?.models).toEqual([neon]);
    expect(loadProfile(await profileRepo({ ...profile, overrides: { models: [{ ...neon, provider: "-x" }] } }))).rejects.toThrow("overrides.models must list rows with a role, work, a provider that names a T3 provider instance, a model, and an effort");
  });

  test("takes a T3 provider instance in its overrides", async () => {
    const muse = { provider: "t3" as const, key: "providerInstances.muse", value: { driver: "muse", enabled: true, config: { binaryPath: "~/.local/bin/muse" } } };
    expect((await loadProfile(await profileRepo({ ...profile, overrides: { config: [muse] } }))).overrides?.config).toEqual([muse]);
  });
});

describe("machine file", () => {
  test("rejects an unknown role", async () => {
    const home = temp.make("home-");
    await saveMachine(home, { schema: 1, role: "linux" });
    writeFileSync(join(home, ".config/hedge/machine.json"), JSON.stringify({ schema: 1, role: "toaster" }));
    expect(loadMachine(home)).rejects.toThrow("role must be mac, devbox, linux, or hub");
  });

  test("round-trips setup progress and draft answers", async () => {
    const home = temp.make("home-");
    expect(await loadMachine(home)).toBeUndefined();
    await saveMachine(home, { schema: 1, role: "mac", setup: { done: ["github", "packs"], draft: { packs: ["orchestration"], plan: "claude" } } });
    expect(await loadMachine(home)).toEqual({ schema: 1, role: "mac", setup: { done: ["github", "packs"], draft: { packs: ["orchestration"], plan: "claude" } } });
  });

  test("a new Mac is a mac and never a Coder devbox, even with Coder's variables set", () => {
    const coder = { CODER_AGENT_URL: "https://coder.example", CODER: "true" };
    expect(thisMachine(undefined, "darwin", {}, "laptop")).toEqual({ schema: 1, role: "mac", name: "laptop" });
    expect(thisMachine(undefined, "darwin", coder, "laptop")).toEqual({ schema: 1, role: "mac", name: "laptop" });
    expect(thisMachine({ schema: 1, role: "mac", name: "octo-mac", profileDir: "/Users/octo/hedge-profile" }, "darwin", coder, "laptop")).toEqual({ schema: 1, role: "mac", name: "octo-mac", profileDir: "/Users/octo/hedge-profile" });
    expect(thisMachine(undefined, "linux", coder, "not a host")).toEqual({ schema: 1, role: "devbox", coder: true });
  });

  test("rejects a schema it does not know", async () => {
    const home = temp.make("home-");
    await saveMachine(home, { schema: 1, role: "linux" });
    const path = join(home, ".config/hedge/machine.json");
    writeFileSync(path, JSON.stringify({ schema: 9, role: "linux" }));
    expect(loadMachine(home)).rejects.toThrow(`${path}: unknown schema 9`);
  });
});
