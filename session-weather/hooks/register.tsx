import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Reading, RecentTurn, SubagentFigures } from '../types'
import { RECENT_TURNS_SHAPE, THINKING_SHAPE } from './atoms'
import { cleanUp } from './cleanup'
import { compactLineOf, fillLine, keepBreakdown, packRows, readBreakdown, readFacts, recountTurns, sessionParts } from './context'
import { DEBUG_FOLDER } from './debug'
import { waitingFor } from './entries'
import { messageOf, sessionFile } from './files'
import { clip, forecast, formatCost, formatDelta, formatDuration, formatTime, formatTokens, MINUTE, plural, SECOND } from './format'
import { called, contextRestarted, requestAnswered, requestStarted, turnEnded } from './growth'
import { bar, BLOCK_HEADER, formatLeft, formatPart, levelOf, liveWindows, MINE, paceOf, STORED_CLOSED, STORED_LIMITS, storedLimits } from './limits'
import { LOG_TOOL_NAME, logToolSpec, previousTurn, readLog, setPreviousTurn } from './log'
import { restore, SAVE_TOGGLE, STORED_DEBUG_ON, TOGGLE } from './prefs'
import { COMMAND, DEBUG_COMMAND, heldValue, PANE, settingFieldOf, settings } from './settings'
import { addSpend, costCarried, costCounted, recountShares, setCostCarried, setCostCounted } from './spend'
import { glanceOf, hideStatus, openPane, recount, setStartedOn, showStatus } from './status'
import { figureParts, figuresTimer, forgetEnded, inSubagentOrder, lookedFor, lookFor, MAX_SUBAGENT_ROWS, minuteSubagents, noted, noteFigures, parentOf, relistSubagents, runningSubagents, setFiguresTimer, settleFigures, spawnedAt, SUBAGENT_INDENT, subagentLine, subagentOrder, subagentsHeaderOf } from './subagents'
import { formatSummaryCost, HAIKU_NAME, inputTokens, MAX_REQUEST_CHARS, SAID_CHARS, useSettings } from './summary/prompt'
import { actionOf, askedAt, asking, drainedAt, ended, endLive, endTurn, goOn, isOwed, isResumedBy, isTurnOf, keepMark, liveBlock, MAX_SUBMISSIONS, newTurn, owedRecap, setAskedAt, setDrainedAt, setIsOwed, setLiveBlock, setOwedRecap, setSubmissions, setSummary, startTicker, statusOf, stopTicker, submissions, updateTurn } from './summary/run'
import type { Submission } from './summary/run'
import { AT_WORK, chargeCalls, countTool, keepTurn, maxRecent, measureRecord, openRecord, recordSubagents, recordTurn, restoreTurns, saveTurns, setSaving } from './turns'
import { TERMINAL_TURN_ROWS } from './ui/cards'
import { isPickingDrawn, isRoomyDrawn, setIsPickingDrawn, setIsRoomyDrawn } from './ui/drawn'
import { clamp01, limitStretches } from './ui/look'
import type { DesktopUi } from './ui/look'
import { drawNarrowDesktop } from './ui/narrow'
import { COLUMN_GAP, MIN_PINNED_ROWS, moveUpdates, pageStep, PANE_OVERHEAD, pickTurn, recentLine, shownTurnOf, toNewest, WEATHER_CHARS, weatherColumns, WIDE_FROM, WIDE_OVERHEAD, widthOf, windowOf } from './ui/updates'
import { barRasterOf, barWidthOf, CARD_INSET, CARD_ROWS, cellRunsOf, skyInkOf, TERMINAL_CARD } from './ui/terminal'
import type { CellRun } from './ui/terminal'
import { drawWideDesktop } from './ui/wide'

const reading = atom({ plugin: 'session-weather', key: 'reading' } as const, null)
const samples = atom({ plugin: 'session-weather', key: 'samples' } as const, [])
const delta = atom({ plugin: 'session-weather', key: 'delta' } as const, null)
const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const shares = atom({ plugin: 'session-weather', key: 'shares' } as const, [])
const turnTools = atom({ plugin: 'session-weather', key: 'turnTools' } as const, 0)
const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const subagentFigures = atom({ plugin: 'session-weather', key: 'subagentFigures' } as const, [])
const lastTurn = atom({ plugin: 'session-weather', key: 'lastTurn' } as const, null)
const autoCompact = atom({ plugin: 'session-weather', key: 'autoCompact' } as const, null)
const fills = atom({ plugin: 'session-weather', key: 'fills' } as const, null)
const cost = atom({ plugin: 'session-weather', key: 'cost' } as const, null)
const facts = atom({ plugin: 'session-weather', key: 'facts' } as const, null)
const compactions = atom({ plugin: 'session-weather', key: 'compactions' } as const, null)
const thinking = atom({ plugin: 'session-weather', key: 'thinking' } as const, null, { shape: THINKING_SHAPE })
const recentTurns = atom({ plugin: 'session-weather', key: 'recentTurns' } as const, [], { shape: RECENT_TURNS_SHAPE })
const pickedTurn = atom({ plugin: 'session-weather', key: 'pickedTurn' } as const, null)
const isSaving = atom({ plugin: 'session-weather', key: 'isSaving' } as const, false)
const isSummaryOn = atom({ plugin: 'session-weather', key: 'isSummaryOn' } as const, true)
const summaryCost = atom({ plugin: 'session-weather', key: 'summaryCost' } as const, 0)
const summaryPlace = atom({ plugin: 'session-weather', key: 'summaryPlace' } as const, { line: 0, row: 0 })
const subagentTop = atom({ plugin: 'session-weather', key: 'subagentTop' } as const, 0)
const toolTop = atom({ plugin: 'session-weather', key: 'toolTop' } as const, 0)
const turnTop = atom({ plugin: 'session-weather', key: 'turnTop' } as const, 0)
const isDebugOn = atom({ plugin: 'session-weather', key: 'isDebugOn' } as const, false)

// The rows a pinned desktop layout leaves free at the body's foot.
const DESK_FOOT_ROWS = 1

