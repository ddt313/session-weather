// The live window's fill; `tokens` and `percent` are absent right after a
// compaction, until the next response reports them. `isCompacted` marks the
// reading a compaction left, whose drop is the change shown.
export type Reading = { tokens?: number; window: number; percent?: number; isCompacted?: true }

// The window's fill at the end of one turn.
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
// before, and what it says comes next. `isRecap` marks the one written
// after the turn ended, over the whole turn.
export type ThinkingEntry = { at: number; gist: string; decisions: string[]; next?: string; isRecap?: true }

// The main loop's current or last turn, as the summary follows it. `notes`
// are its thinking blocks that carried text, oldest first; `summarized`
// counts the ones an update has read; `entries` are the updates, oldest
// first. `durationMs` is set once the turn ended; `failure` says why the
// latest request gave no update.
export type Thinking = {
  turnId: string
  request: string
  startedAt: number
  durationMs?: number
  isAborted?: boolean
  notes: string[]
  summarized: number
  entries: ThinkingEntry[]
  isSummarizing: boolean
  failure?: string
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
      // Shaped: a turn kept by the version that showed a single summary is
      // declined.
      thinking: Shaped<Thinking | null>
      // Whether the thinking summary runs; the person turns it off and on.
      isSummaryOn: boolean
      // What the summary's Haiku requests cost this session, in US dollars:
      // the engine leaves them out of the session's cost.
      summaryCost: number
      // How many lines of the turn's updates the person scrolled past, the
      // newest at 0: the updates scroll in their own window.
      summaryScroll: number
    }
  }
}
