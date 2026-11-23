import { afterEach, expect, test } from "bun:test";
import { checkout, cleanFixtures, reviewHead, settings } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function reviewed() {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  return { pr, head };
}

const ciLine = (output: string) => output.split("\n").find((line) => line.startsWith("ci: "));

test("only the base branch's required checks decide CI, and the rest print as not required", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);

  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }, { name: "preview", bucket: "pending" }]);
  const advisory = await pr.hedge("gate");
  expect(advisory.code).toBe(0);
  expect(ciLine(advisory.output)).toBe("ci: green, 1 required check(s) pass; not required: failing: lint; 1 still running");

  pr.ci([{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
  const red = await pr.hedge("gate");
  expect(red.code).toBe(1);
  expect(ciLine(red.output)).toStartWith("ci: red, required failing: test. Fix it");

  pr.ci([{ name: "lint", bucket: "pass" }]);
  const missing = await pr.hedge("gate");
  expect(missing.code).toBe(75);
  expect(ciLine(missing.output)).toBe("ci: pending, required not reported yet: test");
});

test("classic branch protection adds required checks, and a check from another app does not count for a pinned one", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "build", integration_id: 7 }], { classic: ["deploy"] });
  pr.statuses([{ context: "deploy", state: "success" }]);

  pr.ci([{ name: "build", bucket: "pass", app: 9 }]);
  const spoofed = await pr.hedge("gate");
  expect(spoofed.code).toBe(75);
  expect(ciLine(spoofed.output)).toBe("ci: pending, required not reported yet: build");

  pr.ci([{ name: "build", bucket: "pass", app: 7 }]);
  const green = await pr.hedge("gate");
  expect(ciLine(green.output)).toBe("ci: green, 2 required check(s) pass");
  expect(green.code).toBe(0);
});

test("a check pinned to an app passes on a commit status its app's bot posts", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Visual Review / storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.statuses([{ context: "Visual Review / storybook", state: "success", by: "product[bot]" }]);
  const green = await pr.hedge("gate");
  expect(ciLine(green.output)).toBe("ci: green, 1 required check(s) pass");
  expect(green.code).toBe(0);
});

test("a check pinned to an app does not pass on a status from a person or from another app's bot", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Visual Review / storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.githubApp("other", 9);

  pr.statuses([{ context: "Visual Review / storybook", state: "success", by: "a-maintainer" }]);
  const byPerson = await pr.hedge("gate");
  expect(byPerson.code).toBe(75);
  expect(ciLine(byPerson.output)).toBe("ci: pending, required not reported yet: Visual Review / storybook");

  pr.statuses([{ context: "Visual Review / storybook", state: "success", by: "other[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Visual Review / storybook");
});

test("a newer status from anyone but the pinned app holds the pinned check, as GitHub does", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Visual Review / storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);

  pr.statuses([{ context: "Visual Review / storybook", state: "failure", by: "a-maintainer" }, { context: "Visual Review / storybook", state: "success", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Visual Review / storybook; not required: failing: Visual Review / storybook");

  pr.statuses([{ context: "Visual Review / storybook", state: "success", by: "a-maintainer" }, { context: "Visual Review / storybook", state: "failure", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Visual Review / storybook");
});

test("the pinned app's rerun clears its own older failure", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Visual Review / storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.statuses([{ context: "Visual Review / storybook", state: "success", by: "product[bot]" }, { context: "Visual Review / storybook", state: "failure", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 1 required check(s) pass");
});

test("a pinned check its app passed by status still fails on a failing check run of the same name", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "build", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.ci([{ name: "build", bucket: "fail", app: 9 }]);
  pr.statuses([{ context: "build", state: "success", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: red, required failing: build");
});

test("a pinned check waits when its app posted the check's context in another spelling too", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Visual Review / storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.statuses([{ context: "Visual Review / Storybook", state: "failure", by: "product[bot]" }, { context: "Visual Review / storybook", state: "success", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Visual Review / storybook; not required: failing: Visual Review / Storybook");
});

test("the gate's check list marks a status the pinned app posted", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "storybook", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.ci("none");
  pr.statuses([{ context: "storybook", state: "success", by: "product[bot]" }, { context: "lint", state: "failure", by: "a-maintainer" }]);
  const gate = await pr.hedge("gate", "--json");
  expect(JSON.parse(gate.output).ci.checks).toEqual(["lint (status): fail", "storybook (status, app 7): pass"]);
});

test("an app answer without a numeric id leaves a pinned check unreported and its status unmarked", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "deploy", integration_id: 7 }]);
  pr.githubApp("product", { answer: JSON.stringify({ id: "7", slug: "product" }) });
  pr.ci("none");
  pr.statuses([{ context: "deploy", state: "success", by: "product[bot]" }]);
  const gate = await pr.hedge("gate", "--json");
  expect(JSON.parse(gate.output).ci.checks).toEqual(["deploy (status): pass"]);
  expect(JSON.parse(gate.output).ci.line).toBe("ci: pending, required not reported yet: deploy");
});

test("a status from a bot without an app leaves a pinned check unreported", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "deploy", integration_id: 7 }]);
  pr.statuses([{ context: "deploy", state: "success", by: "gone[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: deploy");
});

test("a status whose app GitHub cannot read makes CI unknown", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "deploy", integration_id: 7 }]);
  pr.githubApp("product", { error: "gh: Service Unavailable (HTTP 503)" });
  pr.ci([{ name: "deploy", bucket: "pass", app: 7 }]);
  pr.statuses([{ context: "deploy", state: "failure", by: "product[bot]" }]);
  const unknown = await pr.hedge("gate");
  expect(unknown.code).toBe(1);
  expect(ciLine(unknown.output)).toStartWith("ci: unknown, cannot read the app behind product[bot] over REST (gh: Service Unavailable (HTTP 503))");
});

