// The desktop pane's cards.

import { expect, test } from 'claude-code/testing'
import { answer, at, BREAKDOWN, clockOf, DAY, desk, engine, HOUR, limits, measure, MINUTE, mount, NOW, oneTurn, pressDesk, requestUsage, runStep, SAVED, SECOND, SLOW, start, stop, stopWith, thought, turnDone, WIDE_FROM } from './helpers'
import type { Found } from './helpers'

// The switches that fold the subagents', the tools' and the thinking card,
// first on each card's top line, all open.
const FOLDS = ['▾', '▾', '▾']
// Under WIDE_FROM columns, with a turn kept: the subagents' and the tools'
// switches, the recent turns' folded with the switch to persist them, then
// the thinking card's.
const NARROW_FOLDS = ['▾', '▾', '▸', '☐ Persist', '▾']
// From WIDE_FROM columns, the context's and the recent turns' switches, on
// the left (a session with no limits read has no limits card).
const LEFT_FOLDS = ['▾', '▾']

test('on the desktop under WIDE_FROM columns: the sky and the session, a tile each for the context and the windows, the last turn', async ($, on) => {
  const { clock } = engine(on, { rateLimits: limits(25), breakdown: BREAKDOWN, cost: 1.234, startedAt: NOW, turns: 3 })

  await $.session.start(start)
  await clock.settle()
  await $.session.measure(measure(90_000, 45))

  const { texts, alts } = await desk($)
  // Alone in the spend files, the session takes the whole of each window.
  expect(texts.slice(0, texts.indexOf('Thinking'))).toEqual([
    'Cloudy',
    `Fable 5.2 · since ${clockOf(NOW)} · 3 turns`,
    '$1.23',
    'session',
    'Context',
    '45%',
    '90k / 200k',
    'compact at 92%',
    '5-hour',
    '3%',
    'session 3%',
    'reset 3h 26m',
    'Week',
    '25%',
    'session 25%',
    'reset 2d 5h',
    'Last turn',
    '+90k',
    // A turn that started no subagents and called no tools still gets their
    // cards, which say so.
    'Subagents',
    'No subagents ran in this turn',
    'Tools',
    'No tools called in this turn',
  ])
  expect(alts.slice(0, 4)).toEqual([
    'Cloudy',
    'Context 45% full',
    '5-hour 3% used, this session 3%',
    'Week 25% used, this session 25%',
  ])
  // No window on pace to run out: no warning.
  expect(texts.some(text => text.includes('on pace'))).toBe(false)

  // The terminal draws no Svg: it keeps its rows of text.
  const ui = await mount($, 'terminal', 60)
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  await ui.unmount()
})

test('on the desktop a window on pace to run out before it resets gets a warning, and its bar is hatched on to where it would stand', async ($, on) => {
  // The 5-hour window a tenth of its time gone; the week 60% used half way.
  engine(on, {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 9, resetsAt: at(4 * HOUR + 30 * MINUTE) },
      { kind: 'seven_day', percentUsed: 60, resetsAt: at(3 * DAY + 12 * HOUR) },
    ],
  })

  await $.session.start(start)
  const { texts, svgs } = await desk($)
  expect(texts).toContain('Week limit on pace for >100% before it resets in 3d 12h.')
  expect(svgs.map(one => one.alt)).toContain('Warning')

  // The week's bar hatched past its 60%; the 5-hour window says nothing yet.
  const sourceOf = (alt: string) => svgs.find(one => one.alt === alt)?.source ?? ''
  expect(sourceOf('Week 60% used')).toContain('url(#h)')
  expect(sourceOf('5-hour 9% used')).not.toContain('url(#h)')

  // From WIDE_FROM columns the warning is a pill in the header, 32 pixels
  // tall, its words escaped in the drawing and whole in its alt.
  const wide = await desk($, WIDE_FROM)
  const warning = 'Week limit on pace for >100% before it resets in 3d 12h.'
  const pill = wide.svgs.find(one => one.alt === warning)?.source ?? ''
  expect(pill).toContain('height="32"')
  expect(pill).toContain('<tspan font-weight="600">Week limit</tspan> on pace for &gt;100% before it resets in 3d 12h</text>')
  expect(wide.texts.some(text => text.includes('on pace'))).toBe(false)
})

