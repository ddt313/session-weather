// The subagents: those at work and ended, and the figures each spent.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Timer, TurnUsage } from 'claude-code'
import type { Subagent, SubagentFigures } from '../types'
import { clip, formatDuration, formatTokens, modelNameOf, SECOND } from './format'
import { formatLeft } from './limits'
import { showStatus } from './status'
import { inputTokens } from './summary/prompt'
import { AT_WORK, ENDED, recordSubagents, workingOf } from './turns'
import { isRoomyDrawn } from './ui/drawn'

const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const subagentFigures = atom({ plugin: 'session-weather', key: 'subagentFigures' } as const, [])

// When each subagent the main loop started was spawned, as `agent.spawn` saw
// it, until a list written since gives its row that time. The module's own:
// a reload loses only a spawn not listed yet.
export const spawnedAt = new Map<string, number>()

// The agent whose loop spawned each nested subagent, by its id, as its spawn
// or a list showed it: what a nested one reads and writes counts toward the
// main loop's subagent above it. The module's own: a reload has it again
// from the next list.
export const parentOf = new Map<string, string>()

// The loops that began a turn with no row, the list read for each once: a
// subagent no `agent.spawn` raised (a forked skill) gets its row then, a
// workflow's or the engine's own (compaction, memory) never does, and is not
// looked for again. The module's own.
export const lookedFor = new Set<string>()

// The list of subagents and their figures change one at a time, in order:
// a list of the agents read before another subagent started never lands
// after one read since, and a row a new prompt let go never comes back from
// a list or a flush that read it before. The module's own, as the status
// line's queue is.
let subagentQueue: Promise<unknown> = Promise.resolve()

export const inSubagentOrder = <T,>(work: () => Promise<T>) => {
  const run = subagentQueue.then(work)
  subagentQueue = run.catch(() => {})

  return run
}

// The figures of the subagents `listed`; those of a row gone are let go.
async function keepFigures ($: EngineInterface, listed: readonly Subagent[]) {
  const ids = new Set(listed.map(one => one.id))

  if ((await read($, subagentFigures)).some(one => !ids.has(one.id))) {
    await update($, subagentFigures, figures => figures.filter(one => ids.has(one.id)))
  }
}

// The main loop's subagents (`agents`: the model's, not a plugin's) as the
// pane lists them, over the list kept (`before`): those at work, and those
// it saw at work, or saw spawn, that ended since the person's prompt. Each
// with the words its row gives it, where it stands, since when it runs (kept
// from the list or taken from its spawn) and, ended, since when it has, `now`
// for one ending here. One the pane never saw at work (done before the mod
// loaded, or in an earlier prompt) has no row; one ended that `agents` no
// longer names keeps its own.
const subagentsOf = (before: readonly Subagent[], agents: readonly AgentInfo[], now: number): Subagent[] => {
  const fresh = agents.flatMap(agent => {
    const was = before.find(one => one.id === agent.id)
    const isEnded = ENDED.has(agent.status)

    if (!AT_WORK.has(agent.status) && !(isEnded && (was !== undefined || spawnedAt.has(agent.id)))) return []

    const startedAt = was?.startedAt ?? spawnedAt.get(agent.id)
    const endedAt = isEnded ? (was?.endedAt ?? now) : undefined

    return [
      {
        id: agent.id,
        label: agent.description.trim() || agent.name || agent.type,
        status: agent.status,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
      },
    ]
  })
  const named = new Set(agents.map(agent => agent.id))

  return [...fresh, ...before.filter(one => ENDED.has(one.status) && !named.has(one.id))]
}

// The list kept from `agents`, worked out again from the list as it stands
// when written, and written only where it changed: a spawn whose time a row
// took is let go, the figures of a row gone go with it, and the status line,
// which counts those at work, is set again. In the subagents' order alone.
async function keepSubagents ($: EngineInterface, agents: readonly AgentInfo[]) {
  const [before, now] = await Promise.all([read($, subagents), $.clock.now()])

  if (JSON.stringify(before) === JSON.stringify(subagentsOf(before, agents, now))) return

  const kept = await update($, subagents, current => subagentsOf(current, agents, now))

  for (const one of kept) {
    if (one.startedAt !== undefined) spawnedAt.delete(one.id)
  }

  await keepFigures($, kept)
  await recordSubagents($).catch(() => {})
  await showStatus($).catch(() => {})
}

