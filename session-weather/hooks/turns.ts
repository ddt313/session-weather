// The recent turns: each turn's record, and the file that keeps them for a
// resumed session.

import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface } from 'claude-code'
import type { Compactions, Reading, RecentTurn, Subagent, SubagentFigures, Thinking, ThinkingEntry, TurnCall, TurnSubagent } from '../types'
import { RECENT_TURNS_SHAPE } from './atoms'
import { MAX_ENTRIES } from './entries'
import { deleteFiles, messageOf, sessionFile, tell } from './files'
import { tokensOf } from './format'
import { logTurn } from './log'
import { settings } from './settings'

const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const subagentFigures = atom({ plugin: 'session-weather', key: 'subagentFigures' } as const, [])
const compactions = atom({ plugin: 'session-weather', key: 'compactions' } as const, null)
const recentTurns = atom({ plugin: 'session-weather', key: 'recentTurns' } as const, [], { shape: RECENT_TURNS_SHAPE })
const isSaving = atom({ plugin: 'session-weather', key: 'isSaving' } as const, false)

// The recent turns, as the wide layout lists them: the person's last few
// turns, as many as the setting keeps (10 unless set), in `$.state`, where a
// reload finds them and a /clear, which starts another conversation, lets
// them go. Each keeps its figures and its newest updates, so a turn picked
// from the list shows them without reading its log back. A persisted
// session's file holds as many, no more: an older turn is let go there too.
export const maxRecent = () => settings.recentTurns

// The turn as it now stands into its row, added where it has none (rows in
// the order the turns began, the oldest let go past `maxRecent`): how long it
// ran, how it ended or whether it waits, and its newest updates. Its fill
// and its tool calls stay as counted.
export function recordTurn($: EngineInterface, turn: Thinking) {
  return update($, recentTurns, list => {
    const before = list.find(one => one.turnId === turn.turnId)
    const record: RecentTurn = {
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
      ...(turn.isAborted === true ? { isAborted: true as const } : {}),
      ...(turn.paused !== undefined && turn.durationMs === undefined ? { isWaiting: true as const } : {}),
      ...(before?.fromTokens === undefined ? {} : { fromTokens: before.fromTokens }),
      ...(before?.toTokens === undefined ? {} : { toTokens: before.toTokens }),
      tools: before?.tools ?? 0,
      entries: turn.entries.slice(-MAX_ENTRIES),
      ...(before?.subagents === undefined ? {} : { subagents: before.subagents }),
      ...(before?.moreSubagents === undefined ? {} : { moreSubagents: before.moreSubagents }),
      ...(before?.calls === undefined ? {} : { calls: before.calls }),
      ...(before?.moreCalls === undefined ? {} : { moreCalls: before.moreCalls }),
    }

    return before === undefined
      ? [...list, record].sort((a, b) => a.startedAt - b.startedAt).slice(-maxRecent())
      : list.map(one => (one === before ? record : one))
  })
}

// The turn kept, in its row of the recent turns and in its log: wherever
// the log takes a turn, as it ends, waits or gets an update, its row does,
// and the session's saved file where the person saves it.
export async function keepTurn ($: EngineInterface, turn: Thinking) {
  await recordTurn($, turn).catch(() => {})
  await logTurn($, turn)
  await saveTurns($)
}

// A prompt of the person's begins a turn: its row, newest, from the fill
// the window holds. Right after a compaction that is not known, and the row
// says nothing of tokens; before anything was read the turn counts from
// empty, as the pane's first growth does.
export function openRecord($: EngineInterface, turnId: string, startedAt: number, fill: Reading | null) {
  const fromTokens = fill?.tokens ?? (fill?.isCompacted === true ? undefined : 0)

  return update($, recentTurns, list =>
    [
      ...list.filter(one => one.turnId !== turnId),
      { turnId, startedAt, ...(fromTokens === undefined ? {} : { fromTokens }), tools: 0, entries: [] },
    ].slice(-maxRecent()),
  )
}

// The tool calls a recent turn keeps at most, the newest; past them it
// counts how many it let go.
const MAX_TURN_CALLS = 100

// A tool call while the newest turn runs or waits counts toward it, and is
// kept in its row.
export function countTool($: EngineInterface, call: TurnCall) {
  return update($, recentTurns, list => {
    const last = list.at(-1)

    if (last === undefined || last.durationMs !== undefined) return list

    const calls = [...(last.calls ?? []), call]
    const over = Math.max(0, calls.length - MAX_TURN_CALLS)
    const more = (last.moreCalls ?? 0) + over

    return [
      ...list.slice(0, -1),
      { ...last, tools: last.tools + 1, calls: calls.slice(over), ...(more > 0 ? { moreCalls: more } : {}) },
    ]
  })
}

