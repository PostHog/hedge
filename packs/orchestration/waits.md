# Waits

How a T3 thread waits, and what Hedge checks before a turn ends.

## Thread states

- **Working**: a turn runs, or the thread waits on something that wakes it: a pull request watch, a child task, a thread wait, or a background command.
- **My move**: the turn ended, and nothing wakes the thread. It is in my inbox.
- **Settled**: the thread owns no open pull request and asks nothing. It may wait on its own scheduled check.
- **Snoozed**: hidden until a date. Snooze a thread only when I ask for it. A snooze hides the thread's pull requests and questions behind a timer.

## Waiting on an event

Keep the thread Working with something that wakes it, then end the turn and say who or what you wait on.

- **A pull request**: call `watch_pull_request`.
  - With `until: "merged"`, T3 wakes the thread on failed checks, passed required checks, new comments or reviews, conflicts, and once on the merge or close. It does not wake the thread for a merge or close that the thread made itself through the CLI. Use it when you act on the pull request yourself, such as a merge after approval.
  - With `until: "checks"`, the thread comes to me once the checks finish. Use it for a pull request you hand to me. When I hand it back, such as with a merge word, watch it again with `until: "merged"`.
  - A watch ends after many comment-only wakes. When a wake says the watch ended, and the pull request is still open, call `watch_pull_request` again.
- **A child task**: its completion wakes you. Do not poll it.
- **Another thread**: call `t3_thread_wait`. When it returns a finished run, act on it in the same turn. When it times out with `next`, end the turn. When it times out without `next`, read its status: while it runs, call it again; when it waits on a question or an approval, answer it or ask me.
- **A command**, such as a deploy or a CI run: wait in one call that blocks until it ends. When it outlasts the shell's foreground limit and your tools include `t3_background_wait`, run it in the background and pass its task id to `t3_background_wait`. Without that tool, as on Codex, keep the command in one shell session and wait on it in blocking calls that each end within the limit.

## Nothing to wake it

When the answer comes by email, from a person on Slack, or from another place T3 does not watch, end the turn on my move with what you wait for. To check again at a set time instead, follow the next section. Never snooze a thread to hide a wait.

## Waiting on its own schedule

For a post-deploy check or a timed re-check in a thread that owns no open pull request, bind a `schedule_task` to the thread and check that it has a next run. Then settle the thread with `t3_thread_organize`. The task wakes the thread. A clean check settles it again; a problem or a question keeps it in my inbox. After a merge, the `rollout` skill's **Settle between checks** says what each check reads.

## On each wake

Read the live state first: a wake can name an old head. Then do what you can alone, such as fixing CI, answering review-bot threads, or running the gate. When the next move is mine, end the turn with the status and my next action, or ask.

## Waiting on me

Ask with the question tool in the same turn. A new question card brings the thread back to me even while it waits or is snoozed. A card that was already open when I snoozed the thread stays hidden until the snooze ends. Prose in a hidden thread stays hidden. Keep one pending question card per thread. To message a thread that waits on a card, follow the `t3_thread_send` rule in `~/.agents/AGENTS.md`.

A thread whose title starts with a mark in `orchestration.proseTitles` asks in prose: write the questions, numbered, in your last message.

## Owning thread

Every open pull request you open for me, each layer of a stack included, has exactly one **owning thread**: the thread that links it and watches it, from its opening until it merges or closes. The owning thread reacts to comments, CI, and conflicts as `babysit-pr` says, and starts the merge once it is ready and I gave the merge word.

- In a map or loop whose lanes run as `delegate_task` subthreads, the conductor or coordinator owns the pull requests, as `~/.agents/guides/t3.md` says.
- My "Merge" answer on a merge card is my merge word in the thread that asked it, for that pull request at that head. That thread merges or enqueues it in the same turn, as soon as the merge gate lets that head through: a `hedge proof gate` pass at that head, except in a repository that skips the gate. It never hands the word to another thread, and never asks me to repeat it in another thread. A new head voids it.
- A standing order of mine for a map, such as "merge on your own until the next milestone", is my merge word for each pull request the thread I gave it in merges, held gaps included. When I type one, ask me once on a card: a question that names the map, `standing-order`, and the end date when I named one, with the option "Merge on your own". Record my choice with `hedge decision record --mark 👤 --class merge --kind standing-order --pr <map owner/repo#n>`, adding `--condition 'until <YYYY-MM-DD>'` for an end date. End it with `hedge decision void <id> --reason '<the milestone reached>'` when the map reaches its milestone.
- Keep the watch through handoffs and parks.
- Hand each open pull request over before the thread settles, archives, or moves, to a thread on the same machine: `hedge pr handover` finds the new thread only in this machine's T3.
  1. Ask the thread that takes it over to link it with `link_pull_request` and watch it with `watch_pull_request`.
  2. Check with `list_thread_pull_requests` that the new thread links and watches it.
  3. Run `hedge pr handover --pr <url> --to <thread id>`, then settle the old thread.

## What Hedge checks

With the `question-guard` workflow on, the `orchestration` pack checks the first three when a turn ends, and the last when you call the question tool. A turn-end check sends a turn back once; when you end the turn again, it ends. Threads whose title starts with a mark in `orchestration.proseTitles` skip the prose check, and so do most child threads. The checks are a safety net, not the rule: follow this guide whether or not a check fires.

- **A decision in prose in a hidden thread.** When your last message asks me a decision in prose, and the thread stays out of my inbox after the turn because it is snoozed, waits on a task or a thread, or watches checks or an approval, Hedge sends the turn back. Ask with the question tool. When you cannot, because a skill asks in prose or I turned the card down, end the turn with your complete reply again: T3 shows only the last message.
- **A background command left running.** When a Claude background shell that this turn started still runs and no `t3_background_wait` waits on it, Hedge sends the turn back. Pass it to `t3_background_wait`, or end the turn again when it is a server meant to outlive the turn.
- **A wait that nothing wakes.** When your last line starts with ⏳ or 🔕 and the thread waits on nothing that wakes it: no pull request watch until it merges or whose checks still run, no running child task or background task, no thread wait, and no scheduled check bound to it, Hedge sends the turn back. Child threads skip this check. Give the wait something that wakes it, as **Waiting on an event** says, or end the turn on my move.
- **A card in a prose thread.** Hedge denies the question tool in a thread whose title starts with a mark in `orchestration.proseTitles`.

With the `pr-owners` workflow on, the `pull-requests` pack refuses to settle or archive a thread with `t3_thread_organize` while it owns an open pull request that no other open thread links. Hand it over first, or close or merge it. It also refuses to settle or snooze a thread I pinned.

The file `~/.config/hedge/ask-guard.off` turns off the background, wake, and card checks on a machine. The prose check stays on.
