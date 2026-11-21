// The thinking summary at work: the ticker that asks Haiku, the live block,
// the notes and marks kept, and the turn's end.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Timer } from 'claude-code'
import type { Thinking, ThinkingEntry } from '../../types'
import { THINKING_SHAPE } from '../atoms'
import { logDebug } from '../debug'
import { MAX_DECISIONS, MAX_RECAP_DECISIONS, MAX_TURN_ENTRIES, partsOf } from '../entries'
import { messageOf } from '../files'
import { clip, plural, SECOND } from '../format'
import { previousTurn, setPreviousTurn } from '../log'
import { STORED_SUMMARY_OFF } from '../prefs'
import { isVietnamese, settings } from '../settings'
import { relistSubagents, runningSubagents } from '../subagents'
import { keepTurn, recordTurn } from '../turns'
import { isPickingDrawn } from '../ui/drawn'
import { ACTION_CHARS, askOf, clipNote, failureOf, HAIKU, haikuCost, isSilent, MAX_MARKS, MAX_NOTES, parseSummary, readUpTo, recapWait, SUMMARY_TIMEOUT, summaryGap, summaryPrompt, system } from './prompt'

const thinking = atom({ plugin: 'session-weather', key: 'thinking' } as const, null, { shape: THINKING_SHAPE })
const pickedTurn = atom({ plugin: 'session-weather', key: 'pickedTurn' } as const, null)
const isSummaryOn = atom({ plugin: 'session-weather', key: 'isSummaryOn' } as const, true)
const summaryCost = atom({ plugin: 'session-weather', key: 'summaryCost' } as const, 0)
const summaryPlace = atom({ plugin: 'session-weather', key: 'summaryPlace' } as const, { line: 0, row: 0 })
const isDebugOn = atom({ plugin: 'session-weather', key: 'isDebugOn' } as const, false)

// The summary's clockwork, the module's own: a reload starts it over.
let ticker: Timer | null = null
export let asking: AbortController | null = null
export let askedAt = Number.NEGATIVE_INFINITY
export const setAskedAt = (value: typeof askedAt) => {
  askedAt = value
}
// A due request (a turn's end, the person turning the summary on) asked for
// while another ran: it runs once that one has settled.
export let isOwed = false
export const setIsOwed = (value: typeof isOwed) => {
  isOwed = value
}
// The main-loop turn whose end still owes its last word, until its recap is
// asked, though the next prompt's turn has begun.
export let owedRecap: string | null = null
export const setOwedRecap = (value: typeof owedRecap) => {
  owedRecap = value
}
// A recap that failed (an overloaded API, a timeout, a bare WAIT) is asked
// again, `recapWait` apart, up to RECAP_RETRIES times: no tick follows a
// turn's end.
const RECAP_RETRIES = 2
let retried = { turnId: '', count: 0 }

// The main loop's thinking block still streaming: its text so far, and how
// much of it notes hold already. Null between blocks. The surface shows the
// text as it streams, so a long stretch of thinking is summarized a part at
// a time while it goes on, not only once it ends.
export let liveBlock: { turnId: string; text: string; kept: number } | null = null
export const setLiveBlock = (value: typeof liveBlock) => {
  liveBlock = value
}

// The least a part holds: a block that wrote less since the last part waits.
const LIVE_MIN_CHARS = 200

// A main-loop turn begun by a prompt of these origins goes on with the turn
// before it: a subagent's hand-back (the engine delivers it as another
// Claude session's message, `peer`), a background task's notification, a
// message of another agent. These wake Claude while the person waits on the
// work they asked for. Any other prompt, the person's own above all, starts
// a turn of its own, and the updates over.
const RESUMING: ReadonlySet<string> = new Set(['task-notification', 'peer', 'peer-send-message', 'observer'])

// The person's own prompts, typed, sent from elsewhere or stored, which
// never go on with the turn before, whatever they say.
const PROMPTED: ReadonlySet<string> = new Set([
  'composer',
  'bridge',
  'sdk',
  'channel',
  'slack-ping',
  'auto-continuation',
  'scheduled-trigger',
])

