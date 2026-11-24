# Setup note: Orchestration

Read this when the person picks the Orchestration pack.

**Maps** and **side threads** work with defaults. A map is one issue that
lists tickets; a conductor thread starts one subthread per ticket under its
lineage, and a sidebar thread only for live grilling and prototypes. Maps
live in the issues of their profile repo unless they name another
repo with `--set orchestration.tracker=<owner/name>`.

Three workflows run by themselves on a schedule and start off:
`quality-loop`, `signal-loop`, and `pr-digest`. Each runs on one machine only, on
the first node the profile lists, or on the hub when there is no node.
While that node is stopped, they do not run; take it out
with `hedge devbox remove <host>` and they move to the next node. Each needs
answers:

| Setting | What to ask | Used by |
| --- | --- | --- |
| `orchestration.loopProject` | The folder of a repo they already opened in T3 Code on that machine, where the loops and the digest start threads. | All three |
| `orchestration.qualityArea` | The paths in that repo the loops may change, such as `src/api`. | The two loops |
| `orchestration.ledgerRepo` | A private repo for the loops' ledger. It records production numbers, so it stays private. | The two loops |

On a first setup, recommend them off: they run at night without a person,
and they need a node and a repo the person works in. A preset can turn them
on, such as `everything`. With such a preset, `hedge setup --chat` on the hub
ends with code `2` and one `--set` line for each answer it needs, and
applies nothing until it has them. So add
`--workflows quality-loop=off,signal-loop=off,pr-digest=off` to the setup
command, or, when they want the loops now, ask the three answers before step
7 and add them as `--set` lines. Once a node runs, turn one on with its answers:

```sh
hedge packs --workflows quality-loop=on --set orchestration.loopProject=<folder> --set orchestration.qualityArea=<paths> --set orchestration.ledgerRepo=<owner/name>
```

## Question guard

The `question-guard` workflow is on by default. It installs one hook file,
`hooks/ask-guard.ts`, for two events in Claude and Codex:

- **Stop.** A top-level T3 thread that ends its turn with a decision in prose
  is stopped once and told to ask with the question tool. When that check lets
  the stop pass, the proof check and then the wake check below run.
- **PreToolUse on the question tool.** A card in a thread whose title starts
  with one of your prose titles is turned back. See below.

A message that an agent or `hedge thread send` sends to a thread whose
running turn waits on a question card steers that turn by default on Claude
and Codex, which steer without interrupting. The card stays open, and the
thread's agent reads the message when the person answers. In mode `auto`,
`hedge thread send` sends `queue` to a thread that waits on a card when the
message is a slash command, such as `/goal`, which T3 can run at once and
stop the turn, or when the thread runs on another provider, such as
Antigravity, whose steer can fail a turn that waits on a card.

### Threads that ask in prose

Some threads get messages that a job queues into them, such as one alert
thread for each incident. A pending question card holds those messages until
the person answers it. The setting `orchestration.proseTitles` names the
title starts of such threads, separated by commas, such as `⚠️, 🚨`. It is
empty by default. A thread whose title starts with one of them:

- ends its turn with a decision in prose, and the Stop check lets it pass;
- gets each `AskUserQuestion` or `request_user_input` call denied, with the
  reason to write the questions in its last message.

The match ignores the emoji variation selector, so `⚠️` also matches `⚠`. The
card check lets a card pass on any error, and while
`~/.config/hedge/ask-guard.off` exists.

### Wake check at Stop

A top-level T3 thread whose last line starts with ⏳ (it waits on someone
else) or 🔕 (it waits on its own scheduled check) is stopped once when nothing
can wake it. A fork counts as top-level. It runs after the proof check, so a
thread that owes a proof step hears that step first. Hedge never snoozes or
settles the thread. A thread that waits
belongs in T3's waiting state, so the reply tells the agent to give the wait
something that wakes it: `watch_pull_request` with `until: "merged"` for a PR,
including one in the merge queue; the lane's `delegate_task` child or
`t3_thread_wait`; or `schedule_task` bound to the thread for a check at a time.

The stop passes when any of these holds:

- the kill switch file exists, or a stop hook already continued this turn;
- the thread waits on a child task, a thread wait, or a command or monitor it
  awaits, as in the proof check below;
- T3 awaits a PR watch of the thread: the watch runs `until: "merged"`,
  its checks still run or are not read yet after a push, or its PR merged,
  and the PR's stack did not dismiss it. This is T3's own rule for an
  awaited watch task. T3 shows no task while a turn runs, so the check
  reads the watch on the PR itself. A watch whose checks finished, such as
  one on a PR in the merge queue, one that waits on an approval, or one on
  a closed PR, is no wait unless it runs `until: "merged"`;
- on Claude, a subagent, a monitor, a background shell, or a session cron
  runs;
- an enabled scheduled task bound to the thread has a next run time in
  T3's state, a real time in the UTC form T3 writes, also one that is due
  and has not run yet;
- the thread is snoozed, waits on a question card, is a subagent thread, a
  side chat or a workflow agent step, or was delegated from another machine;
- the hook runs in a model session that another one started, as in the proof
  check below;
- any read fails, or the proof check and this check together take longer
  than 10 seconds. The two share one deadline, and a check that answers
  after it lets the stop pass.

### Proof check at Stop

