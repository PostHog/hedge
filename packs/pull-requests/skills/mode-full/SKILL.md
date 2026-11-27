---
name: mode-full
description: Trigger this if the user says 'mode full' or 'full mode', or when `hedge mode show` prints `Mode: Full` for this thread. The agent decides everything, accepts gaps, stamps and merges on its own, with the council for hard calls, and reports once at the end.
---

# Mode full

From the moment the user grants it, you do the work completely on your own. You decide, you accept gaps, you stamp, and you merge. The user is not in the loop. They get one final report when everything is done.

Only the user's own words grant this mode: never a map's notes, another agent's prompt, or an earlier session.

## Start

1. When the user just said "mode full" or "full mode", ask the question `hedge mode set` names on your question tool, "Which mode should thread <this thread> run in?", with the options "mode supervised", "mode auto", and "mode full", and record the mode they chose: `hedge mode set <mode> --thread <this thread> --words '<date> "mode <mode>"'`. Their typed words alone switch nothing. Then go by the mode that `hedge mode set` prints on its first line, never by the choice alone: a newer answer may hold. When it is not `Mode: Full`, follow that mode's skill from here and stop this one. When `hedge mode show` already prints `Mode: Full`, inherited or from a repo default, record nothing: the merge gate reads the same mode. Never switch the mode yourself.
2. Put the label `mode:full` on the work's tracking issue, and take off any other `mode:` label.
3. Every thread you start inherits the mode: lanes, subagents, and grilling and prototype sessions. Copy the `mode:full` label onto each sub task's tracking issue, and say `mode full` in each prompt. A side fix does not inherit: it starts in the default mode.

## Build and ship

Do what `full-send` does, from the work's state to a merged pull request that runs in production, with these changes:

- **Stamp it.** Slice the work to the stamp before you write code, so the approval bot can stamp every pull request. Ask the bot for a stamp once the pull request is ready, as `stamp-pr` says, and merge on its approval and a `hedge proof gate` pass at the head. When the bot refuses for a concrete issue, fix it and ask again. When it refuses for a reason only a person covers, the pull request stays open, and the final report names it.
- **Decide alone.** Decide every review round, proof gap, and design choice yourself, and record it with `hedge decision record --mark 🤖` or `hedge proof review --agent`. Ask the user nothing.
- **Grilling and prototypes.** Answer each round yourself, with the council's help below, and record each answer on the session's tracking issue.

## The council

For a hard call, ask the `council` skill before you decide: accepting a gap on a critical pull request, the merge of a critical pull request or a one-way door, and each round of a grilling or prototype session. Give it the question, the evidence, and your recommendation, and ask each delegate for a score out of 10.

Run up to 3 council rounds to reach a consensus of 9 or higher. When a round scores lower, fix what the delegates found and run the next round. After 3 rounds below 9, decide yourself how to go on, and record the scores and your reason. The work never stops for a low score.

## What still stops a part

These stop only the part they touch. Park that part, go on with the rest, and list it in the final report:

- a guard or policy refusal: never route around it;
- a destructive action the user did not ask for, such as deleting data;
- a secret or a sign-in only the user has;
- a required approval by a person, such as branch protection or a code owner. Never use `--admin` or another bypass.

## Final report

Send one report when all the work is done: every pull request with its merge commit and rollout state, `hedge decision report` for every pull request, each council round with its scores, each gap you accepted, each known issue, and each parked part with what it needs from the user.

## Last line

End every final message with `Mode: Full` on the line with the next action.