// How the engine frames a subagent's hand-back or a task's notification: a
// turn whose prompt came from no origin above, or that no `prompt.submit`
// showed, is known by it.
const HANDED_BACK = /^\s*<(?:agent-message from="|task-notification>)/

// The prompts submitted since the main loop's last turn began, as
// `prompt.submit` saw them: where each came from, its text, and whether the
// session was idle (it starts a turn of its own) or ran a turn (it waits in
// the queue, or goes into that turn). A turn's start finds its own by its
// text, else takes the latest one made while idle.
export type Submission = { kind: string; text: string; isIdle: boolean }
export let submissions: Submission[] = []
export const setSubmissions = (value: typeof submissions) => {
  submissions = value
}
export const MAX_SUBMISSIONS = 20

// Whether the main loop's turn that begins with `text` goes on with the turn
// before it. Its submission, once found, and every one made while idle are
// let go: those started this turn or none.
export const isResumedBy = (text: string) => {
  const trimmed = text.trim()
  const own = submissions.filter(one => one.text === trimmed).at(-1)
  const found = own ?? submissions.filter(one => one.isIdle).at(-1)
  submissions = submissions.filter(one => one !== found && !one.isIdle)

  if (found !== undefined && RESUMING.has(found.kind)) return true
  if (found !== undefined && PROMPTED.has(found.kind)) return false

  return HANDED_BACK.test(text)
}

// While the turn waits on its subagents, the tick counts them again each
// WAIT_CHECK. Once none has worked for DRAIN_GRACE and no result has woken
// Claude (a hand-back withheld, a subagent stopped with no word), the turn
// is done. The module's own: a reload starts the count over.
const WAIT_CHECK = 10_000
const DRAIN_GRACE = 30_000
let checkedAt = Number.NEGATIVE_INFINITY
export let drainedAt: number | null = null
export const setDrainedAt = (value: typeof drainedAt) => {
  drainedAt = value
}

// The turn ended: no longer waiting.
export const ended = (turn: Thinking, durationMs: number, isAborted: boolean): Thinking => {
  const { paused: _, ...rest } = turn

  return { ...rest, durationMs, isAborted }
}

// The turn goes on in the main loop's turn `turnId`, which a subagent's
// result or another background message began: no longer waiting, reopened
// if it had ended, its recap no longer owed.
export async function goOn ($: EngineInterface, turn: Thinking, turnId: string) {
  const reopened = await updateTurn($, turn.turnId, one => {
    const { durationMs: _, isAborted: __, paused: ___, ...rest } = one

    return { ...rest, lastTurnId: turnId }
  })

  // Its row in the recent turns runs again too.
  if (reopened !== null && isTurnOf(reopened, turnId)) await recordTurn($, reopened).catch(() => {})

  if (owedRecap === turn.turnId) owedRecap = null
  if (retried.turnId === turn.turnId) retried = { turnId: '', count: 0 }

  drainedAt = null
}

// The tick's count of the subagents a waiting turn waits on.
async function checkWait ($: EngineInterface) {
  const now = await $.clock.now()

  if (now - checkedAt < WAIT_CHECK) return

  checkedAt = now
  const turn = await read($, thinking)

  if (turn?.paused === undefined || turn.durationMs !== undefined) {
    drainedAt = null
    // While the turn runs, the subagents the pane shows are listed again at
    // the same pace.
    await relistSubagents($)

    return
  }

  const running = await runningSubagents($)

  if (running !== turn.paused.subagents) {
    await updateTurn($, turn.turnId, one =>
      one.paused === undefined ? one : { ...one, paused: { ...one.paused, subagents: running } },
    )
  }

  if (running > 0) {
    drainedAt = null

    return
  }

  drainedAt ??= now

  if (now - drainedAt < DRAIN_GRACE) return

  // It ran until its last subagent ended, as far as the count saw. As at a
  // turn's end, the log takes how it ended, then the summary asks for its
  // last word, past the gap: the clock stops.
  const end = drainedAt
  drainedAt = null
  await updateTurn($, turn.turnId, one =>
    one.paused === undefined ? one : ended(one, Math.max(0, end - one.startedAt), false),
  )
  owedRecap = (await read($, isSummaryOn)) ? turn.turnId : null
  stopTicker()
  $.clock.after(0, () => void endTurn($, turn.turnId).catch(() => {}))
}

export const stopTicker = () => {
  ticker?.cancel()
  ticker = null
}

// While a turn runs, or waits on its subagents: redraw each second for the
// clock in the header, and ask for a summary once one is due.
export function startTicker($: EngineInterface) {
  stopTicker()
  ticker = $.clock.every(SECOND, () => void tick($).catch(() => {}))
}

async function tick ($: EngineInterface) {
  $.ui.invalidate('ui.render')

  // When a summary is due, what the streaming block wrote since its last
  // part becomes a part of its own, for the summary to read.
  if (asking === null && (await $.clock.now()) - askedAt >= summaryGap()) {
    await cutLive($)
  }

  await checkWait($)
  await askSummary($, false)
}

// The streaming block's text since its last part, up to its last sentence
// (or its last word) ended, becomes a note: `…` closes it, and opens the
// part after it.
async function cutLive ($: EngineInterface) {
  const live = liveBlock

  if (live === null) return

  const fresh = live.text.slice(live.kept)

  if (fresh.trim().length < LIVE_MIN_CHARS) return

  const sentence = Math.max(fresh.lastIndexOf('. '), fresh.lastIndexOf('\n'))
  const end = sentence >= LIVE_MIN_CHARS / 2 ? sentence + 1 : fresh.lastIndexOf(' ')

  if (end <= 0) return

  const part = fresh.slice(0, end)
  const isFirst = live.kept === 0
  live.kept += part.length
  await keepNote($, live.turnId, `${isFirst ? '' : '… '}${part.trim()} …`)
}

// The streaming block ended: what no part holds yet becomes its last note.
export async function endLive ($: EngineInterface) {
  const live = liveBlock
  liveBlock = null

  if (live === null) return

  const rest = live.text.slice(live.kept).trim()

  if (rest === '') return

  await keepNote($, live.turnId, live.kept === 0 ? rest : `… ${rest}`)
}

// A main-loop turn as the summary starts to follow it.
export const newTurn = (turnId: string, request: string, startedAt: number): Thinking => ({
  turnId,
  request,
  startedAt,
  notes: [],
  summarized: 0,
  seen: 0,
  actions: [],
  said: [],
  entries: [],
  isSummarizing: false,
})

// Whether the main loop's turn `turnId` is the kept turn's: its first, or
// the latest that went on with it.
export const isTurnOf = (turn: Thinking, turnId: string) => turn.turnId === turnId || turn.lastTurnId === turnId

// Changes the turn kept, where it is still the turn `turnId`.
export function updateTurn($: EngineInterface, turnId: string, change: (turn: Thinking) => Thinking) {
  return update($, thinking, turn => (turn !== null && isTurnOf(turn, turnId) ? change(turn) : turn))
}

// The updates with `entry` after them, the newest MAX_TURN_ENTRIES kept: the
// log is written from them, so a turn's first updates stay in it.
const withEntry = (entries: readonly ThinkingEntry[], entry: ThinkingEntry) =>
  [...entries, entry].slice(-MAX_TURN_ENTRIES)

// How many updates came after the turn's latest recap, or all of them while
// it has none.
const sinceRecap = (turn: Thinking) => {
  let count = 0

  for (let at = turn.entries.length - 1; at >= 0 && turn.entries[at]?.isRecap !== true; at -= 1) count += 1

  return count
}

// Something to say. While the turn runs: notes Haiku has not read yet, as an
// update or a WAIT, or notes that waited past `maxSilence`. While it waits on
// its subagents: notes no update has read, nothing more coming until a
// result wakes Claude. Once it ended: those, or two updates or more since
// the last recap (a turn a result reopened has one). One update and nothing
// after it needs none: the recap would say it again.
const hasNews = (turn: Thinking, now: number) => {
  if (turn.durationMs !== undefined) return turn.notes.length > turn.summarized || sinceRecap(turn) >= 2
  if (turn.paused !== undefined) return turn.notes.length > turn.summarized

  return turn.notes.length > turn.seen || isSilent(turn, now)
}

// One request at a time: a tick that comes while one runs leaves it be, and
// a due request waits for it. `isDue` skips the gap: the turn's end, the
// person turning it on.
async function askSummary ($: EngineInterface, isDue: boolean) {
  if (asking !== null) {
    if (isDue) isOwed = true

    return
  }

  const stop = new AbortController()
  asking = stop
  let isAgain = false

  try {
    isAgain = await summarize($, stop.signal, isDue)
  } finally {
    asking = null
  }

  // Cut by the person turning the summary off, it asks nothing more of its
  // own; one asked for meanwhile, as by turning it on again, still runs.
  const isNext = (isAgain && !stop.signal.aborted) || isOwed
  isOwed = false

  if (isNext) await askSummary($, true)
}

// Asks Haiku for the next update on the turn and adds it to the earlier
// ones; a WAIT leaves the notes for the next request. The turn before the
// current one goes first while it still owes its recap: the next prompt can
// begin before the last one's end was summarized. Resolves true when the
// turn ended meanwhile and still wants its recap, which no tick will ask
// for.
async function summarize ($: EngineInterface, signal: AbortSignal, isDue: boolean) {
  const now = await $.clock.now()

  // The gap first: it needs no read of the turn, which ticks would make
  // each second.
  if (!isDue && now - askedAt < summaryGap()) return false

  const before = previousTurn
  const isPrevious =
    before !== null && before.turnId === owedRecap && before.durationMs !== undefined && hasNews(before, now)
  const turn = isPrevious ? before : await read($, thinking)

  if (turn === null || !hasNews(turn, now) || !(await read($, isSummaryOn))) return false

  askedAt = now
  const ask = askOf(turn, now)

  // A turn's recap is asked once: one that failed is not asked again over
  // the turn that followed.
  if (ask.isRecap && turn.turnId === owedRecap) owedRecap = null

  if (!isPrevious) await updateTurn($, turn.turnId, one => ({ ...one, isSummarizing: true }))

  const prompt = summaryPrompt(turn, ask)
  let result: ModelCompleteResult | null = null
  let failure: string

  try {
    result = await $.model.complete(
      { model: HAIKU, system: system.text, prompt, effort: 'low', timeoutMs: SUMMARY_TIMEOUT },
      { signal },
    )
    failure = failureOf(result)
  } catch (error) {
    // A request the engine refuses to send, as for a model the settings block.
    failure = clip(messageOf(error), 120)
  }

  const answeredAt = await $.clock.now()

  // What the summaries cost, said under them. The engine counts the request
  // in the session's cost, and so in this session's spend: nothing is added
  // to that here.
  if (result !== null) {
    const spent = haikuCost(result.usage)

    if (spent > 0) await update($, summaryCost, usd => usd + spent)
  }

  const reply = result?.isAnswered
    ? parseSummary(result.text, ask.isRecap ? MAX_RECAP_DECISIONS : MAX_DECISIONS, ask.isForced)
    : null
  const told = reply !== null && 'update' in reply ? reply.update : null
  const entry: ThinkingEntry | null =
    told === null ? null : { at: now, ...told, ...(ask.isRecap ? { isRecap: true as const } : {}) }

  // What the reply makes of the turn, wherever it is kept by then.
  const settle = (one: Thinking): Thinking => {
    const { failure: _, waitingFor, ...rest } = one
    const settled = { ...rest, isSummarizing: false }
    const upTo = readUpTo(one, ask)

    if (entry !== null) {
      return { ...settled, entries: withEntry(settled.entries, entry), summarized: upTo, seen: upTo }
    }

    // Haiku waits for more: these notes come back with the next ones.
    if (reply !== null && 'wait' in reply) return { ...settled, seen: upTo, waitingFor: reply.wait }

    const kept = waitingFor === undefined ? settled : { ...settled, waitingFor }

    // Cut because the person turned the summary off: nothing went wrong.
    return signal.aborted ? kept : { ...kept, failure }
  }

  await updateTurn($, turn.turnId, settle)

  if (ask.isRecap && entry === null && !signal.aborted) {
    const count = retried.turnId === turn.turnId ? retried.count : 0

    // A later turn's own recap owed goes first; this one is then let go.
    if (count < RECAP_RETRIES && (owedRecap === null || owedRecap === turn.turnId)) {
      retried = { turnId: turn.turnId, count: count + 1 }
      owedRecap = turn.turnId
      $.clock.after(recapWait(), () => void askSummary($, true).catch(() => {}))
    }
  }

  if (await read($, isDebugOn)) {
    await logDebug($, { turn, ask, sentAt: now, answeredAt, prompt, result, failure, reply, isAborted: signal.aborted })
  }

  const after = await read($, thinking)

  // The new update goes on top of the turn shown: someone scrolled down
  // keeps the lines they were reading where they were. Beside the weather
  // a turn picked from the list may be shown instead, its lines unmoved.
  const picked = isPickingDrawn ? await read($, pickedTurn) : null

  if (told !== null && after?.turnId === turn.turnId && (picked === null || picked === turn.turnId)) {
    const added = partsOf(told).length
    await update($, summaryPlace, place =>
      place.line > 0 || place.row > 0 ? { line: place.line + added, row: place.row } : place,
    )
  }

  // The log takes the update on the turn it was asked on, the next prompt's
  // turn having begun meanwhile or not.
  if (entry !== null) {
    if (after?.turnId === turn.turnId) {
      await keepTurn($, after)
    } else if (previousTurn?.turnId === turn.turnId) {
      // The next turn began from this one as it stood: with this update in
      // it already, when that came after the update was kept.
      const isKept = previousTurn.entries.some(
        one => one.at === entry.at && one.isRecap === entry.isRecap && one.gist === entry.gist,
      )

      if (!isKept) setPreviousTurn(settle(previousTurn))

      await keepTurn($, previousTurn)
    }
  }

  return (
    after?.turnId === turn.turnId &&
    after.durationMs !== undefined &&
    (!ask.isRecap || (after.dropped ?? 0) + after.notes.length > ask.base + ask.covered)
  )
}

// A main-loop turn ended: the log takes how it ended, then the summary asks
// for its last word. The next prompt's turn may have begun by now: the turn
// is then the one before it.
export async function endTurn ($: EngineInterface, turnId: string) {
  const current = await read($, thinking)
  const turn = current?.turnId === turnId ? current : previousTurn?.turnId === turnId ? previousTurn : null

  if (turn !== null) await keepTurn($, turn)

  await askSummary($, true)
}

// The person's switch: off cuts a request under way and stops the clock;
// on picks up what came in meanwhile.
export async function setSummary ($: EngineInterface, isOn: boolean) {
  await $.store.set(STORED_SUMMARY_OFF, !isOn)
  await update($, isSummaryOn, () => isOn)

  if (!isOn) {
    stopTicker()
    asking?.abort()

    return
  }

  const turn = await read($, thinking)

  if (turn !== null && turn.durationMs === undefined) startTicker($)

  $.clock.after(0, () => void askSummary($, true).catch(() => {}))
}

// One of the main loop's thinking blocks, or a part of a long one: a note of
// the turn. A turn whose start the mod missed (it loaded mid-turn) begins
// here.
async function keepNote ($: EngineInterface, turnId: string, text: string) {
  const note = clipNote(text.trim())

  if (note === '') return

  try {
    const now = await $.clock.now()
    let isNew = false

    await update($, thinking, turn => {
      const one = turn !== null && isTurnOf(turn, turnId) ? turn : newTurn(turnId, '', now)
      isNew = one !== turn

      // The same block twice, as from a retried request, is one note.
      if (one.notes.at(-1)?.text === note) return one

      const notes = [...one.notes, { at: now, text: note }]
      const dropped = Math.max(0, notes.length - MAX_NOTES)

      return {
        ...one,
        notes: notes.slice(dropped),
        summarized: Math.max(0, one.summarized - dropped),
        seen: Math.max(0, one.seen - dropped),
        ...(dropped === 0 ? {} : { dropped: (one.dropped ?? 0) + dropped }),
      }
    })

    if (isNew && (await read($, isSummaryOn))) startTicker($)
  } catch {
    // The stream goes on; the summary misses this note.
  }
}

// A tool call in a few words, for the summary: the tool and what it was
// aimed at, never a command's own text, which may hold a secret. Bash and
// PowerShell go by the description the call gave, a file by its name.
export const actionOf = (tool: string, input: Readonly<Record<string, unknown>>) => {
  const field = (key: string) => {
    const value = input[key]

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const file = field('file_path') ?? field('notebook_path')
  const target =
    tool === 'Bash' || tool === 'PowerShell'
      ? field('description')
      : file !== undefined
        ? file.split(/[\\/]/).at(-1)
        : (field('description') ?? field('pattern') ?? field('skill'))

  return clip(target === undefined ? tool : `${tool}: ${target}`, ACTION_CHARS)
}

// A tool call or a block of the text Claude wrote to the person, kept on the
// main loop's turn while it runs (on the turn named, where one is).
export async function keepMark ($: EngineInterface, key: 'actions' | 'said', text: string, turnId?: string) {
  const mark = text.trim()

  if (mark === '') return

  try {
    const at = await $.clock.now()

    await update($, thinking, turn => {
      if (turn === null || turn.durationMs !== undefined || (turnId !== undefined && !isTurnOf(turn, turnId))) {
        return turn
      }

      const marks = [...turn[key], { at, text: mark }].slice(-MAX_MARKS)

      return key === 'actions' ? { ...turn, actions: marks } : { ...turn, said: marks }
    })
  } catch {
    // The turn goes on; the summary misses this.
  }
}

// A line on where the summary stands, when the updates do not say it:
// after a WAIT, what Haiku waits for, in the summary's language, under a
// word in Vietnamese where that is the language, else in English.
export const statusOf = (turn: Thinking | null) => {
  if (turn === null) return 'Waiting for the next turn.'

  if (turn.waitingFor !== undefined && turn.failure === undefined) {
    const waiting = isVietnamese(settings.language) ? 'Đợi thêm' : 'Waiting'

    return turn.waitingFor === '' ? `${waiting}…` : `${waiting}: ${turn.waitingFor}`
  }

  if (turn.entries.length > 0) return turn.failure === undefined ? null : `Update failed: ${turn.failure}`

  // No notes though the turn has called tools, written or ended: most
  // likely the transcript view keeps Claude's thinking from the mod, so the
  // line says where it comes from. A turn just begun may think yet.
  if (turn.notes.length === 0) {
    const isUnderWay = turn.durationMs === undefined
    const hasActed = turn.actions.length > 0 || turn.said.length > 0 || !isUnderWay

    if (!hasActed) return 'No thinking notes yet.'

    return `${isUnderWay ? 'No thinking notes yet' : 'No thinking notes this turn'}: they come only with the Thinking or Verbose transcript view.`
  }

  if (turn.failure !== undefined) return `Summary failed: ${turn.failure}`

  return `Summarizing ${plural(turn.notes.length, 'note')}…`
}
