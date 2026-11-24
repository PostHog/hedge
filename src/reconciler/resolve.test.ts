import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks, parseManifest } from "../pack/manifest.ts";
import type { AvailableSource, FetchedSource, MachineFile, MachineRole, PackManifest, Plan, Profile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { apply, check } from "./apply.ts";
import { resolve, ResolveError } from "./resolve.ts";

const fixtures = join(import.meta.dir, "fixtures");
let engine: AvailableSource;
let agentSkills: FetchedSource;

beforeAll(async () => {
  const dir = join(fixtures, "engine");
  engine = { ref: { name: "engine", repo: "PostHog/hedge", ref: "v0.1.0" }, dir, packs: await loadPacks(dir) };
  agentSkills = { ref: { name: "agent-skills", repo: "Silthus/agent-skills", ref: "v1" }, dir: join(fixtures, "agent-skills"), packs: [] };
});

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    schema: 1,
    dir: "/profile",
    engine: { repo: "PostHog/hedge", ref: "v0.1.0", channel: "release" },
    sources: [],
    packs: ["pull-requests", "orchestration"],
    plan: "both",
    settings: { "pull-requests.reviewer": "other", "orchestration.tracker": "me/hedge-profile" },
    workflows: {},
    ...overrides,
  };
}

const mac: MachineFile = { schema: 1, role: "mac" };
const devbox: MachineFile = { schema: 1, role: "devbox" };

function plan(overrides: Partial<Profile> = {}, machine = mac, sources = [engine, agentSkills]) {
  return resolve(profile(overrides), machine, sources);
}

function file(result: Plan, target: string) {
  const found = result.files.find((item) => item.target === target);
  if (!found || !("content" in found)) throw new Error(`no content file ${target}`);
  return found.content;
}

function withPack(manifest: PackManifest, files: Record<string, string> = {}): AvailableSource {
  const dir = temp.make("source-");
  const packDir = join(dir, "packs", manifest.name);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(packDir, path, ".."), { recursive: true });
    writeFileSync(join(packDir, path), content);
  }
  return { ref: { name: manifest.name, repo: dir, ref: "v1" }, dir, packs: [{ manifest, dir: packDir }] };
}

const validPack = (manifest: PackManifest) => withPack(parseManifest(manifest, manifest.name));

const temp = tempDirs();

