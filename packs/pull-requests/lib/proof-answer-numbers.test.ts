import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answeredFindings } from "./proof.ts";
import { checkout, cleanFixtures, fakeModel, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lensAnswer = `I read the whole diff.

- **Greeting:** it reads the member's name once.
- **Errors:** a failed send is logged.

FINDINGS:
- feature.txt:1 | major | LENS | an empty name -> a blank greeting | guard it | anchor: greet the new member
- feature.txt:1 | minor | LENS | a typo -> confusion | fix it | anchor: greet the new member

COVERED:

- feature.txt
- other.txt

TESTS:

- feature.test.ts:3 The LENS test waits on a real timer. Control the clock.
`;

function lensNamingReviewer(pr: Checkout) {
  const reply = join(pr.home, "lens-answer");
  writeFileSync(reply, lensAnswer);
  pr.env.HEDGE_PROOF_REVIEWER = `lens=$(awk '/^Lens: / && !seen { sub(/^Lens: /, ""); print; seen = 1 }'); sed "s/LENS/$lens/g" "${reply}"`;
}

async function panelRound() {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  lensNamingReviewer(pr);
  await pr.hedge("review", "--lens", "correctness", "--lens", "sweep");
  return { pr, waited: await pr.hedge("review", "--wait") };
}

const lenses = ["Correctness", "Risk", "Fresh eyes", "Sweep"];
const finding = (lens: string) => [
  `feature.txt:1 | major | ${lens} | an empty name -> a blank greeting | guard it | anchor: greet the new member`,
  `feature.txt:1 | minor | ${lens} | a typo -> confusion | fix it | anchor: greet the new member`,
];
const items = [...lenses.flatMap(finding), ...lenses.map((lens) => `TESTS: feature.test.ts:3 The ${lens} test waits on a real timer. Control the clock.`)];
const numbered = ["Answer each finding by these numbers, in hedge proof respond:", ...items.map((item, index) => `${index + 1}. ${item}`)].join("\n");
const readingOrderItems = lenses.length * 7;

test("a finished panel prints its findings by the numbers hedge pairs answers with: every lens's findings, then every TESTS item", async () => {
  const { pr, waited } = await panelRound();

  expect(waited.code).toBe(0);
  expect(waited.output).toContain(numbered);
  expect((await pr.hedge("show", "--round", "1")).output).toContain(numbered);
});

test("hedge proof respond refuses answers numbered past the last finding, so they cannot shift onto other findings", async () => {
  const { pr } = await panelRound();
  const readingOrder = Array.from({ length: readingOrderItems }, (_, index) => `${index + 1}. rejected: answered in reading order\n`).join("");
  writeFileSync(join(pr.repository, "responses.md"), readingOrder);

  const refused = pr.hedge("respond", "--round", "1", "responses.md");
  await expect(refused).rejects.toThrow(`Round 1 has 12 findings; answers numbered past them: 13 to ${readingOrderItems}.`);
  await expect(refused).rejects.toThrow(numbered);

  const byNumbers = readingOrder.split("\n").slice(0, items.length).join("\n") + "\n";
  writeFileSync(join(pr.repository, "responses.md"), byNumbers);
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
});

test("the numbers in the list are the ones respond pairs: answering every major leaves the TESTS items, numbered last, unanswered", async () => {
  const { pr } = await panelRound();
  const majors = items.flatMap((item, index) => item.includes("| major |") ? [`${index + 1}. fixed: the greeting guards an empty name\n`] : []).join("");
  writeFileSync(join(pr.repository, "responses.md"), majors);

  const refused = pr.hedge("respond", "--round", "1", "responses.md");
  await expect(refused).rejects.toThrow("Answer findings 9, 10, 11, 12 too");
  await expect(refused).rejects.toThrow(numbered);
});

test("a single reviewer's findings that start alike print with their whole text, so each number names one finding", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", `FINDINGS:
- feature.txt:1 | major | Correctness | the greeting
  drops an empty name | anchor: greet the new member
- feature.txt:1 | major | Correctness | the greeting
  repeats for a returning member | anchor: greet the new member
COVERED: feature.txt
`);

  const reviewed = await pr.hedge("review", "--single");

  expect(reviewed.output).toContain([
    "Answer each finding by these numbers, in hedge proof respond:",
    "1. feature.txt:1 | major | Correctness | the greeting",
    "   drops an empty name | anchor: greet the new member",
    "2. feature.txt:1 | major | Correctness | the greeting",
    "   repeats for a returning member | anchor: greet the new member",
  ].join("\n"));
});

test("hedge proof respond refuses answers to a round without findings", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  await pr.hedge("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n");

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Round 1 has no findings, so it needs no answers.");
});

const twoFindings = "FINDINGS:\n- feature.txt:1 | major | Correctness | an empty name -> a blank greeting | anchor: greet the new member\n- feature.txt:1 | major | Correctness | a returning member -> a second greeting | anchor: greet the new member\nCOVERED: feature.txt\n";

async function singleFindingRound(review = "FINDINGS:\n- feature.txt:1 | major | Correctness | an empty name -> a blank greeting | anchor: greet the new member\nCOVERED: feature.txt\n") {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", review);
  await pr.hedge("review", "--single");
  return pr;
}

test("hedge proof show fails on a finished round whose findings it cannot read", async () => {
  const pr = await singleFindingRound();
  const findings = join(pr.pullRequest, "reviews/1/findings.md");
  rmSync(findings);
  mkdirSync(findings);

  await expect(pr.hedge("show", "--round", "1")).rejects.toThrow("EISDIR");
});

test("an answer past the last finding quoted in a fenced block saves as other text, as on main", async () => {
  const pr = await singleFindingRound();
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n\nAn earlier round read:\n\n```text\n2. rejected: same as 1.\n```\n");

  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
});

test("a fenced quote of an answer to a real finding answers nothing, so respond still asks for that answer", async () => {
  const pr = await singleFindingRound(twoFindings);
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n\n```text\n2. rejected: from an earlier round\n```\n");

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 2 too");
});

test("inline code written with three backticks is no fence, so an answer past the last finding between two such labels is refused", async () => {
  const pr = await singleFindingRound();
  writeFileSync(join(pr.repository, "responses.md"), "```first```\n1. fixed: the greeting guards an empty name\n2. rejected: no such finding\n```second```\n");

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Round 1 has 1 findings; answers numbered past them: 2.");
});

const fenceCases: [string, string, number[]][] = [
  ["a backtick fence", "1. fixed: a\n```text\n2. rejected: quoted\n```\n", [1]],
  ["CRLF line ends", "1. fixed: a\r\n```\r\n2. rejected: quoted\r\n```\r\n", [1]],
  ["a tilde fence", "~~~\n2. rejected: quoted\n~~~\n1. fixed: a\n", [1]],
  ["a tilde fence whose info has backticks", "~~~ `text`\n2. rejected: quoted\n~~~\n1. fixed: a\n", [1]],
  ["a fence line with text after it, which does not close", "```\n``` text\n2. rejected: quoted\n```\n1. fixed: a\n", [1]],
  ["a shorter fence, which does not close", "````\n```\n2. rejected: quoted\n````\n1. fixed: a\n", [1]],
  ["the other fence character, which does not close", "```\n~~~\n2. rejected: quoted\n```\n1. fixed: a\n", [1]],
  ["an indented fence inside an answer", "1. fixed: a\n    ```\n    2. rejected: quoted\n    ```\n", [1]],
  ["a fence left open, which runs to the end", "1. fixed: a\n```\n2. rejected: quoted\n", [1]],
  ["inline code with three backticks, which is no fence", "```first```\n1. fixed: a\n2. rejected: b\n```second```\n", [1, 2]],
];

test.each(fenceCases)("answers in %s", (_, responses, answered) => {
  const { findings } = answeredFindings(twoFindings, responses);

  expect(findings.flatMap(({ answer }, index) => answer ? [index + 1] : [])).toEqual(answered);
});

test("a fenced quote stays in the other text of the answers", () => {
  expect(answeredFindings(twoFindings, "1. fixed: a\n```text\n2. rejected: quoted\n```\n").other).toContain("2. rejected: quoted");
});

test("a prose finding that starts with a bare list marker keeps that line in the list", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "1.\nThe greeting drops an empty name.\n");

  expect((await pr.hedge("review", "--single")).output).toContain("Answer each finding by these numbers, in hedge proof respond:\n1. 1.\n   The greeting drops an empty name.");
});
