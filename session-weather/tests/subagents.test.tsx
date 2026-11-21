// The subagents: their rows, figures, and the turns that wait on them.

import { expect, test } from 'claude-code/testing'
import { allTexts, answer, at, BREAKDOWN, DAY, engine, handBack, HOUR, LOG, measure, MINUTE, NO_WAIT, NOW, oneTurn, pane, requestUsage, resume, RULE, runStep, SECOND, sectionOf, SLOW, start, stop, stopWith, subagent, submit, tagged, thought, thoughts, turnDone, when, WIDE_FROM } from './helpers'
import type { Test$ } from './helpers'

// What the weather shows of the subagents, in a pane `columns` wide: from
// WIDE_FROM, the block's header and its rows (each subagent's own, then what
// it is at and its figures), up to the recent turns; narrower, the one line.
// None where it shows nothing of them.
const subagentsShown = async ($: Test$, surface: 'desktop' | 'terminal', columns: number) => {
  const texts = await pane($, surface, columns)
  const top = texts.findIndex(text => text.startsWith('Subagents'))
  const end = texts.indexOf('Recent turns', top)

  // Each row's own Text, not the dim part inside it.
  return top === -1 ? [] : texts.slice(top, end === -1 ? undefined : end).filter(text => !text.startsWith(' · '))
}

test('from WIDE_FROM columns each subagent has a row, where it stands and how long it has run; one that ended stays until the next prompt', SLOW, async ($, on) => {
  const { agents, clock } = engine(on)
  const long = 'Read every file of the hooks module and list each helper that has no comment over it'
  const ids: Record<string, string> = { 'Find the flaky test': 'a1', [long]: 'a2' }
  on('agent.spawn', ($$, e) => ({ model: 'claude-haiku-5-5', agentId: ids[e.description] ?? 'w9' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })

  // Spawned by the main loop: its row shows at once. Another plugin's, and a
  // subagent's own, do not.
  agents.push(
    { id: 'a1', description: 'Find the flaky test', type: 'Explore', status: 'running' },
    { id: 'p1', description: "A plugin's helper", type: 'general-purpose', status: 'running', spawnedBy: 'other' },
    { id: 'c1', description: "A subagent's own", type: 'Explore', status: 'running', parentId: 'a1' },
  )
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find the flaky test' } as never)

  for (const surface of ['terminal'] as const) {
    expect(await subagentsShown($, surface, WIDE_FROM)).toEqual([
      'Subagents · 1 at work',
      'Find the flaky test · running · <1m',
    ])
  }

  // Three minutes on, a second, its description long: cut to leave room for
  // the rest.
  await clock.advance(3 * MINUTE)
  agents.push({ id: 'a2', description: long, type: 'general-purpose', status: 'pending' })
  await $.agent.spawn({ prompt: 'Read it.', description: long } as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 2 at work',
    'Find the flaky test · running · 3m',
    'Read every file of the hooks… · pending · <1m',
  ])

  // The first ends with its last turn: its row stays, done, with how long it
  // ran and, the mod having seen none of its requests, what its turn says it
  // read and wrote.
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 180_000 }) as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 at work · 1 finished',
    'Read every file of the hooks… · pending · <1m',
    'Find the flaky test · done · 3m 0s',
    'Opus 5.5 · 25.5k tokens',
  ])

  // A minute on, the second fails: the latest to end first.
  await clock.advance(MINUTE)
  agents[3]!.status = 'failed'
  await $.turn.complete(turnDone({ agentId: 'a2', durationMs: MINUTE, usage: undefined }) as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 2 finished',
    'Read every file of the hooks… · failed · 1m 0s',
    'Find the flaky test · done · 3m 0s',
    'Opus 5.5 · 25.5k tokens',
  ])

  // A hand-back goes on with the prompt, and keeps them; the person's next
  // prompt lets them go.
  await resume($, handBack('a1'), 't2')
  expect((await subagentsShown($, 'terminal', WIDE_FROM))[0]).toBe('Subagents · 2 finished')
  await $.turn.start({ text: 'next', turnId: 't3' })
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([])

  // A workflow's many, listed as one more starts: five rows, the rest in one.
  for (let at = 1; at <= 8; at += 1) {
    agents.push({ id: `w${at}`, description: `Step ${at}`, type: 'general-purpose', status: 'running' })
  }
  await $.agent.spawn({ prompt: 'Run it.', description: 'Step 9' } as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 8 at work',
    'Step 1 · running',
    'Step 2 · running',
    'Step 3 · running',
    'Step 4 · running',
    'Step 5 · running',
    'and 3 more',
  ])
})

