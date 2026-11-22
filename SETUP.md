# Set up Hedge with the person

You are an agent in T3 Code. The person pasted the prompt from the Hedge
README or the Hedge page. Set up Hedge with them, from nothing to a passing
`hedge doctor` on a **hub** and one or more **nodes**: Linux boxes in the
cloud, such as Coder workspaces. Agents run only there.

The machine you run on, usually their Mac, keeps only the T3 Code app and the
Coder CLI. Install nothing from Hedge here: run every `hedge` command, and the
Hedge install, on the hub over SSH.

## How you work

- **Guide.** Before each step, say in one or two plain sentences what it does
  and why. Size it to what they know (step 2).
- **Ask with your question tool.** Every choice goes through it. Each option
  says what the person gets and what they give up, and one option is marked
  as recommended. Put independent questions in one call. When your question
  tool takes fewer questions in one call, ask the rest in a second call right
  after the first.
- **Secrets go through the secret prompt.** Ask for every secret, such as an
  API key, a token, or a code to paste, with the host's secret prompt (in T3
  Code, its `request_secret` tool), delivered as a file. Never ask in chat,
  and never send a paste to a Terminal window. Say in one line what the
  secret is for and where to make it. Then give the file to the command as
  the step shows, on its standard input or in a variable, also over SSH.
  Only when the host has no secret prompt, run the command in a Terminal
  window (see "Terminal only for a terminal screen"), where it asks for the
  secret itself. A secret that a Coder template parameter asks for is not
  yours to ask for, type, or pass: step 5 says what to do with it.
- **Say a word before you use it.** The first time you say a Hedge word to the
  person, such as workflow, pack, profile, hub, or node, explain it in one
  plain line.
- **Keep it short.** One or two sentences per explanation.
- **Run every command yourself.** The person answers, approves, and does their
  own sign-ins in their browser. A sign-in on the hub prints a link and often
  a one-time code: give both to the person, and say what the sign-in is for.
- **Show, then tell.** Where a step names a visual, show it as a page in the
  chat when you can (T3 Code shows HTML pages that agents publish). Otherwise
  describe it in three lines of text.
- **One PATH.** Your shell may have started before the Coder CLI was
  installed, and a command over SSH does not read the box's login files.
  Begin every command that runs `hedge`, `gh`, `bun`, `claude`, `codex`, `t3`,
  or `coder`, here or over SSH, with
  `export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";`.
- **When a step fails.** Explain its last lines and fix what they name. When
  it still fails, or the cause is not clear, offer `hedge triage` on the hub.
  It exists after the install makes `~/.local/bin/hedge` there. Run
  `hedge triage --print --note "<the failed step and its last line>"` over SSH
  and show the person the report. It opens a **public** issue for the Hedge
  maintainer, with private details taken out, so ask before you run the same
  command with `--send`. When `gh` is not signed in, `--send` saves the
  report to a file, says where, and exits 1. That exit is not a new failure.
- **Terminal only for a terminal screen.** A command that draws its own
  screen in a terminal and reads the person's keys there, such as
  `claude auth login` on the hub, runs in a Terminal window: write it to a
  file in `~/.cache/hedge-setup` that ends in `.command`, with a `#!/bin/sh`
  line and the `PATH` line above, make it executable, and `open` it. Ask them
  to tell you when it ends. Each step that needs this says so. When you do
  not run on a Mac, give the person the command to run in their own
  terminal instead.

## Picks from the page

The prompt can end with a list that starts with `My picks from the Hedge
page:`. The person chose these on the Hedge page, so do not ask for them
again. When a step uses a line, say the pick back in one sentence and go on.
Ask everything else as the steps say. Without the list, ask every question.

| Line | How to use it |
| --- | --- |
| `Packs on the first setup` | The packs for step 6, picked one by one. `none` means no pack. Still ask the AI plan, and read each pack's setup note. |
| `Packs once the hub runs` | The answer to item 2 of step 9. `none` means no pack, so skip item 2. |

The page names packs only. Each pack's setup note still asks which of its
workflows to turn on and which settings it needs. On a rerun of setup (step
1), the packs in their profile win over the page's picks: see step 1.

A prompt from an earlier page can carry more lines. Use them too:

- `Where Hedge runs`: ignore it. Hedge now always runs on a hub and nodes.
- `Workflows on the first setup` and `Workflows once the hub runs`: add the
  list to the command of that step as `--workflows`, without the spaces. Such
  a line wins over a workflow flag from a setup note.
- `Setting`: add `--set <key>=<value>` to the setup command in step 7, once
  for each line.

## While something runs

Steps 5, 7, and 9 start commands that take minutes. At the first wait, in
step 5, offer the three-minute lesson "What Hedge is". In T3 Code, download
it on the Mac and show it in the chat, so it plays there:

```sh
mkdir -p ~/.cache/hedge-setup && curl -fsSL -o ~/.cache/hedge-setup/what-hedge-is.mp4 https://posthog.github.io/hedge/assets/lessons/what-hedge-is.mp4
```

Then show it with its full path, such as
`![What Hedge is](/Users/<login>/.cache/hedge-setup/what-hedge-is.mp4)`,
and under it the lesson page
`https://posthog.github.io/hedge/learn/what-hedge-is/`, which plays it in a
browser when the chat cannot. In a terminal, or when the download fails,
give the page link only.

At each later wait, explain one of these, in two or three lines, and do not
repeat one. Skip a topic that does not fit their picks:

