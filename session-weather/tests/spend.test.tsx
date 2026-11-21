// The session's spend, and its share of each limit's window.

import { expect, test } from 'claude-code/testing'
import { barsShown, DAY, engine, HOUR, limitsShown, MINUTE, NOW, oneTurn, pane, SECOND, SLOW, start, thoughts } from './helpers'

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

test("this session's part of each window shows in yellow, its cells the last of the bar's filled ones", SLOW, async ($, on) => {
  const { clock } = engine(on, { rateLimits: LIVE, cost: 0, ...others })

  await $.session.start(start)
  await clock.settle()
  // Yet to spend in either window: the limits as they were.
  expect(await limitsShown($)).toEqual(['5h 30% · reset in 3h 0m', 'Week 12% · reset in 2d 0h'])
  expect(await barsShown($)).toEqual({
    'bar-five_hour': 'others━25 red╍39 track━21',
    'bar-seven_day': 'others━10 red╍4 track━71',
  })

  // $1 now: a quarter of the 5-hour window's $4, 7.5 of its 30 points; a
  // twentieth of the week's $20, 0.6 of its 12.
  await $.session.measure(spent(1))
  await clock.settle()

  expect(await limitsShown($)).toEqual([
    '5h 30% · this session 8% · reset in 3h 0m',
    'this session 8% [warning]',
    'Week 12% · this session 1% · reset in 2d 0h',
    'this session 1% [warning]',
  ])
  expect(await barsShown($)).toEqual({
    // This session's part the last of the filled cells; under half a cell, the
    // week's shows in words alone.
    'bar-five_hour': 'others━19 amber━6 red╍39 track━21',
    'bar-seven_day': 'others━10 red╍4 track━71',
  })
})

test('a session alone in the files takes the whole of each window: spend no file holds counts toward it', async ($, on) => {
  const { clock } = engine(on, { rateLimits: LIVE, cost: 0 })

  await $.session.start(start)
  await $.session.measure(spent(0.1))
  await clock.settle()
  expect(await limitsShown($)).toEqual([
    '5h 30% · this session 30% · reset in 3h 0m',
    'this session 30% [warning]',
    'Week 12% · this session 12% · reset in 2d 0h',
    'this session 12% [warning]',
  ])
  expect(await barsShown($)).toEqual({
    'bar-five_hour': 'amber━25 red╍39 track━21',
    'bar-seven_day': 'amber━10 red╍4 track━71',
  })
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

test("the summary's Haiku requests are this session's spend once, as the engine counts them in its cost", async ($, on) => {
  const { clock, files, steps } = engine(on, { rateLimits: LIVE, cost: 0 })

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  // One update: 10k tokens in and 2k out, $0.002, said under the summary.
  // The mod adds nothing to the spend beside the engine's total.
  expect((await thoughts($)).at(-1)).toBe('Summary cost $0.002 - Haiku 5.5')
  expect(spendOf(files)).toBe(null)

  // The engine's total takes the request in: the file counts it, once.
  await $.session.measure(spent(0.002))
  await clock.settle()
  expect(spendOf(files)).toEqual({ seen: 0.002, spans: [minuteOf(NOW, 0.002)] })
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
