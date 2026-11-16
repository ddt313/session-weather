import { expect, mock, test } from 'claude-code/testing'
import type { ConfigSetInput, ConfigValue, On } from 'claude-code'

const measure = (tokens: number, percent: number) => ({
  context: { tokens, window: 200_000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

const measureLimits = (rateLimits: unknown[]) => ({
  context: { window: 200_000 },
  rateLimits,
  changed: ['rateLimits' as const],
})

const compacted = {
  context: { window: 200_000 },
  rateLimits: [],
  changed: ['context' as const],
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-15T01:00:00Z')
// Half a minute past a whole minute, so the counts read the same until the
// clock moves a full minute.
const at = (ms: number) => new Date(NOW + ms + 30_000).toISOString()

const limits = (weekUsed: number) => [
  { kind: 'seven_day', percentUsed: weekUsed, resetsAt: at(2 * DAY + 5 * HOUR) },
  { kind: 'five_hour', percentUsed: 3.4, resetsAt: at(3 * HOUR + 26 * MINUTE) },
]

// A compaction leaves at least one message: its summary.
const SUMMARY = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]

// From this many columns the mod lays the pane out in two: the weather on
// the left, the thinking summary beside it.
const WIDE_FROM = 90

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

const bar = (filled: number) => '█'.repeat(filled) + '░'.repeat(20 - filled)

// The summary in Vietnamese, as a setting: the tests whose replies and pane
// read in it. The default is English.
const VIETNAMESE = { options: { summaryLanguage: 'Vietnamese' } }

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
const engine = (
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
    for (const chunk of steps.shift() ?? []) {
      const wait = (chunk as { wait?: number }).wait

      if (wait !== undefined) {
        await clock.sleep(wait)
        continue
      }

      yield chunk as never
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
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

const start = { cwd: '/tmp', surface: 'desktop' as const, isInteractive: true }

type Found = { props: Record<string, unknown>; text: string }
type Mounted = {
  find: (q: { type?: string; key?: string }) => Promise<Found | undefined>
  findAll: (q: { type: string }) => Promise<{ text: string }[]>
  unmount: () => Promise<void>
}
type Test$ = { ui: { mount: (target: never) => Promise<unknown>; press: (target: never) => Promise<unknown> } }

// The pane drawn on `surface`, `columns` wide when given, and with `props`
// over the fixture's (a placement, a body's rows).
const mount = async (
  $: Test$,
  surface: 'desktop' | 'terminal' = 'desktop',
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
const allTexts = async (
  $: Test$,
  surface: 'desktop' | 'terminal' = 'desktop',
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
const pane = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop', columns?: number) => {
  const texts = await allTexts($, surface, columns)
  const top = texts.findIndex(SUMMARY_TOP)

  return top === -1 ? texts : texts.slice(0, top)
}

// The thinking summary, from its header down, in a pane `columns` wide when
// given.
const thoughts = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop', columns?: number) => {
  const texts = await allTexts($, surface, columns)
  const top = texts.findIndex(SUMMARY_TOP)

  return top === -1 ? [] : texts.slice(top)
}

// The labels of the pane's Buttons, with `props` over the fixture's.
const buttons = async ($: Test$, props: Record<string, unknown> = {}) => {
  const ui = await mount($, 'desktop', undefined, props)
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return labels
}

// How the pane lays out `columns` wide on `surface`: which way its outer Box
// runs, how wide the weather's column is (undefined in one column), and what
// the weather and the summary's own column (undefined in one column) show.
const layout = async ($: Test$, surface: 'desktop' | 'terminal', columns: number) => {
  const ui = await mount($, surface, columns)
  const outer = await ui.find({ type: 'Box' })
  const weather = await ui.find({ key: 'weather' })
  const summary = await ui.find({ key: 'summary' })
  await ui.unmount()

  return {
    direction: outer?.props.flexDirection,
    weatherWidth: weather?.props.width,
    weather: weather?.text,
    summary: summary?.text,
  }
}

// The lines of `part` that `whole` lacks, each looked for after the one
// before it was found: none where `whole` holds them all in that order, with
// any others between them.
const missingFrom = (part: readonly string[], whole: readonly string[]) => {
  let from = 0

  return part.filter(line => {
    const found = whole.indexOf(line, from)

    if (found === -1) return true

    from = found + 1

    return false
  })
}

// The pane minimized to a widget on the desktop app, anchored in the chat's
// bottom right corner unless `props` say otherwise.
const WIDGET = { placement: 'widget', anchoredEdges: ['bottom', 'right'] }

// The person pressing a Button of the pane, by its key, in a pane `columns`
// wide when given.
const press = async ($: Test$, key: string, columns?: number) => {
  const ui = await mount($, 'desktop', columns)
  await $.ui.press({ plugin: 'session-weather', key } as never)
  await ui.unmount()
}


// Haiku's answer; 10k tokens in and 2k out cost $0.002.
const USAGE = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answer = (text: string) => ({ isAnswered: true, text, usage: USAGE })
const PLAIN = 'GIST: Claude đang sửa lỗi.'

// A request the API refused for the rate limit.
const RATE_LIMITED = {
  isAnswered: false,
  reason: 'api-error',
  status: 429,
  error: 'rate_limit',
  usage: { ...USAGE, input_tokens: 0, output_tokens: 0 },
}

// The line that ends a request where Haiku may not reply WAIT.
const NO_WAIT = 'WAIT is not allowed this time.'

// The rule the pane draws between two updates: box drawing across the body.
const RULE = '─'.repeat(PANE.props.bodyColumns - 1)

// A prompt with each note's time taken out, for the tests that read what the
// notes say rather than when they came.
const plain = (prompt: string | undefined) => (prompt ?? '').replace(/<note at="[^"]*">/g, '<note>')

// What a prompt holds between <tag> and </tag>, its notes without their
// times, or '' where it has none.
const tagged = (prompt: string | undefined, tag: string) => {
  const text = plain(prompt)
  const open = text.indexOf(`<${tag}>\n`)
  const close = text.indexOf(`\n</${tag}>`, open)

  return open === -1 || close === -1 ? '' : text.slice(open + tag.length + 3, close)
}

// Pieces of one streamed response.
const thought = (index: number, text: string) => ({ kind: 'thinking', index, text })
const words = (index: number, text: string) => ({ kind: 'text', index, text })
const toolStart = (index: number) => ({ kind: 'tool', index, id: `toolu_${index}`, name: 'Read' })
const toolInput = (index: number) => ({ kind: 'input', index, json: '{"file_path":"a.ts"}' })
const stop = { kind: 'stop', stopReason: 'tool_use', usage: null }

// Streams one model request of a turn through the mod, as the engine
// queued it, and gives back what came out the top.
const runStep = async (
  $: { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } } },
  queue: unknown[][],
  turnId: string,
  chunks: unknown[],
  agentId?: string,
) => {
  queue.push(chunks)
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) } as never)
  const out: unknown[] = []

  for await (const chunk of stream) {
    out.push(chunk)
  }

  await stream.result

  return out
}

const SECOND = 1000

test('the pane opens as the session starts, with the weather, its fill, the growth and the limits', async ($, on) => {
  const { opens } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  expect(opens).toEqual([{ id: 'session-weather', title: 'Session Weather', rows: 12 }])

  await $.session.measure(measure(90_000, 45))

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await pane($, surface)).toEqual([
      '☁ Cloudy',
      '45% of context · 90k / 200k',
      bar(9),
      'Last turn ▲ +90k',
      'Usage limits',
      '5h 3% · reset in 3h 26m',
      bar(1),
      'Week 25% · reset in 2d 5h',
      bar(5),
    ])
  }
})

test('the forecast follows the table, edge by edge', async ($, on) => {
  engine(on)

  const table = [
    [0, '☀ Clear'],
    [24, '☀ Clear'],
    [25, '☁ Cloudy'],
    [49, '☁ Cloudy'],
    [50, '☂ Showers'],
    [74, '☂ Showers'],
    [75, '☇ Storm'],
    [89, '☇ Storm'],
    [90, 'ϟ Compact soon'],
    [100, 'ϟ Compact soon'],
  ] as const

  for (const [percent, sky] of table) {
    await $.session.measure(measure(percent * 2_000, percent))
    expect([percent, (await pane($))[0]]).toEqual([percent, sky])
  }
})

test('a session before its first response waits for the fill', async ($, on) => {
  engine(on)

  await $.session.start(start)
  expect(await pane($)).toEqual(['Context: waiting for the first response.'])
})

test('the countdowns redraw the pane each minute they change, and only then', async ($, on) => {
  const { clock, redraws } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  await clock.advance(MINUTE)
  expect(await pane($)).toContain('5h 3% · reset in 3h 25m')
  const after = redraws()

  // "3h 25m" turns "3h 24m": a redraw. Each minute of the 5-hour window does.
  await clock.advance(MINUTE)
  expect(redraws()).toBe(after + 1)
})

test('a week alone, whose count holds for an hour, redraws nothing minute to minute', async ($, on) => {
  const { clock, redraws } = engine(on, {
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: at(2 * DAY + 5 * HOUR + 30 * MINUTE) }],
  })

  await $.session.start(start)
  await clock.advance(MINUTE)
  const after = redraws()

  await clock.advance(5 * MINUTE)
  expect(redraws()).toBe(after)
  expect(await pane($)).toContain('Week 40% · reset in 2d 5h')
})

test('a session opened before its first response shows the limits stored by the last', async ($, on) => {
  engine(on, { stored: { limits: limits(25) } })

  await $.session.start(start)
  expect(await pane($)).toContain('Week 25% · reset in 2d 5h')

  await $.session.measure(measureLimits(limits(27)))
  expect(await pane($)).toContain('Week 27% · reset in 2d 5h')
})

test('each fresh reading is stored for the next session', async ($, on) => {
  const { writes } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  expect(writes).toEqual([{ key: 'limits', value: limits(25) }])

  await $.session.measure(measureLimits(limits(28)))
  expect(writes.at(-1)).toEqual({ key: 'limits', value: limits(28) })
})

test('a window past its reset is left out until the next reading', async ($, on) => {
  engine(on, {
    stored: {
      limits: [
        { kind: 'five_hour', percentUsed: 80, resetsAt: new Date(NOW - HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 25, resetsAt: at(2 * DAY + 5 * HOUR) },
      ],
    },
  })

  await $.session.start(start)
  const texts = await pane($)
  expect(texts).toContain('Week 25% · reset in 2d 5h')
  expect(texts.some(text => text.startsWith('5h'))).toBe(false)
})

// What each session spent, in a file of its own in the mod's folder: spans
// of [from, to, dollars], and the session's total cost they count up to.
const SPEND = '/home/me/.claude/session-weather/spend'
type Span = [number, number, number]
const spendFile = (spans: Span[], seen?: number) => JSON.stringify({ ...(seen === undefined ? {} : { seen }), spans })
const spendOf = (files: Map<string, string>, id = 'session-1') =>
  JSON.parse(files.get(`${SPEND}/${id}.json`) ?? 'null') as { seen?: number; spans: Span[] } | null

// The minute `ms` falls in, as a span that spent `usd`.
const minuteOf = (ms: number, usd: number): Span => {
  const from = Math.floor(ms / MINUTE) * MINUTE

  return [from, from + MINUTE, usd]
}

// A 5-hour window that began two hours ago, 30% used, and a week that began
// five days ago, 12% used.
const LIVE = [
  { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
  { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 2 * DAY).toISOString() },
]

// Another session, its file written an hour ago: $3 then, in both windows;
// $16 three days ago, in the week alone; $50 eight days ago, in neither.
const OTHER = `${SPEND}/other.json`
const OTHER_SPANS: Span[] = [
  [NOW - 8 * DAY, NOW - 8 * DAY + MINUTE, 50],
  [NOW - 3 * DAY, NOW - 3 * DAY + MINUTE, 16],
  [NOW - HOUR, NOW - HOUR + MINUTE, 3],
]
const others = { files: { [OTHER]: spendFile(OTHER_SPANS, 69) }, written: { [OTHER]: NOW - HOUR } }

// The session's total cost as the engine measures it.
const spent = (usd: number) => ({ context: { window: 200_000 }, rateLimits: LIVE, cost: { usd }, changed: ['cost' as const] })

// The pane's limits under "Usage limits": each Text's shown text, with its
// color where it has one, or [dim]; in a pane `columns` wide when given.
const limitsShown = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop', columns?: number) => {
  const ui = await mount($, surface, columns)
  const texts = (await ui.findAll({ type: 'Text' })) as unknown as { text: string; props: { color?: string; dimColor?: boolean } }[]
  await ui.unmount()
  const top = texts.findIndex(one => one.text === 'Usage limits')
  // A window's line, its part, its bar and the bar's runs, until what comes
  // after the limits.
  const isLimit = (text: string) => /^(?:5h |Week |this session|[█░│]| [~>])/.test(text)
  const end = texts.findIndex((one, at) => at > top && !isLimit(one.text))

  return texts
    .slice(top + 1, end === -1 ? undefined : end)
    .map(one => `${one.text}${one.props.color !== undefined ? ` [${one.props.color}]` : one.props.dimColor ? ' [dim]' : ''}`)
}

test("this session's part of each window shows in yellow, its cells the last of the bar's filled ones", async ($, on) => {
  const { clock } = engine(on, { rateLimits: LIVE, cost: 0, ...others })

  await $.session.start(start)
  await clock.settle()
  // Yet to spend in either window: the limits as they were.
  expect(await limitsShown($)).toEqual([
    '5h 30% · reset in 3h 0m',
    `${bar(6)} [dim]`,
    'Week 12% · reset in 2d 0h',
    `${bar(2)} [dim]`,
  ])

  // $1 now: a quarter of the 5-hour window's $4, 7.5 of its 30 points; a
  // twentieth of the week's $20, 0.6 of its 12.
  await $.session.measure(spent(1))
  await clock.settle()

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await limitsShown($, surface)).toEqual([
      '5h 30% · this session 8% · reset in 3h 0m',
      'this session 8% [warning]',
      bar(6),
      `${'█'.repeat(4)} [dim]`,
      `${'█'.repeat(2)} [warning]`,
      `${'░'.repeat(14)} [dim]`,
      // Under half a cell: the part shows in words alone.
      'Week 12% · this session 1% · reset in 2d 0h',
      'this session 1% [warning]',
      `${bar(2)} [dim]`,
    ])
  }
})

test('a session alone in the files takes the whole of each window: spend no file holds counts toward it', async ($, on) => {
  const { clock } = engine(on, { rateLimits: LIVE, cost: 0 })

  await $.session.start(start)
  await $.session.measure(spent(0.1))
  await clock.settle()
  expect(await limitsShown($)).toEqual([
    '5h 30% · this session 30% · reset in 3h 0m',
    'this session 30% [warning]',
    bar(6),
    `${'█'.repeat(6)} [warning]`,
    `${'░'.repeat(14)} [dim]`,
    'Week 12% · this session 12% · reset in 2d 0h',
    'this session 12% [warning]',
    bar(2),
    `${'█'.repeat(2)} [warning]`,
    `${'░'.repeat(18)} [dim]`,
  ])
})

test("the session's spend goes to a file of its own by the minute; a total that went down started over", async ($, on) => {
  const { clock, files } = engine(on, { rateLimits: LIVE, cost: 0, ...others })

  await $.session.start(start)
  await clock.settle()
  // Nothing spent, nothing written.
  expect(spendOf(files)).toBe(null)

  await $.session.measure(spent(0.5))
  await $.session.measure(spent(0.8))
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 0.8, spans: [minuteOf(NOW, 0.8)] })

  await clock.advance(2 * MINUTE)
  await $.session.measure(spent(1))
  // Down from $1 to $0.30: the total started over, and all of it is new.
  await $.session.measure(spent(0.3))
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 0.3, spans: [minuteOf(NOW, 0.8), minuteOf(NOW + 2 * MINUTE, 0.5)] })

  // Each write of its own is read back: $1.30 of the 5-hour window's $4.30
  // is 9 of its 30 points.
  expect(await pane($)).toContain('5h 30% · this session 9% · reset in 2h 58m')
})

test('a session counted for the first time, as on a reload mid-session, spreads what it spent over its life so far', async ($, on) => {
  // Begun three hours ago, $6 spent: by the even spread, $4 of it since the
  // 5-hour window began two hours ago.
  const { clock, files } = engine(on, { rateLimits: LIVE, cost: 6, startedAt: NOW - 3 * HOUR, ...others })

  await $.session.start(start)
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 6, spans: [[NOW - 3 * HOUR, NOW, 6]] })

  // $4 of the 5-hour window's $7 is 17 of its 30 points; $6 of the week's
  // $25, 2.9 of its 12.
  const texts = await pane($)
  expect(texts).toContain('5h 30% · this session 17% · reset in 3h 0m')
  expect(texts).toContain('Week 12% · this session 3% · reset in 2d 0h')

  // A reload reads what the file counted: only the spend since is new.
  await $.session.start(start)
  await $.session.measure(spent(6.5))
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 6.5, spans: [[NOW - 3 * HOUR, NOW, 6], minuteOf(NOW, 0.5)] })
})

