// The live window's fill; `tokens` and `percent` are absent right after a
// compaction, until the next response reports them. `isCompacted` marks the
// reading a compaction left, whose drop is the change shown.
export type Reading = { tokens?: number; window: number; percent?: number; isCompacted?: true }

// The window's fill where the main loop's turn began: the turn before's end.
export type Sample = { tokens: number; percent: number }

// One of the account's rate-limit windows as the engine reports it: which
// one, its share used, and when it resets (ISO 8601).
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// This session's part of what every session spent in one rate-limit window
// since it began, 0 to 1, by the window's kind.
export type Share = { kind: string; ratio: number }

// The main loop's last finished turn: how long it ran, how many tool calls
// it made (its subagents' included), and the share of its input the prompt
// cache served, when it reported usage.
export type LastTurn = { durationMs: number; tools: number; cacheRate?: number; isAborted: boolean }

// When the engine compacts on its own: at `threshold` tokens, or not at all.
export type AutoCompact = { threshold?: number; isEnabled: boolean }

// A row of what fills the context, as the engine's breakdown estimates it:
// its name as /context prints it, and its tokens.
export type Fill = { name: string; tokens: number }

// The session as the wide layout's line tells it: when it began (ms since
// the epoch, a /clear starting it over), how many prompts the person has sent
// it as the engine counts them, and the main loop's model as the context
// breakdown names it; each one absent until read.
export type Facts = { startedAt: number; turns?: number; model?: string }

// A subagent the main loop started, at work or ended since the person's
// prompt: its id, the words its row gives it (the task's description, else
// its name or type), where its loop stands (`pending`, `running` or
// `waiting` at work; `completed`, `failed` or `killed` once ended), when it
// was spawned (ms since the epoch), where the mod saw it spawn, and, ended,
// when the mod saw it end.
export type Subagent = { id: string; label: string; status: string; startedAt?: number; endedAt?: number }

// What a subagent of the list did, as far as the mod saw it, by its id: the
// model its latest request named and the effort it asked for, the tokens its
// own requests read and wrote, those its own subagents' did (`nested`), the
// tokens its latest request carried (its context), and its latest tool call
// in a few words. A figure not seen yet is absent; tokens start at 0.
export type SubagentFigures = {
  id: string
  model?: string
  effort?: string
  tokens: number
  nested?: number
  context?: number
  action?: string
}

// The compactions of the session the mod has seen: how many, and whether it
// has seen the session from its first prompt (`isWhole`), or only since it
// loaded into one under way, which may have had more before.
export type Compactions = { count: number; isWhole: boolean }

// One update Haiku gave on a turn's thinking, written at `at` (ms since the
// epoch): what Claude is at, the decisions it settled on since the update
// before, what it takes as true without having checked it, and what it says
// comes next. `isRecap` marks the one written after the turn ended, over the
// whole turn.
export type ThinkingEntry = {
  at: number
  gist: string
  decisions: string[]
  assumptions: string[]
  next?: string
  isRecap?: true
}

// Something of the main loop's turn the summary reads, kept at `at` (ms
// since the epoch): a thinking note, a tool call in a few words, or a block
// of the text Claude wrote to the person.
export type TurnMark = { at: number; text: string }

// The main loop's current or last turn, as the summary follows it: the
// turn a prompt of the person's own began, and every turn a subagent's
// result or a background task's notification began after it, which go on
// with it. `turnId` is the first turn's id, and `lastTurnId` the latest of
// those that went on with it (absent while there is none). `paused` is set
// while it waits on subagents it started: since when (its last turn's end),
// and how many still ran at the last count. `notes`
// are its thinking blocks that carried text, oldest first; `summarized`
// counts the ones an update has read, and `seen` the ones Haiku has read,
// an update or a WAIT; `dropped` counts the notes dropped from the front past
// the cap, all turn long (absent is none), so a request's place in the notes
// outlives the trimming; `actions` are its tool calls and `said` the text
// Claude wrote to the person, oldest first; `entries` are the updates,
// oldest first. `durationMs` is set once the turn ended; `failure` says why
// the latest request gave no update; `waitingFor` is what Haiku said it
// waits for at its last WAIT ('' when it did not say), until an update
// comes. A change that values kept before it no longer fit bumps the atom's
// shape tag; an optional field added needs none.
export type Thinking = {
  turnId: string
  lastTurnId?: string
  request: string
  startedAt: number
  durationMs?: number
  isAborted?: boolean
  paused?: { at: number; subagents: number }
  notes: TurnMark[]
  summarized: number
  seen: number
  dropped?: number
  actions: TurnMark[]
  said: TurnMark[]
  entries: ThinkingEntry[]
  isSummarizing: boolean
  failure?: string
  waitingFor?: string
}

