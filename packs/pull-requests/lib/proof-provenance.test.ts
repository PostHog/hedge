import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const verifiedAtHead = "Provenance verified by code: captured by the Hedge runner at";
const verifiedRule = 'A kind marked "Provenance verified by code" ran under the Hedge runner';
const allVerified = "Every owed kind's provenance is verified by code";
const testOnlyFact = "Hedge checked in code that every file this diff changes is a test file that no production file names";
const lastLine = (output: string) => output.split("\n").at(-1);

async function ranLiveRun(pr: Checkout) {
  const code = await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
  expect((await pr.hedge("run", "--kind", "live-run", "--", "echo", "hi ada")).code).toBe(0);
  await pr.hedge("require", "--kinds", "live-run");
  await reviewHead(pr);
  rmSync(join(pr.repository, "findings.md"));
  return code;
}

const runRecord = (pr: Checkout, commit: string) => {
  const directory = join(pr.pullRequest, "runs", commit, "live-run");
  const [name] = readdirSync(directory);
  return { path: join(directory, name!), record: JSON.parse(readFileSync(join(directory, name!), "utf8")) };
};

test("a runner capture records its command, commit, exit, run times and directory, and the gate and judge show that provenance", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "JUDGE", verdict());
  const head = await ranLiveRun(pr);

  const gate = await pr.hedge("gate");

  expect(runRecord(pr, head).record).toEqual({ command: ["echo", "hi ada"], commit: head, exitCode: 0, startedAt: "2026-10-25T12:00:00.000Z", finishedAt: "2026-10-25T12:00:00.000Z", cwd: pr.repository });
  expect(gate.code).toBe(0);
  expect(gate.output).toContain(`live-run: evidence at HEAD in ${join(pr.pullRequest, head, "live-run")}; captured by the Hedge runner at ${head.slice(0, 7)}: 1 run(s), each exit 0 on a clean tree, from 2026-10-25T12:00:00.000Z to 2026-10-25T12:00:00.000Z`);
  const prompt = judge.prompts().at(-1)!;
  expect(prompt).toContain(`${verifiedAtHead} ${head.slice(0, 7)}: 1 run(s), each exit 0 on a clean tree, from 2026-10-25T12:00:00.000Z to 2026-10-25T12:00:00.000Z, at HEAD.`);
  expect(prompt).toContain(`captured by the Hedge runner, exit 0, at \`${head.slice(0, 7)}\`, clean at both checks, ran from 2026-10-25T12:00:00.000Z to 2026-10-25T12:00:00.000Z`);
  expect(prompt).toContain(verifiedRule);
  expect(prompt).toContain(allVerified);
});

test("a run record from before provenance keeps its runner mark but is not verified by code", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "JUDGE", verdict());
  const head = await ranLiveRun(pr);
  const { path, record } = runRecord(pr, head);
  writeFileSync(path, JSON.stringify({ command: record.command }));

  const gate = await pr.hedge("gate");

  expect(gate.code).toBe(0);
  expect(gate.output).toContain(`live-run: evidence at HEAD in ${join(pr.pullRequest, head, "live-run")}\n`);
  const prompt = judge.prompts().at(-1)!;
  expect(prompt).toContain(`captured by the Hedge runner, exit 0, at \`${head.slice(0, 7)}\`, clean at both checks\n`);
  expect(prompt).not.toContain(verifiedAtHead);
  expect(prompt).not.toContain(verifiedRule);
});

test("a run record that names another commit, a failed exit or a finish before its start reads as an author file", async () => {
  for (const tampered of [{ commit: "f".repeat(40) }, { exitCode: 1 }, { finishedAt: "2026-10-25T11:59:59.000Z" }]) {
    const pr = await checkout();
    const judge = fakeModel(pr, "JUDGE", verdict());
    const head = await ranLiveRun(pr);
    const { path, record } = runRecord(pr, head);
    writeFileSync(path, JSON.stringify({ ...record, ...tampered }));

    expect((await pr.hedge("gate")).code).toBe(0);

    const prompt = judge.prompts().at(-1)!;
    expect(prompt).not.toContain("captured by the Hedge runner");
    expect(prompt).not.toContain(verifiedRule);
    cleanFixtures();
  }
});

test("evidence at a commit carries to HEAD across commits that change only tests, verified by code, and stops at a production change", async () => {
  const pr = await checkout();
  const judge = fakeModel(pr, "JUDGE", verdict());
  const proved = await ranLiveRun(pr);
  await pr.commit("feature.test.ts", "expect(greet(\"ada\")).toBe(\"hi ada\");\n");

  const carried = await pr.hedge("gate");

  expect(carried.code).toBe(0);
  expect(carried.output).toContain(`live-run: evidence of ${proved.slice(0, 7)} carried across 1 quiet commit(s) (test-only delta); captured by the Hedge runner at ${proved.slice(0, 7)}`);
  const prompt = judge.prompts().at(-1)!;
  expect(prompt).toContain(`${verifiedAtHead} ${proved.slice(0, 7)}`);
  expect(prompt).toContain("hedge carried it to HEAD across clean merges of the base and commits that change only test files no production file names.");
  expect(prompt).toContain(allVerified);

  await pr.commit("feature.ts", "export const greet = (name: string) => `hello ${name}`;\n");
  const changed = await pr.hedge("gate");
  expect(changed.code).toBe(1);
  expect(changed.output).toContain(`live-run: missing at HEAD; the newest evidence is at ${proved.slice(0, 7)}`);
});

test("the judge learns that a diff of only test files is test-only, and a diff with production code is not", async () => {
  const promptFor = async (files: Record<string, string>) => {
    const pr = await checkout();
    const judge = fakeModel(pr, "JUDGE", verdict());
    for (const [file, content] of Object.entries(files)) await pr.commit(file, content);
    await reviewHead(pr);
    await pr.hedge("require", "--none", "--reason", "Tests only");
    expect((await pr.hedge("gate")).code).toBe(0);
    return judge.prompts().at(-1)!;
  };
  const spec = "expect(total([1, 2])).toBe(3);\n";

  expect(await promptFor({ "billing.test.ts": spec })).toContain(testOnlyFact);
  expect(await promptFor({ "billing.ts": "export const total = (items: number[]) => items.length;\n", "billing.test.ts": spec })).not.toContain(testOnlyFact);
});

test("a judge failure without a reason still names one on the gate's last line", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "JUDGE", verdict({ proof: { verdict: "fail", reason: " ", citations: [] } }));

  const gate = await pr.hedge("gate");

  expect(gate.code).toBe(1);
  expect(lastLine(gate.output)).toBe("gate: fail (exit 1): judge proof: fail: the judge gave no reason");
});