describe("resolve", () => {
  test("builds AGENTS.md from fragments in pack order with about me last", () => {
    const content = file(plan({ aboutMe: "I review every diff.\n" }), ".agents/AGENTS.md");
    expect(content).toBe("# Agent rules\n\nConfirm before a destructive action.\n\n## Pull requests\n\nOpen every pull request as a draft.\n\n## About me\n\nI review every diff.\n");
    expect(file(plan(), ".codex/AGENTS.md")).toBe(file(plan(), ".claude/rules/hedge.md"));
    expect(file(plan(), ".gemini/AGENTS.md")).toBe(file(plan(), ".agents/AGENTS.md"));
  });

  test("appends named sections from other packs to the owning guide", () => {
    expect(file(plan(), ".agents/guides/coding-standards.md")).toBe("# Coding standards\n\nKeep it simple.\n\n## Pull requests\n\nKeep each pull request under 400 lines.\n");
  });

  describe("a section that repeats a heading of its guide", () => {
    const owner = "# Coding standards\n\n## Tests\n\nWrite the test first.\n";
    const repeats = (section: string, text: string, ownerText = owner) => {
      const base = withPack({ schema: 1, name: "standards", summary: "Standards.", guides: [{ guide: "rules", path: "rules.md" }] }, { "rules.md": ownerText });
      const extra = withPack({ schema: 1, name: "mine", summary: "Mine.", guides: [{ guide: "rules", section, path: "mine.md" }] }, { "mine.md": text });
      return plan({ packs: ["standards", "mine"] }, mac, [engine, base, extra]);
    };

    test("is written and reported as a to-do in any letter case", async () => {
      const result = repeats("My rules", "### tests\n\nWrite the test first, always.\n");
      expect(file(result, ".agents/guides/rules.md")).toContain("### tests\n\nWrite the test first, always.");
      const report = await apply(result, { home: temp.make("home-"), dryRun: true });
      expect(report.ok).toBe(true);
      expect(report.findings.find((finding) => finding.id === "repeats:rules:My rules:tests")).toMatchObject({ pack: "mine", todo: true, say: expect.stringContaining('Section "My rules" of the mine pack repeats the heading "tests" of standards') });
    });

    test("is reported when its own title repeats a heading", () => {
      expect(repeats("tEsTs", "Name each test after its behaviour.\n").repeatedHeadings).toEqual([{ pack: "mine", guide: "rules", section: "tEsTs", heading: "tEsTs", owner: "standards" }]);
    });

    test("is reported once for each heading it repeats", () => {
      const ownerText = "# Coding standards\n\n## Tests\n\n## Naming\n";
      expect(repeats("My rules", "### Tests\n\n### Naming\n", ownerText).repeatedHeadings?.map((entry) => entry.heading)).toEqual(["Tests", "Naming"]);
    });

    test("is found between two horizontal rules at the top of the guide", () => {
      expect(repeats("My rules", "### Tests\n", "---\n\n# Coding standards\n\n## Tests\n\n---\n\nMore\n").repeatedHeadings).toHaveLength(1);
    });

    test("is not looked for on a Bun without a Markdown parser, and the section is still written", () => {
      const bun = Bun as { markdown?: unknown };
      const parser = bun.markdown;
      bun.markdown = undefined;
      try {
        const result = repeats("My rules", "### Tests\n");
        expect(result.repeatedHeadings).toBeUndefined();
        expect(file(result, ".agents/guides/rules.md")).toContain("## My rules\n\n### Tests");
      } finally {
        bun.markdown = parser;
      }
    });

    test("is found in setext and indented headings", () => {
      expect(repeats("My rules", "  ## Tests\n").repeatedHeadings).toHaveLength(1);
      expect(repeats("My rules", "Tests\n-----\n").repeatedHeadings).toHaveLength(1);
    });

    test.each([
      ["a code block of the guide", "My rules", "### Tests\n", "# Coding standards\n\n````md\n```\n## Tests\n````\n"],
      ["a code block of the section", "My rules", "````md\n```\n## Tests\n````\n", owner],
      ["an HTML comment", "My rules", "<!--\n## Tests\n-->\n", owner],
      ["front matter", "My rules", "---\ntitle: x\n---\n## Notes\n", "---\ntitle: x\n---\n# Coding standards\n"],
      ["a comment in front matter with Windows line ends", "My rules", "---\r\ntitle: x\r\n## Tests\r\n---\r\nMore\r\n", owner],
      ["a closing hash that is part of the text", "My rules", "## Tests#\n", owner],
    ])("is not found in %s", (_, section, text, ownerText) => {
      expect(repeats(section, text, ownerText).repeatedHeadings).toBeUndefined();
    });
  });

  test("throws when two packs own the same guide", () => {
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", guides: [{ guide: "coding-standards", path: "g.md" }] }, { "g.md": "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow("guide coding-standards is owned by both base and rival");
  });

  test("writes skill settings from answers and defaults and lists what is unanswered", () => {
    const result = plan({ settings: { "pull-requests.reviewer": "other" } });
    const settings = file(result, ".agents/guides/skill-settings.md");
    expect(settings).toContain("- `base.heavySlots`: `2`. How many heavy commands may run at once?");
    expect(settings).toContain("- `pull-requests.reviewer`: `other`.");
    expect(result.unanswered.map((setting) => setting.key)).toEqual(["orchestration.tracker"]);
  });

  test("links pack skills and skills from another source", () => {
    const links = plan().files.filter((item) => "source" in item);
    expect(links).toEqual([
      { target: ".agents/skills/full-stop", source: join(fixtures, "engine/packs/pull-requests/skills/full-stop") },
      { target: ".claude/skills/full-stop", source: join(fixtures, "engine/packs/pull-requests/skills/full-stop") },
      { target: ".gemini/config/skills/full-stop", source: join(fixtures, "engine/packs/pull-requests/skills/full-stop") },
      { target: ".agents/skills/writing-voice", source: join(fixtures, "agent-skills/skills/communication/writing-voice") },
      { target: ".claude/skills/writing-voice", source: join(fixtures, "agent-skills/skills/communication/writing-voice") },
      { target: ".gemini/config/skills/writing-voice", source: join(fixtures, "agent-skills/skills/communication/writing-voice") },
    ]);
  });

  test("lets a profile skill replace a pack skill of the same name", () => {
    const dir = temp.make("profile-");
    mkdirSync(join(dir, "skills/writing-voice"), { recursive: true });
    const result = plan({ dir, overrides: { skills: ["skills/writing-voice"] } });
    expect(result.files.filter((item) => item.target.endsWith("/writing-voice"))).toEqual([
      { target: ".agents/skills/writing-voice", source: join(dir, "skills/writing-voice") },
      { target: ".claude/skills/writing-voice", source: join(dir, "skills/writing-voice") },
      { target: ".gemini/config/skills/writing-voice", source: join(dir, "skills/writing-voice") },
    ]);
    expect(result.dropped).toContainEqual({ pack: "pull-requests", item: "skill agent-skills:communication/writing-voice", reason: "your profile replaces it" });
  });

  test("drops skills of an unreachable source with a reason", () => {
    const result = plan({}, mac, [engine, { ref: agentSkills.ref, error: "offline" }]);
    expect(result.files.some((item) => item.target.endsWith("writing-voice"))).toBe(false);
    expect(result.dropped).toContainEqual({ pack: "pull-requests", item: "skill agent-skills:communication/writing-voice", reason: "its source is unreachable" });
  });

  test("gives each config key one owner and throws on a clash", () => {
    expect(plan().owners).toEqual({ "claude:permissions.defaultMode": "base" });
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", config: [{ provider: "claude", key: "permissions.defaultMode", value: "plan" }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(new ResolveError("claude:permissions.defaultMode is owned by both base and rival"));
  });

  test("refuses Hedge's proxy values from a profile or any pack but the hub pack, and names who set which one", () => {
    const codex = (key: string, value: unknown) => ({ provider: "codex" as const, key, value });
    const fromProfile = (entry: { provider: "claude" | "codex"; key: string; value: unknown }) => () => plan({ overrides: { config: [entry] } });
    expect(fromProfile(codex("model_provider", "hedge-proxy"))).toThrow(new ResolveError(`your profile sets model_provider = "hedge-proxy" in config codex:model_provider. Only the hub pack may set Hedge's proxy route. Remove that config entry.`));
    expect(fromProfile({ ...codex("model_provider", "hedge-proxy"), workflow: "off" } as never)).toThrow('sets model_provider = "hedge-proxy"');
    expect(fromProfile(codex("model_providers.hedge-proxy.base_url", "http://127.0.0.1:8317/v1"))).toThrow("sets the hedge-proxy provider table in config codex:model_providers.hedge-proxy.base_url");
    expect(fromProfile({ provider: "claude", key: "env", value: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } })).toThrow("your profile sets env.ANTHROPIC_BASE_URL = http://127.0.0.1:8317 in config claude:env");
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", config: [{ provider: "codex", key: "model_providers", value: { "hedge-proxy": { name: "Mine" } } }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(new ResolveError("the rival pack sets the hedge-proxy provider table in config codex:model_providers. Only the hub pack may set Hedge's proxy route. Remove that config entry."));
    expect(plan({ overrides: { config: [codex("model_provider", "my-proxy"), codex("model_providers.my-proxy", { base_url: "http://127.0.0.1:8317/v1" }), { provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "https://gateway.example.com" }] } }).owners["codex:model_provider"]).toBe("profile");
    expect(plan({ packs: ["hub"] }, devbox).owners["claude:env.ANTHROPIC_BASE_URL"]).toBe("hub");
  });

  test("refuses Hedge's own Claude key helper from a profile and names the pack and the setting", () => {
    const helper = 'cat "$HOME/.config/hedge/cli-proxy.key"';
    expect(() => plan({ overrides: { config: [{ provider: "claude", key: "apiKeyHelper", value: helper }] } })).toThrow(new ResolveError(`your profile sets apiKeyHelper = ${helper} in config claude:apiKeyHelper. Only the hub pack may set Hedge's proxy route. Remove that config entry.`));
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", config: [{ provider: "claude", key: "apiKeyHelper", value: helper }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(`the rival pack sets apiKeyHelper = ${helper} in config claude:apiKeyHelper.`);
    expect(plan({ overrides: { config: [{ provider: "claude", key: "apiKeyHelper", value: "my-helper" }] } }).owners["claude:apiKeyHelper"]).toBe("profile");
  });

  test("takes a T3 key with an empty dotted part as one literal key", () => {
    const result = plan({ overrides: { config: [{ provider: "t3", key: "extension..option", value: true }] } });
    expect(result.owners["t3:extension..option"]).toBe("profile");
    expect(result.config).toContainEqual({ provider: "t3", key: "extension..option", value: true, pack: "profile" });
  });

  test("lets the profile override a pack's config key", () => {
    const result = plan({ overrides: { config: [{ provider: "claude", key: "permissions.defaultMode", value: "plan" }] } });
    expect(result.owners["claude:permissions.defaultMode"]).toBe("profile");
    expect(result.config).toEqual([{ provider: "claude", key: "permissions.defaultMode", value: "plan", pack: "profile" }]);
  });

  test("orders packs by requires and drops a pack whose requirement is missing", () => {
    expect(plan({ packs: ["orchestration", "pull-requests"] }).packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration"]);
    const result = plan({ packs: ["orchestration"] });
    expect(result.packs.find((pack) => pack.name === "orchestration")).toMatchObject({ available: false, reason: "requires pull-requests" });
    expect(result.packs.map((pack) => pack.name)).toEqual(["base", "orchestration"]);
  });

  test("throws on a requires cycle", () => {
    const a = withPack({ schema: 1, name: "a", summary: "A.", requires: ["b"] });
    const b = withPack({ schema: 1, name: "b", summary: "B.", requires: ["a"] });
    expect(() => plan({ packs: ["a", "b"] }, mac, [engine, a, b])).toThrow("packs require each other in a cycle");
  });

  test("activates workflows from overrides, defaults, and needs", () => {
    const onMac = plan({ workflows: { prune: false, "quality-loop": true } });
    expect(onMac.workflows).toEqual([
      { id: "prune", pack: "base", active: false, reason: "turned off" },
      { id: "draft-prs", pack: "pull-requests", active: true },
      { id: "maps", pack: "orchestration", active: true },
      { id: "quality-loop", pack: "orchestration", active: false, reason: "needs devbox" },
      { id: "boxes", pack: "orchestration", active: false, reason: "needs hub" },
    ]);
    expect(onMac.jobs).toEqual([]);
    expect(onMac.dropped).toContainEqual({ pack: "orchestration", item: "job box-pool", reason: "workflow boxes is off" });

    const onDevbox = plan({ workflows: { "quality-loop": true }, settings: { ...profile().settings, "orchestration.loopProject": "hedge" } }, devbox);
    expect(onDevbox.jobs.map((job) => job.id)).toEqual(["prune", "quality-loop"]);
    expect(plan({ devboxes: ["my-box"], workflows: { "quality-loop": true } }).jobs.map((job) => job.id)).toContain("quality-loop");
  });

  test("takes unset settings from the context repo, keeps every setting the profile sets, and never points a path at the context checkout for another repo", () => {
    const context = withPack({
      schema: 1,
      name: "ctx",
      summary: "Context.",
      settings: [
        { key: "context.repo", question: "Which context repo?", type: "string", optional: true, ask: "never" },
        { key: "context.path", question: "Which folder?", type: "string", default: "~/dev/context", ask: "never" },
        { key: "ctx.repo", question: "Which repo?", type: "string", ask: "setup", fromContext: { value: "{repo}" } },
        { key: "ctx.path", question: "Which folder?", type: "string", default: "~/dev/ctx", ask: "never", fromContext: { value: "{path}", unlessSet: "ctx.repo" } },
        { key: "ctx.log", question: "Which log?", type: "string", default: "", ask: "never", fromContext: { value: "{path}/log.md" } },
      ],
    });
    const values = (settings: Record<string, string>) => {
      const { "ctx.repo": repo, "ctx.path": path, "ctx.log": log } = plan({ packs: ["ctx"], settings }, mac, [engine, context]).settings;
      return { repo, path, log } as Record<string, unknown>;
    };
    expect(values({})).toEqual({ repo: undefined, path: "~/dev/ctx", log: "" });
    expect(values({ "context.repo": "acme/context" })).toEqual({ repo: "acme/context", path: "~/dev/context", log: "~/dev/context/log.md" });
    expect(values({ "context.repo": "acme/context", "context.path": "~/notes/" })).toEqual({ repo: "acme/context", path: "~/notes", log: "~/notes/log.md" });
    expect(values({ "context.repo": "acme/context", "ctx.repo": "me/other" })).toEqual({ repo: "me/other", path: "~/dev/ctx", log: "~/dev/context/log.md" });
    expect(values({ "context.repo": "acme/context", "ctx.path": "~/mine", "ctx.log": "~/mine/log.md" })).toEqual({ repo: "acme/context", path: "~/mine", log: "~/mine/log.md" });
  });

  test("asks for the context repo once instead of two repo questions it answers", () => {
    const repoSetting = (pack: string) => ({ key: `${pack}.repo`, question: "Which repo?", type: "string" as const, ask: "setup" as const, fromContext: { value: "{repo}" } });
    const one = withPack({ schema: 1, name: "one", summary: "One.", settings: [{ key: "context.repo", question: "Which context repo?", type: "string", optional: true, ask: "never" }, repoSetting("one")] });
    const two = withPack({ schema: 1, name: "two", summary: "Two.", settings: [repoSetting("two")] });
    const asked = (packs: string[], settings: Record<string, string> = {}) => plan({ packs, settings }, mac, [engine, one, two]).ask.map((setting) => `${setting.key}${setting.optional ? "?" : ""}`);
    expect(asked(["one", "two"])).toEqual(["context.repo"]);
    expect(asked(["one"])).toEqual(["one.repo"]);
    expect(asked(["one", "two"], { "two.repo": "me/two" })).toEqual(["one.repo", "two.repo"]);
  });

  test("leaves the settings of an inactive workflow out", () => {
    expect(plan().unanswered.map((setting) => setting.key)).not.toContain("orchestration.loopProject");
    expect(plan({ workflows: { "quality-loop": true } }, devbox).unanswered.map((setting) => setting.key)).toEqual(["orchestration.loopProject"]);
  });

  test("keeps a setting that two workflows share while one of them is on", () => {
    const loops = withPack({
      schema: 1,
      name: "loops",
      summary: "Loops.",
      settings: [{ key: "loops.project", question: "Which project?", type: "string" }],
      workflows: [
        { id: "night", name: "Night", sentence: "Runs at night.", default: true, settings: ["loops.project"] },
        { id: "morning", name: "Morning", sentence: "Runs in the morning.", default: false, settings: ["loops.project"] },
      ],
    });
    const result = plan({ packs: ["loops"], settings: { "loops.project": "hedge" } }, mac, [engine, loops]);
    expect(result.settings["loops.project"]).toBe("hedge");
    expect(plan({ packs: ["loops"] }, mac, [engine, loops]).unanswered.map((setting) => setting.key)).toEqual(["loops.project"]);
    expect(plan({ packs: ["loops"], workflows: { night: false } }, mac, [engine, loops]).unanswered).toEqual([]);
  });

  test("keeps a setting that another pack's active workflow lists", () => {
    const owner = withPack({ schema: 1, name: "owner", summary: "Owner.", settings: [{ key: "owner.project", question: "Which project?", type: "string" }], workflows: [{ id: "owned", name: "Owned", sentence: "Owned.", default: false, settings: ["owner.project"] }] });
    const user = withPack({ schema: 1, name: "user", summary: "User.", workflows: [{ id: "borrowed", name: "Borrowed", sentence: "Borrowed.", default: true, settings: ["owner.project"] }] });
    const result = plan({ packs: ["owner", "user"] }, mac, [engine, owner, user]);
    expect(result.unanswered.map((setting) => setting.key)).toEqual(["owner.project"]);
  });

  test("a workflow stays off while a workflow it requires is off, also through a chain, and a cycle that is all on stays on", () => {
    const flow = (id: string, requires: string[]) => ({ id, name: id, sentence: `${id}.`, default: true, requires });
    const chain = withPack({ schema: 1, name: "chain", summary: "Chain.", workflows: [flow("top", ["middle"]), flow("middle", ["bottom"]), flow("bottom", []), flow("ping", ["pong"]), flow("pong", ["ping"])] });
    const states = (workflows: Record<string, boolean>) => plan({ packs: ["chain"], workflows }, mac, [engine, chain]).workflows.filter((state) => state.pack === "chain").map(({ id, active, reason }) => [id, active, reason]);
    expect(states({ bottom: false })).toEqual([["top", false, "needs workflow middle"], ["middle", false, "needs workflow bottom"], ["bottom", false, "turned off"], ["ping", true, undefined], ["pong", true, undefined]]);
    expect(states({ pong: false }).slice(3)).toEqual([["ping", false, "needs workflow pong"], ["pong", false, "turned off"]]);
  });

  test("a workflow that yields stays off while a workflow it yields to is on, and comes back when that one is off or needs a workflow that is off", () => {
    const flow = (id: string, fields: { requires?: string[]; yields?: string[] }) => ({ id, name: id, sentence: `${id}.`, default: true, ...fields });
    const pair = withPack({ schema: 1, name: "pair", summary: "Pair.", workflows: [flow("direct", { yields: ["routed"] }), flow("after-direct", { requires: ["direct"] }), flow("routed", { requires: ["base-route"] }), flow("base-route", {})] });
    const states = (workflows: Record<string, boolean>) => plan({ packs: ["pair"], workflows }, mac, [engine, pair]).workflows.filter((state) => state.pack === "pair").map(({ id, active, reason }) => [id, active, reason]);
    expect(states({})).toEqual([["direct", false, "yields to workflow routed"], ["after-direct", false, "needs workflow direct"], ["routed", true, undefined], ["base-route", true, undefined]]);
    expect(states({ routed: false }).slice(0, 2)).toEqual([["direct", true, undefined], ["after-direct", true, undefined]]);
    expect(states({ "base-route": false }).slice(0, 3)).toEqual([["direct", true, undefined], ["after-direct", true, undefined], ["routed", false, "needs workflow base-route"]]);
  });

  test("a fallback whose setting is answered stays on while the workflow it yields to waits for its own setting", () => {
    const setting = (key: string) => ({ key, question: `${key}?`, type: "string" as const });
    const flow = (id: string, fields: { yields?: string[] }) => ({ id, name: id, sentence: `${id}.`, default: true, settings: [`pair.${id}`], offUntilSet: [`pair.${id}`], ...fields });
    const pair = withPack({ schema: 1, name: "pair", summary: "Pair.", settings: [setting("pair.fallback"), setting("pair.preferred")], workflows: [flow("fallback", { yields: ["preferred"] }), flow("preferred", {})] });
    const states = plan({ packs: ["pair"], settings: { "pair.fallback": "set" } }, mac, [engine, pair]).workflows.filter((state) => state.pack === "pair").map(({ id, active, reason }) => [id, active, reason]);
    expect(states).toEqual([["fallback", true, undefined], ["preferred", false, "waits for setting pair.preferred"]]);
  });

  test("asks the settings of a fallback that takes over from a workflow waiting for its setting", () => {
    const pair = withPack({
      schema: 1, name: "pair", summary: "Pair.",
      settings: [{ key: "pair.preferred", question: "Preferred?", type: "string", ask: "never", optional: true }, { key: "pair.fallback", question: "Which fallback?", type: "string", ask: "setup" }],
      workflows: [
        { id: "fallback", name: "Fallback", sentence: "Fallback.", default: true, settings: ["pair.fallback"], yields: ["preferred"] },
        { id: "preferred", name: "Preferred", sentence: "Preferred.", default: true, settings: ["pair.preferred"], offUntilSet: ["pair.preferred"] },
      ],
    });
    const resolved = plan({ packs: ["pair"] }, mac, [engine, pair]);
    expect(resolved.workflows.filter((state) => state.pack === "pair").map(({ id, active }) => [id, active])).toEqual([["fallback", true], ["preferred", false]]);
    expect(resolved.ask.map((setting) => setting.key)).toContain("pair.fallback");
    expect(resolved.unanswered.map((setting) => setting.key)).toEqual(["pair.fallback"]);
  });

  test("a workflow waits for an engine setting that only an inactive workflow of a later pack gives a default", () => {
    const library = withPack({ schema: 1, name: "library", summary: "Library.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", optional: true }], workflows: [{ id: "shelf", name: "Shelf", sentence: "Shelf.", default: true, settings: ["context.repo"], offUntilSet: ["context.repo"] }] });
    const later = withPack({ schema: 1, name: "later", summary: "Later.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", default: "me/context" }], workflows: [{ id: "archive", name: "Archive", sentence: "Archive.", default: false, settings: ["context.repo"] }] });
    const resolved = plan({ packs: ["library", "later"] }, mac, [engine, library, later]);
    expect(resolved.workflows.find((state) => state.id === "shelf")).toMatchObject({ active: false, reason: "waits for setting context.repo" });
    expect(resolved.settings["context.repo"]).toBeUndefined();
  });

  test("releases a workflow waiting for a setting that the fallback of another held workflow supplies, and keeps holding a workflow whose own fallback supplies its setting", () => {
    const cloud = withPack({ schema: 1, name: "cloud", summary: "Cloud.", settings: [{ key: "cloud.token", question: "Token?", type: "string", ask: "never", optional: true }], workflows: [{ id: "cloud", name: "Cloud", sentence: "Cloud.", default: true, settings: ["cloud.token"], offUntilSet: ["cloud.token"] }] });
    const local = withPack({ schema: 1, name: "local", summary: "Local.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", default: "me/context" }], workflows: [{ id: "local", name: "Local", sentence: "Local.", default: true, settings: ["context.repo"], yields: ["cloud"] }] });
    const shelf = withPack({ schema: 1, name: "shelf", summary: "Shelf.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", optional: true }], workflows: [{ id: "shelf", name: "Shelf", sentence: "Shelf.", default: true, settings: ["context.repo"], offUntilSet: ["context.repo"] }] });
    const resolved = plan({ packs: ["shelf", "cloud", "local"] }, mac, [engine, cloud, local, shelf]);
    expect(resolved.workflows.filter((state) => state.pack !== "base").map(({ id, active, reason }) => [id, active, reason])).toEqual([["shelf", true, undefined], ["cloud", false, "waits for setting cloud.token"], ["local", true, undefined]]);
    expect(resolved.settings["context.repo"]).toBe("me/context");
  });

  test("keeps holding a workflow whose own fallback supplies its setting", () => {
    const own = validPack({ schema: 1, name: "own", summary: "Own.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", optional: true }], workflows: [{ id: "preferred", name: "Preferred", sentence: "Preferred.", default: true, settings: ["context.repo"], offUntilSet: ["context.repo"] }, { id: "fallback", name: "Fallback", sentence: "Fallback.", default: true, yields: ["preferred"] }] });
    const spare = validPack({ schema: 1, name: "spare", summary: "Spare.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", default: "me/context" }], workflows: [{ id: "feeder", name: "Feeder", sentence: "Feeder.", default: true, settings: ["context.repo"], requires: ["fallback"] }] });
    const resolved = plan({ packs: ["own", "spare"] }, mac, [engine, own, spare]);
    expect(resolved.workflows.filter((state) => state.pack !== "base").map(({ id, active, reason }) => [id, active, reason])).toEqual([["preferred", false, "waits for setting context.repo"], ["fallback", true, undefined], ["feeder", true, undefined]]);
  });

  test("names the setting a held workflow still misses after a fallback supplies its first one", () => {
    const remote = validPack({ schema: 1, name: "remote", summary: "Remote.", settings: [{ key: "remote.token", question: "Token?", type: "string", ask: "never", optional: true }, { key: "context.repo", question: "Repo?", type: "string", ask: "never", default: "me/context" }], workflows: [{ id: "cloud", name: "Cloud", sentence: "Cloud.", default: true, settings: ["remote.token"], offUntilSet: ["remote.token"] }, { id: "local", name: "Local", sentence: "Local.", default: true, settings: ["context.repo"], yields: ["cloud"] }] });
    const shelf = validPack({ schema: 1, name: "shelf", summary: "Shelf.", settings: [{ key: "context.repo", question: "Repo?", type: "string", ask: "never", optional: true }, { key: "context.path", question: "Path?", type: "string", ask: "never", optional: true }], workflows: [{ id: "shelf", name: "Shelf", sentence: "Shelf.", default: true, settings: ["context.repo", "context.path"], offUntilSet: ["context.repo", "context.path"] }] });
    const resolved = plan({ packs: ["shelf", "remote"] }, mac, [engine, remote, shelf]);
    expect(resolved.workflows.filter((state) => state.pack !== "base").map(({ id, active, reason }) => [id, active, reason])).toEqual([["shelf", false, "waits for setting context.path"], ["cloud", false, "waits for setting remote.token"], ["local", true, undefined]]);
    expect(resolved.settings["context.repo"]).toBe("me/context");
  });

  test("settles a chain of yields: the first stays on when the one it yields to yields in turn", () => {
    const flow = (id: string, yields: string[] = []) => ({ id, name: id, sentence: `${id}.`, default: true, yields });
    const chain = withPack({ schema: 1, name: "chain", summary: "Chain.", workflows: [flow("a", ["b"]), flow("b", ["c"]), flow("c")] });
    const states = (workflows: Record<string, boolean>) => plan({ packs: ["chain"], workflows }, mac, [engine, chain]).workflows.filter((state) => state.pack === "chain").map(({ id, active, reason }) => [id, active, reason]);
    expect(states({})).toEqual([["a", true, undefined], ["b", false, "yields to workflow c"], ["c", true, undefined]]);
    expect(states({ c: false })).toEqual([["a", false, "yields to workflow b"], ["b", true, undefined], ["c", false, "turned off"]]);
  });

  test("joins a pack's Codex rules that fit this machine into one file of the pack, only for a Codex plan", () => {
    const flow = { id: "boxes", name: "Boxes", sentence: "Boxes.", default: false };
    const rules = withPack({ schema: 1, name: "rules", summary: "Rules.", workflows: [flow], codexRules: [{ path: "all.rules" }, { path: "devbox.rules", roles: ["devbox"] }, { path: "boxes.rules", workflow: "boxes" }] }, { "all.rules": "# all\n", "devbox.rules": "# devbox", "boxes.rules": "# boxes\n" });
    const target = ".codex/rules/hedge-rules.rules";
    const rulesOf = (fields: Partial<Profile>, machine: MachineFile) => plan({ packs: ["rules"], ...fields }, machine, [engine, rules]).files.filter((item) => item.target.startsWith(".codex/rules/"));
    expect(rulesOf({}, mac)).toEqual([{ target, content: "# all\n" }]);
    expect(rulesOf({ workflows: { boxes: true } }, devbox)).toEqual([{ target, content: "# all\n# devbox\n# boxes\n" }]);
    expect(rulesOf({ plan: "codex" }, mac)).toHaveLength(1);
    expect(rulesOf({ plan: "claude" }, devbox)).toEqual([]);
    const none = withPack({ schema: 1, name: "none", summary: "None.", workflows: [flow], codexRules: [{ path: "boxes.rules", workflow: "boxes" }] }, { "boxes.rules": "# boxes\n" });
    expect(plan({ packs: ["none"] }, mac, [engine, none]).files.filter((item) => item.target.startsWith(".codex/rules/"))).toEqual([]);
  });

  test("drops an item while a workflow it gives way to is on, also one of another pack, and keeps it while that workflow is off or its pack is not on", () => {
    const bridge = withPack({ schema: 1, name: "bridge", summary: "Bridge.", workflows: [{ id: "bridge", name: "Bridge", sentence: "Bridge.", default: false }] });
    const native = withPack({ schema: 1, name: "native", summary: "Native.", config: [{ provider: "claude", key: "enabledPlugins.chat@market", value: true, unless: ["bridge"] }] });
    const result = (fields: Partial<Profile>) => plan({ packs: ["bridge", "native"], ...fields }, mac, [engine, bridge, native]);
    const chat = (fields: Partial<Profile>) => result(fields).config.filter((entry) => entry.pack === "native").map((entry) => entry.key);
    expect(chat({})).toEqual(["enabledPlugins.chat@market"]);
    expect(chat({ workflows: { bridge: true } })).toEqual([]);
    expect(result({ workflows: { bridge: true } }).dropped).toContainEqual({ pack: "native", item: "config claude:enabledPlugins.chat@market", reason: "gives way to workflow bridge" });
    expect(plan({ packs: ["native"] }, mac, [engine, bridge, native]).config.filter((entry) => entry.pack === "native")).toHaveLength(1);
  });

  test("refuses an item that gives way to a workflow no pack of any source declares, but not while a source that may declare it is unreachable", () => {
    const native = withPack({ schema: 1, name: "native", summary: "Native.", config: [{ provider: "claude", key: "enabledPlugins.chat@market", value: true, unless: ["brigde"] }] });
    expect(() => plan({ packs: ["native"] }, mac, [engine, native])).toThrow("native: config claude:enabledPlugins.chat@market gives way to workflow brigde, which no pack declares");
    expect(plan({ packs: ["native"] }, mac, [engine, native, { ref: agentSkills.ref, error: "offline" }]).config.filter((entry) => entry.pack === "native")).toHaveLength(1);
  });

  test("limits items by os and role", () => {
    expect(plan({ packs: ["posthog"] }).human.map((step) => step.id)).toEqual(["coder"]);
    expect(plan({ packs: ["posthog"] }, devbox).human).toEqual([]);
  });

  test("discovers pack commands and rejects reserved names and clashes", () => {
    expect(plan({ packs: ["hub"] }).commands).toEqual({ box: { pack: "hub", path: join(fixtures, "engine/packs/hub/commands/box.ts") } });
    expect(plan().commands).toEqual({});
    const reserved = withPack({ schema: 1, name: "rival", summary: "Rival." }, { "commands/doctor.ts": "export {};\n" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, reserved])).toThrow("rival: command doctor is reserved by the engine");
    const clash = withPack({ schema: 1, name: "rival", summary: "Rival." }, { "commands/box.ts": "export {};\n" });
    expect(() => plan({ packs: ["hub", "rival"] }, mac, [engine, clash])).toThrow("command box is shipped by both hub and rival");
  });

  test("hands a profile's secret rows and a pack's secret providers to hedge secret", () => {
    const rows = withPack({ schema: 1, name: "rows", summary: "Rows.", handlers: [{ seam: "secret-rows", path: "lib/rows.ts" }] }, { "lib/rows.ts": "export const rows = () => [];\n" });
    const providers = withPack({ schema: 1, name: "keys", summary: "Keys.", handlers: [{ seam: "secret-providers", path: "lib/providers.ts" }] }, { "lib/providers.ts": "export const providers = {};\n" });
    expect(plan({ packs: ["rows", "keys"] }, mac, [engine, rows, providers]).handlers).toEqual({
      "secret-rows": { pack: "rows", path: join(rows.dir, "packs/rows/lib/rows.ts") },
      "secret-providers": { pack: "keys", path: join(providers.dir, "packs/keys/lib/providers.ts") },
    });
  });

  test("collects the handlers of enabled packs by seam, and rejects two for one seam", () => {
    const bots = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/bot.ts" }] }, { "lib/bot.ts": "export {};\n" });
    expect(plan().handlers).toEqual({});
    expect(plan({ packs: ["bots"] }, mac, [engine, bots]).handlers).toEqual({ "review-bot": { pack: "bots", path: join(bots.dir, "packs/bots/lib/bot.ts") } });
    const words = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "pr-command", path: "lib/bot.ts", subcommands: ["queue-wait"] }] }, { "lib/bot.ts": "export {};\n" });
    expect(plan({ packs: ["bots"] }, mac, [engine, words]).handlers).toEqual({ "pr-command": { pack: "bots", path: join(words.dir, "packs/bots/lib/bot.ts"), subcommands: ["queue-wait"] } });
    const linuxOnly = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/bot.ts", on: ["linux"] }] });
    expect(plan({ packs: ["bots"] }, mac, [engine, linuxOnly]).handlers).toEqual({});
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", handlers: [{ seam: "review-bot", path: "lib/bot.ts" }] });
    expect(() => plan({ packs: ["bots", "rival"] }, mac, [engine, bots, rival])).toThrow("the review-bot handler is declared by both bots and rival");
    const leak = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "../../../outside.ts" }] });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, leak])).toThrow("bots: path ../../../outside.ts leaves its pack");
    const missing = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib/missing.ts" }] });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, missing])).toThrow("bots: the review-bot handler lib/missing.ts is not a file");
    const folder = withPack({ schema: 1, name: "bots", summary: "Bots.", handlers: [{ seam: "review-bot", path: "lib" }] }, { "lib/bot.ts": "export {};\n" });
    expect(() => plan({ packs: ["bots"] }, mac, [engine, folder])).toThrow("bots: the review-bot handler lib is not a file");
  });

  test("marks a pack of an unreachable source as unavailable", () => {
    const result = plan({ packs: ["team"] }, mac, [engine, agentSkills, { ref: { name: "team", repo: "org/team", ref: "v1" }, error: "offline" }]);
    expect(result.packs).toContainEqual({ name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" });
  });
});

