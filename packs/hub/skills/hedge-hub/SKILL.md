---
name: hedge-hub
description: Manage your machines from the Hedge hub. Use to roll out a profile or engine change to every machine, to change one machine, or to look up which machines Hedge manages.
---

# Hedge hub

The hub is the devbox that the profile's `hub` names (`hedge hub here`).
It reaches every devbox over SSH and the Mac through its T3 link. Make each
change in the profile, push it, and roll it out from the hub.

## The machines

- **The hub**: this machine. `hedge hub status` prints this machine's name
  and the hub that the profile names. `hub.alias` is the SSH name other
  machines use for it.
- **Devboxes**: the `devboxes` list in the profile's `hedge.json`, plus the
  ones `hedge devbox` lists on the hub, without duplicates. Reach each one by
  its SSH name.
- **The Mac**: a T3 environment link on the hub. `t3_environment_links`
  lists it.
- **Boxes**: short-lived devboxes from the pool. `hedge box list` lists them.
  Leave them out of a rollout.

`profileDir` in `~/.config/hedge/machine.json` names the profile checkout.

## Roll out a change

1. **Push.** Commit the profile change in the profile checkout and push it.
   An engine change needs no commit here: it reaches a machine through
   `hedge update` once it is on the engine's main branch, or in a release for
   the release channel. Done when `git status` in the profile checkout is
   clean and its branch matches its remote.
2. **Hub.** Run `hedge update`, then `hedge doctor`. Done when both exit 0.
3. **Devboxes.** For each devbox in turn, run the same two commands in a
   login shell over SSH, with a total limit of 10 minutes:

   ```sh
   timeout 600 ssh -o BatchMode=yes -o ConnectTimeout=10 <devbox> 'f="$HOME/.local/share/hedge/engine/hedge"; bash -lc "sh $f update && sh $f doctor"'
   ```

   Done when each devbox has exited 0 or has a failure to report.
4. **Mac.** Find the Mac with `t3_environment_links`. Call `t3_thread_launch`
   with its `environmentId`, `scratch: true`, `runtimeMode` `full-access`,
   and a prompt that runs `hedge update`, then `hedge doctor`, stops at the
   first failure, and reports each exit code and every `To do:` line. Wait
   with `t3_thread_wait`. Done when the thread answered, or when the link is
   missing, expired, or timed out: then report the Mac as pending with the
   reason.
5. **Report** one line per machine: updated and verified, pending, or the
   failure with its last output line. Relay every `To do:` line; those are
   steps only the person can do. Done when every machine from **The
   machines**, boxes aside, has a line.

### When a step fails

- **Unreachable devbox:** report it as pending. It takes the change on its
  next `hedge update`.
- **Out of time:** the command exits 124 when a devbox takes longer than 10
  minutes. Report it as failed with "timed out after 10 minutes" and go on to
  the next devbox. Do not wait for it or run it again.
- **`hedge update` refuses:** the engine checkout has local changes, or the
  profile did not fast-forward. Report the line it printed and skip that
  machine.
- **`hedge apply` conflicts:** a file Hedge wants exists with other content.
  Report each path and wait for the person: adopting discards that content,
  so only they decide. Apply their answer with `hedge apply --adopt <path>`.

When you start outside the hub, start a T3 thread on the hub that runs these
steps.

## Change one machine

Put shared setup in the profile and roll it out. Keep a value for one machine
in that machine's own local files, outside the profile. To add a devbox, run
`hedge devbox add <ssh name>` on the hub: it sets the host up as a devbox and
lists it.

## Own-account balancing

This workflow is off by default. Read its terms note first:
`hedge packs` lists it while the Hub pack is on, and prints it again when the
person turns the workflow on with
`hedge packs --workflows own-account-balancing=on`. Only the person does that. Balancing is only for
the person's own subscriptions, never for someone else's.

- **The proxy.** On the hub, `hedge apply` runs `hedge cli-proxy install`.
  It installs the pinned CLIProxyAPI release, checks its SHA-256, and runs it
  as the user service `hedge-cli-proxy.service` at `http://127.0.0.1:8317`,
  loopback only. Its files are in `~/.local/share/hedge-cli-proxy/`. The
  client key is in `~/.config/hedge/cli-proxy.key` and the management key in
  `~/.local/share/hedge-cli-proxy/management.env`, both mode 600. Install
  keeps a file that Hedge did not write and stops at a linked path.
