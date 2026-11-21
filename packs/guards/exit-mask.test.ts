import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../src/testing/git.ts";
import { guard } from "./hooks/guards.ts";
import { exitMaskRisk } from "./lib/exit-mask.ts";

const temp = tempDirs();
const stubs = tempDirs();
let bin = "";

beforeAll(() => {
  bin = join(stubs.make("exit-mask-bin-"), "bin");
  mkdirSync(bin);
  for (const name of ["git", "gh", "hedge", "fleet"]) {
    writeFileSync(join(bin, name), '#!/bin/sh\ncalls=$(($(cat "$STUB_CALLS" 2>/dev/null || echo 0) + 1))\necho "$calls" > "$STUB_CALLS"\n[ "$calls" = "$STUB_FAILS" ] && exit 3\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
});
afterEach(() => temp.cleanup());
afterAll(() => stubs.cleanup());

function runFailing(command: string, failing: number) {
  const calls = join(temp.make("exit-mask-calls-"), "calls");
  const run = spawnSync("bash", ["-c", command], { cwd: temp.make("exit-mask-run-"), env: { PATH: `${bin}:/usr/bin:/bin`, STUB_CALLS: calls, STUB_FAILS: String(failing) }, encoding: "utf8" });
  const made = Number(spawnSync("cat", [calls], { encoding: "utf8" }).stdout || 0);
  return { seen: { status: run.status, output: `${run.stdout}${run.stderr}` }, made };
}

function shellShowsEveryFailure(command: string) {
  const { seen, made } = runFailing(command, 0);
  expect(made).toBeGreaterThan(0);
  return Array.from({ length: made }, (_, call) => runFailing(command, call + 1).seen).every((failed) => !Bun.deepEquals(failed, seen));
}

const refused = (command: string) => exitMaskRisk(command, "Robin") !== undefined;

describe("the exit-status mask guard", () => {
  test.each([
    "git push origin HEAD",
    "git commit -m 'a; b | tail' && git push",
    "set -o pipefail; hedge proof gate --pr 1 | tail -20",
    "set -euo pipefail\ngit push | tail -3",
    "set +o pipefail; set -o pipefail; git push | tail -3",
    "set -o pipefail; git push 2>&1 | tail -3; echo \"exit $?\"",
    'git push 2>&1 | tail -3; echo "${PIPESTATUS[0]}"',
    "git push 2>&1 | tail -3; exit ${PIPESTATUS[0]}",
    "set -e; git commit -m x; git push",
    "if git push; then echo pushed; fi",
    "git push > push.log 2>&1 && tail push.log",
    "git push;",
    "git push # pushes the branch",
    'git push && echo "pushed $?"',
    "! git push",
    'hedge proof gate --pr 1 > gate.log 2>&1; echo "EXIT=$?"; cat gate.log',
    'hedge proof gate --pr 1 > gate.log 2>&1\necho "EXIT=$?"\ncat gate.log',
    "hedge proof review --pr 1 > review.log 2>&1; echo EXIT=$?; tail -5 review.log",
    'git push > push.log 2>&1; echo "push exit ${?}" >&2; cat push.log',
    "git push && git log -1 > log.txt; echo \"exit $?\"",
    "git push && { echo pushed; }; echo \"exit $?\"",
    'git push > push.log 2>&1 || echo "push failed: $?"; cat push.log',
    "git push || exit 1",
    'echo main | xargs git push origin | tail -3; echo "exit ${PIPESTATUS[1]}"',
    'git push | tail -3; echo "${PIPESTATUS[@]}"',
    'git push; echo "exit=$?" -e',
    "set -o pipefail; ( set +o pipefail ); git push | cat",
    'git push | cat; echo "${PIPESTATUS[00]}"',
    "{ printf '%s\\n' main; } | xargs git push origin | cat; echo \"${PIPESTATUS[1]}\"",
    "for i in 1; do echo main; done | xargs git push origin | cat; echo \"${PIPESTATUS[1]}\"",
    "( echo main ) | xargs git push origin | cat; echo \"${PIPESTATUS[1]}\"",
    "if true; then echo main; fi | xargs git push origin | cat; echo \"${PIPESTATUS[1]}\"",
    "label='<(input)' out=$(git push); echo \"exit=$?\"",
    'git push | cat; exit "${PIPESTATUS[0]}"',
    'true | git push; echo "${PIPESTATUS[1]}"',
    'true | git push || echo "${PIPESTATUS[1]}"',
    'git push || exit "1"',
    'git push | cat; echo "${PIPESTATUS[0]}" "$?"',
    "git push; echo exit=\"$?\" 'done'",
    'git push; exit "${?}"',
    'echo y | ( echo x ); ( echo a ) | git push | cat; echo "${PIPESTATUS[1]}"',
    'echo y | ( echo x ); { echo a; } | git push | cat; echo "${PIPESTATUS[1]}"',
    'echo a | { { echo b; }; } | git push | cat; echo "${PIPESTATUS[2]}"',
    'case x in x) echo main;; esac | xargs git push origin | cat; echo "${PIPESTATUS[1]}"',
    'echo y | ( echo a; echo b ) | git push | cat; echo "${PIPESTATUS[2]}"',
    'echo y | for i in 1; do echo main; done | xargs git push origin | cat; echo "${PIPESTATUS[2]}"',
    'echo a | { echo c; { echo b; }; } | git push | cat; echo "${PIPESTATUS[2]}"',
    'echo y | ( echo a; ( echo b ) ) | git push | cat; echo "${PIPESTATUS[2]}"',
    ': | : | : | : | : | : | : | : | git push | cat; echo "${PIPESTATUS[010]}"',
    "git push > push.log 2>&1; exit $?",
    "git commit -F - <<'EOF'\nFix the gate\nEOF\necho \"exit $?\"",
    "( git push )",
    "(true && git push)",
    "{ true; git push; }",
    "if true; then git push; fi",
    "case x in x) git push;; esac",
    "bash -c 'git push'",
    "bash -c 'git push' && echo ok",
    "sh -c 'true && git push' > push.log 2>&1; echo \"exit $?\"",
    "eval 'git push'",
    'out=$(git push 2>&1); echo "exit $?"; echo "$out"',
    "bash <<'EOF'\ngit push\nEOF",
    "echo 'git push' | bash",
    "echo main | xargs git push origin",
    "echo main | xargs -I{} git push origin {}",
    'hedge heavy -- git push > push.log 2>&1; echo "exit=$?"',
    "timeout 60 git push",
    "fleet proof save --kind live-run run.txt",
  ])("allows a status the agent sees: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toBeUndefined();
    expect(shellShowsEveryFailure(command)).toBe(true);
  });

  test.each([
    "hedge proof gate --pr 1 2>&1 | tail -20",
    "hedge proof save --kind live-run x | grep -v debug",
    "git push origin HEAD 2>&1 | tail -3",
    "git -C repo push | head",
    "git commit -m 'Fix the gate' | grep -c changed",
    "gh pr ready 12 && gh pr merge 12 --squash 2>&1 | tail -5",
    "gh run watch 123 --exit-status | cat",
    "fleet proof gate --pr 1 2>&1 | tail -20",
    "hedge heavy -- git push | tail -3",
    "fleet heavy -- git push | tail -3",
    "git commit -m x; git push",
    "git push || true",
    "git push || :",
    "git push || exit 0",
    "git push; echo done",
    "git push; true",
    "git push\necho done",
    "git push &",
    "! git push; echo done",
    "( set -o pipefail ); git push | cat",
    "( set -e ); git push; echo done",
    "git push; ( echo \"exit $?\" ) > /dev/null",
    "git push & wait",
    "git push & echo \"exit $?\"",
    "git push; echo \"exit $?\" | grep -c x",
    "git push | cat; exit",
    "git push; printf 'done\\n' \"$?\"",
    "git push; printf '%.0s' \"$?\"",
    "git push; printf '%.0s%s' \"$?\"",
    "git push; echo -e 'exit \\c' $?",
    "set -o errexit | cat; git push; echo done",
    "false && set -e; git push; echo done",
    "if false; then set -e; fi; git push; echo done",
    'out=<(git push); echo "exit=$?"',
    'echo main | xargs git push origin | tail -3; echo "exit ${PIPESTATUS[0]}"',
    '{ git push 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"; } > /dev/null',
    "git push || { true; exit 0; }",
    "git push || { true; exit $?; }",
    "git push || { true; exit 1; } | cat",
    "set -e; true && set +e; git push; echo done",
    "set -o pipefail; true && set +o pipefail; git push | cat",
    "git push || { false && exit 1; }; true",
    "git push; printf -vstatus\"$?\" '%s' done",
    "git push; printf '%s' \"-v${?+ok}\"",
    "git push; printf \"%bexit=$?\" 'done\\c' -v",
    "shopt -s xpg_echo; git push; echo \"exit\\c $?\"",
    "git push; exit $? &",
    'git push; echo "$""?"',
    "git push; echo $\"?\"",
    'git push | cat; echo "${PIPESTATUS[010]}"',
    'git push | cat; exit "${PIPESTATUS[@]}"; true',
    'git push | cat; exit ${PIPESTATUS[*]}; true',
    'git push | cat; exit "${PIPESTATUS[1]}"',
    'git push; exit $(( $? * 0 ))',
    'label=ok; git push > push.log 2>&1; echo "${label:-$?}"',
    'git push > push.log 2>&1; exit "$?" > /dev/null/status; true',
    'git push 2>&1 | grep -q pushed && echo "${PIPESTATUS[0]}"; echo done',
    'git push && ( exit 3 ); echo "${PIPESTATUS[@]}"',
    'git push && ( exit 3 ); echo "${PIPESTATUS[0]}"',
    "git push; exit $? now",
    "git push; exit 1",
    'true | git push > /dev/null 2>&1 || exit "${PIPESTATUS[1]}" && : & wait',
    "git push > /dev/null 2>&1 || exit 1 && : & wait",
    "git push > /dev/null 2>&1; exit $? && : & wait",
    'git push | cat; exit "${PIPESTATUS[0]}" || : & wait',
    "git push; echo \"'\"'$?'\"'\"",
    'set -o pipefail >&9; git push | cat',
    'echo y | ( echo x ); ( echo a ) | git push | cat; echo "${PIPESTATUS[2]}"',
    'echo y | ( echo x ); { echo a; } | git push | cat; echo "${PIPESTATUS[2]}"',
    'echo a | { { echo b; }; } | git push | cat; echo "${PIPESTATUS[1]}"',
    'git push | cat; echo "${PIPESTATUS[08]}"',
    ': | : | : | : | : | : | : | : | git push | cat; echo "${PIPESTATUS[08]}"',
    ': | : | : | : | : | : | : | : | : | : | git push | cat; echo "${PIPESTATUS[010]}"',
    'git push; echo "${?+ok}"',
    'git push | cat; echo "${PIPESTATUS[0]+set}"',
    "git push 2>&1 | tee push.log; echo \"exit $?\"",
    "git push | cat; true; echo \"${PIPESTATUS[0]}\"",
    "git push > push.log 2>&1; cat push.log; echo \"exit $?\"",
    'hedge proof gate --pr 1 > gate.log 2>&1\necho "gate exit $?" >> gate.log',
    "git push; echo \"exit $?\" > /dev/null",
    "git push; echo \"exit $?\" >&3 3>/dev/null",
    "git push; echo 'exit $?'",
    "git push; echo \"exit \\$?\"",
    "git push; echo exit \\$?",
    "git push; printf -v status '%s' \"$?\"",
    "git push; echo \"$(true; echo $?)\"",
    "git push > push.log 2>&1; status=$?; cat push.log",
    "git push | cat; echo \"exit $?\"",
    "( git push ) | cat",
    "( git push ) || true",
    "( git push ) &",
    "{ git push; } | cat",
    "{ git push; } || true",
    "{ git push; echo \"$?\"; } > /dev/null",
    "( git push; echo \"$?\" ) > /dev/null",
    "f() { git push; }; f | cat",
    "set -e; { git push; echo done; } && true",
    "set -e; git push && true; echo done",
    "set -e; set +e; git push; echo done",
    "set -o pipefail; set +o pipefail; git push | cat",
    "set -o pipefail; git push | cat; echo done",
    "bash -c 'git push' | cat",
    "bash -c 'git push; echo done'",
    "bash -c 'git push | cat'",
    "sh -c 'git push' || true",
    "eval 'git push | cat'",
    "echo \"$(git push)\"",
    "x=$(git push; true)",
    "local_out=$(git push) other=$(true)",
    "cat <(git push)",
    "bash <<'EOF'\ngit push | cat\nEOF",
    "echo 'git push; true' | bash",
    "echo main | xargs git push origin | cat",
  ])("refuses a status the shell hides: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toContain("hides the exit status");
    expect(shellShowsEveryFailure(command)).toBe(false);
  });

  test.each([
    "for branch in a b; do git push origin $branch; done",
    "if true; then git push; else echo skipped; fi",
    "( git push ) && echo ok",
    "git push && echo ok; echo done",
    "{ git push || exit 1; } > push.log",
    "git push || echo failed",
    "git push > push.log 2>&1; printf 'exit %s\\n' \"$?\"; cat push.log",
    "git push > push.log 2>&1; printf \"exit $?\\n\"",
    'git push || { echo "push failed"; exit 1; }',
    "git push > push.log 2>&1; status=$?; cat push.log; exit $status",
    "bash -c 'git push; echo \"exit $?\"'",
    "git push origin --help | head",
    "git push; echo \"exit $?\" &",
    'out=$(git push) > >(cat); echo "exit=$?"',
    'git push; echo "pid $$$?"',
    'git push; echo "$?" "$(true)"',
    'git push; x=$(true) echo "exit=$?"',
    'git push | cat; echo "${PIPESTATUS[0x0]}"',
  ])("refuses a form it cannot read, though the shell may show the status: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each([
    "hedge proof save --help | head -60",
    "hedge proof gate --help > help.txt 2>&1; cat help.txt",
    "fleet proof review -h | tail",
    "git push --help | head",
    "git commit -h | head",
    "git -C repo push --help | head",
    "git push '--help' | head",
    "gh pr merge --help | head -20",
    "hedge heavy -- git push --help | head",
    "bash -c 'git push --help | head'",
  ])("allows a help call, which changes nothing: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toBeUndefined();
  });

  test.each([
    "git commit -m --help | cat",
    "git commit -m \"--help\" | cat",
    "git commit --message=--help | cat",
    "hedge proof gate --reason --help | cat",
    "hedge proof review -- --help | cat",
    "git push --help=foo | cat",
    "git push -- --help | cat",
    "git push --help origin | cat",
  ])("keeps guarding a --help that is not the only word after the command: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each(['git push; echo "$$?"', "git push; echo $$'x'?", 'git push; echo "$$"\'x\'"?"'])("refuses a $$ that prints the process id, not the status: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each(["git push > push.log 2>&1; exit \"$?\"'0'", "git push > push.log 2>&1; exit $?0"])("refuses an exit code built from the status, which wraps to 0 for code 128: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each([
    'sh -c \'git push; exit "${PIPESTATUS[0]}"\' 2>/dev/null; echo "$?"',
    'sh -c \'git push | cat; exit "${PIPESTATUS[0]}"\'',
    'eval \'git push | cat; exit "${PIPESTATUS[0]}"\'',
  ])("refuses a PIPESTATUS read in a nested program, which may run in a shell without it: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test("refuses a quote it cannot close instead of hanging", () => {
    expect(refused("git push; echo $(( 1 ' ))")).toBe(true);
  });

  test.each(["~/.local/bin/hedge proof review --pr 1 | tee review.log", "/usr/bin/git push | tail -3", "\\git push | tail -3"])("refuses a guarded command named by its path or escaped: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each(["gh run watch 123 | tail", "git log --oneline | head -3"])("ignores a command whose status does not gate anything: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toBeUndefined();
  });

  test.each([
    ["git push | tail -3", "git push"],
    ["hedge proof gate --pr 1; echo done", "hedge proof gate"],
    ["gh run watch 1 --exit-status || true", "gh run watch --exit-status"],
  ])("names a rewrite that passes: %s", (command, what) => {
    const reason = exitMaskRisk(command, "Robin") ?? "";
    const rewrite = [...reason.matchAll(/`([^`]+)`/g)].map(([, form]) => form).find((form) => form.startsWith(what) && form.includes("echo"));
    expect(rewrite).toContain(`${what} …`);
    expect(exitMaskRisk(rewrite!, "Robin")).toBeUndefined();
    expect(reason).toContain("--help");
  });

  test("the shell hook refuses with the fix", () => {
    const call = { tool_name: "Bash", tool_input: { command: "gh run watch 123 --exit-status | tail -3" }, cwd: "/" };
    expect(guard(call, temp.make("home-"), temp.make("root-"))?.hookSpecificOutput.permissionDecisionReason).toContain("set -o pipefail");
  });

  test("the shell hook lets a help call through", () => {
    const call = { tool_name: "Bash", tool_input: { command: "hedge proof save --help | head -60" }, cwd: "/" };
    expect(guard(call, temp.make("home-"), temp.make("root-"))).toBeUndefined();
  });
});
