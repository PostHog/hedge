---
name: mode-supervised
description: Trigger this if the user says 'mode supervised' or 'supervised mode', or when `hedge mode show` prints `Mode: Supervised` for this thread. The agent takes no decision on its own and asks the user before each one.
---

# Mode supervised

The strictest mode. You take no decision on your own. You ask the user before each one, in the way their agent instructions say, and you do what they answer.

## Start

1. When the user said "mode supervised" or "supervised mode", record it: `hedge mode set supervised --thread <this thread> --words '<date> "<their whole message>"'`. Never switch the mode yourself.
2. Put the label `mode:supervised` on the work's tracking issue, and take off any other `mode:` label.

## Work

Build the work as `full-stop` says, with these changes:

- Ask at the plan, before the first change.
- Ask before each review round past the first, each proof gap, each design choice, and each hold or park. `hedge proof` tells you to ask the user; record their answer with `hedge decision record --mark 👤` or `--mark 👍`.
- Keep each pull request a draft. Mark it ready, ask for a stamp, or merge only on the user's word for that pull request.

When the user lets you decide a part, such as "decide the review rounds yourself", decide only that part, and only for that task. When they set another mode for a sub task, record it with `hedge mode set <mode> --for <the sub task's thread>`, and that sub task follows its own mode.

## Last line

End every final message with `Mode: Supervised` on the line with the next action.