- **The Codex catalog.** Codex and T3 offer only the service tiers that the
  proxy's model catalog lists for a model. Upstream's catalog lists only
  `priority`, but Codex accounts also serve `ultrafast` on GPT-6.2 Sol,
  GPT-6.2 Astra, GPT-6.1 Sol and GPT-6 Astra. So the proxy reads its Codex
  catalog from `~/.local/share/hedge-cli-proxy/codex-catalog.json`
  (`models.codex-catalog` in its config): upstream's catalog with the
  `ultrafast` tier added. Install writes it, each balancer run fetches it
  again when it is 3 hours old, and `hedge cli-proxy catalog` fetches it now.
  A failed or empty fetch keeps the last file. The doctor warns while the file
  is missing.
- **The model registry.** The proxy routes by a second file, upstream's
  `models.json`, with one model list per Codex plan (`codex-pro`,
  `codex-team`, and so on). It sends a model only to subscriptions whose plan
  lists it. Hedge writes it to
  `~/.local/share/hedge-cli-proxy/models-catalog.json` (`models.catalog` in
  the config) on the same schedule as the catalog. When Codex accounts serve
  a new model before upstream lists it, `earlyModels` in
  `packs/hub/lib/codex-catalog.ts` adds it to both files as a copy of the
  model it succeeds, in the registry only for the plans it names: GPT-6.2 Sol
  copies GPT-6.1 Sol, and GPT-6.2 Astra copies GPT-6 Astra, both for
  `codex-pro`, because a Business seat refuses them. Upstream's own entry
  replaces the copy once it appears.
- **Subscriptions.** The person adds each of their own Claude accounts on the
  hub, or their Codex accounts on the `codex` plan. Setup never waits for
  them: the proxy installs and runs with none. Until the proxy holds
  `hub.proxyAccounts` of them that work (2 by default), `hedge apply` and
  `hedge doctor` show a `To do:` line with the login command, and nothing
  fails. `hedge cli-proxy accounts` counts them; it exits 4 while too few
  work. On the `both` plan it counts Claude subscriptions, and
  `hedge cli-proxy doctor` names the Codex ones beside them. Keep the login
  URL and callback values out of logs and Git.
- **The balancer.** Every 5 minutes, `hedge cli-proxy-balance` reads the weekly
  usage of each subscription and gives the highest priority to the one whose
  weekly quota resets first. A full or unreadable subscription gets priority
  0. A Claude subscription with extra usage turned on (a Team seat) would
  bill past its windows, so the balancer turns it off while any window is
  full and on again when all have capacity. It lists the ones it turned off
  in `~/.local/state/hedge/cli-proxy-paused.json`, so a subscription turned
  off by hand stays off. To allow paid extra usage on a Claude subscription,
  add its full Auth Index from the management panel to the JSON array in
  `~/.local/share/hedge-cli-proxy/allow-extra-usage.json` on the hub. The next
  balance run resumes any listed subscription it paused. Full subscriptions
  still get priority 0. It keeps fill-first routing, and session affinity keeps
  each session on one subscription. `hedge cli-proxy-balance --dry-run` prints
  the ranking and changes nothing. Unreadable usage does not fail the run. Its log lines name a
  subscription by provider and short id, such as `Claude subscription
  aaaabbbb`, never by its file name, which holds the account's email. The
  short id is the first 8 characters of the subscription's Auth Index in the
  management panel. When the Auth Index holds other characters than letters,
  digits, `-` and `_`, the short id is the first 8 characters of the SHA-256
  of the file name instead: `printf %s <file name> | sha256sum | cut -c1-8`
  on the hub finds it. When the proxy says a subscription's login expired
  (`invalid_grant`) while that subscription fails, the balancer's log line says
  so, and `hedge cli-proxy doctor` warns with the same short id and its sign-in
  command. Only working subscriptions count toward `hub.proxyAccounts`. Usage that is
  unreadable for another reason has no such warning: it clears on a later run.
- **Claude Code.** On the `claude` and `both` plans, on the hub and on each
  devbox, Hedge sets `env.ANTHROPIC_BASE_URL` to the proxy and `apiKeyHelper`
  to a command that reads the client key file. The key is never in the
  settings file.
