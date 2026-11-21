# Hedge glossary

The words the engine, its packs, and its docs use.

## Setup layers

**Hedge**:
The product: the engine, its packs, and the site. Say "PostHog Hedge" once where a reader meets it first, such as a page title or a README heading, so search tells it apart from other projects named Hedge. The command is `hedge`; `fleet` runs the same command, so the habit from before the rename keeps working.
_Avoid_: Fleet, the tool, the framework

**Engine**:
The public Hedge installer and CLI that puts packs and a profile onto a machine.
_Avoid_: Core, framework, starter

**Pack**:
An opt-in bundle of instruction fragments, guides, skills, skill settings, provider config, jobs, and steps that adds one way of working. It is a `pack.json` plus files.
_Avoid_: Module, plugin, add-on, extension, group

**Base pack**:
The one pack every user gets.
_Avoid_: Core, default pack

**In every Hedge**:
The packs every setup gets: Base, and Hub on the hub. The site shows them without a switch.
_Avoid_: Required packs, core packs

**Old pack name**:
The name a pack had before it moved into another pack, such as `context-library` for Memory and `recovery` for Hub. A profile that still lists it keeps working: Hedge reads it as the new pack, with only the old pack's workflows on, and keeps the profile as it is.
_Avoid_: Legacy pack, deprecated pack

**Seed**:
A verb only: to bring an outside pack or plugin into Hedge, such as a Claude plugin marketplace. Hedge has no seed command yet. Never call a pack a seed.
_Avoid_: Import, install (for an outside pack), seeds (for packs)

**Pack source**:
A Git repo that holds packs, fetched at a pinned ref. The engine repo is one, and a profile can list more, such as a private team repo.
_Avoid_: Registry, marketplace, tap

**Profile**:
One person's private repo of answers and files: `hedge.json`, an optional `about-me.md`, and `overrides/`. It is also their dotfiles repo.
_Avoid_: Personal layer, config, dotfiles

**Context repo**:
One person's repo of what their agents learn and record: memory, dreams, notes, to-dos, ideas, research, maps, and logs such as the lessons log and the rollout log. It is meant to be shared with their team, so it may live in the team's GitHub org, but it is never public. The profile holds private answers and is read by Hedge; the context repo holds shared knowledge and is read and written by agents. `context.repo` names it, and the memory, library, map, and log settings take it as their default.
_Avoid_: Personal repo, notes repo, knowledge base

**Workflow**:
One way of working a pack offers, described in one plain sentence. It is on when its pack is on, the profile does not turn it off, everything it needs holds, and every setting it waits for is set.
_Avoid_: Feature, capability

**Preset**:
A named choice of packs and workflows, such as Starter or Everyday, that setup and the page offer.
_Avoid_: Template, bundle

**Model table**:
The model and effort agents use for each kind of work, one table for each AI plan. The Base pack declares it, and a profile can replace any row. Each row names its provider: `claude` and `codex` stand for T3's `claudeAgent` and `codex` instances, and any other value is the id of a T3 provider instance, such as `antigravity`.
_Avoid_: Model policy, casting

**T3 provider instance**:
One agent provider that T3 Code runs, such as `claudeAgent`, `codex`, or `antigravity`: an id, a driver, on or off, and its config. A pack or a profile turns one on with a `t3` config entry whose key is `providerInstances.<id>`. Hedge changes only the instances it declares.
_Avoid_: Agent, backend

## Applying

**Plan**:
Everything one machine should have, computed from the profile, the machine file, and the fetched pack sources.
_Avoid_: Manifest, desired state

**Reconciler**:
The module that resolves a plan, applies it, and checks it.
_Avoid_: Installer, sync

**Machine file**:
`~/.config/hedge/machine.json`: this machine's role, whether it is a Coder workspace, its profile directory, and setup progress. It never enters the profile.
_Avoid_: Local config, state file

## Machines

**Cloud box**:
A Linux machine in the cloud, such as a Coder workspace: the hub or a node. Hedge runs only on cloud boxes. The Mac and the phone run only the T3 Code app, and Hedge installs nothing on them.
_Avoid_: Mac only, local setup

