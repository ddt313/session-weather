# Claude Code mods

Mods for Claude Code: plugins of function hooks that change Claude Code's own
interface. This folder is a plugin marketplace, `ddt313-mods`, holding one mod
so far.

| Mod | What it does |
| --- | --- |
| [session-weather](session-weather) | A pane with the session's weather: how full the context is, the last turn, the 5-hour and weekly limits, the cost, and a running Haiku summary of what Claude is thinking. |

## Session Weather

The pane opens beside the conversation when a session starts.
`/session-weather` opens it again after you closed it.

**Weather**

- A forecast from the context fill: ☀ Clear (under 25%), ☁ Cloudy, ☂ Showers,
  ☇ Storm, ϟ Compact soon (90% and up, with a toast once on the way up).
- Tokens used out of the window, a bar, and where auto-compact runs.
- The last turn: the tokens it added, how long it ran, its tool calls, and
  the share of its input the prompt cache served.
- The 5-hour and weekly limits with the time until they reset, kept across
  sessions until the next reading.
- The session's cost at API prices, as `/cost` reports it.

**Thinking summary**

- Reads the main loop's thinking blocks as they stream (subagents left out)
  and has Claude Haiku 5.5 sum them up in a few lines: what Claude is doing,
  the decisions it settled on (★), and what it says comes next (→).
- At most one update every 15 seconds while new notes arrive. A long
  stretch of thinking does not wait for its end: what it wrote since the
  last update (200 characters or more, cut at a sentence's end) is
  summarized while it goes on. The prompt's
  earlier updates stay, newest first, in their own window under the weather.
  A recap closes a turn that had two updates or more. A new prompt starts the
  list over.
- To scroll the updates and nothing else, click ▲ ▼: each click moves about
  half the window, and a line scrolled part-way shows from there, marked `…`.
  The mouse wheel does not reach the updates (the desktop scrolls the pane
  itself with it), nor do the keys, and holding an arrow down does not scroll
  (the desktop draws the pane again only when the press ends).
- Claude Code receives summaries of Claude's reasoning only while the
  session's **Transcript view** is **Thinking** (or Verbose), from the next
  prompt on. In the Normal view only the short notes Claude writes between
  tool calls arrive, so there is less to summarize.
- Each turn's updates also go to a log of the session's own, a Markdown
  file named after the session's id in `~/.claude/session-weather/thinking/`
  (under `CLAUDE_CONFIG_DIR` when that is set). A turn's section says when
  it began and how it ended, then your prompt, the recap, and the updates in
  the order they came. It is written again as each update comes, a recap
  that lands after your next prompt still goes to its turn, and a resumed
  session goes on in the same file. A turn with no update adds nothing.
- Claude reads the log through a tool of the mod's,
  `mcp__session-weather__thinking_log`, kept behind ToolSearch until it is
  wanted: the recaps of the last 10 turns by default, up to 50 turns, or
  every update with `full`. Its description tells Claude that the log is
  Haiku's paraphrase of its summarized thinking, to check against the code
  or the transcript, not a record of what it decided.
- The mod cannot delete files (its file API has no delete), so the logs stay
  until you remove them; a turn takes a kilobyte or two.
- The summary is written in Vietnamese (fixed for now).
- Each update is one Haiku request on the session's own account, about
  $0.001; the pane shows what the summaries cost this session. The request
  carries your prompt and Claude's thinking notes. **Turn summary off** stops
  the requests, and the choice is kept across sessions.

## Install

```
claude plugin marketplace add <path to this folder>
claude plugin install session-weather@ddt313-mods
```

A marketplace that is a folder is read from that folder: edit a mod, then
run `/reload-plugins` in a session to load the change, with no new version
and no reinstall.

## Develop

```
claude plugin test session-weather
claude plugin validate session-weather
```

- `session-weather/hooks/register.tsx`: the hooks module.
- `session-weather/types/index.d.ts`: the contract of the values the mod
  keeps in `$.state`.
- `session-weather/tests/register.test.tsx`: its tests.

Claude Code writes the API's type declarations into
`session-weather/.claude-plugin/types/` when it loads the mod; they are not
committed.

## License

MIT, see [LICENSE](LICENSE).