A T3 thread that owns an open PR is stopped once when it ends its turn while
`hedge proof gate` has not passed at the PR's pushed head. The reason names the
one step still owed, with the command for that PR:

- push the local commits on the PR's branch, then run the gate;
- commit and push changed tracked files, or restore them, on the PR's branch
  or on a detached HEAD at the PR's pushed head;
- push the commits of a detached HEAD in the PR's worktree, when HEAD
  continues the PR's pushed head. On a stack, that is the nearest layer that
  HEAD continues;
- run the gate at the pushed head, when no run is recorded there;
- fix what the last gate run failed on, or, for exit 3, decide each gap by
  tier with `hedge decision record`, or ask the person, or, for exit 75, wait
  for CI with `hedge proof gate --wait 10`, or, when a wait already ran out,
  open the checks it names first.

It checks each open PR the thread owns whose repository is the `origin` of the
thread's checkout. A subagent thread owns nothing while the thread it belongs
to is open, and a conductor is not blocked for PRs linked by an open subagent
in its own separate worktree. A fork owns its own PRs and those of its shared-checkout subagents. Each run of
`hedge proof gate` records its exit code and first failure line for the commit
it judges, as its own numbered file under
`~/.local/state/hedge/proof/<owner>/<name>/<pr>/gate-record/<commit>/`, with
the repository name in lower case. The run writes the file when it starts, as
a failure, and replaces it with its result when it ends. The check reads the
newest file, so an older run that ends late never replaces a newer result,
and a run that crashed counts as failed. The check reads that record, T3's shell
snapshot, and local git. It never runs the gate, a test, a model, or a GitHub
call. It trusts `origin/<branch>` as the pushed head.

The stop passes when any of these holds:

- `~/.config/hedge/ask-guard.off` exists. It turns off the prose-title card
  check and this check;
- a stop hook already continued this turn (`stop_hook_active`), so the check
  blocks at most once per turn;
- the thread waits on a question card, or its last line starts with
  `NEEDS_HUMAN:`;
- the thread waits on a child task, a thread wait, or a command or monitor
  it awaits; on Claude, on a subagent, a monitor, or a scheduled wake-up. A
  command or monitor the thread does not await, such as a dev server or a PR
  watch whose CI has settled, is no wait, as in T3;
- a subagent thread of the thread, such as a delegated task, still runs,
  waits on a question, or awaits work of its own. A fork of the thread is no
  wait;
- a PR watch has not seen CI settle at the pushed head. T3's `checksPending`
  answers this when the watch has it; otherwise no check has passed or
  failed yet;
- the thread was delegated from another machine;
- the hook runs in a model session that another one started, such as a review
  a lane runs with `codex exec`. The model sessions that Hedge starts (the
  judge, reviewers, the arbiter, the eval judge, and `hedge context add`) get
  no `T3CODE_THREAD_ID`, so the check never runs in them;
- any read fails, or the check takes longer than 10 seconds. At the deadline
  it stops the git and `ps` commands it started, and the hook process exits
  once it has answered, even when a helper of those commands still runs.

## Loop pause

The `loop-pause` workflow is on by default. It installs
`hooks/loop-pause.ts` for PreToolUse in Claude and Codex. The setting
`orchestration.loopLedger` names the loops' ledger directory, which holds
`limits.md`, `lanes.md` and `signals.md`. With a context library, it defaults
to its `quality-loop` directory. Without the setting, or when that directory
does not exist, such as on a machine whose loops keep their ledger in
`orchestration.ledgerRepo` elsewhere, the hook does nothing. Any other error
reading the directory denies. Set it to that
ledger's checkout to turn the hook on there.

A thread whose first prompt opens, after any bracketed note on who sent it
(as T3's scheduled tasks add), with a line that starts with "Run" or "Start"
and names a coordinator and the `quality-loop` or `signal-loop` skill, or with
the skill's slash command, is a loop coordinator, whether a schedule or a
person started it. A prompt that asks about a coordinator run, or quotes one
further down, is not. A prompt that opens with "Run" and names both, such as
"Run the quality-loop coordinator audit", counts: while the loops are paused,
start such an audit with "Audit" instead. When such a thread calls
`delegate_task` while `limits.md` says `Paused: yes`, or while the file cannot
be read, has no `Paused:` line, says anything but a plain `yes` or `no` (a
note may follow after a comma, a semicolon, a spaced dash, or in closed
brackets, and any markup around the word must match), or has `Paused:` lines that disagree, the call is denied: the coordinator settles the lanes that ended, keeps
its watches and post-deploy checks, records a no-op run, and starts no lane.
Settling, `watch_pull_request`, `schedule_task`, `t3_thread_send`, and every
other thread pass.

Two commands give the loop skills the same facts:

- `hedge loop check-pause [--ledger <dir>]` exits 0 while the loops run, 1
  while they are paused, and 3 when `limits.md` cannot be read or does not
  clearly say yes or no.
- `hedge loop next-id --kind lane|signal [--ledger <dir>]` prints the next
  lane or signal id, one past the highest row in `lanes.md` or `signals.md`,
  follow-up rows such as `L012b` included.
  It reserves each id with an exclusive file create under
  `~/.local/state/hedge/loop-ids/`, keyed by the ledger directory's real
  path, so two coordinators on one machine that share a checkout never get
  the same id. Two checkouts are like two machines: write the row and push the
  ledger right after.