test("on the desktop each subagent's row says its state, task and time, its model, effort and context, what it is at, and its tokens", SLOW, async ($, on) => {
  const { agents, clock, steps } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push({ id: 'a1', description: 'Find the flaky test', type: 'general-purpose', status: 'running' })
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find the flaky test' } as never)
  await runStep($, steps, 'a-turn', [stopWith(requestUsage(1_000, 20_000, 500))], 'a1', 'high')
  await runStep($, steps, 'a-turn', [stopWith(requestUsage(2_000, 21_500, 800))], 'a1', 'high')
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/ProductList.tsx', agentId: 'a1' } as never)
  await clock.advance(SECOND)

  // The subagents' card, up to the Tools card under it.
  const card = (texts: string[]) => texts.slice(texts.indexOf('Subagents'), texts.lastIndexOf('Tools'))
  const working = await desk($)
  expect(card(working.texts)).toEqual([
    'Subagents',
    'Find the flaky test',
    'Opus 5.5 · high · ctx 24.3k',
    '<1m',
    'Read: ProductList.tsx',
    '45.8k tokens',
  ])
  // The chip is a rounded drawing, its words in its alt.
  expect(working.alts).toEqual(expect.arrayContaining(['Subagents', '1 at work', 'running', 'Read', "100% of the subagents' tokens"]))

  // Ended: done, how long it ran, its model and effort; what it was at and
  // its context go.
  await clock.advance(2 * MINUTE)
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 2 * MINUTE }) as never)
  const ended = await desk($)
  expect(card(ended.texts)).toEqual(['Subagents', 'Find the flaky test', 'Done · Opus 5.5 · high', '2m 1s', '45.8k tokens'])
  expect(ended.alts).toContain('1 finished')
  expect(ended.alts).not.toContain('1 at work')
})

test('on the desktop the subagents card shows one row at once under WIDE_FROM columns and two from them, ▲ and ▼ scrolling the rest a row a press', SLOW, async ($, on) => {
  const { agents } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'w0' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let at = 1; at <= 4; at += 1) {
    agents.push({ id: `w${at}`, description: `Step ${at}`, type: 'general-purpose', status: 'running' })
  }
  await $.agent.spawn({ prompt: 'Run it.', description: 'Step 5' } as never)

  // The card's rows, where they stand among four, and its arrows; the Tools
  // card's arrows, which a turn without calls has none of, left out.
  const card = async (columns?: number) => {
    const { texts, labels } = await desk($, columns)
    const rows = texts.slice(texts.indexOf('Subagents'), texts.lastIndexOf('Tools')).filter(one => one.startsWith('Step '))

    return { rows, place: texts.find(one => one.endsWith(' of 4')), labels: labels.filter(one => one === '▲' || one === '▼') }
  }

  // Under WIDE_FROM columns: the first one, where it stands, and the arrows.
  expect(await card()).toEqual({ rows: ['Step 1'], place: '1 of 4', labels: ['▲', '▼'] })

  // ▼ a row a press, to the last and no further; ▲ back up.
  await pressDesk($, 'subagents-down')
  expect((await card()).rows).toEqual(['Step 2'])
  for (let n = 0; n < 3; n += 1) await pressDesk($, 'subagents-down')
  expect(await card()).toEqual({ rows: ['Step 4'], place: '4 of 4', labels: ['▲', '▼'] })
  await pressDesk($, 'subagents-up')
  expect((await card()).rows).toEqual(['Step 3'])

  // The person's next prompt lists them from the top again.
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect((await card()).rows).toEqual(['Step 1'])

  // From WIDE_FROM columns two at once, scrolled the same, no further than
  // the last two.
  expect(await card(WIDE_FROM)).toEqual({ rows: ['Step 1', 'Step 2'], place: '1–2 of 4', labels: ['▲', '▼'] })
  for (let n = 0; n < 3; n += 1) await pressDesk($, 'subagents-down', WIDE_FROM)
  expect(await card(WIDE_FROM)).toEqual({ rows: ['Step 3', 'Step 4'], place: '3–4 of 4', labels: ['▲', '▼'] })

  // Two or fewer from WIDE_FROM columns: all of them, no arrows; one under
  // them still scrolls.
  agents.splice(2)
  await $.agent.spawn({ prompt: 'Run it.', description: 'Step 6' } as never)
  expect(await card(WIDE_FROM)).toEqual({ rows: ['Step 1', 'Step 2'], place: undefined, labels: [] })
  expect((await card()).labels).toEqual(['▲', '▼'])
})

