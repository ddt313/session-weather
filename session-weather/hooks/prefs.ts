// What the store keeps for the pane across sessions: the summary off, the
// debug log on, the folded cards.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { storedLimits } from './limits'

const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const isSummaryOn = atom({ plugin: 'session-weather', key: 'isSummaryOn' } as const, true)
const foldedCards = atom({ plugin: 'session-weather', key: 'foldedCards' } as const, [])
const isDebugOn = atom({ plugin: 'session-weather', key: 'isDebugOn' } as const, false)

// Set when the person turns the summary off, so later sessions keep it off.
export const STORED_SUMMARY_OFF = 'isSummaryOff'
// Set while the person keeps the summary's debug log on, in later sessions
// too.
export const STORED_DEBUG_ON = 'isDebugOn'
// The desktop's cards the person folded, in later sessions too; and the
// cards that fold, by the names it keeps.
const STORED_FOLDED = 'foldedCards'
// `narrowTurns` is the other way about: under WIDE_FROM columns the recent
// turns stand folded unless the person opened them, which it marks.
const FOLDING = ['context', 'limits', 'turns', 'subagents', 'tools', 'thinking', 'narrowTurns'] as const
export type Folding = (typeof FOLDING)[number]
// The address of the Button that turns it off and on.
export const TOGGLE = 'summary-toggle'
// The address of the Button that saves the session's recent turns.
export const SAVE_TOGGLE = 'save-turns'

// A card folded to its top line, or opened again, by the person's press: in
// the store too, the names in FOLDING's order.
export async function foldCard ($: EngineInterface, name: Folding) {
  const was = await read($, foldedCards)
  const folded = FOLDING.filter(one => (one === name ? !was.includes(one) : was.includes(one)))

  await update($, foldedCards, () => folded)
  await $.store.set(STORED_FOLDED, folded)
}

// What the store keeps for the pane: the person's choices (the summary off,
// the debug log on) and the last limits read. `$.state` holds them while the
// session runs, but a /clear wipes it and starts no session.start: each
// main-loop turn's start reads them again, as does the end of a /clear, so a
// summary the person turned off stays off. Resolves whether it is on.
export async function restore ($: EngineInterface) {
  const [isOff, isDebugging, wasOn, wasDebugging, shown, folded, wasFolded] = await Promise.all([
    $.store.get(STORED_SUMMARY_OFF).then(value => value === true),
    $.store.get(STORED_DEBUG_ON).then(value => value === true),
    read($, isSummaryOn),
    read($, isDebugOn),
    read($, limits),
    $.store.get(STORED_FOLDED).then(value =>
      Array.isArray(value) ? FOLDING.filter(name => (value as unknown[]).includes(name)) : [],
    ),
    read($, foldedCards),
  ])

  if (wasOn === isOff) await update($, isSummaryOn, () => !isOff)
  if (wasDebugging !== isDebugging) await update($, isDebugOn, () => isDebugging)
  if (folded.join() !== wasFolded.join()) await update($, foldedCards, () => folded)

  if (shown.length === 0) {
    const known = await storedLimits($)

    if (known.length > 0) await update($, limits, () => known)
  }

  return !isOff
}
