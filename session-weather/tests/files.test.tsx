// The mod's files: the thinking log, the debug log, and the cleanup.

import { expect, test } from 'claude-code/testing'
import { answer, DAY, DEBUG, engine, LOG, MINUTE, MOD_FILES, NOW, oneTurn, RATE_LIMITED, runStep, SECOND, sectionOf, SLOW, start, stop, thought, thoughts, toolInput, toolStart, turnDone, two, when } from './helpers'

// The mod's files, each written `days` days ago.
const aged = (entries: [string, number][]) => ({
  files: Object.fromEntries(entries.map(([path]) => [path, 'x'])),
  written: Object.fromEntries(entries.map(([path, days]) => [path, NOW - days * DAY])),
})

test("the mod's files nothing has written for 30 days are deleted as a session starts; its own, newer ones and others stay", SLOW, async ($, on) => {
  const old = [
    `${MOD_FILES}/thinking/old.md`,
    `${MOD_FILES}/debug/old.md`,
    `${MOD_FILES}/spend/old.json`,
    `${MOD_FILES}/turns/old.json`,
  ]
  const kept = [`${MOD_FILES}/thinking/new.md`, `${MOD_FILES}/thinking/session-1.md`, `${MOD_FILES}/thinking/notes.txt`]
  const { files, runs, clock } = engine(
    on,
    aged([
      ...old.map((path): [string, number] => [path, 31]),
      [kept[0]!, 29],
      [kept[1]!, 90],
      [kept[2]!, 90],
    ]),
  )

  await $.session.start(start)
  await clock.settle()
  expect(runs).toEqual([{ argv: ['rm', '-f', '--', ...old], stdin: undefined }])
  expect([...files.keys()].sort()).toEqual([...kept].sort())

  // Once a day at most: a reading a minute on looks no further.
  await clock.advance(MINUTE)
  expect(runs.length).toBe(1)
})

test('on Windows PowerShell deletes them, the paths on its input', async ($, on) => {
  const old = '/Users/me/.claude/session-weather/thinking/old.md'
  const { files, runs, clock } = engine(on, {
    env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', HOME: '/c/Users/me' },
    ...aged([[old, 40]]),
  })

  await $.session.start(start)
  await clock.settle()
  expect(runs.map(run => run.argv[0])).toEqual(['powershell.exe'])
  expect(runs[0]?.stdin).toBe('C:\\Users\\me\\.claude\\session-weather\\thinking\\old.md')
  expect(files.has(old)).toBe(false)
})

test('the days are a setting: at 7 a file written eight days ago goes', { options: { cleanupDays: 7 } }, async ($, on) => {
  const file = `${MOD_FILES}/thinking/old.md`
  const { files, clock } = engine(on, aged([[file, 8]]))

  await $.session.start(start)
  await clock.settle()
  expect(files.has(file)).toBe(false)
})

test('at 0 days every file stays', { options: { cleanupDays: 0 } }, async ($, on) => {
  const file = `${MOD_FILES}/thinking/old.md`
  const { files, runs, clock } = engine(on, aged([[file, 400]]))

  await $.session.start(start)
  await clock.settle()
  expect(runs).toEqual([])
  expect(files.has(file)).toBe(true)
})

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

test('a debug log left on in an earlier session keeps the newest 30 requests', SLOW, async ($, on) => {
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
const LOG_TOOL = 'mcp__session-weather__thinking_log'

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

test("a line like an entry's mark inside a prompt leaves the debug log its 30 requests", SLOW, async ($, on) => {
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