- **T3 Code's inbox.** A thread that finishes or waits for them shows up in
  the inbox. They answer it there, on the Mac or the phone.
- **The Slack trigger.** With the Slack pack, their own Slack message with
  `:t3code:` starts a thread about it.
- **Threads on nodes.** T3 Code starts each new thread on a node. The thread
  keeps working while the Mac sleeps or is closed.
- **What runs each night.** The hub and each node run `hedge update` every
  night, so they take the newest engine and their profile by themselves. The
  last screen of setup lists the other jobs under "Runs by itself".

Say whether the step runs once or again later. The install and each sign-in
run once per box. `hedge update` runs again every night by itself.

## 1. Check this machine and Coder

Run `uname -s` and `id -u`. Go on when the user ID is not `0`. Hedge needs
nothing else here but the Coder CLI.

**Coder CLI.** When `command -v coder` finds nothing, download
`https://coder.com/install.sh` to `~/.cache/hedge-setup/coder-install.sh`,
read it, and run it. It needs no Homebrew and no password:

```sh
sh ~/.cache/hedge-setup/coder-install.sh --method standalone --prefix "$HOME/.local"
```

When `coder whoami` fails, sign in. Read their Coder address from the `url`
file in Coder's settings folder: `~/Library/Application Support/coderv2` on a
Mac, `~/.config/coderv2` on Linux. Ask for the address only when that file is
missing. Coder needs a session token: it lets this machine act as them in
Coder, and they make one at `<coder address>/cli-auth`. Ask for it with the
secret prompt, delivered as a file, and sign in with it:

```sh
CODER_SESSION_TOKEN="$(cat <file>)" coder login <coder address>
```

Without a secret prompt, run `coder login <coder address>` in a Terminal
window, where it asks for the token itself. Coder is done when `coder whoami`
passes. When they have no Coder deployment, stop: this setup needs Coder
today. Plain Linux boxes over SSH are not supported yet. "Set it up by hand"
in the README installs Hedge on one Linux box.

**An earlier setup.** Run `coder list`, and ask whether one of the running
workspaces is the hub of an earlier Hedge or Fleet setup. Their boxes can
have any name, so offer each running workspace whose name starts with
`hedge-` or `fleet-` as an option, and "None" too; they can name another one
in their own answer. Check only the workspace they name. Never check every
workspace: an account can have dozens, and each check takes an SSH session:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub status'
```

Run `coder config-ssh --yes` first when `ssh coder.<name>` finds no host.
When a hub answers, show its packs with `hedge packs` there, and ask:

- **Change only what they name** (recommended): run `hedge packs` on the hub
  with `--add`, `--remove`, and `--workflows` for each change, and follow the
  setup note of each pack they add. Then check the hub as in step 8, and end
  there. Skip step 9: its command sets first-install defaults, such as
  `mcp-gateway=off`, that would change what they did not name. Everything
  else stays as it is.
- **Run setup again**: setup reuses their profile repo and starts from its
  packs, workflows, and settings. In the step 7 command, leave out
  `--preset`, and name only what changes with `--add`, `--remove`, and
  `--workflows`. Everything else stays as it is. Files they changed by hand
  are kept, and step 8 shows them. Skip step 5 for the hub.

  The profile's packs win over the picks from the page. Add each picked
  pack that the profile does not have with `--add`. When the profile has a
  pack that the picks leave out, name it and ask whether to keep it, the
  recommended option, or to remove it with `--remove`.

An earlier Hedge or Fleet that runs on this Mac stays as it is until the hub
works. Then offer to stop it. On a Mac, `get.sh` installs nothing: it only
stops and turns off the launchd jobs of an earlier Fleet or Hedge, and keeps
their files. Download it to `~/.cache/hedge-setup/get.sh`, read it, and run
`sh ~/.cache/hedge-setup/get.sh` here. Tell them they can delete
`~/.local/share/hedge` or `~/.local/share/fleet` by hand afterwards.

## 2. Ask everything in one call

Ask these questions now, in one call of your question tool. Then the
creation and the setup do not wait for the person. Setup notes can add
questions later (step 6). Leave out each question that the picks from the
page already answer. On a rerun of setup (step 1), leave out the Packs
question: setup starts from the packs in their profile.

1. **New to you.** A multi-select question: "Which of these are new to you?"
   with T3 Code (the app you are talking in), Hedge (what it sets up),
   Cloud boxes (Linux machines in the cloud, such as Coder workspaces, where
   agents keep working while the Mac sleeps), and "None, I know all three".
2. **Nodes**, with the options of step 4.
3. **Packs**, with the options of step 6.
4. **AI plan**, with the options of step 6.

Also find their GitHub login: run `gh api user --jq .login` when `gh` works
here, and otherwise add it as a fifth question. Step 5 needs it.

Each pick in question 1 adds an explainer to a later step:

| New to | Add |
| --- | --- |
| T3 Code | In step 3: a **thread** is one agent conversation with its own task. A **worktree** is a separate checkout of the same repo, so several threads change code at once without touching each other. T3 Code shows every box's threads on the Mac and the phone. |
| Hedge | In step 3: the picture, and one pack from step 6 with one of its workflows as an example. |
| Cloud boxes | In step 4: what a hub and a node are, and why agents run there. |

When the packs are "One by one", ask the multi-select of step 6 right after.

## 3. Show what Hedge is

Fetch the picture from
`https://raw.githubusercontent.com/PostHog/hedge/main/docs/hedge.svg`
and show it. Then say: Hedge runs your agents in the cloud, not on your Mac.
It installs agent rules, skills, and workflows on your hub and your nodes. A
**workflow** is one way of working that agents follow, such as a draft pull
request for every fix. A **pack** is a set of workflows that you turn on as
a whole. Your answers go to your **profile**, a private GitHub repo named
`<login>-hedge`, so every box you add gets the same setup. Setup proposes the
name, and you can type another. A team pack can keep its members' profiles in
the team's GitHub org instead, as `<login>-hedge`, so teammates can
read each other's setup. A profile from before keeps its name, such as
`hedge-profile` or `hedge-profile-<login>`.

