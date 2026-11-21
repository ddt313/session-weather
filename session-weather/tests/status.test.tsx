// The status line, and the pane the person closed.

import { expect, test } from 'claude-code/testing'
import { at, DAY, engine, HOUR, measure, measureLimits, MINUTE, mount, SECOND, SLOW, start, SUMMARY, WIDE_FROM } from './helpers'

test('a pane the person closed stays closed in later sessions until /session-weather', SLOW, async ($, on) => {
  const { opens, writes } = engine(on, { stored: { isClosed: true } })

  await $.session.start(start)
  expect(opens).toEqual([])

  const ran = await $.command.run({ command: 'session-weather' })
  expect(ran.text).toBeUndefined()
  expect(opens).toEqual([{ id: 'session-weather', title: 'Session Weather', rows: 12 }])
  expect(writes.at(-1)).toEqual({ key: 'isClosed', value: false })
})

test('/session-weather is a switch: it closes the pane drawn, kept closed in later sessions, and opens it again', SLOW, async ($, on) => {
  const { opens, panes, writes } = engine(on)

  await $.session.start(start)
  expect(panes.map(pane => pane.id)).toEqual(['session-weather'])

  // Drawn: the command closes it, as the person's own close does.
  await $.command.run({ command: 'session-weather' } as never)
  expect(panes).toEqual([])
  expect(writes.at(-1)).toEqual({ key: 'isClosed', value: true })
  expect(opens.length).toBe(1)

  // Closed: it opens again.
  await $.command.run({ command: 'session-weather' } as never)
  expect(panes.map(pane => pane.id)).toEqual(['session-weather'])
  expect(writes.at(-1)).toEqual({ key: 'isClosed', value: false })
  expect(opens.length).toBe(2)
})

// The 5-hour window at 30%, resetting in 4h 38m.
const FIVE_HOUR = [{ kind: 'five_hour', percentUsed: 30.2, resetsAt: at(4 * HOUR + 38 * MINUTE) }]

// The person's /session-weather.
const command = ($: { command: { run: (e: never) => Promise<unknown> } }) =>
  $.command.run({ command: 'session-weather' } as never)

test('in the terminal the pane asks to open WIDE_FROM columns wide, the two columns side by side; on the desktop, no width', async ($, on) => {
  const { opens } = engine(on)

  await $.session.start({ ...start, surface: 'terminal' as never })
  expect(opens).toEqual([{ id: 'session-weather', title: 'Session Weather', rows: 12, columns: WIDE_FROM }])

  await $.session.start(start)
  expect(opens.at(-1)).toEqual({ id: 'session-weather', title: 'Session Weather', rows: 12 })
})

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