test('what other sessions spend moves this one\'s part, read again each minute once their file is written again', async ($, on) => {
  const { clock, write } = engine(on, { rateLimits: LIVE, cost: 0, ...others })

  await $.session.start(start)
  await $.session.measure(spent(1))
  await clock.settle()
  expect(await pane($)).toContain('5h 30% · this session 8% · reset in 3h 0m')

  // The other session spends $4 more: this one's $1 is an eighth of $8.
  write(OTHER, spendFile([...OTHER_SPANS, minuteOf(NOW, 4)], 73))
  await clock.advance(MINUTE)
  expect(await pane($)).toContain('5h 30% · this session 4% · reset in 2h 59m')

  // A file caught half-written counts what it held when last read whole.
  write(OTHER, '{"seen":73,"spans":[[')
  await clock.advance(MINUTE)
  expect(await pane($)).toContain('5h 30% · this session 4% · reset in 2h 58m')
})

test("the summary's Haiku requests are this session's spend too", async ($, on) => {
  const { clock, files, steps } = engine(on, { rateLimits: LIVE })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  // One update: 10k tokens in and 2k out, $0.002. The engine gave no total
  // cost, so the file counts none.
  expect(spendOf(files)).toEqual({ spans: [minuteOf(NOW, 0.002)] })
})

test('off a subscription, where no window has a reading, no spend is kept', async ($, on) => {
  const { clock, files } = engine(on, { cost: 0 })

  await $.session.start(start)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 2 }, changed: ['cost' as const] })
  await clock.settle()
  expect([...files.keys()]).toEqual([])
})

test("after /clear the new session's spend goes on from the total the last one reached, or from nothing when it started over", async ($, on) => {
  const { clock, files, useSession } = engine(on, { rateLimits: LIVE, cost: 0 })
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))
  const clear = async (from: string, to: string) => {
    await ($ as never as { session: { end: (e: unknown) => Promise<unknown> } }).session.end({
      reason: 'clear',
      sessionId: from,
      resume: { id: from },
    })
    useSession(to)
    await clock.advance(SECOND)
  }

  await $.session.start(start)
  await $.session.measure(spent(2))
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 2, spans: [minuteOf(NOW, 2)] })

  // The engine kept counting over the /clear: of $2.50, 50 cents are new.
  await clear('session-1', 'session-2')
  await $.session.measure(spent(2.5))
  await clock.settle()
  expect(spendOf(files, 'session-2')).toEqual({ seen: 2.5, spans: [minuteOf(NOW, 0.5)] })

  // It started over: all 40 cents are new.
  await clear('session-2', 'session-3')
  await $.session.measure(spent(0.4))
  await clock.settle()
  expect(spendOf(files, 'session-3')).toEqual({ seen: 0.4, spans: [minuteOf(NOW, 0.4)] })
  expect(spendOf(files)).toEqual({ seen: 2, spans: [minuteOf(NOW, 2)] })
})

test('/compact updates the pane at once, keeps the drop for one reading, then counts on', async ($, on) => {
  engine(on)
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.measure(measure(180_000, 90))
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await pane($)).toEqual(['☀ Compacted', '▼ -160k'])

  await $.session.measure(measure(46_000, 23))
  expect(await pane($)).toContain('Last turn ▼ -160k')

  await $.session.measure(measure(51_000, 25))
  expect(await pane($)).toContain('Last turn ▲ +5k')
})

test('a precompute or a skipped compaction leaves the pane as it was', async ($, on) => {
  engine(on)
  let result: Record<string, unknown> = { messages: SUMMARY, tokensBefore: 180_000 }
  on('session.compact', () => result)

  await $.session.measure(measure(120_000, 60))
  const before = await pane($)

  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  expect(await pane($)).toEqual(before)

  result = { skip: 'nothing to compact' }
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await pane($)).toEqual(before)
})

test('a compaction the hook did not see shows, then a drop on the next turn', async ($, on) => {
  engine(on)

  await $.session.measure(measure(184_000, 92))
  await $.session.measure(compacted)
  expect(await pane($)).toEqual(['☀ Compacted'])

  await $.session.measure(measure(50_000, 25))
  expect(await pane($)).toContain('Last turn ▼ -134k')
})

test('a mod loaded mid-session counts the next turn from the fill it found', async ($, on) => {
  engine(on, { tokens: 100_000, percent: 50 })

  await $.session.start(start)
  const before = await pane($)
  expect(before[0]).toBe('☂ Showers')
  expect(before.some(text => text.startsWith('Last turn'))).toBe(false)

  await $.session.measure(measure(112_500, 56))
  expect(await pane($)).toContain('Last turn ▲ +12.5k')
})

test('a toast warns once on the way past 90%, and again after a compaction', async ($, on) => {
  const { toasts } = engine(on)

  await $.session.measure(measure(160_000, 80))
  await $.session.measure(measure(178_000, 89))
  expect(toasts).toEqual([])

  await $.session.measure(measure(180_000, 90))
  expect(toasts).toEqual(['ϟ Context 90% full (180k / 200k): time to /compact'])

  await $.session.measure(measure(190_000, 95))
  await $.session.measure(measure(60_000, 30))
  await $.session.measure(measure(176_000, 88))
  expect(toasts.length).toBe(1)

  await $.session.measure(measure(182_000, 91))
  expect(toasts.length).toBe(2)
})

test('a pane the person closed stays closed in later sessions until /session-weather', async ($, on) => {
  const { opens, writes } = engine(on, { stored: { isClosed: true } })

  await $.session.start(start)
  expect(opens).toEqual([])

  const ran = await $.command.run({ command: 'session-weather' })
  expect(ran.text).toBeUndefined()
  expect(opens).toEqual([{ id: 'session-weather', title: 'Session Weather', rows: 12 }])
  expect(writes.at(-1)).toEqual({ key: 'isClosed', value: false })
})

// The 5-hour window at 30%, resetting in 4h 38m.
const FIVE_HOUR = [{ kind: 'five_hour', percentUsed: 30.2, resetsAt: at(4 * HOUR + 38 * MINUTE) }]

// The person's /session-weather.
const command = ($: { command: { run: (e: never) => Promise<unknown> } }) =>
  $.command.run({ command: 'session-weather' } as never)

test('with the pane drawn there is no status line', async ($, on) => {
  const { clock, statuses } = engine(on, { rateLimits: FIVE_HOUR, cost: 1.234 })

  await $.session.start(start)
  await clock.settle()
  await $.session.measure(measure(84_000, 42))
  await clock.advance(MINUTE)
  expect(statuses.filter(text => text !== undefined)).toEqual([])
})

test("on a terminal too narrow for the pane, the status line carries the weather's key figures", async ($, on) => {
  const { clock, opens, panes, status } = engine(on, { columns: 120, rateLimits: FIVE_HOUR, cost: 1.234 })

  await $.session.start(start)
  await clock.settle()
  expect(opens.length).toBe(1)
  expect(panes.map(pane => pane.isPlaced)).toEqual([false])
  expect(status()).toBe('5h 30% (4h 38m) · $1.23')

  await $.session.measure(measure(84_000, 42))
  expect(status()).toBe('☁ 42% · 5h 30% (4h 38m) · $1.23')
})

test("the line's sky reads how far the fill has come toward compaction, as the pane's does", async ($, on) => {
  const { clock, status } = engine(on, {
    columns: 120,
    breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: true },
  })

  await $.session.start(start)
  await clock.settle()
  // 75% of the window, a storm by the window; 90% of the way to 167k.
  await $.session.measure(measure(150_000, 75))
  expect(status()).toBe('ϟ 75%')
})

test('a part of the line with nothing read yet is left out, and with no part there is no line', async ($, on) => {
  const { clock, statuses, status } = engine(on, { columns: 120 })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  // Before the first response: no fill, no window, no cost.
  await $.session.start(start)
  await clock.settle()
  expect(statuses.filter(text => text !== undefined)).toEqual([])

  await $.session.measure(measure(84_000, 42))
  expect(status()).toBe('☁ 42%')

  // A window with no reset known shows its share alone; the week is not shown.
  await $.session.measure(
    measureLimits([
      { kind: 'five_hour', percentUsed: 30 },
      { kind: 'seven_day', percentUsed: 60, resetsAt: at(DAY) },
    ]),
  )
  expect(status()).toBe('☁ 42% · 5h 30%')

  // Nothing spent yet is no cost to show.
  const spent = (usd: number) => ({ context: { window: 200_000 }, rateLimits: [], cost: { usd }, changed: ['cost' as const] })
  await $.session.measure(spent(0))
  expect(status()).toBe('☁ 42% · 5h 30%')
  await $.session.measure(spent(0.004))
  expect(status()).toBe('☁ 42% · 5h 30% · <$0.01')

  // Right after a compaction the fill is unknown until the next response.
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(status()).toBe('5h 30% · <$0.01')
  await $.session.measure(measure(46_000, 23))
  expect(status()).toBe('☀ 23% · 5h 30% · <$0.01')
})

test('the countdown moves the line each minute, and the line is set only when it changes', async ($, on) => {
  const { clock, statuses, status } = engine(on, { columns: 120, rateLimits: FIVE_HOUR })

  await $.session.start(start)
  await clock.settle()
  await $.session.measure(measure(84_000, 42))
  const before = statuses.length
  expect(status()).toBe('☁ 42% · 5h 30% (4h 38m)')

  await $.session.measure(measure(84_000, 42))
  expect(statuses.length).toBe(before)

  await clock.advance(MINUTE)
  expect(status()).toBe('☁ 42% · 5h 30% (4h 37m)')
  expect(statuses.length).toBe(before + 1)

  // A window half a minute from its reset; past it, the window is stale and
  // leaves the line.
  await $.session.measure(measureLimits([{ kind: 'five_hour', percentUsed: 97, resetsAt: at(MINUTE) }]))
  expect(status()).toBe('☁ 42% · 5h 97% (<1m)')
  await clock.advance(MINUTE)
  expect(status()).toBe('☁ 42%')
})

test('closed by the person, the pane leaves the line in its place; /session-weather takes it away', async ($, on) => {
  const { clock, closeByHand, status } = engine(on, { rateLimits: FIVE_HOUR, cost: 1.234 })

  await $.session.start(start)
  await clock.settle()
  await $.session.measure(measure(84_000, 42))
  expect(status()).toBeUndefined()

  // The `ui.close` hook shows the line at once; with no close the kit can
  // raise, the minute's look stands in for it.
  closeByHand()
  await clock.advance(MINUTE)
  expect(status()).toBe('☁ 42% · 5h 30% (4h 37m) · $1.23')

  // The line stays current while the pane is closed.
  await $.session.measure(measure(110_000, 55))
  expect(status()).toBe('☂ 55% · 5h 30% (4h 37m) · $1.23')

  await command($)
  expect(status()).toBeUndefined()
})

test('a pane the person closed in an earlier session: the line from the start, until /session-weather opens it at any width', async ($, on) => {
  const { asked, clock, opens, status } = engine(on, { columns: 120, rateLimits: FIVE_HOUR, stored: { isClosed: true } })

  await $.session.start(start)
  await clock.settle()
  expect(opens).toEqual([])
  expect(status()).toBe('5h 30% (4h 38m)')

  await asked(() => command($))
  expect(status()).toBeUndefined()
})

test('a pane waiting undrawn goes from the line once a wider terminal places it', async ($, on) => {
  const { clock, closeByHand, resize, status } = engine(on, { columns: 120, rateLimits: FIVE_HOUR })

  await $.session.start(start)
  await clock.settle()
  expect(status()).toBe('5h 30% (4h 38m)')

  // Still too narrow: the pane waits.
  resize(130)
  await clock.advance(MINUTE)
  expect(status()).toBe('5h 30% (4h 37m)')

  // Placed, the pane is drawn for the first time.
  resize(160)
  const ui = await mount($)
  await ui.unmount()
  await clock.settle()
  expect(status()).toBeUndefined()

  // The person closes it, and the line comes back.
  closeByHand()
  await clock.advance(MINUTE)
  expect(status()).toBe('5h 30% (4h 36m)')
})

test("a pane placed where no drawing was seen leaves the line at the next minute's look", async ($, on) => {
  const { clock, resize, status } = engine(on, { columns: 120, rateLimits: FIVE_HOUR })

  await $.session.start(start)
  await clock.settle()
  expect(status()).toBe('5h 30% (4h 38m)')

  resize(160)
  await clock.advance(MINUTE)
  expect(status()).toBeUndefined()
})

test("after /clear the line drops the old conversation's fill", async ($, on) => {
  const { clock, status, useSession } = engine(on, { columns: 120, rateLimits: FIVE_HOUR })
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))

  await $.session.start(start)
  await clock.settle()
  await $.session.measure(measure(84_000, 42))
  expect(status()).toBe('☁ 42% · 5h 30% (4h 38m)')

  await ($ as never as { session: { end: (e: unknown) => Promise<unknown> } }).session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  useSession('session-2')
  expect(status()).toBe('5h 30% (4h 38m)')

  await clock.advance(SECOND)
  expect(status()).toBe('5h 30% (4h 38m)')
})

// A main-loop turn of 2m 14s whose input the cache served at 96%.
const turnDone = (overrides: Record<string, unknown> = {}) => ({
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
const oneTurn = async (
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

test('the pane says where the engine compacts on its own, or that it does not', async ($, on) => {
  engine(on, { breakdown: { autoCompactThreshold: 184_000, isAutoCompactEnabled: true } })

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('auto-compact at 92% · 184k')
})

test('auto-compaction turned off reads so', async ($, on) => {
  engine(on, { breakdown: { isAutoCompactEnabled: false } })

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('auto-compact off')
})

test('the last turn reads its growth, length, tool calls and cache', async ($, on) => {
  engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  for (const command of ['ls', 'pwd', 'git status']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  await $.turn.complete(turnDone() as never)
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('Last turn ▲ +90k · 2m 14s · 3 tools · cache 96%')

  // A subagent's turn is not the main loop's last.
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 5_000 }) as never)
  expect(await pane($)).toContain('Last turn ▲ +90k · 2m 14s · 3 tools · cache 96%')

  // The next turn counts its own tool calls from zero, and its growth from
  // where it began: none shows, not the turn before's, until a measurement
  // reads it.
  await $.turn.start({ text: 'and this', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 9_000, isAborted: true }) as never)
  expect(await pane($)).toContain('Last turn 9s (interrupted) · 1 tool · cache 96%')
  await $.session.measure(measure(97_000, 49))
  expect(await pane($)).toContain('Last turn ▲ +7k · 9s (interrupted) · 1 tool · cache 96%')
})

test('the session cost shows and follows each measurement', async ($, on) => {
  engine(on, { cost: 1.234 })

  await $.session.start(start)
  expect(await pane($)).toContain('Session cost $1.23')

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 3.42 }, changed: ['cost' as const] })
  expect(await pane($)).toContain('Session cost $3.42')
})

test('the thinking summary sits last, under the session cost, waiting for a turn', async ($, on) => {
  engine(on, { cost: 1.234 })

  await $.session.start(start)
  const texts = await allTexts($)
  expect(texts.slice(texts.indexOf('Session cost $1.23'))).toEqual([
    'Session cost $1.23',
    '🧭 Thinking',
    'Waiting for the next turn.',
    'Summary cost $0.000 - Haiku 5.5',
  ])
  expect(await buttons($)).toEqual(['Turn summary off'])
})

test("Haiku reads the main loop's thinking notes, and the pane shows what it says", VIETNAMESE, async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(
    answer(
      [
        'GIST: Theo lựa chọn của bạn, chỉ thêm 9 key của top tool vào messages.properties, rồi kiểm tra ở App mode.',
        'DECISION: Không commit khi bạn chưa bảo',
        'NEXT: Kiểm tra trang Press',
      ].join('\n'),
    ),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'Chỉ thêm key cho top tool thôi', turnId: 't1' })

  // Two blocks of thinking, one split in pieces, around a tool call.
  const chunks = [
    thought(0, "I'm going with the user's choice "),
    thought(0, "to add only the top tool's keys."),
    toolStart(1),
    toolInput(1),
    thought(2, 'Next I will check the Press page.'),
    stop,
  ]
  expect(await runStep($, steps, 't1', chunks)).toEqual(chunks)

  await clock.advance(SECOND)
  expect(asks.length).toBe(1)
  expect(asks[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(asks[0]?.system).toContain('Vietnamese')
  expect(asks[0]?.prompt).toContain('Chỉ thêm key cho top tool thôi')
  expect(plain(asks[0]?.prompt)).toContain("<note>\nI'm going with the user's choice to add only the top tool's keys.\n</note>")
  expect(plain(asks[0]?.prompt)).toContain('<note>\nNext I will check the Press page.\n</note>')

  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Theo lựa chọn của bạn, chỉ thêm 9 key của top tool vào messages.properties, rồi kiểm tra ở App mode.',
    '★ Không commit khi bạn chưa bảo',
    '→ Kiểm tra trang Press',
    'Summary cost $0.002 - Haiku 5.5',
  ])
})