test("from WIDE_FROM columns a subagent's rows say what it is at, its model and effort, what it read and wrote, and its context", SLOW, async ($, on) => {
  const { agents, clock, steps } = engine(on)
  on('agent.spawn', ($$, e) => ({ model: 'claude-opus-5-5', agentId: e.parentAgentId === undefined ? 'a1' : 'c1' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push({ id: 'a1', description: 'Find the flaky test', type: 'general-purpose', status: 'running' })
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find the flaky test' } as never)

  // Two requests and a tool call: taken in once a second has passed.
  await runStep($, steps, 'a-turn', [stopWith(requestUsage(1_000, 20_000, 500))], 'a1', 'high')
  await runStep($, steps, 'a-turn', [stopWith(requestUsage(2_000, 21_500, 800))], 'a1', 'high')
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/ProductList.tsx', agentId: 'a1' } as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 at work',
    'Find the flaky test · running · <1m',
  ])

  await clock.advance(SECOND)

  for (const surface of ['terminal'] as const) {
    expect(await subagentsShown($, surface, WIDE_FROM)).toEqual([
      'Subagents · 1 at work',
      'Find the flaky test · running · <1m',
      'Read: ProductList.tsx',
      'Opus 5.5 · high · 45.8k tokens · ctx 24.3k',
    ])
  }

  // A subagent of its own: what it reads and writes counts toward its row,
  // what it is at does not. A loop no row stands for (the engine's own fork)
  // counts toward none.
  agents.push({ id: 'c1', description: 'Look closer', type: 'Explore', status: 'running', parentId: 'a1' })
  await $.agent.spawn({ prompt: 'Look.', description: 'Look closer', parentAgentId: 'a1' } as never)
  await runStep($, steps, 'c-turn', [stopWith(requestUsage(10_000, 0, 200, 'claude-haiku-5-5'))], 'c1')
  await $.tool.call({ tool: 'Grep', pattern: 'flaky', agentId: 'c1' } as never)
  await runStep($, steps, 'f-turn', [stopWith(requestUsage(90_000, 0, 1_000))], 'fork-1')
  await clock.advance(SECOND)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 at work',
    'Find the flaky test · running · <1m',
    'Read: ProductList.tsx',
    'Opus 5.5 · high · 56k tokens · ctx 24.3k',
  ])

  // Ended: how long it ran, its model and what it read and wrote, more than
  // its turn says (its subagent's too); what it was at and its context go.
  await clock.advance(2 * MINUTE)
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 2 * MINUTE }) as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 finished',
    'Find the flaky test · done · 2m 2s',
    'Opus 5.5 · high · 56k tokens',
  ])

  // Narrower, the one line.
  expect(await subagentsShown($, 'terminal', WIDE_FROM - 1)).toEqual(['Subagents · 1 finished'])
})

test('subagents started at once each keep their row and since when they run', SLOW, async ($, on) => {
  const { agents, clock } = engine(on)
  on('agent.spawn', ($$, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'One' ? 'a1' : 'a2' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push(
    { id: 'a1', description: 'One', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'Two', type: 'Explore', status: 'running' },
  )

  // Two Agent calls of one response: their spawns, and the lists each reads,
  // overlap.
  await Promise.all([
    $.agent.spawn({ prompt: 'One.', description: 'One' } as never),
    $.agent.spawn({ prompt: 'Two.', description: 'Two' } as never),
  ])
  await clock.advance(2 * MINUTE)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 2 at work',
    'One · running · 2m',
    'Two · running · 2m',
  ])
})

test("a subagent's own requests the mod missed count as its turn says, its subagents' kept beside them", async ($, on) => {
  const { agents, clock, steps } = engine(on)
  on('agent.spawn', ($$, e) => ({ model: 'claude-opus-5-5', agentId: e.parentAgentId === undefined ? 'a1' : 'c1' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push(
    { id: 'a1', description: 'Find it', type: 'general-purpose', status: 'running' },
    { id: 'c1', description: 'Look', type: 'Explore', status: 'running', parentId: 'a1' },
  )
  await $.agent.spawn({ prompt: 'Find it.', description: 'Find it' } as never)
  await $.agent.spawn({ prompt: 'Look.', description: 'Look', parentAgentId: 'a1' } as never)

  // Of its own requests the mod sees one, 10k; its subagent's come to 50k.
  await runStep($, steps, 'a-turn', [stopWith(requestUsage(10_000, 0, 0))], 'a1')
  await runStep($, steps, 'c-turn', [stopWith(requestUsage(50_000, 0, 0))], 'c1')
  await clock.advance(SECOND)
  expect((await subagentsShown($, 'terminal', WIDE_FROM)).at(-1)).toBe('Opus 5.5 · 60k tokens · ctx 10k')

  // Its turn says its own came to 30k: that, and its subagent's 50k beside.
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 5_000, usage: requestUsage(20_000, 10_000, 0) }) as never)
  expect((await subagentsShown($, 'terminal', WIDE_FROM)).at(-1)).toBe('Opus 5.5 · 80k tokens')
})

