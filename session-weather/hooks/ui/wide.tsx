// The desktop pane from WIDE_FROM columns: the cards in two columns.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Fill } from '../../types'
import { RECENT_TURNS_SHAPE, THINKING_SHAPE } from '../atoms'
import { compactLineOf, REST, sessionParts } from '../context'
import { formatCost, formatDelta, formatTokens } from '../format'
import { formatLeft, formatPart, paceOf } from '../limits'
import type { Folding } from '../prefs'
import { subagentsOfRecord } from '../turns'
import { DESK_SUBAGENT_ROWS, DESK_TOOL_ROWS, footerOf, LEFT_CELLS, subagentsCardOf, thinkingCardOf, toolsCardOf, turnsCardOf, wideTurnRowsOf } from './cards'
import { isPickingDrawn, isRoomyDrawn, setIsPickingDrawn, setIsRoomyDrawn } from './drawn'
import { barSvg, cardLook, cardTitleOf, clamp01, DESK, foldButtonOf, foldPlanOf, HATCH, INK, lastTurnPartsOf, limitStretches, paceAlertOf, pillSvg, shownWindowsOf, SKIES, skyOf, swatchSvg, tileSvg, WIDE_HEAD_ROWS, WINDOW_TITLES } from './look'
import type { DesktopUi, Stretch } from './look'
import { COLUMN_GAP, MIN_PINNED_ROWS, shownTurnOf, WIDE_OVERHEAD } from './updates'

const reading = atom({ plugin: 'session-weather', key: 'reading' } as const, null)
const delta = atom({ plugin: 'session-weather', key: 'delta' } as const, null)
const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const shares = atom({ plugin: 'session-weather', key: 'shares' } as const, [])
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
const foldedCards = atom({ plugin: 'session-weather', key: 'foldedCards' } as const, [])
const turnTop = atom({ plugin: 'session-weather', key: 'turnTop' } as const, 0)
const isDebugOn = atom({ plugin: 'session-weather', key: 'isDebugOn' } as const, false)

// What fills the context, as the wide card colors it, largest first; the
// rest, folded together, grey.
const FILL_INKS = ['#F47920', '#00AEEF', '#7FD7F7', '#FACAA7'] as const

const inkOfFill = (fill: Fill, index: number) => (fill.name === REST ? INK.grey : (FILL_INKS[index] ?? INK.grey))

