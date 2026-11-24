import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel, graded, type Checkout } from "./proof-testing.ts";

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

async function receiptPage(pr: Checkout) {
  const requests = join(pr.home, "receipt-requests");
  const handler = join(pr.home, "publish.ts");
  writeFileSync(handler, `require("fs").appendFileSync(${JSON.stringify(requests)}, JSON.stringify(await Bun.stdin.json()) + "\\n");\nconsole.log(JSON.stringify({ id: "receipt", url: "https://receipts.example/r/receipt" }));\n`);
  pr.env.HEDGE_HANDLERS = JSON.stringify({ "proof-receipt": handler });
  pr.pullRequestState({ body: `## Problem\n\nThe greeting is blank.\n\n${graded("non-critical")}` });
  await pr.hedge("receipt");
  return JSON.parse(readFileSync(requests, "utf8").trim().split("\n").at(-1)!).page as string;
}

const row = (number: number, text: string, answer: string) => new RegExp(`^\\| ${number} \\|[^\\n]*${text}[^\\n]*\\| ${answer} \\|$`, "m");

function lensNamingReviewer(pr: Checkout) {
  const reply = join(pr.home, "lens-answer");
  writeFileSync(reply, lensAnswer);
  pr.env.HEDGE_PROOF_REVIEWER_MODEL = "gpt-6.1-sol";
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

test("the receipt shows each answer next to the finding its listed number names", async () => {
  const { pr } = await panelRound();
  writeFileSync(join(pr.repository, "responses.md"), items.map((_, index) => `${index + 1}. rejected: answer ${index + 1}\n`).join(""));
  await pr.hedge("respond", "--round", "1", "responses.md");

  const page = await receiptPage(pr);
  for (const [index, lens] of lenses.entries()) {
    expect(page).toMatch(row(2 * index + 1, `major \\| ${lens} \\|`, `rejected: answer ${2 * index + 1}`));
    expect(page).toMatch(row(2 * index + 2, `minor \\| ${lens} \\|`, `rejected: answer ${2 * index + 2}`));
    expect(page).toMatch(row(2 * lenses.length + index + 1, `The ${lens} test waits`, `rejected: answer ${2 * lenses.length + index + 1}`));
  }
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
  pr.env.HEDGE_PROOF_REVIEWER_MODEL = "gpt-6.1-sol";
  await pr.hedge("review", "--single");
  return pr;
}

test("hedge proof show fails on a finished round whose findings it cannot read", async () => {
  const pr = await singleFindingRound();
  const findings = join(pr.pullRequest, "reviews/1/findings.md");
  rmSync(findings);
  mkdirSync(findings);

  const shown = await pr.hedge("show", "--round", "1");

  expect(shown.code).toBe(1);
  expect(shown.output).toContain("hedge cannot read the findings of this round: EISDIR");
});

test("hedge proof respond refuses a code fence in any form, since every numbered line counts as an answer", async () => {
  const pr = await singleFindingRound(twoFindings);
  const fences = ["```text", "~~~", "    ```", "\t~~~", "```first```", "````", "- ```text", "3. ~~~", "  * - ```", "\uFEFF```", "\u00a0```"];
  for (const fence of fences) {
    writeFileSync(join(pr.repository, "responses.md"), fence.startsWith("\uFEFF") ? `${fence}\n1. fixed: from an earlier round\n` : `1. fixed: the greeting guards an empty name\n${fence}\n2. rejected: from an earlier round\n`);
    await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("responses.md holds a code fence, a line that starts with ``` or ~~~. Every numbered line counts as an answer, quoted or not. Quote an earlier answer with > and write code in single backticks.");
  }
});

test("an answer quoted with > answers nothing and is not counted past the last finding", async () => {
  const pr = await singleFindingRound(twoFindings);
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n\nAn earlier receipt read:\n\n> 2. rejected: from an earlier round\n> 3. rejected: from an earlier round\n");

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 2 too");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n2. rejected: a returning member is greeted once\n\n> 3. rejected: from an earlier round\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);

  expect(await receiptPage(pr)).toContain("Other answers, as written:\n\n```text\n> 3. rejected: from an earlier round\n```");
});

test("a finding marked with a number and a nonbreaking space prints under its own number alone", async () => {
  const pr = await singleFindingRound("FINDINGS:\n7.\u00a0feature.txt:1 | major | Correctness | an empty name -> a blank greeting | anchor: greet the new member\nCOVERED: feature.txt\n");

  expect((await pr.hedge("show", "--round", "1")).output).toContain("Answer each finding by these numbers, in hedge proof respond:\n1. feature.txt:1 | major |");
});

test("the fence check reads a long run of bare carriage returns in one pass", async () => {
  const pr = await singleFindingRound();
  writeFileSync(join(pr.repository, "responses.md"), `1. fixed: the greeting guards an empty name\n${"\r".repeat(32_000)}\n`);
  const started = performance.now();

  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  expect(performance.now() - started).toBeLessThan(400);
});

test("an answer number too long for a JavaScript number is named as written", async () => {
  const pr = await singleFindingRound();
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed: the greeting guards an empty name\n123456789012345678901234567890. rejected: no such finding\n");

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("answers numbered past them: 123456789012345678901234567890.");
});

test("a prose finding that starts with a bare list marker keeps that line in the list", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "1.\nThe greeting drops an empty name.\n");

  expect((await pr.hedge("review", "--single")).output).toContain("Answer each finding by these numbers, in hedge proof respond:\n1. 1.\n   The greeting drops an empty name.");
});