// How many subagents the main loop started still work: the model's, not a
// plugin's, and not idle between turns, as a teammate waiting for a message
// is. Their results wake Claude again. The pane keeps the list it read, and
// the agent that spawned each nested one. None where the list cannot be read.
export function runningSubagents($: EngineInterface) {
  return inSubagentOrder(async () => {
    const agents = await $.agent.list()

    for (const agent of agents) {
      if (agent.parentId !== undefined) parentOf.set(agent.id, agent.parentId)
    }

    const mine = agents.filter(agent => agent.parentId === undefined && agent.spawnedBy === undefined)
    await keepSubagents($, mine)

    return mine.filter(agent => AT_WORK.has(agent.status)).length
  }).catch(() => 0)
}

// The subagents shown listed again, where any is at work: one may have ended.
export async function relistSubagents ($: EngineInterface) {
  if (workingOf(await read($, subagents)) > 0) await runningSubagents($)
}

// A loop began a turn: one with no row, not looked for before and not known
// as a subagent's own, has the list read for it, once.
export async function lookFor ($: EngineInterface, agentId: string) {
  if (lookedFor.has(agentId) || spawnedAt.has(agentId) || parentOf.has(agentId)) return
  if ((await read($, subagents)).some(one => one.id === agentId)) return

  lookedFor.add(agentId)
  await runningSubagents($)
}

// A new prompt of the person's: the subagents that ended go from the list,
// their figures with them; those still at work stay.
export function forgetEnded($: EngineInterface) {
  return inSubagentOrder(async () => {
    if (!(await read($, subagents)).some(one => ENDED.has(one.status))) return

    const kept = await update($, subagents, list => list.filter(one => !ENDED.has(one.status)))
    await keepFigures($, kept)
  })
}

// What the subagents' requests and tool calls came to since the pane last
// took them in, by the id of the loop they ran in: the model and effort of
// the latest request, the tokens the requests read and wrote, those the
// latest one carried, and the latest tool call in a few words. Taken in at
// most once per FIGURES_GAP, so subagents at work draw the pane no more often
// than that. The module's own: a reload loses at most one gap's.
type Noted = Omit<SubagentFigures, 'id' | 'nested'>

export const noted = new Map<string, Noted>()
const FIGURES_GAP = SECOND
export let figuresTimer: Timer | null = null
export const setFiguresTimer = (value: typeof figuresTimer) => {
  figuresTimer = value
}

// A nested subagent's figures go up this many spawns at most to find the row
// they count toward.
const MAX_NESTING = 8

// What a request or a tool call of the loop `agentId` showed, noted; the
// figures are taken in once the gap has passed.
export function noteFigures($: EngineInterface, agentId: string, seen: Partial<Noted>) {
  const one = noted.get(agentId) ?? { tokens: 0 }
  noted.set(agentId, { ...one, ...seen, tokens: one.tokens + (seen.tokens ?? 0) })
  figuresTimer ??= $.clock.after(FIGURES_GAP, () => {
    figuresTimer = null
    void takeFigures($).catch(() => {})
  })
}

// The row a loop's figures count toward: its own where it is listed, else,
// for a nested subagent, the listed one above it. Undefined for a loop no row
// stands for: a plugin's subagent, a workflow's, the engine's own forks.
const rowOf = (id: string, listed: ReadonlySet<string>) => {
  let at: string | undefined = id

  for (let up = 0; at !== undefined && up <= MAX_NESTING; up += 1) {
    if (listed.has(at)) return at

    at = parentOf.get(at)
  }

  return undefined
}

// The figures noted since the pane last took them in, into the rows: a
// loop's own to its row, a nested subagent's tokens to the row above it, as
// its subagents'. Written only where one counts toward a row. In the
// subagents' order alone.
async function takeNoted ($: EngineInterface) {
  const taken = [...noted]
  noted.clear()
  const listed = new Set((await read($, subagents)).map(one => one.id))
  const counted = taken.flatMap(([id, one]) => {
    const row = rowOf(id, listed)

    return row === undefined ? [] : [{ row, isOwn: row === id, one }]
  })

  if (counted.length === 0) return

  await update($, subagentFigures, figures => {
    const rows = new Map(figures.map(figure => [figure.id, figure]))

    for (const { row, isOwn, one } of counted) {
      const was = rows.get(row) ?? { id: row, tokens: 0 }
      rows.set(
        row,
        isOwn ? { ...was, ...one, tokens: was.tokens + one.tokens } : { ...was, nested: (was.nested ?? 0) + one.tokens },
      )
    }

    return [...rows.values()].filter(figure => listed.has(figure.id))
  })
}