test('updates keep 15 seconds apart, stay newest first, and the end adds a recap', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Một.\nDECISION: Chỉ sửa file A'),
    answer('GIST: Hai.\nNEXT: Chạy test'),
    answer('GIST: Tổng kết.\nDECISION: A\nDECISION: B\nDECISION: C'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(1)

  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(10 * SECOND)
  expect(asks.length).toBe(1)

  // The second update reads the new note, the one the first read as its
  // context, and what the first said.
  await clock.advance(5 * SECOND)
  expect(asks.length).toBe(2)
  expect(tagged(asks[1]?.prompt, 'notes')).toBe('<note>\nSecond note.\n</note>')
  expect(tagged(asks[1]?.prompt, 'context')).toBe('<note>\nFirst note.\n</note>')
  expect(asks[1]?.prompt).toContain('<update>\nGIST: Một.\nDECISION: Chỉ sửa file A\n</update>')
  expect(asks[1]?.prompt).not.toContain(NO_WAIT)

  // The first update stays, under the second, a rule between them.
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 16s',
    '16s · Hai.',
    '→ Chạy test',
    RULE,
    '1s · Một.',
    '★ Chỉ sửa file A',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  // Nothing new: the clock ticks on without asking.
  await clock.advance(20 * SECOND)
  expect(asks.length).toBe(2)

  // The recap reads the whole turn, may not wait, and stands on top.
  await $.turn.complete(turnDone({ durationMs: 40_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')
  expect(tagged(asks[2]?.prompt, 'notes')).toBe('<note>\nFirst note.\n</note>\n<note>\nSecond note.\n</note>')
  expect(asks[2]?.prompt).not.toContain('<context>')
  expect(asks[2]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 40s · done',
    'Recap · Tổng kết.',
    '★ A',
    '★ B',
    '★ C',
    RULE,
    '16s · Hai.',
    '→ Chạy test',
    RULE,
    '1s · Một.',
    '★ Chỉ sửa file A',
    'Summary cost $0.006 - Haiku 5.5',
  ])

  // The recap is the turn's last word: no more asking.
  await clock.advance(60 * SECOND)
  expect(asks.length).toBe(3)
})

test('a rule of box drawing stands between two updates, on the desktop as in the terminal', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  // One update: nothing to set apart.
  expect(await thoughts($)).not.toContain(RULE)

  for (const text of ['Second note.', 'Third note.']) {
    await runStep($, steps, 't1', [thought(0, text), stop])
    await clock.advance(15 * SECOND)
  }

  // Three updates, two rules between them, each across the body.
  for (const surface of ['desktop', 'terminal'] as const) {
    const texts = await thoughts($, surface)
    expect(texts.filter(text => text === RULE).length).toBe(2)
    expect(texts.indexOf(RULE)).toBe(texts.indexOf('31s · Claude đang sửa lỗi.') + 1)
    expect(texts.lastIndexOf(RULE)).toBe(texts.indexOf('16s · Claude đang sửa lỗi.') + 1)
  }
})

test('a new prompt starts the updates over', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect(await thoughts($)).toContain('1s · Claude đang sửa lỗi.')

  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])
})

test('one update and nothing after it needs no recap; a note it missed gets one', async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Only note.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(1)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 5s · done',
    '1s · Claude đang sửa lỗi.',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  // A note inside the gap, then the end: the recap reads it.
  await $.turn.start({ text: 'again', turnId: 't2' })
  await runStep($, steps, 't2', [thought(0, 'First.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't2', [thought(0, 'Late note.'), stop])
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 3_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('Late note.')
  expect((await thoughts($)).slice(0, 4)).toEqual([
    '🧭 Thinking · 3s · done',
    'Recap · Claude đang sửa lỗi.',
    RULE,
    '1s · Claude đang sửa lỗi.',
  ])
})

test('a turn the single-summary version kept is declined, not drawn', async ($, on) => {
  engine(on)
  on('state.get', ($, e, next) =>
    (e as { key?: string }).key === 'thinking'
      ? {
          value: {
            value: {
              turnId: 't0',
              request: '',
              startedAt: NOW,
              notes: ['x'],
              summarized: 1,
              summary: { gist: 'old', decisions: [] },
              isSummarizing: false,
            },
            version: 1,
          },
        }
      : next(e),
  )

  await $.session.start(start)
  expect(await thoughts($)).toEqual(['🧭 Thinking', 'Waiting for the next turn.', 'Summary cost $0.000 - Haiku 5.5'])
})

test("a subagent's thinking stays out, and its turn neither resets the main one nor its tool count", async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.start({ text: 'look around', turnId: 'a-turn', agentId: 'a1' })
  await runStep($, steps, 'a-turn', [thought(0, 'A subagent note.'), stop], 'a1')
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await clock.advance(SECOND)
  expect(asks).toEqual([])
  expect(await thoughts($)).toContain('No thinking notes yet.')

  await $.turn.complete(turnDone() as never)
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('Last turn ▲ +90k · 2m 14s · 2 tools · cache 96%')
})

test('a failed summary says why, and the next tick after the gap tries again', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(RATE_LIMITED)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  expect(await thoughts($)).toContain('Summary failed: rate_limit 429')

  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)
  expect(await thoughts($)).toContain('16s · Claude đang sửa lỗi.')
})

test('turned off, the summary asks nothing and keeps off; turned on, it catches up', async ($, on) => {
  const { asks, steps, writes, clock } = engine(on)

  await $.session.start(start)
  await press($, 'summary-toggle')
  expect(writes.at(-1)).toEqual({ key: 'isSummaryOff', value: true })
  expect(await thoughts($)).toEqual(['🧭 Thinking summary is off'])
  expect(await buttons($)).toEqual(['Turn summary on'])

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note while off.'), stop])
  await clock.advance(20 * SECOND)
  expect(asks).toEqual([])

  await press($, 'summary-toggle')
  await clock.settle()
  expect(writes.at(-1)).toEqual({ key: 'isSummaryOff', value: false })
  expect(asks.length).toBe(1)
  expect(asks[0]?.prompt).toContain('A note while off.')
  expect((await thoughts($))[1]).toBe('20s · Claude đang sửa lỗi.')
})

test('a summary turned off in an earlier session starts off', async ($, on) => {
  engine(on, { stored: { isSummaryOff: true } })

  await $.session.start(start)
  expect(await thoughts($)).toEqual(['🧭 Thinking summary is off'])
  expect(await buttons($)).toEqual(['Turn summary on'])
})

test('a reply that ignores the format still shows, and the cost adds up', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(answer('Claude đang đọc file cấu hình.'), answer(PLAIN))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Claude đang đọc file cấu hình.',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
  await clock.advance(15 * SECOND)
  expect(await thoughts($)).toContain('Summary cost $0.004 - Haiku 5.5')
})

test('the arrows move the updates in their own window, half of it a click; the weather stays', async ($, on) => {
  const { replies, steps, clock } = engine(on, { cost: 1.234 })
  replies.push(answer('GIST: Một.\nDECISION: Chỉ sửa file A'), answer('GIST: Hai.\nNEXT: Chạy test'), answer('GIST: Ba.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)

  // Newest first, a row each: "16s · Hai.", "→ Chạy test", "1s · Một.",
  // "★ Chỉ sửa file A". A click moves half the window, five rows in a body
  // of thirty, and stops at the last row.
  await press($, 'older')
  expect(await pane($)).toContain('Session cost $1.23')
  expect(await thoughts($)).toEqual(['🧭 Thinking · 16s', '★ Chỉ sửa file A', 'Summary cost $0.004 - Haiku 5.5'])
  expect(await buttons($)).toEqual(['↑ 2 newer updates', 'Turn summary off', '▲', '▼'])

  // A new update lands on top, and the window keeps showing the same row.
  await runStep($, steps, 't1', [thought(0, 'Third note.'), stop])
  await clock.advance(15 * SECOND)
  expect((await thoughts($))[1]).toBe('★ Chỉ sửa file A')
  expect(await buttons($)).toEqual(['↑ 3 newer updates', 'Turn summary off', '▲', '▼'])

  // ▲ goes back as far, stopping at the newest; ↑ goes straight there.
  await press($, 'newer')
  expect((await thoughts($))[1]).toBe('31s · Ba.')
  await press($, 'older')
  expect((await thoughts($))[1]).toBe('★ Chỉ sửa file A')
  await press($, 'newest')
  expect((await thoughts($))[1]).toBe('31s · Ba.')

  // A new prompt starts at the top, with nothing to scroll.
  await press($, 'older')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await buttons($)).toEqual(['Turn summary off'])
})

test('in a narrow pane the lines wrap as the surface wraps them, and a click on ▼ passes a long line', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Claude đang đọc file cấu hình rồi chạy lại toàn bộ test\nNEXT: Chạy lại test'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)

  // One Text a line, for the surface to wrap at its full width. At 21
  // columns a desktop row holds about 23 characters: the long line is three
  // rows, the next step a fourth.
  expect(await thoughts($, 'desktop', 21)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Claude đang đọc file cấu hình rồi chạy lại toàn bộ test',
    '→ Chạy lại test',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  await press($, 'older', 21)
  expect((await thoughts($, 'desktop', 21)).slice(1, -1)).toEqual(['→ Chạy lại test'])
  await press($, 'newer', 21)
  expect((await thoughts($, 'desktop', 21))[1]).toBe('1s · Claude đang đọc file cấu hình rồi chạy lại toàn bộ test')
})

test('a click on ▼ shows a long line from part-way, marked, and a new update keeps that place', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  const words = Array.from({ length: 60 }, (_, at) => `từ${at}`).join(' ')
  replies.push(answer(`GIST: ${words}`), answer('GIST: Mới.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)

  // About 23 characters a row at 21 columns: the line is a score of rows,
  // and a click passes five of them.
  await press($, 'older', 21)
  const moved = (await thoughts($, 'desktop', 21))[1] ?? ''
  expect(moved.startsWith('… ')).toBe(true)
  expect(moved.length).toBeLessThan(`1s · ${words}`.length - 100)
  expect(moved.length).toBeGreaterThan(`1s · ${words}`.length - 130)

  // An update lands on top: the line still shows from the same word.
  await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
  await clock.advance(15 * SECOND)
  expect((await thoughts($, 'desktop', 21))[1]).toBe(moved)

  // ▲ goes back five rows, to the start of the long line, under the new one.
  await press($, 'newer', 21)
  expect((await thoughts($, 'desktop', 21))[1]).toBe(`1s · ${words}`)
})

test('from WIDE_FROM columns the weather stands in a column of its own, the summary beside it; narrower, one above the other', async ($, on) => {
  const { steps, clock } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))
  await oneTurn($, steps, clock, 't1', 'fix it')

  // A column short of it: one column, the weather on top.
  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await layout($, surface, WIDE_FROM - 1)).toEqual({
      direction: 'column',
      weatherWidth: undefined,
      weather: expect.stringContaining('45% of context · 90k / 200k'),
      summary: undefined,
    })
  }

  // From it: the weather on the left, wide enough for its longest line on
  // one row (46 characters: 41 cells of the desktop's narrower face, 47 of
  // the terminal's), and the summary in the rest.
  for (const [surface, weatherWidth] of [
    ['desktop', 41],
    ['terminal', 47],
  ] as const) {
    const wide = await layout($, surface, WIDE_FROM)
    expect([surface, wide.direction, wide.weatherWidth]).toEqual([surface, 'row', weatherWidth])
    expect(wide.weather).toContain('45% of context · 90k / 200k')
    expect(wide.weather).toContain('Usage limits')
    expect(wide.weather).toContain('Week 25%')
    expect(wide.weather).not.toContain('🧭')
    expect(wide.summary).toContain('1s · Claude đang sửa lỗi.')
    expect(wide.summary).toContain('Summary cost $0.002 - Haiku 5.5')
  }

  // Nothing is lost on the way: each line one column shows stands beside the
  // weather in the same order, but the limits' bars, which gain their pace.
  const isBar = (text: string) => /^[█░]/.test(text)
  const narrow = (await allTexts($, 'desktop', WIDE_FROM - 1)).filter(text => !isBar(text))
  expect(missingFrom(narrow, await allTexts($, 'desktop', WIDE_FROM))).toEqual([])
})

test('beside the weather the rule spans the summary, and a click moves half its taller window', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Một.\nNEXT: Tiếp 1'),
    answer('GIST: Hai.\nNEXT: Tiếp 2'),
    answer('GIST: Ba.\nNEXT: Tiếp 3'),
    answer('GIST: Bốn.\nNEXT: Tiếp 4'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)

  for (const text of ['Second note.', 'Third note.', 'Fourth note.']) {
    await runStep($, steps, 't1', [thought(0, text), stop])
    await clock.advance(15 * SECOND)
  }

  // At 120 columns the summary has the body's less the weather's (41 on the
  // desktop, 47 on the terminal) and the 2 between: the rule spans those.
  expect(await thoughts($, 'desktop', 120)).toContain('─'.repeat(76))
  expect(await thoughts($, 'terminal', 120)).toContain('─'.repeat(70))

  // Newest first, a row each: "46s · Bốn.", "→ Tiếp 4", and so on down to
  // "→ Tiếp 1", the eighth. In one column a click passes five rows of a
  // body of thirty...
  await press($, 'older')
  expect((await thoughts($))[1]).toBe('→ Tiếp 2')

  // ...and beside the weather, where the window has the body's height but
  // the summary's header and footer, twelve: past the last row, so it stops
  // there.
  await press($, 'newest')
  await press($, 'older', 120)
  expect((await thoughts($, 'desktop', 120))[1]).toBe('→ Tiếp 1')
})

test('with the summary off the weather keeps one column at any width', async ($, on) => {
  engine(on, { stored: { isSummaryOff: true }, rateLimits: limits(25) })

  await $.session.start(start)
  expect(await layout($, 'desktop', 200)).toEqual({
    direction: 'column',
    weatherWidth: undefined,
    weather: expect.stringContaining('Week 25% · reset in 2d 5h'),
    summary: undefined,
  })
})

// The windows the wide layout's additions were asked from: the 5-hour window
// 11% used with 2h 22m left, 53% of its time gone; the week 75% used with
// 18h 52m left, 89% of it gone.
const PACED = [
  { kind: 'five_hour', percentUsed: 11, resetsAt: at(2 * HOUR + 22 * MINUTE) },
  { kind: 'seven_day', percentUsed: 75, resetsAt: at(18 * HOUR + 52 * MINUTE) },
]

test('from WIDE_FROM columns each limit bar marks the share of its time gone, and says where its share would stand at the reset', async ($, on) => {
  engine(on, { rateLimits: PACED })

  await $.session.start(start)

  for (const surface of ['desktop', 'terminal'] as const) {
    // A column short of it: the bars as they were, no mark, no pace.
    expect(await limitsShown($, surface, WIDE_FROM - 1)).toEqual([
      '5h 11% · reset in 2h 22m',
      `${bar(2)} [dim]`,
      'Week 75% · reset in 18h 52m',
      `${bar(15)} [dim]`,
    ])

    // From it: the cell where the time gone falls is │ (the 11th of the 5-hour
    // bar, the 18th of the week's), and 11% over 53% of the time reads 21% at
    // the reset, 75% over 89% of it 84%.
    expect(await limitsShown($, surface, WIDE_FROM)).toEqual([
      '5h 11% · reset in 2h 22m',
      `██${'░'.repeat(8)}│${'░'.repeat(9)} ~21% at reset`,
      '██ [dim]',
      `${'░'.repeat(8)} [dim]`,
      '│',
      `${'░'.repeat(9)} [dim]`,
      ' ~21% at reset [dim]',
      'Week 75% · reset in 18h 52m',
      `${'█'.repeat(15)}░░│░░ ~84% at reset`,
      `${'█'.repeat(15)} [dim]`,
      '░░ [dim]',
      '│',
      '░░ [dim]',
      ' ~84% at reset [dim]',
    ])
  }
})

test('early in a window the bar has its mark and no pace; a share on its way past the limit reads >100%', async ($, on) => {
  // The 5-hour window 4h 30m from its reset, a tenth of its time gone; the
  // week 60% used half way through.
  engine(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 9, resetsAt: at(4 * HOUR + 30 * MINUTE) },
      { kind: 'seven_day', percentUsed: 60, resetsAt: at(3 * DAY + 12 * HOUR) },
    ],
  })

  await $.session.start(start)
  expect(await limitsShown($, 'terminal', WIDE_FROM)).toEqual([
    '5h 9% · reset in 4h 30m',
    `█│${'░'.repeat(18)}`,
    '█ [dim]',
    '│',
    `${'░'.repeat(18)} [dim]`,
    'Week 60% · reset in 3d 12h',
    // The fill runs past the mark: ahead of the window's time.
    `${'█'.repeat(9)}│██${'░'.repeat(8)} >100% at reset`,
    `${'█'.repeat(9)} [dim]`,
    '│',
    '██ [dim]',
    `${'░'.repeat(8)} [dim]`,
    ' >100% at reset [dim]',
  ])
})

// A row of the window's breakdown: what it is, its tokens, and its kind.
const category = (name: string, tokens: number, kind = 'used') => ({
  name,
  tokens,
  color: 'inactive',
  isDeferred: kind === 'deferred',
  kind,
})

