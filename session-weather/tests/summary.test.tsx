// The thinking summary: the notes Haiku reads, its updates and recaps, the
// turn's end.

import { expect, test } from 'claude-code/testing'
import { allTexts, answer, buttons, DEBUG, engine, limits, LOG, measure, MINUTE, NO_WAIT, NOW, oneTurn, pane, plain, PLAIN, press, RATE_LIMITED, RULE, runStep, SECOND, sectionOf, SLOW, start, stop, tagged, thought, thoughts, toolInput, toolStart, turnDone, VIETNAMESE } from './helpers'

const words = (index: number, text: string) => ({ kind: 'text', index, text })

test('the thinking summary sits last, under the session cost, waiting for a turn', SLOW, async ($, on) => {
  engine(on, { cost: 1.234 })

  await $.session.start(start)
  const texts = await allTexts($)
  expect(texts.slice(texts.indexOf('Session cost $1.23'))).toEqual([
    'Session cost $1.23',
    '🧭 Thinking',
    'Waiting for the next turn.',
    'Summary cost $0.000 - Haiku 5.5',
  ])
  expect(await buttons($)).toEqual(['▾', 'Turn summary off'])
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

test('updates keep 15 seconds apart, stay newest first, and the end adds a recap', SLOW, async ($, on) => {
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

test('a rule of box drawing stands between two updates, beside the weather on the desktop as in the terminal', async ($, on) => {
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

  // Three updates, two rules between them, each across the body. (Under
  // WIDE_FROM columns the desktop lists earlier updates one line each.)
  const texts = await thoughts($)
  expect(texts.filter(text => text === RULE).length).toBe(2)
  expect(texts.indexOf(RULE)).toBe(texts.indexOf('31s · Claude đang sửa lỗi.') + 1)
  expect(texts.lastIndexOf(RULE)).toBe(texts.indexOf('16s · Claude đang sửa lỗi.') + 1)
})

test('a new prompt starts the updates over', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  expect(await thoughts($)).toContain('1s · Claude đang sửa lỗi.')

  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])

  // Ended with no thinking the mod saw: the line says where it comes from.
  await $.turn.complete(turnDone({ turnId: 't2' }) as never)
  expect(await thoughts($)).toContain('No thinking notes this turn: they come only with the Thinking or Verbose transcript view.')
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
  // The main loop called tools and thought nothing the mod saw: the line says
  // where its thinking comes from.
  expect(await thoughts($)).toContain('No thinking notes yet: they come only with the Thinking or Verbose transcript view.')

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
  // "★ Chỉ sửa file A". A click moves half the window, three rows in a body
  // of thirty under the weather's card, to the last row.
  await press($, 'older')
  expect(await pane($)).toContain('Session cost $1.23')
  expect(await thoughts($)).toEqual(['🧭 Thinking · 16s', '★ Chỉ sửa file A', 'Summary cost $0.004 - Haiku 5.5'])
  expect(await buttons($)).toEqual(['▾', '↑ 2 newer updates', 'Turn summary off', '▲', '▼'])

  // A new update lands on top, and the window keeps showing the same row.
  await runStep($, steps, 't1', [thought(0, 'Third note.'), stop])
  await clock.advance(15 * SECOND)
  expect((await thoughts($))[1]).toBe('★ Chỉ sửa file A')
  expect(await buttons($)).toEqual(['▾', '↑ 3 newer updates', 'Turn summary off', '▲', '▼'])

  // ▲ goes back as far; ↑ goes straight to the newest.
  await press($, 'newer')
  expect((await thoughts($))[1]).toBe('16s · Hai.')
  await press($, 'older')
  expect((await thoughts($))[1]).toBe('★ Chỉ sửa file A')
  await press($, 'newest')
  expect((await thoughts($))[1]).toBe('31s · Ba.')

  // A new prompt starts at the top, with nothing to scroll.
  await press($, 'older')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await buttons($)).toEqual(['▾', 'Turn summary off'])
})

test('in a narrow pane the lines wrap as the surface wraps them, and a click on ▼ passes a long line', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Claude đang đọc file cấu hình rồi chạy lại toàn bộ test\nNEXT: Chạy lại test'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)

  // One Text a line, for the surface to wrap at its full width. At 25
  // columns a terminal row holds 20 characters inside the card: the long
  // line is four rows, the next step a fifth.
  expect(await thoughts($, 'terminal', 25)).toEqual([
    '🧭 Thinking · 1s',
    '1s · Claude đang đọc file cấu hình rồi chạy lại toàn bộ test',
    '→ Chạy lại test',
    'Summary cost $0.002 - Haiku 5.5',
  ])

  // A click passes three rows, two the whole line.
  await press($, 'older', 25)
  await press($, 'older', 25)
  expect((await thoughts($, 'terminal', 25)).slice(1, -1)).toEqual(['→ Chạy lại test'])
  await press($, 'newer', 25)
  await press($, 'newer', 25)
  expect((await thoughts($, 'terminal', 25))[1]).toBe('1s · Claude đang đọc file cấu hình rồi chạy lại toàn bộ test')
})

test('a click on ▼ shows a long line from part-way, marked, and a new update keeps that place', async ($, on) => {
  const { replies, steps, clock } = engine(on)
  const words = Array.from({ length: 60 }, (_, at) => `từ${at}`).join(' ')
  replies.push(answer(`GIST: ${words}`), answer('GIST: Mới.'))

  await $.session.start(start)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)

  // 20 characters a terminal row at 25 columns, inside the card: the line is
  // a score of rows, and a click passes three of them, about sixty
  // characters.
  await press($, 'older', 25)
  const moved = (await thoughts($, 'terminal', 25))[1] ?? ''
  expect(moved.startsWith('… ')).toBe(true)
  expect(moved.length).toBeLessThan(`1s · ${words}`.length - 50)
  expect(moved.length).toBeGreaterThan(`1s · ${words}`.length - 70)

  // An update lands on top: the line still shows from the same word.
  await runStep($, steps, 't1', [thought(0, 'Another note.'), stop])
  await clock.advance(15 * SECOND)
  expect((await thoughts($, 'terminal', 25))[1]).toBe(moved)

  // ▲ goes back three rows, to the start of the long line, under the new one.
  await press($, 'newer', 25)
  expect((await thoughts($, 'terminal', 25))[1]).toBe(`1s · ${words}`)
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

test("each prompt's turn reads the person's choices from the store again: a /clear, which wipes the pane's values, does not turn the summary back on", async ($, on) => {
  const { asks, store, steps, clock, files } = engine(on)

  await $.session.start(start)
  expect(await buttons($)).toEqual(['▾', 'Turn summary off'])

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
