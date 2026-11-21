// The thinking log: each turn's updates in a Markdown file, and the tool that
// reads it back.

import type { EngineInterface } from 'claude-code'
import type { Thinking, ThinkingEntry } from '../types'
import { partsOf, shownText, stampOf, waitingFor } from './entries'
import { messageOf, rewrite, sessionFile, tell } from './files'
import { clip, formatDuration, formatWhen, plural } from './format'
import { settings } from './settings'
import { fitNewest, HAIKU_NAME } from './summary/prompt'

// The thinking log: each turn's updates in a Markdown file of the session's
// own under the Claude Code configuration directory, its section rewritten
// as they come, and a tool that reads it back for the model. A turn with no
// update leaves no section.
export const LOG_FOLDER = ['session-weather', 'thinking'] as const
const LOG_REQUEST_CHARS = 300
// Each section opens with this mark and the turn's id: a rewrite finds the
// turn's section by it, and the tool splits the log at each.
const LOG_MARK = '<!-- turn '
const LOG_SECTION = /^<!-- turn [^\n]* -->\n/m
// What the tool hands back: the latest turns, LOG_TURNS unless asked, and
// no more characters than LOG_BUDGET, the oldest turns left out first.
const LOG_TURNS = 10
const MAX_LOG_TURNS = 50
const LOG_BUDGET = 20_000
const LOG_TOOL = 'thinking_log'
export const LOG_TOOL_NAME = 'mcp__session-weather__thinking_log'

const logHeader = (sessionId: string, root: string | null) =>
  [
    '# Thinking log',
    '',
    `Session \`${sessionId}\`${root === null ? '' : ` in \`${root}\``}.`,
    '',
    `What ${HAIKU_NAME} said of Claude's thinking notes, turn by turn, as the Session Weather pane showed it: each turn's recap first, then its updates in the order they came. Haiku's reading of summarized thinking, not Claude's own words: check a decision against the code and the transcript before relying on it.`,
    '',
    '',
  ].join('\n')

// One update as a bullet, its time into the turn (or Recap) and its gist,
// its decisions, assumptions and next step under it, marked as the pane
// marks them.
const logLines = (turn: Thinking, entry: ThinkingEntry) =>
  partsOf(entry).map(line =>
    line.kind === 'gist' ? `- ${stampOf(turn, entry)} · ${line.text}` : `  - ${shownText(line)}`,
  )

// The line that opens a turn's section.
const sectionMark = (turnId: string) => `${LOG_MARK}${turnId} -->`

// A turn's section: when it began and how it ended, the request, the recap
// (the newest first, should a late note have brought a second), then the
// updates in order.
const logSection = (turn: Thinking) => {
  const request = clip(turn.request.replace(/\s+/g, ' ').trim(), LOG_REQUEST_CHARS)
  const recaps = turn.entries.filter(entry => entry.isRecap === true).reverse()
  const updates = turn.entries.filter(entry => entry.isRecap !== true)
  const ending =
    turn.durationMs !== undefined
      ? [formatDuration(turn.durationMs), turn.isAborted === true ? 'interrupted' : 'done']
      : turn.paused !== undefined
        ? [waitingFor(turn.paused.subagents)]
        : ['in progress']

  return [
    sectionMark(turn.turnId),
    `## ${[formatWhen(turn.startedAt), ...ending].join(' · ')}`,
    '',
    `> ${request === '' ? '(no prompt text)' : request}`,
    '',
    ...[...recaps, ...updates].flatMap(entry => logLines(turn, entry)),
    '',
    '',
  ].join('\n')
}