// The window's breakdown as the engine estimates it: six rows of content in
// use, and the rows that are not (tools loaded on demand, the compaction
// buffer, the free space); the model it was counted for.
const BREAKDOWN = {
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
const clockOf = (ms: number) => `${two(new Date(ms).getHours())}:${two(new Date(ms).getMinutes())}`

// The weather from WIDE_FROM columns down to its session's line: what stands
// above the subagents at work and the recent turns.
const sessionShown = async ($: Test$, surface: 'desktop' | 'terminal') => {
  const texts = await pane($, surface, WIDE_FROM)
  const end = texts.findIndex(text => text === 'Subagents at work' || text === 'Recent turns')

  return end === -1 ? texts : texts.slice(0, end)
}

// The session ended, as by a /clear.
const endSession = async ($: unknown, reason: string) =>
  ($ as { session: { end: (e: unknown) => Promise<unknown> } }).session.end({
    reason,
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })

test('from WIDE_FROM columns what fills the context stands under the auto-compact line, largest first, the rest in one', async ($, on) => {
  const breakdown = { ...BREAKDOWN }
  engine(on, { breakdown })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))

  for (const surface of ['desktop', 'terminal'] as const) {
    // A column short of it, as it was.
    expect(await pane($, surface, WIDE_FROM - 1)).toEqual([
      '☁ Cloudy',
      '45% of context · 90k / 200k',
      bar(9),
      'auto-compact at 92% · 184k',
      'Last turn ▲ +90k',
    ])

    // From it: the rows in use, never the free space, the buffer or the tools
    // loaded on demand; past four, the rest in one (MCP tools and Skills);
    // the rows on the branches of a tree.
    const shown = await pane($, surface, WIDE_FROM)
    expect(shown.slice(shown.indexOf('auto-compact at 92% · 184k'), shown.indexOf('Last turn ▲ +90k') + 1)).toEqual([
      'auto-compact at 92% · 184k',
      '├ Messages 64k · 32%',
      '├ System tools 17.1k · 9%',
      '├ System prompt 3.2k · 2%',
      '├ Memory files 2.4k · 1%',
      '└ Other 2.3k · 1%',
      'Last turn ▲ +90k',
    ])
  }

  // A compaction empties what filled it: the next measurement, inside the
  // next turn, reads it again.
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  breakdown.categories = [category('System prompt', 3_200), category('Messages', 12_000), category('Free space', 160_000, 'free')]
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await $.session.measure(measure(20_000, 10))
  const after = await pane($, 'desktop', WIDE_FROM)
  expect(after.slice(after.indexOf('auto-compact at 92% · 184k') + 1, after.indexOf('auto-compact at 92% · 184k') + 3)).toEqual([
    '├ Messages 12k · 6%',
    '└ System prompt 3.2k · 2%',
  ])
})

test("from WIDE_FROM columns the session cost becomes the session's line: its model, since when, its prompts and compactions", async ($, on) => {
  const { setTurns } = engine(on, { breakdown: BREAKDOWN, cost: 16.17, startedAt: NOW })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))
  const since = `since ${clockOf(NOW)}`

  await $.session.start(start)

  for (const surface of ['desktop', 'terminal'] as const) {
    // A column short of it, the cost as it was.
    const narrow = await pane($, surface, WIDE_FROM - 1)
    expect(narrow.at(-1)).toBe('Session cost $16.17')
    expect(narrow.some(text => text.includes('Fable'))).toBe(false)

    // From it, no prompt yet: none said.
    expect((await sessionShown($, surface)).at(-1)).toBe(`Fable 5.2 · ${since} · $16.17`)
  }

  // 23 prompts and two compactions on, the line takes a second row.
  setTurns(23)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })

  for (const surface of ['desktop', 'terminal'] as const) {
    expect((await sessionShown($, surface)).slice(-2)).toEqual([`Fable 5.2 · ${since} · 23 turns`, '2 compactions · $16.17'])
    expect((await pane($, surface, WIDE_FROM - 1)).at(-1)).toBe('Session cost $16.17')
  }
})

test('a session the mod loads into under way counts its compactions from there, as 1+; after /clear it counts them all', async ($, on) => {
  const { clock, setTurns, useSession } = engine(on, { breakdown: BREAKDOWN, turns: 5, startedAt: NOW - 3 * DAY })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))

  // Begun three days ago: the day it began, not its time.
  await $.session.start(start)
  const began = `since Oct ${new Date(NOW - 3 * DAY).getDate()}`
  expect((await sessionShown($, 'terminal')).at(-1)).toBe(`Fable 5.2 · ${began} · 5 turns`)

  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect((await sessionShown($, 'terminal')).slice(-2)).toEqual([`Fable 5.2 · ${began} · 5 turns`, '1+ compactions'])

  // A /clear starts the session over, now: the mod sees it whole.
  await endSession($, 'clear')
  useSession('session-2')
  setTurns(0)
  await clock.advance(SECOND)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect((await sessionShown($, 'terminal')).at(-1)).toBe(`Fable 5.2 · ${began} · 1 compaction`)
})

// What the weather shows under "Subagents at work", in a pane `columns`
// wide; none where it shows no such section.
const subagentsShown = async ($: Test$, surface: 'desktop' | 'terminal', columns: number) => {
  const texts = await pane($, surface, columns)
  const top = texts.indexOf('Subagents at work')
  // Each row's own Text, not the dim part inside it.
  const rows = texts.slice(top + 1).filter(text => !text.startsWith(' · '))
  const end = rows.findIndex(text => !/ · (?:pending|running|waiting)(?: · |$)/.test(text))

  return top === -1 ? [] : rows.slice(0, end === -1 ? undefined : end)
}

test('from WIDE_FROM columns the subagents at work show while there are any: each one, where it stands, how long it has run', async ($, on) => {
  const { agents, clock } = engine(on)
  on('agent.spawn', ($$, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'Find the flaky test' ? 'a1' : 'a2' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })

  // Spawned by the main loop: its row shows at once. Another plugin's, and a
  // subagent's own, do not.
  agents.push(
    { id: 'a1', description: 'Find the flaky test', type: 'Explore', status: 'running' },
    { id: 'p1', description: "A plugin's helper", type: 'general-purpose', status: 'running', spawnedBy: 'other' },
    { id: 'c1', description: "A subagent's own", type: 'Explore', status: 'running', parentId: 'a1' },
  )
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find the flaky test' } as never)

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await subagentsShown($, surface, WIDE_FROM)).toEqual(['Find the flaky test · running · <1m'])
    expect((await pane($, surface, WIDE_FROM - 1)).includes('Subagents at work')).toBe(false)
  }

  // Three minutes on, a second, its description long: cut to leave room for
  // the rest.
  await clock.advance(3 * MINUTE)
  const long = 'Read every file of the hooks module and list each helper that has no comment over it'
  agents.push({ id: 'a2', description: long, type: 'general-purpose', status: 'pending' })
  await $.agent.spawn({ prompt: 'Read it.', description: long } as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Find the flaky test · running · 3m',
    'Read every file of the hooks… · pending · <1m',
  ])

  // The first ends with its last turn: its row goes; the last to end takes
  // the section with it.
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 200_000 }) as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual(['Read every file of the hooks… · pending · <1m'])

  agents[3]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a2', durationMs: 5_000 }) as never)
  expect((await pane($, 'terminal', WIDE_FROM)).includes('Subagents at work')).toBe(false)

  // A workflow's many, listed as one more starts: five rows, the rest in one.
  for (let at = 1; at <= 8; at += 1) {
    agents.push({ id: `w${at}`, description: `Step ${at}`, type: 'general-purpose', status: 'running' })
  }
  await $.agent.spawn({ prompt: 'Run it.', description: 'Step 9' } as never)
  const shown = await pane($, 'terminal', WIDE_FROM)
  const rows = shown.slice(shown.indexOf('Subagents at work') + 1, shown.indexOf('Recent turns'))
  expect(rows.filter(text => !text.startsWith(' · '))).toEqual([
    'Step 1 · running',
    'Step 2 · running',
    'Step 3 · running',
    'Step 4 · running',
    'Step 5 · running',
    'and 3 more',
  ])
})

test('drawn wide and idle, the pane redraws no more often than before', async ($, on) => {
  const { clock, redraws } = engine(on, {
    breakdown: BREAKDOWN,
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: at(2 * DAY + 5 * HOUR + 30 * MINUTE) }],
  })

  await $.session.start(start)
  await allTexts($, 'desktop', WIDE_FROM)
  await clock.advance(MINUTE)
  const after = redraws()

  await clock.advance(5 * MINUTE)
  expect(redraws()).toBe(after)
})

// The recent turns' rows, newest first, as the Buttons of a pane `columns`
// wide label them.
const turnRows = async ($: Test$, surface: 'desktop' | 'terminal', columns = WIDE_FROM) => {
  const ui = await mount($, surface, columns)
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return labels.filter(text => /^(?:▸ )?\d\d:\d\d · /.test(text))
}

test('from WIDE_FROM columns the recent turns are listed, newest first: when each began, how long it ran, what it added, its tool calls', async ($, on) => {
  const { clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  for (const command of ['ls', 'pwd', 'git status']) {
    await $.tool.call({ tool: 'Bash', command })
  }

  // Under way: it runs, the fill measured so far its growth.
  await $.session.measure(measure(60_000, 30))
  expect(await turnRows($, 'terminal')).toEqual([`▸ ${clockOf(NOW)} · running · ▲ +60k · 3 tools`])

  await $.turn.complete(turnDone() as never)
  await $.session.measure(measure(90_000, 45))
  await clock.advance(5 * MINUTE)
  await $.turn.start({ text: 'and this', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 9_000, isAborted: true }) as never)
  await $.session.measure(measure(97_000, 49))

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await turnRows($, surface)).toEqual([
      `▸ ${clockOf(NOW + 5 * MINUTE)} · 9s · ▲ +7k · 1 tool · interrupted`,
      `${clockOf(NOW)} · 2m 14s · ▲ +90k · 3 tools`,
    ])
    // A column short of it, no list.
    expect(await turnRows($, surface, WIDE_FROM - 1)).toEqual([])
    expect((await pane($, surface, WIDE_FROM - 1)).includes('Recent turns')).toBe(false)
  }

  // With the summary off there is nothing beside the weather to show a turn
  // in: the rows are figures alone, unmarked, as wide as the body.
  await press($, 'summary-toggle')
  const shown = await pane($, 'terminal', WIDE_FROM)
  expect(shown.slice(shown.indexOf('Recent turns'))).toEqual([
    'Recent turns',
    `${clockOf(NOW + 5 * MINUTE)} · 9s · ▲ +7k · 1 tool · interrupted`,
    `${clockOf(NOW)} · 2m 14s · ▲ +90k · 3 tools`,
  ])
  expect(await turnRows($, 'terminal')).toEqual([])
})

test('a recent turn pressed shows its updates beside the weather; a new prompt shows its own again', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'))

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  await clock.advance(MINUTE)
  await oneTurn($, steps, clock, 't2', 'and this')
  const [first, second] = [clockOf(NOW), clockOf(NOW + MINUTE + SECOND)]

  // The newest is shown, marked.
  expect(await turnRows($, 'desktop')).toEqual([`▸ ${second} · 2s · 0 tools`, `${first} · 2s · 0 tools`])
  expect(await thoughts($, 'desktop', WIDE_FROM)).toEqual([
    '🧭 Thinking · 2s · done',
    '1s · Hai.',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  // The one before, pressed: its updates, the turn said by when it began.
  await press($, 'turn-t1', WIDE_FROM)
  expect(await turnRows($, 'desktop')).toEqual([`${second} · 2s · 0 tools`, `▸ ${first} · 2s · 0 tools`])
  expect(await thoughts($, 'desktop', WIDE_FROM)).toEqual([
    `🧭 Turn at ${first} · 2s · done`,
    '1s · Một.',
    'Summary cost $0.004 - Haiku 5.5',
  ])
  // In one column the current turn shows, as it always has.
  expect((await thoughts($, 'desktop'))[1]).toBe('1s · Hai.')

  // The newest pressed again: back to it.
  await press($, 'turn-t2', WIDE_FROM)
  expect((await thoughts($, 'desktop', WIDE_FROM))[1]).toBe('1s · Hai.')

  // An earlier turn picked, the next prompt shows its own turn.
  await press($, 'turn-t1', WIDE_FROM)
  await $.turn.start({ text: 'next', turnId: 't3' })
  expect(await thoughts($, 'desktop', WIDE_FROM)).toEqual([
    '🧭 Thinking · 0s',
    'No thinking notes yet.',
    'Summary cost $0.004 - Haiku 5.5',
  ])
  expect((await turnRows($, 'desktop'))[0]).toBe(`▸ ${second} · running · 0 tools`)
})

test("a hand-back goes on in its turn's row; the list keeps the last ten turns, and a /clear empties it", async ($, on) => {
  const { agents, clock } = engine(on)
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))

  await $.session.start(start)
  await $.prompt.submit(submit('review it'))
  await $.turn.start({ text: 'review it', turnId: 't1' })
  agents.push(subagent('a1'))
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(await turnRows($, 'terminal')).toEqual([`▸ ${clockOf(NOW)} · waiting · 0 tools`])

  // Its subagent hands back half a minute on: the same row runs again, then
  // ends, the whole of it from the person's prompt.
  await clock.advance(30 * SECOND)
  agents[0]!.status = 'completed'
  await resume($, handBack('a1'), 't2')
  expect(await turnRows($, 'terminal')).toEqual([`▸ ${clockOf(NOW)} · running · 0 tools`])
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  expect(await turnRows($, 'terminal')).toEqual([`▸ ${clockOf(NOW)} · 30s · 0 tools`])

  // Ten more prompts: the first turn goes from the list.
  for (let at = 1; at <= 10; at += 1) {
    await $.turn.start({ text: `prompt ${at}`, turnId: `u${at}` })
    await $.turn.complete(turnDone({ turnId: `u${at}`, durationMs: 1_000 }) as never)
  }

  const rows = await turnRows($, 'terminal')
  expect(rows.length).toBe(10)
  expect(rows.some(row => row.includes('30s'))).toBe(false)

  // A /clear starts another conversation: its turns are listed from there.
  await endSession($, 'clear')
  expect(await turnRows($, 'terminal')).toEqual([])
  expect((await pane($, 'terminal', WIDE_FROM)).includes('Recent turns')).toBe(false)
})

test('how many turns the list keeps is a setting', { options: { recentTurns: 3 } }, async ($, on) => {
  const { clock } = engine(on)

  await $.session.start(start)

  for (let at = 1; at <= 5; at += 1) {
    await $.turn.start({ text: `prompt ${at}`, turnId: `u${at}` })
    await $.turn.complete(turnDone({ turnId: `u${at}`, durationMs: at * 1_000 }) as never)
    await clock.advance(MINUTE)
  }

  // The newest three, newest first.
  expect(await turnRows($, 'terminal')).toEqual([
    `▸ ${clockOf(NOW + 4 * MINUTE)} · 5s · 0 tools`,
    `${clockOf(NOW + 3 * MINUTE)} · 4s · 0 tools`,
    `${clockOf(NOW + 2 * MINUTE)} · 3s · 0 tools`,
  ])
})

// The mod's folder of files, and the file a saved session's turns go to.
const MOD_FILES = '/home/me/.claude/session-weather'
const SAVED = `${MOD_FILES}/turns/session-1.json`

// What the session's saved file holds, as JSON.
type Saved = {
  shape: string
  turns: { turnId: string; durationMs?: number; entries: { gist: string }[] }[]
  compactions?: { count: number; isWhole: boolean }
}

const savedIn = (files: Map<string, string>) => JSON.parse(files.get(SAVED) ?? 'null') as Saved | null

test("saving is off until pressed: then the session's turns and compactions go to a file of its own; pressed again, it goes", async ($, on) => {
  const { files, runs, steps, clock } = engine(on)
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')

  // Off unless pressed: nothing is written.
  expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☐ Persist')
  expect(files.has(SAVED)).toBe(false)

  await press($, 'save-turns', WIDE_FROM)
  expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☑ Persist')
  expect(savedIn(files)?.shape).toBe('recent-turns-1')
  expect(savedIn(files)?.turns.map(one => [one.turnId, one.durationMs, one.entries.map(entry => entry.gist)])).toEqual([
    ['t1', 2_000, ['Claude đang sửa lỗi.']],
  ])
  expect(savedIn(files)?.compactions).toEqual({ count: 0, isWhole: true })

  // A compaction and the next turn are saved as they come.
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(savedIn(files)?.compactions).toEqual({ count: 1, isWhole: true })
  await oneTurn($, steps, clock, 't2', 'and this')
  expect(savedIn(files)?.turns.map(one => one.turnId)).toEqual(['t1', 't2'])

  // Unticked: the file goes, by a command of the host's, and the turns stay
  // in memory, for as long as Claude Code runs.
  await press($, 'save-turns', WIDE_FROM)
  expect(runs.at(-1)?.argv).toEqual(['rm', '-f', '--', SAVED])
  expect(files.has(SAVED)).toBe(false)
  expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☐ Persist')
  expect((await turnRows($, 'terminal')).length).toBe(2)

  // A turn after it writes no file.
  await oneTurn($, steps, clock, 't3', 'and more')
  expect(files.has(SAVED)).toBe(false)
})

