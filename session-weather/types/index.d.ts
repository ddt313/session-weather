// The live window's fill; `tokens` and `percent` are absent right after a
// compaction, until the next response reports them. `isCompacted` marks the
// reading a compaction left, whose drop is the change shown.
export type Reading = { tokens?: number; window: number; percent?: number; isCompacted?: true }

// The window's fill where the main loop's turn began: the turn before's end.
export type Sample = { tokens: number; percent: number }

// One of the account's rate-limit windows as the engine reports it: which
// one, its share used, and when it resets (ISO 8601).
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The main loop's last finished turn: how long it ran, how many tool calls
// it made (its subagents' included), and the share of its input the prompt
// cache served, when it reported usage.
export type LastTurn = { durationMs: number; tools: number; cacheRate?: number; isAborted: boolean }

// When the engine compacts on its own: at `threshold` tokens, or not at all.
export type AutoCompact = { threshold?: number; isEnabled: boolean }

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

// The main loop's current or last turn, as the summary follows it. `notes`
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
  request: string
  startedAt: number
  durationMs?: number
  isAborted?: boolean
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
      // Tool calls since the main loop's turn began.
      turnTools: number
      lastTurn: LastTurn | null
      // Null until read, or where the engine gave no breakdown.
      autoCompact: AutoCompact | null
      // The session's cost in US dollars at API prices; null where the host
      // keeps no ledger.
      cost: number | null
      // Null until the main loop starts a turn while the mod is loaded.
      // Shaped: a turn an earlier version kept in another shape is declined.
      thinking: Shaped<Thinking | null>
      // Whether the thinking summary runs; the person turns it off and on.
      isSummaryOn: boolean
      // What the summary's Haiku requests cost this session, in US dollars:
      // the engine leaves them out of the session's cost.
      summaryCost: number
      // Where the updates' window stands, the newest at 0: the line on top
      // (lines scrolled past), and how many rows of it are above the window.
      summaryPlace: { line: number; row: number }
      // Whether each Haiku request of the summary, and its reply, goes to the
      // debug log; the person turns it on and off.
      isDebugOn: boolean
    }
  }
}
