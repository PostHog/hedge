# <img src="docs/hedge-logo.svg" alt="" width="30" height="30"> PostHog Hedge

<img src="docs/hedge.svg" alt="Your Mac and your phone run only the T3 Code app. It links to your nodes in the cloud, where agent threads work in their own worktrees. Your hub in the cloud links the nodes and keeps the secrets of your packs. Every cloud box reads the same private profile repo on GitHub." width="760">

**PostHog Hedge runs your coding agents in the cloud, not on your Mac.**

- **Always on.** Agents keep working when you close your Mac or go to sleep.
- **Secure.** Agents run on isolated cloud boxes. Pack secrets, such as your
  Slack, incident.io, and MCP gateway sign-ins, stay on your hub. Your Mac
  stays clean.
- **With you everywhere.** Read and steer every thread from your Mac or your
  phone.
- **Grows with your work.** Add a node when you need more agents at once.

Hedge sets up one **hub** and one or more **nodes**: Linux boxes in the
cloud, such as Coder workspaces. Each gets T3 Code, Claude Code, Codex, and
the agent workflows you pick as **packs**. Your answers live in your own
private **profile** repo, so every box gets the same setup. Your Mac and
your phone run only the T3 Code app. Hedge installs nothing on them.

https://github.com/user-attachments/assets/153cb394-af22-4096-8344-2c5487af3cfe

## Getting started

You need a Coder deployment where you can create workspaces. The setup agent
creates your boxes with the Coder CLI and reaches them over SSH. Plain Linux
boxes without Coder are not supported yet.

1. **Download [T3 Code](https://t3.codes)** on your Mac, and open it. Its
   Welcome page sets up one agent, Claude Code or Codex, and signs you in.
   The first setup runs there. Add T3 Code on your phone once your boxes are
   linked.
2. **Sign in with T3 Connect.** In T3 Code, open **Settings → Sharing &
   access**, sign in, and turn on **T3 Connect**. It shows your hub and your
   nodes in T3 Code on your Mac and your phone.
3. **Paste this prompt** into a new thread in T3 Code, or
   [open it in T3 Code](https://app.t3.codes/new?prompt=Set%20up%20Hedge%20with%20me.%20Read%20https%3A%2F%2Fraw.githubusercontent.com%2FPostHog%2Fhedge%2Fmain%2FSETUP.md%20and%20follow%20it%20step%20by%20step.):

   ```text
   Set up Hedge with me. Read https://raw.githubusercontent.com/PostHog/hedge/main/SETUP.md and follow it step by step.
   ```

From here the agent leads. It creates your hub, sets Hedge up there over
SSH, and adds your nodes from the hub. It explains each part and runs the
steps itself. You answer its questions and do your own sign-ins.

## Packs

Base and Hub are in every Hedge. You pick the rest.

- [Base](https://posthog.github.io/hedge/packs/base/): every box gets safety rules, the model table, T3 Code defaults, and the jobs that keep it current.
- [Hub](https://posthog.github.io/hedge/packs/hub/): the hub links your boxes, cleans their disks, and keeps your pack secrets. Turn on recovery, and threads go on after a usage limit.
- [Quality gates](https://posthog.github.io/hedge/packs/pull-requests/): every change passes proof and a second-model review before it merges, and a risky change also passes a QA swarm.
- [Orchestration](https://posthog.github.io/hedge/packs/orchestration/): type /build and say what you want: small work goes straight to a pull request, big work becomes a map that a conductor thread works through, and side work gets its own thread.
- [Communication](https://posthog.github.io/hedge/packs/communication/): agents write in your voice, give short updates, and share plans and previews as links.
- [Guards](https://posthog.github.io/hedge/packs/guards/): hooks stop risky shell commands, such as a push past review or a polling loop.
- [Memory](https://posthog.github.io/hedge/packs/memory/): one private repo holds what your agents learn and what you save, and every box reads it.
- [Slack](https://posthog.github.io/hedge/packs/slack/): your own Slack message or reaction with your trigger emoji, or a mention of your Slack app, starts a T3 thread about it.
- [Paging (incident.io)](https://posthog.github.io/hedge/packs/incident-io/): an agent that watches a risky change pages you, and only you, when it goes wrong.
- [MCP gateway](https://posthog.github.io/hedge/packs/mcp-gateway/): the hub signs in to your MCP servers once, and agents on every box reach them through it.

Switch Quality gates, Orchestration, Communication, and Memory on
[the Hedge site](https://posthog.github.io/hedge/), and it builds the prompt
above with your picks in it. [The Packs page](https://posthog.github.io/hedge/packs/) builds a
prompt that adds packs to a Hedge you already run. Five pack pages have a
short video.

## Day to day

On the hub or a node:

- `hedge packs` lists your packs. `--add <pack>` or `--remove <pack>` turns
  one on or off.
- `hedge doctor` checks the box against your profile and changes nothing.
- `hedge update` moves the engine and your profile forward, then applies.
  Every box also runs it each night while Nightly updates is on.
- `hedge devbox add <ssh host>`, on the hub, makes a box one of your nodes.

[Getting started](docs/getting-started.md) shows each setup step by hand. The
[Slack](docs/slack.md), [incident.io](docs/incident-io.md), and
[secret store](docs/secret-store.md) docs cover those parts in depth.

## Coming from Fleet

Hedge was named Fleet before. Run the `get.sh` line below once on each box
that ran Fleet: it stops Fleet, copies your setup, and starts Hedge. On a
Mac, it only stops Fleet's jobs, so run it there after your hub works.
`fleet` still runs the same command. To undo the move, see
[Go back to Fleet](SETUP.md#go-back-to-fleet).

## Status

Hedge is early. No release is tagged yet, so `get.sh` installs `main`. On
every pull request, CI runs the install, `hedge setup`, and `hedge doctor` as
a new Linux user. The real sign-ins, T3 Connect, and a live Coder workspace
need a person, so CI does not prove them yet. The [changelog](CHANGELOG.md)
lists every change since v0.1.0, released under the name Fleet.

## Set it up by hand

Run this on the hub as your login user, not with `sudo`. It needs Linux (x64
or arm64) with `curl`, `git`, `tar`, `sha256sum`, `python3`, cron, and
systemd's user manager. To keep T3 Code running after you log out, an
administrator runs `sudo loginctl enable-linger <your user>` once. On a Mac,
`get.sh` installs nothing.

```sh
curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh
```

[`get.sh`](get.sh) installs the GitHub CLI, Bun, and T3 Code when they are
missing, fetches the engine into `~/.local/share/hedge/engine`, and puts
`hedge` on your `PATH` in your shell profile, so open a new shell to use it.
Then `hedge setup` asks plain-language questions, has
you sign in to GitHub and to Claude, ChatGPT, or both, saves your answers to
a new private profile repo named `<login>-hedge`, and applies your packs. A
profile you made before keeps its name, such as `hedge-profile`. Run `get.sh`
again to pick up where it stopped.

## Develop

```sh
bun install
bun run test
bun run typecheck
bun scripts/build-page.ts
```

The tests need `jq` on your `PATH`. The last command writes the site to `site/`. [GLOSSARY.md](GLOSSARY.md) holds
the words Hedge uses.

## License

MIT. See [LICENSE](LICENSE).
