# Setup note: Guards

Read this when the person picks the Guards pack.

Guards are hooks that check each shell command an agent runs and refuse the
risky ones, such as code piped from the network into a shell. A refusal tells
the agent whom to ask. Two guards start on with the pack, and the others
start off. Ask with your question tool, in one call:

- **Whether to keep the two guards that start on.** Recommend both:
  - `shell-guards`: refuses network code piped into a shell, packages the
    project lacks, GitHub owners outside their list, `pkill -f`, skipped Git
    hooks, force pushes without a lease, and pushes to `main`. To leave it
    off, add `--workflows shell-guards=off`.
  - `package-age`: installs only package versions at least three days old.
    To leave it off, add `--workflows package-age=off`.
- **Their first name**, for the refusal message. Add
  `--set guards.person=<name>`.
- **Which GitHub owners agents may use**: their login and their orgs,
  separated by commas. Add `--set guards.owners=<owners>`. The shell guards
  then also refuse a gh owner that is not spelled out, such as `$ORG` or
  `$(…)`, because the shell could fill in any owner.
- **Which repositories take pushes straight to `main`**, if any, as
  `owner/name` separated by commas. The shell guards refuse a push to `main`
  or `master` of any other GitHub repository, unless its `AGENTS.md` says to
  push there. Add `--set guards.main-push-repos=<repos>`.

`merge-gate` makes an agent's Trunk enqueue or merge wait for a
`hedge proof gate` pass at the head of each open layer of the PR's stack, or
for the person's gate override at that head. Turn it on only when the person
proves PRs with the Quality gates pack: add `--workflows merge-gate=on`.
Repositories that merge without the gate, such as their own tooling, go in
`--set guards.merge-gate-exempt=<owner/name or owner/*, ...>`. In every
repository, these included, a head with a proof gap that an agent accepted
waits for the person's merge word for that head. That word is their "Merge"
answer on a merge card, and it counts only in the T3 thread that asked it, so
that thread merges or enqueues the PR itself. A standing order of the person's,
their "Merge on your own" answer on a question card recorded with
`hedge decision record --kind standing-order`, is that word for every PR merged
from that thread until it ends. It needs a gate pass at the head all the same,
also in a repository that `guards.merge-gate-exempt` lets skip the gate.

When the person adds Claude allow rules that let agents request reviewers or
post `/trunk merge` without the auto-mode review, list the same rules, one per
line, in `guards.allow-rules`. The shell guards then refuse each command such a
rule matches that does more than request reviewers or post one bare Trunk
command. The guards refuse every shell call while that list names a rule they
cannot narrow.

`gh-stack` installs GitHub's `gh stack` extension at a pinned version and
checks its digest. The shell guards refuse every other gh extension, and count
the branches a `gh stack push` sends toward the burst limit. Turn it on only
when the person stacks pull requests with `gh stack`: add
`--workflows gh-stack=on`.

Two more guards run only on a Linux devbox and need root and the person's
keyboard there: `git-allowlist`, a signed list of the GitHub owners Git may
use, and `oom-survival`, which stops a runaway build before memory runs out.
Leave them off on a first setup.