test('a subagent no spawn raised, as a forked skill, gets its row as its turn starts', async ($, on) => {
  const { agents } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })

  // Nothing else at work, so no tick or minute lists it.
  agents.push({ id: 's1', description: 'Run the review skill', type: 'general-purpose', status: 'running' })
  await $.turn.start({ text: 'Review it.', turnId: 's-turn', agentId: 's1' })
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 at work',
    'Run the review skill · running',
  ])

  // It ends: its row says so, and what its turn read and wrote.
  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 's1', turnId: 's-turn', durationMs: 5_000 }) as never)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 1 finished',
    'Run the review skill · done',
    'Opus 5.5 · 25.5k tokens',
  ])
})

test('under WIDE_FROM columns one line says how many subagents work and finished; the status line, how many work', async ($, on) => {
  // A terminal too narrow to place the pane unasked: the status line stands
  // in for it.
  const { agents, clock, status } = engine(on, { columns: 120 })
  on('agent.spawn', ($$, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'One' ? 'a1' : 'a2' }))

  await $.session.start(start)
  await $.turn.start({ text: 'go', turnId: 't1' })
  agents.push(
    { id: 'a1', description: 'One', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'Two', type: 'Explore', status: 'running' },
  )
  await $.agent.spawn({ prompt: 'One.', description: 'One' } as never)
  await $.agent.spawn({ prompt: 'Two.', description: 'Two' } as never)
  expect(status()).toBe('2 subagents')
  // (The desktop gives them rows at any width: see the desktop tests.)
  expect(await subagentsShown($, 'terminal', WIDE_FROM - 1)).toEqual(['Subagents · 2 at work'])

  agents[0]!.status = 'completed'
  await $.turn.complete(turnDone({ agentId: 'a1', durationMs: 5_000 }) as never)
  expect(status()).toBe('1 subagent')
  expect(await subagentsShown($, 'terminal', WIDE_FROM - 1)).toEqual(['Subagents · 1 at work · 1 finished'])

  // The last stopped: nothing left for the line to say.
  await clock.advance(MINUTE)
  agents[1]!.status = 'killed'
  await $.turn.complete(turnDone({ agentId: 'a2', durationMs: 5_000, reason: 'aborted', isAborted: true }) as never)
  expect(status()).toBe(undefined)
  expect(await subagentsShown($, 'terminal', WIDE_FROM)).toEqual([
    'Subagents · 2 finished',
    'Two · stopped · 1m 0s',
    'Opus 5.5 · 25.5k tokens',
    'One · done · 0s',
    'Opus 5.5 · 25.5k tokens',
  ])
})

test('drawn wide and idle, the pane redraws no more often than before', async ($, on) => {
  const { clock, redraws } = engine(on, {
    breakdown: BREAKDOWN,
    rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: at(2 * DAY + 5 * HOUR + 30 * MINUTE) }],
  })

  await $.session.start(start)
  await allTexts($, 'desktop', WIDE_FROM)
  await clock.advance(MINUTE)
  const after = redraws()

  await clock.advance(5 * MINUTE)
  expect(redraws()).toBe(after)
})

// The thinking summary's header.
const header = async ($: Test$) => (await thoughts($))[0]

