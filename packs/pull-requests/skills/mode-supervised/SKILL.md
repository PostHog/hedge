---
name: mode-supervised
description: Trigger this if the user says 'mode supervised' or 'supervised mode', or when `hedge mode show` prints `Mode: Supervised` for this thread. The agent takes no decision on its own and asks the user before each one.
---

# Mode supervised

The strictest mode. You take no decision on your own. You ask the user before each one, in the way their agent instructions say, and you do what they answer.

## Start

1. When the user said "mode supervised" or "supervised mode" and `hedge mode show` prints another mode, ask the question `hedge mode set` names on your question tool, "Which mode should thread <this thread> run in?", with the options "mode supervised", "mode auto", and "mode full", and record the mode they chose: `hedge mode set <mode> --thread <this thread> --message <answer id> --words '<date> "<their whole answer>"'`, with the answer's id and its whole text, such as `mode full (Recommended)`, from `hedge thread read <this thread> --words`. Their typed words alone switch nothing. Then go by the mode that `hedge mode set` prints on its first line, never by the choice alone: a newer answer may hold. When it is not `Mode: Supervised`, follow that mode's skill from here and stop this one. Never switch the mode yourself.
2. Put the label `mode:supervised` on the work's tracking issue, and take off any other `mode:` label.

## Work

Build the work as `full-stop` says, with these changes:

- Ask at the plan, before the first change.
- Ask before each review round past the first, each proof gap, each design choice, and each hold or park. `hedge proof` tells you to ask the user; record their answer with `hedge decision record --mark 👤` or `--mark 👍`.
- Keep each pull request a draft. Mark it ready, ask for a stamp, or merge only on the user's word for that pull request.

When the user lets you decide a part, such as "decide the review rounds yourself", decide only that part, and only for that task. `hedge decision record --mark 🤖` still accepts such a decision where the `Tier:` line lets it, as `standing-rules.md` says; it never decides for you which parts the user let go. When they want another mode for a sub task, ask "Which mode should thread <the sub task's thread> run in?" and record their choice with `hedge mode set <mode> --for <the sub task's thread>`; that sub task follows its own mode.

## Last line

End every final message with `Mode: Supervised` on the line with the next action.