test('on the desktop a card folds to its top line and opens again, kept in the store; the lowest card open takes the height left', SLOW, async ($, on) => {
  const { clock, store } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let n = 1; n <= 30; n += 1) {
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Read', file_path: `/work/f${n}.ts` } as never)
  }

  // In the pane's body of 30 rows, all open: the thinking card takes the
  // height, the tools show their three under WIDE_FROM columns, five from
  // them.
  const tools = async (columns?: number) => (await desk($, columns)).texts.filter(text => text.startsWith('Read: ')).length
  expect(await tools()).toBe(3)
  expect(await tools(WIDE_FROM)).toBe(5)

  // The thinking card folded: its top line alone, ▸ on it, kept in the
  // store; the tools take what it left, more rows.
  await pressDesk($, 'fold-thinking')
  expect(store.get('foldedCards')).toEqual(['thinking'])
  const folded = await desk($)
  // The subagents', the tools', the recent turns' (folded here unless
  // opened) and the thinking card's switches.
  expect(folded.labels.filter(label => label === '▾' || label === '▸')).toEqual(['▾', '▾', '▸', '▸'])
  expect(folded.texts.slice(folded.texts.indexOf('Thinking') + 1).every(text => !text.includes(' · ') || text.startsWith('Summary'))).toBe(true)
  expect(await tools()).toBeGreaterThan(5)
  expect(await tools(WIDE_FROM)).toBeGreaterThan(8)

  // The tools folded too: their top line and its count alone; the subagents'
  // card, the lowest open, takes the height.
  await pressDesk($, 'fold-tools')
  expect(store.get('foldedCards')).toEqual(['tools', 'thinking'])
  expect(await tools()).toBe(0)
  expect((await desk($)).alts).toContain('30 calls')

  // Opened again, each as it was.
  await pressDesk($, 'fold-tools')
  await pressDesk($, 'fold-thinking')
  expect(store.get('foldedCards')).toEqual([])
  expect(await tools()).toBe(3)
})

test('from WIDE_FROM columns the context, the limits and the recent turns fold to their top line, each with its gist', async ($, on) => {
  const { clock, steps, store } = engine(on, { rateLimits: limits(25), breakdown: BREAKDOWN })

  await $.session.start(start)
  await clock.settle()
  await oneTurn($, steps, clock, 't1', 'fix it')
  await $.session.measure(measure(90_000, 45))

  await pressDesk($, 'fold-context', WIDE_FROM)
  await pressDesk($, 'fold-limits', WIDE_FROM)
  await pressDesk($, 'fold-turns', WIDE_FROM)
  expect(store.get('foldedCards')).toEqual(['context', 'limits', 'turns'])

  // Each card its top line: the context's fill, each window's share, the
  // turns kept and the switch to persist them; nothing under them.
  const { texts, labels, alts } = await desk($, WIDE_FROM)
  // Each title led by its icon, as the right column's cards are.
  expect(alts).toEqual(expect.arrayContaining(['Context', 'Usage limits', 'Recent turns', 'Subagents', 'Tools', 'Thinking']))
  const left = texts.slice(texts.indexOf('Context'), texts.indexOf('Subagents'))
  expect(left).toEqual(['Context', '45% · 90k / 200k', 'Usage limits', '5-hour 3% · Week 25%', 'Recent turns', '1 turn'])
  expect(labels.slice(0, 4)).toEqual(['▸', '▸', '▸', '☐ Persist'])

  // Opened again: the whole of each.
  await pressDesk($, 'fold-turns', WIDE_FROM)
  expect((await desk($, WIDE_FROM)).texts).toContain('Context added')
})

test('under WIDE_FROM columns the recent turns stand folded until opened, and a turn pressed shows in the cards', async ($, on) => {
  const { replies, steps, clock, store } = engine(on)
  await threeUpdates($, replies, steps, clock)
  await $.tool.call({ tool: 'Read', file_path: '/work/first.ts' } as never)
  await $.turn.complete(turnDone({ durationMs: 31_000 }) as never)
  await clock.settle()
  await clock.advance(MINUTE)
  replies.push(answer('GIST: Bốn.'))
  await oneTurn($, steps, clock, 't2', 'and this')
  const [first, second] = [clockOf(NOW), clockOf(NOW + 31 * SECOND + MINUTE)]

  // Folded: its top line, how many turns, the switch to persist them; no
  // table, under the tools and over the summary.
  const shut = await desk($)
  expect(shut.texts.slice(shut.texts.indexOf('Recent turns'), shut.texts.indexOf('Recent turns') + 2)).toEqual(['Recent turns', '2 turns'])
  expect(shut.texts.lastIndexOf('Tools')).toBeLessThan(shut.texts.indexOf('Recent turns'))
  expect(shut.texts.indexOf('Recent turns')).toBeLessThan(shut.texts.indexOf('Thinking'))
  expect(shut.texts).not.toContain('Context added')

  // Opened, kept in the store; the wide layout's own is not touched.
  await pressDesk($, 'fold-narrowTurns')
  expect(store.get('foldedCards')).toEqual(['narrowTurns'])
  const open = await desk($)
  expect(open.labels).toEqual(expect.arrayContaining([`▸ ${second}  2s`, `${first}  31s`]))
  expect((await desk($, WIDE_FROM)).texts).toContain('Context added')

  // The turn before, pressed: the summary, the tools shown are its own.
  await pressDesk($, 'turn-t1')
  const past = await desk($)
  expect(past.texts).toContain(`Turn at ${first}`)
  expect(past.texts).toContain('Read: first.ts')
  expect(past.labels).toContain(`▸ ${first}  31s`)
})

