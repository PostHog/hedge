import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localLedger } from "./decision-ledger.ts";
import { proofCommand } from "./proof-cli.ts";
import { judgePrompt } from "./proof-judge.ts";
import { proofGate, requireProofs, saveProof, type DevPull } from "./proof.ts";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

const prod = { repository: "example/charts", pr: 12, commit: "a".repeat(40) };
const dev = { repository: "example/charts", pr: 11 };
const mergedAt = "2026-11-17T09:00:00Z";

async function prodPr() {
  const home = mkdtempSync(join(tmpdir(), "hedge-dev-observed-"));
  homes.push(home);
  expect(await requireProofs(home, prod, [], "claude", dev)).toEqual(["dev-observed"]);
  return {
    home,
    gate: (devPull: () => DevPull) => proofGate(home, prod, { ci: () => ({ state: "green", detail: "all pass" }), pushedHead: () => ({ commit: prod.commit }), openBotFindings: async () => [], ledger: localLedger(home), devPull }),
    async observe(output: string, at: string) {
      const file = join(home, `${at}.log`);
      writeFileSync(file, output);
      const saved = await saveProof(home, prod, file, "dev-observed");
      utimesSync(saved, new Date(at), new Date(at));
    },
  };
}

const kindLine = (lines: string[]) => lines.find((line) => line.startsWith("dev-observed:"));

test("a prod PR waits on the dev result until the dev PR merged and its observation was saved after the merge", async () => {
  const pr = await prodPr();
  const unmerged = await pr.gate(() => ({}));
  expect(unmerged.code).toBe(1);
  expect(kindLine(unmerged.lines)).toBe("dev-observed: waiting on the dev result of example/charts#11: the dev PR is not merged yet");

  const unreadable = await pr.gate(() => { throw new Error("HTTP 502\nmore"); });
  expect(kindLine(unreadable.lines)).toBe("dev-observed: waiting on the dev result of example/charts#11: cannot read the dev PR (HTTP 502)");

  await pr.observe("$ dev-check\nworker-0 Running\nexit=0", "2026-11-17T08:00:00Z");
  const early = await pr.gate(() => ({ mergedAt, mergeCommit: "d".repeat(40) }));
  expect(kindLine(early.lines)).toStartWith("dev-observed: waiting on the dev result of example/charts#11: the dev PR merged at 2026-11-17T09:00:00Z as ddddddd, after the newest dev-observed evidence, saved at 2026-11-17T08:00:00.000Z.");
  expect(early.evidence.find((proof) => proof.kind === "dev-observed")?.directory).toBeUndefined();

  await pr.observe("$ dev-check --logs\npolled 3 jobs, 0 retries\nexit=0", "2026-11-17T09:30:00Z");
  const observed = await pr.gate(() => ({ mergedAt, mergeCommit: "d".repeat(40) }));
  expect(kindLine(observed.lines)).toStartWith("dev-observed: evidence at HEAD in ");
  expect(observed.lines).toContain("dev result: example/charts#11 merged at 2026-11-17T09:00:00Z as ddddddd; the dev-observed evidence was saved at 2026-11-17T09:30:00.000Z, after the merge");

  const { prompt } = await judgePrompt({
    cwd: pr.home, from: "f".repeat(40), commit: prod.commit, diff: "", crossFamily: true, ci: observed.ci, owed: observed.owed!, ledger: observed.lines,
    evidence: observed.evidence, reviews: [], rubric: "", references: [],
  });
  expect(prompt).toContain("dev result: example/charts#11 merged at 2026-11-17T09:00:00Z");
  expect(prompt).toContain("polled 3 jobs, 0 retries");
  expect(prompt).toContain("never fail a question because the observation was saved after the review");
});

test("require --after-dev owes dev-observed, which needs its dev PR, and the dev PR does not change", async () => {
  const home = mkdtempSync(join(tmpdir(), "hedge-dev-observed-require-"));
  homes.push(home);
  const printed: string[] = [];
  const require = (...args: string[]) => proofCommand(["require", ...args, "--author", "claude", "--repo", prod.repository, "--pr", String(prod.pr), "--commit", prod.commit], { home, cwd: home, env: {}, print: (text) => printed.push(text) });
  await expect(require("--kinds", "dev-observed")).rejects.toThrow("dev-observed needs --after-dev");
  await expect(require("--after-dev", "charts#11")).rejects.toThrow("--after-dev takes the dev PR as <owner/name>#<number>");
  await require("--kinds", "prod-shape", "--after-dev", "example/charts#11");
  await require("--kinds", "post-deploy-watch");
  expect(printed).toEqual(["prod-shape,dev-observed", "prod-shape,post-deploy-watch,dev-observed"]);
  await expect(require("--after-dev", "example/charts#10")).rejects.toThrow("already waits on dev PR example/charts#11");
});