export const register: Register = (on, options) => {
  // A change in `/config` reloads the mod, and this runs again with it.
  useSettings(options)

  // A setting changed in `/config` is held to what the mod will use, a gap
  // of 1 stored as 5, so the row shows the value in effect. A value written
  // into settings.json by hand is held the same way as it loads.
  on('config.set', ($, e, next) => {
    const field = settingFieldOf(e.key)

    return field === undefined ? next(e) : next({ ...e, value: heldValue(field, e.value) })
  })

  on('session.start', async ($, e, next) => {
    setStartedOn(e.surface)
    // Also runs on every hot reload: seed the reading, but leave the samples
    // alone. A mod loaded mid-session counts the next turn's growth from this
    // reading, not from zero. A session the person saved gets its turns and
    // compactions back first, after a restart. What the engine and the store
    // hold is read all at once.
    await restoreTurns($).catch(() => {})
    const [usage, breakdown, isClosed] = await Promise.all([
      $.session.usage(),
      readBreakdown($),
      $.store.get(STORED_CLOSED).then(value => value === true),
      readFacts($),
    ])
    const { tokens, window, percent } = usage.context
    const now: Reading = { tokens, window, percent }
    // A reload right after a compaction finds no fill yet: the reading keeps
    // the compaction's mark, and its drop stays the change shown, until the
    // next response.
    await update($, reading, kept =>
      tokens === undefined && kept?.isCompacted === true ? { window, isCompacted: true as const } : now,
    )

    // Before the first response the engine has no windows: show the last ones
    // stored until it reports.
    const fresh = [...usage.rateLimits]
    const known = fresh.length > 0 ? fresh : await storedLimits($)
    await update($, limits, () => known)

    if (fresh.length > 0) {
      await $.store.set(STORED_LIMITS, fresh)
    }

    await update($, cost, () => usage.cost?.usd ?? null)
    await keepBreakdown($, breakdown)

    // What the session spent so far, and its part of each window.
    const spentSoFar = usage.cost?.usd
    void (spentSoFar === undefined ? recountShares($) : addSpend($, spentSoFar)).catch(() => {})

    // The summary as the person left it. A reload drops the request under
    // way and the clock with the old module: a turn still running gets a
    // new clock.
    const isOn = await restore($)
    const turn = await update($, thinking, one => (one?.isSummarizing === true ? { ...one, isSummarizing: false } : one))

    if (isOn && turn !== null && turn.durationMs === undefined) {
      startTicker($)
    }

    // "reset in" counts down between turns, and what other sessions spend
    // moves this one's part: check both each minute. A reload drops this
    // timer with the old module.
    $.clock.every(MINUTE, () => {
      void recount($).catch(() => {})
      void recountShares($).catch(() => {})
      void showStatus($).catch(() => {})
      void minuteSubagents($).catch(() => {})
      void cleanUp($).catch(() => {})
    })
    // Subagents at work since before a reload show at once.
    void runningSubagents($).catch(() => {})
    // The mod's old files go as the session starts, and once a day after.
    void cleanUp($).catch(() => {})
    await $.command.register({
      name: COMMAND,
      description: 'Open or close the Session Weather pane',
      immediate: true,
    })
    await $.command.register({
      name: DEBUG_COMMAND,
      description: "Turn the thinking summary's debug log on or off",
      immediate: true,
    })

    // The log's tool, listed for the model from the first prompt on.
    try {
      await $.tool.register(logToolSpec())
    } catch {
      // No tool: the log is still written, for the person to read.
    }

    // The pane, unless the person closed it; where it is closed or waits
    // undrawn, the status line stands in for it.
    void (isClosed ? Promise.resolve() : openPane($)).then(() => showStatus($)).catch(() => {})

    return next(e)
  })

  // The person's switch for the pane. Drawn, it closes, as the person's own
  // close does: it stays closed in later sessions, and the status line takes
  // its place. Closed, or waiting undrawn, it opens, placed at any width, and
  // the status line goes.
  on('command.run', { command: COMMAND }, async $ => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)

    if (isUp) {
      await $.store.set(STORED_CLOSED, true)
      await $.ui.close({ id: PANE })

      return {}
    }

    await $.store.set(STORED_CLOSED, false)
    await openPane($)
    await showStatus($).catch(() => {})

    return {}
  })

  // The person turning the summary's debug log on or off: the output says
  // where it writes.
  on('command.run', { command: DEBUG_COMMAND }, async $ => {
    const isOn = !(await read($, isDebugOn))
    await $.store.set(STORED_DEBUG_ON, isOn)
    await update($, isDebugOn, () => isOn)
    const path = await sessionFile($, DEBUG_FOLDER, await $.session.id())

    if (!isOn) {
      return { text: `Summary debug log off.${path === null ? '' : ` What it wrote stays in ${path}`}` }
    }

    return {
      text:
        path === null
          ? `Summary debug log on, but with no file: the Claude Code configuration directory is not known. Each request still leaves a line in the transcript. /${DEBUG_COMMAND} turns it off.`
          : `Summary debug log on: each Haiku request and its reply go to ${path}, and a line to the transcript. /${DEBUG_COMMAND} turns it off.`,
    }
  })

  // The pane closed: the status line takes its place. An unload is the mod
  // going, or reloading, which looks again as the session starts.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await $.store.set(STORED_CLOSED, true)
    }

    const done = await next(e)

    if (e.id === PANE && e.origin.kind !== 'unload') {
      await showStatus($).catch(() => {})
    }

    return done
  })

  // Where each prompt came from, for the turn it starts to know whether it
  // goes on with the turn before (RESUMING). Every prompt passes as it came.
  on('prompt.submit', async ($, e, next) => {
    const one: Submission = {
      kind: e.origin === undefined ? 'unclassified' : e.origin.kind,
      text: e.text.trim(),
      isIdle: e.turnId === undefined,
    }
    setSubmissions([...submissions, one].slice(-MAX_SUBMISSIONS))
    const result = await next(e)

    // A prompt dropped starts no turn.
    if (result.drop !== undefined) setSubmissions(submissions.filter(item => item !== one))

    return result
  })

  // A subagent's run raises turn.start too, inside the main loop's turn: its
  // tool calls count toward that turn, and its thinking is its own.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnTools, () => 0)
      setLiveBlock(null)
      const isResumed = isResumedBy(e.text)
      const [current, fill] = await Promise.all([read($, thinking), read($, reading)])

      // The turn's growth counts from the fill it starts at: the turn
      // before's end, measured at its end or inside it.
      if (fill?.tokens !== undefined && fill.percent !== undefined && fill.isCompacted !== true) {
        const { tokens, percent } = fill
        await update($, samples, () => [{ tokens, percent }])
      }

      const isOn = await restore($)
      // The prompt the turn began with counts toward the session's.
      await recountTurns($)

      if (isResumed && current !== null) {
        // A subagent's result, or another background message: the updates
        // go on where they were.
        await goOn($, current, e.turnId)
      } else {
        // A new prompt's first note is summarized at once, not after the gap
        // the last turn's updates left; its updates start at the top.
        setAskedAt(Number.NEGATIVE_INFINITY)
        await toNewest($)
        // The turn before, for an update on it that lands from here on, or
        // its recap, still owed. One that waited on its subagents ends here,
        // as far as its last turn went.
        setPreviousTurn(current?.paused !== undefined && current.durationMs === undefined
            ? ended(current, Math.max(0, current.paused.at - current.startedAt), false)
            : current)

        if (previousTurn !== null && previousTurn !== current) {
          if (isOn) setOwedRecap(previousTurn.turnId)

          void keepTurn($, previousTurn)
        }

        // The subagents listed, as they last stood, into the rows of the turns
        // that started them, before this prompt's row opens.
        await recordSubagents($).catch(() => {})
        const startedAt = await $.clock.now()
        await update($, thinking, () => newTurn(e.turnId, clip(e.text.trim(), MAX_REQUEST_CHARS), startedAt))
        // It heads the recent turns, picked: beside the weather its updates
        // show, whichever turn was picked before.
        await openRecord($, e.turnId, startedAt, fill)
        await update($, pickedTurn, () => null)
        // The subagents the prompt before saw end go; those at work stay.
        await forgetEnded($)
        // The desktop's cards list them again from the top.
        await update($, subagentTop, () => 0)
        await update($, toolTop, () => 0)
        // The recent turns from the newest, the new prompt's on top.
        await update($, turnTop, () => 0)
      }

      if (isOn) {
        startTicker($)
      }
    }

    const started = await next(e)

    // A subagent's run the list has no row for, as a forked skill's, which no
    // `agent.spawn` raised: the list is read for it, once.
    if (e.agentId !== undefined) await lookFor($, e.agentId).catch(() => {})

    return started
  })

  // The main loop's thinking as it streams: each block that carries text
  // becomes notes of the turn, a part while it streams long (the ticker cuts
  // them) and the rest once it ends. The text it shows the person is kept
  // too, a block once it ends, for the summary not to tell it again. Every
  // chunk passes on as it came, before anything is kept; a subagent's steps
  // pass untouched, what each read and wrote, and the model and effort it
  // named, noted for its row.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      const usage = result.usage

      if (usage !== null) {
        const tokens = inputTokens(usage) + usage.output_tokens
        noteFigures($, e.agentId, {
          model: usage.model === '' ? e.model : usage.model,
          ...(typeof e.effort === 'string' ? { effort: e.effort } : {}),
          tokens,
          context: tokens,
        })
      }

      return result
    }

    // The calls this request answers: those made since the last one.
    const answered = requestStarted()
    const stream = next(e)
    let index: number | null = null
    let shown: { index: number; text: string } | null = null
    const keepShown = async () => {
      if (shown !== null) await keepMark($, 'said', clip(shown.text.trim(), SAID_CHARS), e.turnId)
      shown = null
    }

    for await (const chunk of stream) {
      yield chunk

      if (chunk.kind === 'thinking') {
        if (index !== null && index !== chunk.index) {
          await endLive($)
          index = null
        }

        if (index === null || liveBlock === null) {
          index = chunk.index
          setLiveBlock({ turnId: e.turnId, text: '', kept: 0 })
        }

        if (liveBlock !== null) liveBlock.text += chunk.text
      } else if (chunk.kind !== 'engine' && index !== null) {
        await endLive($)
        index = null
      }

      if (chunk.kind === 'text') {
        if (shown !== null && shown.index !== chunk.index) await keepShown()

        shown ??= { index: chunk.index, text: '' }
        shown.text += chunk.text
      } else if (chunk.kind !== 'engine') {
        await keepShown()
      }
    }

    if (index !== null) {
      await endLive($)
    }

    await keepShown()

    const result = await stream.result
    // What those calls added to the context goes on their rows.
    const charge = requestAnswered(answered, result.usage === null ? undefined : inputTokens(result.usage))

    if (charge !== null) await chargeCalls($, charge).catch(() => {})

    return result
  })

  // Every call counts toward the turn; the main loop's are kept in a few
  // words, for the summary to read what Claude did beside what it thought,
  // and a subagent's latest, for its row to say what it is at.
  on('tool.call', async ($, e, next) => {
    await update($, turnTools, n => n + 1)
    const action = actionOf(e.tool, e as unknown as Readonly<Record<string, unknown>>)
    const at = await $.clock.now()
    await countTool($, {
      at,
      text: action,
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
    })

    if (e.agentId === undefined) {
      called({ at, text: action })
      await keepMark($, 'actions', action)
    } else {
      noteFigures($, e.agentId, { action })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnEnded()
      const usage = e.usage
      const input = usage ? inputTokens(usage) : 0
      const tools = await read($, turnTools)
      await update($, lastTurn, () => ({
        durationMs: e.durationMs,
        tools,
        isAborted: e.isAborted,
        ...(usage && input > 0 ? { cacheRate: usage.cache_read_input_tokens / input } : {}),
      }))

      // While subagents it started still work, the turn waits for their
      // results, which wake Claude and go on with it; the clock runs on. One
      // the person interrupted, or with none left at work, has ended: the
      // whole of it, from the person's prompt, when results woke it.
      const running = e.isAborted ? 0 : await runningSubagents($)
      const now = await $.clock.now()
      const turn = await updateTurn($, e.turnId, one =>
        running > 0
          ? { ...one, paused: { at: now, subagents: running } }
          : ended(one, one.lastTurnId === undefined ? e.durationMs : Math.max(0, now - one.startedAt), e.isAborted),
      )
      const turnId = turn !== null && isTurnOf(turn, e.turnId) ? turn.turnId : e.turnId
      const isWaiting = turn !== null && isTurnOf(turn, e.turnId) && turn.paused !== undefined

      // Its row in the recent turns ends, or waits, at once.
      if (turn !== null && isTurnOf(turn, e.turnId)) await recordTurn($, turn).catch(() => {})

      // Its last word is owed while the summary runs, even once the next
      // prompt's turn has begun; a turn that ended with it off owes none.
      if (!isWaiting) {
        setOwedRecap((await read($, isSummaryOn)) ? turnId : null)
        stopTicker()
      }

      // The turn's growth as far as measured: the engine raises no
      // measurement at the end when the fill has not moved since one inside
      // the turn, and none for a turn cut before any response, which shows
      // none. A measurement after the end counts it again.
      const [fill, start] = await Promise.all([read($, reading), read($, samples)])
      const from = start.at(-1)?.tokens

      if (fill?.tokens !== undefined && from !== undefined && fill.isCompacted !== true) {
        const to = fill.tokens
        await update($, delta, () => (to === from ? null : to - from))
      }

      // The log takes the end, then the turn's last word is asked, past the
      // gap: no tick follows the end. A turn that waits takes an update of
      // where it stands.
      $.clock.after(0, () => void endTurn($, turnId).catch(() => {}))

      return next(e)
    }

    // A subagent's turn ended, and with its last the subagent: the rows are
    // listed again once the engine has taken it, and its figures taken in,
    // the turn's own count where that is the larger.
    const agentId = e.agentId
    const done = await next(e)
    await relistSubagents($).catch(() => {})
    await settleFigures($, agentId, e.usage).catch(() => {})

    return done
  })

  // A subagent the main loop starts: when, for its row's time, and the list
  // read again so its row shows at once. One a subagent starts has no row:
  // what it reads and writes counts toward its parent's. The spawn stands
  // whatever this bookkeeping does, and a failed hook's spawn is not asked
  // again.
  on('agent.spawn', async ($, e, next) => {
    const done = await next(e)

    try {
      if (done.agentId !== undefined && e.parentAgentId !== undefined) {
        parentOf.set(done.agentId, e.parentAgentId)
      } else if (done.agentId !== undefined) {
        spawnedAt.set(done.agentId, await $.clock.now())
        await runningSubagents($)
      }
    } catch {
      // Its row waits for the next list.
    }

    return done
  }).catch(($, e, next) => next(e))

  // The model reading the log, through the tool registered at the start.
  on('tool.call', { tool: LOG_TOOL_NAME }, async ($, e) => {
    try {
      return { result: await readLog($, e as unknown as { turns?: unknown; full?: unknown }) }
    } catch (error) {
      return { deny: `The thinking log could not be read: ${messageOf(error)}` }
    }
  }).catch(() => ({ deny: 'The thinking log could not be read.' }))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const { tokens, window, percent } = e.context
      const [before, turn] = await Promise.all([read($, reading), read($, thinking)])
      // A measurement while the main loop's turn runs (a rate-limit window
      // moved) shows the fill; the turn's growth is counted at its end. One
      // while the summary's turn waits on its subagents comes between turns.
      const isMidTurn = turn !== null && turn.durationMs === undefined && turn.paused === undefined
      // A compaction's mark stays while the engine has no fill yet, and
      // through the turn it ran in: its drop is the change shown at the end.
      const isCompacted = before?.isCompacted === true && (tokens === undefined || isMidTurn)
      const now: Reading = { tokens, window, percent, ...(isCompacted ? { isCompacted: true as const } : {}) }
      await update($, reading, () => now)

      if (tokens !== undefined) await measureRecord($, tokens)

      // Where the engine compacts on its own, read again at each turn's end
      // (a switch of model changes the window, /config the setting; the read
      // is local) and before the toast, which warns on the way there. What
      // fills the context and the model come with it, and a compaction,
      // having emptied what filled it, has it read again at once.
      const [kept, filled] = await Promise.all([read($, autoCompact), read($, fills)])
      let compactAt = kept

      if (!isMidTurn || window !== before?.window || compactAt === null || filled === null) {
        const fresh = await readBreakdown($)
        await keepBreakdown($, fresh)
        compactAt = fresh.compactAt
      }

      if (tokens !== undefined && percent !== undefined) {
        // The last sample is the fill the turn began at (the turn before's
        // end); after a compaction the hook below did not see, it is still
        // the fuller window, so the drop shows. After one it saw, the drop it
        // counted stays the change shown for this first reading.
        if (!isMidTurn && !before?.isCompacted) {
          const from = (await read($, samples)).at(-1)?.tokens ?? before?.tokens ?? 0
          await update($, delta, () => tokens - from)
        }

        // Warn once on the way up toward compaction: staying above the line,
        // or a hot reload, toasts nothing; after a compaction it may again.
        const level = levelOf(tokens, percent, compactAt)
        const was =
          before?.tokens === undefined || before.percent === undefined
            ? undefined
            : levelOf(before.tokens, before.percent, compactAt)

        if (level >= settings.compactAt && (was === undefined || was < settings.compactAt)) {
          $.ui.toast(
            `${forecast(level).icon} Context ${percent}% full (${formatTokens(tokens)} / ${formatTokens(window)}): time to /compact`,
            { timeoutMs: 10_000 },
          )
        }

        // Only a turn's end is read back, as where the next one begins.
        if (!isMidTurn) await update($, samples, () => [{ tokens, percent }])
      }
    }

    if (e.changed.includes('rateLimits')) {
      const fresh = [...e.rateLimits]
      await update($, limits, () => fresh)
      await $.store.set(STORED_LIMITS, fresh)
      // A window that reset counts the parts from its new start.
      void recountShares($).catch(() => {})
    }

    if (e.changed.includes('cost')) {
      await update($, cost, () => e.cost?.usd ?? null)

      if (e.cost !== undefined) void addSpend($, e.cost.usd).catch(() => {})
    }

    await showStatus($).catch(() => {})

    return next(e)
  })

  // A /clear (or a resume of another session in this process) goes on under
  // a new session id, with no session.start: the old conversation's weather
  // and thinking go with it, and a request under way on its turn is cut, so
  // nothing of it reaches the new conversation's log. The host wipes the
  // pane's values too, the person's choices among them.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      contextRestarted()
      stopTicker()
      asking?.abort()
      setLiveBlock(null)
      setPreviousTurn(null)
      setOwedRecap(null)
      const window = (await read($, reading))?.window
      await update($, reading, () => (window === undefined ? null : { window }))
      await update($, samples, () => [])
      await update($, delta, () => null)
      await update($, lastTurn, () => null)
      await update($, turnTools, () => 0)
      await update($, thinking, () => null)
      await update($, fills, () => null)
      await update($, facts, () => null)
      await update($, compactions, () => null)
      await inSubagentOrder(async () => {
        await update($, subagents, () => [])
        await update($, subagentFigures, () => [])
      })
      spawnedAt.clear()
      parentOf.clear()
      lookedFor.clear()
      noted.clear()
      figuresTimer?.cancel()
      setFiguresTimer(null)
      await update($, recentTurns, () => [])
      await update($, pickedTurn, () => null)
      await update($, subagentTop, () => 0)
      await update($, toolTop, () => 0)
      await update($, turnTop, () => 0)
      await update($, isSaving, () => false)
      await showStatus($).catch(() => {})
      await toNewest($)
      setIsOwed(false)
      setAskedAt(Number.NEGATIVE_INFINITY)
      setSubmissions([])
      setDrainedAt(null)
      // The next session's spend counts from what this one's total reached,
      // should the engine keep counting it over a /clear.
      setCostCarried(e.reason === 'clear' ? (costCounted?.cost ?? null) : null)
      setCostCounted(null)
      // The host wipes the pane's values once the session has ended: the
      // person's choices and the limits come back from the store after it,
      // the parts are counted for the next session, the new session's facts
      // and breakdown are read (a resumed one's saved turns first), and the
      // status line reads what is left.
      $.clock.after(SECOND, () =>
        void restore($)
          .then(() =>
            Promise.all([
              recountShares($),
              showStatus($),
              restoreTurns($)
                .catch(() => {})
                .then(() => readFacts($))
                .then(async () => keepBreakdown($, await readBreakdown($))),
            ]),
          )
          .catch(() => {}),
      )
    }

    return next(e)
  })

  // `/compact` is a command, not a turn, so no measurement follows it: the
  // pane learns of a compaction here. The fill stays unknown until the next
  // response; the drop is what the compaction counted.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)

    // A precompute installs nothing, a subagent compacts its own transcript,
    // and a skip leaves the conversation as it was.
    if (e.trigger === 'precompute' || e.agentId !== undefined || done.skip !== undefined) {
      return done
    }

    // The compaction stands whatever this bookkeeping does. It counts toward
    // the session's (one loaded mid-session counts from there), and what
    // filled the context is read again with the next measurement.
    contextRestarted()

    try {
      await update($, compactions, one => ({ count: (one?.count ?? 0) + 1, isWhole: one?.isWhole ?? false }))
      await saveTurns($)
      await update($, fills, () => null)
      const { window } = (await $.session.usage()).context
      const drop =
        done.tokensBefore === undefined || done.tokensAfter === undefined
          ? null
          : done.tokensAfter - done.tokensBefore
      await update($, reading, () => ({ window, isCompacted: true as const }))
      await update($, delta, () => drop)
      await update($, samples, () => [])
    } catch {
      // The pane keeps its last reading until the next turn measures one.
    }

    await showStatus($).catch(() => {})

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Drawn, the pane says all the status line would: an unplaced pane is
    // drawn first once the terminal widens to place it, and the line goes.
    void hideStatus($).catch(() => {})

    // Minimized to a widget on the desktop app: the glance, lined up on the
    // edge the widget is anchored to, with no buttons, as a click may not
    // reach it there. It reads only what it shows.
    if (e.props.placement === 'widget') {
      const [at, now, compactAt, readings, spent, isOn] = await Promise.all([
        $.clock.now(),
        read($, reading),
        read($, autoCompact),
        read($, limits),
        read($, cost),
        read($, isSummaryOn),
      ])
      const glance = glanceOf(now, compactAt, readings, spent, at, isOn ? await read($, thinking) : null)
      const lines = [
        glance.sky === null ? null : (
          <Text bold color={glance.sky.color} wrap="truncate">
            {glance.sky.text}
          </Text>
        ),
        glance.figures === null ? null : (
          <Text dimColor wrap="truncate">
            {glance.figures}
          </Text>
        ),
        glance.update === null ? null : <Text wrap="truncate">{glance.update}</Text>,
      ].filter(line => line !== null)
      const isOnRight = e.props.anchoredEdges?.includes('right') ?? false

      return (
        <Box flexDirection="column" {...(isOnRight ? { alignItems: 'flex-end' as const } : {})}>
          {lines.length === 0 ? (
            <Text dimColor wrap="truncate">
              Waiting for the first response.
            </Text>
          ) : (
            lines.slice(0, Math.max(1, e.props.scroll.bodyRows))
          )}
        </Box>
      )
    }

    // On the desktop, the design's layouts: under WIDE_FROM columns the
    // narrow one, from it the wide one. The terminal draws no Svg (its table
    // has one that draws nothing): it draws its blocks below in cards with a
    // round border, and its bars as a Raster, a row of colored cells.
    // A pinned layout stands a row short of the body: the desktop turns rows
    // into pixels by its own measure, which on a smaller or scaled screen came
    // to a few pixels more than the body shows, and the pane scrolled.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const rows = Math.max(1, e.props.scroll.bodyRows - DESK_FOOT_ROWS)

      return e.props.bodyColumns < WIDE_FROM
        ? drawNarrowDesktop($, ui as DesktopUi, e.props.bodyColumns, rows)
        : drawWideDesktop($, ui as DesktopUi, e.props.bodyColumns, rows)
    }

    // A bar: a Raster where the surface has one, else its rows of text.
    const Raster = 'Raster' in ui ? ui.Raster : undefined
    const barOf = (key: string, cells: number, runs: readonly CellRun[], marks: readonly number[], text: JSX.Element) =>
      Raster === undefined ? text : <Raster {...barRasterOf(key, cells, runs, marks)} />

    // Each read subscribes the drawing to its value; they go all at once.
    const [at, now, added, lastSamples, readings, parts, compactAt, turn, spent, listed, isOn] = await Promise.all([
      $.clock.now(),
      read($, reading),
      read($, delta),
      read($, samples),
      read($, limits),
      read($, shares),
      read($, autoCompact),
      read($, lastTurn),
      read($, cost),
      read($, subagents),
      read($, isSummaryOn),
    ])
    // From WIDE_FROM columns the weather says more (`isRoomy`): the pace on
    // the limits, what fills the context, the session, a row for each
    // subagent and the recent turns. That goes by the width alone, the
    // summary on or off; the two columns need the summary on as well. What
    // only a roomy pane shows is read only there: a narrower one redraws for
    // none of it. The subagents are read at any width, a narrower pane saying
    // in one line how many work and finished; what each did, only a roomy one.
    const isRoomy = e.props.bodyColumns >= WIDE_FROM
    const isWide = isOn && isRoomy
    const [filled, known, counted, figured, recent, picked, isSaved] = isRoomy
      ? await Promise.all([
          read($, fills),
          read($, facts),
          read($, compactions),
          read($, subagentFigures),
          read($, recentTurns),
          read($, pickedTurn),
          read($, isSaving),
        ])
      : ([null, null, null, [] as SubagentFigures[], [] as RecentTurn[], null, false] as const)
    setIsRoomyDrawn(isRoomy)
    setIsPickingDrawn(isWide)
    // The characters a row of the weather holds, what it adds cut to them
    // rather than wrapped: its column's beside the summary, else the body's;
    // inside its cards' borders either way.
    const weatherChars = isWide ? WEATHER_CHARS : widthOf(e.props.bodyColumns - CARD_INSET, e.surface)
    // The bars span their card inside its border and padding.
    const barCells = barWidthOf((isWide ? weatherColumns(e.surface) : e.props.bodyColumns) - (isWide ? 0 : CARD_INSET))
    const hasTurns = lastSamples.length > 0
    // Each window, with this session's part of its share in points.
    const windows = liveWindows(readings, at).map(window => ({
      ...window,
      mine: window.percent * (parts.find(part => part.kind === window.kind)?.ratio ?? 0),
    }))

    const tokens = now?.tokens
    const percent = now?.percent
    const compactLine = now === null ? null : compactLineOf(compactAt, now.window)

    // "Last turn ▲ +9.7k · 2m 14s · 18 tools · cache 96%".
    const turnParts = [
      added === null ? null : formatDelta(added),
      turn === null ? null : `${formatDuration(turn.durationMs)}${turn.isAborted ? ' (interrupted)' : ''}`,
      turn === null ? null : plural(turn.tools, 'tool'),
      turn?.cacheRate === undefined ? null : `cache ${Math.round(turn.cacheRate * 100)}%`,
    ].filter((part): part is string => part !== null)

    // Roomy, the session's cost goes on its line: "Fable 5.2 · since 09:12 ·
    // 23 turns · 2 compactions · $16.17", in as many rows as the column needs.
    const sessionRows = isRoomy ? packRows(sessionParts(known, counted, spent, at), weatherChars) : []

    // The fill: read, unknown after a compaction until the next response, or
    // not yet reported in a session that has not had one. The sky reads how
    // far it has come toward compaction.
    const sky = tokens !== undefined && percent !== undefined ? forecast(levelOf(tokens, percent, compactAt)) : null
    const context =
      now !== null && tokens !== undefined && percent !== undefined && sky !== null ? (
        <Box flexDirection="column">
          <Text bold color={sky.color}>
            {sky.icon} {sky.label}
          </Text>
          <Text>
            {percent}% of context · {formatTokens(tokens)} / {formatTokens(now.window)}
          </Text>
          {barOf(
            'bar-context',
            barCells,
            [{ from: 0, to: clamp01(percent / 100), ink: skyInkOf(sky.label) }],
            compactAt?.isEnabled === true && compactAt.threshold !== undefined && now.window > 0
              ? [compactAt.threshold / now.window]
              : [],
            <Text color={sky.color}>{bar(percent)}</Text>,
          )}
          {compactLine !== null && <Text dimColor>{compactLine}</Text>}
          {filled?.map((fill, index) => (
            <Text dimColor wrap="truncate">
              {clip(fillLine(fill, now.window, index === filled.length - 1), weatherChars)}
            </Text>
          ))}
          {turnParts.length > 0 && <Text dimColor>Last turn {turnParts.join(' · ')}</Text>}
        </Box>
      ) : now?.isCompacted || hasTurns ? (
        <Box flexDirection="column">
          <Text bold color="warning">
            ☀ Compacted
          </Text>
          {now?.isCompacted && added !== null && <Text dimColor>{formatDelta(added)}</Text>}
        </Box>
      ) : (
        <Text dimColor>Context: waiting for the first response.</Text>
      )

    // The thinking summary sits last: it changes the most. Off, it reads
    // nothing, so its updates redraw nothing.
    const [turnNow, summarySpent, isDebugging, place] = isOn
      ? await Promise.all([read($, thinking), read($, summaryCost), read($, isDebugOn), read($, summaryPlace)])
      : ([null, 0, false, { line: 0, row: 0 }] as const)

    // Beside the weather the summary shows the turn picked from the list of
    // recent turns, the current one unless the person pressed another.
    const view = isWide ? shownTurnOf(turnNow, picked, recent) : { turn: turnNow, isPast: false }
    const turnShown = view.turn

    // "🧭 Thinking · 1m 46s", the turn's whole length once it ended; "·
    // waiting for 2 subagents" while their results are still to come. A turn
    // picked from the list says when it began: "🧭 Turn at 14:32 · 2m 14s ·
    // done", its length left out where its end was not seen (Claude Code
    // closed while it ran).
    const header =
      turnShown === null
        ? '🧭 Thinking'
        : view.isPast
          ? [
              `🧭 Turn at ${formatTime(turnShown.startedAt)}`,
              ...(turnShown.durationMs === undefined ? [] : [formatDuration(turnShown.durationMs)]),
              turnShown.isAborted ? 'interrupted' : 'done',
            ].join(' · ')
          : [
              '🧭 Thinking',
              formatDuration(Math.max(0, turnShown.durationMs ?? at - turnShown.startedAt)),
              ...(turnShown.durationMs !== undefined
                ? [turnShown.isAborted ? 'interrupted' : 'done']
                : turnShown.paused !== undefined
                  ? [waitingFor(turnShown.paused.subagents)]
                  : []),
              ...(turnShown.isSummarizing ? ['summarizing…'] : []),
            ].join(' · ')

    const status = view.isPast
      ? turnShown?.entries.length === 0
        ? 'No updates on this turn.'
        : null
      : statusOf(turnNow)

    // A body tall enough pins the weather on top and the summary's cost at
    // the bottom; the turn's updates scroll in the window between, moved by
    // the arrows. A new prompt starts them over. A body WIDE_FROM columns
    // wide sets the weather beside the summary instead, and the window then
    // has the summary's whole column but its header and footer.
    const rows = e.props.scroll.bodyRows
    const isPinned = isOn && rows >= MIN_PINNED_ROWS
    const weatherWidth = weatherColumns(e.surface) + CARD_INSET
    // The summary's columns: the body's, less the weather's column and the
    // gap beside it where the two stand side by side, inside its card.
    const summaryColumns = (isWide ? e.props.bodyColumns - weatherWidth - COLUMN_GAP : e.props.bodyColumns) - CARD_INSET
    // The lines measured in rows at the summary's width, the measure the
    // arrows then step through.
    const width = widthOf(summaryColumns, e.surface)
    // The lines showing, each one Text the surface wraps at its full width,
    // kept together by update (each opens with its gist), with a rule between
    // two: it stands where a Box's `gap` spaced them (an empty Box of one row
    // drew nothing on the desktop), and the steps count neither.
    const { shown, newer, canScroll } = windowOf(turnShown, width, place, isPinned, rows)

    // The rule between two updates: a dim row of box drawing across the
    // summary, in the monospaced face whose cells the body is measured in,
    // and cut rather than wrapped should it run over. (The desktop drew no
    // Svg here.)
    const rule = (
      <Text dimColor mono wrap="truncate">
        {'─'.repeat(Math.max(1, summaryColumns - 1))}
      </Text>
    )

    const thoughts = (
      <Box flexDirection="column" {...(isPinned ? { flexGrow: 1, flexShrink: 1, overflow: 'hidden' as const } : {})}>
        <Text bold>{header}</Text>
        {status !== null && <Text dimColor>{status}</Text>}
        {newer > 0 && (
          <Button
            key="newest"
            hotkey="n"
            plain
            dimColor
            label={`↑ ${plural(newer, 'newer update')}`}
            onPress={() => toNewest($).catch(() => {})}
          />
        )}
        {shown.length > 0 && (
          <Box flexDirection="column">
            {shown.flatMap((group, at) => [
              ...(at === 0 ? [] : [rule]),
              <Box flexDirection="column">
                {group.map(item =>
                  item.kind === 'decision' ? (
                    <Text color="warning">{item.text}</Text>
                  ) : item.kind === 'assumption' ? (
                    <Text color="suggestion">{item.text}</Text>
                  ) : (
                    <Text>{item.text}</Text>
                  ),
                )}
              </Box>,
            ])}
          </Box>
        )}
      </Box>
    )

    // A click on an arrow steps the window about half its height: the one
    // way to scroll it. Holding an arrow cannot scroll, as the desktop draws
    // the pane again only when the press ends; its wheel scrolls the pane
    // itself, which, pinned, has nothing to scroll; and its keys do not
    // reach the pane.
    // The cards' borders take rows of their own: the summary's card, and in
    // one column the weather's above it.
    const step = pageStep(rows, (isWide ? WIDE_OVERHEAD : PANE_OVERHEAD + CARD_ROWS) + CARD_ROWS)

    // The recent turns' header, and beside it the person's switch for
    // keeping this session's turns past a restart of Claude Code, a box to
    // tick: "☐ Persist" unless pressed; ticked, "☑ Persist", the turns go to
    // a file; unticked again, the file goes and the turns stay in memory.
    const recentHeader = (
      <Box flexDirection="row" gap={2}>
        <Text {...BLOCK_HEADER}>Recent turns</Text>
        <Button
          key={SAVE_TOGGLE}
          hotkey="p"
          plain
          dimColor={!isSaved}
          label={isSaved ? '☑ Persist' : '☐ Persist'}
          onPress={() => setSaving($, !isSaved).catch(() => {})}
        />
      </Box>
    )

    // The weather: the fill, the limits, the session's cost and how many
    // subagents work and finished; roomy, the pace on the limits, what fills
    // the context, the session's line, a row for each subagent and the recent
    // turns too. A column of its own beside
    // the summary, which, pinned, cuts what runs past the body's height: the
    // oldest turns go first.
    const weather = (
      <Box
        key="weather"
        flexDirection="column"
        flexShrink={0}
        {...(isWide ? { width: weatherWidth } : {})}
        {...(isWide && isPinned ? { overflow: 'hidden' as const } : {})}
      >
        {/* The weather's card: the sky and the fill, the limits, the session. */}
        <Box {...TERMINAL_CARD} gap={1}>
          {context}
          {windows.length > 0 && (
            <Box flexDirection="column">
              <Text {...BLOCK_HEADER}>Usage limits</Text>
              {windows.map(window => {
                // "5h 30% · this session 8% · reset in 4h 38m", the part in
                // yellow, as its cells are: the last of the bar's filled ones,
                // and, where the pace says more by the reset, that much hatched.
                // Roomy, the bar marks how much of the window's time has gone,
                // and says where the share used would stand at the reset.
                const pace = isRoomy ? paceOf(window.percent, window.elapsed) : null
                const marks = isRoomy && window.elapsed !== undefined ? [window.elapsed] : []
                const cells = pace === null ? barCells : Math.max(10, barCells - pace.length - 1)

                return (
                  <Box flexDirection="column">
                    <Text>
                      {window.name} {window.used}%
                      {window.mine > 0 && ' · '}
                      {window.mine > 0 && <Text color={MINE}>this session {formatPart(window.mine)}</Text>}
                      {window.left === undefined ? '' : ` · reset in ${formatLeft(window.left)}`}
                    </Text>
                    <Box flexDirection="row" gap={1}>
                      {barOf(
                        `bar-${window.kind}`,
                        cells,
                        cellRunsOf(limitStretches(window)),
                        marks,
                        <Text dimColor>{bar(window.used)}</Text>,
                      )}
                      {pace !== null && <Text dimColor>{pace}</Text>}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          )}
          {isRoomy
            ? sessionRows.length > 0 && (
                <Box flexDirection="column">
                  {sessionRows.map(row => (
                    <Text dimColor wrap="truncate">
                      {row}
                    </Text>
                  ))}
                </Box>
              )
            : (spent !== null || listed.length > 0) && (
                <Box flexDirection="column">
                  {spent !== null && <Text dimColor>Session cost {formatCost(spent)}</Text>}
                  {listed.length > 0 && <Text dimColor>{subagentsHeaderOf(listed)}</Text>}
                </Box>
              )}
        </Box>
        {listed.length > 0 && isRoomy && (
          <Box {...TERMINAL_CARD}>
            <Text {...BLOCK_HEADER}>{subagentsHeaderOf(listed)}</Text>
            {subagentOrder(listed)
              .slice(0, MAX_SUBAGENT_ROWS)
              .map(agent => {
                // Its row, then under it, at work, what it is at, and its
                // figures in as many rows as they need.
                const { label, tail } = subagentLine(agent, at, weatherChars)
                const isWorking = AT_WORK.has(agent.status)
                const figure = figured.find(one => one.id === agent.id)
                const chars = weatherChars - SUBAGENT_INDENT
                const action = isWorking ? figure?.action : undefined
                const figureRows = packRows(figureParts(figure, isWorking), chars)

                return (
                  <Box flexDirection="column">
                    <Text wrap="truncate">
                      {label}
                      <Text dimColor>{tail}</Text>
                    </Text>
                    {(action !== undefined || figureRows.length > 0) && (
                      <Box flexDirection="column" paddingLeft={SUBAGENT_INDENT}>
                        {action !== undefined && (
                          <Text dimColor wrap="truncate">
                            {clip(action, chars)}
                          </Text>
                        )}
                        {figureRows.map(row => (
                          <Text dimColor wrap="truncate">
                            {row}
                          </Text>
                        ))}
                      </Box>
                    )}
                  </Box>
                )
              })}
            {listed.length > MAX_SUBAGENT_ROWS && <Text dimColor>and {listed.length - MAX_SUBAGENT_ROWS} more</Text>}
          </Box>
        )}
        {recent.length > 0 && (
          <Box {...TERMINAL_CARD}>
            {recentHeader}
            {recent.slice(-Math.min(maxRecent(), TERMINAL_TURN_ROWS)).reverse().map((one, index) => {
              // Newest first, so that a column too short for them all cuts
              // the oldest. Beside the summary each is pressed to show its
              // updates there, the one shown marked ▸; with the summary off
              // they are figures alone.
              const text = recentLine(one, index === 0)

              if (!isWide) {
                return (
                  <Text dimColor wrap="truncate">
                    {clip(text, weatherChars)}
                  </Text>
                )
              }

              const isShown = one.turnId === turnShown?.turnId

              return (
                <Button
                  key={`turn-${one.turnId}`}
                  // 1 the newest, on down, and 0 the tenth (TERMINAL_TURN_ROWS).
                  hotkey={index < 9 ? String(index + 1) : '0'}
                  plain
                  dimColor={!isShown}
                  label={clip(`${isShown ? '▸ ' : ''}${text}`, weatherChars)}
                  onPress={() => pickTurn($, one.turnId === turnNow?.turnId ? null : one.turnId).catch(() => {})}
                />
              )
            })}
          </Box>
        )}
      </Box>
    )

    // The summary's footer: what it cost, its switch, and the arrows. Once
    // the pane holds the keyboard (ctrl+x tab, or a click), a letter presses
    // each of the pane's buttons: s the switch, k and j the arrows, n the
    // newest update, p Persist, and 1 to 9 a recent turn.
    const footer = (
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor>
          {isOn
            ? `Summary cost ${formatSummaryCost(summarySpent)} - ${HAIKU_NAME}${isDebugging ? ' · debug log on' : ''}`
            : '🧭 Thinking summary is off'}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key={TOGGLE}
            hotkey="s"
            label={isOn ? 'Turn summary off' : 'Turn summary on'}
            dimColor
            onPress={() => setSummary($, !isOn).catch(() => {})}
          />
          {canScroll && (
            <Button
              key="newer"
              hotkey="k"
              plain
              dimColor
              label="▲"
              onPress={() => moveUpdates($, -step, width, isWide).catch(() => {})}
            />
          )}
          {canScroll && (
            <Button
              key="older"
              hotkey="j"
              plain
              dimColor
              label="▼"
              onPress={() => moveUpdates($, step, width, isWide).catch(() => {})}
            />
          )}
        </Box>
      </Box>
    )

    // Wide: the weather on the left, the summary and its footer on the
    // right; pinned, both as tall as the body.
    if (isWide) {
      return (
        <Box flexDirection="row" gap={COLUMN_GAP} {...(isPinned ? { height: rows } : {})}>
          {weather}
          <Box
            key="summary"
            {...TERMINAL_CARD}
            gap={1}
            flexGrow={1}
            flexShrink={1}
            {...(isPinned ? { height: rows, overflow: 'hidden' as const } : {})}
          >
            {thoughts}
            {footer}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" {...(isPinned ? { height: rows } : {})}>
        {weather}
        <Box
          key="thinking"
          {...TERMINAL_CARD}
          gap={1}
          {...(isPinned ? { flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' as const } : {})}
        >
          {isOn && thoughts}
          {footer}
        </Box>
      </Box>
    )
  })
}