test('the cards the person folded stay folded when a session starts', async ($, on) => {
  engine(on, { stored: { foldedCards: ['subagents', 'bogus'] } })

  await $.session.start(start)
  const { labels, texts } = await desk($)
  expect(labels.slice(0, 2)).toEqual(['▸', '▾'])
  expect(texts).not.toContain('No subagents ran in this turn')
})

test('on the desktop under WIDE_FROM columns the Tools card lists the current turn\'s calls three at once', async ($, on) => {
  const { clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let n = 1; n <= 4; n += 1) {
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Read', file_path: `/work/f${n}.ts` } as never)
  }

  const card = async () => {
    const { texts } = await desk($)

    return texts.slice(texts.lastIndexOf('Tools'), texts.indexOf('Recent turns'))
  }

  // Under the subagents' card, newest first, three of the four.
  const { texts, alts } = await desk($)
  expect(texts.indexOf('Subagents')).toBeLessThan(texts.lastIndexOf('Tools'))
  expect(alts).toContain('4 calls')
  expect(await card()).toEqual(['Tools', '1–3 of 4', 'Read: f4.ts', '4s', 'Read: f3.ts', '3s', 'Read: f2.ts', '2s'])

  // ▼ to the last three, no further.
  await pressDesk($, 'tools-down')
  await pressDesk($, 'tools-down')
  expect((await card()).slice(1, 3)).toEqual(['2–4 of 4', 'Read: f3.ts'])
})

// A turn of three updates, written at 1s, 16s and 31s: each a gist and one
// more line, a decision, the next step, an assumption.
const threeUpdates = async (
  $: Parameters<typeof runStep>[0] & { session: { start: (e: never) => Promise<unknown> }; turn: { start: (e: never) => Promise<unknown> } },
  replies: unknown[],
  steps: unknown[][],
  clock: { advance: (ms: number) => Promise<void> },
) => {
  replies.push(
    answer('GIST: Một.\nDECISION: Chỉ sửa file A'),
    answer('GIST: Hai.\nNEXT: Chạy test'),
    answer('GIST: Ba.\nASSUMPTION: Test đã xanh'),
  )
  await $.session.start(start as never)
  await $.turn.start({ text: 'fix it', turnId: 't1' } as never)
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)

  for (const text of ['Second note.', 'Third note.']) {
    await runStep($, steps, 't1', [thought(0, text), stop])
    await clock.advance(15 * SECOND)
  }
}

test("on the desktop under WIDE_FROM columns the thinking card lists the turn's updates newest first, each gist by its time, what follows by an icon", async ($, on) => {
  const { replies, steps, clock } = engine(on)
  await threeUpdates($, replies, steps, clock)

  // Each gist a Text, its time a heavier one inside it; what follows each
  // by its icon, in its color; a rule between two updates.
  const { texts, labels, alts } = await desk($)
  expect(texts.slice(texts.indexOf('Thinking'))).toEqual([
    'Thinking',
    '31s',
    '31s · Ba.',
    '31s ·',
    'Test đã xanh',
    '16s · Hai.',
    '16s ·',
    'Chạy test',
    '1s · Một.',
    '1s ·',
    'Chỉ sửa file A',
    'Summary $0.006 · Haiku 5.5',
  ])
  expect(alts).toEqual(expect.arrayContaining(['Thinking', 'Decided', 'To check', 'Next']))
  // The rules between them are drawn lines, one between each two.
  expect(alts.filter(alt => alt === 'Between updates').length).toBe(2)
  // Pinned in a body of 30 rows: the arrows to scroll it.
  expect(labels).toEqual([...NARROW_FOLDS, '▲', '▼', 'Turn summary off'])
})