test('a saved session started again gets its turns and compactions back, saving on; a turn the restart cut reads interrupted', async ($, on) => {
  const saved = {
    shape: 'recent-turns-1',
    turns: [
      {
        turnId: 't1',
        startedAt: NOW - HOUR,
        durationMs: 134_000,
        fromTokens: 0,
        toTokens: 90_000,
        tools: 3,
        entries: [{ at: NOW - HOUR + SECOND, gist: 'Một.', decisions: [], assumptions: [] }],
      },
      { turnId: 't2', startedAt: NOW - 10 * MINUTE, fromTokens: 90_000, toTokens: 97_000, tools: 1, isWaiting: true, entries: [] },
    ],
    compactions: { count: 2, isWhole: true },
  }
  engine(on, { files: { [SAVED]: JSON.stringify(saved) }, breakdown: BREAKDOWN, turns: 2 })

  await $.session.start(start)
  expect(await turnRows($, 'terminal')).toEqual([
    `${clockOf(NOW - 10 * MINUTE)} · ▲ +7k · 1 tool · interrupted`,
    `${clockOf(NOW - HOUR)} · 2m 14s · ▲ +90k · 3 tools`,
  ])
  expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☑ Persist')
  // All its compactions, not those since the restart alone.
  expect((await sessionShown($, 'terminal')).join('\n')).toContain('2 compactions')

  await press($, 'turn-t1', WIDE_FROM)
  expect(await thoughts($, 'terminal', WIDE_FROM)).toEqual([
    `🧭 Turn at ${clockOf(NOW - HOUR)} · 2m 14s · done`,
    '1s · Một.',
    'Summary cost $0.000 - Haiku 5.5',
  ])

  await press($, 'turn-t2', WIDE_FROM)
  expect((await thoughts($, 'terminal', WIDE_FROM)).slice(0, 2)).toEqual([
    `🧭 Turn at ${clockOf(NOW - 10 * MINUTE)} · interrupted`,
    'No updates on this turn.',
  ])
})

for (const [kind, text] of [
  ['in another shape', JSON.stringify({ shape: 'recent-turns-0', turns: [{ turnId: 't1' }] })],
  ['emptied', ''],
] as const) {
  test(`a saved file ${kind} gives nothing back`, async ($, on) => {
    engine(on, { files: { [SAVED]: text } })

    await $.session.start(start)
    await $.turn.start({ text: 'go', turnId: 't9' })
    expect(await turnRows($, 'terminal')).toEqual([`▸ ${clockOf(NOW)} · running · 0 tools`])
    expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☐ Persist')
  })
}

// The mod's files, each written `days` days ago.
const aged = (entries: [string, number][]) => ({
  files: Object.fromEntries(entries.map(([path]) => [path, 'x'])),
  written: Object.fromEntries(entries.map(([path, days]) => [path, NOW - days * DAY])),
})

test("the mod's files nothing has written for 30 days are deleted as a session starts; its own, newer ones and others stay", async ($, on) => {
  const old = [
    `${MOD_FILES}/thinking/old.md`,
    `${MOD_FILES}/debug/old.md`,
    `${MOD_FILES}/spend/old.json`,
    `${MOD_FILES}/turns/old.json`,
  ]
  const kept = [`${MOD_FILES}/thinking/new.md`, `${MOD_FILES}/thinking/session-1.md`, `${MOD_FILES}/thinking/notes.txt`]
  const { files, runs, clock } = engine(
    on,
    aged([
      ...old.map((path): [string, number] => [path, 31]),
      [kept[0]!, 29],
      [kept[1]!, 90],
      [kept[2]!, 90],
    ]),
  )

  await $.session.start(start)
  await clock.settle()
  expect(runs).toEqual([{ argv: ['rm', '-f', '--', ...old], stdin: undefined }])
  expect([...files.keys()].sort()).toEqual([...kept].sort())

  // Once a day at most: a reading a minute on looks no further.
  await clock.advance(MINUTE)
  expect(runs.length).toBe(1)
})

test('on Windows PowerShell deletes them, the paths on its input', async ($, on) => {
  const old = '/Users/me/.claude/session-weather/thinking/old.md'
  const { files, runs, clock } = engine(on, {
    env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', HOME: '/c/Users/me' },
    ...aged([[old, 40]]),
  })

  await $.session.start(start)
  await clock.settle()
  expect(runs.map(run => run.argv[0])).toEqual(['powershell.exe'])
  expect(runs[0]?.stdin).toBe('C:\\Users\\me\\.claude\\session-weather\\thinking\\old.md')
  expect(files.has(old)).toBe(false)
})

test('the days are a setting: at 7 a file written eight days ago goes', { options: { cleanupDays: 7 } }, async ($, on) => {
  const file = `${MOD_FILES}/thinking/old.md`
  const { files, clock } = engine(on, aged([[file, 8]]))

  await $.session.start(start)
  await clock.settle()
  expect(files.has(file)).toBe(false)
})

test('at 0 days every file stays', { options: { cleanupDays: 0 } }, async ($, on) => {
  const file = `${MOD_FILES}/thinking/old.md`
  const { files, runs, clock } = engine(on, aged([[file, 400]]))

  await $.session.start(start)
  await clock.settle()
  expect(runs).toEqual([])
  expect(files.has(file)).toBe(true)
})

test("each block's header reads as one: a step larger than its rows, heavier, muted", async ($, on) => {
  const { agents } = engine(on, { rateLimits: PACED })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push({ id: 'a1', description: 'Find it', type: 'Explore', status: 'running' })
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find it' } as never)

  // The header's style, by its text, in a pane `columns` wide.
  const styleOf = async (surface: 'desktop' | 'terminal', columns: number, text: string) => {
    const ui = await mount($, surface, columns)
    const found = ((await ui.findAll({ type: 'Text' })) as unknown as Found[]).find(one => one.text === text)
    await ui.unmount()

    return found === undefined ? undefined : { size: found.props.size, weight: found.props.weight, dim: found.props.dimColor }
  }
  const header = { size: 'heading', weight: 'semibold', dim: true }

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await styleOf(surface, WIDE_FROM - 1, 'Usage limits')).toEqual(header)

    for (const text of ['Usage limits', 'Subagents at work', 'Recent turns']) {
      expect([text, await styleOf(surface, WIDE_FROM, text)]).toEqual([text, header])
    }
  }
})

test('under WIDE_FROM columns, in a widget and on the status line, nothing of the wide layout shows', async ($, on) => {
  // Everything the wide layout's additions read is there: the breakdown and
  // its model, prompts and a compaction, a subagent at work, recent turns,
  // windows far enough in for their pace.
  const { agents, clock, status, steps } = engine(on, {
    breakdown: BREAKDOWN,
    rateLimits: PACED,
    cost: 1.234,
    turns: 3,
    startedAt: NOW,
    columns: 120,
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await oneTurn($, steps, clock, 't0', 'first')
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.session.measure(measure(90_000, 45))
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push({ id: 'a1', description: 'Find it', type: 'Explore', status: 'running' })
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find it' } as never)
  expect((await pane($, 'terminal', WIDE_FROM)).includes('Subagents at work')).toBe(true)

  for (const surface of ['desktop', 'terminal'] as const) {
    expect(await pane($, surface, WIDE_FROM - 1)).toEqual([
      '☁ Cloudy',
      '45% of context · 90k / 200k',
      bar(9),
      'auto-compact at 92% · 184k',
      'Last turn ▼ -160k · 2s · 0 tools · cache 96%',
      'Usage limits',
      // Alone in the spend files, the session takes the whole of each.
      '5h 11% · this session 11% · reset in 2h 22m',
      'this session 11%',
      bar(2),
      '██',
      '░'.repeat(18),
      'Week 75% · this session 75% · reset in 18h 52m',
      'this session 75%',
      bar(15),
      '█'.repeat(15),
      '░'.repeat(5),
      'Session cost $1.23',
    ])
    expect(await turnRows($, surface, WIDE_FROM - 1)).toEqual([])
  }

  expect(await allTexts($, 'desktop', undefined, WIDGET)).toEqual(['☁ Cloudy · 45%', '5h 11% · Week 75% · $1.23'])

  // On a terminal too narrow to place the pane unasked, the line stands in,
  // as it reads at the next minute.
  await clock.advance(MINUTE)
  expect(status()).toBe('☁ 45% · 5h 11% (2h 21m) · $1.23')
})

test('minimized to a widget, the pane reads at a glance: the sky, the windows and the cost, the newest update', async ($, on) => {
  const { steps, clock } = engine(on, { rateLimits: limits(25), cost: 1.234 })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect(await allTexts($, 'desktop', undefined, WIDGET)).toEqual([
    '☁ Cloudy · 45%',
    '5h 3% · Week 25% · $1.23',
    '1s · Claude đang sửa lỗi.',
  ])
  // A click may not reach it there: nothing to press.
  expect(await buttons($, WIDGET)).toEqual([])

  // A widget one row tall shows the sky alone.
  expect(await allTexts($, 'desktop', undefined, { ...WIDGET, scroll: { offset: 0, bodyRows: 1 } })).toEqual([
    '☁ Cloudy · 45%',
  ])

  // Turned off, the summary's update goes from it.
  await press($, 'summary-toggle')
  expect(await allTexts($, 'desktop', undefined, WIDGET)).toEqual(['☁ Cloudy · 45%', '5h 3% · Week 25% · $1.23'])

  // Compacted, the fill unknown until the next response.
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect((await allTexts($, 'desktop', undefined, WIDGET))[0]).toBe('☀ Compacted')
})

test('a widget waits for the first reading, and lines up on the edge it is anchored to', async ($, on) => {
  engine(on)

  await $.session.start(start)
  expect(await allTexts($, 'desktop', undefined, WIDGET)).toEqual(['Waiting for the first response.'])

  // Anchored on the chat's right edge, its lines end there; elsewhere, as in
  // the session rail, they start at the left.
  const aligned = [
    [['bottom', 'right'], 'flex-end'],
    [['right'], 'flex-end'],
    [['bottom', 'left'], undefined],
    [[], undefined],
  ] as const

  for (const [anchoredEdges, alignItems] of aligned) {
    const ui = await mount($, 'desktop', undefined, { ...WIDGET, anchoredEdges })
    expect([anchoredEdges, (await ui.find({ type: 'Box' }))?.props.alignItems]).toEqual([anchoredEdges, alignItems])
    await ui.unmount()
  }
})

test('a long stretch of thinking is summarized a part at a time while it streams', async ($, on) => {
  const { asks, steps, clock } = engine(on)
  const sentences = (step: number) =>
    Array.from({ length: 5 }, (_, at) => `Claude weighs step ${step}, point ${at}, at some length.`).join(' ')

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  // One block of thinking, written over forty seconds.
  const running = runStep($, steps, 't1', [
    thought(0, `${sentences(1)} `),
    { wait: 20 * SECOND },
    thought(0, `${sentences(2)} `),
    { wait: 20 * SECOND },
    thought(0, 'And so it is settled.'),
    stop,
  ])

  // Its first part is summarized while the block goes on.
  await clock.advance(SECOND)
  expect(asks.length).toBe(1)
  expect(plain(asks[0]?.prompt)).toContain(`<note>\n${sentences(1)} …\n</note>`)
  expect(asks[0]?.system).toContain('was cut while Claude was still writing it')

  // Its second, after the gap and once written: the new part, the first one
  // as its context.
  await clock.advance(20 * SECOND)
  expect(asks.length).toBe(2)
  expect(tagged(asks[1]?.prompt, 'notes')).toBe(`<note>\n… ${sentences(2)} …\n</note>`)
  expect(tagged(asks[1]?.prompt, 'context')).toBe(`<note>\n${sentences(1)} …\n</note>`)

  // The block ends: its rest is the last part, summarized in its turn; the
  // turn's recap then reads all three.
  await clock.advance(20 * SECOND)
  await running
  expect(asks.length).toBe(3)
  expect(plain(asks[2]?.prompt)).toContain('<note>\n… And so it is settled.\n</note>')

  await $.turn.complete(turnDone({ durationMs: 41_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(4)
  expect(asks[3]?.prompt).toContain('The turn has ended')
  expect(asks[3]?.prompt).toContain('step 1')
  expect(asks[3]?.prompt).toContain('step 2')
  expect(asks[3]?.prompt).toContain('And so it is settled.')
})

test('a short block is one note, kept whole when it ends', async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  // Under the least a part holds: nothing is cut while it streams.
  const running = runStep($, steps, 't1', [thought(0, 'A short thought. '), { wait: 5 * SECOND }, thought(0, 'Done.'), stop])
  await clock.advance(2 * SECOND)
  expect(asks).toEqual([])

  await clock.advance(4 * SECOND)
  await running
  await clock.advance(SECOND)
  expect(asks.length).toBe(1)
  expect(plain(asks[0]?.prompt)).toContain('<note>\nA short thought. Done.\n</note>')
})

test('a long note keeps its opening and its end, where the reasoning lands', async ($, on) => {
  const { asks, steps, clock } = engine(on)
  const long = 'A'.repeat(3_000) + 'B'.repeat(4_000) + 'C'.repeat(3_000)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, long), stop])
  await clock.advance(SECOND)

  const prompt = plain(asks[0]?.prompt)
  expect(prompt).toContain(`<note>\n${'A'.repeat(2_000)}\n[…]\n${'B'.repeat(1_000)}${'C'.repeat(3_000)}\n</note>`)
  expect(prompt).not.toContain('A'.repeat(2_001))
})

test('the next request carries the end of what the last update read, from a sentence on', async ($, on) => {
  const { asks, steps, clock } = engine(on)
  const plan = Array.from({ length: 30 }, (_, at) => `Sentence ${at} of the plan, said at some length.`).join(' ')

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, plan), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Next part.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)

  // About a thousand characters of the plan's end, from the first sentence
  // that starts in them, marked as cut.
  const context = tagged(asks[1]?.prompt, 'context')
  expect(context).toMatch(/^<note>\n… Sentence \d+ of the plan/)
  expect(context.endsWith('Sentence 29 of the plan, said at some length.\n</note>')).toBe(true)
  expect(context).not.toContain('Sentence 0 ')
  expect(context.length).toBeLessThanOrEqual('<note>\n… \n</note>'.length + 1_000)
  expect(tagged(asks[1]?.prompt, 'notes')).toBe('<note>\nNext part.\n</note>')
})

test('Haiku may wait for more notes: the pane says what for, and the notes come back with the next', VIETNAMESE, async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('WAIT: Claude chưa chốt dùng A hay B'), answer('GIST: Claude chọn B.\nDECISION: Dùng B'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Option A is quick. Option B is safe.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(1)
  expect(asks[0]?.system).toContain('Reply WAIT when')
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1s',
    'Đợi thêm: Claude chưa chốt dùng A hay B',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  // Nothing new since the WAIT: no request, however long the gap.
  await clock.advance(20 * SECOND)
  expect(asks.length).toBe(1)

  // A new note: the one Haiku waited on goes again, first.
  await runStep($, steps, 't1', [thought(0, 'B it is.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(2)
  expect(tagged(asks[1]?.prompt, 'notes')).toBe(
    '<note>\nOption A is quick. Option B is safe.\n</note>\n<note>\nB it is.\n</note>',
  )
  expect(asks[1]?.prompt).not.toContain('<context>')
  expect(asks[1]?.prompt).not.toContain(NO_WAIT)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 22s',
    '22s · Claude chọn B.',
    '★ Dùng B',
    'Summary cost $0.004 - Haiku 5.5',
  ])
})

test('after 45 seconds without an update WAIT is not allowed, and a WAIT then gives what it waits for', VIETNAMESE, async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('WAIT'), answer('WAIT: chưa rõ Claude định làm gì'), answer('WAIT: Claude vẫn đang đọc code'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Let me read the code.'), stop])
  await clock.advance(SECOND)
  // A bare WAIT does not say what for.
  expect((await thoughts($))[1]).toBe('Đợi thêm…')

  await runStep($, steps, 't1', [thought(0, 'Reading more of it.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).not.toContain(NO_WAIT)
  expect((await thoughts($))[1]).toBe('Đợi thêm: chưa rõ Claude định làm gì')

  // A long tool call: no new note, until the pane has had no update for 45
  // seconds. Then the notes that waited go once more, with WAIT taken away.
  await clock.advance(28 * SECOND)
  expect(asks.length).toBe(2)
  await clock.advance(SECOND)
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  expect(tagged(asks[2]?.prompt, 'notes')).toBe('<note>\nLet me read the code.\n</note>\n<note>\nReading more of it.\n</note>')

  // Haiku waited all the same: what it waits for becomes the update.
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 45s',
    '45s · Claude vẫn đang đọc code',
    'Summary cost $0.006 - Haiku 5.5',
  ])
})

test('a turn that ends while Haiku waits gets its recap, WAIT not allowed', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('WAIT: chưa rõ Claude định làm gì'), answer('GIST: Claude đã đọc code và dừng ở đó.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Let me read the code.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).toContain('The turn has ended')
  expect(asks[1]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 5s · done',
    'Recap · Claude đã đọc code và dừng ở đó.',
    'Summary cost $0.004 - Haiku 5.5',
  ])
})

test('each note goes to Haiku with its time into the turn', async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await clock.advance(3 * SECOND)
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  expect(asks[0]?.prompt).toContain('<note at="3s">\nFirst note.\n</note>')
})

