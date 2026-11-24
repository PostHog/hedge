import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, fakeModel } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lensAnswer = `I read the whole diff.

- **Greeting:** it reads the member's name once.
- **Errors:** a failed send is logged.

FINDINGS:
- feature.txt:1 | major | Correctness | an empty name -> a blank greeting | guard it | anchor: greet the new member
- feature.txt:1 | minor | Correctness | a typo -> confusion | fix it | anchor: greet the new member

COVERED:

- feature.txt
- other.txt

TESTS:

- feature.test.ts:3 The test waits on a real timer. Control the clock.
`;

async function panelRound() {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", lensAnswer);
  await pr.hedge("review", "--lens", "correctness", "--lens", "sweep");
  return { pr, waited: await pr.hedge("review", "--wait") };
}

const lenses = 4;
const major = "feature.txt:1 | major | Correctness | an empty name -> a blank greeting | guard it | anchor: greet the new member";
const minor = "feature.txt:1 | minor | Correctness | a typo -> confusion | fix it | anchor: greet the new member";
const testItem = "TESTS: feature.test.ts:3 The test waits on a real timer. Control the clock.";
const items = [...Array.from({ length: lenses }, () => [major, minor]).flat(), ...Array.from({ length: lenses }, () => testItem)];
const numbered = ["Answer each finding by these numbers, in hedge proof respond:", ...items.map((item, index) => `${index + 1}. ${item}`)].join("\n");
const readingOrderItems = lenses * 7;

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
  await expect(refused).rejects.toThrow(`Round 1 has 12 findings, but answers 13 to ${readingOrderItems} number past them`);
  await expect(refused).rejects.toThrow(numbered);

  writeFileSync(join(pr.repository, "responses.md"), readingOrder.split("\n").slice(0, items.length).join("\n") + "\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
});