test("on the desktop ▲ and ▼ scroll the turn's updates about half the window a press, never to another turn", async ($, on) => {
  const { replies, steps, clock } = engine(on)
  await threeUpdates($, replies, steps, clock)
  const card = async () => {
    const { texts, labels } = await desk($)

    return { lines: texts.slice(texts.indexOf('Thinking') + 2, -1), labels }
  }

  // Six rows of lines, a press five of them: the last line on top, the three
  // updates' gists above the window.
  await pressDesk($, 'older')
  expect(await card()).toEqual({
    lines: ['Chỉ sửa file A'],
    labels: [...NARROW_FOLDS, '▲', '▼', '↑ 3 newer updates', 'Turn summary off'],
  })

  // ▲ goes back up; so does the newer updates' button, at once.
  await pressDesk($, 'newer')
  expect((await card()).lines[0]).toBe('31s · Ba.')
  await pressDesk($, 'older')
  await pressDesk($, 'newest')
  expect((await card()).lines[0]).toBe('31s · Ba.')

  // A second turn: the card shows it alone, nothing of the turn before; one
  // row of lines has nothing to scroll, and no arrows.
  await $.turn.complete(turnDone({ durationMs: 31_000 }) as never)
  await clock.settle()
  await oneTurn($, steps, clock, 't2', 'and this')
  const second = await card()
  expect(second.lines).toContain('1s · Claude đang sửa lỗi.')
  expect(second.lines.some(line => line.includes('Ba.'))).toBe(false)
  expect(second.labels).toEqual([...NARROW_FOLDS, 'Turn summary off'])
})

test('on the desktop from WIDE_FROM columns: the sky, the cost across the top; the context, the limits and the recent turns on the left', async ($, on) => {
  const { clock, steps } = engine(on, { rateLimits: limits(25), breakdown: BREAKDOWN, cost: 1.234, startedAt: NOW, turns: 3 })

  await $.session.start(start)
  await clock.settle()
  await oneTurn($, steps, clock, 't1', 'fix it')
  await $.session.measure(measure(90_000, 45))

  const { texts, labels } = await desk($, WIDE_FROM)
  const between = (from: string, to: string) => texts.slice(texts.indexOf(from), texts.indexOf(to))

  expect(texts.slice(0, texts.indexOf('Context'))).toEqual([
    'Cloudy',
    `Fable 5.2 · since ${clockOf(NOW)} · 3 turns`,
    'Session cost',
    '$1.23',
  ])
  // Under the context: each window with this session's part, its reset and
  // its pace.
  expect(between('Usage limits', 'Recent turns')).toEqual([
    'Usage limits',
    '5-hour',
    '3%',
    'This session 3%',
    'Resets in 3h 26m · ~11% at reset',
    ' · ~11% at reset',
    'Week',
    '25%',
    'This session 25%',
    'Resets in 2d 5h · ~37% at reset',
    ' · ~37% at reset',
    'Other sessions',
    'This session',
    'Projected at reset',
  ])
  // On top, as the person looks at it most: what fills the context, each
  // part with its share; the last turn.
  expect(between('Context', 'Usage limits')).toEqual([
    'Context',
    'Auto-compact at 92% · 184k',
    '45%',
    '90k / 200k',
    'Messages',
    '64k',
    '32%',
    'System tools',
    '17.1k',
    '9%',
    'System prompt',
    '3.2k',
    '2%',
    'Memory files',
    '2.4k',
    '1%',
    'Other',
    '2.3k',
    '1%',
    'Last turn',
    '+90k',
    '2s · 0 tools · cache 96%',
  ])
  // The recent turns as a table, the one shown marked; then, atop the right
  // column, the subagents' card and the tools', which say the turn started
  // and called none.
  expect(between('Recent turns', 'Thinking')).toEqual([
    'Recent turns',
    'Time · Duration',
    'Context added',
    // The subagents' and the tool calls' headers are icons; no subagents
    // leaves the row's cell blank.
    '2s',
    '+90k',
    '0',
    'Subagents',
    'No subagents ran in this turn',
    'Tools',
    'No tools called in this turn',
  ])
  // The left column's three cards fold too, each by its switch first.
  expect(labels).toEqual(['▾', '▾', '▾', `▸ ${clockOf(NOW)}  2s`, '☐ Persist', ...FOLDS, 'Turn summary off'])
})

