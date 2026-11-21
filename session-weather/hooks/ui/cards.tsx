// The desktop pane's cards: tools, subagents, thinking, recent turns and
// the footer.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { RecentTurn, Subagent, SubagentFigures, Thinking, TurnCall } from '../../types'
import { RECENT_TURNS_SHAPE } from '../atoms'
import { waitingFor } from '../entries'
import { formatDuration, formatGrowth, formatTime, formatTokens, plural, tokensOf } from '../format'
import { formatLeft } from '../limits'
import { SAVE_TOGGLE, TOGGLE } from '../prefs'
import type { Folding } from '../prefs'
import { STANDING, subagentOrder } from '../subagents'
import { formatSummaryCost, HAIKU_NAME } from '../summary/prompt'
import { setSummary, statusOf } from '../summary/run'
import { AT_WORK, maxRecent, setSaving, subagentsOfRecord, workingOf } from '../turns'
import { isPickingDrawn } from './drawn'
import { barSvg, CARD_GAP_ROWS, CARD_TOP_ROWS, cardLook, cardTitleOf, chipOf, clamp01, DESK, figureMeta, foldButtonOf, GROWS, iconSvg, INK, LINE_PX, lineIconSvg, MARK_LOOKS, OPEN, kindOf, ROW_INDENT, RULE_SVG, shownActionOf, STATE_TILES, swatchSvg, tileSvg, toolIconOf } from './look'
import type { CardFold, DesktopUi } from './look'
import { MIN_PINNED_ROWS, moveUpdates, pageStep, pickTurn, toNewest, widthOf, windowOf } from './updates'

const subagents = atom({ plugin: 'session-weather', key: 'subagents' } as const, [])
const subagentFigures = atom({ plugin: 'session-weather', key: 'subagentFigures' } as const, [])
const recentTurns = atom({ plugin: 'session-weather', key: 'recentTurns' } as const, [], { shape: RECENT_TURNS_SHAPE })
const pickedTurn = atom({ plugin: 'session-weather', key: 'pickedTurn' } as const, null)
const subagentTop = atom({ plugin: 'session-weather', key: 'subagentTop' } as const, 0)
const toolTop = atom({ plugin: 'session-weather', key: 'toolTop' } as const, 0)
const turnTop = atom({ plugin: 'session-weather', key: 'turnTop' } as const, 0)

// The subagents the desktop's card shows at once, from WIDE_FROM columns and
// under them, where room is short; ▲ and ▼ scroll the rest.
export const DESK_SUBAGENT_ROWS = 2
export const NARROW_SUBAGENT_ROWS = 1

// Moves the desktop card's window over the subagents `by` rows (negative
// toward the top), within those listed, the card showing `rows` at once. A
// top kept from a longer list is read as the last place the list has.
async function moveSubagents ($: EngineInterface, by: number, rows: number) {
  const [listed, figured, top, picked] = await Promise.all([
    read($, subagents),
    read($, subagentFigures),
    read($, subagentTop),
    pickedRecordOf($),
  ])
  // A turn picked from the list shows those it started.
  const count = picked === undefined ? listed.length : subagentsOfRecord(picked, listed, figured).listed.length
  const last = Math.max(0, count - rows)
  const to = Math.max(0, Math.min(last, Math.min(top, last) + by))

  // At either end a press has nothing to write, nothing to draw.
  if (to !== top) await update($, subagentTop, () => to)
}

// The row of the turn picked from the recent turns, where the pane shows
// one; undefined for the newest.
async function pickedRecordOf ($: EngineInterface) {
  if (!isPickingDrawn) return undefined

  const [picked, recent] = await Promise.all([read($, pickedTurn), read($, recentTurns)])

  return picked === null ? undefined : recent.find(one => one.turnId === picked)
}

// The tool calls the desktop's Tools card shows at once, from WIDE_FROM
// columns and under them; ▲ and ▼ scroll the rest.
export const DESK_TOOL_ROWS = 5
export const NARROW_TOOL_ROWS = 3

// Moves the Tools card's window over the shown turn's calls `by` rows
// (negative toward the newest), as `moveSubagents` does.
async function moveTools ($: EngineInterface, by: number, rows: number) {
  const [recent, top, picked] = await Promise.all([read($, recentTurns), read($, toolTop), pickedRecordOf($)])
  const count = (picked ?? recent.at(-1))?.calls?.length ?? 0
  const last = Math.max(0, count - rows)
  const to = Math.max(0, Math.min(last, Math.min(top, last) + by))

  if (to !== top) await update($, toolTop, () => to)
}