describe("resolve without the hub pack", () => {
  const pointsAtHub = /\bhub\b|tunnel|proxy|ANTHROPIC_BASE_URL|127\.0\.0\.1/i;
  const optional = ["pull-requests", "orchestration", "posthog"];
  const workflowIds = ["prune", "draft-prs", "maps", "quality-loop", "boxes"];
  const roles: MachineRole[] = ["mac", "devbox", "linux"];

  function random(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  }

  function hubFree(result: Plan) {
    const { jobs, human, steps, checks, config, files, commands } = result;
    return !pointsAtHub.test(JSON.stringify({ jobs, human, steps, checks, config, files, commands }));
  }

  test("no planned item points at a hub, tunnel, or proxy, and resolve stays under 50 ms", () => {
    const next = random(42);
    for (let run = 0; run < 200; run++) {
      const packs = optional.filter(() => next() < 0.6);
      const workflows = Object.fromEntries(workflowIds.filter(() => next() < 0.5).map((id) => [id, next() < 0.5]));
      const machine: MachineFile = { schema: 1, role: roles[Math.floor(next() * roles.length)] ?? "mac" };
      const started = performance.now();
      const result = plan({ packs, workflows, devboxes: next() < 0.5 ? ["box"] : [] }, machine);
      expect(performance.now() - started).toBeLessThan(50);
      expect(hubFree(result)).toBe(true);
    }
    expect(hubFree(plan({ packs: ["hub", "orchestration", "pull-requests"] }, devbox))).toBe(false);
  });
});

