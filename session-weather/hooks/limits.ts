// The plan's usage limits: their windows, bars and pace.

import type { EngineInterface } from 'claude-code'
import type { AutoCompact, Limit } from '../types'
import { DAY, HOUR, MINUTE } from './format'

// How far the fill has come toward compaction, in percent: of the threshold
// where the engine compacts on its own (167k of a 200k window, so before 90%
// of the window), else of the window. The forecast and the toast read it;
// the bar and the share of the window stay the window's.
export const levelOf = (tokens: number, percent: number, compactAt: AutoCompact | null) =>
  compactAt?.isEnabled === true && compactAt.threshold !== undefined && compactAt.threshold > 0
    ? Math.round((tokens / compactAt.threshold) * 100)
    : percent

// 20 cells, filled to the share used.
export const bar = (percent: number) => {
  const filled = Math.max(0, Math.min(20, Math.round(percent / 5)))

  return '█'.repeat(filled) + '░'.repeat(20 - filled)
}

// The header of a block of the weather ("Usage limits", "Recent turns"): a
// step larger than its rows and heavier, still muted. The terminal has one
// size, and draws it bold.
export const BLOCK_HEADER = { dimColor: true, size: 'heading', weight: 'semibold' } as const

// This session's part of a window, in the theme's yellow.
export const MINE = 'warning'

// A window's bar split where this session's part of the share used (`mine`
// points of it) begins: the last of the filled cells, rounded as they are,
// so a part under half a cell has none.
export const barParts = (percent: number, mine: number) => {
  const filled = Math.max(0, Math.min(20, Math.round(percent / 5)))
  const own = Math.min(filled, Math.round(Math.max(0, mine) / 5))

  return { others: '█'.repeat(filled - own), own: '█'.repeat(own), free: '░'.repeat(20 - filled) }
}

// A run of a window's bar as the wide layout draws it: cells others used
// (dim), this session's part (yellow), cells free (dim), and the pace mark.
type BarRun = { kind: 'others' | 'own' | 'free' | 'mark'; text: string }

// The bar of `barParts` with the cell where `elapsed` of the window's time
// falls drawn as │: a fill that has passed the mark runs ahead of the
// window's time, one short of it behind. The runs in order, each kind's
// cells together.
export const barRuns = (percent: number, mine: number, elapsed: number): BarRun[] => {
  const { others, own, free } = barParts(percent, mine)
  const kinds: BarRun['kind'][] = [
    ...Array.from(others, () => 'others' as const),
    ...Array.from(own, () => 'own' as const),
    ...Array.from(free, () => 'free' as const),
  ]
  kinds[Math.max(0, Math.min(19, Math.floor(elapsed * 20)))] = 'mark'
  const cell = { others: '█', own: '█', free: '░', mark: '│' } as const

  return kinds.reduce<BarRun[]>((runs, kind) => {
    const last = runs.at(-1)

    if (last?.kind === kind) last.text += cell[kind]
    else runs.push({ kind, text: cell[kind] })

    return runs
  }, [])
}

// From this share of a window's time on, the pace says where the share used
// would stand at the reset: earlier, a few points over a short time say
// little.
export const PACE_FROM = 0.2

// "~84% at reset": the share used at this pace when the window resets, its
// share used over the share of its time gone; ">100% at reset" where it would
// run out first. Null before PACE_FROM, or where the reset is not known.
export const paceOf = (percent: number, elapsed: number | undefined) => {
  if (elapsed === undefined || elapsed < PACE_FROM) return null

  const projected = percent / elapsed

  return projected > 100 ? '>100% at reset' : `~${Math.round(projected)}% at reset`
}

// "8%"; "<1%" under half a point.
export const formatPart = (points: number) => (points < 0.5 ? '<1%' : `${Math.round(points)}%`)

// The account's windows as the rate-limit notices name them, in the order
// shown, and how long each runs: one began its length before its reset. The
// engine reports each one's share used and its reset, never a count of
// tokens.
export const WINDOWS = [
  { kind: 'five_hour', name: '5h', length: 5 * HOUR },
  { kind: 'seven_day', name: 'Week', length: 7 * DAY },
] as const

// The last windows any session read, kept across sessions: the engine has
// none until a session's first response, so a session just opened shows
// these until then.
export const STORED_LIMITS = 'limits'
// Set when the person closes the pane, so later sessions leave it closed
// until the command opens it again.
export const STORED_CLOSED = 'isClosed'

const isLimit = (value: unknown): value is Limit => {
  const limit = value as Partial<Limit> | null

  return (
    typeof limit === 'object' &&
    limit !== null &&
    typeof limit.kind === 'string' &&
    typeof limit.percentUsed === 'number' &&
    (limit.resetsAt === undefined || typeof limit.resetsAt === 'string')
  )
}

export async function storedLimits ($: EngineInterface) {
  const value = await $.store.get(STORED_LIMITS)

  return Array.isArray(value) ? value.filter(isLimit) : []
}

// "5d 7h", "4h 38m", "12m", "<1m".
export const formatLeft = (ms: number) => {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`

  return '<1m'
}

// The windows to show, in order: each one's share used, rounded and as read,
// the time left until its reset, and when it began and the share of its time
// gone (0 to 1), where the reset is known. Past its reset the share read
// before is stale: that window is left out until the next reading.
export const liveWindows = (readings: readonly Limit[], now: number) =>
  WINDOWS.flatMap(({ kind, name, length }) => {
    const limit = readings.find(one => one.kind === kind)

    if (limit === undefined) {
      return []
    }

    const left = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt) - now

    if (left !== undefined && left <= 0) {
      return []
    }

    const isKnown = left !== undefined && !Number.isNaN(left)
    const start = isKnown ? now + left - length : undefined
    const elapsed = isKnown ? Math.max(0, Math.min(1, 1 - left / length)) : undefined

    return [{ kind, name, used: Math.round(limit.percentUsed), percent: limit.percentUsed, left, start, elapsed }]
  })
