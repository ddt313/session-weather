// What the test files share: the engine beneath the mod, and the readings,
// turns and drawings they raise and read.

import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const measure = (tokens: number, percent: number) => ({
  context: { tokens, window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

export const measureLimits = (rateLimits: unknown[]) => ({
  context: { window: 200_000 },
  rateLimits,
  changed: ['rateLimits' as const],
})

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const NOW = Date.parse('2026-10-15T01:00:00Z')
// Half a minute past a whole minute, so the counts read the same until the
// clock moves a full minute.
export const at = (ms: number) => new Date(NOW + ms + 30_000).toISOString()

export const limits = (weekUsed: number) => [
  { kind: 'seven_day', percentUsed: weekUsed, resetsAt: at(2 * DAY + 5 * HOUR) },
  { kind: 'five_hour', percentUsed: 3.4, resetsAt: at(3 * HOUR + 26 * MINUTE) },
]

// A compaction leaves at least one message: its summary.
export const SUMMARY = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]

// From this many columns the mod lays the pane out in two: the weather on
// the left, the thinking summary beside it.
export const WIDE_FROM = 90

const PANE = {
  component: 'Pane',
  requestId: 'session-weather',
  props: {
    title: 'Session Weather',
    isFocused: false,
    // Wide, so an update's lines draw one row each, yet a column short of
    // WIDE_FROM: one column, the weather above the summary. The tests of
    // rows lay the pane out narrower, the tests of two columns wider.
    bodyColumns: WIDE_FROM - 1,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

export const bar = (filled: number) => '█'.repeat(filled) + '░'.repeat(20 - filled)

// The terminal's bars, drawn as a Raster: the inks by name, as the mod packs
// them.
const INKS: Readonly<Record<number, string>> = {
  0x4a4a4a: 'track',
  0x9a9a9a: 'others',
  0xf5b731: 'amber',
  0xe5484d: 'red',
  0xd8d8d8: 'mark',
  0x8a8a8a: 'grey',
  0x00aeef: 'sky',
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const bytesOf = (text: string) => {
  const bits = [...text.replace(/=+$/, '')].map(ch => BASE64.indexOf(ch))
  const out: number[] = []

  for (let at = 0; at + 1 < bits.length; at += 4) {
    const n = ((bits[at] ?? 0) << 18) | ((bits[at + 1] ?? 0) << 12) | ((bits[at + 2] ?? 0) << 6) | (bits[at + 3] ?? 0)
    out.push((n >> 16) & 255)
    if (at + 2 < bits.length) out.push((n >> 8) & 255)
    if (at + 3 < bits.length) out.push(n & 255)
  }

  return out
}

// A Raster's cells read back, its runs of one glyph in one ink together:
// "amber━2 track━18", a mark "mark┃1".
export const cellsShown = (cells: string) => {
  const bytes = bytesOf(cells)
  const words: number[] = []

  for (let at = 0; at + 3 < bytes.length; at += 4) {
    words.push(((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0)
  }

  const runs: { name: string; count: number }[] = []

  for (let at = 0; at + 2 < words.length; at += 3) {
    const name = `${INKS[words[at + 1] ?? 0] ?? (words[at + 1] ?? 0).toString(16)}${String.fromCodePoint(words[at] ?? 0x20)}`
    const last = runs.at(-1)

    if (last?.name === name) last.count += 1
    else runs.push({ name, count: 1 })
  }

  return runs.map(run => `${run.name}${run.count}`).join(' ')
}

// The summary in Vietnamese, as a setting: the tests whose replies and pane
// read in it. The default is English.
export const VIETNAMESE = { options: { summaryLanguage: 'Vietnamese' } }

// A pane opened unasked is placed from this many terminal columns.
const UNASKED_FLOOR = 144

// Stands for the engine beneath the mod: what it opens, redraws, toasts and
// stores; `stored` is what earlier sessions left in the mod's store, `files`
// what the disk holds (`written` when each of them was written, the test's
// start unless given), `env` the variables the process has (a home directory
// unless given), `startedAt` when the session began, `turns` how many prompts
// it has had (none unless given), `columns` how wide the terminal is (wide
// enough to place the pane unless given), and `beforeWrite` runs as a file is
// about to be written.
export const engine = (
  on: On,
  usage: {
    tokens?: number
    percent?: number
    rateLimits?: unknown[]
    stored?: Record<string, unknown>
    breakdown?: Record<string, unknown>
    cost?: number
    files?: Record<string, string>
    written?: Record<string, number>
    env?: Record<string, string>
    startedAt?: number
    turns?: number
    columns?: number
    beforeWrite?: (path: string) => Promise<unknown>
  } = {},
) => {
  // The prompts the session has had, as the engine counts them; a test moves
  // it on.
  let turns = usage.turns ?? 0
  const opens: unknown[] = []
  const toasts: string[] = []
  // The status lines the mod set, in order, undefined where it removed its
  // line; and the line under the prompt now.
  const statuses: (string | undefined)[] = []
  // The panes open, as `$.ui.panes()` lists them. One opened unasked is
  // placed only on a terminal UNASKED_FLOOR columns wide; one the person
  // asked for (`asked`), at any width.
  const panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  let columns = usage.columns ?? 200
  let isAsked = false
  // The lines the mod logged, and where to.
  const logs: { text: string; to: string }[] = []
  const writes: { key: string; value: unknown }[] = []
  // The disk, by path, when each file was last written, and the tools the
  // mod registered.
  const files = new Map(Object.entries(usage.files ?? {}))
  const mtimes = new Map([...files.keys()].map(path => [path, usage.written?.[path] ?? NOW]))
  const registered: unknown[] = []
  // The commands the mod ran on the host.
  const runs: { argv: string[]; stdin?: string }[] = []
  // The session's id; a /clear moves it on.
  let sessionId = 'session-1'
  // What each `$.turn.step` streams, in turn (a `{ wait }` holds the stream
  // that many milliseconds of the clock); what Haiku was asked, and the
  // replies it gives, in turn (a plain summary once they run out).
  const steps: unknown[][] = []
  const asks: { model: string; prompt: string; system?: string; effort?: string }[] = []
  const replies: unknown[] = []
  // The session's subagents, as `$.agent.list()` gives them; a test moves
  // their status along.
  const agents: {
    id: string
    description: string
    type: string
    status: string
    name?: string
    parentId?: string
    spawnedBy?: string
  }[] = []
  let redraws = 0
  const { tokens, percent, rateLimits = [], stored = {}, cost } = usage
  const clock = mock.clock(on, { now: NOW })
  const store = new Map(Object.entries(stored))

  on('turn.step', async function* ($, e) {
    // What the response read and wrote, as its stop says.
    let usage: unknown = null

    for (const chunk of steps.shift() ?? []) {
      const wait = (chunk as { wait?: number }).wait

      if (wait !== undefined) {
        await clock.sleep(wait)
        continue
      }

      if ((chunk as { kind?: string }).kind === 'stop') usage = (chunk as { usage?: unknown }).usage ?? null

      yield chunk as never
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: usage as never }
  })
  // A `{ wait, reply }` comes back that many milliseconds of the clock late.
  on('model.complete', async ($, e) => {
    asks.push({ model: e.model, prompt: e.prompt, system: e.system, effort: e.effort })
    const reply = replies.shift() ?? answer(PLAIN)
    const held = reply as { wait?: number; reply?: unknown }

    if (held.wait !== undefined) {
      await clock.sleep(held.wait)

      return { value: held.reply as never }
    }

    return { value: reply as never }
  })

  on('session.usage', ($, e) => ({
    value: {
      startedAt: usage.startedAt ?? 0,
      context: {
        window: 200_000,
        ...(tokens === undefined ? {} : { tokens, percent }),
        ...(e.breakdown !== undefined && usage.breakdown !== undefined ? { breakdown: usage.breakdown } : {}),
      },
      rateLimits,
      ...(cost === undefined ? {} : { cost: { usd: cost } }),
    },
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin }))
  on('agent.list', () => ({ value: agents as never }))
  on('tool.call', () => ({ deny: 'not run in this test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.open', ($, e) => {
    opens.push(e)
    const isPlaced = isAsked || columns >= UNASKED_FLOOR || panes.some(pane => pane.id === e.id && pane.isPlaced)
    const others = panes.filter(pane => pane.id !== e.id)
    panes.splice(0, panes.length, ...others, { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced })

    return {
      value: isPlaced
        ? { isPlaced: true as const }
        : { isPlaced: false as const, reason: `${columns} columns; a pane opened unasked is placed from ${UNASKED_FLOOR}` },
    }
  })
  on('ui.panes', () => ({ value: panes.map(pane => ({ ...pane })) }))
  // The mod closing its pane: it goes from the engine's record.
  on('ui.close', ($, e) => {
    const open = panes.filter(pane => pane.id !== e.id)
    panes.splice(0, panes.length, ...open)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.invalidate', () => {
    redraws += 1

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    writes.push({ key: e.key, value: e.value })

    return { value: undefined }
  })

  // The engine hands the file hooks a path made absolute on the host: on
  // Windows `/home/me` comes as `C:\home\me`. The disk keys it the POSIX way.
  const key = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')

  mock.env(on, usage.env ?? { HOME: '/home/me' })
  on('session.id', () => ({ value: sessionId }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.turns', () => ({ value: turns }))
  on('fs.exists', ($, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', ($, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.write', async ($, e) => {
    await usage.beforeWrite?.(key(e.path))
    files.set(key(e.path), e.text)
    mtimes.set(key(e.path), clock.now())

    return { value: undefined }
  })
  // The files right in a folder; none where there is no such folder.
  on('fs.list', ($, e) => {
    const dir = key(e.path).replace(/\/+$/, '')
    const names = [...files.keys()].flatMap(path =>
      path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/') ? [path.slice(dir.length + 1)] : [],
    )

    return {
      value: names.map(name => ({
        name,
        kind: 'file' as const,
        size: (files.get(`${dir}/${name}`) ?? '').length,
        mtimeMs: mtimes.get(`${dir}/${name}`) ?? NOW,
        isLink: false,
      })),
    }
  })
  // A command the mod runs, kept in turn: deleting files, rm's after its
  // `--` or PowerShell's on its input, which the disk then lets go.
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    const paths = e.argv[0] === 'rm' ? e.argv.slice(e.argv.indexOf('--') + 1) : (e.init?.stdin ?? '').split('\n')

    for (const path of paths) {
      files.delete(key(path))
      mtimes.delete(key(path))
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.register', ($, e, next) => {
    registered.push(e)

    return next(e)
  })

  return {
    clock,
    opens,
    toasts,
    statuses,
    status: () => statuses.at(-1),
    panes,
    // What `work` opens, the person asked for, as with a command they typed.
    asked: async <T,>(work: () => Promise<T>) => {
      isAsked = true

      try {
        return await work()
      } finally {
        isAsked = false
      }
    },
    // The person closing the pane. The test kit raises no `ui.close` of the
    // person's (nor lets a test's hook close a pane), so the pane leaves the
    // engine's record alone: the mod finds it gone at its next look.
    closeByHand: () => {
      const open = panes.filter(pane => pane.id !== 'session-weather')
      panes.splice(0, panes.length, ...open)
    },
    // The terminal resized: a pane waiting undrawn is placed once it is wide
    // enough.
    resize: (to: number) => {
      columns = to

      for (const pane of panes) pane.isPlaced ||= columns >= UNASKED_FLOOR
    },
    logs,
    writes,
    steps,
    asks,
    replies,
    agents,
    files,
    store,
    registered,
    runs,
    redraws: () => redraws,
    // Another session writes its file, or this one's own changes, now.
    write: (path: string, text: string) => {
      files.set(path, text)
      mtimes.set(path, clock.now())
    },
    // The session goes on under another id, as after a /clear.
    useSession: (id: string) => {
      sessionId = id
    },
    // The person sends the session another prompt, or a /clear starts the
    // count over.
    setTurns: (count: number) => {
      turns = count
    },
  }
}

export const start = { cwd: '/tmp', surface: 'desktop' as const, isInteractive: true }

export type Found = { props: Record<string, unknown>; text: string }
type Mounted = {
  find: (q: { type?: string; key?: string }) => Promise<Found | undefined>
  findAll: (q: { type: string }) => Promise<{ text: string }[]>
  unmount: () => Promise<void>
}
export type Test$ = { ui: { mount: (target: never) => Promise<unknown>; press: (target: never) => Promise<unknown> } }

// The pane drawn on `surface`, `columns` wide when given, and with `props`
// over the fixture's (a placement, a body's rows).
export const mount = async (
  $: Test$,
  surface: 'desktop' | 'terminal' = 'terminal',
  columns?: number,
  props: Record<string, unknown> = {},
) =>
  (await $.ui.mount({
    plugin: 'session-weather',
    surface,
    ...PANE,
    props: { ...PANE.props, ...(columns === undefined ? {} : { bodyColumns: columns }), ...props },
  } as never)) as Mounted

// Everything the pane shows, one string per Text, on the surface named, in a
// pane `columns` wide when given, with `props` over the fixture's.
export const allTexts = async (
  $: Test$,
  surface: 'desktop' | 'terminal' = 'terminal',
  columns?: number,
  props: Record<string, unknown> = {},
) => {
  const ui = await mount($, surface, columns, props)
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()

  return texts
}

// Where the thinking summary begins: its header, or the line saying it is off.
const SUMMARY_TOP = (text: string) => text.startsWith('🧭')

// The weather: what the pane shows above the thinking summary, or beside it,
// in a pane `columns` wide when given.
export const pane = async ($: Test$, surface: 'desktop' | 'terminal' = 'terminal', columns?: number) => {
  const texts = await allTexts($, surface, columns)
  const top = texts.findIndex(SUMMARY_TOP)

  return top === -1 ? texts : texts.slice(0, top)
}

// The thinking summary, from its header down, in a pane `columns` wide when
// given.
export const thoughts = async ($: Test$, surface: 'desktop' | 'terminal' = 'terminal', columns?: number) => {
  const texts = await allTexts($, surface, columns)
  const top = texts.findIndex(SUMMARY_TOP)

  return top === -1 ? [] : texts.slice(top)
}

// The labels of the pane's Buttons, with `props` over the fixture's.
export const buttons = async ($: Test$, props: Record<string, unknown> = {}) => {
  const ui = await mount($, 'terminal', undefined, props)
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return labels
}

// The person pressing a Button of the pane, by its key, in a pane `columns`
// wide when given.
export const press = async ($: Test$, key: string, columns?: number) => {
  const ui = await mount($, 'terminal', columns)
  await $.ui.press({ plugin: 'session-weather', key } as never)
  await ui.unmount()
}


// Haiku's answer; 10k tokens in and 2k out cost $0.002.
const USAGE = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const answer = (text: string) => ({ isAnswered: true, text, usage: USAGE })
export const PLAIN = 'GIST: Claude đang sửa lỗi.'

// A request the API refused for the rate limit.
export const RATE_LIMITED = {
  isAnswered: false,
  reason: 'api-error',
  status: 429,
  error: 'rate_limit',
  usage: { ...USAGE, input_tokens: 0, output_tokens: 0 },
}

// The line that ends a request where Haiku may not reply WAIT.
export const NO_WAIT = 'WAIT is not allowed this time.'

// The rule the pane draws between two updates: box drawing across the body.
// Inside the thinking card's border and padding, 4 columns of the body's.
export const RULE = '─'.repeat(PANE.props.bodyColumns - 4 - 1)

// A prompt with each note's time taken out, for the tests that read what the
// notes say rather than when they came.
export const plain = (prompt: string | undefined) => (prompt ?? '').replace(/<note at="[^"]*">/g, '<note>')

// What a prompt holds between <tag> and </tag>, its notes without their
// times, or '' where it has none.
export const tagged = (prompt: string | undefined, tag: string) => {
  const text = plain(prompt)
  const open = text.indexOf(`<${tag}>\n`)
  const close = text.indexOf(`\n</${tag}>`, open)

  return open === -1 || close === -1 ? '' : text.slice(open + tag.length + 3, close)
}

// Pieces of one streamed response.
export const thought = (index: number, text: string) => ({ kind: 'thinking', index, text })
export const toolStart = (index: number) => ({ kind: 'tool', index, id: `toolu_${index}`, name: 'Read' })
export const toolInput = (index: number) => ({ kind: 'input', index, json: '{"file_path":"a.ts"}' })
export const stop = { kind: 'stop', stopReason: 'tool_use', usage: null }

// What a model request read and wrote, as the API reports it: `input`
// uncached, `cached` served by the cache, `output` generated.
export const requestUsage = (input: number, cached: number, output: number, model = 'claude-opus-5-5') => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: 0,
  model,
})

// The stop of a response that read and wrote `usage`.
export const stopWith = (usage: ReturnType<typeof requestUsage>) => ({ kind: 'stop', stopReason: 'tool_use', usage })

// Streams one model request of a turn through the mod, as the engine
// queued it, and gives back what came out the top: inside the subagent
// `agentId` when given, at the `effort` given.
export const runStep = async (
  $: { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } } },
  queue: unknown[][],
  turnId: string,
  chunks: unknown[],
  agentId?: string,
  effort?: string,
) => {
  queue.push(chunks)
  const stream = $.turn.step({
    turnId,
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 3,
    ...(agentId ? { agentId } : {}),
    ...(effort ? { effort } : {}),
  } as never)
  const out: unknown[] = []

  for await (const chunk of stream) {
    out.push(chunk)
  }

  await stream.result

  return out
}

export const SECOND = 1000

// The terminal pane's bars, by their Raster's key ("bar-context",
// "bar-five_hour"), each its cells read back; in a pane `columns` wide when
// given.
export const barsShown = async ($: Test$, columns?: number) => {
  const ui = await mount($, 'terminal', columns)
  const rasters = (await ui.findAll({ type: 'Raster' })) as unknown as { props: { key?: string; columns: number; cells: string } }[]
  await ui.unmount()

  return Object.fromEntries(rasters.map(one => [one.props.key ?? '', cellsShown(one.props.cells)]))
}

// The pane's limits under "Usage limits": each Text's shown text, with its
// color where it has one, or [dim]; in a pane `columns` wide when given.
export const limitsShown = async ($: Test$, surface: 'desktop' | 'terminal' = 'terminal', columns?: number) => {
  const ui = await mount($, surface, columns)
  const texts = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: { color?: string; dimColor?: boolean } }[]
  await ui.unmount()
  const top = texts.findIndex(one => one.text === 'Usage limits')
  // A window's line, its part, its bar and the bar's runs, until what comes
  // after the limits.
  const isLimit = (text: string) => /^(?:5h |Week |this session|[█░│]| ?[~>])/.test(text)
  const end = texts.findIndex((one, at) => at > top && !isLimit(one.text))

  return texts
    .slice(top + 1, end === -1 ? undefined : end)
    .map(one => `${one.text}${one.props.color !== undefined ? ` [${one.props.color}]` : one.props.dimColor ? ' [dim]' : ''}`)
}

// A main-loop turn of 2m 14s whose input the cache served at 96%.
export const turnDone = (overrides: Record<string, unknown> = {}) => ({
  reason: 'answer' as const,
  answer: 'Done.',
  durationMs: 134_000,
  isAborted: false,
  turnId: 't1',
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 0,
    model: 'claude-opus-5-5',
  },
  ...overrides,
})

// A turn of one update, asked a second in, that ends two seconds in.
export const oneTurn = async (
  $: Parameters<typeof runStep>[0] & { turn: { start: (e: never) => Promise<unknown>; complete: (e: never) => Promise<unknown> } },
  steps: unknown[][],
  clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> },
  turnId: string,
  text: string,
) => {
  await $.turn.start({ text, turnId } as never)
  await runStep($, steps, turnId, [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ turnId, durationMs: 2_000 }) as never)
  await clock.settle()
}

// The windows the wide layout's additions were asked from: the 5-hour window
// 11% used with 2h 22m left, 53% of its time gone; the week 75% used with
// 18h 52m left, 89% of it gone.
export const PACED = [
  { kind: 'five_hour', percentUsed: 11, resetsAt: at(2 * HOUR + 22 * MINUTE) },
  { kind: 'seven_day', percentUsed: 75, resetsAt: at(18 * HOUR + 52 * MINUTE) },
]

// A row of the window's breakdown: what it is, its tokens, and its kind.
export const category = (name: string, tokens: number, kind = 'used') => ({
  name,
  tokens,
  color: 'inactive',
  isDeferred: kind === 'deferred',
  kind,
})

// The window's breakdown as the engine estimates it: six rows of content in
// use, and the rows that are not (tools loaded on demand, the compaction
// buffer, the free space); the model it was counted for.
export const BREAKDOWN = {
  autoCompactThreshold: 184_000,
  isAutoCompactEnabled: true,
  model: 'claude-fable-5-2',
  categories: [
    category('System prompt', 3_200),
    category('System tools', 17_100),
    category('MCP tools', 1_400),
    category('Memory files', 2_400),
    category('Skills', 900),
    category('Messages', 64_000),
    category('MCP tools (deferred)', 30_000, 'deferred'),
    category('Autocompact buffer', 16_000, 'buffer'),
    category('Free space', 95_000, 'free'),
  ],
}

// "08:00", the host's time at `ms`.
export const clockOf = (ms: number) => `${two(new Date(ms).getHours())}:${two(new Date(ms).getMinutes())}`

// The weather from WIDE_FROM columns down to its session's line: what stands
// above the subagents at work and the recent turns.
export const sessionShown = async ($: Test$, surface: 'desktop' | 'terminal') => {
  const texts = await pane($, surface, WIDE_FROM)
  const end = texts.findIndex(text => text.startsWith('Subagents') || text === 'Recent turns')

  return end === -1 ? texts : texts.slice(0, end)
}

// The session ended, as by a /clear.
export const endSession = async ($: unknown, reason: string) =>
  ($ as { session: { end: (e: unknown) => Promise<unknown> } }).session.end({
    reason,
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })

// The recent turns' rows, newest first, as the Buttons of a pane `columns`
// wide label them.
export const turnRows = async ($: Test$, surface: 'desktop' | 'terminal', columns = WIDE_FROM) => {
  const ui = await mount($, surface, columns)
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return labels.filter(text => /^(?:▸ )?\d\d:\d\d · /.test(text))
}

// The mod's folder of files, and the file a saved session's turns go to.
export const MOD_FILES = '/home/me/.claude/session-weather'
export const SAVED = `${MOD_FILES}/turns/session-1.json`

// The summary's debug log, under the home directory the engine's process has.
export const DEBUG = '/home/me/.claude/session-weather/debug/session-1.md'

// The session's log, under the home directory the engine's process has.
export const LOG = '/home/me/.claude/session-weather/thinking/session-1.md'

export const two = (n: number) => String(n).padStart(2, '0')

// A section's time, as the host's clock reads it, its offset said.
export const when = (ms: number) => {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()

  return [
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    `${two(date.getHours())}:${two(date.getMinutes())}`,
    `UTC${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`,
  ].join(' ')
}

// One turn's section of a log, from its mark to the next one.
export const sectionOf = (text: string, turnId: string) => {
  const at = text.indexOf(`<!-- turn ${turnId} -->\n`)
  const next = text.indexOf('\n<!-- turn ', at + 1)

  return at === -1 ? '' : text.slice(at, next === -1 ? undefined : next + 1)
}

// A subagent of the main loop's, at work, as `$.agent.list()` gives it.
export const subagent = (id: string) => ({ id, description: `review ${id}`, type: 'general-purpose', status: 'running' })

// A prompt as `prompt.submit` takes it: the person's own, typed while the
// session was idle, unless `origin` and `turnId` say otherwise.
export const submit = (text: string, origin: Record<string, unknown> = { kind: 'composer' }, turnId?: string) =>
  ({ text, origin, wait: false, ...(turnId === undefined ? {} : { turnId }) }) as never

// A subagent's report as the engine hands it back to the main loop: another
// Claude session's message, which begins a turn of its own.
export const handBack = (agentId: string) =>
  `<agent-message from="${agentId}"> [Subagent hand-back] The report follows:\n  Found two issues.`

// A turn a background message begins, as the engine raises it: a subagent's
// hand-back unless `kind` says otherwise.
export const resume = async (
  $: { prompt: { submit: (e: never) => Promise<unknown> }; turn: { start: (e: never) => Promise<unknown> } },
  text: string,
  turnId: string,
  kind = 'peer',
) => {
  await $.prompt.submit(submit(text, { kind }))
  await $.turn.start({ text, turnId } as never)
}

// The desktop pane under WIDE_FROM columns, `columns` wide (`bodyRows` tall
// where given, else the fixture's 30): each Text's words, each Svg's alt
// and markup, and each Button's words, in order.
export const desk = async ($: Test$, columns = 60, bodyRows?: number) => {
  const ui = await mount($, 'desktop', columns, bodyRows === undefined ? {} : { scroll: { offset: 0, bodyRows } })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const svgs = ((await ui.findAll({ type: 'Svg' })) as unknown as Found[]).map(one => ({
    alt: String(one.props.alt),
    source: String(one.props.source),
  }))
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return { texts, alts: svgs.map(one => one.alt), svgs, labels }
}

// The person pressing a Button of the desktop pane, `columns` wide (under
// WIDE_FROM unless given), `bodyRows` tall where given.
export const pressDesk = async ($: Test$, key: string, columns = 60, bodyRows?: number) => {
  const ui = await mount($, 'desktop', columns, bodyRows === undefined ? {} : { scroll: { offset: 0, bodyRows } })
  await $.ui.press({ plugin: 'session-weather', key } as never)
  await ui.unmount()
}

// Time for a test that runs long while the other files' tests run beside
// it, each file in a process of its own.
export const SLOW = { timeoutMs: 15_000 }