describe("resolve guards", () => {
  const pack = (name: string, fields: Partial<PackManifest> = {}): PackManifest => ({ schema: 1, name, summary: `${name}.`, ...fields });

  test("keeps every target inside the home directory", () => {
    const escape = withPack(pack("escape", { guides: [{ guide: "../../../../tmp/escape", path: "g.md" }] }), { "g.md": "x" });
    expect(() => plan({ packs: ["escape"] }, mac, [engine, escape])).toThrow("target .agents/guides/../../../../tmp/escape.md leaves the home directory");
  });

  test("refuses instructions, skills, and commands that link outside their pack", () => {
    const outside = temp.make("outside-");
    writeFileSync(join(outside, "secret.md"), "outside\n");
    mkdirSync(join(outside, "skill"));
    const linked = (manifest: PackManifest, link: string, target: string) => {
      const source = withPack(manifest);
      const packDir = join(source.dir, "packs", manifest.name);
      mkdirSync(join(packDir, link, ".."), { recursive: true });
      symlinkSync(target, join(packDir, link));
      return source;
    };
    const cases: Array<[PackManifest, string, string]> = [
      [pack("rules", { instructions: "rules.md" }), "rules.md", join(outside, "secret.md")],
      [pack("skills", { skills: ["skills/leak"] }), "skills/leak", join(outside, "skill")],
      [pack("tools"), "commands/leak.ts", join(outside, "secret.md")],
    ];
    for (const [manifest, link, target] of cases) {
      expect(() => plan({ packs: [manifest.name] }, mac, [engine, linked(manifest, link, target)])).toThrow("links outside its pack");
    }
  });

  test("refuses a pack file that is a broken link, so it cannot point outside later", () => {
    const source = withPack(pack("dangling", { files: [{ path: "hook.ts", target: ".config/hedge/hooks/hook.ts" }] }));
    symlinkSync(join(temp.make("outside-"), "later.ts"), join(source.dir, "packs/dangling/hook.ts"));
    expect(() => plan({ packs: ["dangling"] }, mac, [engine, source])).toThrow("dangling: path hook.ts is a broken link");
  });

  test("refuses a pack file on a file that the provider config owns", () => {
    const rival = withPack(pack("rival", { files: [{ path: "settings.json", target: ".claude/settings.json" }] }), { "settings.json": "{}" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow(".claude/settings.json belongs to the provider config");
  });

  test("rejects a workflow id or a job id that two packs declare", () => {
    const sync = { id: "sync", name: "Sync", sentence: "Sync.", default: true };
    const one = withPack(pack("one", { workflows: [{ ...sync, needs: ["hub"] }] }));
    const two = withPack(pack("two", { workflows: [sync] }));
    expect(() => plan({ packs: ["one", "two"] }, mac, [engine, one, two])).toThrow("workflow sync is declared by both one and two");
    const prune = withPack(pack("prune", { jobs: [{ id: "prune", command: ["true"], schedule: { every: "1d" } }] }));
    expect(() => plan({ packs: ["prune"] }, mac, [engine, prune])).toThrow("job prune is declared by both base and prune");
  });

  test("keeps a job of a pack from before the rename that says oncePerFleet on one machine only", () => {
    const team = withPack(pack("team", { jobs: [{ id: "digest", command: ["true"], schedule: { every: "1d" }, oncePerFleet: true }] }));
    const on = (name: string) => plan({ packs: ["team"], devboxes: ["node-1", "node-2"] }, { ...devbox, name }, [engine, team]).jobs.some((job) => job.id === "digest");
    expect([on("node-1"), on("node-2")]).toEqual([true, false]);
  });

  test("plans T3 project scripts by scope, owned by their pack", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "hedge prepare", projects: ["~/app"] };
    const team = withPack(pack("team", { t3ProjectScripts: [{ ...script, roles: ["devbox"] }, { ...script, id: "mac-only", on: ["darwin"] }] }));
    expect(plan({ packs: ["team"] }, devbox, [engine, team]).t3ProjectScripts).toEqual([{ ...script, roles: ["devbox"], pack: "team" }]);
    expect(plan({ packs: ["team"] }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, id: "mac-only", on: ["darwin"], pack: "team" }]);
  });

  test("adds the path a T3 project script's setting names to its projects", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "hedge prepare", projects: ["~/app"], projectSetting: "team.checkout" };
    const team = withPack(pack("team", { settings: [{ key: "team.checkout", question: "Where is the checkout?", type: "string", default: "~/dev/app", ask: "never" }], t3ProjectScripts: [script] }));
    expect(plan({ packs: ["team"] }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, projects: ["~/app", "~/dev/app"], pack: "team" }]);
    expect(plan({ packs: ["team"], settings: { "team.checkout": "~/app" } }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, pack: "team" }]);
    expect(plan({ packs: ["team"], settings: { "team.checkout": "app" } }, mac, [engine, team]).t3ProjectScripts).toEqual([{ ...script, pack: "team" }]);
  });

  test("rejects two T3 project scripts that would get the same id", () => {
    const script = { id: "prepare", name: "Prepare worktree", command: "hedge prepare", projects: ["~/app"] };
    const team = withPack(pack("team", { t3ProjectScripts: [{ ...script, id: "extra-prepare" }] }));
    const teamExtra = withPack(pack("team-extra", { t3ProjectScripts: [script] }));
    expect(() => plan({ packs: ["team", "team-extra"] }, mac, [engine, team, teamExtra])).toThrow(new ResolveError("t3 project script prepare of team-extra and extra-prepare of team both get the id hedge-team-extra-prepare"));
    const twice = withPack(pack("twice", { t3ProjectScripts: [script, { ...script, name: "Again" }] }));
    expect(() => plan({ packs: ["twice"] }, mac, [engine, twice])).toThrow(new ResolveError("t3 project script prepare of twice and prepare of twice both get the id hedge-twice-prepare"));
  });

  test("keeps the AI plan and resolves a T3 job's project", () => {
    expect(plan({ plan: "claude" }).ai).toBe("claude");
    const result = plan({ workflows: { "quality-loop": true }, settings: { "orchestration.tracker": "me/maps", "orchestration.loopProject": "chosen-project" } }, devbox);
    expect(result.jobs.find((job) => job.id === "quality-loop")?.task?.project).toBe("chosen-project");
  });

  test("throws when the base pack is not available", () => {
    const base = engine.packs.find((item) => item.manifest.name === "base");
    if (!base) throw new Error("no base fixture");
    const broken: AvailableSource = { ...engine, packs: [{ ...base, manifest: { ...base.manifest, requires: ["hub"] } }] };
    expect(() => resolve(profile({ packs: [] }), mac, [broken])).toThrow("the base pack is not available: requires hub");
  });

  test("reserves the skill-settings guide for the engine", () => {
    const rival = withPack(pack("rival", { guides: [{ guide: "skill-settings", path: "g.md" }] }), { "g.md": "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, rival])).toThrow("rival: guide skill-settings is written by the engine");
  });

  test("drops a profile config override whose workflow is off", () => {
    const result = plan({ workflows: { prune: false }, overrides: { config: [{ provider: "claude", key: "model", value: "x", workflow: "prune" }] } });
    expect(result.config.some((entry) => entry.key === "model")).toBe(false);
    expect(result.dropped).toContainEqual({ pack: "profile", item: "config claude:model", reason: "workflow prune is off" });
  });
});

