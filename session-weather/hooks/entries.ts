// The thinking summary's updates: their lines, how many a turn keeps.

import type { Thinking, ThinkingEntry } from '../types'
import { formatDuration, plural } from './format'

// A turn keeps up to MAX_TURN_ENTRIES updates, every one of them for its
// log; the pane draws the newest MAX_ENTRIES.
export const MAX_TURN_ENTRIES = 1_000
export const MAX_ENTRIES = 100
export const EARLIER_UPDATES = 8
export const MAX_DECISIONS = 2
export const MAX_RECAP_DECISIONS = 3
export const MAX_ASSUMPTIONS = 2

// "1m 5s" into the turn.
export const intoTurn = (turn: Thinking, at: number) => formatDuration(Math.max(0, at - turn.startedAt))

// Where a turn stands that waits on its subagents: "waiting for 2
// subagents", or, the last of them ended and its result not yet in,
// "waiting".
export const waitingFor = (subagents: number) => (subagents > 0 ? `waiting for ${plural(subagents, 'subagent')}` : 'waiting')

// One line of an update: its gist, a decision, an assumption, or its next
// step.
export type UpdateLine = { kind: 'gist' | 'decision' | 'assumption' | 'next'; text: string }

// An update's lines, in the order the pane, the prompt and the log all give
// them.
export const partsOf = (one: Update): UpdateLine[] => [
  { kind: 'gist', text: one.gist },
  ...one.decisions.map(text => ({ kind: 'decision' as const, text })),
  ...one.assumptions.map(text => ({ kind: 'assumption' as const, text })),
  ...(one.next === undefined ? [] : [{ kind: 'next' as const, text: one.next }]),
]

// What an update's gist opens with in the pane and the log: Recap, or its
// time into the turn.
export const stampOf = (turn: Thinking, entry: ThinkingEntry) => (entry.isRecap ? 'Recap' : intoTurn(turn, entry.at))

// The turn's updates as the window scrolls over them, newest first: the
// newest MAX_ENTRIES.
export const updateLines = (turn: Thinking): UpdateLine[] =>
  turn.entries.slice(-MAX_ENTRIES).reverse().flatMap(entry => {
    const stamp = stampOf(turn, entry)

    return partsOf(entry).map(line => (line.kind === 'gist' ? { ...line, text: `${stamp} · ${line.text}` } : line))
  })

// What each kind of line opens with: ★ a decision, ? an assumption, → the
// next step.
const MARKS = { gist: '', decision: '★ ', assumption: '? ', next: '→ ' } as const

export const shownText = (line: UpdateLine) => `${MARKS[line.kind]}${line.text}`

export type Update = Pick<ThinkingEntry, 'gist' | 'decisions' | 'assumptions' | 'next'>
