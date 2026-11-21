// The desktop pane under WIDE_FROM columns: the cards in one column.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { RECENT_TURNS_SHAPE, THINKING_SHAPE } from '../atoms'
import { sessionParts } from '../context'
import { formatCost, formatDelta, formatTokens } from '../format'
import { formatLeft, formatPart } from '../limits'
import { maxRecent, subagentsOfRecord } from '../turns'
import { footerOf, NARROW_SUBAGENT_ROWS, NARROW_TOOL_ROWS, NARROW_TURN_ROWS, subagentsCardOf, thinkingCardOf, toolsCardOf, TURN_ROW_PX, turnsCardOf } from './cards'
import { isPickingDrawn, isRoomyDrawn, setIsPickingDrawn, setIsRoomyDrawn } from './drawn'
import { barSvg, CARD_GAP_ROWS, CARD_TOP_ROWS, cardLook, clamp01, DESK, foldPlanOf, iconSvg, INK, lastTurnPartsOf, limitStretches, LINE_PX, NARROW_HEAD_ROWS, paceAlertOf, shownWindowsOf, SKIES, skyOf, tileSvg, WINDOW_TITLES } from './look'
import type { DesktopUi } from './look'
import { MIN_PINNED_ROWS, PANE_OVERHEAD, shownTurnOf } from './updates'

const reading = atom({ plugin: 'session-weather', key: 'reading' } as const, null)
const delta = atom({ plugin: 'session-weather', key: 'delta' } as const, null)
const limits = atom({ plugin: 'session-weather', key: 'limits' } as const, [])
const shares = atom({ plugin: 'session-weather', key: 'shares' } as const, [])
const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const subagentFigures = atom({ plugin: 'session-weather', key: 'subagentFigures' } as const, [])
const lastTurn = atom({ plugin: 'session-weather', key: 'lastTurn' } as const, null)
const autoCompact = atom({ plugin: 'session-weather', key: 'autoCompact' } as const, null)
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

