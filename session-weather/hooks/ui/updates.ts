// The updates as the pane lays them out, and the turn picked to show.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { RecentTurn, Thinking } from '../../types'
import { RECENT_TURNS_SHAPE, THINKING_SHAPE } from '../atoms'
import { shownText, updateLines } from '../entries'
import type { UpdateLine } from '../entries'
import { formatDelta, formatDuration, formatTime, plural } from '../format'

const thinking = atom({ plugin: 'session-weather', key: 'thinking' } as const, null, { shape: THINKING_SHAPE })
const recentTurns = atom({ plugin: 'session-weather', key: 'recentTurns' } as const, [], { shape: RECENT_TURNS_SHAPE })
const pickedTurn = atom({ plugin: 'session-weather', key: 'pickedTurn' } as const, null)
const summaryPlace = atom({ plugin: 'session-weather', key: 'summaryPlace' } as const, { line: 0, row: 0 })
const subagentTop = atom({ plugin: 'session-weather', key: 'subagentTop' } as const, 0)
const toolTop = atom({ plugin: 'session-weather', key: 'toolTop' } as const, 0)

// A pane body this tall pins the weather and scrolls the updates in a window
// of their own under it; a shorter one (the terminal's inline pane) scrolls
// whole, as the engine does.
export const MIN_PINNED_ROWS = 24

// Where the rows of `text` would start, wrapped at `width` characters at
// spaces where it can. The surface wraps the lines itself, using all the
// width it has; these rows only measure how far a step goes, and where a
// line shown from part-way begins.
const rowStarts = (text: string, width: number) => {
  const starts = [0]
  let rowStart = 0
  let at = 0

  while (at < text.length) {
    const space = text.indexOf(' ', at)
    const wordEnd = space === -1 ? text.length : space

    if (wordEnd - rowStart <= width) {
      at = wordEnd + 1
      continue
    }

    // The word does not fit on this row: it starts the next one, or, a word
    // longer than a row, is cut.
    rowStart = at > rowStart ? at : rowStart + width
    starts.push(rowStart)
    at = rowStart
  }

  return starts
}

// One row of the updates, as the steps count them: the line it is part of,
// and the character of the line's shown text it starts at.
type UpdateRow = { line: number; start: number }

// The lines' rows at `width`, and the row each line starts on.
const updateRows = (lines: readonly UpdateLine[], width: number) => {
  const rows: UpdateRow[] = []
  const starts: number[] = []

  lines.forEach((line, at) => {
    starts.push(rows.length)

    for (const start of rowStarts(shownText(line), width)) {
      rows.push({ line: at, start })
    }
  })

  return { rows, starts }
}

// How many characters a row of the pane holds, roughly: its cells less one,
// and on the desktop a seventh more, its face being narrower than the cells
// the pane is measured in. What the arrows step through.
const DESKTOP_FACE = 1.15

const faceOf = (surface: string) => (surface === 'terminal' ? 1 : DESKTOP_FACE)

export const widthOf = (columns: number, surface: string) => Math.max(10, Math.round((columns - 1) * faceOf(surface)))

// From WIDE_FROM columns the pane lays out in two, as a page does on a wide
// screen: the weather in a column of its own on the left, the thinking
// summary beside it with the rest of the width and the body's whole height.
// Narrower, or with the summary off, they stand one above the other.
export const WIDE_FROM = 90
export const COLUMN_GAP = 2
// The weather's column holds its longest usual line on one row: "Week 74% ·
// this session <1% · reset in 20h 37m".
export const WEATHER_CHARS = 46

export const weatherColumns = (surface: string) => Math.ceil(WEATHER_CHARS / faceOf(surface)) + 1

// Rows a click on an arrow moves the window: about half of it, so a long
// history reads in a few clicks. The window is the body less what stands
// above and below it: in one column the weather, the summary's header and
// its footer, about PANE_OVERHEAD rows; beside the weather, the header and
// the footer alone, about WIDE_OVERHEAD. Never less than ROW_STEP.
const ROW_STEP = 3
export const PANE_OVERHEAD = 20
export const WIDE_OVERHEAD = 6

export const pageStep = (bodyRows: number, overhead: number) => Math.max(ROW_STEP, Math.floor((bodyRows - overhead) / 2))

// The row standing at the top of the window: the line it is in, and how many
// of that line's rows are above it.
const topRow = (starts: readonly number[], rowCount: number, line: number, within: number) => {
  const first = starts[line] ?? 0
  const lineRows = (starts[line + 1] ?? rowCount) - first

  return first + Math.max(0, Math.min(within, lineRows - 1))
}

// The updates' window over the turn at `width`: the lines, their rows, the
// row each line starts on, and the row standing on top (0 with no rows).
const layUpdates = (turn: Thinking | null, width: number, place: { line: number; row: number }) => {
  const lines = turn === null ? [] : updateLines(turn)
  const { rows, starts } = updateRows(lines, width)
  const top = rows.length === 0 ? 0 : topRow(starts, rows.length, Math.min(place.line, lines.length - 1), place.row)

  return { lines, rows, starts, top }
}