test('the tool calls since the last update go along in a few words: a command by its description, a file by its name', async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await $.tool.call({ tool: 'Bash', command: 'curl -H "token: s3cret" https://example.test', description: 'Fetch the report' })
  await clock.advance(SECOND)
  expect(tagged(asks[0]?.prompt, 'actions')).toBe('0s · Bash: Fetch the report')
  expect(asks[0]?.prompt).not.toContain('s3cret')

  // After that update: the main loop's calls go, a subagent's stays out.
  await clock.advance(5 * SECOND)
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/pane.tsx', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(10 * SECOND)
  expect(asks.length).toBe(2)
  expect(tagged(asks[1]?.prompt, 'actions')).toBe('6s · Edit: pane.tsx\n6s · Bash')

  // The recap reads the whole turn's calls.
  await $.turn.complete(turnDone({ durationMs: 20_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(tagged(asks[2]?.prompt, 'actions')).toBe('0s · Bash: Fetch the report\n6s · Edit: pane.tsx\n6s · Bash')
})

test('what Claude wrote to the person since the last update goes along, for Haiku not to tell it again', async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Plan it.'), words(1, 'Mình sẽ sửa '), words(1, 'file A.'), stop])
  await clock.advance(SECOND)
  expect(tagged(asks[0]?.prompt, 'said')).toBe('Mình sẽ sửa file A.')
  expect(tagged(asks[0]?.prompt, 'notes')).toBe('<note>\nPlan it.\n</note>')
  expect(asks[0]?.system).toContain('<said>')

  // Read once, it goes no more, and the recap reads none.
  await runStep($, steps, 't1', [thought(0, 'Done it.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).not.toContain('<said>')

  await $.turn.complete(turnDone({ durationMs: 20_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).not.toContain('<said>')
})

test('an assumption shows in the pane, marked ?, and goes back to Haiku with its update', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Claude dùng chung một element rule.\nASSUMPTION: Element là dữ liệu bất biến\nNEXT: Viết test'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Reuse the element.'), stop])
  await clock.advance(SECOND)
  expect(asks[0]?.system).toContain('ASSUMPTION: something Claude takes as true')
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Claude dùng chung một element rule.',
    '? Element là dữ liệu bất biến',
    '→ Viết test',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  await runStep($, steps, 't1', [thought(0, 'Test it.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks[1]?.prompt).toContain(
    '<update>\nGIST: Claude dùng chung một element rule.\nASSUMPTION: Element là dữ liệu bất biến\nNEXT: Viết test\n</update>',
  )
})

// The summary's debug log, under the home directory the engine's process has.
const DEBUG = '/home/me/.claude/session-weather/debug/session-1.md'

const entriesIn = (text: string) => text.match(/^<!-- request [^\n]* -->$/gm)?.length ?? 0

test('the debug log is off until /session-weather-debug, then keeps each request as sent and its reply', async ($, on) => {
  const { asks, replies, steps, clock, files, writes, logs } = engine(on)
  replies.push(answer('WAIT: Claude chưa chốt dùng A hay B'), answer('GIST: Claude chọn B.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Option A is quick. Option B is safe.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(1)

  // Off until asked: no file, no line.
  expect(files.has(DEBUG)).toBe(false)
  expect(logs).toEqual([])

  const ran = await $.command.run({ command: 'session-weather-debug' } as never)
  expect(ran.text).toBe(
    `Summary debug log on: each Haiku request and its reply go to ${DEBUG}, and a line to the transcript. /session-weather-debug turns it off.`,
  )
  expect(writes.at(-1)).toEqual({ key: 'isDebugOn', value: true })
  expect((await thoughts($)).at(-1)).toBe('Summary cost $0.002 - Haiku 5.5 · debug log on')

  await runStep($, steps, 't1', [thought(0, 'B it is.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)

  // The request as sent, under the system prompt, and the reply as it came.
  const text = files.get(DEBUG) ?? ''
  const prompt = asks[1]?.prompt ?? '?'
  expect(text.startsWith('# Summary debug log\n')).toBe(true)
  expect(text).toContain(`\`\`\`text\n${asks[1]?.system}\n\`\`\``)
  expect(text).toContain(`\`\`\`text\n${prompt}\n\`\`\``)
  expect(text).toContain('```text\nGIST: Claude chọn B.\n```')
  expect(text).toContain('· 16s into turn `t1`')
  expect(text).toContain('- Asked for an update or WAIT: notes 1–2 of the turn')
  expect(text).toContain('- Outcome: update: Claude chọn B.')
  expect(entriesIn(text)).toBe(1)
  expect(logs).toEqual([
    { text: `Summary debug: notes 1–2, ${prompt.length} chars → update: Claude chọn B.`, to: 'transcript' },
  ])

  // Off again: the file stays as it was, and no line comes.
  const off = await $.command.run({ command: 'session-weather-debug' } as never)
  expect(off.text).toBe(`Summary debug log off. What it wrote stays in ${DEBUG}`)
  expect((await thoughts($)).at(-1)).toBe('Summary cost $0.004 - Haiku 5.5')

  await runStep($, steps, 't1', [thought(0, 'Done.'), stop])
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(3)
  expect(files.get(DEBUG)).toBe(text)
  expect(logs.length).toBe(1)
})

test('a debug log left on in an earlier session keeps the newest 30 requests', async ($, on) => {
  const { asks, steps, clock, files } = engine(on, { stored: { isDebugOn: true } })

  await $.session.start(start)
  expect((await thoughts($)).at(-1)).toBe('Summary cost $0.000 - Haiku 5.5 · debug log on')

  await $.turn.start({ text: 'fix it', turnId: 't1' })

  for (let at = 0; at < 32; at += 1) {
    await runStep($, steps, 't1', [thought(0, `Note ${at}.`), stop])
    await clock.advance(15 * SECOND)
  }

  expect(asks.length).toBe(32)

  // The two oldest went: the first kept was sent 31 seconds in, the last
  // 7m 46s in.
  const text = files.get(DEBUG) ?? ''
  expect(entriesIn(text)).toBe(30)
  expect(text).not.toContain('· 1s into turn')
  expect(text).not.toContain('· 16s into turn')
  expect(text).toContain('· 31s into turn')
  expect(text).toContain('· 7m 46s into turn')
  expect(text.match(/^# Summary debug log$/gm)?.length).toBe(1)
})

test('a failed request goes to the debug log with why', async ($, on) => {
  const { replies, steps, clock, files, logs } = engine(on, { stored: { isDebugOn: true } })
  replies.push(RATE_LIMITED)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)

  const text = files.get(DEBUG) ?? ''
  expect(text).toContain('- Outcome: failed: rate_limit 429')
  expect(text).toContain('### Reply\n\n(no reply: rate_limit 429)')
  expect(logs.at(-1)?.text).toMatch(/^Summary debug: notes 1–1, \d+ chars → failed: rate_limit 429$/)
})

// The session's log, under the home directory the engine's process has.
const LOG = '/home/me/.claude/session-weather/thinking/session-1.md'
const LOG_TOOL = 'mcp__session-weather__thinking_log'

const two = (n: number) => String(n).padStart(2, '0')

// A section's time, as the host's clock reads it, its offset said.
const when = (ms: number) => {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()

  return [
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    `${two(date.getHours())}:${two(date.getMinutes())}`,
    `UTC${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`,
  ].join(' ')
}

// One turn's section of a log, from its mark to the next one.
const sectionOf = (text: string, turnId: string) => {
  const at = text.indexOf(`<!-- turn ${turnId} -->\n`)
  const next = text.indexOf('\n<!-- turn ', at + 1)

  return at === -1 ? '' : text.slice(at, next === -1 ? undefined : next + 1)
}

test("each turn's updates go to the session's log, its recap first, then the updates in order", async ($, on) => {
  const { files, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Một.\nDECISION: Chỉ sửa file A'),
    answer('GIST: Hai.\nNEXT: Chạy test'),
    answer('GIST: Tổng kết.\nDECISION: A'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix   it\nplease', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)

  // Written as it goes: the turn still running.
  expect(sectionOf(files.get(LOG) ?? '', 't1')).toContain(`## ${when(NOW)} · in progress\n`)

  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 40_000 }) as never)
  await clock.settle()

  const text = files.get(LOG) ?? ''
  expect(text.startsWith('# Thinking log\n\nSession `session-1` in `/work/app`.\n\nWhat Haiku 5.5 said')).toBe(true)
  expect(sectionOf(text, 't1')).toBe(
    [
      '<!-- turn t1 -->',
      `## ${when(NOW)} · 40s · done`,
      '',
      '> fix it please',
      '',
      '- Recap · Tổng kết.',
      '  - ★ A',
      '- 1s · Một.',
      '  - ★ Chỉ sửa file A',
      '- 16s · Hai.',
      '  - → Chạy test',
      '',
      '',
    ].join('\n'),
  )
})

test('a turn with no update leaves no log', async ($, on) => {
  const { files, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [toolStart(0), toolInput(0), stop])
  await $.turn.complete(turnDone({ durationMs: 3_000 }) as never)
  await clock.settle()
  expect([...files.keys()]).toEqual([])
})

test('each turn keeps its own section, and a recap that lands after the next prompt goes to its turn', async ($, on) => {
  const { files, replies, steps, clock } = engine(on)
  // The recap comes back nine and a half seconds after it was asked.
  replies.push(
    answer('GIST: Một.'),
    answer('GIST: Hai.'),
    { wait: 9_500, reply: answer('GIST: Tổng kết.') },
    answer('GIST: Lượt hai.'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 20_000 }) as never)
  await clock.settle()

  // The next prompt comes while the recap is on its way.
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  await runStep($, steps, 't2', [thought(0, 'A note of the second turn.'), stop])
  await clock.advance(10 * SECOND)
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 12_000 }) as never)
  await clock.settle()

  const text = files.get(LOG) ?? ''
  expect(text.slice(text.indexOf('<!-- turn '))).toBe(
    [
      '<!-- turn t1 -->',
      `## ${when(NOW)} · 20s · done`,
      '',
      '> fix it',
      '',
      '- Recap · Tổng kết.',
      '- 1s · Một.',
      '- 16s · Hai.',
      '',
      '<!-- turn t2 -->',
      `## ${when(NOW + 16 * SECOND)} · 12s · done`,
      '',
      '> and now this',
      '',
      '- 10s · Lượt hai.',
      '',
      '',
    ].join('\n'),
  )

  // The pane shows the second turn alone, as before.
  expect((await thoughts($))[1]).toBe('10s · Lượt hai.')
})

test('a resumed session goes on in its log, the sections before left as they were', async ($, on) => {
  const earlier = [
    '# Thinking log',
    '',
    'Session `session-1` in `/work/app`.',
    '',
    'What Haiku 5.5 said of the notes.',
    '',
    '<!-- turn t0 -->',
    '## 2026-10-14 09:00 UTC+07:00 · 5s · done',
    '',
    '> yesterday',
    '',
    '- 1s · Hôm qua.',
    '',
    '',
  ].join('\n')
  const { files, steps, clock } = engine(on, { files: { [LOG]: earlier } })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect(files.get(LOG)).toBe(
    `${earlier}<!-- turn t1 -->\n## ${when(NOW)} · 2s · done\n\n> fix it\n\n- 1s · Claude đang sửa lỗi.\n\n`,
  )
})

// What the thinking_log tool answers, given `input`.
const callLog = async ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown> = {}) =>
  String(((await $.tool.call({ tool: LOG_TOOL, ...input } as never)) as { result?: unknown }).result)

// Where the tool says the log is: the path the mod made, before the host
// resolved it.
const logLead = async ($: Parameters<typeof callLog>[0]) => (await callLog($)).split('\n')[0]

test('on Windows the log sits in the profile, in its separators', async ($, on) => {
  const { steps, clock } = engine(on, { env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', HOME: '/c/Users/me' } })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect(await logLead($)).toBe(
    'The thinking log of this session, C:\\Users\\me\\.claude\\session-weather\\thinking\\session-1.md: 1 turn, oldest first. Each turn shows its recap, or its last update when it has none; `full: true` gives every update.',
  )
})

for (const userProfile of ['C:\\Users\\me', '/mnt/c/Users/me']) {
  test(`elsewhere the log sits under HOME, whatever USERPROFILE WSL passed on (${userProfile})`, async ($, on) => {
    const { files, steps, clock } = engine(on, { env: { HOME: '/home/me', USERPROFILE: userProfile } })

    await $.session.start(start)
    await oneTurn($, steps, clock, 't1', 'fix it')
    expect([...files.keys()]).toEqual([LOG])
  })
}

test('CLAUDE_CONFIG_DIR moves the log with the rest of the configuration', async ($, on) => {
  const { files, steps, clock } = engine(on, { env: { CLAUDE_CONFIG_DIR: '/cfg/claude/', HOME: '/home/me' } })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect([...files.keys()]).toEqual(['/cfg/claude/session-weather/thinking/session-1.md'])
  expect(await logLead($)).toContain('this session, /cfg/claude/session-weather/thinking/session-1.md: 1 turn')
})

test("the thinking_log tool is registered behind ToolSearch, and reads back each turn's recap", async ($, on) => {
  const { registered, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.\nDECISION: Chỉ sửa file A'), answer('GIST: Tổng kết.\nDECISION: A'))

  await $.session.start(start)
  expect(registered).toMatchObject([
    {
      name: 'thinking_log',
      isDeferred: true,
      inputSchema: { properties: { turns: { type: 'integer' }, full: { type: 'boolean' } } },
    },
  ])

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 40_000 }) as never)
  await clock.settle()
  await clock.advance(MINUTE)
  await oneTurn($, steps, clock, 't2', 'and now this')

  const t1 = `## ${when(NOW)} · 40s · done\n\n> fix it\n\n`
  const t2 = `## ${when(NOW + 16 * SECOND + MINUTE)} · 2s · done\n\n> and now this\n\n- 1s · Claude đang sửa lỗi.`
  expect(await callLog($)).toBe(
    [
      `The thinking log of this session, ${LOG}: 2 turns, oldest first. Each turn shows its recap, or its last update when it has none; \`full: true\` gives every update.`,
      `${t1}- Recap · Tổng kết.\n  - ★ A`,
      t2,
    ].join('\n\n'),
  )

  expect(await callLog($, { turns: 1.7, full: true })).toBe(
    `The thinking log of this session, ${LOG}: the last 1 of 2 turns, oldest first.\n\n${t2}`,
  )
  expect(await callLog($, { turns: 2, full: true })).toContain(
    `${t1}- Recap · Tổng kết.\n  - ★ A\n- 1s · Một.\n- 16s · Hai.\n  - ★ Chỉ sửa file A\n\n${t2}`,
  )
})

test('the tool leaves the oldest turns out past its budget, and says when there is no log', async ($, on) => {
  // Sections of one length each.
  const body = (at: number) =>
    `## 2026-10-14 09:${two(at)} UTC+07:00 · 5s · done\n\n> turn ${two(at)}\n\n- 1s · ${'x'.repeat(1_000)}`
  const log = `# Thinking log\n\n${Array.from({ length: 30 }, (_, at) => `<!-- turn t${at} -->\n${body(at)}\n\n`).join('')}`
  const { files } = engine(on)

  await $.session.start(start)
  expect(await callLog($)).toBe(
    'No thinking log for this session yet: no turn has had a thinking summary. It needs the Session Weather summary on, and the Thinking or Verbose transcript view.',
  )

  files.set(LOG, log)
  const fits = Math.floor(20_000 / body(0).length)
  const text = await callLog($, { turns: 30 })
  expect(text).toContain(`: the last ${fits} of 30 turns, oldest first.`)
  expect(text.endsWith(body(29))).toBe(true)
  expect(text).toContain(body(30 - fits))
  expect(text).not.toContain(body(29 - fits))
})

test('a turn that ends with an update under way still gets its recap when the next prompt comes first', async ($, on) => {
  const { asks, files, replies, steps, clock } = engine(on)
  // The second update is still on its way when the turn ends and the next
  // prompt's turn begins.
  replies.push(answer('GIST: Một.'), { wait: 5 * SECOND, reply: answer('GIST: Hai.') }, answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await runStep($, steps, 't1', [thought(0, 'Last note.'), stop])
  await $.turn.complete(turnDone({ durationMs: 17_000 }) as never)
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  await clock.advance(5 * SECOND)
  await clock.settle()

  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')
  expect(asks[2]?.prompt).toContain('Last note.')

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section).toContain(' · 17s · done\n')
  expect(section).toContain('- Recap · Tổng kết.\n- 1s · Một.\n- 16s · Hai.\n')
})

test("a turn whose next prompt begins before its end is taken still closes its log section and gets its recap", async ($, on) => {
  const { asks, files, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  // A queued prompt: its turn begins before the end's own work runs.
  await $.turn.complete(turnDone({ durationMs: 17_000 }) as never)
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  await clock.settle()

  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section).toContain(' · 17s · done\n')
  expect(section).toContain('- Recap · Tổng kết.\n')
})

test("a turn that begins and ends while the last one's recap is on its way gets its own", async ($, on) => {
  const { asks, files, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Một.'),
    answer('GIST: Hai.'),
    { wait: 20 * SECOND, reply: answer('GIST: Tổng kết.') },
    answer('GIST: Lượt hai.'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 17_000 }) as never)
  await clock.settle()

  // The next turn, short, comes and goes while t1's recap takes 20 seconds.
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  await runStep($, steps, 't2', [thought(0, 'A note of the second turn.'), stop])
  await clock.advance(5 * SECOND)
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 5_000 }) as never)
  await clock.advance(20 * SECOND)
  await clock.settle()

  expect(asks.length).toBe(4)
  expect(asks[3]?.prompt).toContain('A note of the second turn.')
  expect((await thoughts($))[1]).toBe('Recap · Lượt hai.')

  const log = files.get(LOG) ?? ''
  expect(sectionOf(log, 't1')).toContain('- Recap · Tổng kết.\n')
  expect(sectionOf(log, 't2')).toContain('- Recap · Lượt hai.\n')
})