// The pane on the desktop under WIDE_FROM columns, as the design's narrow
// layout draws it: the sky, the context and the windows in tiles, a warning
// where a window is on pace to run out, the last turn, the subagents, the
// thinking summary and its footer. Each read subscribes the drawing to its
// value.
export async function drawNarrowDesktop ($: EngineInterface, ui: DesktopUi, columns: number, rows: number) {
  const { Box, Button, Svg, Text } = ui
  const [at, now, added, readings, parts, compactAt, turn, spent, listed, figured, known, counted, isOn] =
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
      read($, isSummaryOn),
    ])
  // The summary reads nothing while it is off: its updates redraw nothing.
  const [turnNow, place, summarySpent, isDebugging] = isOn
    ? await Promise.all([read($, thinking), read($, summaryPlace), read($, summaryCost), read($, isDebugOn)])
    : ([null, { line: 0, row: 0 }, 0, false] as const)
  // Its subagents' rows say how long each has run, to the minute.
  setIsRoomyDrawn(listed.length > 0)
  // The recent turns stand here too: with the summary on, one may be picked.
  setIsPickingDrawn(isOn)

  const windows = shownWindowsOf(readings, parts, at)
  const tokens = now?.tokens
  const percent = now?.percent
  const sky = skyOf(now, compactAt)
  const skyLook = sky === null ? undefined : SKIES[sky.label]
  const sessionLine = sessionParts(known, counted, null, at).join(' · ')

  const skyRow = (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {skyLook !== undefined && <Svg source={tileSvg(skyLook.icon, skyLook.ink, 40, 0.14)} alt={sky?.label ?? 'Sky'} width={40} height={40} />}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text size="heading" weight="semibold" color={sky?.color}>
          {sky?.label ?? 'Waiting for the first response'}
        </Text>
        {sessionLine !== '' && (
          <Text size="caption" dimColor wrap="truncate">
            {sessionLine}
          </Text>
        )}
      </Box>
      {spent !== null && (
        <Box flexDirection="column" alignItems="flex-end">
          <Text size="heading" weight="semibold" tabular>
            {formatCost(spent)}
          </Text>
          <Text size="caption" dimColor>
            session
          </Text>
        </Box>
      )}
    </Box>
  )

  // The context and each window in a tile of its own, side by side.
  const tileCount = 1 + windows.length
  const tileCells = Math.max(10, Math.floor((columns - (tileCount - 1)) / tileCount))
  const barCells = tileCells - 2
  const compactMark =
    now !== null && compactAt?.isEnabled === true && compactAt.threshold !== undefined && now.window > 0
      ? compactAt.threshold / now.window
      : undefined
  const compactWords =
    compactAt === null
      ? null
      : !compactAt.isEnabled
        ? 'auto-compact off'
        : compactAt.threshold === undefined || now === null
          ? null
          : `compact at ${Math.round((compactAt.threshold / now.window) * 100)}%`
  const tile = (label: string, value: string, bar: { source: string; height: number }, alt: string, lines: readonly (string | null)[]) => (
    <Box flexDirection="column" width={tileCells} paddingX={1} paddingY="xs" {...cardLook(DESK.card)}>
      <Text size="caption" weight="medium" dimColor>
        {label}
      </Text>
      <Text size="title" weight="medium" tabular>
        {value}
      </Text>
      <Svg source={bar.source} alt={alt} height={bar.height} />
      {lines
        .filter((line): line is string => line !== null)
        .map(line => (
          <Text size="caption" dimColor wrap="truncate">
            {line}
          </Text>
        ))}
    </Box>
  )
  const contextTile =
    tokens !== undefined && percent !== undefined && now !== null
      ? tile(
          'Context',
          `${percent}%`,
          barSvg([{ from: 0, to: clamp01(percent / 100), ink: INK.mine }], barCells, compactMark),
          `Context ${percent}% full`,
          [`${formatTokens(tokens)} / ${formatTokens(now.window)}`, compactWords],
        )
      : tile(
          'Context',
          '—',
          barSvg([], barCells, compactMark),
          'Context not measured yet',
          now?.isCompacted === true ? ['compacted', added === null ? null : formatDelta(added)] : ['waiting for a response'],
        )
  const tiles = (
    <Box flexDirection="row" gap={1}>
      {contextTile}
      {windows.map(window =>
        tile(
          WINDOW_TITLES[window.kind] ?? window.name,
          `${window.used}%`,
          barSvg(limitStretches(window), barCells),
          `${WINDOW_TITLES[window.kind] ?? window.name} ${window.used}% used${window.mine > 0 ? `, this session ${formatPart(window.mine)}` : ''}`,
          [window.mine > 0 ? `session ${formatPart(window.mine)}` : null, window.left === undefined ? null : `reset ${formatLeft(window.left)}`],
        ),
      )}
    </Box>
  )

  const alert = paceAlertOf(windows)
  const alertBox = alert !== null && (
    <Box flexDirection="row" alignItems="flex-start" gap={1} paddingX={1} paddingY="xs" {...cardLook(DESK.alert)}>
      <Svg source={iconSvg('warning', INK.red, 16)} alt="Warning" width={16} height={16} />
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text size="caption" color="error">
          {alert}
        </Text>
      </Box>
    </Box>
  )

  // "Last turn +11k · 1m 36s · 5 tools · cache 100%".
  const { grown, rest: lastParts } = lastTurnPartsOf(added, turn)
  const lastTurnChip = (grown !== null || lastParts.length > 0) && (
    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY="xs" {...cardLook(DESK.card)}>
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
  )

  // A body tall enough pins the cards and lets the lowest card open take
  // what is left, cut at the bottom; a shorter one scrolls whole, as the
  // engine does.
  const isPinned = isOn && rows >= MIN_PINNED_ROWS

  // Room is short under WIDE_FROM columns: one subagent at once, and the
  // current turn's tool calls three at once, unless the card takes what the
  // others leave.
  const [subagentAt, toolAt, turnAt, recent, folded, picked, isSaved] = await Promise.all([
    read($, subagentTop),
    read($, toolTop),
    read($, turnTop),
    read($, recentTurns),
    read($, foldedCards),
    isOn ? read($, pickedTurn) : null,
    read($, isSaving),
  ])

  // The recent turns, folded here unless the person opened them: pressed
  // while the summary runs, a turn shows in the cards under the weather, as
  // from WIDE_FROM columns.
  const view = isOn ? shownTurnOf(turnNow, picked, recent) : { turn: turnNow, isPast: false }
  const pastRow = view.isPast ? recent.find(one => one.turnId === view.turn?.turnId) : undefined
  const cardOf = pastRow === undefined ? { listed, figured, more: 0 } : subagentsOfRecord(pastRow, listed, figured)
  const callsRow = pastRow ?? recent.at(-1)
  const turnsFolded = !folded.includes('narrowTurns')
  const turnsShownCount = Math.min(recent.length, maxRecent(), NARROW_TURN_ROWS)
  const turnsCard = turnsCardOf($, ui, {
    recent,
    isOn,
    shownId: isOn ? view.turn?.turnId : undefined,
    currentId: turnNow?.turnId,
    isSaved,
    foldName: 'narrowTurns',
    fold: { isFolded: turnsFolded, grows: false },
    rows: NARROW_TURN_ROWS,
    top: turnAt,
  })

  const plan = foldPlanOf({
    folded,
    isOn,
    room: isPinned ? rows - NARROW_HEAD_ROWS - (alert !== null ? 2 : 0) : null,
    subagents: { count: cardOf.listed.length, rows: NARROW_SUBAGENT_ROWS },
    tools: { count: callsRow?.calls?.length ?? 0, rows: NARROW_TOOL_ROWS },
    // The recent turns stand between the tools and the summary.
    taken:
      turnsShownCount === 0
        ? 0
        : CARD_GAP_ROWS + CARD_TOP_ROWS + (turnsFolded ? 0 : 2 + (turnsShownCount * TURN_ROW_PX) / LINE_PX),
  })
  const subagentsCard = subagentsCardOf(
    $,
    ui,
    cardOf.listed,
    cardOf.figured,
    at,
    columns,
    subagentAt,
    false,
    cardOf.more,
    plan.subagents.rows,
    plan.subagents.fold,
  )
  const toolsCard = toolsCardOf($, ui, callsRow, toolAt, plan.tools.rows, plan.tools.fold)
  // The turn shown, the current one unless one was picked; its text stands a
  // cell in from each side. Its arrows step through the turn shown.
  const thinkingCard =
    isOn &&
    thinkingCardOf($, ui, {
      turnNow,
      shown: view.turn,
      isPast: view.isPast,
      place,
      at,
      rows,
      cardColumns: columns - 2,
      isWide: true,
      overhead: PANE_OVERHEAD,
      isFolded: plan.isThinkingFolded,
    })

  const footer = footerOf($, ui, isOn, summarySpent, isDebugging)

  return (
    <Box flexDirection="column" gap="sm" {...(isPinned ? { height: rows } : {})}>
      {skyRow}
      {tiles}
      {alertBox}
      {lastTurnChip}
      {subagentsCard}
      {toolsCard}
      {turnsCard}
      {thinkingCard}
      {footer}
    </Box>
  )
}