describe("resolve per AI plan", () => {
  const rows = (model: string) => [
    { role: "implementation", work: "Implementation and tests", provider: "claude" as const, model, effort: "high" as const },
    { role: "review", work: "Review", provider: "codex" as const, model: "gpt-review", effort: "high" as const },
  ];
  const tables = withPack(
    {
      schema: 1,
      name: "models",
      summary: "Models.",
      instructions: "AGENTS.md",
      models: { claude: rows("claude-only"), both: rows("claude-both") },
      config: [
        { provider: "t3", key: "defaultModel", value: "claude-only", plans: ["claude"] },
        { provider: "t3", key: "defaultModel", value: "claude-both", plans: ["both"] },
      ],
      steps: [{ id: "codex-cli", run: ["install", "codex"], plans: ["codex", "both"], on: ["linux"] }],
      files: [
        { path: "hooks/guard.ts", target: ".config/hedge/hooks/guard.ts" },
        { path: "heavy.slice", target: ".config/systemd/user/hedge-heavy.slice", on: ["linux"] },
      ],
    },
    { "AGENTS.md": "# Models fragment\n", "hooks/guard.ts": "export {};\n", "heavy.slice": "[Slice]\n" },
  );
  const withTables = (overrides: Partial<Profile> = {}, machine = mac) => plan({ packs: ["pull-requests", "orchestration", "models"], ...overrides }, machine, [engine, agentSkills, tables]);

  test("refuses a T3 job whose model role the plan's model table lacks", () => {
    const task = { prompt: "Run.", projectSetting: "jobs.project", modelRole: "worker", workspaceStrategy: "worktree" as const, runtimeMode: "auto" as const };
    const jobs = withPack({ schema: 1, name: "jobs", summary: "Jobs.", settings: [{ key: "jobs.project", question: "Which project?", type: "string", default: "hedge" }], jobs: [{ id: "nightly", command: [], runner: "t3", schedule: { every: "1d" }, task }] });
    const resolveJobs = (overrides: Partial<Profile> = {}) => plan({ packs: ["pull-requests", "orchestration", "models", "jobs"], ...overrides }, mac, [engine, agentSkills, tables, jobs]);
    expect(() => resolveJobs()).toThrow("job nightly asks for model role worker, which the model table lacks");
    const worker = { role: "worker", work: "Workers", provider: "claude" as const, model: "claude-worker", effort: "high" as const };
    expect(resolveJobs({ overrides: { models: [worker] } }).jobs.map((job) => job.id)).toContain("nightly");
  });

  test("keeps only the items whose plans hold and records why the others dropped", () => {
    const claude = withTables({ plan: "claude" }, devbox);
    expect(claude.config.filter((entry) => entry.key === "defaultModel").map((entry) => entry.value)).toEqual(["claude-only"]);
    expect(claude.steps.map((step) => step.id)).toEqual([]);
    expect(claude.dropped).toContainEqual({ pack: "models", item: "step codex-cli", reason: "not for plan claude" });
    expect(withTables({ plan: "both" }, devbox).steps.map((step) => step.id)).toEqual(["codex-cli"]);
  });

  test("fills the plan's model table and renders it after the owning pack's fragment", () => {
    const result = withTables({ plan: "both" });
    expect(result.models.map((row) => row.model)).toEqual(["claude-both", "gpt-review"]);
    const agents = file(result, ".agents/AGENTS.md");
    expect(agents).toContain("# Models fragment\n\n## Model selection\n\n| Work | Model | Effort |\n| --- | --- | --- |\n| Implementation and tests | `claude-both` | high |\n| Review | `gpt-review` | high |\n");
    expect(agents.indexOf("## Model selection")).toBeLessThan(agents.indexOf("## About me") < 0 ? Infinity : agents.indexOf("## About me"));
  });

  test("has no model table for a plan the pack leaves out", () => {
    const result = withTables({ plan: "codex" });
    expect(result.models).toEqual([]);
    expect(file(result, ".agents/AGENTS.md")).not.toContain("## Model selection");
  });

  test("lets the profile replace a row by role or add one", () => {
    const extra = { role: "lookup", work: "Lookups", provider: "claude" as const, model: "small", effort: "medium" as const };
    const replaced = { ...rows("mine")[0]! };
    const result = withTables({ plan: "both", overrides: { models: [replaced, extra] } });
    expect(result.models.map((row) => `${row.role}=${row.model}`)).toEqual(["implementation=mine", "review=gpt-review", "lookup=small"]);
  });

  test("throws when two packs declare a model table", () => {
    const rival = withPack({ schema: 1, name: "rival", summary: "Rival.", models: { claude: rows("rival") } });
    expect(() => plan({ packs: ["models", "rival"] }, mac, [engine, agentSkills, tables, rival])).toThrow("the model table is declared by both models and rival");
  });

  test("links pack files into the home directory, limited by os", () => {
    const links = (result: Plan) => result.files.filter((item) => "source" in item && item.target.startsWith(".config/"));
    expect(links(withTables({}, devbox))).toEqual([
      { target: ".config/hedge/hooks/guard.ts", source: join(tables.dir, "packs/models/hooks/guard.ts") },
      { target: ".config/systemd/user/hedge-heavy.slice", source: join(tables.dir, "packs/models/heavy.slice") },
    ]);
    expect(links(withTables()).map((item) => item.target)).toEqual([".config/hedge/hooks/guard.ts"]);
  });

  test("refuses a pack file that leaves its pack or the home directory", () => {
    const outside = withPack({ schema: 1, name: "rival", summary: "Rival.", files: [{ path: "../x", target: ".x" }] });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, outside])).toThrow("rival: path ../x leaves its pack");
    const away = withPack({ schema: 1, name: "rival", summary: "Rival.", files: [{ path: "x", target: "../x" }] }, { x: "x" });
    expect(() => plan({ packs: ["rival"] }, mac, [engine, away])).toThrow("target ../x leaves the home directory");
  });
});

