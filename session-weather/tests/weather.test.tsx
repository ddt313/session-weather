// The weather: the forecast, the context's fill and growth, the limits,
// compactions and the session's line.

import { expect, test } from 'claude-code/testing'
import { at, bar, BREAKDOWN, category, clockOf, DAY, endSession, engine, HOUR, limits, limitsShown, measure, measureLimits, MINUTE, NOW, PACED, pane, SECOND, sessionShown, SLOW, start, SUMMARY, turnDone, WIDE_FROM } from './helpers'

const compacted = {
  context: { window: 200_000 },
  rateLimits: [],
  changed: ['context' as const],
}

test('the pane opens as the session starts, with the weather, its fill, the growth and the limits', SLOW, async ($, on) => {
  const { opens } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  expect(opens).toEqual([{ id: 'session-weather', title: 'Session Weather', rows: 12 }])

  await $.session.measure(measure(90_000, 45))

  // The desktop draws its own layout: see the desktop tests.
  expect(await pane($, 'terminal')).toEqual([
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

test('from WIDE_FROM columns each limit bar marks the share of its time gone, and says where its share would stand at the reset', async ($, on) => {
  engine(on, { rateLimits: PACED })

  await $.session.start(start)

  // A column short of it: the bars as they were, no mark, no pace.
  expect(await limitsShown($, 'terminal', WIDE_FROM - 1)).toEqual([
    '5h 11% · reset in 2h 22m',
    `${bar(2)} [dim]`,
    'Week 75% · reset in 18h 52m',
    `${bar(15)} [dim]`,
  ])

  for (const surface of ['terminal'] as const) {
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

test('from WIDE_FROM columns what fills the context stands under the auto-compact line, largest first, the rest in one', async ($, on) => {
  const breakdown = { ...BREAKDOWN }
  engine(on, { breakdown })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))

  // A column short of it, as it was.
  expect(await pane($, 'terminal', WIDE_FROM - 1)).toEqual([
    '☁ Cloudy',
    '45% of context · 90k / 200k',
    bar(9),
    'auto-compact at 92% · 184k',
    'Last turn ▲ +90k',
  ])

  for (const surface of ['terminal'] as const) {
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
  const after = await pane($, 'terminal', WIDE_FROM)
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

  // A column short of it, the cost as it was.
  const narrow = await pane($, 'terminal', WIDE_FROM - 1)
  expect(narrow.at(-1)).toBe('Session cost $16.17')
  expect(narrow.some(text => text.includes('Fable'))).toBe(false)

  for (const surface of ['terminal'] as const) {
    // From it, no prompt yet: none said.
    expect((await sessionShown($, surface)).at(-1)).toBe(`Fable 5.2 · ${since} · $16.17`)
  }

  // 23 prompts and two compactions on, the line takes a second row.
  setTurns(23)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })

  for (const surface of ['terminal'] as const) {
    expect((await sessionShown($, surface)).slice(-2)).toEqual([`Fable 5.2 · ${since} · 23 turns`, '2 compactions · $16.17'])
  }

  expect((await pane($, 'terminal', WIDE_FROM - 1)).at(-1)).toBe('Session cost $16.17')
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
