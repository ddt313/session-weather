import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const PANE = {
  component: 'Pane',
  requestId: 'session-weather',
  props: {
    title: 'Session Weather',
    isFocused: false,
    // Wide, so an update's lines draw one row each; the tests of rows lay
    // the pane out narrower.
    bodyColumns: 200,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const bar = (filled: number) => '█'.repeat(filled) + '░'.repeat(20 - filled)

// Stands for the engine beneath the mod: what it opens, redraws, toasts and
// stores; `stored` is what earlier sessions left in the mod's store, `files`
// what the disk holds, `env` the variables the process has (a home directory
// unless given), and `beforeWrite` runs as a file is about to be written.
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
    env?: Record<string, string>
    beforeWrite?: (path: string) => Promise<unknown>
  } = {},
) => {
  const opens: unknown[] = []
  const toasts: string[] = []
  // The lines the mod logged, and where to.
  const logs: { text: string; to: string }[] = []
  const writes: { key: string; value: unknown }[] = []
  // The disk, by path, and the tools the mod registered.
  const files = new Map(Object.entries(usage.files ?? {}))
  const registered: unknown[] = []
  // What each `$.turn.step` streams, in turn (a `{ wait }` holds the stream
  // that many milliseconds of the clock); what Haiku was asked, and the
  // replies it gives, in turn (a plain summary once they run out).
  const steps: unknown[][] = []
  const asks: { model: string; prompt: string; system?: string; effort?: string }[] = []
  const replies: unknown[] = []
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
      startedAt: 0,
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
  on('tool.call', () => ({ deny: 'not run in this test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.open', ($, e) => {
    opens.push(e)

    return { value: { isPlaced: true } }
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
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('fs.exists', ($, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', ($, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.write', async ($, e) => {
    await usage.beforeWrite?.(key(e.path))
    files.set(key(e.path), e.text)

    return { value: undefined }
  })
  on('tool.register', ($, e, next) => {
    registered.push(e)

    return next(e)
  })

  return { clock, opens, toasts, logs, writes, steps, asks, replies, files, store, registered, redraws: () => redraws }
}

const start = { cwd: '/tmp', surface: 'desktop' as const, isInteractive: true }

type Mounted = {
  findAll: (q: { type: string }) => Promise<{ text: string }[]>
  unmount: () => Promise<void>
}
type Test$ = { ui: { mount: (target: never) => Promise<unknown>; press: (target: never) => Promise<unknown> } }

// The pane drawn on `surface`, `columns` wide when given.
const mount = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop', columns?: number) =>
  (await $.ui.mount({
    plugin: 'session-weather',
    surface,
    ...PANE,
    props: { ...PANE.props, ...(columns === undefined ? {} : { bodyColumns: columns }) },
  } as never)) as Mounted

// Everything the pane shows, one string per Text, on the surface named, in a
// pane `columns` wide when given.
const allTexts = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop', columns?: number) => {
  const ui = await mount($, surface, columns)
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()

  return texts
}

// Where the thinking summary begins: its header, or the line saying it is off.
const SUMMARY_TOP = (text: string) => text.startsWith('🧭')

// The weather: what the pane shows above the thinking summary.
const pane = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop') => {
  const texts = await allTexts($, surface)
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

// The labels of the pane's Buttons.
const buttons = async ($: Test$) => {
  const ui = await mount($)
  const labels = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return labels
}

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

test("Haiku reads the main loop's thinking notes, and the pane shows what it says", async ($, on) => {
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

test('Haiku may wait for more notes: the pane says what for, and the notes come back with the next', async ($, on) => {
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

test('after 45 seconds without an update WAIT is not allowed, and a WAIT then gives what it waits for', async ($, on) => {
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