test("an app GitHub cannot read behind a status that decides no pinned check leaves CI readable", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "CI / scan", integration_id: 7 }]);
  pr.githubApp("docs", { error: "gh: Service Unavailable (HTTP 503)" });
  pr.ci([{ name: "CI / build", bucket: "pass", app: 7 }]);

  pr.statuses([{ context: "Docs / preview", state: "failure", by: "docs[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: CI / scan; not required: failing: Docs / preview");

  pr.statuses([{ context: "CI / preview", state: "failure", by: "docs[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: CI / scan; not required: failing: CI / preview");

  pr.pullRequestState({ draft: true });
  pr.ci([{ name: "CI / scan", bucket: "pass", app: 7 }, { name: "CI / build", bucket: "pass", app: 7 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 1 required check(s) pass; not required: failing: CI / preview");
});

test("on a draft, an app GitHub cannot read behind a sibling status that cannot change the waiver leaves CI readable", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / scan", integration_id: 7 }]);
  pr.githubApp("docs", { error: "gh: Service Unavailable (HTTP 503)" });

  pr.ci([{ name: "CI / build", bucket: "pass", app: 7 }]);
  pr.statuses([{ context: "CI / preview", state: "success", by: "docs[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: CI / scan (its workflow finished without posting it)");

  pr.statuses([{ context: "CI / preview", state: "failure", by: "docs[bot]" }]);
  pr.ci("none");
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: CI / scan; not required: failing: CI / preview");

  pr.ci([{ name: "CI / build", bucket: "pending", app: 7 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: pending, required not reported yet: CI / scan");
});

test("a required status context not pinned to an app reads its newest status, whoever posted it", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "deploy" }]);
  pr.statuses([{ context: "deploy", state: "success", by: "a-maintainer" }, { context: "deploy", state: "failure", by: "ci[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 1 required check(s) pass");
});

test("without required checks, a status context reads its newest status, whoever posted it", async () => {
  const { pr } = await reviewed();
  pr.statuses([{ context: "deploy", state: "success", by: "new-ci[bot]" }, { context: "deploy", state: "failure", by: "old-ci[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: green, 2 check(s) on ");
});

test("on a draft, a status from the pinned app's bot passes its own check but withholds no sibling", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / lint", integration_id: 7 }, { context: "CI / scan", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.ci("none");
  pr.statuses([{ context: "CI / lint", state: "success", by: "product[bot]" }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(75);
  expect(ciLine(gate.output)).toBe("ci: pending, required not reported yet: CI / scan");
});

test("on a draft, a pinned check's workflow withholds a missing check only while every sibling status from its app passes", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / lint", integration_id: 7 }, { context: "CI / scan", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.ci([{ name: "CI / build", bucket: "pass", app: 7 }]);
  pr.statuses([{ context: "CI / lint", state: "success", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 1 required check(s) pass; withheld from drafts, required once ready: CI / scan (its workflow finished without posting it)");

  pr.statuses([{ context: "CI / lint", state: "success", by: "product[bot]" }, { context: "CI / setup", state: "failure", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: CI / scan; not required: failing: CI / setup");
  pr.statuses([{ context: "CI / lint", state: "success", by: "product[bot]" }, { context: "CI / setup", state: "pending", by: "product[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: pending, required not reported yet: CI / scan");
});

test("on a draft, a failing status from someone else beside a pinned check's workflow does not hold it, as on main", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / scan", integration_id: 7 }]);
  pr.githubApp("product", 7);
  pr.ci([{ name: "CI / build", bucket: "pass", app: 7 }]);
  pr.statuses([{ context: "CI / deploy-preview", state: "failure", by: "a-maintainer" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: CI / scan (its workflow finished without posting it); not required: failing: CI / deploy-preview");
});

test("on a draft whose required checks are all unpinned, passing sibling statuses withhold a missing one, as on main", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / scan" }]);
  pr.ci("none");
  pr.statuses([{ context: "CI / lint", state: "success", by: "ci[bot]" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: CI / scan (its workflow finished without posting it)");
});

test("a draft passes without a required check its workflow withholds from drafts, and a ready PR still needs it", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "Backend / Test results" }]);
  pr.pullRequestState({ draft: true });

  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "pending" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");

  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "pass" }]);
  const withheld = await pr.hedge("gate");
  expect(withheld.code).toBe(0);
  expect(ciLine(withheld.output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: Backend / Test results (its workflow finished without posting it)");

  pr.pullRequestState({ draft: false });
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");
});

test("on a draft, a failed sibling does not withhold a required check, and the wait for it names the failure", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });

  pr.required("main", [{ context: "Backend / Test results" }]);
  pr.ci([{ name: "Backend / Unit (1)", bucket: "pass" }, { name: "Backend / Unit (2)", bucket: "fail" }]);
  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(75);
  expect(ciLine(gate.output)).toBe("ci: pending, required not reported yet: Backend / Test results; not required: failing: Backend / Unit (2)");
});

test("on a draft, a check from another app than the pinned one neither passes nor withholds it", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "CI / test", integration_id: 7 }]);
  pr.ci([{ name: "CI / test", bucket: "pass", app: 9 }, { name: "CI / lint", bucket: "pass", app: 7 }]);
  const spoofed = await pr.hedge("gate");
  expect(spoofed.code).toBe(75);
  expect(ciLine(spoofed.output)).toBe("ci: pending, required not reported yet: CI / test");

  pr.ci([{ name: "CI / lint", bucket: "pass", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: CI / test");
});

test("on a draft, a pinned check listed as posted only once ready reads as withheld when its workflow's checks from any app finished and passed, and a ready PR still needs it", async () => {
  const { pr } = await reviewed();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.draftSkippedChecks": "example/product=Backend / Test results" });
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "Backend / Test results", integration_id: 7 }]);

  pr.ci([{ name: "Backend / Gate", bucket: "pass", app: 9 }, { name: "Backend / Unit", bucket: "pending", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");

  pr.ci([{ name: "Backend / Gate", bucket: "pass", app: 9 }, { name: "Backend / Unit", bucket: "pass", app: 9 }]);
  const withheld = await pr.hedge("gate");
  expect(withheld.code).toBe(0);
  expect(ciLine(withheld.output)).toBe("ci: green, 0 required check(s) pass; withheld from drafts, required once ready: Backend / Test results (its workflow finished without posting it)");

  pr.pullRequestState({ draft: false });
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");
});

test("on a draft, a pinned check posted only once ready still waits when its workflow failed, when only statuses report, or when another app posted it", async () => {
  const { pr } = await reviewed();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.draftSkippedChecks": "example/product=Backend / Test results" });
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "Backend / Test results", integration_id: 7 }]);

  pr.ci([{ name: "Backend / Gate", bucket: "pass", app: 9 }, { name: "Backend / Unit", bucket: "fail", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results; not required: failing: Backend / Unit");

  pr.ci("none");
  pr.statuses([{ context: "Backend / Gate", state: "success" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");

  pr.statuses([]);
  pr.ci([{ name: "Backend / Gate", bucket: "pass", app: 9 }, { name: "Backend / Test results", bucket: "pass", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");
});

test("on a draft, a pinned check is not withheld on another app's checks for another repository's listing", async () => {
  const { pr } = await reviewed();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.draftSkippedChecks": "example/other=Backend / Test results" });
  pr.pullRequestState({ draft: true });
  pr.required("main", [{ context: "Backend / Test results", integration_id: 7 }]);
  pr.ci([{ name: "Backend / Gate", bucket: "pass", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required not reported yet: Backend / Test results");
});

test("the newest run of a check from each app decides: a rerun clears an older failure, and another app's pass hides no failure", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "fail" }, { name: "test", bucket: "pass" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: green, 1 required check(s) pass");

  pr.ci([{ name: "test", bucket: "pass" }, { name: "test", bucket: "fail" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: red, required failing: test");

  pr.ci([{ name: "test", bucket: "fail", app: 7 }, { name: "test", bucket: "pass", app: 9 }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: red, required failing: test");
});

test("CI is unknown and nothing is cached when GitHub does not answer for the rulesets, and a plan without rulesets counts every check", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pass" }, { name: "security", bucket: "fail" }]);
  pr.required("main", { error: "gh: Service Unavailable (HTTP 503)" }, { classic: ["test"] });
  const unknown = await pr.hedge("gate");
  expect(unknown.code).toBe(1);
  expect(ciLine(unknown.output)).toStartWith("ci: unknown, cannot read the rulesets of main over REST (gh: Service Unavailable (HTTP 503))");

  pr.required("main", [{ context: "security" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toStartWith("ci: red, required failing: security");
});

test("a private repository whose plan has no rulesets still counts its classic protection", async () => {
  const { pr } = await reviewed();
  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }]);
  pr.required("main", { error: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" }, { classic: ["test"] });
  const classic = await pr.hedge("gate");
  expect(ciLine(classic.output)).toBe("ci: green, 1 required check(s) pass; not required: failing: lint");
});

test("required checks on a later page of rules count", async () => {
  const { pr } = await reviewed();
  pr.required("main", [], { others: 100 });
  pr.required("main", [{ context: "security" }], { page: 2 });
  pr.ci([{ name: "test", bucket: "pass" }, { name: "security", bucket: "pending" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required waiting on: security");
});

test("a stacked PR whose base requires nothing is held to the default branch's required checks", async () => {
  const { pr } = await reviewed();
  pr.pullRequestState({ base: "feature-base" });
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "pending" }, { name: "lint", bucket: "pass" }]);
  expect(ciLine((await pr.hedge("gate")).output)).toBe("ci: pending, required waiting on: test (required by main; the base feature-base requires none)");
});

test("with --repo and --pr, the gate reads the PR head and the required checks over REST, never through gh pr view", async () => {
  const { pr } = await reviewed();
  pr.required("main", [{ context: "test" }]);
  const before = pr.githubCalls().length;
  expect((await pr.hedge("gate", "--repo", "example/product", "--pr", "42")).code).toBe(0);
  const calls = pr.githubCalls().slice(before);
  expect(calls).toContainEqual("api repos/example/product/pulls/42");
  expect(calls).toContainEqual(expect.stringMatching(/^api repos\/example\/product\/rules\/branches\/main/));
  expect(calls.filter((call) => call.startsWith("pr view"))).toEqual([]);
});