// The pane on the desktop from WIDE_FROM columns, as the design's wide
// layout draws it: across the top the sky with the session's line, a
// warning where a window would run out, and the session's cost; on the left
// the limits with their pace (on top, as the person looks at them most), the
// context with what fills it, and the recent turns, one pressed to show its
// updates; on the right the subagents and the thinking summary, its arrows
// scrolling the turn shown. With the summary off, the cards stand in one
// column. Each read subscribes the drawing.
export async function drawWideDesktop ($: EngineInterface, ui: DesktopUi, columns: number, rows: number) {
  const { Box, Button, Svg, Text } = ui
  const [at, now, added, readings, parts, compactAt, turn, spent, listed, figured, known, counted, filled, recent, isSaved, isOn] =
    await Promise.all([
      $.clock.now(),
      read($, reading),
      read($, delta),
      read($, limits),
      read($, shares),
      read($, autoCompact),
      read($, lastTurn),
      read($, cost),
      read($, subagents),
      read($, subagentFigures),
      read($, facts),
      read($, compactions),
      read($, fills),
      read($, recentTurns),
      read($, isSaving),
      read($, isSummaryOn),
    ])
  const [turnNow, picked, place, summarySpent, isDebugging] = isOn
    ? await Promise.all([read($, thinking), read($, pickedTurn), read($, summaryPlace), read($, summaryCost), read($, isDebugOn)])
    : ([null, null, { line: 0, row: 0 }, 0, false] as const)
  setIsRoomyDrawn(true)
  setIsPickingDrawn(isOn)

  const windows = shownWindowsOf(readings, parts, at)
  const tokens = now?.tokens
  const percent = now?.percent
  const sky = skyOf(now, compactAt)
  const skyLook = sky === null ? undefined : SKIES[sky.label]
  const sessionLine = sessionParts(known, counted, null, at).join(' · ')
  const alert = paceAlertOf(windows)
  // Beside the weather the summary shows the turn picked from the recent
  // turns, the current one unless the person pressed another.
  const view = isOn ? shownTurnOf(turnNow, picked, recent) : { turn: null, isPast: false }
  const rightCells = columns - LEFT_CELLS - COLUMN_GAP
  const leftCells = isOn ? LEFT_CELLS : columns
  const barCells = leftCells - 2

  const head = (
    <Box flexDirection="row" alignItems="center" gap={2}>
      {skyLook !== undefined && <Svg source={tileSvg(skyLook.icon, skyLook.ink, 44, 0.14)} alt={sky?.label ?? 'Sky'} width={44} height={44} />}
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text size="heading" weight="semibold" color={sky?.color}>
          {sky?.label ?? 'Waiting for the first response'}
        </Text>
        {sessionLine !== '' && (
          <Text size="caption" dimColor wrap="truncate">
            {sessionLine}
          </Text>
        )}
      </Box>
      <Box flexGrow={1} />
      {alert !== null && (
        <Box flexShrink={1} minWidth={0}>
          <Svg source={pillSvg(alert)} alt={alert} />
        </Box>
      )}
      {spent !== null && (
        <Box flexDirection="column" alignItems="flex-end">
          <Text size="caption" dimColor>
            Session cost
          </Text>
          <Text size="title" weight="medium" tabular>
            {formatCost(spent)}
          </Text>
        </Box>
      )}
    </Box>
  )

  // The context: its share used, a bar of what fills it, each part's share
  // under it, and the last turn.
  const compactLine = now === null ? null : compactLineOf(compactAt, now.window)
  const compactMark =
    now !== null && compactAt?.isEnabled === true && compactAt.threshold !== undefined && now.window > 0
      ? compactAt.threshold / now.window
      : undefined
  let from = 0
  const fillRuns: Stretch[] =
    now === null || now.window <= 0
      ? []
      : filled !== null && filled.length > 0
        ? filled.map((fill, index) => {
            const run = { from, to: Math.min(1, from + fill.tokens / now.window), ink: inkOfFill(fill, index) }
            from = run.to

            return run
          })
        : percent === undefined
          ? []
          : [{ from: 0, to: clamp01(percent / 100), ink: INK.mine }]
  const contextBar = barSvg(fillRuns, barCells, compactMark, 10)
  const { grown, rest: lastParts } = lastTurnPartsOf(added, turn)

  // The cards the person folded to their top line: the left column's each
  // keeps its gist there.
  const folded = await read($, foldedCards)
  const isFolded = (name: Folding) => folded.includes(name)
  const contextGist =
    tokens !== undefined && percent !== undefined && now !== null ? `${percent}% · ${formatTokens(tokens)} / ${formatTokens(now.window)}` : null

  const contextCard = isFolded('context') ? (
    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY="sm" {...cardLook(DESK.card)}>
      {foldButtonOf($, ui, 'context', true)}
      {cardTitleOf(ui, 'layers', 'Context')}
      <Box flexGrow={1} />
      {contextGist !== null && (
        <Text size="caption" dimColor tabular wrap="truncate">
          {contextGist}
        </Text>
      )}
    </Box>
  ) : (
    <Box flexDirection="column" gap="xs" paddingX={1} paddingY="sm" {...cardLook(DESK.card)}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, 'context', false)}
        {cardTitleOf(ui, 'layers', 'Context')}
        <Box flexGrow={1} />
        {compactLine !== null && (
          <Text size="caption" dimColor wrap="truncate">
            {`${compactLine.charAt(0).toUpperCase()}${compactLine.slice(1)}`}
          </Text>
        )}
      </Box>
      {tokens !== undefined && percent !== undefined && now !== null ? (
        <Box flexDirection="row" alignItems="flex-end" gap={1}>
          <Text size="title" weight="medium" tabular>
            {`${percent}%`}
          </Text>
          <Text dimColor tabular>
            {`${formatTokens(tokens)} / ${formatTokens(now.window)}`}
          </Text>
        </Box>
      ) : (
        <Text dimColor>
          {now?.isCompacted === true
            ? `Compacted${added === null ? '' : ` ${formatDelta(added)}`}`
            : 'Waiting for the first response.'}
        </Text>
      )}
      <Svg source={contextBar.source} alt={percent === undefined ? 'Context' : `Context ${percent}% full`} height={contextBar.height} />
      {now !== null &&
        filled?.map((fill, index) => (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={swatchSvg(inkOfFill(fill, index))} alt={fill.name} width={12} height={8} />
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate">{fill.name}</Text>
            </Box>
            <Text dimColor tabular>
              {formatTokens(fill.tokens)}
            </Text>
            <Text size="caption" dimColor tabular>
              {formatPart((fill.tokens / now.window) * 100)}
            </Text>
          </Box>
        ))}
      {(grown !== null || lastParts.length > 0) && (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text size="caption" weight="medium" dimColor>
            Last turn
          </Text>
          {grown !== null && (
            <Text size="caption" weight="semibold" tabular>
              {grown}
            </Text>
          )}
          {lastParts.length > 0 && (
            <Text size="caption" dimColor wrap="truncate">
              {lastParts.join(' · ')}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )

  // The limits: each window's share used over a bar of this session's part
  // and its pace, when it resets and where the pace would take it.
  const limitsGist = windows.map(window => `${WINDOW_TITLES[window.kind] ?? window.name} ${window.used}%`).join(' · ')
  const limitsCard =
    windows.length > 0 &&
    (isFolded('limits') ? (
      <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY="sm" {...cardLook(DESK.card)}>
        {foldButtonOf($, ui, 'limits', true)}
        {cardTitleOf(ui, 'gauge', 'Usage limits')}
        <Box flexGrow={1} />
        <Text size="caption" dimColor tabular wrap="truncate">
          {limitsGist}
        </Text>
      </Box>
    ) : (
    <Box flexDirection="column" gap="sm" paddingX={1} paddingY="sm" {...cardLook(DESK.card)}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, 'limits', false)}
        {cardTitleOf(ui, 'gauge', 'Usage limits')}
      </Box>
      {windows.map(window => {
        const title = WINDOW_TITLES[window.kind] ?? window.name
        const pace = paceOf(window.percent, window.elapsed)
        const limitBar = barSvg(limitStretches(window), barCells, undefined, 8)

        return (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text weight="medium">{title}</Text>
              <Text weight="semibold" tabular>
                {`${window.used}%`}
              </Text>
            </Box>
            <Svg
              source={limitBar.source}
              alt={`${title} ${window.used}% used${window.mine > 0 ? `, this session ${formatPart(window.mine)}` : ''}`}
              height={limitBar.height}
            />
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text size="caption" dimColor>
                {window.mine > 0 ? `This session ${formatPart(window.mine)}` : ''}
              </Text>
              <Text size="caption" dimColor wrap="truncate">
                {window.left === undefined ? '' : `Resets in ${formatLeft(window.left)}`}
                {pace !== null && (
                  <Text size="caption" {...(pace.startsWith('>') ? { color: 'error' } : { dimColor: true })}>
                    {`${window.left === undefined ? '' : ' · '}${pace}`}
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
        )
      })}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {(
          [
            [INK.others, 'Other sessions'],
            [INK.mine, 'This session'],
            [HATCH, 'Projected at reset'],
          ] as const
        ).map(([ink, label]) => (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={swatchSvg(ink)} alt={label} width={12} height={8} />
            <Text size="caption" dimColor>
              {label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
    ))

  // The recent turns: in a pinned pane they take the height the cards above
  // them leave, unless folded.
  const turnsCard = turnsCardOf($, ui, {
    recent,
    isOn,
    shownId: isOn ? view.turn?.turnId : undefined,
    currentId: turnNow?.turnId,
    isSaved,
    foldName: 'turns',
    fold: { isFolded: isFolded('turns'), grows: isOn && rows >= MIN_PINNED_ROWS && !isFolded('turns') },
    // Pinned, as many as fit, ▲ and ▼ scrolling the rest; else all of them,
    // the pane scrolling whole.
    rows:
      isOn && rows >= MIN_PINNED_ROWS
        ? wideTurnRowsOf({
            room: rows - WIDE_HEAD_ROWS,
            isContextFolded: isFolded('context'),
            fills: filled?.length ?? 0,
            isLimitsFolded: isFolded('limits'),
            windows: windows.length,
          })
        : null,
    top: await read($, turnTop),
  })

  // A turn picked from the list shows the subagents it started; the current
  // one, those listed now.
  const pastRow = view.isPast ? recent.find(one => one.turnId === view.turn?.turnId) : undefined
  const cardOf = pastRow === undefined ? { listed, figured, more: 0 } : subagentsOfRecord(pastRow, listed, figured)
  const callsRow = pastRow ?? recent.at(-1)
  // A body tall enough pins both columns to it, each cut at the bottom: the
  // oldest turns go first on the left; on the right the lowest card open
  // takes what is left, the summary's oldest lines cut, or the oldest calls
  // or subagents.
  const isPinned = isOn && rows >= MIN_PINNED_ROWS
  const plan = foldPlanOf({
    folded,
    isOn,
    room: isPinned ? rows - WIDE_HEAD_ROWS : null,
    subagents: { count: cardOf.listed.length, rows: DESK_SUBAGENT_ROWS },
    tools: { count: callsRow?.calls?.length ?? 0, rows: DESK_TOOL_ROWS },
  })
  const subagentsCard = subagentsCardOf(
    $,
    ui,
    cardOf.listed,
    cardOf.figured,
    at,
    isOn ? rightCells : columns,
    await read($, subagentTop),
    true,
    cardOf.more,
    plan.subagents.rows,
    plan.subagents.fold,
  )
  // Under them the tool calls of the same turn.
  const toolsCard = toolsCardOf($, ui, callsRow, await read($, toolTop), plan.tools.rows, plan.tools.fold)
  const footer = footerOf($, ui, isOn, summarySpent, isDebugging)

  // With the summary off there is nothing to stand beside: one column.
  if (!isOn) {
    return (
      <Box flexDirection="column" gap="sm">
        {head}
        {contextCard}
        {limitsCard}
        {subagentsCard}
        {toolsCard}
        {turnsCard}
        {footer}
      </Box>
    )
  }

  const thinkingCard = thinkingCardOf($, ui, {
    turnNow,
    shown: view.turn,
    isPast: view.isPast,
    place,
    at,
    rows,
    cardColumns: rightCells - 2,
    isWide: true,
    overhead: WIDE_OVERHEAD,
    isFolded: plan.isThinkingFolded,
  })

  return (
    <Box flexDirection="column" gap="sm" {...(isPinned ? { height: rows } : {})}>
      {head}
      <Box flexDirection="row" gap={COLUMN_GAP} {...(isPinned ? { flexGrow: 1, flexShrink: 1, minHeight: 0 } : {})}>
        <Box flexDirection="column" gap="sm" width={LEFT_CELLS} flexShrink={0} {...(isPinned ? { overflow: 'hidden' as const } : {})}>
          {contextCard}
          {limitsCard}
          {turnsCard}
        </Box>
        <Box flexDirection="column" gap="sm" flexGrow={1} flexShrink={1} minWidth={0}>
          {subagentsCard}
          {toolsCard}
          {thinkingCard}
          {footer}
        </Box>
      </Box>
    </Box>
  )
}