function takeFigures($: EngineInterface) {
  return inSubagentOrder(() => takeNoted($))
}

// A subagent's turn ended: what it noted is taken in at once, for its row to
// end on its last figures. Where the turn says its own requests read and
// wrote more than the mod saw of them (it loaded part-way through), its own
// count is the turn's; its subagents' stays as counted.
export function settleFigures($: EngineInterface, agentId: string, usage: TurnUsage | undefined) {
  return inSubagentOrder(async () => {
    await takeNoted($)

    if (usage === undefined || !(await read($, subagents)).some(one => one.id === agentId)) return

    const tokens = inputTokens(usage) + usage.output_tokens
    const isShort = (figures: readonly SubagentFigures[]) =>
      (figures.find(one => one.id === agentId)?.tokens ?? 0) < tokens

    if (!isShort(await read($, subagentFigures))) return

    await update($, subagentFigures, figures => {
      if (!isShort(figures)) return figures

      const was = figures.find(one => one.id === agentId) ?? (usage.model === '' ? {} : { model: usage.model })

      return [...figures.filter(one => one.id !== agentId), { ...was, id: agentId, tokens }]
    })
  }).then(() => recordSubagents($).catch(() => {}))
}

// Each minute, as no ticker runs while the summary is off: the subagents
// shown listed again, and, drawn, the times of those at work moved on a
// minute.
export async function minuteSubagents ($: EngineInterface) {
  await relistSubagents($)

  if (
    isRoomyDrawn &&
    (await read($, subagents)).some(agent => AT_WORK.has(agent.status) && agent.startedAt !== undefined)
  ) {
    $.ui.invalidate('ui.render')
  }
}

// The subagents the weather gives rows at most, the rest said in one more:
// a workflow's dozens would push the recent turns out of the column.
export const MAX_SUBAGENT_ROWS = 5
// The cells the rows under a subagent's own stand in from it.
export const SUBAGENT_INDENT = 2

// "Subagents · 2 at work · 1 finished": how many of those listed work, and
// how many ended since the person's prompt.
export const subagentsHeaderOf = (listed: readonly Subagent[]) => {
  const working = workingOf(listed)
  const finished = listed.length - working

  return [
    'Subagents',
    ...(working > 0 ? [`${working} at work`] : []),
    ...(finished > 0 ? [`${finished} finished`] : []),
  ].join(' · ')
}

// The subagents in the order the weather lists them: those at work as
// listed, the oldest first, then those that ended, the latest first.
export const subagentOrder = (listed: readonly Subagent[]) => [
  ...listed.filter(one => AT_WORK.has(one.status)),
  ...listed.filter(one => !AT_WORK.has(one.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
]

// Where a subagent stands, in its row's words: as its loop says while at
// work; done, failed or stopped once it ended.
export const STANDING = new Map([
  ['completed', 'done'],
  ['failed', 'failed'],
  ['killed', 'stopped'],
])

// "fix the tests · running · 3m": a subagent's row in `chars`, its words cut
// to leave room for where it stands and, where its spawn was seen, how long
// it has run, to the minute; ended, how long it ran, "fix the tests · done ·
// 2m 14s".
export const subagentLine = (agent: Subagent, now: number, chars: number) => {
  const ran =
    agent.startedAt === undefined
      ? null
      : agent.endedAt === undefined
        ? formatLeft(Math.max(0, now - agent.startedAt))
        : formatDuration(Math.max(0, agent.endedAt - agent.startedAt))
  const tail = ` · ${STANDING.get(agent.status) ?? agent.status}${ran === null ? '' : ` · ${ran}`}`
  const label = clip(agent.label.replace(/\s+/g, ' '), Math.max(8, chars - tail.length)).replace(/\s+…$/, '…')

  return { label, tail }
}

// "Opus 5.5 · high · 222.3k tokens · ctx 29.3k": a subagent's figures in a
// few parts, for the rows under its own. The model of its latest request and
// the effort it asked for, the tokens its requests read and wrote, and,
// while it works, those its latest request carried; a part not seen left out.
export const figureParts = (figure: SubagentFigures | undefined, isWorking: boolean) =>
  figure === undefined
    ? []
    : [
        figure.model === undefined ? null : modelNameOf(figure.model),
        figure.effort ?? null,
        figure.tokens + (figure.nested ?? 0) > 0 ? `${formatTokens(figure.tokens + (figure.nested ?? 0))} tokens` : null,
        isWorking && figure.context !== undefined ? `ctx ${formatTokens(figure.context)}` : null,
      ].filter((part): part is string => part !== null)