// What the calls a request answered added to the context, on their rows in
// the newest turn: each call found by when it was made and what it did.
export function chargeCalls(
  $: EngineInterface,
  charge: { calls: readonly { at: number; text: string }[]; tokens: number; isShared: boolean },
) {
  return update($, recentTurns, list => {
    const last = list.at(-1)

    if (last?.calls === undefined) return list

    const isAnswered = (call: TurnCall) =>
      call.agentId === undefined && charge.calls.some(one => one.at === call.at && one.text === call.text)
    const calls = last.calls.map(call =>
      isAnswered(call) ? { ...call, tokens: charge.tokens, ...(charge.isShared ? { isShared: true as const } : {}) } : call,
    )

    return [...list.slice(0, -1), { ...last, calls }]
  })
}

// The fill as measured: the newest turn has added what lies past its start.
export function measureRecord($: EngineInterface, tokens: number) {
  return update($, recentTurns, list => {
    const last = list.at(-1)

    return last === undefined || last.toTokens === tokens ? list : [...list.slice(0, -1), { ...last, toTokens: tokens }]
  })
}

// The subagents a recent turn keeps at most; past them it counts how many.
const MAX_TURN_SUBAGENTS = 30

// The row of `recent` (oldest first) a subagent spawned at `startedAt` goes
// with: the last turn begun by then, the newest for one whose spawn the mod
// did not see; -1 for one older than every row kept.
const recordIndexOf = (recent: readonly RecentTurn[], startedAt: number | undefined) => {
  if (startedAt === undefined) return recent.length - 1

  for (let at = recent.length - 1; at >= 0; at -= 1) {
    if ((recent[at]?.startedAt ?? Infinity) <= startedAt) return at
  }

  return -1
}

// A recent turn's subagents with `listed` (those it started, with their
// `figured`) as they now stand: each kept where it was, its model, effort and
// tokens as last seen, the first MAX_TURN_SUBAGENTS by when they began, the
// rest counted.
const withSubagents = (
  row: RecentTurn,
  listed: readonly Subagent[],
  figured: readonly SubagentFigures[],
): RecentTurn => {
  const kept = new Map((row.subagents ?? []).map(one => [one.id, one]))

  for (const one of listed) {
    const was = kept.get(one.id)
    const figure = figured.find(item => item.id === one.id)
    const model = figure?.model ?? was?.model
    const effort = figure?.effort ?? was?.effort
    kept.set(one.id, {
      ...one,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      tokens: Math.max(was?.tokens ?? 0, tokensOf(figure)),
    })
  }

  const all = [...kept.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const more = Math.max(row.moreSubagents ?? 0, all.length - MAX_TURN_SUBAGENTS)
  const { subagents: _, moreSubagents: __, ...rest } = row

  return { ...rest, subagents: all.slice(0, MAX_TURN_SUBAGENTS), ...(more > 0 ? { moreSubagents: more } : {}) }
}

// The subagents listed, as they now stand, into the rows of the turns that
// started them, and the saved file where the person saves: as one starts or
// ends, as one's last figures come in, and before a prompt lets go of those
// that ended. Written only where a row changed.
export async function recordSubagents ($: EngineInterface) {
  const [listed, figured, recent] = await Promise.all([read($, subagents), read($, subagentFigures), read($, recentTurns)])

  if (listed.length === 0 || recent.length === 0) return

  // One a row keeps stays with it; any other goes with the turn begun before
  // it started.
  const withListed = (list: readonly RecentTurn[]) =>
    list.map((row, index) => {
      const mine = listed.filter(one => {
        const keeper = list.findIndex(item => item.subagents?.some(kept => kept.id === one.id) === true)

        return (keeper === -1 ? recordIndexOf(list, one.startedAt) : keeper) === index
      })

      return mine.length === 0 ? row : withSubagents(row, mine, figured)
    })

  if (JSON.stringify(withListed(recent)) === JSON.stringify(recent)) return

  await update($, recentTurns, withListed)
  await saveTurns($)
}

// What the subagents' card shows for a turn picked from the list: the
// subagents it kept, each still at work drawn from the live list and its
// figures, the others as their rows last stood; and how many it did not keep.
export const subagentsOfRecord = (row: RecentTurn, live: readonly Subagent[], liveFigures: readonly SubagentFigures[]) => {
  const kept = row.subagents ?? []
  const listed = kept.map(one => {
    const now = live.find(item => item.id === one.id)

    if (now !== undefined) return now

    const { model: _, effort: __, tokens: ___, ...agent } = one

    return agent
  })
  const figured = kept.map(
    (one): SubagentFigures =>
      liveFigures.find(item => item.id === one.id && live.some(agent => agent.id === one.id)) ?? {
        id: one.id,
        ...(one.model === undefined ? {} : { model: one.model }),
        ...(one.effort === undefined ? {} : { effort: one.effort }),
        tokens: one.tokens,
      },
  )

  return { listed, figured, more: row.moreSubagents ?? 0 }
}

// A session's recent turns kept past a restart of Claude Code, while the
// person keeps saving on for it: a JSON file of the session's own beside its
// thinking log, written whole as each turn is kept, read back when the
// session starts again. A session never saved writes nothing.
export const TURNS_FOLDER = ['session-weather', 'turns'] as const
// The shape a saved file holds, as the `recentTurns` atom's tag: a file
// written in another is not read back.
const SAVED_SHAPE = 'recent-turns-1'

// What a saved file holds: the turns, and the compactions counted.
type SavedTurns = { shape: string; turns: RecentTurn[]; compactions?: Compactions }

const isStrings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')

const isNumberOrNone = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value))

