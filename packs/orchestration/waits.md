# Waits

How a T3 thread waits, and what Hedge checks before a turn ends.

## Thread states

- **Working**: a turn runs, or the thread waits on something that wakes it: a pull request watch, a child task, a thread wait, a background command, or a scheduled check.
- **My move**: the turn ended, and nothing wakes the thread. It is in my inbox.
- **Settled**: the thread owns no open pull request and asks nothing, or it waits only on its own scheduled check.
- **Snoozed**: hidden until a date. Snooze a thread only when I ask for it. A snooze hides the thread's pull requests and questions behind a timer.

## Waiting on an event

Keep the thread Working with something that wakes it, then end the turn and say who or what you wait on.

- **A pull request**: call `watch_pull_request`. With `until: "merged"`, the thread stays Working until the pull request merges or closes. T3 wakes it on failed checks, passed required checks, new comments or reviews, conflicts, and once on the merge or close, except a merge or close that the watching thread made itself through the CLI. Use it when you act on the pull request yourself, such as a merge after approval. With `until: "checks"`, the thread comes to me once the checks finish. Use it for a pull request you hand to me.
- **A child task**: its completion wakes you. Do not poll it.
- **Another thread**: call `t3_thread_wait`.
- **A command**, such as a deploy or a CI run: run it in the background and pass its task id to `t3_background_wait`.

## Nothing to wake it

When the answer comes by email, from a person on Slack, or from another place T3 does not watch, bind a `schedule_task` to the thread for a re-check, or say so and end the turn on my move. Never snooze a thread to hide a wait.

## Waiting on its own schedule

For a post-deploy check or a timed re-check, bind a `schedule_task` to the thread and check that it has a next run. Then settle the thread with `t3_thread_organize`. The task wakes the thread. A clean check settles it again; a problem or a question keeps it in my inbox.

## On each wake

Read the live state first: a wake can name an old head. Then do what you can alone, such as fixing CI, answering review-bot threads, or running the gate. When the next move is mine, end the turn with the status and my next action, or ask.

## Waiting on me

Ask with the question tool in the same turn, never in prose. A pending question brings the thread back to me even while it waits or is snoozed. Prose in a hidden thread stays hidden. Keep one pending question card per thread. To message a thread that waits on a card, follow the `t3_thread_send` rule in `~/.agents/AGENTS.md`.

## Owning thread

Every open pull request you open for me, each layer of a stack included, has exactly one **owning thread**: the thread that links it and watches it, from its opening until it merges or closes. The owning thread reacts to comments, CI, and conflicts as `babysit-pr` says, and starts the merge once it is ready and I gave the merge word.

- In a map or loop whose lanes run as `delegate_task` subthreads, the conductor or coordinator owns the pull requests. A subthread never calls `watch_pull_request`. The conductor wakes it with `t3_thread_send` for CI, review, conflict, and rollout turns.
- Keep the watch through handoffs and parks.
- Hand each open pull request over before the thread settles, archives, or moves: send the thread that takes it over a message that asks it to link the pull request with `link_pull_request`, then run `hedge pr handover --pr <url> --to <thread id>`.

## What Hedge checks

The `orchestration` and `pull-requests` packs check these before a turn ends or a call runs:

- **A decision in prose in a hidden thread.** When your last message asks me a decision in prose, and the thread stays out of my inbox after the turn because it is snoozed, waits on a task or a thread, or watches checks, Hedge sends the turn back. Ask with the question tool. When you cannot, because a skill asks in prose or I turned the card down, end the turn with your complete reply again: T3 shows only the last message.
- **A background command left running.** When a background command that this turn started still runs and nothing waits on it, Hedge sends the turn back. Pass it to `t3_background_wait`, or end the turn again when it is a server meant to outlive the turn.
- **An unproven pull request.** When the thread owns a pull request and waits on nothing, Hedge sends the turn back until `hedge proof gate` passed on its pushed head. To park for me, ask with the question tool or end with a `NEEDS_HUMAN:` line.
- **A card in a prose thread.** Hedge denies the question tool in a thread whose title starts with a mark in `orchestration.proseTitles`. Write the questions in your last message, numbered.
- **A settle that drops a pull request.** Hedge refuses to settle or archive a thread that owns an open pull request that no other open thread links. Hand it over first, or close or merge it. Hedge also refuses to settle or snooze a thread I pinned.

The file `~/.config/hedge/ask-guard.off` turns off the background, proof, and card checks on a machine. The prose check stays on.