## 4. The hub and the nodes

Hedge sets up one **hub** with a 200 GB disk and one **node** with a 500 GB
disk, both Linux boxes in the cloud that stay on while the Mac sleeps. The
hub links the boxes, watches their disks, and keeps the pack secrets, such
as the Slack, incident.io, and MCP gateway sign-ins. The nodes
are where threads do the work. Step 2 asks how many nodes, with these
options:

- **One node** (recommended): enough for a few threads at once. Add more
  later, when the load grows.
- **Two nodes**: twice as many threads at once. The hub, two nodes, and the
  Mac use 4 machines of T3 Connect, so this needs a paid T3 Chat plan.

They can name more nodes in their own answer. Below, "the nodes" means as
many as they chose.

**T3 Connect's limit.** A free T3 Connect account links up to 3 machines.
The hub, each node, and the Mac each use one, and so does every other
machine already on their account, such as an old hub that they keep until
its replacement works. Before step 5 creates anything, count the machines on
their account, from the T3 Connect page in T3 Code's account menu, plus the
new ones. When the count is over 3, say so and let them choose: fewer nodes,
removing a machine they no longer use from that page, or a paid T3 Chat
plan, which they link in T3 Code's account menu under **T3 Chat** → **Link
T3 Chat** (up to 10 machines with Pro).

## 5. Create the hub and the nodes

Create every workspace now, at once, and go on to step 6 while they start.
Show each command as you start it. Put only values that are not secret on a
command line: every program on the Mac can read the arguments of a running
command. A private value that is not a secret, such as an email address,
shows as `<private>` in a command you show, and you never print it back.
You never ask for, type, or pass a secret, such as a token or a key. Item 4
says what to do with a template parameter that holds one.

1. **Names.** Use `hedge-hub` and `hedge-node-1`, `hedge-node-2`, and so on.
   When `coder list` already has a workspace by that name that they do not
   reuse, add the next free number instead, such as `hedge-hub-2`, so the
   new box and the one it replaces never share a name. Ask for a name only
   when they want another. Below, `<hub>` and `<node>` stand for them, and
   `<name>` for any of them.
2. **Template.** List them with `coder templates list`. When there is one,
   use it; ask only when there are more. Read its parameters with the
   engine's script. It asks the Coder API for the parameters of the
   template's active version, with the session token on `curl`'s standard
   input, so the token never shows. `coder templates pull` needs an
   organization name that a member often cannot pass, so do not use it.
   Download the script once, and read it:

   ```sh
   mkdir -p ~/.cache/hedge-setup && curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/scripts/template-parameters.sh -o ~/.cache/hedge-setup/template-parameters.sh && cat ~/.cache/hedge-setup/template-parameters.sh
   ```

   Then run it:

   ```sh
   sh ~/.cache/hedge-setup/template-parameters.sh <template>
   ```

   It prints one line per parameter: its name, its type, and whether it
   is `mutable`, `ephemeral`, or a `secret`. It prints a default value only
   for a number, a `bool`, or a parameter with a fixed list of allowed
   values, and then prints that list too. For any other parameter it
   prints only `default hidden` or `no default`, because free text can be
   a credential, also when nothing names it one. It marks a parameter as a
   secret when its name or description names a token, a key, a password,
   or another credential.

   When the script fails, open the template's page in the Coder web app,
   `<coder address>/templates/<template>`, and ask the person to read you
   the parameter names and their allowed values from it, never a value of
   a secret.

   Find the disk size, the region, the dotfiles, the dotfiles branch, the
   secret parameters, and the ephemeral parameters.
   A secret is a parameter that holds a token, a key, a password, or another
   credential: the script marks it `secret`. Never ask about a secret.
   Sort each other parameter by the first row of this table that fits it:

   | Parameter | What you do |
   | --- | --- |
   | The disk size | Pass the size that item 4 gives. |
   | The dotfiles | Pass the profile repo of item 3, as `git@github.com:<profile repo>.git`. |
   | The dotfiles branch, such as `dotfiles_branch` | Pass its default, mostly empty, which is the profile's default branch. Setup saves the answers to the branch the box checks out, so a box on another branch never changes the default branch. |
   | The region | Ask. |
   | Another parameter without a default | Ask. |
   | Another parameter with a `default hidden` | Ask for the value to pass. The person reads the default on the template's page in the Coder web app. When it holds a credential, it is a secret. |
   | Another parameter with a default | Pass its default. |

   Ask every question of the table in one call.
