// The status line and the pane's glance at the session.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AutoCompact, Limit, Reading, Thinking } from '../types'
import { stampOf } from './entries'
import { forecast, formatCost, plural } from './format'
import { formatLeft, levelOf, liveWindows } from './limits'
import { PANE, PANE_ROWS, TITLE } from './settings'
import { WIDE_FROM } from './ui/updates'
import { workingOf } from './turns'

const reading = atom({ plugin: 'session-weather', key: 'reading' } as const, null)
const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const autoCompact = atom({ plugin: 'session-weather', key: 'autoCompact' } as const, null)
const cost = atom({ plugin: 'session-weather', key: 'cost' } as const, null)

// What the countdowns read now; the pane is drawn again only when it
// changes. The module's own, so a reload redraws once.
let counted: string | null = null

export async function recount ($: EngineInterface) {
  const text = liveWindows(await read($, limits), await $.clock.now())
    .map(window => (window.left === undefined ? window.name : `${window.name} ${formatLeft(window.left)}`))
    .join(' · ')

  if (text !== counted) {
    counted = text
    $.ui.invalidate('ui.render')
  }
}

// The surface the session started on, for the pane's open.
let startedOn: string | null | undefined

export const setStartedOn = (surface: string | null | undefined) => {
  startedOn = surface
}

// In the terminal, docked beside the transcript, the pane asks to open
// WIDE_FROM columns wide, for the weather and the summary side by side; the
// terminal holds a dock to 45% of its width, and a width the person set wins.
// Elsewhere it asks for no width: the desktop lays its pane out itself.
export function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, rows: PANE_ROWS, ...(startedOn === 'terminal' ? { columns: WIDE_FROM } : {}) })
}

// "☁ 42% · 5h 30% (4h 38m) · $1.23 · 2 subagents": the weather's key figures
// in one line, for the status line under the prompt. The sky (how far the
// fill has come toward compaction, as the pane's) and the context's share
// used, the 5-hour window's share used and the time until it resets, the
// session's cost, and how many subagents the main loop started are at work.
// A part with nothing read yet is left out rather than shown as zero: the
// fill before the first response or right after a compaction, the window off
// a subscription or past its reset, a cost with no ledger or nothing spent,
// no subagent at work. Undefined where no part has a reading.
const statusTextOf = (
  now: Reading | null,
  compactAt: AutoCompact | null,
  readings: readonly Limit[],
  spent: number | null,
  working: number,
  at: number,
) => {
  const tokens = now?.tokens
  const percent = now?.percent
  const fiveHour = liveWindows(readings, at).find(window => window.kind === 'five_hour')
  const left = fiveHour?.left
  const parts = [
    tokens === undefined || percent === undefined
      ? null
      : `${forecast(levelOf(tokens, percent, compactAt)).icon} ${percent}%`,
    fiveHour === undefined
      ? null
      : `${fiveHour.name} ${fiveHour.used}%${left === undefined || Number.isNaN(left) ? '' : ` (${formatLeft(left)})`}`,
    spent === null || spent <= 0 ? null : formatCost(spent),
    working > 0 ? plural(working, 'subagent') : null,
  ].filter((part): part is string => part !== null)

  return parts.length === 0 ? undefined : parts.join(' · ')
}

// The pane minimized to a widget on the desktop app, where a glance is all
// it gets: "☁ Cloudy · 42%", the sky and the context's share used; "5h 30% ·
// Week 74% · $1.23", the windows' shares and the session's cost; and the
// newest update of the thinking summary while it is on. A part with nothing
// read yet is left out, as on the status line; null where a line has none.
export const glanceOf = (
  now: Reading | null,
  compactAt: AutoCompact | null,
  readings: readonly Limit[],
  spent: number | null,
  at: number,
  turn: Thinking | null,
) => {
  const tokens = now?.tokens
  const percent = now?.percent
  const sky = tokens === undefined || percent === undefined ? null : forecast(levelOf(tokens, percent, compactAt))
  const figures = [
    ...liveWindows(readings, at).map(window => `${window.name} ${window.used}%`),
    ...(spent === null || spent <= 0 ? [] : [formatCost(spent)]),
  ]
  const newest = turn?.entries.at(-1)

  return {
    sky:
      sky !== null && percent !== undefined
        ? { text: `${sky.icon} ${sky.label} · ${percent}%`, color: sky.color }
        : now?.isCompacted
          ? { text: '☀ Compacted', color: 'warning' }
          : null,
    figures: figures.length === 0 ? null : figures.join(' · '),
    update: turn === null || newest === undefined ? null : `${stampOf(turn, newest)} · ${newest.gist}`,
  }
}

// What the status line holds, as this module last set it; null until it sets
// one, so a reload sets it again over whatever the old module left.
let statusShown: { text: string | undefined } | null = null
// The line is worked out and set one call at a time, in order: a look at the
// panes taken before the pane was placed never lands after one taken since.
let statusQueue: Promise<unknown> = Promise.resolve()

const inStatusOrder = (work: () => Promise<void> | void) => {
  const run = statusQueue.then(work)
  statusQueue = run.catch(() => {})

  return run
}

// Pins `text` as the status line, undefined removing it; only a change
// reaches the engine.
function setStatus($: EngineInterface, text: string | undefined) {
  if (statusShown !== null && statusShown.text === text) return

  $.ui.status(text)
  statusShown = { text }
}

// The status line as it should stand now: the weather's figures while the
// pane is not drawn (the person closed it, or it waits undrawn on a terminal
// too narrow to place it unasked), none while it is, where the pane says it
// all. The engine's record of the panes says which. Called wherever what the
// line shows may have changed: a reading, a compaction, a /clear, the minute
// that moves the countdown, the pane opened or closed, a subagent started or
// ended.
export function showStatus($: EngineInterface) {
  return inStatusOrder(async () => {
    const [panes, now, compactAt, readings, spent, listed, at] = await Promise.all([
      $.ui.panes(),
      read($, reading),
      read($, autoCompact),
      read($, limits),
      read($, cost),
      read($, subagents),
      $.clock.now(),
    ])
    const isDrawn = panes.some(pane => pane.id === PANE && pane.isPlaced)

    setStatus($, isDrawn ? undefined : statusTextOf(now, compactAt, readings, spent, workingOf(listed), at))
  })
}

// The pane being drawn, as when a widened terminal places it: the line goes,
// after any look at the panes already under way.
export function hideStatus($: EngineInterface) {
  return inStatusOrder(() => setStatus($, undefined))
}