describe("a step's undo", () => {
  const step = { id: "auto-box", run: ["box-on"], check: ["box-is-on"], undo: ["box-off"], workflow: "boxes" };
  const signIn = { id: "sign-in", say: "Sign in to the box service.", probe: ["signed-in"], workflow: "boxes" };
  const team = (steps: PackManifest["steps"]) => withPack({ schema: 1, name: "team", summary: "Team.", workflows: [{ id: "boxes", name: "Boxes", sentence: "Boxes.", default: true }], human: [signIn], steps });
  const box = (on: boolean, undo = 0) => {
    const world = { on, signedIn: true };
    const run = async (command: string[]) => {
      const name = command.join(" ");
      if (name === "box-is-on") return world.on ? 0 : 1;
      if (name === "box-state") return world.signedIn ? (world.on ? 0 : 1) : 3;
      if (name === "box-unsure") return 3;
      if (name === "box-on") return (world.on = true), 0;
      if (name === "box-off") return undo || ((world.on = false), 0);
      if (name === "signed-in") return world.signedIn ? 0 : 1;
      if (name === "broken") return 1;
      return 0;
    };
    return { world, run };
  };
  const planWith = (steps: PackManifest["steps"], workflows: Record<string, boolean>, machine = devbox) => plan({ packs: ["team"], workflows }, machine, [engine, team(steps)]);

  test("runs once the step's workflow is off and its check shows what it set, and doctor reports it until then", async () => {
    const { world, run } = box(true);
    const off = planWith([step], { boxes: false });
    const home = temp.make("home-");
    expect((await check(off, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "The workflow boxes is off, but step auto-box of the team pack still holds what it set. Run hedge apply to undo it.", repair: "apply" });
    const applied = await apply(off, { home, run });
    expect(world.on).toBe(false);
    expect(applied.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "workflow boxes is off" });
    expect((await apply(off, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect((await check(off, { home, run })).findings.map((finding) => finding.id)).not.toContain("undo:auto-box");
  });

  test("leaves the step alone while its workflow is on, or when it is off for another reason", async () => {
    const on = box(true);
    await apply(planWith([step], {}), { home: temp.make("home-"), run: on.run });
    expect(on.world.on).toBe(true);
    const elsewhere = box(true);
    await apply(planWith([{ ...step, on: ["darwin"] }], { boxes: false }), { home: temp.make("home-"), run: elsewhere.run });
    expect(elsewhere.world.on).toBe(true);
  });

  test("an undo that fails is reported, and the next apply tries again", async () => {
    const { world, run } = box(true, 1);
    const report = await apply(planWith([step], { boxes: false }), { home: temp.make("home-"), run });
    expect(world.on).toBe(true);
    expect(report.findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Hedge could not undo step auto-box of the team pack, whose workflow boxes is off. The next hedge apply tries again.", repair: "apply" });
  });

  test("waits for the step's prerequisite and runs nothing in a pack whose step failed in this apply", async () => {
    const waiting = box(true);
    waiting.world.signedIn = false;
    const gated = planWith([{ ...step, after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    expect((await apply(gated, { home, run: waiting.run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(waiting.world.on).toBe(true);
    expect((await check(gated, { home, run: waiting.run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Hedge can undo it.", repair: "human" });
    waiting.world.signedIn = true;
    await apply(gated, { home, run: waiting.run });
    expect(waiting.world.on).toBe(false);
    const broken = box(true);
    await apply(planWith([{ id: "broken", run: ["broken"], check: ["broken"] }, step], { boxes: false }), { home: temp.make("home-"), run: broken.run });
    expect(broken.world.on).toBe(true);
  });

  test("a check that cannot tell before the prerequisite passes leaves a note that keeps doctor green, and the undo runs once it passes", async () => {
    const blind = box(true);
    blind.world.signedIn = false;
    const gated = planWith([{ ...step, check: ["box-state"], after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    const note = { id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Hedge can undo it." };
    expect((await apply(gated, { home, run: blind.run })).findings).toContainEqual(note);
    expect(blind.world.on).toBe(true);
    const doctor = await check(gated, { home, run: blind.run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.ok).toBe(true);
    blind.world.signedIn = true;
    await apply(gated, { home, run: blind.run });
    expect(blind.world.on).toBe(false);
  });

  test("a check that cannot tell once the prerequisite passes is a failure", async () => {
    const unsure = planWith([{ ...step, check: ["box-unsure"], after: "sign-in" }], { boxes: false });
    const home = temp.make("home-");
    const { world, run } = box(true);
    const finding = { id: "undo:auto-box", pack: "team", say: "Hedge cannot tell whether step auto-box of the team pack still holds what it set, though its workflow boxes is off.", repair: "apply" as const };
    expect((await apply(unsure, { home, run })).findings).toContainEqual(finding);
    expect(world.on).toBe(true);
    const doctor = await check(unsure, { home, run });
    expect(doctor.findings).toContainEqual(finding);
    expect(doctor.ok).toBe(false);
  });

  test("a dry run previews the undo without running it, and leaves out an undo that waits", async () => {
    const { world, run } = box(true);
    const gated = planWith([{ ...step, after: "sign-in" }], { boxes: false });
    const preview = await apply(gated, { home: temp.make("home-"), run, dryRun: true });
    expect(preview.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "hedge apply would undo it: workflow boxes is off" });
    expect(world.on).toBe(true);
    world.signedIn = false;
    const waiting = await apply(gated, { home: temp.make("home-"), run, dryRun: true });
    expect(waiting.actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
  });

  test("a Base step whose undo fails fails the apply", async () => {
    const off = planWith([step], { boxes: false });
    const base = { ...off, undo: off.undo!.map((item) => ({ ...item, pack: "base" })) };
    expect((await apply(base, { home: temp.make("home-"), run: box(true, 1).run })).ok).toBe(false);
    expect((await apply(off, { home: temp.make("home-"), run: box(true, 1).run })).ok).toBe(true);
  });

  test("a Base step whose check cannot tell fails the apply, but not while it waits for its prerequisite", async () => {
    const asBase = (steps: PackManifest["steps"]) => {
      const off = planWith(steps, { boxes: false });
      return { ...off, undo: off.undo!.map((item) => ({ ...item, pack: "base" })) };
    };
    expect((await apply(asBase([{ ...step, check: ["box-unsure"] }]), { home: temp.make("home-"), run: box(true).run })).ok).toBe(false);
    const waiting = box(true);
    waiting.world.signedIn = false;
    expect((await apply(asBase([{ ...step, check: ["box-state"], after: "sign-in" }]), { home: temp.make("home-"), run: waiting.run })).ok).toBe(true);
  });

  test("runs on the next apply after its pack leaves the profile, and doctor reports it until then", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    expect(world.on).toBe(true);
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await check(removed, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "The team pack is off, but step auto-box of the team pack still holds what it set. Run hedge apply to undo it.", repair: "apply" });
    expect((await apply(removed, { home, run, dryRun: true })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "hedge apply would undo it: the team pack is off" });
    expect(world.on).toBe(true);
    expect((await apply(removed, { home, run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "the team pack is off" });
    expect(world.on).toBe(false);
    world.on = true;
    expect((await apply(removed, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(world.on).toBe(true);
  });

  test("runs the undo the step had when it last applied, after a step left its pack's plan for a reason other than a workflow", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    await apply(planWith([{ ...step, workflow: undefined }], {}), { home, run });
    const moved = planWith([{ ...step, workflow: undefined, on: ["darwin"], undo: ["changed-undo"] }], {});
    const report = await apply(moved, { home, run });
    expect(report.actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "this machine no longer plans it" });
    expect(world.on).toBe(false);
  });

  test("leaves a step alone while its pack is in the profile but cannot be loaded, and never records a step it did not see hold", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    const outage = plan({ packs: ["team"], workflows: {} }, devbox, [engine]);
    expect((await apply(outage, { home, run })).actions.filter((action) => action.target.startsWith("step "))).toEqual([]);
    expect(world.on).toBe(true);
    const blocked = box(false);
    const fresh = temp.make("home-");
    await apply(planWith([{ ...step, after: "sign-in" }], {}), { home: fresh, run: async (command) => (command.join(" ") === "signed-in" ? 1 : blocked.run(command)) });
    blocked.world.on = true;
    await apply(plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]), { home: fresh, run: blocked.run });
    expect(blocked.world.on).toBe(true);
  });

  test("waits for the prerequisite the step had when it applied, after its pack leaves", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([{ ...step, after: "sign-in" }], {}), { home, run });
    expect(world.on).toBe(true);
    world.signedIn = false;
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await apply(removed, { home, run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Step auto-box of the team pack waits for sign-in before Hedge can undo it.", repair: "human" });
    expect(world.on).toBe(true);
    world.signedIn = true;
    await apply(removed, { home, run });
    expect(world.on).toBe(false);
  });

  test("an undo that fails after its pack leaves is reported, and the next apply tries again", async () => {
    const failing = box(false, 1);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run: failing.run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([step])]);
    expect((await apply(removed, { home, run: failing.run })).findings).toContainEqual({ id: "undo:auto-box", pack: "team", say: "Hedge could not undo step auto-box of the team pack, which is off. The next hedge apply tries again.", repair: "apply" });
    const working = box(true);
    await apply(removed, { home, run: working.run });
    expect(working.world.on).toBe(false);
  });

  test("stops when the step ledger is not one, rather than forget what it would undo", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/steps.json"), JSON.stringify({ version: 1, steps: [{ pack: "team", id: "auto-box" }] }));
    await expect(apply(planWith([step], {}), { home, run: box(true).run })).rejects.toThrow(".local/state/hedge/steps.json is not a Hedge step ledger");
  });

  test("reads the step's left probe instead of its check, when the check also passes with nothing to hold", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const doctored = { ...step, check: ["always-fine"], left: ["box-is-on"] };
    await apply(planWith([doctored], {}), { home, run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([doctored])]);
    expect((await apply(removed, { home, run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "the team pack is off" });
    expect(world.on).toBe(false);
    expect((await apply(removed, { home, run })).findings.map((finding) => finding.id)).not.toContain("undo:auto-box");
    const workflowOff = box(true);
    expect((await apply(planWith([doctored], { boxes: false }), { home: temp.make("home-"), run: workflowOff.run })).actions).toContainEqual({ target: "step team/auto-box", operation: "remove", reason: "workflow boxes is off" });
    expect(workflowOff.world.on).toBe(false);
    await expect(loadPacks(team([{ ...step, left: ["box-is-on"], undo: undefined }]).dir)).rejects.toThrow("steps auto-box: left needs an undo");
    await expect(loadPacks(team([{ ...step, left: "box-is-on" as unknown as string[] }]).dir)).rejects.toThrow("steps auto-box: left must be a command list");
  });

  test("doctor names what a human step left once its pack is off, until a person removes it, and keeps doctor green", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, undo: "Sign out with box logout." }];
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home, run });
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, leaving]);
    const note = { id: "left:sign-in", pack: "team", say: "The team pack is off. Sign out with box logout." };
    const doctor = await check(removed, { home, run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.ok).toBe(true);
    world.signedIn = false;
    expect((await check(removed, { home, run })).findings).not.toContainEqual(note);
    const never = box(true);
    never.world.signedIn = false;
    const fresh = temp.make("home-");
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home: fresh, run: never.run });
    never.world.signedIn = true;
    expect((await check(removed, { home: fresh, run: never.run })).findings.map((finding) => finding.id)).not.toContain("left:sign-in");
    await expect(loadPacks(withPack({ schema: 1, name: "team", summary: "Team.", human: [{ ...signIn, undo: "" }] }).dir)).rejects.toThrow("human sign-in: undo must say what a person does");
  });

  test("doctor reads a human step's left probe once it leaves, keeps its record through a probe that fails while planned, and forgets it once nothing is left", async () => {
    const { world, run } = box(true);
    const home = temp.make("home-");
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, left: ["box-is-on"], undo: "Turn the box off by hand." }];
    const kept = plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]);
    await apply(kept, { home, run });
    await apply(kept, { home, run: async (command) => (command.join(" ") === "signed-in" ? 127 : run(command)) });
    world.signedIn = false;
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, leaving]);
    const note = { id: "left:sign-in", pack: "team", say: "The team pack is off. Turn the box off by hand." };
    expect((await check(removed, { home, run })).findings).toContainEqual(note);
    world.on = false;
    await apply(removed, { home, run });
    world.on = true;
    expect((await check(removed, { home, run })).findings).not.toContainEqual(note);
    await expect(loadPacks(withPack({ schema: 1, name: "team", summary: "Team.", human: [{ ...signIn, left: ["box-is-on"] }] }).dir)).rejects.toThrow("human sign-in: left needs an undo");
  });

  test("records a human step from the probe the apply already ran", async () => {
    const { run } = box(true);
    const leaving = team([]);
    leaving.packs[0]!.manifest.human = [{ ...signIn, repair: ["sign-in-again"], undo: "Sign out with box logout." }];
    let probes = 0;
    const counted = async (command: string[]) => (command.join(" ") === "signed-in" && probes++, run(command));
    await apply(plan({ packs: ["team"], workflows: {} }, devbox, [engine, leaving]), { home: temp.make("home-"), run: counted });
    expect(probes).toBe(1);
  });

  test("doctor names the secrets folder of a pack that is off, and keeps it", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/hedge/secrets/team"), { recursive: true });
    mkdirSync(join(home, ".config/hedge/secrets/not a pack"), { recursive: true });
    writeFileSync(join(home, ".config/hedge/secrets/team/token"), "secret");
    const note = { id: "secrets:team", pack: "team", say: "The team pack is off. Its secrets stay in ~/.config/hedge/secrets/team. Delete that folder when you no longer need them." };
    expect((await check(planWith([], {}), { home, run: box(true).run })).findings).not.toContainEqual(note);
    const removed = plan({ packs: [], workflows: {} }, devbox, [engine, team([])]);
    await apply(removed, { home, run: box(true).run });
    expect(readFileSync(join(home, ".config/hedge/secrets/team/token"), "utf8")).toBe("secret");
    const doctor = await check(removed, { home, run: box(true).run });
    expect(doctor.findings).toContainEqual(note);
    expect(doctor.findings.map((finding) => finding.id)).not.toContain("secrets:not a pack");
    expect(doctor.ok).toBe(true);
  });

  const crew = (steps: PackManifest["steps"]) => withPack({ schema: 1, name: "crew", summary: "Crew.", steps });
  const gone = () => plan({ packs: [], workflows: {} }, devbox, [engine, team([step]), crew([{ ...step, id: "crew-box", run: ["crew-on"], check: ["crew-is-on"], undo: ["crew-off"] }])]);

  test("undoes a step that left before it applies the steps that stay, so a step that moved to another pack holds after one apply", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    const moved = plan({ packs: ["crew"], workflows: {} }, devbox, [engine, team([step]), crew([{ ...step, workflow: undefined }])]);
    const report = await apply(moved, { home, run });
    expect(report.ok).toBe(true);
    expect(world.on).toBe(true);
  });

  test("checks and undoes with the commands the step had when it last held, after its workflow goes off", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    await apply(planWith([step], {}), { home, run });
    await apply(planWith([{ ...step, check: ["broken"] }], { boxes: false }), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps each step as soon as it holds, so a step that stops the apply leaves the earlier ones to undo", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    const stops = async (command: string[]) => (command[0] === "stop" ? Promise.reject(new Error("stopped")) : run(command));
    await expect(apply(planWith([step, { id: "later", run: ["stop"] }], {}), { home, run: stops })).rejects.toThrow("stopped");
    await apply(gone(), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps a step that failed but holds what it set", async () => {
    const { world, run } = box(false);
    const home = temp.make("home-");
    const half = async (command: string[]) => (command.join(" ") === "box-on" ? ((world.on = true), 1) : run(command));
    expect((await apply(planWith([step], {}), { home, run: half })).findings).toContainEqual({ id: "step:auto-box", pack: "team", say: "Step auto-box of the team pack failed.", repair: "apply" });
    await apply(gone(), { home, run });
    expect(world.on).toBe(false);
  });

  test("keeps the steps of an apply that runs while another one does", async () => {
    const { world, run } = box(false);
    const other = { on: false };
    const home = temp.make("home-");
    const crewRun = async (command: string[]) => {
      const name = command.join(" ");
      if (name === "crew-is-on") return other.on ? 0 : 1;
      if (name === "crew-on") return (other.on = true), 0;
      if (name === "crew-off") return (other.on = false), 0;
      return run(command);
    };
    const crewPlan = plan({ packs: ["crew"], workflows: {} }, devbox, [engine, crew([{ ...step, id: "crew-box", workflow: undefined, run: ["crew-on"], check: ["crew-is-on"], undo: ["crew-off"] }])]);
    const meanwhile = async (command: string[]) => (command.join(" ") === "box-on" ? (await apply(crewPlan, { home, run: crewRun }), run(command)) : run(command));
    await apply(planWith([step], {}), { home, run: meanwhile });
    await apply(gone(), { home, run: crewRun });
    expect(world.on).toBe(false);
    expect(other.on).toBe(false);
  });

  test("refuses a step ledger that is a link, rather than run commands from another file", async () => {
    const home = temp.make("home-");
    const elsewhere = join(temp.make("elsewhere-"), "steps.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, steps: [] }));
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".local/state/hedge/steps.json"));
    await expect(apply(planWith([step], {}), { home, run: box(true).run })).rejects.toThrow(".local/state/hedge/steps.json must be a regular file");
  });

  test("needs an id no other step of the pack uses, once a step has an undo", async () => {
    await expect(loadPacks(team([step, { ...step, run: ["other"] }]).dir)).rejects.toThrow("steps auto-box: a step with an undo needs an id no other step of the pack uses");
    await loadPacks(team([{ id: "twin", run: ["on-linux"], on: ["linux"] }, { id: "twin", run: ["on-mac"], on: ["darwin"] }]).dir);
  });

  test("needs a check, so Hedge can tell what is left to undo", async () => {
    await expect(loadPacks(team([{ id: "auto-box", run: ["box-on"], undo: ["box-off"] }]).dir)).rejects.toThrow("steps auto-box: undo needs a check");
    await expect(loadPacks(team([{ ...step, check: [] }]).dir)).rejects.toThrow("steps auto-box: undo needs a check");
    await expect(loadPacks(team([{ ...step, undo: "box-off" as unknown as string[] }]).dir)).rejects.toThrow("steps auto-box: undo must be a command list");
  });
});

