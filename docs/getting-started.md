# Getting started

This guide sets up Hedge by hand, from two new Coder workspaces to a hub and
a linked node that run the same Hedge setup. Your Mac and your phone run only
the T3 Code app. The setup agent of the [README](../README.md) runs the same
steps for you; this guide shows what it does.

You need:

- the T3 Code app on your Mac, signed in with T3 Connect. You run this setup
  from the Mac. Add T3 Code on your phone once the boxes are linked;
- a GitHub account;
- a Claude plan, a ChatGPT plan, or both;
- a Coder deployment where you can create workspaces, and the Coder CLI on
  your Mac. Each workspace needs the Linux prerequisites in the
  [README](../README.md#set-it-up-by-hand): `curl`, `git`, `tar`,
  `sha256sum`, `python3`, cron, and systemd's user manager, with lingering
  on so T3 Code keeps running after you log out.

## 1. Create the hub and a node

On your Mac, sign in to Coder and create two workspaces: a hub with a 200 GB
disk and a node with a 500 GB disk. When the template has no secret
parameter, give every template parameter with its own `--parameter`, so you
see each value Coder uses. Set the dotfiles
parameter to the SSH address of your profile repo:
`git@github.com:<login>/<login>-hedge.git`, with your login in lower case in
the repo name. When you have a profile from before, use its name, such as
`git@github.com:<login>/hedge-profile.git` or
`git@github.com:<login>/fleet-profile.git`. Coder clones it with the workspace's Git SSH key, so a
private profile works. Its `https://github.com/` address fails on a private
repo, because the box has no GitHub sign-in yet. `hedge setup` makes `<login>-hedge` in step 2 when you
have none. When setup prints another repo in step 2, such as a profile in a
team's org, change the dotfiles parameter of each workspace to
`git@github.com:<repo>.git` in the Coder web app: open the workspace, go to
**Settings → Parameters**, set it, and submit.

When the template has a secret parameter, do not run `coder create` for it:
a value you pass with `--parameter` stays in your shell history, and Coder
can print the default of one you leave out. Create that workspace in the
create form of the Coder web app, with the name that the commands below use:
`hedge-hub` or `hedge-node-1`. Pick the preset None when the form shows a
preset picker, and leave a secret that has a default as it is. Coder keeps
each value of that form with the build, so anyone who can see the workspace
can read it. Then run the other lines of the block below: `coder login`, the
two `coder schedule stop` lines, and `coder config-ssh`.

```sh
coder login <your Coder URL>
coder create hedge-hub --template <template> --preset none --parameter <disk parameter>=200 --parameter <dotfiles parameter>=git@github.com:<login>/<login>-hedge.git --yes
coder create hedge-node-1 --template <template> --preset none --parameter <disk parameter>=500 --parameter <dotfiles parameter>=git@github.com:<login>/<login>-hedge.git --yes
coder schedule stop hedge-hub manual
coder schedule stop hedge-node-1 manual
coder config-ssh --yes
```

Add one `--parameter` for each other parameter of the template. Do not use
`--copy-parameters-from`: Coder then takes the copied workspace's values
over every `--parameter` you pass.

`coder schedule stop <workspace> manual` turns off the stop schedule, but a
build that is already running can keep a stop time from its template.
[`scripts/check-workspace.sh`](../scripts/check-workspace.sh) checks both:
`sh check-workspace.sh hedge-hub <parameter>=<value>...` prints `ok` for each
parameter that has the value you passed, and for a workspace that runs with
no stop time. Pass it only the disk size, the region, the instance type, and
the dotfiles repo, never a private value. It prints no value and no token.
When the disk size or the region is wrong and the template does not let it
change, delete the workspace and create it again.

Check that SSH works. With the default prefix, the workspace `hedge-hub` is
the host `coder.hedge-hub`:

```sh
ssh coder.hedge-hub true
```

## 2. Run the install line on the hub

Open a shell on the hub with `ssh coder.hedge-hub`, and run this as yourself,
not with `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh
```

`get.sh` installs the GitHub CLI, Bun, and the `t3` command when they are
missing. Then it starts `hedge setup`. Setup asks plain-language questions.
Where it shows a default, press ↵ to take it. On a Mac, `get.sh` installs
nothing: it only stops the jobs of an earlier Fleet or Hedge there.

`get.sh` puts `~/.local/bin` and `~/.bun/bin` on your `PATH` in your login
file, which this shell has already read. Before the next steps, put them on
the `PATH` of this shell too, or open a new shell:

```sh
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
```

Setup asks you to sign in. A sign-in prints a link, and often a code. Open
the link on your Mac or your phone:

| Sign-in | What it asks |
| --- | --- |
| GitHub | The code from the terminal on `github.com/login/device`, then your approval. Hedge asks for `repo`, `read:org`, `admin:public_key`, `admin:ssh_signing_key`, and `workflow` once, so it can make your profile repo, add your keys, and push to large repos, where GitHub can ask for `workflow` even when a push changes no workflow file. |
| Claude | Your Claude account in the browser. Paste the code it shows back into the terminal. Only when your plan includes Claude. |
| ChatGPT | The code from the terminal, on the page it prints. Only when your plan includes Codex. Setup checks the sign-in with a real request, because a stale sign-in still looks signed in. When your ChatGPT account or workspace turns device code sign-in off, turn it on in ChatGPT's settings under Security, or ask the workspace admin. Without it, run `ssh -L 1455:localhost:1455 coder.hedge-hub` on your Mac, run `codex login -c 'cli_auth_credentials_store="file"'` in that SSH session, open the link it prints on the Mac, and run setup again. |

Setup creates the private repo `<login>-hedge` in your GitHub account and
saves your answers there. Setup shows the name before it creates the repo, and
you can type another. It marks the repo with the GitHub topic
`hedge-for-<login>`, so setup on your next machine finds it without the name.
When setup cannot add the topic, it prints the command that adds it. When a team pack you picked names a profile org, setup creates `<login>-hedge`
in that org instead, private to the org, where teammates may read it.
Setup first looks for a profile you already have, also with an older name
such as `hedge-profile`, `hedge-profile-<login>` or `fleet-profile`, and
keeps it with its name. When the Memory pack is on and you have no separate
memory repo yet, setup points `context.repo` at that same profile repo, so
memory (`memory/`), dreams (`dreams/`), and the context library live there too.
If you already have a personal profile, setup keeps it
and prints the two commands that move it to the org. Then it applies your
packs to the hub and checks the result with `hedge doctor`. It ends with a
screen that lists your packs and what runs by itself.

If you stop, or a step fails, run the same line again. Every step skips what is
done.

## 3. Turn on T3 Connect on the hub

Still on the hub:

```sh
t3 up --connect
```

It prints a link to sign in to T3 Connect. Open it on your Mac or your phone,
and sign in with the account that the T3 Code app uses.

## 4. Name the hub and add the node

Still on the hub, install the Coder CLI there when it is missing, and sign
the hub in to Coder, so it reaches the node over SSH. The CLI comes from your
Coder deployment, so its version matches. Then name the hub, turn on the Hub
pack, and add the node. The MCP gateway starts off, because it needs Docker
on the hub:

```sh
command -v coder || { mkdir -p ~/.local/bin && curl -fsSL "<your Coder URL>/bin/coder-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" -o ~/.local/bin/coder && chmod +x ~/.local/bin/coder; }
coder login <your Coder URL>
coder config-ssh --yes
hedge hub here
hedge packs --add hub --workflows mcp-gateway=off
hedge devbox add coder.hedge-node-1
```

`hedge devbox add` runs these steps on the node, in this order. It shows each
one as it starts:

| Step | What it asks |
| --- | --- |
| Install Hedge | Nothing. It runs `get.sh` on the node at the engine ref your profile pins. |
| Sign in to Coder | Nothing. It makes a token on the hub and signs the node in with it. |
| Sign in to GitHub | Type the code that the node prints on `github.com/login/device`. |
| Apply your profile | Nothing. It clones your profile repo on the node and applies it. |
| Sign in to Claude | Open the link it prints, sign in, and paste the code back into the terminal. |
| Sign in to ChatGPT | Open the link it prints and type the code it shows. |
| Link T3 Connect | Open the link that `t3 up --connect` prints on the node and sign in. |
| Link T3 Code | Nothing. It pairs T3 Code on the hub and the node. |

When it ends, it prints that the host is your devbox now, and that the hub
took it. If a step stops, run `hedge devbox add coder.hedge-node-1` again. It
picks up where it stopped.

`hedge devbox` lists your nodes. When a new node replaces an old one,
`hedge devbox remove <ssh host>` on the hub takes the old one out of your
profile and unlinks it in T3 Code.

## 5. Start threads on the nodes

In the T3 Code app, open **Settings → Environments**. The hub and the node
show there through T3 Connect. Then open **Load balancing**, turn it on, and
set the hub and your Mac to **Manual only**. New threads then start on the
node.

## Change things later

Run these on the hub, or on a node:

- `hedge packs` lists your packs. `hedge packs --add <pack>` and
  `--remove <pack>` turn one on or off. A pack marked `~` is on, but a step
  that only you can do is not done on this box yet. Its workflow shows
  `needs setup`, and `hedge doctor` lists the steps.
- `hedge settings` lists your settings. `hedge set <pack.key>=<value>` changes
  one.
- `hedge doctor` checks a box against your profile without changing it.
- `hedge update` moves the engine and your profile forward. Each box also
  runs it every night.
- `hedge refresh` asks each pack source that follows a branch, such as a
  skills repository, whether it moved. When it moved forward, it updates the
  files your packs place, such as skills, guides, and instructions, and leaves
  steps, settings, and jobs to the nightly update. Each box runs it every
  five minutes. Your skills are links into Hedge's copy of each source, so an
  edit to a skill is an edit in that copy. Hedge keeps it: `hedge refresh`,
  `hedge apply`, and `hedge update` leave that source where it is and name the
  edited files until you commit or undo them. `hedge refresh` also takes no
  rewritten branch; `hedge update` does.

## When setup goes wrong

`hedge triage` collects what the Hedge maintainer needs to fix a setup
problem: the versions of Hedge, T3 Code, Claude Code, Codex, gh, Bun and your
OS, the `hedge doctor` output, the step that failed and its error, the setup
timings, and the setup transcript. It removes tokens, keys, email addresses,
hostnames and home paths, and shows you the report. Then you pick: open a
public issue on `PostHog/hedge` with it, save it to a file to send
yourself, or neither.

An agent can run `hedge triage --print` to show you the report in the chat,
and `hedge triage --send` once you say yes. `--save <file>` writes it to a
file, and `--note <text>` says what went wrong.

[The Hedge page](https://posthog.github.io/hedge/) shows what each
pack does, and builds the setup prompt with your picks.
