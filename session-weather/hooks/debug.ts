// The debug log: each request to Haiku and its reply, in a Markdown file.

import type { EngineInterface, ModelCompleteResult } from 'claude-code'
import type { Thinking } from '../types'
import { intoTurn } from './entries'
import { messageOf, rewrite, tell } from './files'
import { clip, formatDuration, formatTokens, pad } from './format'
import { DEBUG_COMMAND } from './settings'
import { HAIKU_NAME, haikuCost, inputTokens, system } from './summary/prompt'
import type { Ask, Reply } from './summary/prompt'

// The summary's debug log, while the person keeps it on: each Haiku request
// as sent and its reply, in a Markdown file of the session's own beside the
// thinking log, the newest DEBUG_REQUESTS kept (the file API writes a file
// whole and deletes none), and a line for each in the transcript, which the
// model is not sent.
export const DEBUG_FOLDER = ['session-weather', 'debug'] as const
const DEBUG_REQUESTS = 30
// Each request's entry opens with a mark of when it was sent: a rewrite
// finds the entries by it. A line like the mark inside a fence (a prompt or
// a reply as it was, which may quote this very log) is their text, not a
// mark: each fence `fenced` writes is matched whole, its closing run of
// backticks longer than any inside it.
const DEBUG_PARTS = /^(`{3,})text\n[\s\S]*?\n\1$|^<!-- request [^\n]* -->$/gm

// The log's entries, each from its mark to the next one; the header left out.
const debugEntries = (text: string) => {
  const starts = [...text.matchAll(DEBUG_PARTS)].filter(part => part[1] === undefined).map(part => part.index ?? 0)

  return starts.map((start, at) => text.slice(start, starts[at + 1]))
}

// One Haiku request of the summary, as the debug log tells it.
type DebugRequest = {
  turn: Thinking
  ask: Ask
  sentAt: number
  answeredAt: number
  prompt: string
  result: ModelCompleteResult | null
  failure: string
  reply: Reply | null
  isAborted: boolean
}

// `text` in a Markdown fence longer than any run of backticks in it.
const fenced = (text: string) => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(run => run[0].length + 1)))

  return `${fence}text\n${text}\n${fence}`
}

// "14:32:05", the host's time.
const formatClock = (ms: number) => {
  const date = new Date(ms)

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const formatChars = (n: number) => (n < 1000 ? `${n} chars` : `${formatTokens(n)} chars`)

// The notes a request read, by their place in the turn: those after the
// last update's, or for the recap all of them.
const notesRead = ({ ask }: DebugRequest) => `notes ${ask.from + 1}–${ask.covered}`

// What the request let Haiku answer.
const askedFor = ({ ask, sentAt }: DebugRequest) =>
  ask.isRecap
    ? 'the recap, WAIT not allowed'
    : ask.isWaiting
      ? 'an update, WAIT not allowed while Claude waits for its subagents'
      : ask.isForced
        ? `an update, WAIT not allowed after ${formatDuration(sentAt - ask.since)} without one`
        : 'an update or WAIT'

// What the request came to, in a few words.
const outcomeOf = (request: DebugRequest) => {
  const { reply } = request

  if (reply !== null && 'update' in reply) return `update: ${reply.update.gist}`
  if (reply !== null) return reply.wait === '' ? 'WAIT' : `WAIT: ${reply.wait}`
  if (request.isAborted) return 'cut: the summary was turned off'

  return `failed: ${request.failure}`
}

// The request in one line of the transcript.
const debugLine = (request: DebugRequest) =>
  clip(
    `Summary debug: ${notesRead(request)}, ${formatChars(request.prompt.length)}${
      request.ask.isRecap ? ', recap' : request.ask.isForced ? ', WAIT not allowed' : ''
    } → ${outcomeOf(request)}`,
    300,
  )

const debugHeader = (sessionId: string) =>
  [
    '# Summary debug log',
    '',
    `Session \`${sessionId}\`: each request the Session Weather mod sent ${HAIKU_NAME} for its thinking summary, as sent, and the reply, oldest first; the last ${DEBUG_REQUESTS} are kept. \`/${DEBUG_COMMAND}\` turns it off.`,
    '',
    `The system prompt, \`${system.mark}\`, which each request names by that mark (Claude Code puts its own identity block before it):`,
    '',
    fenced(system.text),
    '',
    '',
  ].join('\n')

// One request's entry: when and what it asked, what came of it, then the
// prompt and the reply as they were.
const debugEntry = (request: DebugRequest) => {
  const { result } = request
  const usage = result?.usage
  const spent =
    usage === undefined
      ? ''
      : `; ${inputTokens(usage)} tokens in, ${usage.output_tokens} out, $${haikuCost(usage).toFixed(5)}`

  return [
    `<!-- request ${new Date(request.sentAt).toISOString()} -->`,
    `## ${formatClock(request.sentAt)} · ${intoTurn(request.turn, request.sentAt)} into turn \`${request.turn.turnId}\``,
    '',
    `- Asked for ${askedFor(request)}: ${notesRead(request)} of the turn, ${formatChars(request.prompt.length)}, system prompt \`${system.mark}\`.`,
    `- Answered in ${((request.answeredAt - request.sentAt) / 1000).toFixed(1)} s${spent}.`,
    `- Outcome: ${outcomeOf(request)}`,
    '',
    '### Prompt',
    '',
    fenced(request.prompt),
    '',
    '### Reply',
    '',
    result?.isAnswered ? fenced(result.text) : `(no reply: ${request.failure})`,
    '',
    '',
  ].join('\n')
}

// The debug log's writes, one at a time: each reads the file and writes it
// whole.
let debugging: Promise<void> = Promise.resolve()

// A request into the transcript and the file. The person asked for the log:
// a file it cannot write is said in the transcript too.
export function logDebug($: EngineInterface, request: DebugRequest) {
  tell($, debugLine(request))

  debugging = debugging
    .then(() =>
      rewrite($, DEBUG_FOLDER, (text, sessionId) => {
        const entries = [...debugEntries(text), debugEntry(request)].slice(-DEBUG_REQUESTS)

        return `${debugHeader(sessionId)}${entries.join('')}`
      }),
    )
    .catch((error: unknown) => tell($, `Summary debug log not written: ${messageOf(error)}`))

  return debugging
}
