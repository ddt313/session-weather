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
// stores; `stored` is what earlier sessions left in the mod's store.
const engine = (
  on: On,
  usage: {
    tokens?: number
    percent?: number
    rateLimits?: unknown[]
    stored?: Record<string, unknown>
    breakdown?: Record<string, unknown>
    cost?: number
  } = {},
) => {
  const opens: unknown[] = []
  const toasts: string[] = []
  const writes: { key: string; value: unknown }[] = []
  // What each `$.turn.step` streams, in turn (a `{ wait }` holds the stream
  // that many milliseconds of the clock); what Haiku was asked, and the
  // replies it gives, in turn (a plain summary once they run out).
  const steps: unknown[][] = []
  const asks: { model: string; prompt: string; system?: string; effort?: string }[] = []
  const replies: unknown[] = []
  let redraws = 0
  const { tokens, percent, rateLimits = [], stored = {}, breakdown, cost } = usage
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
  on('model.complete', ($, e) => {
    asks.push({ model: e.model, prompt: e.prompt, system: e.system, effort: e.effort })

    return { value: (replies.shift() ?? answer(PLAIN)) as never }
  })

  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200_000,
        ...(tokens === undefined ? {} : { tokens, percent }),
        ...(e.breakdown !== undefined && breakdown !== undefined ? { breakdown } : {}),
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
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    writes.push({ key: e.key, value: e.value })

    return { value: undefined }
  })

  return { clock, opens, toasts, writes, steps, asks, replies, redraws: () => redraws }
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

// Everything the pane shows, one string per Text, on the surface named.
const allTexts = async ($: Test$, surface: 'desktop' | 'terminal' = 'desktop') => {
  const ui = await mount($, surface)
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
  const ui = await mount($, surface, columns)
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  await ui.unmount()
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

// Pieces of one streamed response.
const thought = (index: number, text: string) => ({ kind: 'thinking', index, text })
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

  // The next turn counts its own tool calls from zero.
  await $.turn.start({ text: 'and this', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 9_000, isAborted: true }) as never)
  expect(await pane($)).toContain('Last turn ▲ +90k · 9s (interrupted) · 1 tool · cache 96%')
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
  expect(asks[0]?.prompt).toContain("<note>\nI'm going with the user's choice to add only the top tool's keys.\n</note>")
  expect(asks[0]?.prompt).toContain('<note>\nNext I will check the Press page.\n</note>')

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

  // The second update reads the new note alone, and what the first said.
  await clock.advance(5 * SECOND)
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).toContain('Second note.')
  expect(asks[1]?.prompt).not.toContain('First note.')
  expect(asks[1]?.prompt).toContain('<update>\nGIST: Một.\nDECISION: Chỉ sửa file A\n</update>')

  // The first update stays, under the second.
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 16s',
    '16s · Hai.',
    '→ Chạy test',
    '1s · Một.',
    '★ Chỉ sửa file A',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  // Nothing new: the clock ticks on without asking.
  await clock.advance(20 * SECOND)
  expect(asks.length).toBe(2)

  // The recap reads the whole turn, and stands on top.
  await $.turn.complete(turnDone({ durationMs: 40_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')
  expect(asks[2]?.prompt).toContain('First note.')
  expect(asks[2]?.prompt).toContain('Second note.')
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 40s · done',
    'Recap · Tổng kết.',
    '★ A',
    '★ B',
    '★ C',
    '16s · Hai.',
    '→ Chạy test',
    '1s · Một.',
    '★ Chỉ sửa file A',
    'Summary cost $0.006 - Haiku 5.5',
  ])

  // The recap is the turn's last word: no more asking.
  await clock.advance(60 * SECOND)
  expect(asks.length).toBe(3)
})

test('a new prompt starts the updates over', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ durationMs: 2_000 }) as never)
  await clock.settle()
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
  expect((await thoughts($)).slice(0, 3)).toEqual([
    '🧭 Thinking · 3s · done',
    'Recap · Claude đang sửa lỗi.',
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
  replies.push({
    isAnswered: false,
    reason: 'api-error',
    status: 429,
    error: 'rate_limit',
    usage: { ...USAGE, input_tokens: 0, output_tokens: 0 },
  })

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
  expect(asks[0]?.prompt).toContain(`<note>\n${sentences(1)} …\n</note>`)
  expect(asks[0]?.system).toContain('was cut while Claude was still writing it')

  // Its second, after the gap and once written: the new part alone.
  await clock.advance(20 * SECOND)
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).toContain(`<note>\n… ${sentences(2)} …\n</note>`)
  expect(asks[1]?.prompt).not.toContain('step 1')

  // The block ends: its rest is the last part, summarized in its turn; the
  // turn's recap then reads all three.
  await clock.advance(20 * SECOND)
  await running
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('<note>\n… And so it is settled.\n</note>')

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
  expect(asks[0]?.prompt).toContain('<note>\nA short thought. Done.\n</note>')
})

test('a long note keeps its opening and its end, where the reasoning lands', async ($, on) => {
  const { asks, steps, clock } = engine(on)
  const long = 'A'.repeat(3_000) + 'B'.repeat(4_000) + 'C'.repeat(3_000)

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, long), stop])
  await clock.advance(SECOND)

  const prompt = asks[0]?.prompt ?? ''
  expect(prompt).toContain(`<note>\n${'A'.repeat(2_000)}\n[…]\n${'B'.repeat(1_000)}${'C'.repeat(3_000)}\n</note>`)
  expect(prompt).not.toContain('A'.repeat(2_001))
})