- **Codex.** On the `codex` and `both` plans, Hedge sets Codex's
  `model_provider` to `hedge-proxy`, a provider that reads the same key file.
- **Devboxes.** The hub's SSH tunnel to each devbox carries port 8317. On the
  hub, `hedge cli-proxy doctor` prints one connect command per devbox; it
  sends the key on standard input, then runs `hedge apply` on the devbox.
  Connect only saves the key, and `hedge apply` writes the Claude and Codex
  settings. When the hub
  hands a box over, it sends the key, runs connect, then runs `hedge apply`
  on the box. When that apply exits 0, the hub says when an agent there
  keeps its own sign-in. When it exits nonzero, a timeout included, the hub
  says only the exit code and `hedge box run <box> -- hedge apply`.
- **When the proxy is down.** Hedge's Claude settings wait for
  `hedge cli-proxy check`, and its Codex settings wait for
  `hedge cli-proxy check codex`. Both checks only read. On the hub, both
  also fail while `hedge cli-proxy doctor` finds the proxy unsafe: a plugin
  Hedge did not install, or panel files that do not match their pins. When
  the proxy is unsafe, or does not serve an agent with this machine's key,
  `hedge apply` leaves that
  agent's settings out and removes Hedge's own values, so the agent uses its
  own sign-in, and the next apply changes nothing. A Claude credential
  beside Hedge's proxy address leaves with it, unless a pack sets that same
  value now, and a `To do:` names it. Only the Hub pack may set Hedge's
  proxy values; a profile that sets one fails to load and names the
  setting. `hedge apply` and
  `hedge doctor` name the failed check. When the proxy answers the key but
  lists no model for the agent, the check exits 4: the agent stays on its
  own sign-in, and the line is a `To do:` with the login command, not a
  failure. The `To do:` names the agent whose model is missing. Most often
  the proxy holds none of that agent's subscriptions that work. Run
  `hedge cli-proxy doctor` on the hub to tell the two cases apart: it counts
  the subscriptions that work, and fails when one works but the proxy lists
  no model for it. `hedge cli-proxy connect` then saves the key, and
  `hedge apply` keeps the agent on its own sign-in until the proxy serves
  it. A later apply then sends the agent there. Connect still changes nothing when the proxy
  does not answer or refuses the key. The first apply after the proxy
  answers again sends the agent back to the proxy.
- **The panel.** The Proxy panel workflow is off by default and needs
  own-account balancing. With
  `hedge packs --workflows proxy-panel=on`, `hedge cli-proxy install` adds
  the pinned CLIProxyAPI management panel with quota history charts, drain
  forecasts, and Reset weekly and Reset Fable buttons, and the quota-ledger
  plugin that keeps `hub.proxyHistoryDays` of history (35 by default). Both
  downloads must match their SHA-256. The balancer then records each
  subscription's quota windows in the ledger on every run. The panel is at
  `http://127.0.0.1:8317/management.html` on the hub, and on each devbox
  through its tunnel; it is never behind the hub's HTTPS. Sign in with the
  `MANAGEMENT_PASSWORD` in `~/.local/share/hedge-cli-proxy/management.env` on
  the hub. A reset button spends a banked reset, which does not come back:
  the first click arms it, and a second click within 5 seconds spends it.
  Hedge owns `config.yaml`, so a panel edit to it lasts until the next
  `hedge apply`. Turning the workflow off first restarts the proxy with the
  panel closed, then removes the page and the pinned plugin and keeps the
  history file. `hedge cli-proxy doctor` fails while a closed panel still
  answers, when the page does not match its pin (CLIProxyAPI may have
  fetched an unpinned one), and on any plugin Hedge did not install: with
  plugins on, anyone with the management key can install others from
  CLIProxyAPI's plugin store. Turning the panel off keeps those and names
  them. Every tunnelled client reaches the proxy as 127.0.0.1, so 5 wrong
  panel sign-ins from any devbox ban 127.0.0.1 from the management API for
  30 minutes. That also stops the balancer and the doctor on the hub until
  the ban ends.
- **Stop on one machine.** `hedge cli-proxy disconnect` removes the settings
  and the key. Then run `claude` and enter `/login`.
