import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armOf } from "./proof-triage.ts";
import { checkout, cleanFixtures, fakeModel, graded, settings, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const noFindings = (file: string) => `FINDINGS:\n(none)\nCOVERED: ${file}\n`;

async function triaged(triage: string | undefined, body: string, file = "feature.ts", content = "export const greet = (name: string) => name;\n") {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, ...triage === undefined ? {} : { "pull-requests.triage": triage } });
  pr.pullRequestState({ body });
  await pr.commit(file, content);
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", noFindings(file));
  return pr;
}

const firstLine = async (pr: Checkout, ...args: string[]) => JSON.parse((await pr.hedge("review", ...args)).output.split("\n")[0]!);
const roundRecord = (pr: Checkout, round: string) => JSON.parse(readFileSync(join(pr.pullRequest, "reviews", round, "triage.json"), "utf8"));
const oneWay = "## Merge risk\n\n<!-- merge-risk -->\n> 🔵 **Merge risk: medium** · one-way door\n> - **Tier:** non-critical\n<!-- /merge-risk -->\n";

test("the arm of a pull request comes from a stable hash of its repository and number, the same on every machine, and the setting decides who is treated", () => {
  const arms = Array.from({ length: 40 }, (_, pr) => armOf("split", "example/product", pr + 1));
  expect(new Set(arms)).toEqual(new Set(["treated", "control"]));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("split", "Example/Product", pr + 1))).toEqual(arms);
  expect(armOf("split", "example/product", 7)).toBe(armOf("split", "example/product", 7));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("on", "example/product", pr + 1))).toEqual(Array(40).fill("treated"));
  expect(Array.from({ length: 40 }, (_, pr) => armOf("off", "example/product", pr + 1))).toEqual(Array(40).fill("control"));
});

test("with triage on, hedge proof review prints the arm and the standard path of a medium-risk change outside every danger area, and the ledger keeps both", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"));

  expect(await firstLine(pr)).toMatchObject({ round: 1, triage: { arm: "treated", path: "standard" } });

  expect(JSON.parse(readFileSync(join(pr.pullRequest, "triage.json"), "utf8"))).toEqual({ setting: "on", arm: "treated" });
  expect(roundRecord(pr, "1")).toEqual({ commit: await pr.git("rev-parse", "HEAD"), arm: "treated", path: "standard", why: [] });
});

test("a high grade, a missing or unreadable grade, a changed file in a danger area, or a file on the critical-path list puts the pull request on the strict path", async () => {
  const pathAt = async (body: string, file?: string) => {
    const pr = await triaged("on", body, file);
    return (await firstLine(pr)).triage;
  };
  expect(await pathAt(graded("critical (b)", "high"))).toEqual({ arm: "treated", path: "strict", why: ["merge-risk grade high"] });
  expect(await pathAt("Greets new members.\n")).toEqual({ arm: "treated", path: "strict", why: ["merge-risk grade none"] });
  expect(await pathAt("Greets.\n\n<!-- merge-risk -->\n> **Merge risk: unclear**\n<!-- /merge-risk -->\n")).toEqual({ arm: "treated", path: "strict", why: ["merge-risk grade unreadable"] });
  expect(await pathAt(graded("non-critical", "medium"), "email-sender.ts")).toEqual({ arm: "treated", path: "strict", why: ["sends: email-sender.ts"] });
  expect(await pathAt(graded("non-critical", "medium"), "redact.ts")).toEqual({ arm: "treated", path: "strict", why: ["redaction: redact.ts"] });

  const listed = await triaged("on", graded("non-critical", "medium"), "pricing.ts");
  writeFileSync(join(listed.home, "critical-paths.md"), "# Critical paths\n\n- `pricing.ts`\n- billing/\n");
  listed.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(listed.env.HEDGE_SETTINGS!), "pull-requests.criticalPathFiles": "example/product=critical-paths.md" });
  expect((await firstLine(listed)).triage).toEqual({ arm: "treated", path: "strict", why: ["critical path: pricing.ts"] });
});

test("a test file in a danger area keeps the standard path, and a critical-path file hedge cannot read puts the pull request on the strict path", async () => {
  const tests = await triaged("on", graded("non-critical", "medium"), "email-sender.test.ts", "test(\"sends\", () => {});\n");
  expect((await firstLine(tests)).triage).toEqual({ arm: "treated", path: "standard", why: [] });

  const unreadable = await triaged("on", graded("non-critical", "medium"));
  unreadable.env.HEDGE_SETTINGS = JSON.stringify({ ...JSON.parse(unreadable.env.HEDGE_SETTINGS!), "pull-requests.criticalPathFiles": "example/product=missing.md" });
  expect((await firstLine(unreadable)).triage).toEqual({ arm: "treated", path: "strict", why: ["critical-path list unreadable"] });
});

test("a one-way door is excluded and runs today's flow", async () => {
  const pr = await triaged("on", oneWay);
  expect((await firstLine(pr)).triage).toEqual({ arm: "treated", path: "excluded", why: ["one-way door"] });
});

test("a final read records the path at its own head", async () => {
  const pr = await triaged("on", graded("non-critical", "medium"));
  await pr.hedge("review");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const reviewed = await pr.git("rev-parse", "HEAD");
  const fixed = await pr.commit("send-mail.ts", "export const send = () => {};\n");
  fakeModel(pr, "REVIEWER", noFindings("send-mail.ts"));

  expect(await firstLine(pr, "--scope", "final", "--base", reviewed)).toMatchObject({ round: "final", triage: { arm: "treated", path: "strict" } });
  expect(roundRecord(pr, "final-1")).toEqual({ commit: fixed, arm: "treated", path: "strict", why: ["sends: send-mail.ts"] });
  expect(roundRecord(pr, "1")).toMatchObject({ commit: reviewed, path: "standard" });
});

test("with triage off, or not set, hedge proof review prints and records nothing of it", async () => {
  for (const setting of ["off", undefined]) {
    const pr = await triaged(setting, graded("critical (b)", "high"));
    expect(await firstLine(pr)).not.toHaveProperty("triage");
    expect(existsSync(join(pr.pullRequest, "triage.json"))).toBe(false);
    expect(existsSync(join(pr.pullRequest, "reviews/1/triage.json"))).toBe(false);
  }
});