**Devbox**:
A cloud box that Hedge set up, where agents and T3 threads run. A Coder workspace is a devbox from its first `hedge apply`, and signs Git commits with its Coder key.
_Avoid_: Coding box, agent box

**Node**:
A devbox that stays on, where T3 threads do the work. The hub links the nodes and watches their disks.
_Avoid_: Worker box

**Hub**:
The one cloud box that the profile's `hub` names, with `hedge hub here`. Setup starts on it. It runs the items placed on the hub, keeps the pack secrets, such as the Slack, incident.io, and MCP gateway sign-ins, adds the nodes with `hedge devbox add`, and manages them.
_Avoid_: Controller, master box

## Threads

**Question card**:
A question a thread asks the person with the question tool: `AskUserQuestion` in Claude, `request_user_input` in Codex. T3 shows it as a card, and the thread's turn waits until the person answers. A message sent to the thread in a mode other than `queue` cancels the card. T3 queues a message with `freshContext: true` in mode `steer` or `restart`, so that message does not cancel it.
_Avoid_: Prompt, popup, dialog

## Decisions

**Decision ledger**:
The append-only log of every decision about a pull request's proof and process, at `~/.local/state/hedge/decisions.jsonl` on the hub. Other machines read and append it over SSH. `hedge decision` records, lists, and voids its decisions, and `hedge proof gate` reads it.
_Avoid_: Claim file, answer log

**Ask class**:
The kind of question a decision answers, such as a review round, a proof gap, or a status ask. Each decision names one.
_Avoid_: Decision type, category

**Tier**:
The `Tier:` line of a pull request's merge-risk callout at HEAD: critical or non-critical. A pull request without it is ungraded. The tier limits what an agent may decide alone.
_Avoid_: Risk level, grade

**Autonomy**:
The setting `pull-requests.autonomy`: how often an agent asks the user about a review round or a proof gap. On `ask`, the default, `hedge proof` tells the agent to ask the user each time. On `end`, it tells the agent to decide alone as a 🤖 decision, wherever the tier lets it, and the user reads every such decision under Decisions in `hedge decision report`, beside the end table. A one-way door, an ungraded pull request, a panel gap, and a product gap on a critical pull request still go to the user.
_Avoid_: Trust level, mode

**Acceptance**:
A decision that lets the gate pass over a proof gap. The user's acceptance always counts; an agent's acceptance counts only while nothing lapses it.
_Avoid_: Waiver, override

**Lapse**:
The gate no longer counts an agent's acceptance, because the tier changed, CI ran on HEAD, the user keeps the gap owed, or the gap is a panel gap. The gate prints each lapsed decision of a kind that stays open.
_Avoid_: Expiry, revoke

**Reversal**:
The user's own words in a T3 thread, a message they typed in the T3 app or their answer to a question tool, that replace a decision's answer. A GitHub comment never counts, since agents post on GitHub as the user. A reversed decision prints as 👤 with the replaced answer struck through, and counts no more. A reversal takes the time the user wrote their words, and those words must be newer than the decision. One answer reverses one decision. A gap the user keeps owed and a voided decision take no reversal.
_Avoid_: Undo, override

**Brake**:
Two reversals of the agent's decisions in one ask class within 28 days. The brake holds from the later reversal. While it holds, an agent decides nothing alone in that class. Only the user's answer to a question that names the brake and the class lifts it, and only when it comes after the brake. An answer that starts with "Lift" lifts it. A "Yes" lifts it only when the question starts with "Lift the brake on <class>". One answer lifts one brake or records one decision, never both.
_Avoid_: Lock, freeze

**Proof summary**:
The proof state of a pull request at HEAD that the gate builds: each owed kind, the review, the head, CI, the tier, the judge's verdict, and the lapsed and voided decisions. The gate prints its lines from it, and `hedge proof gate --json` prints it. Each `hedge proof gate` saves its summary for its commit, with the pull request's head, base and base SHA on GitHub, the tier, `--landed`, and a fingerprint of the pull request's proof files, the standing rules and the ledger decisions that cover it. The end-of-run report uses a saved summary for its judge's verdict only while all of these still match.
_Avoid_: Proof status, gate result