test("an update that lands as the next prompt begins goes to its turn's log once", async ($, on) => {
  // The next prompt begins while the debug log takes the recap: after the
  // turn kept it, before the log did.
  let onWrite: (() => Promise<unknown>) | null = null
  const beforeWrite = async (path: string) => {
    const run = onWrite

    if (run !== null && path.includes('/debug/')) {
      onWrite = null
      await run()
    }
  }
  const { files, replies, steps, clock } = engine(on, { stored: { isDebugOn: true }, beforeWrite })
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  onWrite = () => $.turn.start({ text: 'and now this', turnId: 't2' } as never)
  await $.turn.complete(turnDone({ durationMs: 17_000 }) as never)
  await clock.settle()

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section.match(/^- Recap · /gm)?.length).toBe(1)
  expect(section).toContain('- Recap · Tổng kết.\n- 1s · Một.\n- 16s · Hai.\n')
})

test('past 200 notes, those that come while a request is under way are read by the next one', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  for (let at = 0; at < 200; at += 1) {
    await runStep($, steps, 't1', [thought(0, `Note ${at}.`), stop])
  }

  // The first request reads the 200 and takes five seconds; three notes come
  // meanwhile, and the three oldest go.
  replies.push({ wait: 5 * SECOND, reply: answer('GIST: Một.') })
  await clock.advance(SECOND)

  for (let at = 0; at < 3; at += 1) {
    await runStep($, steps, 't1', [thought(0, `Late ${at}.`), stop])
  }

  await clock.advance(5 * SECOND)
  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(2)
  expect(tagged(asks[1]?.prompt, 'notes')).toBe(
    '<note>\nLate 0.\n</note>\n<note>\nLate 1.\n</note>\n<note>\nLate 2.\n</note>',
  )
})

test('a turn of more than 100 updates keeps its first ones in the log', async ($, on) => {
  const { files, replies, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  for (let at = 0; at < 102; at += 1) {
    replies.push(answer(`GIST: Cập nhật ${at}.`))
    await runStep($, steps, 't1', [thought(0, `Note ${at}.`), stop])
    await clock.advance(15 * SECOND)
  }

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section.match(/^- /gm)?.length).toBe(102)
  expect(section).toContain('\n- 1s · Cập nhật 0.\n- 16s · Cập nhật 1.\n')

  expect((await thoughts($))[1]).toBe('25m 16s · Cập nhật 101.')
})

test('where the engine compacts before 90% of the window, the forecast and the toast count toward its threshold', async ($, on) => {
  const { toasts } = engine(on, { breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: true } })

  await $.session.start(start)
  await $.session.measure(measure(140_000, 70))
  expect((await pane($))[0]).toBe('☇ Storm')
  expect(toasts).toEqual([])

  await $.session.measure(measure(152_000, 76))
  expect((await pane($)).slice(0, 2)).toEqual(['ϟ Compact soon', '76% of context · 152k / 200k'])
  expect(toasts).toEqual(['ϟ Context 76% full (152k / 200k): time to /compact'])
})

test("a measurement inside a turn (a limit moved) shows the fill, and the turn's growth counts from where it began", async ($, on) => {
  engine(on, { stored: { isSummaryOff: true } })
  const inside = (tokens: number, percent: number) =>
    ({ context: { tokens, window: 200_000, percent }, rateLimits: limits(26), changed: ['context', 'rateLimits'] }) as never

  await $.session.start(start)
  await $.session.measure(measure(50_000, 25))
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.session.measure(inside(80_000, 40))
  expect((await pane($))[1]).toBe('40% of context · 80k / 200k')
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 60_000 }) as never)
  await $.session.measure(measure(100_000, 50))
  expect(await pane($)).toContain('Last turn ▲ +50k · 1m 0s · 0 tools · cache 96%')

  // The last response's measurement came inside the turn, and none at its
  // end: the fill had not moved since.
  await $.turn.start({ text: 'c', turnId: 't3' })
  await $.session.measure(inside(120_000, 60))
  await $.turn.complete(turnDone({ turnId: 't3', durationMs: 30_000 }) as never)
  expect(await pane($)).toContain('Last turn ▲ +20k · 30s · 0 tools · cache 96%')

  // The next turn counts from there.
  await $.turn.start({ text: 'd', turnId: 't4' })
  await $.turn.complete(turnDone({ turnId: 't4', durationMs: 5_000 }) as never)
  await $.session.measure(measure(125_000, 63))
  expect(await pane($)).toContain('Last turn ▲ +5k · 5s · 0 tools · cache 96%')
})