3. **Profile repo.** The dotfiles parameter is their profile repo, so each
   start of a workspace applies their profile. Find it before you create:
   when `gh` works here, run
   `gh repo view <repo> --json nameWithOwner --jq .nameWithOwner` for
   `<login>/<login>-hedge`, then for the older names `<login>/hedge-profile`
   and `<login>/fleet-profile`, and use the first that answers. A profile
   with a name the person typed has the GitHub topic `hedge-for-<login>`:
   `gh repo list <login> --limit 10000 --json nameWithOwner,repositoryTopics`
   shows it.
   Otherwise use `<login>/<login>-hedge`, with the login in lower case:
   `hedge setup` makes it in step 7. Until then,
   the workspace's dotfiles script finds no repo and says so in its start
   log. That is expected. A team pack can keep the profile in its GitHub org
   instead; step 7 checks the repo again. Below, `<profile repo>` is the
   `owner/name` you found.

   Coder clones the dotfiles with the workspace's Git SSH key. The profile
   is private, so give its SSH address, `git@github.com:<profile repo>.git`.
   Its `https://github.com/` address fails with `Write access to repository
   not granted`, because the box has no GitHub sign-in yet.

   A node's dotfiles install fails until `hedge devbox add` in step 9 has
   signed it in to GitHub and turned on lingering. Until then, each
   `ssh coder.<node>` prints `A startup script exited with an error` and the
   start log. That is expected: say so once, and go on.
4. **Create.** Give the hub a 200 GB disk and each node a 500 GB disk.
   When the template has an ephemeral parameter, stop and tell the person:
   this guide does not set up such a workspace, because Coder drops or
   repeats ephemeral values on each restart. When the template has a
   secret parameter, with a default or without, never run `coder create`
   for it: the Coder CLI asks for each parameter that a command leaves
   out, also with `--yes`, and prints the default, so a secret would show
   in your output. Ask the person to create each workspace in the Coder
   web UI instead: they open the template's create form; if the form shows
   a preset picker, they pick **None**, so that no preset locks a field.
   They give the workspace the name from item 1, and fill in the values
   you give them. They leave a secret that has a default as it is, and
   type a secret without a default themselves. Tell them first that Coder
   keeps each value of the form with the workspace's build, so anyone who
   can see the workspace can read the secret they type. Coder does this
   for every workspace made from that template, so they decide whether to
   type it. When they tell you the workspace name, go on with item 5.

   When the template has no secret parameter, run `coder create`. Pass each
   parameter with its own `--parameter`, also those where the default is
   right, so Coder asks nothing and you see each value it uses.
   `--preset none` stops the preset question that `--yes` does not skip:

   ```sh
   coder create <name> --template <template> --preset none --parameter <disk parameter>=<200 or 500> --parameter <region parameter>=<region> --parameter <dotfiles parameter>=git@github.com:<profile repo>.git --parameter <other parameter>=<value> --yes
   ```

   Never use `--copy-parameters-from`: Coder then takes the copied
   workspace's values over every `--parameter` you pass.

   Start the hub and the nodes at once, each in the background. They take
   minutes; use the wait (see "While something runs").
5. **Keep them running.** Agents work there while the Mac sleeps:
   `coder schedule stop <name> manual`.
6. **Check them.** When a create ends, check that the workspace runs, that
   no stop time ends it, and that the parameters this guide sets have the
   values you passed: the disk size, the region, the instance type, and the
   dotfiles repo. Never pass a private value to the check. The check never
   takes or prints a private value: it reads the build's parameter list from
   Coder, compares only the parameters you pass, and prints only parameter
   names, never a value or the Coder session token. Download the check once,
   and read it:

   ```sh
   mkdir -p ~/.cache/hedge-setup && curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/scripts/check-workspace.sh -o ~/.cache/hedge-setup/check-workspace.sh && cat ~/.cache/hedge-setup/check-workspace.sh
   ```

   Then run it for each workspace, with those parameters of its create:

   ```sh
   sh ~/.cache/hedge-setup/check-workspace.sh <name> <parameter>=<value> <parameter>=<value>
   ```

   The step is done when every line starts with `ok`. Do what each `x` line
   says, and run the check again. To change a parameter that the template
   lets change, ask the person to open the workspace in the Coder web app,
   go to **Settings → Parameters**, set the value you give them, and
   submit. Coder then builds the workspace again with that value. Never
   change a parameter with the Coder CLI: its update command changes
   nothing while the workspace uses the template's active version, and its
   restart command can ask for a parameter and print its default, also a
   secret's. A parameter that the template does not let change, such
   as the disk size or the region, needs a new workspace: ask, then
   `coder delete <name>` and create it again, before setup touches it.
7. **SSH.** Run `coder config-ssh --yes`. The step is done when
   `ssh coder.<name> true` passes for each workspace.

## 6. What they want

Step 2 asks these. Skip the packs question when the picks from the page name
the packs:

