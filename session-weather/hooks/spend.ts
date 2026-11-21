// The cost of the session, and the share of the plan's limits it spent,
// from the spend files of every session.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Share } from '../types'
import { fileNameOf, joinPath, modFolder, sessionFile } from './files'
import { MINUTE } from './format'
import { liveWindows, WINDOWS } from './limits'

const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const shares = atom({ plugin: 'session-weather', key: 'shares' } as const, [])

// This session's part of each rate-limit window. The engine reports a
// window's share used for the whole account, and never what used it: each
// session writes what it spends, at API prices, to a file of its own, and
// this session's part of a window is its spend there over what every
// session's file spent there, times the window's share. Spend the files do
// not see (claude.ai, another computer, a session without the mod) counts
// toward the sessions here in proportion.
export const SPEND_FOLDER = ['session-weather', 'spend'] as const

// A stretch of spend, spread evenly over it: from and to (ms since the
// epoch), and US dollars. Each minute a session spent in is one; what it
// spent before the mod counted it is one over its life until then.
type Span = [number, number, number]

// A session's spend file: its spans, and the session's cost, as the engine
// totals it, that they count up to (absent until a total was counted).
type SpendFile = { seen?: number; spans: Span[] }

// The longest window: a span that ended before it began counts in none, and
// is dropped as the file is written again.
const LONGEST = Math.max(...WINDOWS.map(window => window.length))

const isSpan = (value: unknown): value is Span =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(n => typeof n === 'number' && Number.isFinite(n)) &&
  value[0] < value[1] &&
  value[2] >= 0

// A spend file's text; null for one that holds none, or is not whole yet
// (its session writing it as it is read).
const parseSpend = (text: string): SpendFile | null => {
  try {
    const value = JSON.parse(text) as { seen?: unknown; spans?: unknown } | null

    if (typeof value !== 'object' || value === null || !Array.isArray(value.spans)) return null

    const { seen } = value

    return {
      ...(typeof seen === 'number' && Number.isFinite(seen) ? { seen } : {}),
      spans: value.spans.filter(isSpan),
    }
  } catch {
    return null
  }
}

// What the spans spent from `start` on: each one's part that lies past it.
const spentSince = (spans: readonly Span[], start: number) =>
  spans.reduce((sum, [from, to, usd]) => (to <= start ? sum : sum + (usd * (to - Math.max(from, start))) / (to - from)), 0)

// Dollars to the millionth, so a file holds no long fractions.
const toMillionth = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000

// The session's cost as last counted in this process, so that a session yet
// to spend writes no file; and after a /clear, the total the session before
// reached, from which a total that kept counting goes on.
export let costCounted: { sessionId: string; cost: number } | null = null
export const setCostCounted = (value: typeof costCounted) => {
  costCounted = value
}
export let costCarried: number | null = null
export const setCostCarried = (value: typeof costCarried) => {
  costCarried = value
}
// The spend files are written and read one call at a time, in order: each
// reads what the one before it wrote.
let spendQueue: Promise<unknown> = Promise.resolve()
// The spend files read, by name: when each was written and its size, and
// its spans. One is read again only once either changed, and the session's
// own after each write of its own.
const spendRead = new Map<string, { stamp: string; spans: Span[] }>()

const queued = <T,>(work: () => Promise<T>) => {
  const run = spendQueue.then(work)
  spendQueue = run.catch(() => {})

  return run
}

// Counts this session's part of each window with a reading: its spend from
// the window's start on, over what every session's file spent from there. A
// file last written before the earliest start holds nothing in any window,
// and is not read.
async function countShares ($: EngineInterface) {
  const now = await $.clock.now()
  const windows = liveWindows(await read($, limits), now).flatMap(({ kind, start }) =>
    start === undefined ? [] : [{ kind, start, own: 0, total: 0 }],
  )
  const folder = windows.length === 0 ? null : await modFolder($, SPEND_FOLDER)
  const entries = folder === null ? [] : await $.fs.list(folder).catch(() => [])
  const earliest = Math.min(...windows.map(window => window.start))
  const ownName = fileNameOf(await $.session.id(), 'json')

  for (const entry of entries) {
    if (folder === null || entry.kind !== 'file' || !entry.name.endsWith('.json')) continue

    if (entry.mtimeMs < earliest) {
      spendRead.delete(entry.name)
      continue
    }

    const stamp = `${entry.mtimeMs}:${entry.size}`

    if (spendRead.get(entry.name)?.stamp !== stamp) {
      const file = await $.fs.read(joinPath(folder, entry.name)).then(parseSpend, () => null)

      // One not whole yet counts what it held when last read whole.
      if (file !== null) spendRead.set(entry.name, { stamp, spans: file.spans })
    }

    const spans = spendRead.get(entry.name)?.spans ?? []

    for (const window of windows) {
      const spent = spentSince(spans, window.start)
      window.total += spent

      if (entry.name === ownName) window.own += spent
    }
  }

  const fresh: Share[] = windows.map(({ kind, own, total }) => ({
    kind,
    ratio: total > 0 ? Math.round((own / total) * 1000) / 1000 : 0,
  }))

  if (JSON.stringify(await read($, shares)) !== JSON.stringify(fresh)) await update($, shares, () => fresh)
}

export function recountShares($: EngineInterface) {
  return queued(() => countShares($))
}

// What the session spent since the last count: `cost`, its total as the
// engine counts it (the summary's Haiku requests among it, as a mod's
// requests are), past what its file counted already, kept in the minute it
// came; then the parts are counted again. Off a subscription no window has a
// reading, and nothing is kept.
export function addSpend($: EngineInterface, cost: number) {
  return queued(async () => {
    if ((await read($, limits)).length === 0) return

    const sessionId = await $.session.id()
    const path = await sessionFile($, SPEND_FOLDER, sessionId, 'json')

    if (path === null) return

    const now = await $.clock.now()
    const file = (await $.fs.exists(path)) ? parseSpend(await $.fs.read(path)) : null
    let spans = (file?.spans ?? []).filter(([, to]) => to > now - LONGEST)
    let seen = file?.seen ?? (costCounted?.sessionId === sessionId ? costCounted.cost : undefined)
    let added = 0

    // After a /clear the total went on from the session before's, or started
    // over.
    if (seen === undefined && costCarried !== null) seen = cost >= costCarried ? costCarried : 0

    if (seen === undefined) {
      // Counted for the first time, as in a session that ran before the mod
      // loaded: what it spent until now, spread over its life so far.
      const { startedAt } = await $.session.usage()

      if (cost > 0) spans = [...spans, [Math.min(startedAt, now - MINUTE), now, cost]]
    } else {
      // A total that went down started over.
      added = cost >= seen ? cost - seen : cost
    }

    seen = cost
    costCounted = { sessionId, cost }
    costCarried = null

    if (added > 0) {
      const from = Math.floor(now / MINUTE) * MINUTE
      const last = spans.at(-1)
      spans =
        last !== undefined && last[0] === from && last[1] === from + MINUTE
          ? [...spans.slice(0, -1), [from, from + MINUTE, last[2] + added]]
          : [...spans, [from, from + MINUTE, added]]
    }

    // A session yet to spend writes no file.
    if (file !== null || spans.length > 0) {
      const kept: SpendFile = {
        ...(seen === undefined ? {} : { seen: toMillionth(seen) }),
        spans: spans.map(([from, to, usd]) => [from, to, toMillionth(usd)]),
      }
      await $.fs.write(path, JSON.stringify(kept))
      spendRead.delete(fileNameOf(sessionId, 'json'))
    }

    await countShares($)
  })
}
