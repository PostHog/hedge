# Setup note: Memory

Read this when the person picks the Memory pack.

One private GitHub repo holds what agents learn and what the person saves,
and every machine reads it. The pack has three workflows:

- **Shared memory** (on): agents keep what they learn as notes in the repo.
- **Context library** (on): a prompt about a topic of the person's plans,
  research, decisions or saved threads gets links to them, and
  `hedge context` saves new ones. It stays off until it knows its repo, and
  `hedge doctor` says so.
- **Dream** (off): each night the hub turns the day's sessions into one draft
  pull request on the memory. It needs the Hub pack.

Ask with your question tool which repo to use:

- **Their profile repo** (recommended): add nothing to the command.
  `hedge setup` and `hedge packs --add memory` set `context.repo` to their
  profile repo unless `<their GitHub login>/hedge-memory` or `fleet-memory`
  exists already. Memory lives in `memory/`, dreams in `dreams/`, and the
  context library and map tracker use the same repo, checked out at
  `context.path` (`~/dev/context` unless set).
- **Another context repo**: add `--set context.repo=<owner/name>`.
  Memory then lives in its `memory` folder, the context library and the map
  tracker use the whole repo, and the checkout is `context.path`,
  `~/dev/context` unless they set it. It may be a private repo of their
  team's org; Hedge refuses a public one.
- **Separate repos they already have**: add `--set memory.repo=<owner/name>`,
  and `--set memory.subtree=<folder>` when the notes live in one folder of it.
  Add `--set context-library.repo=<owner/name>` for the library, and
  `--set context-library.path=<folder>` when its checkout should live
  somewhere other than `~/dev/context-library`.

To leave the context library off, add `context-library=off` to `--workflows`.
To turn Dream on, add `dream=on`.

With the MCP gateway on, the hub also serves the library's search as the
`context_search` tool. It mounts the hub's checkout read-only and logs no
search. Until the hub's first sync clones the library, the gateway runs
without the tool, and its upstream check says what it waits for.

`hedge context add <url>` reads the source in code before an agent starts. A
web page comes from a plain request. A Slack thread or canvas, a Google Doc,
or a Wispr Flow link comes from one fixed tool of the hub's MCP gateway, so
those links need the gateway key that `hedge apply` gives a machine. Then a
Claude agent on the survey row turns the text into a note. It runs without
tools, MCP servers, or settings files, in an empty folder, and sees only the
source's text, the topics the library uses, and the note it updates. A page
that tells it to read or send notes finds no note to read and no way out.
Hedge writes the one note under `notes/` and refuses any other path. It keeps
only the links that appear in what the agent read, turns images into plain
links, escapes HTML, and shows code and diagram blocks as plain text, so
opening the note sends nothing new to another host.

With the Slack pack's trigger on, their own `:brain:` reaction on a Slack
message saves its thread as a note. The reaction shows `:eyes:` while it runs
and goes away once the note is saved. After that, the note updates by itself
when the thread gets new replies and then stays quiet for 30 minutes. A
thread with no reply for a month stops updating; a second `:brain:` updates the
note at once and follows the thread again. A capture that a restart of the
service cuts off runs again when the service starts.

The capture also looks for a Wispr Flow meeting held within an hour of the
thread's start, such as the recording of a huddle, and folds its decisions and
action items into the same note. When the meeting's Wispr notes are not ready
yet, it looks once more 30 minutes later.

After the note is saved, Hedge sends its context to the open T3 threads that
need it, on every linked machine. A router agent without tools, on the survey
row of the model table, reads the note and the list of open top-level threads,
picks at most 8, a conductor before its lanes, and writes each a message with
only the facts it needs. Hedge frames each message as information, not
instructions. The ephemeral reply links each thread that got it. Later replies
only update the note; Wispr notes that arrive late go out once more, with only
what is new. `hedge context share <note> [--dry-run]` and
`hedge context add <url> --share` do the same by hand.
