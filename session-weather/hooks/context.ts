// The context: its fill by category, the session's facts and compactions.

import { atom, update } from 'claude-code'
import type { ContextCategory, EngineInterface } from 'claude-code'
import type { AutoCompact, Compactions, Facts, Fill } from '../types'
import { clip, formatCost, formatTime, formatTokens, modelNameOf, plural } from './format'
import { formatPart } from './limits'

const autoCompact = atom({ plugin: 'session-weather', key: 'autoCompact' } as const, null)
const fills = atom({ plugin: 'session-weather', key: 'fills' } as const, null)
const facts = atom({ plugin: 'session-weather', key: 'facts' } as const, null)
const compactions = atom({ plugin: 'session-weather', key: 'compactions' } as const, null)

// The rows of what fills the context the wide layout shows: the largest,
// and past them the rest in one.
const FILL_ROWS = 5
export const REST = 'Other'

// What fills the context, from the breakdown's rows of content in use (never
// the free space, the compaction buffer or tools loaded on demand): largest
// first, FILL_ROWS rows at most, the last of them the rest folded together.
const fillsOf = (categories: readonly ContextCategory[]): Fill[] => {
  const used = categories
    .filter(row => row.kind === 'used' && row.tokens > 0)
    .map(({ name, tokens }) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  if (used.length <= FILL_ROWS) return used

  const rest = used.slice(FILL_ROWS - 1).reduce((sum, row) => sum + row.tokens, 0)

  return [...used.slice(0, FILL_ROWS - 1), { name: REST, tokens: rest }]
}

// What the window's breakdown says: where the engine compacts on its own,
// what fills the context, and the main loop's model; each null where the
// engine gave none. The `summary` breakdown is estimated locally and sends
// no request.
export async function readBreakdown ($: EngineInterface) {
  try {
    const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown

    if (breakdown === undefined) return { compactAt: null, fills: null, model: null }

    return {
      compactAt: { threshold: breakdown.autoCompactThreshold, isEnabled: breakdown.isAutoCompactEnabled },
      fills: Array.isArray(breakdown.categories) ? fillsOf(breakdown.categories) : null,
      model: typeof breakdown.model === 'string' && breakdown.model !== '' ? breakdown.model : null,
    }
  } catch {
    return { compactAt: null, fills: null, model: null }
  }
}

// What a breakdown read keeps: where the engine compacts, what fills the
// context, and the model on the session's line.
export async function keepBreakdown (
  $: EngineInterface,
  { compactAt, fills: filled, model }: Awaited<ReturnType<typeof readBreakdown>>,
) {
  await update($, autoCompact, () => compactAt)
  await update($, fills, () => filled)

  if (model !== null) await update($, facts, one => (one === null || one.model === model ? one : { ...one, model }))
}

// "├ Messages 52.1k · 26%": a row of what fills the context, its share of the
// window, on a branch of a tree, the last row's (`isLast`) closing it: the
// rows read as parts of the fill above them, not lines of their own. Glyphs,
// not spaces, which a surface may fold away.
export const fillLine = (fill: Fill, window: number, isLast: boolean) =>
  `${isLast ? '└' : '├'} ${fill.name} ${formatTokens(fill.tokens)} · ${formatPart((fill.tokens / window) * 100)}`

// The prompts the person has sent this session, as the engine counts them;
// null where it cannot say.
async function readTurns ($: EngineInterface) {
  try {
    const turns = await $.session.turns()

    return Number.isFinite(turns) ? turns : null
  } catch {
    return null
  }
}

// The engine's count of prompts read again, kept where it moved.
export async function recountTurns ($: EngineInterface) {
  const turns = await readTurns($)

  if (turns !== null) await update($, facts, one => (one === null || one.turns === turns ? one : { ...one, turns }))
}

// The session as its line tells it, read anew: when it began and how many
// prompts it has had, the model kept. Its compactions start counting where
// none are counted yet: all of them in a session with no prompt so far,
// else those from here on.
export async function readFacts ($: EngineInterface) {
  const [{ startedAt }, turns] = await Promise.all([$.session.usage(), readTurns($)])

  await update($, facts, one => ({
    startedAt,
    ...(turns === null ? {} : { turns }),
    ...(one?.model === undefined ? {} : { model: one.model }),
  }))
  await update($, compactions, one => one ?? { count: 0, isWhole: turns === 0 })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

// "since 09:12", the host's time, for a session begun today; "since Nov 14"
// for one begun before. A time the session began, not how long it has run:
// that would go stale while the pane waits undrawn between turns.
const sinceOf = (startedAt: number, now: number) => {
  const began = new Date(startedAt)
  const isToday = began.toDateString() === new Date(now).toDateString()

  return `since ${isToday ? formatTime(startedAt) : `${MONTHS[began.getMonth()]} ${began.getDate()}`}`
}

// "2 compactions"; "2+ compactions" where the mod loaded into the session
// under way, and may have missed some before; none where none were counted.
const compactionsOf = (counted: Compactions | null) => {
  if (counted === null || counted.count === 0) return null

  return counted.isWhole ? plural(counted.count, 'compaction') : `${counted.count}+ compactions`
}

// The session in a few parts, for its line: its model, since when it runs,
// the prompts sent it, its compactions and its cost; a part not known, or
// none yet, left out.
export const sessionParts = (known: Facts | null, counted: Compactions | null, spent: number | null, now: number) =>
  [
    known?.model === undefined ? null : modelNameOf(known.model),
    known === null ? null : sinceOf(known.startedAt, now),
    known?.turns === undefined || known.turns === 0 ? null : plural(known.turns, 'turn'),
    compactionsOf(counted),
    spent === null ? null : formatCost(spent),
  ].filter((part): part is string => part !== null)

// Parts joined by " · " into rows of `chars` at most, a part that does not
// fit on a row starting the next, and a part longer than a row cut.
export const packRows = (parts: readonly string[], chars: number) => {
  const rows: string[] = []

  for (const part of parts) {
    const last = rows.at(-1)

    if (last !== undefined && last.length + 3 + part.length <= chars) rows[rows.length - 1] = `${last} · ${part}`
    else rows.push(part)
  }

  return rows.map(row => clip(row, chars))
}

// "auto-compact at 92% · 920k" in a window of `window` tokens, or that it is
// off; null where the engine has not said.
export const compactLineOf = (compactAt: AutoCompact | null, window: number) => {
  if (compactAt === null) return null
  if (!compactAt.isEnabled) return 'auto-compact off'
  if (compactAt.threshold === undefined) return null

  return `auto-compact at ${Math.round((compactAt.threshold / window) * 100)}% · ${formatTokens(compactAt.threshold)}`
}
