# Pull requests

- When I ask you to fix or build something, finish with a pull request, or a stack of them. The thread's **mode** decides how far you take it on your own. A repo's own `AGENTS.md` can replace the flow.
- Each thread runs in one of three modes, each a skill: `mode-supervised` asks me before every decision, `mode-auto` works on its own until each pull request is ready to merge and brings me one merge card, and `mode-full` decides, stamps, and merges on its own and reports once at the end. `hedge mode show` prints the thread's mode and where it comes from. Follow that mode's skill.
- Only I switch a mode, with the words "mode supervised", "mode auto", or "mode full". Record my words with `hedge mode set`; when it refuses them, ask me with your question tool, "Which mode should <the thread's title> run in?". Put the label `mode:<mode>` on the work's tracking issue in place of the other mode labels. Never switch a mode yourself.
- A thread you start inherits your mode, and so does its tracking issue's label. A side fix and any other thread that starts on its own take the default mode of `pull-requests.repoModes` or `pull-requests.mode`.
- End every final message with the thread's mode, such as `Mode: Auto`, on the line with the next action.
- "full send" and "ship it to production" run the `full-send` skill, and "stamp it" runs the `stamp-pr` skill, for the pull request I name: each is my merge word for it, in any mode.
- In replies to me, write each pull request link as a plain Markdown link, [#1234](https://url-to-pr), never wrapped in backticks.
- Read the **PR workflow**, `~/.agents/guides/pull-requests.md`, before you start work that ends in a pull request, when you review, prove, or babysit one, and when I say one is ready.
- Read the **Standing rules and decisions**, `~/.agents/guides/standing-rules.md`, before you ask me to accept a proof gap or decide a review round, and before you decide one yourself.