test('/clear starts the weather and the summary over, and the old turn reaches no log after it', async ($, on) => {
  const { files, replies, steps, clock } = engine(on)
  on('session.end', ($$, e) => ({ sessionId: e.sessionId }))
  replies.push(answer('GIST: Một.'), { wait: 10 * SECOND, reply: answer('GIST: Hai.') })

  await $.session.start(start)
  await $.session.measure(measure(150_000, 75))
  await $.turn.start({ text: 'old private task', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  // The second update is on its way when the person clears.
  await clock.advance(15 * SECOND)
  await ($ as never as { session: { end: (e: unknown) => Promise<unknown> } }).session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  expect((await pane($))[0]).toBe('Context: waiting for the first response.')
  expect((await thoughts($)).slice(0, 2)).toEqual(['🧭 Thinking', 'Waiting for the next turn.'])

  await clock.advance(10 * SECOND)
  await clock.settle()
  expect(files.get(LOG) ?? '').not.toContain('Hai.')

  // The new conversation's first turn counts from empty.
  await $.turn.start({ text: 'new topic', turnId: 't9' })
  await $.turn.complete(turnDone({ turnId: 't9', durationMs: 5_000 }) as never)
  await $.session.measure(measure(12_000, 6))
  expect(await pane($)).toContain('Last turn ▲ +12k · 5s · 0 tools · cache 96%')
})

test('a log past 3 MiB drops its oldest turns, its header and the new turn kept', async ($, on) => {
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const header = '# Thinking log\n\nSession `session-1` in `/work/app`.\n\n'
  const section = (k: number) =>
    `<!-- turn old${k} -->\n## 2026-10-14 09:00 UTC+07:00 · 5m 0s · done\n\n> earlier prompt ${k}\n\n- Recap · Claude đã sửa lỗi phân tích cú pháp.\n\n`
  const parts = [header]
  let size = bytes(header)

  for (let k = 0; size <= 3 * 1024 * 1024; k += 1) {
    parts.push(section(k))
    size += bytes(section(k))
  }

  const { files, steps, clock } = engine(on, { files: { [LOG]: parts.join('') } })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  const log = files.get(LOG) ?? ''
  expect(bytes(log)).toBeLessThanOrEqual(3 * 1024 * 1024)
  expect(log.startsWith(`${header}<!-- turn old`)).toBe(true)
  expect(log).not.toContain('<!-- turn old0 -->')
  expect(log.endsWith('<!-- turn t1 -->\n' + `## ${when(NOW)} · 2s · done\n\n> fix it\n\n- 1s · Claude đang sửa lỗi.\n\n`)).toBe(true)
})

test("a line like an entry's mark inside a prompt leaves the debug log its 30 requests", async ($, on) => {
  const { steps, clock, files } = engine(on, { stored: { isDebugOn: true } })

  await $.session.start(start)
  await $.turn.start({ text: 'why does the log show\n<!-- request 2026-11-06T10:00:00.000Z -->\ntwice?', turnId: 't1' })

  for (let at = 0; at < 32; at += 1) {
    await runStep($, steps, 't1', [thought(0, `Note ${at}.`), stop])
    await clock.advance(15 * SECOND)
  }

  const text = files.get(DEBUG) ?? ''
  expect(text.match(/^## \d\d:\d\d:\d\d · /gm)?.length).toBe(30)
  expect(text.slice(text.indexOf('\n<!-- request ') + 1).split('\n')[1]?.startsWith('## ')).toBe(true)
  expect(text).toContain('· 31s into turn')
  expect(text).not.toContain('· 16s into turn')
})

test('a reload, or a measurement with no fill, after /compact keeps the compaction and its drop', async ($, on) => {
  engine(on, { stored: { isSummaryOff: true } })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await $.session.measure(measure(180_000, 90))
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.session.start(start)
  expect(await pane($)).toEqual(['☀ Compacted', '▼ -160k'])

  await $.session.measure({ context: { window: 200_000 }, rateLimits: limits(26), changed: ['context', 'rateLimits'] } as never)
  expect((await pane($)).slice(0, 2)).toEqual(['☀ Compacted', '▼ -160k'])

  await $.session.measure(measure(46_000, 23))
  expect(await pane($)).toContain('Last turn ▼ -160k')
})

test('a full million reads 1M, and a session that cost nothing $0.00', async ($, on) => {
  engine(on, { cost: 0 })

  await $.session.start(start)
  expect(await pane($)).toContain('Session cost $0.00')

  await $.session.measure({ context: { tokens: 999_960, window: 1_000_000, percent: 100 }, rateLimits: [], changed: ['context' as const] })
  expect((await pane($))[1]).toBe('100% of context · 1M / 1M')
})

test("each prompt's turn reads the person's choices from the store again: a /clear, which wipes the pane's values, does not turn the summary back on", async ($, on) => {
  const { asks, store, steps, clock, files } = engine(on)

  await $.session.start(start)
  expect(await buttons($)).toEqual(['Turn summary off'])

  // What a /clear leaves: the pane's values gone (the summary on, the debug
  // log off, no limits), the store as the person left it.
  store.set('isSummaryOff', true)
  store.set('isDebugOn', true)
  store.set('limits', limits(25))

  await $.turn.start({ text: 'a private task', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A private note.'), stop])
  await clock.advance(20 * SECOND)
  expect(asks).toEqual([])
  expect(await thoughts($)).toEqual(['🧭 Thinking summary is off'])
  expect(await pane($)).toContain('Week 25% · reset in 2d 5h')

  // Turned on again, the debug log the person left on takes the request.
  await press($, 'summary-toggle')
  await clock.settle()
  expect(asks.length).toBe(1)
  expect(files.has(DEBUG)).toBe(true)
})

test("a turn's recap that fails is asked again after the gap, twice at most", async ($, on) => {
  const { asks, files, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), RATE_LIMITED, answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 17_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(await thoughts($)).toContain('Update failed: rate_limit 429')

  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(4)
  expect((await thoughts($))[1]).toBe('Recap · Tổng kết.')
  expect(sectionOf(files.get(LOG) ?? '', 't1')).toContain('- Recap · Tổng kết.\n')

  // One that keeps failing is let go after two more tries.
  replies.push(RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED)
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  await runStep($, steps, 't2', [thought(0, 'A note of the second turn.'), stop])
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  await clock.advance(5 * MINUTE)
  expect(asks.length).toBe(7)
})

test("the recap says when the turn's tool calls were more than it lists", async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  for (let at = 0; at < 40; at += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/work/app/f${at}.ts` } as never)
  }

  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(1)
  expect(asks[0]?.prompt).toContain('The tools Claude called this turn, oldest first, the newest of them (earlier ones left out):')
  expect(tagged(asks[0]?.prompt, 'actions').split('\n')[0]).toBe('0s · Read: f10.ts')
})

test('a value that runs on to the next lines is kept whole; tags with no gist give no update', async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST:\nClaude sửa xong lỗi A.\nGiờ Claude chuyển sang lỗi B.\nNEXT: Chạy test\n\nVậy thôi.'),
    answer('DECISION: Dùng B\nNEXT: Chạy test'),
    answer('GIST: Claude chọn B.\nDECISION: Dùng B'),
  )

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Claude sửa xong lỗi A. Giờ Claude chuyển sang lỗi B.',
    '→ Chạy test',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  // No GIST: the tagged lines are not shown as one, and the note goes again.
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  expect(await thoughts($)).toContain('Update failed: no summary in the reply')
  expect((await thoughts($)).some(text => text.includes('DECISION'))).toBe(false)

  await clock.advance(15 * SECOND)
  expect(asks.length).toBe(3)
  expect(tagged(asks[2]?.prompt, 'notes')).toBe('<note>\nSecond note.\n</note>')
  expect((await thoughts($))[1]).toBe('31s · Claude chọn B.')
})

test("the forecast follows a change of the auto-compact setting from the next turn's end", async ($, on) => {
  const config: { breakdown: Record<string, unknown> } = {
    breakdown: { autoCompactThreshold: 167_000, isAutoCompactEnabled: true },
  }
  engine(on, config)

  await $.session.start(start)
  await $.session.measure(measure(152_000, 76))
  expect((await pane($)).slice(0, 4)).toEqual([
    'ϟ Compact soon',
    '76% of context · 152k / 200k',
    bar(15),
    'auto-compact at 84% · 167k',
  ])

  config.breakdown = { isAutoCompactEnabled: false }
  await $.session.measure(measure(154_000, 77))
  expect((await pane($))[0]).toBe('☇ Storm')
  expect(await pane($)).toContain('auto-compact off')
})

// A subagent of the main loop's, at work, as `$.agent.list()` gives it.
const subagent = (id: string) => ({ id, description: `review ${id}`, type: 'general-purpose', status: 'running' })

// A prompt as `prompt.submit` takes it: the person's own, typed while the
// session was idle, unless `origin` and `turnId` say otherwise.
const submit = (text: string, origin: Record<string, unknown> = { kind: 'composer' }, turnId?: string) =>
  ({ text, origin, wait: false, ...(turnId === undefined ? {} : { turnId }) }) as never

// A subagent's report as the engine hands it back to the main loop: another
// Claude session's message, which begins a turn of its own.
const handBack = (agentId: string) =>
  `<agent-message from="${agentId}"> [Subagent hand-back] The report follows:\n  Found two issues.`

// A turn a background message begins, as the engine raises it: a subagent's
// hand-back unless `kind` says otherwise.
const resume = async (
  $: { prompt: { submit: (e: never) => Promise<unknown> }; turn: { start: (e: never) => Promise<unknown> } },
  text: string,
  turnId: string,
  kind = 'peer',
) => {
  await $.prompt.submit(submit(text, { kind }))
  await $.turn.start({ text, turnId } as never)
}

// The thinking summary's header.
const header = async ($: Test$) => (await thoughts($))[0]

test("a subagent's result goes on with the turn's updates, which wait, not done, while its subagents work", async ($, on) => {
  const { agents, asks, files, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Giao việc cho hai agent.'),
    answer('GIST: Chờ hai agent.'),
    answer('GIST: Agent a1 xong.'),
    answer('GIST: Tổng kết.'),
  )
  const [a1, a2] = [subagent('a1'), subagent('a2')]

  await $.session.start(start)
  await $.prompt.submit(submit('review it'))
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'I will ask two agents.'), stop])
  await clock.advance(SECOND)
  agents.push(a1, a2)
  await runStep($, steps, 't1', [thought(0, 'Both agents run; I wait for them.'), stop])
  await clock.advance(4 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()

  // Not done: an update says where Claude stands, WAIT not allowed, and no
  // recap yet; the clock runs on.
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).toContain('Claude has ended its turn to wait for subagents it started')
  expect(asks[1]?.prompt).not.toContain('The turn has ended')
  expect(asks[1]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  expect(await header($)).toBe('🧭 Thinking · 5s · waiting for 2 subagents')
  expect(sectionOf(files.get(LOG) ?? '', 't1')).toContain(`## ${when(NOW)} · waiting for 2 subagents\n`)

  await clock.advance(MINUTE)
  expect(asks.length).toBe(2)
  expect(await header($)).toBe('🧭 Thinking · 1m 5s · waiting for 2 subagents')

  // a1 hands back: its turn goes on with the updates, under the person's
  // request.
  a1.status = 'completed'
  await resume($, handBack('a1'), 't2')
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 5s',
    '5s · Chờ hai agent.',
    RULE,
    '1s · Giao việc cho hai agent.',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  await runStep($, steps, 't2', [thought(0, 'Agent a1 found two issues; a2 still runs.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('<request>\nreview it\n</request>')
  expect(tagged(asks[2]?.prompt, 'notes')).toBe('<note>\nAgent a1 found two issues; a2 still runs.\n</note>')

  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(await header($)).toBe('🧭 Thinking · 1m 6s · waiting for 1 subagent')

  // a2, the last, hands back: the turn ends with it, its length from the
  // person's prompt, and its recap reads the whole of it.
  a2.status = 'completed'
  await resume($, handBack('a2'), 't3')
  await runStep($, steps, 't3', [thought(0, 'Both agents are in; I fix the two issues.'), stop])
  await clock.advance(9 * SECOND)
  await $.turn.complete(turnDone({ turnId: 't3', durationMs: 9_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(4)
  expect(asks[3]?.prompt).toContain('The turn has ended')

  for (const note of ['I will ask two agents.', 'Agent a1 found two issues', 'Both agents are in']) {
    expect(tagged(asks[3]?.prompt, 'notes')).toContain(note)
  }

  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 15s · done',
    'Recap · Tổng kết.',
    RULE,
    '1m 6s · Agent a1 xong.',
    RULE,
    '5s · Chờ hai agent.',
    RULE,
    '1s · Giao việc cho hai agent.',
    'Summary cost $0.008 - Haiku 5.5',
  ])

  // One section in the log, under the person's prompt.
  const log = files.get(LOG) ?? ''
  expect(sectionOf(log, 't1')).toContain(`## ${when(NOW)} · 1m 15s · done\n\n> review it\n\n- Recap · Tổng kết.\n`)
  expect(log).not.toContain('<!-- turn t2 -->')
  expect(log).not.toContain('<!-- turn t3 -->')
})

test("a measurement while the turn waits on its subagents counts the last turn's growth", async ($, on) => {
  const { agents, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  agents.push(subagent('a1'))
  await $.turn.complete(turnDone() as never)
  await clock.settle()
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('Last turn ▲ +90k · 2m 14s · 0 tools · cache 96%')
})

test("a prompt of the person's own while the turn waits starts the updates over, and the waiting turn gets its recap", async ($, on) => {
  const { agents, asks, files, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.prompt.submit(submit('review it'))
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  agents.push(subagent('a1'))
  await runStep($, steps, 't1', [thought(0, 'I wait for a1.'), stop])
  await clock.advance(4 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(2)

  await clock.advance(20 * SECOND)
  await $.prompt.submit(submit('and now this'))
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.004 - Haiku 5.5'])

  // The turn that waited ends where its last turn did, and its recap comes.
  await clock.advance(SECOND)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('<request>\nreview it\n</request>')
  expect(asks[2]?.prompt).toContain('The turn has ended')

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section).toContain(' · 5s · done\n')
  expect(section).toContain('- Recap · Tổng kết.\n- 1s · Một.\n- 5s · Hai.\n')
})

test('a turn whose subagents all end with no result waking Claude is done half a minute after', async ($, on) => {
  const { agents, asks, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))
  const a1 = subagent('a1')

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  agents.push(a1)
  await runStep($, steps, 't1', [thought(0, 'I wait for a1.'), stop])
  await $.turn.complete(turnDone({ durationMs: 1_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(2)

  // Stopped, and no word of it wakes Claude.
  a1.status = 'killed'
  await clock.advance(15 * SECOND)
  expect(await header($)).toBe('🧭 Thinking · 16s · waiting')

  await clock.advance(25 * SECOND)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')
  expect(await header($)).toBe('🧭 Thinking · 11s · done')

  // Done: the clock stops, and nothing more is asked.
  await clock.advance(MINUTE)
  expect(asks.length).toBe(3)
})

test("a background task's notification after the turn ended reopens it; one update after its recap needs none again", async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'), answer('GIST: Build xong.'))

  await $.session.start(start)
  await $.prompt.submit(submit('build it'))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 20_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(await header($)).toBe('🧭 Thinking · 20s · done')

  await clock.advance(MINUTE)
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
  await resume($, notice, 't2', 'task-notification')
  expect(await header($)).toBe('🧭 Thinking · 1m 16s')
  expect((await thoughts($))[1]).toBe('Recap · Tổng kết.')

  await runStep($, steps, 't2', [thought(0, 'The build passed.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 2_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(4)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 17s · done',
    '1m 17s · Build xong.',
    RULE,
    'Recap · Tổng kết.',
    RULE,
    '16s · Hai.',
    RULE,
    '1s · Một.',
    'Summary cost $0.008 - Haiku 5.5',
  ])
})

test('a prompt the person typed while a turn ran starts over, though a notification came in after it', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await $.prompt.submit(submit('fix it'))
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  // Typed while t1 runs: it waits in the queue.
  await $.prompt.submit(submit('and now this', { kind: 'composer' }, 't1'))
  await $.turn.complete(turnDone({ durationMs: 2_000 }) as never)
  await clock.settle()

  // A notification goes into the conversation with no turn of its own, then
  // the queued prompt's turn begins.
  await $.prompt.submit(submit('<task-notification>\n<task-id>b1</task-id>\n</task-notification>', { kind: 'task-notification' }))
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])
})

test('a hand-back no prompt.submit showed is known by its frame, and goes on with the turn', async ($, on) => {
  const { agents, steps, clock } = engine(on)
  const a1 = subagent('a1')

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  agents.push(a1)
  await $.turn.complete(turnDone({ durationMs: 2_000 }) as never)
  await clock.settle()
  expect(await header($)).toBe('🧭 Thinking · 1s · waiting for 1 subagent')

  a1.status = 'completed'
  await $.turn.start({ text: handBack('a1'), turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 1s', '1s · Claude đang sửa lỗi.', 'Summary cost $0.002 - Haiku 5.5'])

  // So with an origin the mod does not know.
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  await resume($, handBack('a2'), 't3', 'unclassified')
  expect((await thoughts($))[1]).toBe('1s · Claude đang sửa lỗi.')
})

test("a prompt of the person's own that quotes a hand-back's frame starts over", async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  await resume($, handBack('a1'), 't2', 'composer')
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])
})

// The settings, the manifest's `userConfig`: each a row in `/config`, which
// keys it `session-weather.<field>`, and a change there loads the mod again
// with the new values, as a test's `options` load it.
type Spec = { description: string }

// The `/config` writer beneath the mod: what reached it, and as what.
const configWriter = (on: On) => {
  const written: { key: string; value: unknown }[] = []
  on('config.set', ($, e) => {
    written.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return written
}

// The person setting a row in the `/config` menu: one of a plugin's own
// `userConfig` fields where the key names a plugin, else the panel's.
const setRow = ($: { config: { set: (e: ConfigSetInput) => Promise<unknown> } }, key: string, value: ConfigValue) => {
  const plugin = /^[^.]+(?=\.)/.exec(key)?.[0]

  return $.config.set({
    key,
    value,
    previous: value,
    provider: plugin === undefined ? { plugin: 'engine', tier: 'core' } : { plugin, tier: 'user' },
    origin: { kind: 'composer' },
  })
}

test('with nothing set, the summary is in English, 15 seconds apart, and Compact soon comes at 90%', async ($, on) => {
  const { asks, registered, replies, steps, clock, toasts } = engine(on)
  replies.push(answer('WAIT'))

  await $.session.start(start)
  expect((registered[0] as Spec).description).toContain('summarized thinking, in English:')

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  expect(asks[0]?.system).toContain('\nWrite in English, plainly,')
  expect(asks[0]?.system).not.toContain('Vietnamese')
  expect((await thoughts($))[1]).toBe('Waiting…')

  await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
  await clock.advance(14 * SECOND)
  expect(asks.length).toBe(1)
  await clock.advance(SECOND)
  expect(asks.length).toBe(2)

  await $.session.measure(measure(178_000, 89))
  expect((await pane($))[0]).toBe('☇ Storm')
  expect(toasts).toEqual([])
  await $.session.measure(measure(180_000, 90))
  expect((await pane($))[0]).toBe('ϟ Compact soon')
  expect(toasts).toEqual(['ϟ Context 90% full (180k / 200k): time to /compact'])
})

test(
  "the language set goes to Haiku, the thinking_log tool and the debug log; the pane's word for a WAIT stays English",
  { options: { summaryLanguage: 'Japanese' } },
  async ($, on) => {
    const { asks, files, registered, replies, steps, clock } = engine(on, { stored: { isDebugOn: true } })
    replies.push(answer('WAIT'), answer('WAIT: Claudeはまだ A と B を決めていない'))

    await $.session.start(start)
    expect((registered[0] as Spec).description).toContain('summarized thinking, in Japanese:')

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await runStep($, steps, 't1', [thought(0, 'Option A is quick.'), stop])
    await clock.advance(SECOND)
    expect(asks[0]?.system).toContain('\nWrite in Japanese, plainly,')
    expect(asks[0]?.system).not.toContain('English')
    expect((await thoughts($))[1]).toBe('Waiting…')

    await runStep($, steps, 't1', [thought(0, 'Option B is safe.'), stop])
    await clock.advance(15 * SECOND)
    expect((await thoughts($))[1]).toBe('Waiting: Claudeはまだ A と B を決めていない')

    // The debug log shows the prompt in Japanese, and each request names it
    // by that prompt's own mark.
    const text = files.get(DEBUG) ?? ''
    const mark = /^The system prompt, `([0-9a-f]{8})`/m.exec(text)?.[1]
    expect(text).toContain(`\`\`\`text\n${asks[1]?.system}\n\`\`\``)
    expect(mark).toBeDefined()
    expect(text.match(new RegExp(`system prompt \`${mark}\`\\.$`, 'gm'))?.length).toBe(2)
  },
)

test("Vietnamese set, the summary and the pane's word for a WAIT are Vietnamese", VIETNAMESE, async ($, on) => {
  const { asks, registered, replies, steps, clock } = engine(on)
  replies.push(answer('WAIT'), answer('WAIT: Claude chưa chốt dùng A hay B'))

  await $.session.start(start)
  expect((registered[0] as Spec).description).toContain('summarized thinking, in Vietnamese:')

  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'Option A is quick.'), stop])
  await clock.advance(SECOND)
  expect(asks[0]?.system).toContain('\nWrite in Vietnamese, plainly,')
  expect((await thoughts($))[1]).toBe('Đợi thêm…')

  await runStep($, steps, 't1', [thought(0, 'Option B is safe.'), stop])
  await clock.advance(15 * SECOND)
  expect((await thoughts($))[1]).toBe('Đợi thêm: Claude chưa chốt dùng A hay B')
})

test(
  "a language named the Vietnamese way keeps the pane's Vietnamese word",
  { options: { summaryLanguage: '  tiếng Việt ' } },
  async ($, on) => {
    const { asks, replies, steps, clock } = engine(on)
    replies.push(answer('WAIT'))

    await $.session.start(start)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
    await clock.advance(SECOND)
    expect(asks[0]?.system).toContain('\nWrite in tiếng Việt, plainly,')
    expect((await thoughts($))[1]).toBe('Đợi thêm…')
  },
)

test('a blank language is the default', { options: { summaryLanguage: '   ' } }, async ($, on) => {
  const { asks, steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  expect(asks[0]?.system).toContain('\nWrite in English, plainly,')
})

test(
  'a language set over several lines, or at length, reaches the prompt as one short line',
  { options: { summaryLanguage: 'English\n\nand  then, all in capitals, a very long tail' } },
  async ($, on) => {
    const { asks, steps, clock } = engine(on)

    await $.session.start(start)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
    await clock.advance(SECOND)
    // Cut at 40 characters.
    expect(asks[0]?.system).toContain('\nWrite in English and then, all in capitals, a ver, plainly,')
  },
)

test(
  'the gap set paces the requests, and the silence before WAIT is taken away is three of it',
  { options: { summaryGapSeconds: 5 } },
  async ($, on) => {
    const { asks, replies, steps, clock } = engine(on)
    replies.push(answer('WAIT'), answer('WAIT'), answer('WAIT'))

    await $.session.start(start)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await runStep($, steps, 't1', [thought(0, 'Let me read the code.'), stop])
    await clock.advance(SECOND)
    expect(asks.length).toBe(1)

    // A new note: asked for 5 seconds after the last request, not before.
    await runStep($, steps, 't1', [thought(0, 'Reading more of it.'), stop])
    await clock.advance(4 * SECOND)
    expect(asks.length).toBe(1)
    await clock.advance(SECOND)
    expect(asks.length).toBe(2)
    expect(asks[1]?.prompt).not.toContain(NO_WAIT)

    // No new note: 15 seconds into a turn with no update, WAIT is taken away.
    await clock.advance(8 * SECOND)
    expect(asks.length).toBe(2)
    await clock.advance(SECOND)
    expect(asks.length).toBe(3)
    expect(asks[2]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  },
)

test('a gap under 5 seconds counts as 5', { options: { summaryGapSeconds: 1 } }, async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('WAIT'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
  await clock.advance(4 * SECOND)
  expect(asks.length).toBe(1)
  await clock.advance(SECOND)
  expect(asks.length).toBe(2)
})

test(
  'a gap over 120 seconds counts as 120, and a failed recap waits 30 seconds at most',
  { options: { summaryGapSeconds: 600 } },
  async ($, on) => {
    const { asks, replies, steps, clock } = engine(on)
    replies.push(answer('WAIT'), answer('WAIT'), RATE_LIMITED, answer('GIST: Tổng kết.'))

    await $.session.start(start)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
    await clock.advance(SECOND)
    await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
    await clock.advance(119 * SECOND)
    expect(asks.length).toBe(1)
    await clock.advance(SECOND)
    expect(asks.length).toBe(2)

    // The turn ends: its recap is asked at once, and once more 30 seconds
    // after it failed, not a whole gap.
    await $.turn.complete(turnDone({ durationMs: 121_000 }) as never)
    await clock.settle()
    expect(asks.length).toBe(3)

    await clock.advance(29 * SECOND)
    expect(asks.length).toBe(3)
    await clock.advance(SECOND)
    expect(asks.length).toBe(4)
    expect((await thoughts($))[1]).toBe('Recap · Tổng kết.')
  },
)

test(
  'Compact soon set lower moves the forecast, the toast and the status line with it',
  { options: { compactSoonPercent: 80 } },
  async ($, on) => {
    const { clock, status, toasts } = engine(on, { columns: 120 })

    // The line is read before the pane is drawn, which takes it away.
    await $.session.start(start)
    await clock.settle()
    await $.session.measure(measure(158_000, 79))
    expect(status()).toBe('☇ 79%')
    expect((await pane($))[0]).toBe('☇ Storm')
    expect(toasts).toEqual([])

    await $.session.measure(measure(160_000, 80))
    expect(status()).toBe('ϟ 80%')
    expect((await pane($))[0]).toBe('ϟ Compact soon')
    expect(toasts).toEqual(['ϟ Context 80% full (160k / 200k): time to /compact'])
  },
)

test('Compact soon set under 76 counts as 76, so Storm keeps 75', { options: { compactSoonPercent: 50 } }, async ($, on) => {
  const { toasts } = engine(on)

  const table = [
    [74, '☂ Showers'],
    [75, '☇ Storm'],
    [76, 'ϟ Compact soon'],
  ] as const

  for (const [percent, sky] of table) {
    await $.session.measure(measure(percent * 2_000, percent))
    expect([percent, (await pane($))[0]]).toEqual([percent, sky])
  }

  expect(toasts).toEqual(['ϟ Context 76% full (152k / 200k): time to /compact'])
})

test('Compact soon set over 100 counts as 100', { options: { compactSoonPercent: 150 } }, async ($, on) => {
  engine(on)

  await $.session.measure(measure(198_000, 99))
  expect((await pane($))[0]).toBe('☇ Storm')
  await $.session.measure(measure(200_000, 100))
  expect((await pane($))[0]).toBe('ϟ Compact soon')
})

test('a setting changed in /config is stored as the mod will use it; other rows pass as they came', async ($, on) => {
  engine(on)
  const written = configWriter(on)

  await setRow($, 'session-weather.summaryGapSeconds', 1)
  await setRow($, 'session-weather.summaryGapSeconds', 22.4)
  await setRow($, 'session-weather@ddt313-mods.summaryGapSeconds', 900)
  await setRow($, 'session-weather.compactSoonPercent', 50)
  await setRow($, 'session-weather.summaryLanguage', '  Japanese \n')
  await setRow($, 'session-weather.summaryLanguage', '')
  await setRow($, 'session-weather.cleanupDays', -3)
  await setRow($, 'session-weather.cleanupDays', 7.6)
  await setRow($, 'session-weather.cleanupDays', 99_999)
  await setRow($, 'session-weather.recentTurns', 0)
  await setRow($, 'session-weather.recentTurns', 99)
  // A value of the wrong kind is the engine's to refuse.
  await setRow($, 'session-weather.summaryGapSeconds', 'soon')
  await setRow($, 'theme', 'dark')
  await setRow($, 'other-mod.summaryGapSeconds', 1)

  expect(written).toEqual([
    { key: 'session-weather.summaryGapSeconds', value: 5 },
    { key: 'session-weather.summaryGapSeconds', value: 22 },
    { key: 'session-weather@ddt313-mods.summaryGapSeconds', value: 120 },
    { key: 'session-weather.compactSoonPercent', value: 76 },
    { key: 'session-weather.summaryLanguage', value: 'Japanese' },
    { key: 'session-weather.summaryLanguage', value: 'English' },
    { key: 'session-weather.cleanupDays', value: 0 },
    { key: 'session-weather.cleanupDays', value: 8 },
    { key: 'session-weather.cleanupDays', value: 3650 },
    { key: 'session-weather.recentTurns', value: 1 },
    { key: 'session-weather.recentTurns', value: 30 },
    { key: 'session-weather.summaryGapSeconds', value: 'soon' },
    { key: 'theme', value: 'dark' },
    { key: 'other-mod.summaryGapSeconds', value: 1 },
  ])
})