- **Packs.** One option per preset in
  `https://raw.githubusercontent.com/PostHog/hedge/main/presets.json`, with
  its `blurb`, and "One by one". For one by one, ask a multi-select question
  with the packs below whose row says "Always". A pack whose row says
  "Step 9" needs a hub that runs, so step 9 offers it. Base is always on.
  [The Hedge page](https://posthog.github.io/hedge/) shows what each pack
  does.
- **AI plan.** Claude, ChatGPT, or both: it decides the sign-ins and the
  model defaults. Recommend the agent they set up in T3 Code.

For each pack they pick whose row names a setup note, read that note from
the engine repo, such as
`https://raw.githubusercontent.com/PostHog/hedge/main/packs/slack/SETUP.md`
for the Slack pack, and follow it in step 7. Read only the notes of the
packs they picked. Ask the questions of all the notes together, in one call,
before step 7. A `hedge` command in a note runs on the hub over SSH, with the
`PATH` line, as in step 7. Run the steps that a note puts after the setup
command only once step 7 has named the hub.

| Pack | What it does | Offer it | Setup note |
| --- | --- | --- | --- |
| `pull-requests` | Every change passes proof, a second-model review and a QA swarm before it merges, and a nightly loop you turn on improves one area. | Always | None |
| `orchestration` | Type /build and say what you want: small work goes straight to a pull request, big work becomes a map that a conductor thread works through, and side work gets its own thread. | Always | `packs/orchestration/SETUP.md` |
| `communication` | Agents write in your voice, give short updates, and share plans and previews as links. | Always | None |
| `integrations` | Claude Code and Codex get the official GitHub, Context7, and Convex plugins, and Claude can hand work to Codex. | Always | None |
| `memory` | One private repo holds what your agents learn and what you save, and every box reads it. | Always | `packs/memory/SETUP.md` |
| `guards` | Hooks stop an agent's shell commands from running network code, using GitHub outside your owners, pushing past review, or polling in loops. | Always | `packs/guards/SETUP.md` |
| `slack` | Your own message, reaction, or mention in Slack starts a T3 thread about it. | Always | `packs/slack/SETUP.md` |
| `incident-io` | An agent that watches a risky change pages you, and only you, through incident.io when it goes wrong. | Always | `packs/incident-io/SETUP.md` |
| `hub` | The hub links your boxes, cleans their disks, and keeps your pack secrets. Turn on recovery, and threads go on after a usage limit. | Step 9 | `packs/hub/SETUP.md` |
| `mcp-gateway` | The hub signs in to your MCP servers once, and agents on every machine reach them through it. | Step 9 | `packs/mcp-gateway/SETUP.md` |
| `security` | Agents on every machine read your Wiz findings, threats and inventory through the hub, and cannot change them. | Step 9 | `packs/security/SETUP.md` |

## 7. Set up Hedge on the hub

Every command in this step runs on the hub over SSH. Wait until
`ssh coder.<hub> true` passes.

1. **Sign the hub in to Coder.** The hub reaches the nodes over SSH through
   Coder, so it needs its own Coder session. A Coder workspace often has one
   already. Check first:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; coder whoami && coder config-ssh --yes'
   ```

   When it passes, the hub is signed in: go on with item 2. Otherwise make a
   token here and send it on standard input, so it never shows in the chat:

   ```sh
   coder tokens create | ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; { command -v coder >/dev/null || { case $(uname -m) in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) exit 1;; esac; mkdir -p "$HOME/.local/bin" && curl -fsSL "<coder address>/bin/coder-linux-$a" -o "$HOME/.local/bin/coder" && chmod +x "$HOME/.local/bin/coder"; }; } && token=$(tr -d "[:space:]") && { [ -n "$token" ] || { echo "No Coder token came in." >&2; exit 1; }; } && CODER_SESSION_TOKEN="$token" coder login --use-token-as-session <coder address> && coder config-ssh --yes'
   ```

   When `coder tokens create` prints `rbac: forbidden`, the Coder deployment
   forbids its members to make tokens, and the hub prints
   `No Coder token came in.` Then ask the person for a session token from
   `<coder address>/cli-auth` with the secret prompt, delivered as a file,
   and run the same `ssh coder.<hub> '…'` part with `< <file>` instead of the
   pipe. The hub reads the whole file, also when it does not end with a
   new line.

2. **Install.** Download the install script on the hub and read it. Keep it
   in view, because a pipe into `sh` hides what runs:

   ```sh
   ssh coder.<hub> 'mkdir -p ~/.cache/hedge-setup && curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh -o ~/.cache/hedge-setup/get.sh && cat ~/.cache/hedge-setup/get.sh'
   ```

   Tell the person in two lines what it adds on the hub when missing: the
   GitHub CLI, Bun, and the `t3` command, the engine in
   `~/.local/share/hedge/engine`, `hedge` in `~/.local/bin`, and one `PATH`
   line in its login file. When the script does more than this, tell them
   what, and ask before you start it. Then start it in the background:

   ```sh
   ssh coder.<hub> 'sh ~/.cache/hedge-setup/get.sh --install-only'
   ```

   It is done when `~/.local/bin/hedge help` on the hub prints the list of
   commands. When it stops with an error, explain its last lines, fix what
   they name, and run it again: it continues from where it stopped.
3. **Setup.** Build the command from the answers, so setup asks nothing
   twice:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge setup --chat --preset <id> --plan <claude|codex|both>'
   ```

   For one by one, use `--preset starter`, add `--remove pull-requests` when
   they did not pick it, and add `--add <pack>` once per other pack they
   picked.

   Start it in the background and read its output as it comes. It waits for
   each sign-in that ends in the browser. While it runs:

   - **A sign-in starts** (`▶ Sign in to …`). Say what it is for, from the
     table below, and give the person the link and any one-time code the
     output shows. They open the link on the Mac or the phone. Setup goes on
     by itself once they finish in the browser.
   - **`✓ Ready to use.`** The hub is set up. The steps it names go on in the
     background; say what each one does.

   When it ends with code `2`, it lists what it still needs:

   - **A line `--set <pack.key>=<value>   <question>`.** Ask the question with
     your question tool, then add `--set <pack.key>=<answer>` to the command.
   - **A line `Needs you: <sign-in>`, then `In a terminal, run: <command>`.**
     Say what it is for. When the pack's setup note says how to give the
     command its secrets, such as `hedge slack-trigger setup` in the Slack
     note, follow the note: ask with the secret prompt and give the files to
     the command over SSH. Only a command that draws its own terminal screen
     runs in a Terminal window (see "Terminal only for a terminal screen").
     Claude's sign-in is one: it prints a link, and the person pastes the
     code from the browser back into the terminal. Run it as:

     ```sh
     ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; claude auth login'
     ```

   With code `2`, or with code `1` at setup's last step, `Check everything`,
   a line `To do: This machine cannot reach the MCP gateway` or
   `Fix: This machine cannot reach the MCP gateway` means that the profile
   turns on the MCP gateway, and the gateway needs a named hub. Run
   `hedge hub status` on the hub. When it prints `The hub: not named.`,
   run the `hedge hub here` of item 4 now.

   Then run the same setup command again. Every step skips what is done. On
   any other stop, read the last lines, explain them, and fix what they
   name. Use each wait (see "While something runs").

   Setup prints the profile repo it uses, in a line
   `✓ Created the private repo <repo>` or `✓ Reusing your repo <repo>`. When
   that is not `<profile repo>` from step 5, such as a profile in a team's
   GitHub org, change the dotfiles parameter of each workspace to
   `git@github.com:<repo>.git` in the Coder web app, as step 5 says. The new
   build stops the hub for a moment, so wait for it before the next SSH
   command. Then run the check of step 5 again, and wait until
   `ssh coder.<name> true` passes. When the template does not let the
   parameter change, the box still works: its nightly `hedge update` keeps
   it on their profile.

   | Sign-in | What it is for |
   | --- | --- |
   | GitHub | Once, with every permission Hedge needs: it creates their private profile repo, adds the hub's SSH key, and reads their org's packs. A code to type at a GitHub page. |
   | Claude | Claude Code on the hub uses their Claude plan. In a Terminal window, as above. |
   | ChatGPT | Codex on the hub uses their ChatGPT plan. A code to type at a ChatGPT page. Setup checks it with a real request. When the request fails for another reason, such as a spend cap, setup prints the reason and keeps the sign-in. When device code sign-in is off, setup says how to turn it on, or how to sign in in the browser of this machine over an SSH port forward instead. With own-account balancing on, setup does not need it, because Codex goes through the hub's proxy: setup leaves a `To do:` line instead. This sign-in is only for Codex on the box. The MCP gateway's ChatGPT sign-ins only let agents reach apps such as Slack, and the proxy keeps its own subscriptions. |