// An update as a saved file holds it.
const isEntry = (value: unknown): value is ThinkingEntry => {
  const one = value as Partial<ThinkingEntry> | null

  return (
    typeof one === 'object' &&
    one !== null &&
    typeof one.at === 'number' &&
    typeof one.gist === 'string' &&
    isStrings(one.decisions) &&
    isStrings(one.assumptions) &&
    (one.next === undefined || typeof one.next === 'string') &&
    (one.isRecap === undefined || one.isRecap === true)
  )
}

const isStringOrNone = (value: unknown) => value === undefined || typeof value === 'string'

// A turn's subagent as a saved file holds it.
const isTurnSubagent = (value: unknown): value is TurnSubagent => {
  const one = value as Partial<TurnSubagent> | null

  return (
    typeof one === 'object' &&
    one !== null &&
    typeof one.id === 'string' &&
    typeof one.label === 'string' &&
    typeof one.status === 'string' &&
    typeof one.tokens === 'number' &&
    isNumberOrNone(one.startedAt) &&
    isNumberOrNone(one.endedAt) &&
    isStringOrNone(one.model) &&
    isStringOrNone(one.effort)
  )
}

// A turn's tool call as a saved file holds it.
const isTurnCall = (value: unknown): value is TurnCall => {
  const one = value as Partial<TurnCall> | null

  return (
    typeof one === 'object' &&
    one !== null &&
    typeof one.at === 'number' &&
    typeof one.text === 'string' &&
    isStringOrNone(one.agentId) &&
    isNumberOrNone(one.tokens) &&
    (one.isShared === undefined || one.isShared === true)
  )
}

// A turn's row as a saved file holds it.
const isRecentTurn = (value: unknown): value is RecentTurn => {
  const one = value as Partial<RecentTurn> | null

  return (
    typeof one === 'object' &&
    one !== null &&
    typeof one.turnId === 'string' &&
    typeof one.startedAt === 'number' &&
    typeof one.tools === 'number' &&
    isNumberOrNone(one.durationMs) &&
    isNumberOrNone(one.fromTokens) &&
    isNumberOrNone(one.toTokens) &&
    (one.isAborted === undefined || one.isAborted === true) &&
    (one.isWaiting === undefined || one.isWaiting === true) &&
    Array.isArray(one.entries) &&
    one.entries.every(isEntry) &&
    (one.subagents === undefined || (Array.isArray(one.subagents) && one.subagents.every(isTurnSubagent))) &&
    isNumberOrNone(one.moreSubagents) &&
    (one.calls === undefined || (Array.isArray(one.calls) && one.calls.every(isTurnCall))) &&
    isNumberOrNone(one.moreCalls)
  )
}