test("a subagent's result goes on with the turn's updates, which wait, not done, while its subagents work", async ($, on) => {
  const { agents, asks, files, replies, steps, clock } = engine(on)
  replies.push(
    answer('GIST: Giao việc cho hai agent.'),
    answer('GIST: Chờ hai agent.'),
    answer('GIST: Agent a1 xong.'),
    answer('GIST: Tổng kết.'),
  )
  const [a1, a2] = [subagent('a1'), subagent('a2')]

  await $.session.start(start)
  await $.prompt.submit(submit('review it'))
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'I will ask two agents.'), stop])
  await clock.advance(SECOND)
  agents.push(a1, a2)
  await runStep($, steps, 't1', [thought(0, 'Both agents run; I wait for them.'), stop])
  await clock.advance(4 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()

  // Not done: an update says where Claude stands, WAIT not allowed, and no
  // recap yet; the clock runs on.
  expect(asks.length).toBe(2)
  expect(asks[1]?.prompt).toContain('Claude has ended its turn to wait for subagents it started')
  expect(asks[1]?.prompt).not.toContain('The turn has ended')
  expect(asks[1]?.prompt.endsWith(`\n\n${NO_WAIT}`)).toBe(true)
  expect(await header($)).toBe('🧭 Thinking · 5s · waiting for 2 subagents')
  expect(sectionOf(files.get(LOG) ?? '', 't1')).toContain(`## ${when(NOW)} · waiting for 2 subagents\n`)

  await clock.advance(MINUTE)
  expect(asks.length).toBe(2)
  expect(await header($)).toBe('🧭 Thinking · 1m 5s · waiting for 2 subagents')

  // a1 hands back: its turn goes on with the updates, under the person's
  // request.
  a1.status = 'completed'
  await resume($, handBack('a1'), 't2')
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 5s',
    '5s · Chờ hai agent.',
    RULE,
    '1s · Giao việc cho hai agent.',
    'Summary cost $0.004 - Haiku 5.5',
  ])

  await runStep($, steps, 't2', [thought(0, 'Agent a1 found two issues; a2 still runs.'), stop])
  await clock.advance(SECOND)
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('<request>\nreview it\n</request>')
  expect(tagged(asks[2]?.prompt, 'notes')).toBe('<note>\nAgent a1 found two issues; a2 still runs.\n</note>')

  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(await header($)).toBe('🧭 Thinking · 1m 6s · waiting for 1 subagent')

  // a2, the last, hands back: the turn ends with it, its length from the
  // person's prompt, and its recap reads the whole of it.
  a2.status = 'completed'
  await resume($, handBack('a2'), 't3')
  await runStep($, steps, 't3', [thought(0, 'Both agents are in; I fix the two issues.'), stop])
  await clock.advance(9 * SECOND)
  await $.turn.complete(turnDone({ turnId: 't3', durationMs: 9_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(4)
  expect(asks[3]?.prompt).toContain('The turn has ended')

  for (const note of ['I will ask two agents.', 'Agent a1 found two issues', 'Both agents are in']) {
    expect(tagged(asks[3]?.prompt, 'notes')).toContain(note)
  }

  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 15s · done',
    'Recap · Tổng kết.',
    RULE,
    '1m 6s · Agent a1 xong.',
    RULE,
    '5s · Chờ hai agent.',
    RULE,
    '1s · Giao việc cho hai agent.',
    'Summary cost $0.008 - Haiku 5.5',
  ])

  // One section in the log, under the person's prompt.
  const log = files.get(LOG) ?? ''
  expect(sectionOf(log, 't1')).toContain(`## ${when(NOW)} · 1m 15s · done\n\n> review it\n\n- Recap · Tổng kết.\n`)
  expect(log).not.toContain('<!-- turn t2 -->')
  expect(log).not.toContain('<!-- turn t3 -->')
})

test("a measurement while the turn waits on its subagents counts the last turn's growth", async ($, on) => {
  const { agents, clock } = engine(on)

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  agents.push(subagent('a1'))
  await $.turn.complete(turnDone() as never)
  await clock.settle()
  await $.session.measure(measure(90_000, 45))
  expect(await pane($)).toContain('Last turn ▲ +90k · 2m 14s · 0 tools · cache 96%')
})

test("a prompt of the person's own while the turn waits starts the updates over, and the waiting turn gets its recap", async ($, on) => {
  const { agents, asks, files, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))

  await $.session.start(start)
  await $.prompt.submit(submit('review it'))
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  agents.push(subagent('a1'))
  await runStep($, steps, 't1', [thought(0, 'I wait for a1.'), stop])
  await clock.advance(4 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 5_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(2)

  await clock.advance(20 * SECOND)
  await $.prompt.submit(submit('and now this'))
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.004 - Haiku 5.5'])

  // The turn that waited ends where its last turn did, and its recap comes.
  await clock.advance(SECOND)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('<request>\nreview it\n</request>')
  expect(asks[2]?.prompt).toContain('The turn has ended')

  const section = sectionOf(files.get(LOG) ?? '', 't1')
  expect(section).toContain(' · 5s · done\n')
  expect(section).toContain('- Recap · Tổng kết.\n- 1s · Một.\n- 5s · Hai.\n')
})