4. **Name the hub.** Run this right after setup ends, before any step that a
   pack's setup note puts after the setup command. The Slack and incident.io
   notes run commands that work only on the hub:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub here'
   ```

   It saves `coder.<hub>` as the hub in their profile. Then do the steps that
   each note puts after the setup command.

5. **T3 Connect on the hub.** It lets T3 Code on the Mac and the phone reach
   the hub. Start it in the background, and give the person the link it
   prints to sign in to T3 Connect:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; t3 up --connect --yes --headless'
   ```

### Another Hedge keeps the files

When setup stops with a `To do:` line that starts with `Another Hedge setup
keeps`, the files it names belong to another Hedge on the hub, such as an
earlier Fleet. Say how many files that is, and that they are the same kind
of rules and guides Hedge installs. Ask:

- **Take them over** (recommended): run the `hedge apply --adopt-from <name>`
  that the line names on the hub, then the setup command again. Hedge copies
  the other Hedge's state and every file or linked folder it replaces to
  `~/.local/state/hedge/backups/`. A linked folder moves whole, with
  everything in it, so say which ones move. The other Hedge's files that
  this profile does not write stay where they are, except those inside a
  linked folder that moves, and the old Codex rules file
  `~/.codex/rules/fleet.rules`. Hedge removes that file while it is unchanged,
  because the base pack's rules replace it, and keeps it when it changed.
- **Stop here**: nothing changes, and setup cannot finish while the other
  Hedge keeps the files.

## 8. Check the hub

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge doctor'
```

Run it with the hub's name. The step is done when every line is explained to
the person:

- `Fix:` Hedge can repair it. Run `hedge apply` there, then `hedge doctor`
  again.
- `To do:` the person does it. Say exactly what and where. When it names a
  command that takes a token or a code, ask for it with the secret prompt
  and give the file to the command over SSH, as its pack's setup note shows.
- `Note:` information only.
- `Everything matches your profile.` The box is set up.
- `Everything Hedge sets matches your profile. The To do lines above wait for
  you.` The box is set up. Each `To do:` line above it waits for the person,
  such as adding a subscription to the hub's own-account proxy, and does not
  stop setup. Tell the person what each one asks, and go on.

### When Hedge kept something of theirs

A line that starts with `Kept your` names a file or a setting that was on the
box before Hedge, which Hedge left as it was. Never show the raw key alone.
Say in plain words what it controls, what Hedge's value does instead, and
whether `hedge doctor` passes while it stays. Then ask:

- **Take Hedge's version**: run the `hedge apply --adopt <path>` that the
  line names. A line that says `Removed item changed locally` names a file
  that Hedge no longer installs, so there is nothing to take: keep it, or
  move it away by hand. Hedge keeps the new file up to date, and their old
  file stays in `~/.local/state/hedge/backups/`. When the old file holds their own
  skills or rules, agents stop reading them. Say which ones they lose, and
  offer to move the ones they still want to the "About me" file in their
  profile, which agents read after the packs' rules.
- **Keep theirs**: nothing changes, and the line stays in `hedge doctor`. This
  makes sense when they set the value on purpose, such as a model proxy their
  company needs.

Recommend taking Hedge's version, unless they set the value on purpose.

### Go back to Fleet

On its first run, `get.sh` turns Fleet's jobs off and keeps their files and
launchers. It does this only on a machine with a Fleet engine install in
`~/.local/share/fleet/engine`. When Fleet's `~/.local/bin/fleet` runs an
engine in another folder, `get.sh` stops before it changes anything, so there
is nothing to go back from. To go back on a machine that `get.sh` moved:

1. Stop Hedge's jobs. On Linux, run
   `systemctl --user disable --now` for each unit that
   `systemctl --user list-units --all 'hedge-*'` names, and delete the
   `# hedge:` lines with `crontab -e`. On a Mac, run
   `launchctl bootout gui/$(id -u)/<label>` for each `dev.hedge.*` agent.
   In T3 Code, turn off each `hedge:` scheduled task. For the MCP hub, run
   `docker update --restart=no hedge-mcphub` and `docker stop hedge-mcphub`,
   because both hubs use port 3317.
