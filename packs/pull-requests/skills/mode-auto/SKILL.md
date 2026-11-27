---
name: mode-auto
description: Trigger this if the user says 'mode auto' or 'auto mode', or when `hedge mode show` prints `Mode: Auto` for this thread. The agent works on its own until each pull request is ready to merge, then brings the user one merge card with an explainer.
---

# Mode auto

The default mode. You run the work on your own until each pull request is ready to merge. Then you stop and bring the user one merge card. You decide every routine question yourself and record it. The user sees your decisions once, on the merge card and in the explainer.

## Start

1. When the user said "mode auto" or "auto mode" and `hedge mode show` prints another mode, ask the question `hedge mode set` names on your question tool, "Which mode should thread <this thread> run in?", with the options "mode supervised", "mode auto", and "mode full", and record the mode they chose: `hedge mode set <mode> --thread <this thread> --words '<date> "mode <mode>"'`. Their typed words alone switch nothing. Never switch the mode yourself.
2. Put the label `mode:auto` on the work's tracking issue, and take off any other `mode:` label.
3. Run `hedge mode show` when you are unsure which mode a thread runs in.

## Build

Build the work as `full-stop` says: slice it, build it test-first, prove it, and review it. `full-stop` turns on **Ready on green** in this mode: mark each pull request ready once it passes the ready gate. These parts of `full-stop` change:

- **No plan question.** Decide the plan yourself and write it on the tracking issue, with each decision and its reason. Ask only for what the next section keeps for the user.
- **Review and proof.** Decide how many review rounds and final reads run, which proof gaps you accept, and when the review stops, as `hedge proof` prints. Record each decision with `hedge decision record --mark 🤖` or `hedge proof review --agent`.
- **Stamp.** When the repo has an approval bot, slice the work to the stamp before you write code, and ask the bot for a stamp once the pull request is ready, as `full-stop` **Ready on green** says. Its verdict goes on the merge card. Never merge on the stamp alone.

## What you bring to the user at once

Ask with the question tool, in one card, only for:

- a **big gap**: a proof that cannot run on a critical pull request, or a proof the user named;
- a **blocker**: no part of the work can move without the user, such as a secret only they hold;
- a **critical issue**: an open security finding, a guard or policy refusal, a destructive action the user did not ask for, a new public contract, or a one-way door.

Keep working on every other part while the card waits.

## Grilling and prototypes

A grilling or prototype session always has the user in the loop: ask each round on the question tool, and wait for the answer. The mode never answers for them.

## Merge card

When every pull request of a stack is ready, bring them together: one merge card for the stack, or for every stack of the work once all of them are ready. Each row is the merge card line of `hedge proof gate`. For each pull request, the card also says:

- the stamp verdict, or the forecast when no stamp ran;
- your recommendation on a team review: **Team review** when it makes a decision the team should know, **Heads-up** when it changes a core path, or **No team review**;
- each gap you accepted, and each known issue.

Before the card, build an explainer of the whole work across its stacks with `explain-diff`, unasked. It names every decision you made, every gap you accepted, and every known issue, so the user reviews the work through it. Link it in the card's question text.

A pull request with a gap you accepted gets its own question on the card, as the merge gate's refusal names it. The user's "Merge" is the merge word for that pull request at that head. Record it with `hedge decision record --mark 👤 --class merge`, merge in the same turn, and roll out with `rollout`. A push after the answer needs a new card.

## Last line

End every final message with `Mode: Auto` on the line with the next action.
