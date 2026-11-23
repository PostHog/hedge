import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../src/testing/git.ts";
import { guard } from "./hooks/guards.ts";
import { exitMaskRewrite, exitMaskRisk } from "./lib/exit-mask.ts";

const temp = tempDirs();
const stubs = tempDirs();
let bin = "";

beforeAll(() => {
  bin = join(stubs.make("exit-mask-bin-"), "bin");
  mkdirSync(bin);
  for (const name of ["git", "gh", "hedge", "fleet"]) {
    writeFileSync(join(bin, name), '#!/bin/sh\n[ "$1" = heavy ] && [ "$2" = -- ] && shift 2 && exec "$@"\necho "${0##*/} $*" >> "$STUB_CALLS.trace"\ncalls=$(($(cat "$STUB_CALLS" 2>/dev/null || echo 0) + 1))\necho "$calls" > "$STUB_CALLS"\n[ "$calls" = "$STUB_FAILS" ] && exit 3\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
});
afterEach(() => temp.cleanup());
afterAll(() => stubs.cleanup());

const harnesses = {
  codex: (command: string) => ["-c", command],
  claude: (command: string) => ["-c", ': && eval "$AGENT_COMMAND" < /dev/null && pwd -P > /dev/null', command],
};
type Harness = keyof typeof harnesses;

function runFailing(command: string, failing: number, harness: Harness = "codex") {
  const calls = join(temp.make("exit-mask-calls-"), "calls");
  const [flag, program] = harnesses[harness](command);
  const env = { PATH: `${bin}:/usr/bin:/bin`, STUB_CALLS: calls, STUB_FAILS: String(failing), AGENT_COMMAND: command };
  const run = spawnSync("bash", [flag, program], { cwd: temp.make("exit-mask-run-"), env, encoding: "utf8" });
  const made = Number(spawnSync("cat", [calls], { encoding: "utf8" }).stdout || 0);
  const trace = spawnSync("cat", [`${calls}.trace`], { encoding: "utf8" }).stdout;
  return { seen: { status: run.status, output: `${run.stdout}${run.stderr}` }, made, trace, stdout: run.stdout, stderr: run.stderr };
}

function showsEveryFailureIn(command: string, harness: Harness) {
  const { seen, made } = runFailing(command, 0, harness);
  expect(made).toBeGreaterThan(0);
  return Array.from({ length: made }, (_, call) => runFailing(command, call + 1, harness).seen).every((failed) => !Bun.deepEquals(failed, seen));
}

const shellShowsEveryFailure = (command: string) => showsEveryFailureIn(command, "codex") && showsEveryFailureIn(command, "claude");

const refused = (command: string) => exitMaskRisk(command, "Robin") !== undefined;

describe("the exit-status mask guard", () => {
  test.each([
    "git push origin HEAD",
    "git commit -m 'a; b | tail' && git push",
    "set -o pipefail; hedge proof gate --pr 1 | tail -20",
    "set -euo pipefail\ngit push | tail -3",
    "set +o pipefail; set -o pipefail; git push | tail -3",
    "set -o pipefail; git push 2>&1 | tail -3; echo \"exit $?\"",
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
    'git push; echo "exit=$?" -e',
    "set -o pipefail; ( set +o pipefail ); git push | cat",
    "label='<(input)' out=$(git push); echo \"exit=$?\"",
    'git push || exit "1"',
    "git push; echo exit=\"$?\" 'done'",
    'git push; exit "${?}"',
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
    "set -e; git commit -m x; git push",
    "set -e\ngit push\necho done",
    "set -o errexit; git push; true",
    "set -eo pipefail; true | git push > /dev/null 2>&1; echo done",
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
    'exec > /dev/null; git push; echo "$?"',
    '{ exec 1>&-; } 2>/dev/null; git push; echo "$?"',
    'echo() { :; }; git push; echo "$?"',
    "eval 'exec > /dev/null 2>&1'; git push; echo \"$?\"",
    'printf \'exec > /dev/null\\n\' > quiet.sh; . ./quiet.sh; git push; echo "$?"',
    'printf \'exec > /dev/null\\n\' > quiet.sh; source ./quiet.sh; git push; echo "$?"',
    'echo () { :; }; git push; echo "$?"',
    'function echo { :; }; git push; echo "$?"',
    "IFS=0123456789; git push; echo $?",
    "git push; exit $? |& cat",
    "set -eo pipefail; ! { true; } | git push > /dev/null 2>&1; echo done",
    "set -eo pipefail; ! ( true ) | git push > /dev/null 2>&1; echo done",
    'unset label; git push > /dev/null 2>&1; label=${label:?missing} echo "$?"',
    'set -u; git push | tee push.log; echo "push=${PIPESTATUS[0]}" "${PIPESTATUS[2]}"',
    "set -e; ! git push > /dev/null 2>&1; echo done",
    "set -e; ! true | git push > /dev/null 2>&1; echo done",
    'set -u; git push > /dev/null 2>&1; echo "${PIPESTATUS[0]}" "${PIPESTATUS[1]}"',
    'git push > /dev/null 2>&1; echo "${PIPESTATUS[0]}" "${PIPESTATUS[08]}"',
    "set -o pipefail && : & wait; git push > /dev/null 2>&1 | cat",
    'true | git push > /dev/null 2>&1 || exit "${PIPESTATUS[1]}" && : & wait',
    "git push > /dev/null 2>&1 || exit 1 && : & wait",
    "git push > /dev/null 2>&1; exit $? && : & wait",
    "trap 'exec > /dev/null 2>&1' DEBUG; git push; echo \"$?\"",
    "set -o pipefail; eval 'set +o pipefail'; git push > /dev/null 2>&1 | cat",
    "set -o pipefail; trap 'set +o pipefail' DEBUG; git push > /dev/null 2>&1 | cat",
    "quiet() { set +o pipefail; }; set -o pipefail; quiet; git push > /dev/null 2>&1 | cat",
    "loose() { set +e; }; set -e; loose; git push > /dev/null 2>&1; true",
    "read -r IFS <<< 013; git push > /dev/null 2>&1; echo $?",
    "printf -v IFS 0123; git push > /dev/null 2>&1; echo $?",
    "read -r I''FS <<< 0123456789; git push > /dev/null 2>&1; echo $?",
    'printf -v "I""FS" 0123; git push > /dev/null 2>&1; echo $?',
    "exit() { :; }; git push > /dev/null 2>&1; exit $?",
    "exit() { :; }; git push > /dev/null 2>&1 || exit 1",
    "trap 'exit 0' EXIT; git push > /dev/null 2>&1",
    "function quiet { set +o pipefail; }; set -o pipefail; quiet; git push > /dev/null 2>&1 | cat",
    "trap 'rm -f push.log; exit $?' EXIT; git push > push.log 2>&1; exit \"$?\"",
    "trap 'set +o pipefail' DEBUG; set -o pipefail; git push > /dev/null 2>&1 | cat",
    'git push | cat; exit "${PIPESTATUS[0]}" || : & wait',
    "git push > /dev/null 2>&1; exit $? || : & wait",
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
    'git push; echo "exit=$?" <<EOF\n$(true)\nEOF',
    "set -eo pipefail; { true; } | git push > /dev/null 2>&1; echo done",
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

  test.each([
    'git push 2>&1 | tail -3; echo "${PIPESTATUS[0]}"',
    'git push | tee push.log; echo "push=${PIPESTATUS[0]} tee=${PIPESTATUS[1]}"',
    'true | git push; echo "${PIPESTATUS[1]}"',
    'git push | cat; exit "${PIPESTATUS[0]}"',
  ])("refuses a PIPESTATUS read, which zsh does not set: %s", (command) => {
    expect(refused(command)).toBe(true);
  });

  test.each(["( true ); git push > push.log 2>&1; echo \"exit=$?\"", "git commit -m 'Fix parse()' > commit.log 2>&1; echo \"exit=$?\"", "true | git push; echo \"exit=$?\"", "set -o pipefail; { echo main; } | xargs git push origin | cat; echo \"exit=$?\"", "git push > push.log 2>&1; echo \"exit=$?\"; exec cat push.log", "set -o pipefail; ( trap ':' EXIT ); git push | cat", "( exec > /dev/null ); git push > push.log 2>&1; echo \"exit=$?\"", "IFS= read -r branch <<< main; set -o pipefail; git push origin \"$branch\" | tee push.log", "git push origin fix-CIFS > push.log 2>&1; echo \"exit=$?\"; cat push.log", "read -r IFS <<< 013; git push > push.log 2>&1; echo \"exit=$?\"", "printf 'x=1\\n' > env.sh; source ./env.sh; set -o pipefail; git push | cat", "args=(); set -o pipefail; git push | cat", "files=(); git push > push.log 2>&1; echo \"exit=$?\"", "declare -a list=(); set -o pipefail; git push | cat"])("allows the last stage's status or a pipefail pipe: %s", (command) => {
    expect(exitMaskRisk(command, "Robin")).toBeUndefined();
    expect(shellShowsEveryFailure(command)).toBe(true);
  });

  test.each(['alias echo=:; git push; echo "$?"', 'enable -n echo; git push; echo "$?"', 'shopt -s expand_aliases; git push; echo "$?"', 'builtin exec > /dev/null; git push; echo "$?"', "'exec' > /dev/null; git push; echo \"$?\"", '\\exec > /dev/null; git push; echo "$?"', "command 'exec' > /dev/null; git push; echo \"$?\"", "set -o pipefail; 'eval' 'set +o pipefail'; git push | cat", "set -o pipefail; unsetopt pipefail; git push | cat", "set -o pipefail; setopt no_pipefail; git push | cat", "set -o pipefail; emulate sh; git push | cat"])("refuses a status after a call that changes how the shell prints or pipes: %s", (command) => {
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

  test.each([
    ["git push | tail -3", "set -o pipefail; git push | tail -3"],
    ["hedge proof gate --pr 1 2>&1 | tail -20", "set -o pipefail; hedge proof gate --pr 1 2>&1 | tail -20"],
    ["gh pr ready 12 && gh pr merge 12 --squash 2>&1 | tail -5", "set -o pipefail; gh pr ready 12 && gh pr merge 12 --squash 2>&1 | tail -5"],
    ["git commit -m x; git push", "git commit -m x || exit; git push"],
    ["git push; echo done", "git push || exit; echo done"],
    ["git push ; echo done", "git push || exit; echo done"],
    ["git push\necho done", "git push || exit\necho done"],
    ["git push # pushes the branch\necho done", "git push || exit # pushes the branch\necho done"],
    ["git push\n\n# then\necho done", "git push || exit\n\n# then\necho done"],
    ["git commit -F - <<'EOF'\nFix; the | gate\nEOF\ngit push", "git commit -F - <<'EOF' || exit\nFix; the | gate\nEOF\ngit push"],
    ["git commit -F - <<EOF\nline one \\\nEOF\ngit push\nEOF\necho done", "git commit -F - <<EOF || exit\nline one \\\nEOF\ngit push\nEOF\necho done"],
    ["set -e; git commit -m 'a; b' ; git push; echo done", "set -e; git commit -m 'a; b' || exit; git push || exit; echo done"],
    ["cd . && git push 2>&1 | tail -3; echo done", "set -o pipefail; cd . && git push 2>&1 | tail -3 || exit; echo done"],
    ["git push 2>&1 | tail -3\necho done", "set -o pipefail; git push 2>&1 | tail -3 || exit\necho done"],
    ["git commit -m x; git push | tail -3", "set -o pipefail; git commit -m x || exit; git push | tail -3"],
    ["git push; if true; then echo pushed; fi", "git push || exit; if true; then echo pushed; fi"],
    ["git push; true || exit 1", "git push || exit; true || exit 1"],
    ["git push; echo pushed || exit 1; echo done", "git push || exit; echo pushed || exit 1; echo done"],
    ["git push; false; echo done", "git push || exit; false; echo done"],
    ["git push && echo ok; echo done", "git push || exit && echo ok; echo done"],
    ["git push && false; echo cleanup", "git push || exit && false; echo cleanup"],
    ["cd . && git push && echo ok\necho done", "cd . && git push || exit && echo ok\necho done"],
    ["git add -A && git commit -m x; git push", "git add -A && git commit -m x || exit; git push"],
    ["gh pr ready 1 && gh pr merge 1 --squash; echo done", "gh pr ready 1 || exit && gh pr merge 1 --squash || exit; echo done"],
    ["printf 'msg' | git commit -F -; echo done", "printf 'msg' | git commit -F - || exit; echo done"],
    ["cd . && printf 'msg' | git commit -F -; echo done", "cd . && printf 'msg' | git commit -F - || exit; echo done"],
    ["git push; sleep 0 &", "git push || exit; sleep 0 &"],
    ["git commit -F - <<'EOF'\nline one \\\nEOF\ngit push", "git commit -F - <<'EOF' || exit\nline one \\\nEOF\ngit push"],
    ["( git push | tail -3 )", "set -o pipefail; ( git push | tail -3 )"],
    ["git push | tail -3 && echo ok; echo done", "set -o pipefail; git push | tail -3 || exit && echo ok; echo done"],
    ["git push; true || echo extra", "git push || exit; true || echo extra"],
  ])("rewrites a hidden status into a form that shows it: %s", (command, rewrite) => {
    expect(exitMaskRewrite(command)).toBe(rewrite);
    expect(exitMaskRisk(rewrite, "Robin")).toBeUndefined();
    expect(shellShowsEveryFailure(rewrite)).toBe(true);
    for (const harness of ["codex", "claude"] as const) {
      const passing = runFailing(command, 0, harness);
      expect(runFailing(rewrite, 0, harness)).toEqual(passing);
      for (let call = 1; call <= passing.made; call++) {
        const before = runFailing(command, call, harness);
        const after = runFailing(rewrite, call, harness);
        expect(after.seen.status).not.toBe(0);
        expect(before.trace.startsWith(after.trace)).toBe(true);
        expect(before.stdout.startsWith(after.stdout)).toBe(true);
      }
    }
  });

  test.each([
    "git push || true",
    "git push || echo failed",
    "git push &",
    "for branch in a b; do git push origin $branch; done",
    "{ git push; } | cat",
    "bash -c 'git push | cat'",
    "x=$(git push; true)",
    "false | true || echo extra; git push | cat",
    "if false | true; then echo extra; fi; git push | cat",
    "while false | true; do break; done; git push | cat",
    "! false | true; git push | cat",
    "git push | cat; echo \"exit $?\"",
    "git push | cat; echo \"${PIPESTATUS[0]}\"",
    "f() { false | true || echo extra; }; git push | cat; f",
    "eval 'false | true || echo extra'; git push | cat",
    "set +o pipefail; git push | cat",
    "set -o pipefail; set +o pipefail; git push | cat",
    "trap 'echo extra' ERR; git push | cat",
    "git push | cat; trap 'echo extra' ERR; false | true",
    "git push | cat; . ./next.sh",
    "git push | cat; source ./next.sh",
    'git push | cat; eval "$next"',
    "git push; function f { echo f; }; f",
    "! git push; echo done",
    "! git push | tail -3",
    "git push | tail -3; [[ -o pipefail ]] && echo extra",
    "git push | tail -3; [ -o pipefail ] && echo extra",
    "git push | tail -3; shopt -qo pipefail && echo extra",
    "git push | tail -3; set -o > options.txt",
    "git push | tail -3; set +o | grep -q 'set -o' && echo extra",
    "git log | head -1; git push | tail -3",
    "git push | tail -3 && git log | head -1; echo done",
    "git commit -m \"$(git log -1 --format=%s | tr a-z A-Z)\" | tail -1",
    "git push | tail -3; git commit -m x | tail -1",
    "{ git push | tail -3; }; echo done",
    "git push 2>&1 | tail -3\necho done | cat",
    "git push | cat; false | true",
    ": marker; git push | cat; printf '%s\\n' \"$_\"",
    "git push | cat; bash -c 'false | true && echo visible'",
    "false && git push && echo skipped; echo cleanup",
    "[ -n \"$branch\" ] && git push; echo cleanup",
    "git diff --quiet && git commit -m x; echo cleanup",
    "grep -q main branch.txt || git push; echo cleanup",
    "if true; then :; fi && git push; echo cleanup",
    "[ -n \"$branch\" ] && git push | tail -3; echo cleanup",
    "git fetch || git push; echo cleanup",
    "[ -n \"$branch\" ] && exit && git push; echo cleanup",
    "(false || exit) && git push; echo cleanup",
    "test -d . && cd . || exit > /missing/dir/out && git push; echo cleanup",
    "git clone -q ../remote.git copy && git commit --allow-empty -m first; echo done",
    "git commit -F - <<EOF | tail -1\n$(git log | head -1)\nEOF",
    "git push | tail -3; shopt -o > options.txt",
    "bash <<EOF\ngit push \\\n| tail -3\nEOF",
  ])("refuses instead of rewriting when no rewrite keeps every other command as it was: %s", (command) => {
    expect(exitMaskRewrite(command)).toBeUndefined();
    expect(refused(command)).toBe(true);
  });

  test("keeps the text a heredoc gives a real commit when it rewrites the call", () => {
    const command = "git commit -q --allow-empty -F - <<EOF\nline one \\\nEOF\nsecond line\nEOF\necho done";
    const rewrite = exitMaskRewrite(command);
    expect(rewrite).toBe("git commit -q --allow-empty -F - <<EOF || exit\nline one \\\nEOF\nsecond line\nEOF\necho done");
    const messageAfter = (text: string) => {
      const repo = temp.make("heredoc-repo-");
      const env = { PATH: "/usr/bin:/bin", HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Robin", GIT_AUTHOR_EMAIL: "robin@example.invalid", GIT_COMMITTER_NAME: "Robin", GIT_COMMITTER_EMAIL: "robin@example.invalid" };
      expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
      const run = spawnSync("bash", ["-c", text], { cwd: repo, env, encoding: "utf8" });
      return { status: run.status, output: run.stdout, message: spawnSync("git", ["log", "-1", "--format=%B"], { cwd: repo, env, encoding: "utf8" }).stdout };
    };
    expect(messageAfter(rewrite ?? "")).toEqual(messageAfter(command));
    expect(messageAfter(command).message).toBe("line one EOF\nsecond line\n\n");
  });

  describe("with a real git and a local remote", () => {
    const pushRepo = (accepts: boolean) => {
      const root = temp.make("push-repo-");
      const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Robin", GIT_AUTHOR_EMAIL: "robin@example.invalid", GIT_COMMITTER_NAME: "Robin", GIT_COMMITTER_EMAIL: "robin@example.invalid" };
      const git = (...args: string[]) => expect(spawnSync("git", args, { cwd: root, env }).status).toBe(0);
      git("init", "-q", "--bare", "remote.git");
      writeFileSync(join(root, "remote.git/hooks/pre-receive"), `#!/bin/sh\nexit ${accepts ? 0 : 1}\n`);
      chmodSync(join(root, "remote.git/hooks/pre-receive"), 0o755);
      git("init", "-q", "work");
      git("-C", "work", "commit", "-q", "--allow-empty", "-m", "first");
      git("-C", "work", "remote", "add", "origin", "../remote.git");
      writeFileSync(join(root, "work/notes.txt"), "staged\n");
      return (command: string, where = "work") => {
        const run = spawnSync("bash", ["-c", command], { cwd: join(root, where), env, encoding: "utf8" });
        const remote = spawnSync("git", ["-C", "remote.git", "log", "-1", "--format=%s", "main"], { cwd: root, env, encoding: "utf8" }).stdout;
        return { status: run.status, stdout: run.stdout, remote };
      };
    };

    test.each([
      ["git push -q origin HEAD:main && false; echo cleanup", "git push -q origin HEAD:main || exit && false; echo cleanup", "cleanup"],
      ["cd . && git push -q origin HEAD:main 2>&1 | tail -3; echo cleanup", "set -o pipefail; cd . && git push -q origin HEAD:main 2>&1 | tail -3 || exit; echo cleanup", "cleanup"],
      ["git push -q origin HEAD:main; git log -1 --format=%s", "git push -q origin HEAD:main || exit; git log -1 --format=%s", "first"],
      ["test -d . && cd . || exit && git push -q origin HEAD:main; echo cleanup", "test -d . && cd . || exit && git push -q origin HEAD:main || exit; echo cleanup", "cleanup"],
      ["git add -A && git commit -q -m staged; git push -q origin HEAD:main; git show --format=%s --name-only HEAD", "git add -A && git commit -q -m staged || exit; git push -q origin HEAD:main || exit; git show --format=%s --name-only HEAD", "staged\n\nnotes.txt"],
      ["printf 'piped message' | git commit -q --allow-empty -F -; git push -q origin HEAD:main; git log -1 --format=%s", "printf 'piped message' | git commit -q --allow-empty -F - || exit; git push -q origin HEAD:main || exit; git log -1 --format=%s", "piped message"],
    ])("runs the same commands as the original after an accepted push, and stops after a rejected one: %s", (command, rewrite, printed) => {
      expect(exitMaskRewrite(command)).toBe(rewrite);
      const accepted = pushRepo(true)(rewrite);
      expect(accepted).toEqual(pushRepo(true)(command));
      expect(accepted.stdout).toContain(printed);
      const rejected = pushRepo(false)(rewrite);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).not.toContain(printed);
      expect(pushRepo(false)(command).status).toBe(0);
    });

    test("commits in a repository that git init made just before", () => {
      const command = "git init -q fresh && cd fresh && git commit -q --allow-empty -m first; git log -1 --format=%s; echo done";
      const rewrite = "git init -q fresh && cd fresh && git commit -q --allow-empty -m first || exit; git log -1 --format=%s; echo done";
      expect(exitMaskRewrite(command)).toBe(rewrite);
      const result = pushRepo(true)(rewrite, ".");
      expect(result).toEqual(pushRepo(true)(command, "."));
      expect(result).toMatchObject({ status: 0, stdout: "first\ndone\n" });
    });

    test("commits in the repository a cd before it names, with the piped message", () => {
      const command = "cd work && printf 'piped message' | git commit -q --allow-empty -F -; git push -q origin HEAD:main; echo cleanup";
      const rewrite = "cd work && printf 'piped message' | git commit -q --allow-empty -F - || exit; git push -q origin HEAD:main || exit; echo cleanup";
      expect(exitMaskRewrite(command)).toBe(rewrite);
      const accepted = pushRepo(true)(rewrite, ".");
      expect(accepted).toEqual(pushRepo(true)(command, "."));
      expect(accepted.remote).toBe("piped message\n");
    });
  });

  test("leaves a command alone that already shows the status", () => {
    expect(exitMaskRewrite("git push")).toBeUndefined();
    expect(exitMaskRewrite("git log | head -3")).toBeUndefined();
  });

  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command, description: "Push" }, cwd: "/" });
  const runHookProcess = (provider: string, call: object, env: Record<string, string> = {}) => {
    const home = temp.make("home-");
    const run = spawnSync(process.execPath, [join(import.meta.dir, "hooks/guards.ts"), provider], { input: JSON.stringify(call), env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8" });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout).hookSpecificOutput;
  };

  test("the hook on Claude runs the rewrite in place of the call and tells the agent, leaving the permission check to Claude", () => {
    const answer = runHookProcess("claude", bash("git push 2>&1 | tail -3; echo done"));
    expect(answer).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { command: "set -o pipefail; git push 2>&1 | tail -3 || exit; echo done", description: "Push" },
      additionalContext: expect.stringContaining("`set -o pipefail; git push 2>&1 | tail -3 || exit; echo done`"),
    });
  });

  test("the hook refuses on Codex, which takes a rewrite only with an allow that skips its approval", () => {
    expect(runHookProcess("codex", bash("git push | tail -3")).permissionDecision).toBe("deny");
  });

  test("the hook refuses when Claude Code forbids personal hooks to change a call", () => {
    expect(runHookProcess("claude", bash("git push | tail -3"), { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "1" }).permissionDecision).toBe("deny");
  });

  test("the hook refuses a rewrite that another shell guard refuses", () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
    writeFileSync(join(home, ".local/state/hedge/settings.json"), JSON.stringify({ "guards.owners": "acme" }));
    const answer = guard(bash("gh pr merge 1 --repo evil/app | tail -3"), home, temp.make("root-"), "claude");
    expect(answer?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("`evil`") });
  });

  test("the hook refuses a form it cannot rewrite, with the fix", () => {
    const reason = runHookProcess("claude", bash("for b in a c; do git push origin $b; done")).permissionDecisionReason;
    expect(reason).toContain("one command per item");
    expect(reason).toContain("set -o pipefail");
  });

  test("the shell hook lets a help call through", () => {
    const call = { tool_name: "Bash", tool_input: { command: "hedge proof save --help | head -60" }, cwd: "/" };
    expect(guard(call, temp.make("home-"), temp.make("root-"))).toBeUndefined();
  });
});
