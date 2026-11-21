// The recent turns, and the session's turns saved to a file.

import { expect, test } from 'claude-code/testing'
import { answer, BREAKDOWN, buttons, clockOf, desk, endSession, engine, handBack, HOUR, measure, MINUTE, NOW, oneTurn, pane, press, pressDesk, resume, SAVED, SECOND, sessionShown, SLOW, start, subagent, submit, SUMMARY, thoughts, turnDone, turnRows, WIDE_FROM } from './helpers'

test('from WIDE_FROM columns the recent turns are listed, newest first: when each began, how long it ran, what it added, its tool calls', SLOW, async ($, on) => {
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

  for (const surface of ['terminal'] as const) {
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

test('a recent turn pressed shows its updates beside the weather; a new prompt shows its own again', SLOW, async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'))

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  await clock.advance(MINUTE)
  await oneTurn($, steps, clock, 't2', 'and this')
  const [first, second] = [clockOf(NOW), clockOf(NOW + MINUTE + SECOND)]

  // The newest is shown, marked.
  expect(await turnRows($, 'terminal')).toEqual([`▸ ${second} · 2s · 0 tools`, `${first} · 2s · 0 tools`])
  expect(await thoughts($, 'terminal', WIDE_FROM)).toEqual([
    '🧭 Thinking · 2s · done',
    '1s · Hai.',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  // The one before, pressed: its updates, the turn said by when it began.
  await press($, 'turn-t1', WIDE_FROM)
  expect(await turnRows($, 'terminal')).toEqual([`${second} · 2s · 0 tools`, `▸ ${first} · 2s · 0 tools`])
  expect(await thoughts($, 'terminal', WIDE_FROM)).toEqual([
    `🧭 Turn at ${first} · 2s · done`,
    '1s · Một.',
    'Summary cost $0.004 - Haiku 5.5',
  ])
  // In one column the terminal shows the current turn, as it always has.
  expect((await thoughts($, 'terminal'))[1]).toBe('1s · Hai.')

  // The newest pressed again: back to it.
  await press($, 'turn-t2', WIDE_FROM)
  expect((await thoughts($, 'terminal', WIDE_FROM))[1]).toBe('1s · Hai.')

  // An earlier turn picked, the next prompt shows its own turn.
  await press($, 'turn-t1', WIDE_FROM)
  await $.turn.start({ text: 'next', turnId: 't3' })
  expect(await thoughts($, 'terminal', WIDE_FROM)).toEqual([
    '🧭 Thinking · 0s',
    'No thinking notes yet.',
    'Summary cost $0.004 - Haiku 5.5',
  ])
  expect((await turnRows($, 'terminal'))[0]).toBe(`▸ ${second} · running · 0 tools`)
})

test("a hand-back goes on in its turn's row; the list keeps the last thirty turns, the terminal showing ten, and a /clear empties it", SLOW, async ($, on) => {
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

  // Thirty more prompts: the first turn goes from the list, which keeps
  // thirty; the terminal lists the newest ten of them.
  for (let at = 1; at <= 30; at += 1) {
    await $.turn.start({ text: `prompt ${at}`, turnId: `u${at}` })
    await $.turn.complete(turnDone({ turnId: `u${at}`, durationMs: 1_000 }) as never)
  }

  const rows = await turnRows($, 'terminal')
  expect(rows.length).toBe(10)
  const { texts } = await desk($)
  expect(texts).toContain('30 turns')
  expect(texts.some(text => text.includes('30s'))).toBe(false)

  // A /clear starts another conversation: its turns are listed from there.
  await endSession($, 'clear')
  expect(await turnRows($, 'terminal')).toEqual([])
  expect((await pane($, 'terminal', WIDE_FROM)).includes('Recent turns')).toBe(false)
})

test('on the desktop the recent turns scroll: as many as fit from WIDE_FROM columns, five under them, ▲ and ▼ a turn a press', SLOW, async ($, on) => {
  const { clock } = engine(on)

  await $.session.start(start)
  for (let at = 1; at <= 30; at += 1) {
    await $.turn.start({ text: `prompt ${at}`, turnId: `u${at}` })
    await $.turn.complete(turnDone({ turnId: `u${at}`, durationMs: 1_000 }) as never)
    await clock.advance(MINUTE)
  }

  // Where the rows stand among the thirty, on the card's top line.
  const placeOf = async (columns?: number) => (await desk($, columns)).texts.find(text => / of 30$/.test(text))

  // From WIDE_FROM columns, in a pinned body: the newest that fit, from the
  // top; ▼ to the oldest and no further, ▲ back up.
  const top = await placeOf(WIDE_FROM)
  expect(top).toMatch(/^1–\d+ of 30$/)
  const fit = Number(top?.split('–')[1]?.split(' ')[0])
  expect(fit).toBeGreaterThan(3)
  expect(fit).toBeLessThan(30)
  for (let n = 0; n < 40; n += 1) await pressDesk($, 'turns-down', WIDE_FROM)
  expect(await placeOf(WIDE_FROM)).toBe(`${31 - fit}–30 of 30`)
  await pressDesk($, 'turns-up', WIDE_FROM)
  expect(await placeOf(WIDE_FROM)).toBe(`${30 - fit}–29 of 30`)

  // Under them, opened: five at once.
  await pressDesk($, 'fold-narrowTurns')
  expect(await placeOf()).toMatch(/^\d+–\d+ of 30$/)
  await $.turn.start({ text: 'next', turnId: 'u31' })
  expect(await placeOf()).toBe('1–5 of 30')
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

// What the session's saved file holds, as JSON.
type Saved = {
  shape: string
  turns: { turnId: string; durationMs?: number; entries: { gist: string }[] }[]
  compactions?: { count: number; isWhole: boolean }
}

const savedIn = (files: Map<string, string>) => JSON.parse(files.get(SAVED) ?? 'null') as Saved | null

test("saving is off until pressed: then the session's turns and compactions go to a file of its own; pressed again, it goes", async ($, on) => {
  const { files, runs, steps, clock, toasts } = engine(on)
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 180_000, tokensAfter: 20_000 }))

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')

  // Off unless pressed: nothing is written.
  expect(await buttons($, { bodyColumns: WIDE_FROM })).toContain('☐ Persist')
  expect(files.has(SAVED)).toBe(false)

  // Pressed, a toast says where the turns go.
  await press($, 'save-turns', WIDE_FROM)
  expect(toasts).toEqual([`Persist on: this session's recent turns are saved to ${SAVED} and come back when it starts again`])
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
  expect(toasts.at(-1)).toBe(`Persist off: ${SAVED} is deleted; the recent turns stay until Claude Code closes`)
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

test("a saved session started again gets each turn's subagents back; one at work as it closed reads stopped", async ($, on) => {
  const saved = {
    shape: 'recent-turns-1',
    turns: [
      {
        turnId: 't1',
        startedAt: NOW - HOUR,
        durationMs: 134_000,
        tools: 3,
        entries: [],
        subagents: [
          { id: 'a1', label: 'Find the flaky test', status: 'completed', startedAt: NOW - HOUR, endedAt: NOW - HOUR + MINUTE, model: 'claude-opus-5-5', effort: 'high', tokens: 45_800 },
          { id: 'a2', label: 'Read the hooks', status: 'running', startedAt: NOW - HOUR, model: 'claude-haiku-5-5', tokens: 1_200 },
        ],
      },
      { turnId: 't2', startedAt: NOW - 10 * MINUTE, durationMs: 5_000, tools: 0, entries: [] },
    ],
  }
  engine(on, { files: { [SAVED]: JSON.stringify(saved) }, breakdown: BREAKDOWN, turns: 2 })

  await $.session.start(start)
  await pressDesk($, 'turn-t1', WIDE_FROM)
  const { texts } = await desk($, WIDE_FROM)
  expect(texts).toEqual(
    expect.arrayContaining(['Find the flaky test', 'Done · Opus 5.5 · high', '45.8k tokens', 'Read the hooks', 'Stopped · Haiku 5.5']),
  )
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