// The shown turn's calls by kind, largest first: how many of each, and what
// those of the main loop added to the context (`~` where a share, or a call
// with no figure, is in it). The bar stands by what they added once any has
// a figure, else by how many.
export const kindsOf = (calls: readonly TurnCall[]) => {
  const kinds = new Map<string, { name: string; ink: string; count: number; tokens: number; isRough: boolean }>()

  for (const call of calls) {
    const kind = kindOf(call.text)
    const one = kinds.get(kind.name) ?? { name: kind.name, ink: kind.ink, count: 0, tokens: 0, isRough: false }
    one.count += 1
    one.tokens += call.tokens ?? 0
    one.isRough ||= call.isShared === true || (call.tokens === undefined && call.agentId === undefined)
    kinds.set(kind.name, one)
  }

  const all = [...kinds.values()]
  const isByTokens = all.some(one => one.tokens > 0)
  const sizeOf = (one: (typeof all)[number]) => (isByTokens ? one.tokens : one.count)

  return { kinds: all.sort((a, b) => sizeOf(b) - sizeOf(a) || b.count - a.count), isByTokens, sizeOf }
}

// The bar of the calls' kinds, and its legend: "Files 4 · +12k".
const toolKindsOf = (ui: DesktopUi, calls: readonly TurnCall[]) => {
  const { Box, Svg, Text } = ui
  const { kinds, isByTokens, sizeOf } = kindsOf(calls)
  const total = kinds.reduce((sum, one) => sum + sizeOf(one), 0)
  let from = 0
  const stretches = kinds.map(one => {
    const run = { from, to: total === 0 ? from : Math.min(1, from + sizeOf(one) / total), ink: one.ink }
    from = run.to

    return run
  })
  const bar = barSvg(stretches, 40, undefined, 5)
  const what = isByTokens ? 'by what they added to the context' : 'by how many'

  return (
    <Box flexDirection="column" gap="xs">
      <Svg source={bar.source} alt={`The calls' kinds, ${what}`} height={bar.height} />
      <Box flexDirection="row" columnGap={2} rowGap="xs" flexWrap="wrap">
        {kinds.map(one => (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={swatchSvg(one.ink)} alt={one.name} width={12} height={8} />
            <Text size="caption" dimColor tabular>
              {one.tokens > 0 ? `${one.name} ${one.count} · ${formatGrowth(one.tokens, one.isRough)}` : `${one.name} ${one.count}`}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// The Tools card, beside the weather under the subagents: the shown turn's
// tool calls (its subagents' with them), how many it made in all, then a
// row for each of `rows`, newest first from `top`, ▲ and ▼ scrolling the
// rest: the tool's icon, the tool and what it was aimed at, the subagent
// that made it where one did, and its time into the turn. Drawn for a turn
// that made none too, which it says. Folded, its top line alone, with how
// many calls; growing, it takes the height left, `rows` sized to it.
export function toolsCardOf(
  $: EngineInterface,
  ui: DesktopUi,
  row: RecentTurn | undefined,
  top: number,
  rows = DESK_TOOL_ROWS,
  fold: CardFold = OPEN,
) {
  const { Box, Button, Svg, Text } = ui
  const calls = row?.calls ?? []
  const made = row?.tools ?? 0
  const canScroll = !fold.isFolded && calls.length > rows
  const first = Math.max(0, Math.min(top, calls.length - rows))
  const shown = fold.isFolded ? [] : [...calls].reverse().slice(first, first + rows)
  const more = row?.moreCalls ?? 0
  const labelOf = (agentId: string) => row?.subagents?.find(one => one.id === agentId)?.label ?? 'Subagent'

  return (
    <Box flexDirection="column" gap="xs" paddingX={1} paddingY="sm" {...cardLook(DESK.card)} {...(fold.grows ? GROWS : {})}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, 'tools', fold.isFolded)}
        <Svg source={iconSvg('tool', INK.mine, 18)} alt="Tools" width={18} height={18} />
        <Text weight="semibold">Tools</Text>
        {made > 0 && chipOf(ui, plural(made, 'call'))}
        {canScroll && <Box flexGrow={1} />}
        {canScroll && (
          <Box flexShrink={0}>
            <Text size="caption" dimColor tabular>
              {shown.length === 1 ? `${first + 1} of ${calls.length}` : `${first + 1}–${first + shown.length} of ${calls.length}`}
            </Text>
          </Box>
        )}
        {canScroll && <Button key="tools-up" plain dimColor label="▲" onPress={() => moveTools($, -1, rows).catch(() => {})} />}
        {canScroll && <Button key="tools-down" plain dimColor label="▼" onPress={() => moveTools($, 1, rows).catch(() => {})} />}
      </Box>
      {calls.length > 0 && !fold.isFolded && toolKindsOf(ui, calls)}
      {made === 0 && !fold.isFolded && (
        <Text size="caption" dimColor>
          No tools called in this turn
        </Text>
      )}
      {shown.map(call => (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={iconSvg(toolIconOf(call.text), INK.grey, 14)} alt={call.text.split(':')[0] ?? 'Tool'} width={14} height={14} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="caption" wrap="truncate">
              {shownActionOf(call.text)}
            </Text>
          </Box>
          {call.agentId !== undefined && (
            <Box flexShrink={2} minWidth={0}>
              <Text size="caption" dimColor wrap="truncate">
                {labelOf(call.agentId)}
              </Text>
            </Box>
          )}
          {row !== undefined && (
            <Text size="caption" dimColor tabular>
              {formatDuration(Math.max(0, call.at - row.startedAt))}
            </Text>
          )}
          {call.tokens !== undefined && (
            <Box flexShrink={0}>
              <Text size="caption" dimColor tabular>
                {formatGrowth(call.tokens, call.isShared === true)}
              </Text>
            </Box>
          )}
        </Box>
      ))}
      {more > 0 && !fold.isFolded && (!canScroll || first + shown.length >= calls.length) && (
        <Text size="caption" dimColor>
          {`and ${more} earlier not kept`}
        </Text>
      )}
    </Box>
  )
}

// The subagents' card, drawn for a turn that started none too, which it says:
// how many work and finished (with `showTotal`, the
// tokens of them all), then a row for each of `rows` from `top`, ▲ and ▼
// scrolling the rest: its state, its task, how long it has run (once ended,
// how long it ran), its model, effort and context, what it is at, and its
// tokens, with a bar of its share of all the subagents' tokens.
export function subagentsCardOf(
  $: EngineInterface,
  ui: DesktopUi,
  listed: readonly Subagent[],
  figured: readonly SubagentFigures[],
  at: number,
  columns: number,
  top: number,
  showTotal = false,
  more = 0,
  rows = DESK_SUBAGENT_ROWS,
  fold: CardFold = OPEN,
) {
  const { Box, Button, Svg, Text } = ui
  const working = workingOf(listed)
  const finished = listed.length - working
  const total = listed.reduce((sum, one) => sum + tokensOf(figured.find(figure => figure.id === one.id)), 0)
  const barCells = Math.max(10, columns - ROW_INDENT - 18)
  const canScroll = !fold.isFolded && listed.length > rows
  const first = Math.max(0, Math.min(top, listed.length - rows))
  const shown = fold.isFolded ? [] : subagentOrder(listed).slice(first, first + rows)

  return (
    <Box flexDirection="column" gap="xs" paddingX={1} paddingY="sm" {...cardLook(DESK.card)} {...(fold.grows ? GROWS : {})}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, 'subagents', fold.isFolded)}
        <Svg source={iconSvg('fork', INK.mine, 18)} alt="Subagents" width={18} height={18} />
        <Text weight="semibold">Subagents</Text>
        {working > 0 && chipOf(ui, `${working} at work`, true)}
        {finished > 0 && chipOf(ui, `${finished} finished`)}
        {((showTotal && total > 0) || canScroll) && <Box flexGrow={1} />}
        {/* Each caption on one line: what gives way is the space beside them. */}
        {showTotal && total > 0 && (
          <Box flexShrink={0}>
            <Text size="caption" dimColor tabular>
              {`${formatTokens(total)} tokens`}
            </Text>
          </Box>
        )}
        {canScroll && (
          <Box flexShrink={0}>
            <Text size="caption" dimColor tabular>
              {shown.length === 1 ? `${first + 1} of ${listed.length}` : `${first + 1}–${first + shown.length} of ${listed.length}`}
            </Text>
          </Box>
        )}
        {canScroll && (
          <Button key="subagents-up" plain dimColor label="▲" onPress={() => moveSubagents($, -1, rows).catch(() => {})} />
        )}
        {canScroll && (
          <Button key="subagents-down" plain dimColor label="▼" onPress={() => moveSubagents($, 1, rows).catch(() => {})} />
        )}
      </Box>
      {listed.length === 0 && !fold.isFolded && (
        <Text size="caption" dimColor>
          No subagents ran in this turn
        </Text>
      )}
      {shown.map(agent => {
          const isWorking = AT_WORK.has(agent.status)
          const figure = figured.find(one => one.id === agent.id)
          const look = STATE_TILES[agent.status] ?? { icon: 'loader' as const, ink: INK.mine }
          const standing = STANDING.get(agent.status) ?? agent.status
          const ran =
            agent.startedAt === undefined
              ? null
              : agent.endedAt === undefined
                ? formatLeft(Math.max(0, at - agent.startedAt))
                : formatDuration(Math.max(0, agent.endedAt - agent.startedAt))
          const meta = [
            ...(agent.status === 'running' ? [] : [`${standing.charAt(0).toUpperCase()}${standing.slice(1)}`]),
            ...figureMeta(figure, isWorking),
          ]
          const action = isWorking ? figure?.action : undefined
          const tokens = tokensOf(figure)
          const share = barSvg([{ from: 0, to: total > 0 ? tokens / total : 0, ink: isWorking ? INK.mine : INK.grey }], barCells)

          return (
            <Box flexDirection="column" paddingX={1} paddingY="xs" {...(isWorking ? cardLook(DESK.raised) : {})}>
              <Box flexDirection="row" alignItems="flex-start" gap={1}>
                <Svg source={tileSvg(look.icon, look.ink, 28)} alt={standing} width={28} height={28} />
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text weight="medium" dimColor={!isWorking} wrap="truncate">
                    {agent.label}
                  </Text>
                  {meta.length > 0 && (
                    <Text size="caption" dimColor wrap="truncate">
                      {meta.join(' · ')}
                    </Text>
                  )}
                </Box>
                {ran !== null && (
                  <Text size="caption" dimColor tabular>
                    {ran}
                  </Text>
                )}
              </Box>
              {action !== undefined && (
                <Box flexDirection="row" alignItems="center" gap={1} paddingLeft={ROW_INDENT}>
                  <Svg source={iconSvg(toolIconOf(action), INK.grey, 14)} alt={action.split(':')[0] ?? 'Tool'} width={14} height={14} />
                  <Text size="caption" dimColor wrap="truncate">
                    {action}
                  </Text>
                </Box>
              )}
              {tokens > 0 && (
                <Box flexDirection="row" alignItems="center" gap={1} paddingLeft={ROW_INDENT}>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Svg source={share.source} alt={`${Math.round((tokens / Math.max(1, total)) * 100)}% of the subagents' tokens`} height={share.height} />
                  </Box>
                  {/* On one line: the bar beside it gives way. */}
                  <Box flexShrink={0}>
                    <Text size="caption" dimColor={!isWorking} tabular>
                      {`${formatTokens(tokens)} tokens`}
                    </Text>
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}
      {more > 0 && !fold.isFolded && (
        <Text size="caption" dimColor>
          {`and ${more} more not kept`}
        </Text>
      )}
    </Box>
  )
}

// What the thinking card is drawn from: the current turn (for what its
// status line says), the turn the card shows (the current one, or beside the
// weather one picked from the recent turns) and whether it is a past one,
// where the updates' window stands, the time, the body's rows, the columns
// the card's text has, whether it stands beside the weather, and the rows
// above and below the window, about.
type ThinkingView = {
  turnNow: Thinking | null
  shown: Thinking | null
  isPast: boolean
  place: { line: number; row: number }
  at: number
  rows: number
  cardColumns: number
  isWide: boolean
  overhead: number
  // Folded to its top line by the person.
  isFolded?: boolean
  // What the summary has cost, and whether its debug log is on, for the
  // card's last line.
  spent: number
  isDebugging: boolean
}

// The summary's switch, on the Thinking card: on its last line while it
// runs, on its top line folded or off.
function summarySwitchOf($: EngineInterface, ui: DesktopUi, isOn: boolean) {
  const { Button } = ui

  return (
    <Button
      key={TOGGLE}
      variant="secondary"
      label={isOn ? 'Turn summary off' : 'Turn summary on'}
      onPress={() => setSummary($, !isOn).catch(() => {})}
    />
  )
}

// The Thinking card with the summary off: its top line alone, and the switch
// to turn it on. It stands where the card stands with the summary on, so
// turning it off or on moves no other card.
export function thinkingOffCardOf($: EngineInterface, ui: DesktopUi) {
  const { Box, Svg, Text } = ui

  return (
    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY="sm" {...cardLook(DESK.card)}>
      <Svg source={iconSvg('compass', INK.grey, 18)} alt="Thinking" width={18} height={18} />
      <Text weight="semibold">Thinking</Text>
      {chipOf(ui, 'Off')}
      <Box flexGrow={1} />
      {summarySwitchOf($, ui, false)}
    </Box>
  )
}

// The thinking card: the turn's updates as the terminal lists them, newest
// first, each its gist then what Claude decided (★), takes as true
// unchecked (?) and does next (→), a rule between two. Where the body is
// tall enough to pin it, they scroll in the card, ▲ and ▼ moving them about
// half the window a press, within the turn shown.
export function thinkingCardOf($: EngineInterface, ui: DesktopUi, view: ThinkingView) {
  const { Box, Button, Svg, Text } = ui
  const { shown, isPast } = view
  const isFolded = view.isFolded === true
  // Folded, it stands its top line high, and the card under it takes none
  // of the height: there is none.
  const isPinned = view.rows >= MIN_PINNED_ROWS && !isFolded
  // The lines measured at the card's width, the measure the arrows step
  // through.
  const width = widthOf(view.cardColumns, 'desktop')
  const laid = windowOf(shown, width, view.place, isPinned, view.rows)
  const { shown: groups, newer } = isFolded ? { shown: [], newer: 0 } : laid
  const canScroll = !isFolded && laid.canScroll
  const step = pageStep(view.rows, view.overhead)

  const title = shown !== null && isPast ? `Turn at ${formatTime(shown.startedAt)}` : 'Thinking'
  const took =
    shown === null
      ? null
      : isPast
        ? shown.durationMs === undefined
          ? null
          : formatDuration(shown.durationMs)
        : formatDuration(Math.max(0, shown.durationMs ?? view.at - shown.startedAt))
  const standing =
    shown === null
      ? null
      : shown.durationMs !== undefined
        ? shown.isAborted === true
          ? 'Interrupted'
          : 'Done'
        : shown.paused !== undefined
          ? waitingFor(shown.paused.subagents)
          : null
  const status = isFolded ? null : isPast ? (shown?.entries.length === 0 ? 'No updates on this turn.' : null) : statusOf(view.turnNow)
  // The rule between two updates: a hairline drawn across the card's whole
  // width, standing a line high as the updates' lines do. A row of ─ in the
  // app's font came out a little wider than the card and was cut with "…".
  const rule = (
    <Box flexGrow={1} minWidth={0}>
      <Svg source={RULE_SVG} alt="Between updates" height={LINE_PX} />
    </Box>
  )

  return (
    <Box
      flexDirection="column"
      gap="xs"
      paddingX={1}
      paddingY="sm"
      {...cardLook(DESK.card)}
      {...(isPinned ? { flexGrow: 1, flexShrink: 1, overflow: 'hidden' as const } : {})}
    >
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, 'thinking', isFolded)}
        <Svg source={iconSvg('compass', INK.mine, 18)} alt="Thinking" width={18} height={18} />
        <Text weight="semibold">{title}</Text>
        {took !== null && (
          <Text size="caption" dimColor tabular>
            {took}
          </Text>
        )}
        {standing !== null && chipOf(ui, standing)}
        {shown?.isSummarizing === true && (
          <Text size="caption" dimColor>
            summarizing…
          </Text>
        )}
        <Box flexGrow={1} />
        {canScroll && (
          <Button key="newer" plain dimColor label="▲" onPress={() => moveUpdates($, -step, width, view.isWide).catch(() => {})} />
        )}
        {canScroll && (
          <Button key="older" plain dimColor label="▼" onPress={() => moveUpdates($, step, width, view.isWide).catch(() => {})} />
        )}
        {isFolded && summarySwitchOf($, ui, true)}
      </Box>
      {status !== null && (
        <Text size="caption" dimColor>
          {status}
        </Text>
      )}
      {newer > 0 && (
        <Button
          key="newest"
          plain
          dimColor
          label={`↑ ${plural(newer, 'newer update')}`}
          onPress={() => toNewest($).catch(() => {})}
        />
      )}
      {groups.length > 0 && (
        <Box
          flexDirection="column"
          gap="xs"
          {...(isPinned ? { flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' as const } : {})}
        >
          {groups.flatMap((group, at) => [
            ...(at === 0 ? [] : [rule]),
            <Box flexDirection="column" gap="xs">
              {group.map(item => {
                // The gist: when it was written (or Recap), heavier, then
                // its words.
                if (item.kind === 'gist') {
                  const split = item.isCut ? -1 : item.words.indexOf(' · ')

                  if (split === -1) return <Text>{item.words}</Text>

                  const stamp = item.words.slice(0, split)

                  return (
                    <Text>
                      <Text weight="semibold">{stamp === 'Recap' ? 'Recap.' : `${stamp} ·`}</Text> {item.words.slice(split + 3)}
                    </Text>
                  )
                }

                // A decision, an assumption, the next step: its icon, then
                // its words in its color; none for a line shown part-way.
                const look = MARK_LOOKS[item.kind]

                return (
                  <Box flexDirection="row" alignItems="flex-start" gap={1}>
                    {item.isCut ? (
                      <Box width={2} />
                    ) : (
                      <Svg source={lineIconSvg(look.icon, look.ink, 14)} alt={look.alt} width={14} height={LINE_PX} />
                    )}
                    <Box flexDirection="column" flexShrink={1} minWidth={0}>
                      <Text {...(look.color === undefined ? { dimColor: true } : { color: look.color })}>{item.words}</Text>
                    </Box>
                  </Box>
                )
              })}
            </Box>,
          ])}
        </Box>
      )}
      {!isFolded && (
        <Box flexDirection="column" gap="xs" flexShrink={0}>
          <Box flexGrow={1} minWidth={0}>
            <Svg source={RULE_SVG} alt="Above the summary's cost" height={LINE_PX} />
          </Box>
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Text size="caption" dimColor wrap="truncate">
              {`Summary ${formatSummaryCost(view.spent)} · ${HAIKU_NAME}${view.isDebugging ? ' · debug log on' : ''}`}
            </Text>
            {summarySwitchOf($, ui, true)}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// The recent turns the narrow layout's card shows at once, open; ▲ and ▼
// scroll the rest. From WIDE_FROM columns it shows as many as fit. The
// terminal, which has no arrows for them, lists the newest ten.
export const NARROW_TURN_ROWS = 5
export const TERMINAL_TURN_ROWS = 10

// Moves the recent turns' window `by` turns (negative toward the newest),
// the card showing `rows` at once.
async function moveTurns ($: EngineInterface, by: number, rows: number) {
  const [recent, top] = await Promise.all([read($, recentTurns), read($, turnTop)])
  const last = Math.max(0, Math.min(recent.length, maxRecent()) - rows)
  const to = Math.max(0, Math.min(last, Math.min(top, last) + by))

  if (to !== top) await update($, turnTop, () => to)
}

// The rows a recent turn's row stands in, and the turns a pinned wide
// layout's card shows: the height its column has, less the context's card
// and the limits' over it (each folded or open, the context with a row a
// part of what fills it, the limits three a window and their legend), the
// gaps, its top line and the table's header, at TURN_ROW_PX a turn; never
// fewer than three.
export const wideTurnRowsOf = (fit: { room: number; isContextFolded: boolean; fills: number; isLimitsFolded: boolean; windows: number }) => {
  const turnRows = TURN_ROW_PX / LINE_PX
  const contextHigh = fit.isContextFolded ? CARD_TOP_ROWS : CARD_TOP_ROWS + 3 + fit.fills
  const limitsHigh = fit.windows === 0 ? 0 : fit.isLimitsFolded ? CARD_TOP_ROWS : CARD_TOP_ROWS + 3 * fit.windows + 1
  // Less the table's header over the rows and the Persist line under them.
  const left = fit.room - contextHigh - limitsHigh - 2 * CARD_GAP_ROWS - CARD_TOP_ROWS - 2

  return Math.max(3, Math.floor(left / turnRows))
}

// The recent turns, newest first, as a table: when each began and how long
// it ran (pressed while the summary runs to show it, the one shown marked ▸
// on a fill), what it added to the context over a bar beside the others',
// how many subagents it started, and its tool calls; and the person's switch
// for persisting them. The rows stand TURN_ROW_PX apart, with no gap between
// them. Folded, its top line alone, how many turns it keeps and the switch;
// growing, it takes the height the cards above it leave, cut at the bottom.
// Both of the desktop's layouts draw it, each folding it by a name of its own.
// It shows `rows` turns at once from `top` (all where `rows` is null), ▲ and
// ▼ on its top line scrolling the rest a turn a press.
export function turnsCardOf(
  $: EngineInterface,
  ui: DesktopUi,
  card: {
    recent: readonly RecentTurn[]
    isOn: boolean
    shownId: string | undefined
    currentId: string | undefined
    isSaved: boolean
    foldName: Folding
    fold: CardFold
    rows: number | null
    top: number
  },
) {
  const { Box, Button, Svg, Text } = ui
  const { recent, isOn, shownId, currentId, isSaved, foldName, fold } = card
  const turnsShown = recent.slice(-maxRecent()).reverse()
  // The bars beside one another across the whole list, scrolled or not.
  const mostGrown = Math.max(1, ...turnsShown.map(one => grownOf(one) ?? 0))
  const turnsFolded = fold.isFolded
  const rows = card.rows ?? turnsShown.length
  const canScroll = !turnsFolded && turnsShown.length > rows
  const first = Math.max(0, Math.min(card.top, turnsShown.length - rows))
  const visible = turnsShown.slice(first, first + rows)
  // The switch for keeping the turns past a restart: on the top line folded;
  // open, under the table, where the top line's arrows and their place in
  // the list leave it no room, the table giving way above it.
  const persist = (
    <Box flexShrink={0}>
      <Button
        key={SAVE_TOGGLE}
        plain
        dimColor={!isSaved}
        label={isSaved ? '☑ Persist' : '☐ Persist'}
        onPress={() => setSaving($, !isSaved).catch(() => {})}
      />
    </Box>
  )

  return turnsShown.length > 0 && (
    <Box
      flexDirection="column"
      gap="xs"
      paddingX={1}
      paddingY="sm"
      {...cardLook(DESK.card)}
      {...(fold.grows ? GROWS : {})}
    >
      <Box flexDirection="row" alignItems="center" gap={1}>
        {foldButtonOf($, ui, foldName, turnsFolded)}
        {cardTitleOf(ui, 'history', 'Recent turns')}
        {turnsFolded && (
          <Text size="caption" dimColor tabular>
            {plural(turnsShown.length, 'turn')}
          </Text>
        )}
        <Box flexGrow={1} />
        {canScroll && (
          <Box flexShrink={0}>
            <Text size="caption" dimColor tabular>
              {visible.length === 1
                ? `${first + 1} of ${turnsShown.length}`
                : `${first + 1}–${first + visible.length} of ${turnsShown.length}`}
            </Text>
          </Box>
        )}
        {canScroll && <Button key="turns-up" plain dimColor label="▲" onPress={() => moveTurns($, -1, rows).catch(() => {})} />}
        {canScroll && <Button key="turns-down" plain dimColor label="▼" onPress={() => moveTurns($, 1, rows).catch(() => {})} />}
        {turnsFolded && persist}
      </Box>
      {/* The header over the columns, the subagents and the tool calls by
          the icons their cards on the right carry. */}
      {!turnsFolded && (
      <Box flexDirection="row" alignItems="center" gap={1} paddingRight={1}>
        <Box width={TIME_CELLS + 1 + TOOK_CELLS} flexShrink={0}>
          <Text size="caption" dimColor wrap="truncate">
            Time · Duration
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="caption" dimColor wrap="truncate">
            Context added
          </Text>
        </Box>
        <Box width={AGENTS_CELLS} flexShrink={0} justifyContent="flex-end">
          <Svg source={iconSvg('fork', INK.grey, 14)} alt="Agents" width={14} height={14} />
        </Box>
        <Box width={TOOLS_CELLS} flexShrink={0} justifyContent="flex-end">
          <Svg source={iconSvg('tool', INK.grey, 14)} alt="Tools" width={14} height={14} />
        </Box>
      </Box>
      )}
      {!turnsFolded && (
      <Box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
        {visible.map((one, at) => {
          const isShown = isOn && one.turnId === shownId
          const time = formatTime(one.startedAt)
          // Its place in the whole list: the newest alone may still run.
          const index = first + at
          const took =
            one.durationMs !== undefined
              ? formatDuration(one.durationMs)
              : index === 0 && one.isAborted !== true
                ? one.isWaiting === true
                  ? 'waiting'
                  : 'running'
                : '—'
          const ran = `${took}${one.isAborted === true ? ' · interrupted' : ''}`
          const added = grownOf(one)
          // The subagents it started, those past the ones kept with them;
          // none leaves the cell blank, so the turns that ran some stand out.
          const started = (one.subagents?.length ?? 0) + (one.moreSubagents ?? 0)
          const growth = barSvg(
            [{ from: 0, to: added === null ? 0 : clamp01(added / mostGrown), ink: isShown ? INK.mine : INK.grey }],
            12,
            undefined,
            6,
            TURN_ROW_PX,
          )

          // The shown turn's fill lies under its row, placed over the row's
          // whole box: the round border that rounds it takes room inside the
          // Box it is on, which on the row itself made the row taller. The
          // row's parts are placed too, so they are painted over the fill.
          return (
            <Box position="relative" flexDirection="row" alignItems="center" gap={1} paddingRight={1}>
              {isShown && <Box position="absolute" top={0} bottom={0} left={0} right={0} {...cardLook(DESK.raised)} />}
              <Box position="relative" width={TIME_CELLS + 1 + TOOK_CELLS} flexShrink={0}>
                {isOn ? (
                  <Button
                    key={`turn-${one.turnId}`}
                    plain
                    dimColor={!isShown}
                    onPress={() => pickTurn($, one.turnId === currentId ? null : one.turnId).catch(() => {})}
                  >
                    {`${isShown ? '▸ ' : ''}${time}  `}
                    <Text>{ran}</Text>
                  </Button>
                ) : (
                  <Text dimColor wrap="truncate">
                    {`${time}  ${ran}`}
                  </Text>
                )}
              </Box>
              <Box position="relative" flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Svg source={growth.source} alt={added === null ? 'Context added not known' : `Added ${formatTokens(Math.abs(added))}`} height={growth.height} />
                </Box>
                <Box width={ADDED_CELLS} flexShrink={0} justifyContent="flex-end">
                  <Text size="caption" dimColor={!isShown} tabular>
                    {added === null ? '—' : added < 0 ? `-${formatTokens(-added)}` : `+${formatTokens(added)}`}
                  </Text>
                </Box>
              </Box>
              <Box position="relative" width={AGENTS_CELLS} flexShrink={0} justifyContent="flex-end">
                {started > 0 && (
                  <Text size="caption" dimColor={!isShown} tabular>
                    {`${started}`}
                  </Text>
                )}
              </Box>
              <Box position="relative" width={TOOLS_CELLS} flexShrink={0} justifyContent="flex-end">
                <Text size="caption" dimColor={!isShown} tabular>
                  {`${one.tools}`}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
      )}
      {!turnsFolded && persist}
    </Box>
  )
}

// The cells of the wide layout's left column, the design's 344 pixels; and,
// in its table of recent turns, the cells of the time, the duration, the
// tokens added, the subagents and the tool calls. Each column but the bar's
// is held to its width (never shrunk), so every row's bar has the same track
// and the figures stand under their headers.
export const LEFT_CELLS = 43
const TIME_CELLS = 7
const TOOK_CELLS = 6
const ADDED_CELLS = 6
const AGENTS_CELLS = 4
const TOOLS_CELLS = 4

// The height of a row of the recent turns, the design's 32 pixels: the
// row's bar stands in a drawing that tall, which holds the row to it.
export const TURN_ROW_PX = 32

// The tokens a recent turn added to the context, where both ends are known.
const grownOf = (one: RecentTurn) =>
  one.fromTokens === undefined || one.toTokens === undefined ? null : one.toTokens - one.fromTokens