describe("a pack that a profile names only by its old name", () => {
  const renamed = withPack(
    {
      schema: 1,
      name: "notes",
      title: "Notes",
      summary: "Keeps notes.",
      aliases: [{ name: "library", workflows: ["recall"] }],
      workflows: [
        { id: "recall", name: "Recall", sentence: "Recalls notes.", default: true },
        { id: "shared", name: "Shared", sentence: "Shares notes.", default: true },
      ],
      jobs: [
        { id: "recall-pull", command: ["pull"], schedule: { every: "5m" }, workflow: "recall" },
        { id: "sweep", command: ["sweep"], schedule: { every: "1d" } },
      ],
      skills: ["skills/notes"],
    } as PackManifest,
    { "skills/notes/SKILL.md": "# Notes\n" },
  );

  test("gets only what the old name's workflows hold", () => {
    const result = plan({ packs: ["library"], settings: {} }, mac, [engine, renamed]);
    expect(result.jobs.filter((job) => job.pack === "notes").map((job) => job.id)).toEqual(["recall-pull"]);
    expect(result.files.some((item) => item.target.endsWith("skills/notes"))).toBe(false);
  });

  test("gets the whole pack once the profile names it", () => {
    const result = plan({ packs: ["library", "notes"], settings: {} }, mac, [engine, renamed]);
    expect(result.jobs.filter((job) => job.pack === "notes").map((job) => job.id)).toEqual(["recall-pull", "sweep"]);
    expect(result.files.some((item) => item.target.endsWith("skills/notes"))).toBe(true);
  });

  test("keeps a workflow outside the old name's workflows off, even when the profile turns it on", () => {
    const result = plan({ packs: ["library"], settings: {}, workflows: { shared: true } }, mac, [engine, renamed]);
    expect(result.workflows.filter((workflow) => workflow.pack === "notes").map(({ id, active }) => ({ id, active }))).toEqual([{ id: "recall", active: true }, { id: "shared", active: false }]);
  });

  test("meets a requirement written with the old name by the old name's workflows, and a requirement of the new name only by the new name", () => {
    const needing = (name: string, requires: string) => ({ schema: 1, name, summary: "Needs notes.", requires: [requires] }) as PackManifest;
    const sources = [engine, renamed, withPack(needing("old-reader", "library")), withPack(needing("new-reader", "notes"))];
    const result = plan({ packs: ["library", "old-reader", "new-reader"], settings: {} }, mac, sources);
    expect(result.packs.filter((pack) => pack.name.endsWith("reader")).map(({ name, available, reason }) => ({ name, available, reason }))).toEqual([
      { name: "old-reader", available: true, reason: undefined },
      { name: "new-reader", available: false, reason: "requires notes" },
    ]);
    expect(result.jobs.filter((job) => job.pack === "notes").map((job) => job.id)).toEqual(["recall-pull"]);
  });

  test("lists in the service catalog only the services that the hub runs for the old name", () => {
    const service = (id: string, port: number, workflow?: string) => ({ id, port, health: "/health", roles: ["hub", "solo"], ...(workflow ? { workflow } : {}) });
    const job = (id: string, workflow?: string) => ({ id, command: ["hedge", "run", `notes/${id}`], schedule: { every: "always" }, roles: ["hub", "solo"], ...(workflow ? { workflow } : {}) });
    const serving = withPack({ ...renamed.packs[0]!.manifest, served: [service("recall-api", 4700, "recall"), service("sweep-api", 4701)], jobs: [job("recall-api", "recall"), job("sweep-api")] } as PackManifest);
    const sources = [engine, serving];
    const onHub = plan({ packs: ["library"], hub: "hub-1", settings: {} }, { schema: 1, role: "linux", name: "hub-1" }, sources);
    const onNode = plan({ packs: ["library"], hub: "hub-1", settings: {} }, { schema: 1, role: "linux", name: "node-2" }, sources);
    expect(onHub.jobs.filter((item) => item.pack === "notes").map((item) => item.id)).toEqual(["recall-api"]);
    expect([onHub, onNode].map((result) => (result.catalog ?? []).map((entry) => `${entry.pack}/${entry.id}`))).toEqual([["notes/recall-api"], ["notes/recall-api"]]);
  });

  test("refuses an old name that a pack still has, or that two packs take", () => {
    const taking = (name: string) => withPack({ schema: 1, name, summary: "Takes library.", aliases: [{ name: "library", workflows: [] }] } as PackManifest);
    expect(() => plan({ packs: ["notes"], settings: {} }, mac, [engine, renamed, taking("boxes")])).toThrow("packs notes and boxes both take the old name library");
    expect(() => plan({ packs: ["notes"], settings: {} }, mac, [engine, renamed, withPack({ schema: 1, name: "library", summary: "Still here." } as PackManifest)])).toThrow("pack notes takes the old name library, which another pack still has");
  });
});