// The log with the turn's section where it stood, or after the others.
const withSection = (text: string, turnId: string, section: string) => {
  // Looked for after a newline put before the text, the mark is found at
  // the text's very start too.
  const at = `\n${text}`.indexOf(`\n${sectionMark(turnId)}\n`)

  if (at === -1) {
    const closed = text.endsWith('\n\n') ? text : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`

    return `${closed}${section}`
  }

  const next = text.indexOf(`\n${LOG_MARK}`, at)

  return `${text.slice(0, at)}${section}${next === -1 ? '' : text.slice(next + 1)}`
}

// The most the log holds, in UTF-8 bytes: the file API reads and writes no
// file past 4 MiB, and the log is read and written whole, so past this its
// oldest turns go.
const LOG_MAX_BYTES = 3 * 1024 * 1024

const bytesOf = (text: string) => new TextEncoder().encode(text).length

// The log within LOG_MAX_BYTES: its header kept, its oldest sections left
// out, the newest kept whatever its size.
const fitLog = (text: string) => {
  const first = text.search(LOG_SECTION)
  let excess = bytesOf(text) - LOG_MAX_BYTES
  let cut = first

  if (excess <= 0 || first === -1) return text

  while (excess > 0) {
    const next = text.indexOf(`\n${LOG_MARK}`, cut)

    if (next === -1) break

    excess -= bytesOf(text.slice(cut, next + 1))
    cut = next + 1
  }

  return `${text.slice(0, first)}${text.slice(cut)}`
}

// The log's writes, one at a time: each reads the file and writes it whole.
let logging: Promise<void> = Promise.resolve()

// The main loop's turn before the current one, as it stood when the next
// began: an update asked on it may land after, and the log still takes it.
export let previousTurn: Thinking | null = null
export const setPreviousTurn = (value: typeof previousTurn) => {
  previousTurn = value
}

export function logTurn($: EngineInterface, turn: Thinking) {
  if (turn.entries.length === 0) return logging

  logging = logging
    .then(() =>
      rewrite($, LOG_FOLDER, async (text, sessionId) =>
        fitLog(
          withSection(
            text === '' ? logHeader(sessionId, await $.session.root().catch(() => null)) : text,
            turn.turnId,
            logSection(turn),
          ),
        ),
      ),
    )
    .catch((error: unknown) => tell($, `Thinking log not written: ${messageOf(error)}`, { to: 'debug' }))

  return logging
}

// The tool as the model sees it, the summary's language as set.
export const logToolSpec = () => ({
  name: LOG_TOOL,
  description: [
    "This session's thinking log: for each earlier turn, the user's request and what Claude Haiku said of your thinking notes (the gist, the decisions marked ★, what you took as true unchecked marked ?, the next step marked →), the turn's recap first.",
    'Call it to recall what you weighed or settled on in a turn the conversation no longer holds in detail, as after a compaction, or when the user asks about an earlier turn.',
    `It is Haiku's paraphrase of your summarized thinking, in ${settings.language}: a lead to check against the code, the transcript or the user, never a record of what you decided.`,
    `By default the last ${LOG_TURNS} turns, each with its recap, or its last update when it has none.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      turns: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LOG_TURNS,
        description: `How many of the latest turns to return; ${LOG_TURNS} when left out.`,
      },
      full: { type: 'boolean', description: 'Every update of each turn, not only its recap.' },
    },
    additionalProperties: false,
  },
  isDeferred: true,
})

// A section cut to the turn's last word: its heading and request, then its
// recap, or its last update when it has none.
const lastWord = (section: string) => {
  // Each update is a bullet at the line's start, its decisions and the rest
  // indented under it: the section splits before each update.
  const [head, ...updates] = section.split(/\n(?=- )/)
  const word = updates.find(block => block.startsWith('- Recap · ')) ?? updates.at(-1)

  return word === undefined ? section : `${head}\n${word}`
}

// The tool's answer: the latest turns' sections, oldest first, within the
// budget.
export async function readLog ($: EngineInterface, input: { turns?: unknown; full?: unknown }) {
  const path = await sessionFile($, LOG_FOLDER, await $.session.id())

  if (path === null) return 'No thinking log: the Claude Code configuration directory is not known.'

  const none =
    'No thinking log for this session yet: no turn has had a thinking summary. It needs the Session Weather summary on, and the Thinking or Verbose transcript view.'

  if (!(await $.fs.exists(path))) return none

  const sections = (await $.fs.read(path))
    .split(LOG_SECTION)
    .slice(1)
    .map(section => section.trimEnd())

  if (sections.length === 0) return none

  const asked = typeof input.turns === 'number' && Number.isFinite(input.turns) ? Math.floor(input.turns) : LOG_TURNS
  const isFull = input.full === true
  const picked = sections
    .slice(-Math.min(MAX_LOG_TURNS, Math.max(1, asked)))
    .map(section => (isFull ? section : lastWord(section)))
  // Only the newest, kept whatever its size, can run over the budget.
  const kept = fitNewest(picked, LOG_BUDGET, section => section.length).map(section => clip(section, LOG_BUDGET))
  const count = plural(sections.length, 'turn')
  const lead = [
    `The thinking log of this session, ${path}:`,
    kept.length === sections.length ? `${count}, oldest first.` : `the last ${kept.length} of ${count}, oldest first.`,
    ...(isFull ? [] : ['Each turn shows its recap, or its last update when it has none; `full: true` gives every update.']),
  ].join(' ')

  return [lead, ...kept].join('\n\n')
}