test('a turn whose subagents all end with no result waking Claude is done half a minute after', async ($, on) => {
  const { agents, asks, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'))
  const a1 = subagent('a1')

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  agents.push(a1)
  await runStep($, steps, 't1', [thought(0, 'I wait for a1.'), stop])
  await $.turn.complete(turnDone({ durationMs: 1_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(2)

  // Stopped, and no word of it wakes Claude.
  a1.status = 'killed'
  await clock.advance(15 * SECOND)
  expect(await header($)).toBe('🧭 Thinking · 16s · waiting')

  await clock.advance(25 * SECOND)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(asks[2]?.prompt).toContain('The turn has ended')
  expect(await header($)).toBe('🧭 Thinking · 11s · done')

  // Done: the clock stops, and nothing more is asked.
  await clock.advance(MINUTE)
  expect(asks.length).toBe(3)
})

test("a background task's notification after the turn ended reopens it; one update after its recap needs none again", async ($, on) => {
  const { asks, replies, steps, clock } = engine(on)
  replies.push(answer('GIST: Một.'), answer('GIST: Hai.'), answer('GIST: Tổng kết.'), answer('GIST: Build xong.'))

  await $.session.start(start)
  await $.prompt.submit(submit('build it'))
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'First note.'), stop])
  await clock.advance(SECOND)
  await runStep($, steps, 't1', [thought(0, 'Second note.'), stop])
  await clock.advance(15 * SECOND)
  await $.turn.complete(turnDone({ durationMs: 20_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(3)
  expect(await header($)).toBe('🧭 Thinking · 20s · done')

  await clock.advance(MINUTE)
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'
  await resume($, notice, 't2', 'task-notification')
  expect(await header($)).toBe('🧭 Thinking · 1m 16s')
  expect((await thoughts($))[1]).toBe('Recap · Tổng kết.')

  await runStep($, steps, 't2', [thought(0, 'The build passed.'), stop])
  await clock.advance(SECOND)
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 2_000 }) as never)
  await clock.settle()
  expect(asks.length).toBe(4)
  expect(await thoughts($)).toEqual([
    '🧭 Thinking · 1m 17s · done',
    '1m 17s · Build xong.',
    RULE,
    'Recap · Tổng kết.',
    RULE,
    '16s · Hai.',
    RULE,
    '1s · Một.',
    'Summary cost $0.008 - Haiku 5.5',
  ])
})

test('a prompt the person typed while a turn ran starts over, though a notification came in after it', async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await $.prompt.submit(submit('fix it'))
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  // Typed while t1 runs: it waits in the queue.
  await $.prompt.submit(submit('and now this', { kind: 'composer' }, 't1'))
  await $.turn.complete(turnDone({ durationMs: 2_000 }) as never)
  await clock.settle()

  // A notification goes into the conversation with no turn of its own, then
  // the queued prompt's turn begins.
  await $.prompt.submit(submit('<task-notification>\n<task-id>b1</task-id>\n</task-notification>', { kind: 'task-notification' }))
  await $.turn.start({ text: 'and now this', turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])
})

test('a hand-back no prompt.submit showed is known by its frame, and goes on with the turn', async ($, on) => {
  const { agents, steps, clock } = engine(on)
  const a1 = subagent('a1')

  await $.session.start(start)
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await runStep($, steps, 't1', [thought(0, 'A note.'), stop])
  await clock.advance(SECOND)
  agents.push(a1)
  await $.turn.complete(turnDone({ durationMs: 2_000 }) as never)
  await clock.settle()
  expect(await header($)).toBe('🧭 Thinking · 1s · waiting for 1 subagent')

  a1.status = 'completed'
  await $.turn.start({ text: handBack('a1'), turnId: 't2' })
  expect(await thoughts($)).toEqual(['🧭 Thinking · 1s', '1s · Claude đang sửa lỗi.', 'Summary cost $0.002 - Haiku 5.5'])

  // So with an origin the mod does not know.
  await $.turn.complete(turnDone({ turnId: 't2', durationMs: 1_000 }) as never)
  await clock.settle()
  await resume($, handBack('a2'), 't3', 'unclassified')
  expect((await thoughts($))[1]).toBe('1s · Claude đang sửa lỗi.')
})

test("a prompt of the person's own that quotes a hand-back's frame starts over", async ($, on) => {
  const { steps, clock } = engine(on)

  await $.session.start(start)
  await oneTurn($, steps, clock, 't1', 'fix it')
  await resume($, handBack('a1'), 't2', 'composer')
  expect(await thoughts($)).toEqual(['🧭 Thinking · 0s', 'No thinking notes yet.', 'Summary cost $0.002 - Haiku 5.5'])
})