2. When `~/.local/share/fleet/engine/fleet doctor` prints `Fleet is now Hedge`, check out the
   commit before the rename:
   `git -C ~/.local/share/fleet/engine checkout -q --detach <commit>`.
3. Run `~/.local/share/fleet/engine/fleet packs --workflows nightly-updates=off`. This turns
   off Fleet's nightly updates, so its updater does not check out Hedge
   again. It also turns off the nightly Claude Code, Codex and T3 Code
   updates. It saves the change in the profile, pushes it, and applies, so
   it writes the `# fleet:` crontab lines again. Other machines on this
   profile take the change at their next apply.
4. Turn the stopped units back on. `get.sh` named each one as
   `stopped and turned off the ...`. On Linux, run
   `systemctl --user enable --now <unit>`. On a Mac, run
   `launchctl enable gui/$(id -u)/<label>`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.
   Skip `dev.fleet.fleet-update` and `dev.fleet.agent-update`: step 3 turned
   them off. For the MCP hub, run
   `docker update --restart=unless-stopped fleet-mcphub` and
   `docker start fleet-mcphub`.
5. In T3 Code, turn each `fleet:` scheduled task back on.

## 9. Add the hub packs and the nodes

Run each item on the hub over SSH. `hedge devbox add` takes minutes; use each
wait (see "While something runs").

When cloud boxes were new to them, explain the hub first: it is the one box that
looks after the others. It keeps an SSH tunnel and a T3 link to every node,
and cleans a node's disk before it fills. The node is where threads do the
work. Each node keeps working when the hub is down.

When step 7 printed that a team pack is ticked, such as `✓ You are in the
<org> org, so the <pack> pack is ticked`, read that pack's setup note on the
hub first, when it has one:

```sh
ssh coder.<hub> 'cat ~/.local/share/hedge/sources/<source>/packs/<pack>/SETUP.md'
```

`<source>` is the folder in `~/.local/share/hedge/sources` on the hub that
holds the pack. Its note can name another template, parameters, or a box the
pack makes itself. Where it differs from the items below, follow the note.
When it names another template than step 5 used, replace the nodes: see
"Clean up what you replace".

Item 2 runs only on a first setup, because its command sets first-install
defaults. On a rerun of setup (step 1), skip item 2, and run items 1, 3, and
4 for each node that step 5 created. A change to an earlier setup that
creates no node ends at step 8 (see step 1).

1. **The hub.** Item 4 of step 7 named it. Check that this prints
   `The hub: coder.<hub>`:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge hub status'
   ```

2. **Hub packs.** Ask with a multi-select question which of these to turn
   on, unless the picks from the page name the packs for once the hub runs.
   Recommend the `hubPacks` of the preset they chose in step 6, from
   `presets.json`, or Hub alone for one by one. Read the setup note of each
   one they pick, now:

   - **Hub**: the hub links the boxes, watches their disks, and with
     provider recovery continues threads after a usage limit.
     `packs/hub/SETUP.md`
   - **MCP gateway**: the hub signs in to their MCP servers once.
     `packs/mcp-gateway/SETUP.md`
   - **Security**: agents read their Wiz findings through the MCP gateway,
     read-only. `packs/security/SETUP.md`

   Start from this command, add `--add <pack>` for each other pack they
   picked, and change or add the flags their notes name. With picks from the
   page, leave out `--add hub` when the line does not name `hub`:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge packs --add hub --workflows mcp-gateway=off'
   ```