test('on the desktop from WIDE_FROM columns a recent turn pressed shows beside them, and ▲ ▼ scroll the turn shown', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  await threeUpdates($, replies, steps, clock)
  await $.turn.complete(turnDone({ durationMs: 31_000 }) as never)
  await clock.settle()
  await clock.advance(MINUTE)
  replies.push(answer('GIST: Bốn.'))
  await oneTurn($, steps, clock, 't2', 'and this')

  // The thinking card's title and its lines, past its duration (its chip a
  // drawing, no text) and up to the footer; and the pane's Buttons, in order.
  const card = async () => {
    const { texts, labels } = await desk($, WIDE_FROM)
    const top = texts.findIndex(text => text === 'Thinking' || text.startsWith('Turn at '))

    return { title: texts[top], lines: texts.slice(top + 2, -1), labels }
  }
  const [first, second] = [clockOf(NOW), clockOf(NOW + 31 * SECOND + MINUTE)]

  // The current turn, its one update: nothing to scroll.
  expect(await card()).toEqual({
    title: 'Thinking',
    lines: ['1s · Bốn.', '1s ·'],
    labels: [...LEFT_FOLDS, `▸ ${second}  2s`, `${first}  31s`, '☐ Persist', ...FOLDS, 'Turn summary off'],
  })

  // The one before, pressed: its updates, its recap on top, a drawn rule
  // between two (no text), and arrows to scroll them.
  await pressDesk($, 'turn-t1', WIDE_FROM)
  expect(await card()).toEqual({
    title: `Turn at ${first}`,
    lines: [
      'Recap. Claude đang sửa lỗi.',
      'Recap.',
      '31s · Ba.',
      '31s ·',
      'Test đã xanh',
      '16s · Hai.',
      '16s ·',
      'Chạy test',
      '1s · Một.',
      '1s ·',
      'Chỉ sửa file A',
    ],
    labels: [...LEFT_FOLDS, `${second}  2s`, `▸ ${first}  31s`, '☐ Persist', ...FOLDS, '▲', '▼', 'Turn summary off'],
  })

  // ▼ moves twelve rows, past the last of the seven: the four gists above.
  await pressDesk($, 'older', WIDE_FROM)
  expect(await card()).toEqual({
    title: `Turn at ${first}`,
    lines: ['Chỉ sửa file A'],
    labels: [...LEFT_FOLDS, `${second}  2s`, `▸ ${first}  31s`, '☐ Persist', ...FOLDS, '▲', '▼', '↑ 4 newer updates', 'Turn summary off'],
  })
  await pressDesk($, 'newer', WIDE_FROM)
  expect((await card()).lines[0]).toBe('Recap. Claude đang sửa lỗi.')

  // The current turn pressed again: back to it.
  await pressDesk($, 'turn-t2', WIDE_FROM)
  expect((await card()).title).toBe('Thinking')
})

test('on the desktop from WIDE_FROM columns a recent turn pressed shows the subagents it started, 30 at most', async ($, on) => {
  const { agents, clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'x' }))

  // A turn that starts 32 subagents, which all end.
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let at = 1; at <= 32; at += 1) {
    agents.push({ id: `a${at}`, description: `First ${at}`, type: 'general-purpose', status: 'running' })
  }
  await $.agent.spawn({ prompt: 'Run them.', description: 'First' } as never)
  for (const one of agents) one.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: MINUTE }) as never)
  await $.turn.complete(turnDone({ durationMs: 2 * MINUTE }) as never)
  await clock.settle()
  await clock.advance(MINUTE)

  // The next prompt lets them go from the list, and starts one of its own.
  agents.splice(0)
  await $.turn.start({ text: 'next', turnId: 't2' })
  agents.push({ id: 'b1', description: 'Second 1', type: 'general-purpose', status: 'running' })
  await $.agent.spawn({ prompt: 'Run it.', description: 'Second 1' } as never)

  const card = async () => {
    const { texts } = await desk($, WIDE_FROM)

    return texts.slice(texts.indexOf('Subagents'), texts.findIndex(text => text === 'Thinking' || text.startsWith('Turn at ')))
  }

  // The recent turns count each one's subagents, those past the 30 kept with
  // them, before its tool calls.
  const { texts, alts } = await desk($, WIDE_FROM)
  const rows = texts.slice(texts.indexOf('Context added') + 1, texts.indexOf('Subagents'))
  expect(rows.filter(text => /^\d+$/.test(text))).toEqual(['1', '0', '32', '0'])
  expect(alts).toEqual(expect.arrayContaining(['Agents', 'Tools']))

  // The current turn: its own subagent alone.
  const now = await card()
  expect(now).toContain('Second 1')
  expect(now.some(text => text.startsWith('First '))).toBe(false)

  // The turn before, pressed: the first 30 it started, two at a time, as they
  // ended; the two past them counted.
  await pressDesk($, 'turn-t1', WIDE_FROM)
  const past = await card()
  expect(past).toEqual(expect.arrayContaining(['First 1', 'First 2', '1–2 of 30', 'and 2 more not kept']))
  expect(past).not.toContain('Second 1')
  expect(past.some(text => text.startsWith('Done'))).toBe(true)
  // ▼ scrolls them, the current turn's one subagent notwithstanding.
  await pressDesk($, 'subagents-down', WIDE_FROM)
  expect(await card()).toContain('2–3 of 30')

  // Back to the current turn: its own again.
  await pressDesk($, 'turn-t2', WIDE_FROM)
  expect(await card()).toContain('Second 1')
})