**End-of-run report**:
The Markdown that `hedge decision report` prints when a lane ends: what is still the user's, merges under the narrow grant, the lane's decisions, one proofs row per pull request, the end table, and the side fixes it started. It never runs the judge. It builds the proof summary again at HEAD, so CI, the standing rules, the decisions and the tier are read as they are now, and it takes the judge's verdict from the summary the gate saved at HEAD. When a decision was recorded after the gate, or the head, base, merge-risk callout or proofs changed, it says the gate has not run at HEAD with these proofs. When the summary it builds does not pass, such as after a check fails, outside the checkout where a review carried across commits cannot be checked, when an accepted gap now rests on a condition the saved judge did not weigh, when CI shows other checks than the ones the judge weighed, or when the head, base or tier moves while the report reads it, it sends the user to the gate and offers no merge. This holds for a merged pull request too, which it sends to `hedge proof gate --landed`. A pull request whose proofs Hedge cannot read is still the user's, with the reason, and the other rows still print.
_Avoid_: Summary, wrap-up

**End table**:
One row per pull request: its review rounds and final reads, its production lines at the first reviewed commit and at HEAD with the growth between them, its latest sanity pass, and each skipped proof with its reason and who accepted it. The proof receipt in the pull request and the end-of-run report print the same table. The gate measures the lines at HEAD, so the table holds a pull request only once a gate ran at its HEAD.
_Avoid_: Summary table, scorecard

**Production lines**:
The lines a pull request adds and deletes against the commit where it branched from its base, without tests, docs, lock files and generated files. Tests and docs are counted apart.
_Avoid_: Diff size, LOC

**Stop rule**:
A review round runs after another review only when the latest finished review, a round or a final read, found a bug in production code that the pull request introduced. Such a finding states its severity as blocker or major, and its location field names a production file or no file. It is not a TESTS item, none of its fields starts with `[base]`, and it is not answered rejected or known. Without one, `hedge proof review` refuses the round and prints the question that asks the user, and only the user's `--override` runs it. The first panel of a pull request still runs, since the gate needs it. Fixes since the last round get a final read.
_Avoid_: Round limit, cutoff

**Sanity pass**:
A check that a pull request needs when its production lines at HEAD are more than twice the lines at its first reviewed commit. Before the next round, the agent cuts the pull request back to base behaviour or justifies the growth, and records the verdict with `hedge proof sanity --verdict cut|justified --reason '<why>'`. The latest pass covers the production lines it saw, so a head that grows again needs a new pass. A round the user's `--override` runs waits for the pass too. The reason must not hold figures. A first review that saw no production lines needs none. Before it asks for the pass, the bloat judge scores the growth.
_Avoid_: Bloat check

**Bloat judge**:
A fresh model with no part in the review loop. When a pull request needs a sanity pass, it reads the Problem section, the diff at the first review round and the diff at HEAD, and returns the cuttable share: the share of HEAD's production lines that the problem does not need, with the hunks it would cut. The sanity pass cuts those hunks or justifies each. The end table shows the growth ratio and the cuttable share in the Sanity pass cell.
_Avoid_: Bloat score, bloat reviewer

## Secrets

**Secret store**:
The store on the hub that holds standing credentials and delivers secrets the hub already holds, each with its kind, scope, target project, expiry and check. `hedge secret` reaches it from any machine.
_Avoid_: Vault, keychain, secrets folder

**Standing credential**:
A secret kept in the secret store and reused by every lane until it expires or is revoked.
_Avoid_: Shared key, permanent token

**Secret row**:
The declaration of one secret, without its value: its provider, scope, project, region, settings link and variables. Packs and the profile declare rows.
_Avoid_: Secret config, registry entry

**Secret provider**:
The code that owns a secret's shape rule and its read-only live check.
_Avoid_: Validator, plugin

**Live handoff**:
A secret or confirmation that only works at the moment of use, such as an OAuth callback, a tool's literal `confirm`, or a token that lasts under a day. It is asked for at use time and never stored.
_Avoid_: Late ask, just-in-time secret