// One of the person's recent turns, as the wide layout lists them: the turn
// a prompt of theirs began, with every turn that went on with it, grouped as
// `Thinking` groups them, `turnId` the first one's id. When it began, how
// long it ran once it ended, whether it was interrupted or waits on its
// subagents; the context's fill where it began (absent where not known, as
// right after a compaction) and as last measured while it was the newest;
// the tool calls made while it ran, its subagents' included; and its
// summary's updates, the newest of them as the pane draws them. A change
// that values kept before it no longer fit bumps the atom's shape tag.
export type RecentTurn = {
  turnId: string
  startedAt: number
  durationMs?: number
  isAborted?: true
  isWaiting?: true
  fromTokens?: number
  toTokens?: number
  tools: number
  entries: ThinkingEntry[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-weather': {
      reading: Reading | null
      samples: Sample[]
      // How many tokens the last turn added to the window; negative after a
      // compaction. Null until a turn has ended since the mod loaded.
      delta: number | null
      // The account's windows as last reported; empty off a subscription,
      // where no window has a reading.
      limits: Limit[]
      // This session's part of each window's spend, as last counted; empty
      // off a subscription, or until counted.
      shares: Share[]
      // Tool calls since the main loop's turn began.
      turnTools: number
      // The main loop's subagents at work, and those that ended since the
      // person's prompt, as last listed, oldest first; empty while there are
      // none, or until listed.
      subagents: Subagent[]
      // What each subagent of `subagents` did, taken in at most once a second
      // while they work; one row where its requests or tool calls were seen.
      subagentFigures: SubagentFigures[]
      lastTurn: LastTurn | null
      // Null until read, or where the engine gave no breakdown.
      autoCompact: AutoCompact | null
      // What fills the context, largest first, the rest folded into the last
      // row; read with `autoCompact`. Null until read, where the engine gave
      // no breakdown, or after a compaction until read again.
      fills: Fill[] | null
      // The session's cost in US dollars at API prices; null where the host
      // keeps no ledger.
      cost: number | null
      // Null until the session starts while the mod is loaded, and from a
      // /clear until read again.
      facts: Facts | null
      // Null until the session starts while the mod is loaded, and from a
      // /clear until counted again.
      compactions: Compactions | null
      // Null until the main loop starts a turn while the mod is loaded.
      // Shaped: a turn an earlier version kept in another shape is declined.
      thinking: Shaped<Thinking | null>
      // The person's last few turns, oldest first, the newest the one under
      // way or last ended; from the first the mod saw begin, and from a
      // /clear on. Shaped as `thinking` is.
      recentTurns: Shaped<RecentTurn[]>
      // The turn of `recentTurns` whose updates the wide layout shows, by its
      // id; null for the newest, which a new prompt picks again.
      pickedTurn: string | null
      // Whether the person keeps this session's recent turns, and its count
      // of compactions, past a restart of Claude Code: saved to a file of the
      // session's own and read back when it starts again. Off unless they
      // turn it on.
      isSaving: boolean
      // Whether the thinking summary runs; the person turns it off and on.
      isSummaryOn: boolean
      // What the summary's Haiku requests cost this session, in US dollars:
      // a part of the session's cost, which the engine counts them in.
      summaryCost: number
      // Where the updates' window stands, the newest at 0: the line on top
      // (lines scrolled past), and how many rows of it are above the window.
      summaryPlace: { line: number; row: number }
      // The earlier updates the desktop pane shows opened, each as
      // `<turnId>:<when it was written>`; the next prompt starts it over.
      openUpdates: string[]
      // Whether each Haiku request of the summary, and its reply, goes to the
      // debug log; the person turns it on and off.
      isDebugOn: boolean
    }
  }
}
