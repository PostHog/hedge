import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, issueNode } from "./testing.ts";
import { mapRef, proseLines } from "./wayfinder.ts";

const usage = "Usage: hedge map";

test("a map is a URL, an owner/repo#number, or a number on the tracker", () => {
  const tracker = () => "acme/maps";
  expect(mapRef("https://github.com/globex/plans/issues/4", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 4 });
  expect(mapRef("globex/plans#5", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 5 });
  expect(mapRef("#6", usage, tracker)).toEqual({ owner: "acme", repo: "maps", number: 6 });
  expect(mapRef("7", usage, tracker)).toEqual({ owner: "acme", repo: "maps", number: 7 });
  expect(() => mapRef("7", usage)).toThrow("Set orchestration.tracker");
  expect(() => mapRef("maps", usage, tracker)).toThrow(usage);
});

test("the tracker is read only when the map names no repo", () => {
  const tracker = () => { throw new Error("tracker read"); };
  expect(mapRef("globex/plans#5", usage, tracker)).toEqual({ owner: "globex", repo: "plans", number: 5 });
  expect(() => mapRef("5", usage, tracker)).toThrow("tracker read");
});

test("prose lines skip fenced code", () => {
  expect(proseLines("a\n```\nb\n```\nc\n~~~ts\nd\n~~~")).toEqual(["a", "c"]);
});

test("a fence closes only on the same character, at least as long as its opener, with no info string", () => {
  expect(proseLines("a\n````md\n```\n- hidden\n```\n````\nb")).toEqual(["a", "b"]);
  expect(proseLines("a\n~~~\n```\nhidden\n~~~\nb")).toEqual(["a", "b"]);
  expect(proseLines("a\n```\n~~~\nhidden\n```\nb")).toEqual(["a", "b"]);
  expect(proseLines("a\n```\n```js\nhidden\n```\nb")).toEqual(["a", "b"]);
  expect(proseLines("a\n```\nhidden\n`````  \nb")).toEqual(["a", "b"]);
  expect(proseLines("a\n```a`b\nshown")).toEqual(["a", "```a`b", "shown"]);
  expect(proseLines("a\n```\n    ```\n- hidden\n```\nb")).toEqual(["a", "b"]);
  expect(proseLines("- item\n    ```\n    code\n    ```\nafter")).toEqual(["- item", "after"]);
  expect(proseLines("- item\n  ```\n  code\n     ```\nafter")).toEqual(["- item", "after"]);
  expect(proseLines("a\n````\nhidden to the end\n```")).toEqual(["a"]);
});

test("the Orchestration pack hardcodes no repository, owner, or tracker", async () => {
  const root = join(import.meta.dir, "..");
  const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("testing.ts"));
  const repositoryLiteral = /["'`](?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#\d+|\/issues)/;
  const githubOwner = /github\.com\/(?!\$\{)[A-Za-z0-9_-]+/;
  const hits = await Promise.all(files.map(async (path) => {
    const lines = (await readFile(join(root, path), "utf8")).split("\n");
    return lines.flatMap((line, index) => (repositoryLiteral.test(line) || githubOwner.test(line) ?[`${path}:${index + 1}`] : []));
  }));
  expect(files).toContain("lib/frontier.ts");
  expect(hits.flat()).toEqual([]);
});

test("reads that run at once and all meet the spent GraphQL rate limit print the REST notice once", async () => {
  const home = await mkdtemp(join(tmpdir(), "hedge-wayfinder-"));
  try {
    const repository = "acme/maps";
    const tickets = [2, 3, 4, 5].map((number) => issueNode(repository, number));
    const bin = await fakeGitHub(home, { issues: [issueNode(repository, 1, { children: tickets })], graphqlError: "API rate limit already exceeded for user ID 1." });
    const script = `import { fetchDiscussionFromGitHub } from ${JSON.stringify(join(import.meta.dir, "wayfinder.ts"))};
await Promise.all([2, 3, 4, 5].map((number) => fetchDiscussionFromGitHub("acme", "maps", number)));`;
    const child = Bun.spawn(["bun", "--eval", script], { env: { ...Bun.env, HOME: home, PATH: `${bin}:${Bun.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect({ stderr, code }).toEqual({ stderr: "hedge: GitHub's GraphQL rate limit is spent, so this command reads issues over REST.\n", code: 0 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