// A saved file's text; null for one in another shape, or that holds none.
const parseSaved = (text: string): SavedTurns | null => {
  try {
    const value = JSON.parse(text) as { shape?: unknown; turns?: unknown; compactions?: Partial<Compactions> } | null

    if (typeof value !== 'object' || value === null || value.shape !== SAVED_SHAPE || !Array.isArray(value.turns)) {
      return null
    }

    const counted = value.compactions

    return {
      shape: SAVED_SHAPE,
      turns: value.turns.filter(isRecentTurn).slice(-maxRecent()),
      ...(typeof counted?.count === 'number' && typeof counted.isWhole === 'boolean'
        ? { compactions: { count: counted.count, isWhole: counted.isWhole } }
        : {}),
    }
  } catch {
    return null
  }
}

// The saved file's writes, one at a time, each whole.
let saving: Promise<void> = Promise.resolve()

// The session's turns and compactions to its saved file, while saving is
// on; nothing otherwise.
export function saveTurns($: EngineInterface) {
  saving = saving
    .then(async () => {
      if (!(await read($, isSaving))) return

      const path = await sessionFile($, TURNS_FOLDER, await $.session.id(), 'json')

      if (path === null) return

      const [turns, counted] = await Promise.all([read($, recentTurns), read($, compactions)])
      // As many as the setting keeps now, should it have gone down.
      const saved: SavedTurns = {
        shape: SAVED_SHAPE,
        turns: turns.slice(-maxRecent()),
        ...(counted === null ? {} : { compactions: counted }),
      }
      await $.fs.write(path, JSON.stringify(saved))
    })
    .catch((error: unknown) => tell($, `Saved turns not written: ${messageOf(error)}`, { to: 'debug' }))

  return saving
}

// The person's switch, for this session alone: on, its turns are saved now
// and as each is kept; off, its saved file goes, or, should the host not
// delete it, is emptied, for the clean-up to take later.
export async function setSaving ($: EngineInterface, isOn: boolean) {
  await update($, isSaving, () => isOn)

  const path = await sessionFile($, TURNS_FOLDER, await $.session.id(), 'json')

  // A toast says where the turns go, or that they no longer do.
  try {
    $.ui.toast(
      path === null
        ? `Persist ${isOn ? 'on' : 'off'}: no folder to save to was found`
        : isOn
          ? `Persist on: this session's recent turns are saved to ${path} and come back when it starts again`
          : `Persist off: ${path} is deleted; the recent turns stay until Claude Code closes`,
      { timeoutMs: 10_000 },
    )
  } catch {
    // A host that toasts nothing: the box still shows the switch.
  }

  if (isOn) {
    await saveTurns($)

    return
  }

  saving = saving.then(async () => {
    if (path === null || !(await $.fs.exists(path))) return

    const isDeleted = await deleteFiles($, [path]).catch(() => false)

    if (!isDeleted) await $.fs.write(path, '')
  })
  await saving.catch(() => {})
}

// A session that starts again (Claude Code started anew, or a session
// resumed) and that the person saved: its turns and its compactions back,
// and saving on. Only where the session keeps no turns yet, as after a
// restart; a reload finds its own.
export async function restoreTurns ($: EngineInterface) {
  if ((await read($, recentTurns)).length > 0) return

  const path = await sessionFile($, TURNS_FOLDER, await $.session.id(), 'json')

  if (path === null || !(await $.fs.exists(path))) return

  const saved = parseSaved(await $.fs.read(path))

  if (saved === null) return

  // A turn under way as Claude Code closed ran no further: interrupted,
  // its length not known, no longer running or waiting. So with a subagent
  // at work then: stopped.
  const turns = saved.turns.map(saved => {
    const one =
      saved.subagents === undefined
        ? saved
        : { ...saved, subagents: saved.subagents.map(agent => (AT_WORK.has(agent.status) ? { ...agent, status: 'killed' } : agent)) }

    if (one.durationMs !== undefined) return one

    const { isWaiting: _, ...rest } = one

    return { ...rest, isAborted: true as const }
  })
  const counted = saved.compactions

  await update($, recentTurns, () => turns)
  await update($, isSaving, () => true)

  if (counted !== undefined) await update($, compactions, one => (one === null || one.count === 0 ? counted : one))
}

// The states a subagent's loop is at work in: not yet started, running a
// turn, or held on its own background work.
export const AT_WORK: ReadonlySet<string> = new Set<AgentStatus>(['pending', 'running', 'waiting'])
// The states of one that ended: it answered, it failed, or it was stopped. A
// teammate idle between turns is neither: it has no row until it works again.
export const ENDED: ReadonlySet<string> = new Set<AgentStatus>(['completed', 'failed', 'killed'])

// How many of the subagents listed are at work.
export const workingOf = (listed: readonly Subagent[]) => listed.filter(one => AT_WORK.has(one.status)).length