test('on the desktop from WIDE_FROM columns the Tools card lists the shown turn\'s calls newest first, five at once, ▲ and ▼ scrolling the rest', async ($, on) => {
  const { agents, clock } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))

  const card = async () => {
    const { texts } = await desk($, WIDE_FROM)
    // The card's title, past the recent turns' column of the same name.
    const at = texts.lastIndexOf('Tools')

    return texts.slice(at, texts.findIndex((text, index) => index > at && (text === 'Thinking' || text.startsWith('Turn at '))))
  }

  // A turn of seven calls, one of them its subagent's.
  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push({ id: 'a1', description: 'Scan the docs', type: 'general-purpose', status: 'running' })
  await $.agent.spawn({ prompt: 'Scan.', description: 'Scan the docs' } as never)
  for (let n = 1; n <= 6; n += 1) {
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Read', file_path: `/work/f${n}.ts` } as never)
  }
  await $.tool.call({ tool: 'Grep', pattern: 'flaky', agentId: 'a1' } as never)

  // Newest first, five at once, the subagent's call by its task.
  const first = await card()
  expect(first.slice(0, 2)).toEqual(['Tools', '1–5 of 7'])
  expect((await desk($, WIDE_FROM)).alts).toContain('7 calls')
  expect(first.slice(2)).toEqual(['Grep: flaky', 'Scan the docs', '6s', 'Read: f6.ts', '6s', 'Read: f5.ts', '5s', 'Read: f4.ts', '4s', 'Read: f3.ts', '3s'])

  // ▼ scrolls a row a press, no further than the last.
  await pressDesk($, 'tools-down', WIDE_FROM)
  await pressDesk($, 'tools-down', WIDE_FROM)
  await pressDesk($, 'tools-down', WIDE_FROM)
  const end = await card()
  expect(end).toContain('3–7 of 7')
  expect(end.at(-2)).toBe('Read: f1.ts')

  // The next prompt shows its own calls, none yet, from the top.
  agents.splice(0)
  await $.turn.complete(turnDone({ durationMs: 7_000 }) as never)
  await clock.settle()
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await card()).toEqual(['Tools', 'No tools called in this turn'])

  // The turn before, pressed: its calls again.
  await pressDesk($, 'turn-t1', WIDE_FROM)
  expect((await card()).slice(0, 3)).toEqual(['Tools', '1–5 of 7', 'Grep: flaky'])
})

test("the Tools card says about how much each main-loop call added to the context, once the next request is answered", SLOW, async ($, on) => {
  const { steps, clock } = engine(on)
  // A request answered over `context` tokens: 1,000 uncached, the rest cached.
  const request = (context: number, turnId = 't1') =>
    runStep($, steps, turnId, [stopWith(requestUsage(1_000, context - 1_000, 200))])
  const call = async (text: string, agentId?: string) => {
    await clock.advance(1_000)
    await $.tool.call({ tool: 'Read', file_path: `/work/${text}.ts`, ...(agentId ? { agentId } : {}) } as never)
  }
  // The card's rows, without their times.
  const card = async () => {
    const { texts } = await desk($, WIDE_FROM)
    const from = texts.lastIndexOf('Tools')
    const to = texts.findIndex((text, index) => index > from && (text === 'Thinking' || text.startsWith('Turn at ')))

    return texts.slice(from, to).filter(text => !/^\d+s$/.test(text))
  }

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })

  // The first request sets where the growth counts from; its call, and a
  // subagent's, are answered by the second, which added 42k: all of it the
  // main loop's call's.
  await request(21_000)
  await call('f1')
  await call('docs', 'a1')
  expect(await card()).toEqual(['Tools', 'Read: docs.ts', 'Subagent', 'Read: f1.ts'])
  await request(63_000)
  expect(await card()).toEqual(['Tools', 'Read: docs.ts', 'Subagent', 'Read: f1.ts', '+42k'])

  // Two calls of one request share its growth evenly, marked so.
  await call('f2')
  await call('f3')
  await request(91_000)
  expect((await card()).slice(1, 5)).toEqual(['Read: f3.ts', '~+14k', 'Read: f2.ts', '~+14k'])

  // Four would read alike whatever each did: they get none. Nor does the
  // turn's last call, which no request answers.
  for (const name of ['f4', 'f5', 'f6', 'f7']) await call(name)
  await request(120_000)
  await call('f8')
  await $.turn.complete(turnDone({ durationMs: 9_000 }) as never)
  await clock.settle()
  await pressDesk($, 'turn-t1', WIDE_FROM)
  expect((await card()).slice(2, 7)).toEqual(['Read: f8.ts', 'Read: f7.ts', 'Read: f6.ts', 'Read: f5.ts', 'Read: f4.ts'])

  // A request over a smaller context than the last, as after a compaction,
  // puts nothing anywhere and is where the next counts from.
  await $.turn.start({ text: 'next', turnId: 't2' })
  await call('g1')
  await request(30_000, 't2')
  expect(await card()).toEqual(['Tools', 'Read: g1.ts'])
  await call('g2')
  await request(40_000, 't2')
  expect(await card()).toEqual(['Tools', 'Read: g2.ts', '+10k', 'Read: g1.ts'])
})