3. **Each node.** Run `hedge devbox add` on the hub, for each node, one after
   the other. It installs Hedge on the node, signs it in to Coder, GitHub,
   Claude, and ChatGPT, applies their profile, turns on T3 Connect there, and
   links T3 Code on the hub and the node. Its Claude sign-in draws its own
   terminal screen, so run it in a Terminal window:

   ```sh
   ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox add coder.<node>'
   ```

   Before it opens, explain its sign-ins from the table in step 7, and the T3
   Connect link: the person opens it and signs in, as for the hub. Ask them
   to tell you when it prints that the host is their devbox now.

   It lists the node in their profile and has the hub take it before the
   node applies, so the hub's tunnels, disk watch, and credentials include
   it. It prints two lines that start with `✓ The hub` when both worked.
   When it says the hub did not answer, run `hedge update` on the hub. When
   it says the hub has not linked the node yet, run
   `hedge peers link coder.<node>` on the hub.

   When the node applied the profile and `hedge doctor` there finds
   nothing but steps for the person, such as the Git allowlist, earlyoom
   or a key to paste, it goes on with the sign-ins, T3 Connect and the
   link. At the end it lists those steps once, each with its command. It
   runs none of them itself. Ask the person to run each command, then run
   `hedge apply` on the node, so the jobs, steps and settings that wait on
   those steps get installed. When the apply fails, or `hedge doctor`
   finds anything else, it stops at the profile step. Fix what it says,
   then run `hedge devbox add` again.

   It signs the node in to Coder only at the hub's own Coder address, the
   one the hub's Coder CLI uses. It sends a new token over SSH to the
   node's own `coder login --use-token-as-session`, as in step 7. When the
   node does not reach that address over HTTPS, it makes no token and
   sends none, and it stops with the sign-in the person does on the node:
   install the Coder CLI there, and run `coder login` with an HTTPS address
   the node reaches. Then run `hedge devbox add` again.
   When the node is already signed in to Coder another way, at another
   address as another user, through `CODER_URL` or `CODER_SESSION_TOKEN`,
   or with a `url` or `session` path that is not a plain file, it leaves
   that sign-in alone and makes no token. It installs a missing Coder CLI
   from the hub's Coder address as above, and lists `coder login` with that
   address among the steps for the person at the end. The step first names
   each path to move aside, such as `~/.config/coderv2/session` when it is a
   directory or a link, and each variable to remove from the node's
   environment, because Coder reads these variables before its files. When
   the hub's Coder address is plain HTTP, the step prints no command: the
   person signs the node in over HTTPS. When the Coder CLI could not be
   fetched from the hub's Coder address, the step says so: the person
   installs it from their Coder deployment and signs in at an HTTPS address
   the node reaches. Ask the person to run it only when the node should use
   the hub's Coder deployment.
4. **Check.** Run the `hedge doctor` of step 8 on each node, and on the hub
   again. Explain each line as in step 8.

To add a node later, when the load grows, create it as in step 5 with the
next node name and a 500 GB disk, then run item 3 above for it, and its
`hedge doctor`.

**Clean up what you replace.** When a new hub or node replaces an old
workspace, clean up only after item 4 passes on the new one, and ask before
you remove anything. A workspace from step 5 that `hedge devbox add` never
touched is not a devbox yet. It needs only the `coder delete`, after the
person says yes, and it can go at once.

1. Take the old box out of their profile, on the hub:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox remove coder.<old name>'
   ```

   It takes the old host out of their profile and unlinks it in T3 Code on
   the hub. The hub stops its tunnel, disk watch, and link to that host at
   its next `hedge update`. An old hub can go only after `hedge hub here`
   named the new one. When it stops with an error, fix what it names and run
   it again.
2. Delete the old workspace with `coder delete <old name>`, and remove it in
   T3 Code's Settings → Environments on the Mac.

## 10. Start threads on the nodes

T3 Code on the Mac and the phone reaches the hub and the nodes through T3
Connect. Ask the person to open T3 Code's **Settings → Environments** and
check that the hub and each node are listed. When one is missing, pair it
through its T3 Connect address, as `hedge devbox add` links the boxes. Print
the address on that box:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; hedge devbox address'
```

It asks the T3 Code server that runs on that box, so it finds the address
also when `t3 connect status` does not print it. When it says that T3
Connect is off, start it on that box as in item 5 of step 7, give the person
its sign-in link, and run it again. When it says that T3 Code gives no
tunnel address, stop, and make no token. Tell the person that this box does
not report its address yet, and pair it later. Make a pairing token
only once you have the address:

```sh
ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; t3 pair --ttl 10m --label t3-app'
```

Give the person the address and the token after `Token:`. Never give the
`Pairing URL` it prints: it names the box's own loopback address, which the
Mac and the phone cannot reach. They add the box in **Settings →
Environments** with that address and token.

Then make new threads start on the nodes. This setting lives in the T3 Code
app on each device, so the person sets it: in **Settings → Environments →
Load balancing**, turn it on, and set the hub and this Mac to **Manual
only**. The nodes then take every new thread. Ask them to tell you when it
is done, and to start one test thread to see it open on a node.

## 11. Hand over

Add their profile as a T3 Code project named `hedge-profile` on the hub, so
they can open a thread there. Use the folder that the hub applies, which
setup saves as `profileDir` in `~/.config/hedge/machine.json`: it can be the
checkout of the Coder dotfiles instead of `~/.local/share/hedge/profile`.
Skip it when T3 Code already lists a project at that folder:

```sh
ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; dir=$(sed -n "s/^ *\"profileDir\": \"\(.*\)\",\{0,1\}$/\1/p" ~/.config/hedge/machine.json) && [ -n "$dir" ] && t3 project add --title hedge-profile "$dir"'
```

Then give them these habits, one line each:

- When something does not fit how you work, open a thread in the
  `hedge-profile` project and say what to change. Every box takes the
  change.
- Hedge keeps itself up to date: each box runs `hedge update` every night.
- **Side fix.** When an agent finds an unrelated problem, it hands the fix to
  a new thread with its own pull request, and stays on its task.
- **Build.** Type `/build` and say what you want. The agent sizes the work:
  a small change goes to a pull request, and big work becomes a map of
  tickets with one worker thread per ticket.
- **Learn.** The video lessons at `https://posthog.github.io/hedge/learn/`
  show each part of Hedge in a few minutes.

Leave out a habit whose pack they did not pick: **Side fix** and **Build**
need the Orchestration pack.