// Moves the updates' window `by` rows (negative toward the newest), within
// the shown turn's rows at the `width` the pane was drawn at: beside the
// weather (`isWide`) the turn picked from the list. The place is kept as a
// line and the rows into it, so an update added on top, or another width,
// keeps the reader where they were.
export async function moveUpdates ($: EngineInterface, by: number, width: number, isWide: boolean) {
  const current = await read($, thinking)
  const shown = isWide ? shownTurnOf(current, await read($, pickedTurn), await read($, recentTurns)).turn : current
  const { rows, starts, top } = layUpdates(shown, width, await read($, summaryPlace))
  const to = Math.max(0, Math.min(rows.length - 1, top + by))

  // At either end (or with no rows) a held arrow keeps asking: nothing to
  // write, nothing to draw.
  if (to === top) return

  const line = rows[to]?.line ?? 0
  await update($, summaryPlace, () => ({ line, row: to - (starts[line] ?? 0) }))
}

export async function toNewest ($: EngineInterface) {
  const place = await read($, summaryPlace)

  if (place.line !== 0 || place.row !== 0) await update($, summaryPlace, () => ({ line: 0, row: 0 }))
}

// A line of the updates as the window shows it: its kind; its text as the
// terminal draws it, its mark leading (★, ?, →); its words as the desktop
// draws them, by an icon in place of the mark; and whether it is shown from
// part-way, `… ` leading both, where the desktop draws no icon.
type ShownLine = { kind: UpdateLine['kind']; text: string; words: string; isCut: boolean }

// The updates' window over `turn`, its lines measured `width` characters a
// row, standing at `place`: the lines showing, the first from the row on top
// and, where the window is pinned, a body's `rows` of them at most (else
// all), kept together by update, each opening with its gist; how many
// updates' gists are scrolled past, above the window; and whether there is
// anything to scroll. The terminal's pane and the desktop's card draw it.
export const windowOf = (
  turn: Thinking | null,
  width: number,
  place: { line: number; row: number },
  isPinned: boolean,
  rows: number,
) => {
  const { lines, ...laid } = layUpdates(turn, width, place)
  const top = isPinned ? laid.top : 0
  const topLine = laid.rows[top]?.line ?? 0
  const topChar = laid.rows[top]?.start ?? 0
  const newer = laid.starts.filter((first, at) => lines[at]?.kind === 'gist' && first < top).length
  const shown: ShownLine[][] = []
  let budget = isPinned ? rows : Number.POSITIVE_INFINITY

  for (let at = topLine; at < lines.length && budget > 0; at += 1) {
    const one = lines[at]

    if (one === undefined) break

    const isCut = at === topLine && topChar > 0
    const text = isCut ? `… ${shownText(one).slice(topChar)}` : shownText(one)
    const group = shown.at(-1)
    const item = { kind: one.kind, text, words: isCut ? text : one.text, isCut }

    if (group === undefined || one.kind === 'gist') shown.push([item])
    else group.push(item)

    budget -= (laid.starts[at + 1] ?? laid.rows.length) - (laid.starts[at] ?? 0)
  }

  return { shown, newer, canScroll: isPinned && laid.rows.length > 1 }
}

// "14:32 · 2m 14s · ▲ +9.7k · 18 tools": a recent turn's row. When it began,
// how long it ran (the newest: that it runs, or waits on its subagents), the
// tokens it added to the context, its tool calls, and whether it was
// interrupted; a part not known left out.
export const recentLine = (one: RecentTurn, isNewest: boolean) =>
  [
    formatTime(one.startedAt),
    one.durationMs !== undefined
      ? formatDuration(one.durationMs)
      : isNewest && one.isAborted !== true
        ? one.isWaiting === true
          ? 'waiting'
          : 'running'
        : null,
    one.fromTokens === undefined || one.toTokens === undefined ? null : formatDelta(one.toTokens - one.fromTokens),
    plural(one.tools, 'tool'),
    one.isAborted === true ? 'interrupted' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

// A turn of the list as the summary draws one: its updates, when it began,
// how long it ran and how it ended.
const pastTurnOf = (one: RecentTurn): Thinking => ({
  turnId: one.turnId,
  request: '',
  startedAt: one.startedAt,
  ...(one.durationMs === undefined ? {} : { durationMs: one.durationMs }),
  ...(one.isAborted === true ? { isAborted: true } : {}),
  notes: [],
  summarized: 0,
  seen: 0,
  actions: [],
  said: [],
  entries: one.entries,
  isSummarizing: false,
})

// The turn whose updates the summary shows beside the weather: the one
// picked from the list while it is still listed, else the current one.
export const shownTurnOf = (current: Thinking | null, picked: string | null, recent: readonly RecentTurn[]) => {
  const one = picked === null || picked === current?.turnId ? undefined : recent.find(row => row.turnId === picked)

  return one === undefined ? { turn: current, isPast: false } : { turn: pastTurnOf(one), isPast: true }
}

// The person presses a turn of the list: its updates show, from the newest.
// The current one is picked as null, so that the next prompt's follows.
export async function pickTurn ($: EngineInterface, turnId: string | null) {
  await update($, pickedTurn, () => turnId)
  await update($, subagentTop, () => 0)
  await update($, toolTop, () => 0)
  await toNewest($)
}