test('a recent turn keeps its newest 100 tool calls, counting those let go, and a saved session gets them back', SLOW, async ($, on) => {
  const { files, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await pressDesk($, 'save-turns', WIDE_FROM)
  for (let n = 1; n <= 103; n += 1) await $.tool.call({ tool: 'Bash', description: `Step ${n}` } as never)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()

  const saved = JSON.parse(files.get(SAVED) ?? 'null') as { turns: { tools: number; calls?: { text: string }[]; moreCalls?: number }[] }
  expect(saved.turns[0]?.tools).toBe(103)
  expect(saved.turns[0]?.calls?.length).toBe(100)
  expect(saved.turns[0]?.calls?.[0]?.text).toBe('Bash: Step 4')
  expect(saved.turns[0]?.moreCalls).toBe(3)

  // Scrolled to the oldest kept, the card counts those let go.
  for (let n = 0; n < 95; n += 1) await pressDesk($, 'tools-down', WIDE_FROM)
  const { texts } = await desk($, WIDE_FROM)
  expect(texts).toEqual(expect.arrayContaining(['96–100 of 100', 'Bash: Step 4', 'and 3 earlier not kept']))
})

test("on the desktop from WIDE_FROM columns the shown turn's fill lies under its row, which stands as tall as the others", async ($, on) => {
  const { replies, steps, clock } = engine(on)
  await threeUpdates($, replies, steps, clock)
  await $.turn.complete(turnDone({ durationMs: 31_000 }) as never)
  await clock.settle()
  await clock.advance(MINUTE)
  replies.push(answer('GIST: Bốn.'))
  await oneTurn($, steps, clock, 't2', 'and this')

  const ui = await mount($, 'desktop', WIDE_FROM)
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Found[]
  const svgs = (await ui.findAll({ type: 'Svg' })) as unknown as Found[]
  await ui.unmount()

  // One fill, the shown turn's, placed over its row's whole box and rounded
  // by a border of no color; the rows themselves take no border, which would
  // make one taller than the rest.
  const placed = boxes.filter(one => one.props.position === 'absolute')
  expect(placed.map(one => [one.props.top, one.props.bottom, one.props.left, one.props.right])).toEqual([[0, 0, 0, 0]])
  expect(placed[0]?.props).toMatchObject({ borderStyle: 'round', borderColor: 'rgba(0, 0, 0, 0)' })
  const cardFill = boxes.find(one => one.props.borderStyle === 'round')?.props.backgroundColor
  expect(typeof placed[0]?.props.backgroundColor).toBe('string')
  expect(placed[0]?.props.backgroundColor).not.toBe(cardFill)
  expect(boxes.filter(one => one.props.position === 'relative' && one.props.borderStyle !== undefined)).toEqual([])

  // Each row's bar stands in a drawing the design's 32 pixels high, the
  // bar in its middle, which holds every row to that height.
  const bars = svgs.filter(one => String(one.props.alt).startsWith('Added ') || one.props.alt === 'Context added not known')
  expect(bars.map(one => one.props.height)).toEqual([32, 32])
  expect(bars.map(one => /<rect y="13" [^>]*height="6"/.test(String(one.props.source)))).toEqual([true, true])
})

test('on the desktop from WIDE_FROM columns with the summary off, the cards stand in one column', async ($, on) => {
  engine(on, { stored: { isSummaryOff: true }, rateLimits: limits(25) })

  await $.session.start(start)
  const { texts, labels } = await desk($, 120)
  expect(texts).toContain('Context')
  expect(texts.indexOf('Usage limits')).toBeGreaterThan(-1)
  expect(texts.indexOf('Context')).toBeLessThan(texts.indexOf('Usage limits'))
  expect(texts).not.toContain('Thinking')
  expect(texts.at(-1)).toBe('Thinking summary is off')
  // The switches of the context, the limits, the subagents and the tools.
  expect(labels).toEqual(['▾', '▾', '▾', '▾', 'Turn summary on'])
})
