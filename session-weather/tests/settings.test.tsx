// The person's settings in `/config`.

import { expect, test } from 'claude-code/testing'
import type { ConfigSetInput, ConfigValue, On } from 'claude-code'
import { answer, DEBUG, engine, measure, NO_WAIT, pane, RATE_LIMITED, runStep, SECOND, SLOW, start, stop, thought, thoughts, turnDone, VIETNAMESE } from './helpers'

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

test('with nothing set, the summary is in English, 15 seconds apart, and Compact soon comes at 90%', SLOW, async ($, on) => {
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
  { ...SLOW, options: { summaryGapSeconds: 600 } },
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
