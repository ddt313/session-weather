// The pane's layout in the terminal and on the desktop: its columns, widget
// and headers.

import { expect, test } from 'claude-code/testing'
import { allTexts, answer, bar, BREAKDOWN, buttons, engine, limits, measure, MINUTE, mount, NOW, oneTurn, PACED, pane, press, runStep, SECOND, SLOW, start, stop, SUMMARY, thought, thoughts, turnRows, WIDE_FROM } from './helpers'
import type { Found, Test$ } from './helpers'

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

test('from WIDE_FROM columns the weather stands in a column of its own, the summary beside it; narrower, one above the other', SLOW, async ($, on) => {
  const { steps, clock } = engine(on, { rateLimits: limits(25) })

  await $.session.start(start)
  await $.session.measure(measure(90_000, 45))
  await oneTurn($, steps, clock, 't1', 'fix it')

  // A column short of it: one column, the weather on top. (The desktop draws
  // its own layout there: see the desktop tests.)
  expect(await layout($, 'terminal', WIDE_FROM - 1)).toEqual({
    direction: 'column',
    weatherWidth: undefined,
    weather: expect.stringContaining('45% of context · 90k / 200k'),
    summary: undefined,
  })

  // From it: the weather on the left, wide enough for its longest line on
  // one row (46 characters, 47 cells of the terminal), and the summary in the
  // rest. (The desktop draws its own wide layout: see the desktop tests.)
  const wide = await layout($, 'terminal', WIDE_FROM)
  expect([wide.direction, wide.weatherWidth]).toEqual(['row', 47])
  expect(wide.weather).toContain('45% of context · 90k / 200k')
  expect(wide.weather).toContain('Usage limits')
  expect(wide.weather).toContain('Week 25%')
  expect(wide.weather).not.toContain('🧭')
  expect(wide.summary).toContain('1s · Claude đang sửa lỗi.')
  expect(wide.summary).toContain('Summary cost $0.002 - Haiku 5.5')

  // Nothing is lost on the way: each line one column shows stands beside the
  // weather in the same order, but the limits' bars, which gain their pace.
  const isBar = (text: string) => /^[█░]/.test(text)
  const narrow = (await allTexts($, 'terminal', WIDE_FROM - 1)).filter(text => !isBar(text))
  expect(missingFrom(narrow, await allTexts($, 'terminal', WIDE_FROM))).toEqual([])
})

test('beside the weather the rule spans the summary, and a click moves half its taller window', SLOW, async ($, on) => {
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

  // At 120 columns the summary has the body's less the weather's (47 on the
  // terminal) and the 2 between: the rule spans those.
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
  expect((await thoughts($, 'terminal', 120))[1]).toBe('→ Tiếp 1')
})

test('with the summary off the weather keeps one column at any width', async ($, on) => {
  engine(on, { stored: { isSummaryOff: true }, rateLimits: limits(25) })

  await $.session.start(start)
  expect(await layout($, 'terminal', 200)).toEqual({
    direction: 'column',
    weatherWidth: undefined,
    weather: expect.stringContaining('Week 25% · reset in 2d 5h'),
    summary: undefined,
  })
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

  expect(await styleOf('terminal', WIDE_FROM - 1, 'Usage limits')).toEqual(header)

  for (const surface of ['terminal'] as const) {
    for (const text of ['Usage limits', 'Subagents · 1 at work', 'Recent turns']) {
      expect([text, await styleOf(surface, WIDE_FROM, text)]).toEqual([text, header])
    }
  }
})

test('under WIDE_FROM columns, in a widget and on the status line, nothing of the wide layout shows', SLOW, async ($, on) => {
  // Everything the wide layout's additions read is there: the breakdown and
  // its model, prompts and a compaction, a subagent at work, recent turns,
  // windows far enough in for their pace. Of the subagent, the narrower pane
  // and the status line say only that it works.
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
  expect((await pane($, 'terminal', WIDE_FROM)).includes('Find it · running · <1m')).toBe(true)

  // (The desktop draws its own layout there: see the desktop tests.)
  expect(await pane($, 'terminal', WIDE_FROM - 1)).toEqual([
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
    'Subagents · 1 at work',
  ])
  expect(await turnRows($, 'terminal', WIDE_FROM - 1)).toEqual([])

  expect(await allTexts($, 'desktop', undefined, WIDGET)).toEqual(['☁ Cloudy · 45%', '5h 11% · Week 75% · $1.23'])

  // On a terminal too narrow to place the pane unasked, the line stands in,
  // as it reads at the next minute.
  await clock.advance(MINUTE)
  expect(status()).toBe('☁ 45% · 5h 11% (2h 21m) · $1.23 · 1 subagent')
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
