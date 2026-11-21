// The desktop pane's look: its fills, inks, icons, chips and bars drawn as
// Svg, and the folding of its cards.

import type { ElementTable, EngineInterface } from 'claude-code'
import type { AutoCompact, LastTurn, Limit, Reading, Share, SubagentFigures } from '../../types'
import { forecast, formatDuration, formatTokens, modelNameOf, plural } from '../format'
import { formatLeft, levelOf, liveWindows, PACE_FROM } from '../limits'
import { foldCard } from '../prefs'
import type { Folding } from '../prefs'

// ---------------------------------------------------------------------------
// The desktop pane, laid out as the design "Session Weather layouts" draws
// it: cards on a fill of their own, its bars and icons drawn as Svg. The
// terminal draws no Svg and keeps the rows of text the hook draws below; so,
// for now, does a desktop pane WIDE_FROM columns wide.

// Fills the desktop draws cards with: neutral greys with alpha over the
// pane's ground, which read on a dark theme and a light one alike, and the
// warning's red. The mod cannot read the person's theme; text takes the
// theme's own colors, by name. The alphas are set so that on the desktop's
// dark pane (#191919, measured) a card is the design's #242424, a row raised
// in it (a subagent at work, the turn shown) #2E2E2E, and a chip on it
// (`Done`, `2 at work`) #333333: each fill lies over the card's, and the
// desktop rounds each alpha to a 255th, which a card's 0.1 sat on the edge of.
export const DESK = {
  card: 'rgba(128, 128, 128, 0.105)',
  raised: 'rgba(128, 128, 128, 0.11)',
  chip: 'rgba(128, 128, 128, 0.165)',
  alert: 'rgba(227, 27, 35, 0.14)',
} as const

// A card's look: its fill, and a border of no color with round corners. The
// API names no corner radius, but the desktop draws a round border with
// rounded corners, and rounds the card's fill with it. The border's color
// is spelled as the fills are: the desktop knows no name `transparent`, and
// drew a border of its own for it.
const NO_INK = 'rgba(0, 0, 0, 0)'

export const cardLook = (fill: string) => ({ backgroundColor: fill, borderStyle: 'round', borderColor: NO_INK })

// Colors inside an Svg, which the theme never reaches: tones that read on
// either ground. This session's part takes the design's orange. On the dark
// pane's card, a bar's track is the design's #333333 (near its #3A3A3A on a
// raised row), and what other sessions used its #5C5C5C: `others` where it
// lies on the card, as a legend's swatch does, and `othersOnTrack` where it
// lies over a bar's track, which shows through it.
export const INK = {
  track: 'rgba(128, 128, 128, 0.165)',
  others: 'rgba(128, 128, 128, 0.61)',
  othersOnTrack: 'rgba(128, 128, 128, 0.53)',
  mine: '#F47920',
  sky: '#00AEEF',
  red: '#E5484D',
  amber: '#F5B731',
  grey: '#8A8A8A',
  hatch: 'rgba(227, 27, 35, 0.75)',
} as const

// The pixels a cell of the desktop pane holds across, about: its code font's
// advance. A bar is drawn BAR_STRETCH wider than its cells, and the surface
// squeezes it into its slot, so it fills the slot whatever the advance.
const CELL_PX = 8
const BAR_STRETCH = 1.3

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

// Stroke icons on a 24-unit grid.
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  cloud: '<path d="M7 18.5h10a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.1 10.6 4 4 0 0 0 7 18.5z"/>',
  showers: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 14v6M12 16v6M16 14v6"/>',
  storm: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M13 11l-3 5h4l-3 5"/>',
  bolt: '<path d="M13 2L4.5 13.5H12L11 22l8.5-11.5H12z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.2-2.4 3.8M12 17h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warning: '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  fork: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><circle cx="12" cy="18.5" r="2.5"/><path d="M6 8v1.5A2.5 2.5 0 0 0 8.5 12h7A2.5 2.5 0 0 0 18 9.5V8M12 12v4"/>',
  loader: '<path d="M12 3a9 9 0 1 1-9 9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  terminal: '<path d="M4 6l5 6-5 6M12 18h8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6z"/>',
  // The left column's cards: what fills the context, stacked; a gauge for
  // the limits; the clock turned back for the recent turns.
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/><path d="M12 17h.01"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 3.5V8h4.5"/><path d="M12 8v4l3 2"/>',
} as const

type IconName = keyof typeof ICONS

// Its strokes about 1.75 pixels at any size.
const strokeOf = (pixels: number) => ((1.75 * 24) / pixels).toFixed(2)

// An icon `size` pixels square, in `ink`.
export const iconSvg = (name: IconName, ink: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="${strokeOf(size)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`

// The pixels a line of body text stands in on the desktop: its 14 pixels
// and the space above and below them.
export const LINE_PX = 20

// The thinking card's rule between two updates: a line a pixel thick in the
// middle of a drawing LINE_PX tall, squeezed or stretched across the card,
// in a grey that reads on a dark theme or a light one.
export const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${LINE_PX}" viewBox="0 0 400 ${LINE_PX}" preserveAspectRatio="none">` +
  `<rect y="${LINE_PX / 2}" width="400" height="1" fill="rgba(128, 128, 128, 0.35)"/></svg>`

// An icon `size` pixels square, in `ink`, standing in the middle of a box a
// line of text tall: set at the top of a row, beside words that may wrap, it
// sits level with their first line.
export const lineIconSvg = (name: IconName, ink: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${LINE_PX}" viewBox="0 0 ${size} ${LINE_PX}">` +
  `<g transform="translate(0 ${((LINE_PX - size) / 2).toFixed(1)}) scale(${(size / 24).toFixed(3)})" fill="none" stroke="${ink}" stroke-width="${strokeOf(size)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g></svg>`

// An icon on a faint square of its own ink, filled at `opacity`: a
// subagent's state, and the sky's, which the design fills a little fainter.
export const tileSvg = (name: IconName, ink: string, size: number, opacity = 0.16) => {
  const inner = size * 0.56
  const at = ((size - inner) / 2).toFixed(2)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${(size * 0.3).toFixed(1)}" fill="${ink}" fill-opacity="${opacity}"/>` +
    `<g transform="translate(${at} ${at}) scale(${(inner / 24).toFixed(3)})" fill="none" stroke="${ink}" stroke-width="${strokeOf(inner)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g></svg>`
  )
}

// Text written into an Svg, its markup's characters escaped.
const svgText = (text: string) =>
  text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)

// The width of `text` in the system face at `size` pixels, about: a narrow
// letter, a wide one, the rest.
const textPx = (text: string, size: number) =>
  [...text].reduce(
    (width, ch) => width + size * (/[\s.,:;'|!il1()[\]tfr]/.test(ch) ? 0.3 : /[A-Z%>mw@]/.test(ch) ? 0.68 : 0.55),
    0,
  )

// The warning as the wide layout's header draws it, a pill 32 pixels tall
// and round at both ends, as the design has it: its icon, then its words,
// the window's name and "limit" heavier, in a red that reads on a dark
// theme or a light one. Drawn whole, as a Box with a round border stands
// taller than the design's 32 pixels.
export const pillSvg = (words: string) => {
  const strong = /^\S+ limit/.exec(words)?.[0] ?? ''
  const rest = words.slice(strong.length).replace(/\.$/, '')
  const width = Math.ceil(12 + 14 + 8 + textPx(strong, 12) * 1.06 + textPx(rest, 12) + 14)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32" viewBox="0 0 ${width} 32">` +
    `<style>.w{fill:#B4232A;stroke:#B4232A}@media (prefers-color-scheme: dark){.w{fill:#FFB0B3;stroke:#FFB0B3}}</style>` +
    `<rect width="${width}" height="32" rx="16" fill="rgba(227, 27, 35, 0.14)"/>` +
    `<g class="w" transform="translate(12 9) scale(${(14 / 24).toFixed(3)})" fill="none" style="fill:none" stroke-width="${strokeOf(14)}" stroke-linecap="round" stroke-linejoin="round">${ICONS.warning}</g>` +
    `<text class="w" x="34" y="20" stroke="none" style="stroke:none" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="12">` +
    `<tspan font-weight="600">${svgText(strong)}</tspan>${svgText(rest)}</text></svg>`
  )
}

// A card's chip ("2 at work", "7 calls", "done"): its words on a grey pill
// 20 pixels tall, round at both ends, in Claude's orange (`isMine`) or a grey
// that reads on a dark theme or a light one. Drawn whole, as a Text's own
// fill has square corners and a Box's round border stands taller; and it
// never wraps.
const CHIP_PX = 20

const chipSvg = (words: string, isMine = false) => {
  const width = Math.ceil(textPx(words, 11) * 1.04 + 16)
  const ink = isMine
    ? `.c{fill:${INK.mine}}`
    : '.c{fill:#5E5E5E}@media (prefers-color-scheme: dark){.c{fill:#A8A8A8}}'

  return {
    width,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHIP_PX}" viewBox="0 0 ${width} ${CHIP_PX}">` +
      `<style>${ink}</style>` +
      `<rect width="${width}" height="${CHIP_PX}" rx="${CHIP_PX / 2}" fill="${DESK.chip}"/>` +
      `<text class="c" x="${width / 2}" y="14" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="11" font-weight="500">` +
      `${svgText(words)}</text></svg>`,
  }
}

// How a card that folds stands: folded to its top line, or open, and then
// whether it takes the height left in a pinned pane (the lowest card open).
export type CardFold = { isFolded: boolean; grows: boolean }

export const OPEN: CardFold = { isFolded: false, grows: false }

// A card's switch on its top line, first: ▾ while open, ▸ folded.
export function foldButtonOf($: EngineInterface, ui: DesktopUi, name: Folding, isFolded: boolean) {
  const { Button } = ui

  return (
    <Button
      key={`fold-${name}`}
      plain
      dimColor
      label={isFolded ? '▸' : '▾'}
      onPress={() => foldCard($, name).catch(() => {})}
    />
  )
}

// The body rows, about, that the desktop's parts stand in, a row a line of
// body text: a card's top line with its padding (a folded card's whole), a
// subagent's row, a tool call's, the footer and the gaps between cards.
export const CARD_TOP_ROWS = 2
const SUBAGENT_ROW_ROWS = 3.5
const TOOL_ROW_ROWS = 1.1
const FOOTER_ROWS = 2
export const CARD_GAP_ROWS = 0.5
// What stands above the cards: under WIDE_FROM columns the sky, the tiles
// and the last turn (a warning adds two); from them the header across the
// top.
export const NARROW_HEAD_ROWS = 10
export const WIDE_HEAD_ROWS = 3

// How the folding cards stand, and how many rows the subagents' and the
// tools' show: in a pinned pane (`room` the rows the cards and the footer
// have) the lowest card open takes the height the others leave, the
// thinking card's own way, the other two as many rows as fit, never fewer
// than they show at rest.
export const foldPlanOf = (plan: {
  folded: readonly string[]
  isOn: boolean
  room: number | null
  subagents: { count: number; rows: number }
  tools: { count: number; rows: number }
  // Rows other cards take in the column, not counted here.
  taken?: number
}) => {
  const isFolded = (name: Folding) => plan.folded.includes(name)
  const grower =
    plan.room === null
      ? null
      : plan.isOn && !isFolded('thinking')
        ? 'thinking'
        : !isFolded('tools')
          ? 'tools'
          : !isFolded('subagents')
            ? 'subagents'
            : null
  const subagentsHigh = isFolded('subagents')
    ? CARD_TOP_ROWS
    : CARD_TOP_ROWS + Math.max(1, Math.min(plan.subagents.rows, plan.subagents.count) * SUBAGENT_ROW_ROWS)
  // What the grower has: the room less the footer, the gaps, the thinking
  // card folded where it shows, and the other card above it, and its own
  // top line.
  const left =
    (plan.room ?? 0) -
    (plan.taken ?? 0) -
    FOOTER_ROWS -
    3 * CARD_GAP_ROWS -
    (plan.isOn ? CARD_TOP_ROWS : 0) -
    (grower === 'tools' ? subagentsHigh : CARD_TOP_ROWS) -
    CARD_TOP_ROWS

  return {
    subagents: {
      fold: { isFolded: isFolded('subagents'), grows: grower === 'subagents' },
      rows: grower === 'subagents' ? Math.max(plan.subagents.rows, Math.floor(left / SUBAGENT_ROW_ROWS)) : plan.subagents.rows,
    },
    tools: {
      fold: { isFolded: isFolded('tools'), grows: grower === 'tools' },
      rows: grower === 'tools' ? Math.max(plan.tools.rows, Math.floor(left / TOOL_ROW_ROWS)) : plan.tools.rows,
    },
    isThinkingFolded: isFolded('thinking'),
  }
}

// A card's title as the right column's cards stand theirs: its icon in
// Claude's orange, then its name, heavier.
export const cardTitleOf = (ui: DesktopUi, icon: IconName, title: string) => {
  const { Box, Svg, Text } = ui

  return (
    <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
      <Svg source={iconSvg(icon, INK.mine, 18)} alt={title} width={18} height={18} />
      <Text weight="semibold">{title}</Text>
    </Box>
  )
}

// What a card that grows takes on: the height left, cut at the bottom.
export const GROWS = { flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' as const }

// The chip as a card's top line places it, its words in its alt.
export const chipOf = (ui: DesktopUi, words: string, isMine = false) => {
  const { Box, Svg } = ui
  const chip = chipSvg(words, isMine)

  return (
    <Box flexShrink={0}>
      <Svg source={chip.source} alt={words} width={chip.width} height={CHIP_PX} />
    </Box>
  )
}

// A run along a bar, from and to as shares of its length (0 to 1), in an ink
// or, for a projection, the hatch.
export type Stretch = { from: number; to: number; ink: string }
export const HATCH = 'hatch'

// A bar `thick` pixels tall for a slot `cells` wide: its runs over a faint
// track, rounded at both ends, and, where `mark` is given (0 to 1), a mark
// standing across it; in the middle of a drawing `tall` pixels high where
// that is more, which holds a row it stands in to that height. Drawn
// BAR_STRETCH wider than the cells and squeezed into the slot, so it is
// drawn at the height it gives with the source.
export const barSvg = (stretches: readonly Stretch[], cells: number, mark?: number, thick = 6, tall = 0) => {
  const width = Math.max(40, Math.round(cells * CELL_PX * BAR_STRETCH))
  const height = Math.max(tall, mark === undefined ? thick : thick + 6)
  const top = (height - thick) / 2
  const runs = stretches
    .filter(one => one.to > one.from)
    .map(
      one =>
        `<rect x="${(one.from * width).toFixed(1)}" y="${top}" width="${((one.to - one.from) * width).toFixed(1)}" height="${thick}" fill="${one.ink === HATCH ? 'url(#h)' : one.ink}"/>`,
    )
    .join('')
  const marked =
    mark === undefined ? '' : `<rect x="${(clamp01(mark) * width - 1).toFixed(1)}" y="${top - 3}" width="2" height="${thick + 6}" fill="${INK.others}"/>`

  return {
    height,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
      `<defs><clipPath id="r"><rect y="${top}" width="${width}" height="${thick}" rx="${thick / 2}"/></clipPath>` +
      `<pattern id="h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="${INK.hatch}"/></pattern></defs>` +
      `<g clip-path="url(#r)"><rect y="${top}" width="${width}" height="${thick}" fill="${INK.track}"/>${runs}</g>${marked}</svg>`,
  }
}

// The sky's icon and its ink, by the forecast's label.
export const SKIES: Readonly<Record<string, { icon: IconName; ink: string }>> = {
  Clear: { icon: 'sun', ink: INK.amber },
  Cloudy: { icon: 'cloud', ink: INK.grey },
  Showers: { icon: 'showers', ink: INK.sky },
  Storm: { icon: 'storm', ink: INK.red },
  'Compact soon': { icon: 'bolt', ink: INK.red },
  Compacted: { icon: 'sun', ink: INK.amber },
}

// A window's name over its tile and in the warning.
export const WINDOW_TITLES: Readonly<Record<string, string>> = { five_hour: '5-hour', seven_day: 'Week' }

// A window as the tiles draw it: `liveWindows`' figures and this session's
// part of its share, in points.
type ShownWindow = ReturnType<typeof liveWindows>[number] & { mine: number }

export const shownWindowsOf = (readings: readonly Limit[], parts: readonly Share[], at: number): ShownWindow[] =>
  liveWindows(readings, at).map(window => ({
    ...window,
    mine: window.percent * (parts.find(part => part.kind === window.kind)?.ratio ?? 0),
  }))

// The sky as the desktop names it: the forecast from the fill, or that a
// compaction emptied it; null before the first reading.
export const skyOf = (now: Reading | null, compactAt: AutoCompact | null) =>
  now?.tokens !== undefined && now.percent !== undefined
    ? forecast(levelOf(now.tokens, now.percent, compactAt))
    : now?.isCompacted === true
      ? { label: 'Compacted', color: 'warning' }
      : null

// The last turn in a few parts: what it added to the context ("+11k"), and
// how long it ran, its tool calls and its cache rate.
export const lastTurnPartsOf = (added: number | null, turn: LastTurn | null) => ({
  grown: added === null ? null : added < 0 ? `-${formatTokens(-added)}` : `+${formatTokens(added)}`,
  rest: [
    turn === null ? null : `${formatDuration(turn.durationMs)}${turn.isAborted ? ' (interrupted)' : ''}`,
    turn === null ? null : plural(turn.tools, 'tool'),
    turn?.cacheRate === undefined ? null : `cache ${Math.round(turn.cacheRate * 100)}%`,
  ].filter((part): part is string => part !== null),
})

// Where the share used of a window stands at its reset at this pace, 0 to 1
// of it, from PACE_FROM of its time on; null before.
const projectedOf = (window: ShownWindow) =>
  window.elapsed === undefined || window.elapsed < PACE_FROM ? null : window.percent / window.elapsed / 100

// "Week limit on pace for >100% before it resets in 4d 17h.": the first
// window that at this pace would run out before it resets; null for none.
export const paceAlertOf = (windows: readonly ShownWindow[]) => {
  const over = windows.find(window => (projectedOf(window) ?? 0) > 1 && window.left !== undefined && !Number.isNaN(window.left))

  return over === undefined
    ? null
    : `${WINDOW_TITLES[over.kind] ?? over.name} limit on pace for >100% before it resets in ${formatLeft(over.left ?? 0)}.`
}

// A window's bar: what the account used beside this session, this session's
// part, and, where the pace says more by the reset, that much more hatched.
export const limitStretches = (window: ShownWindow): Stretch[] => {
  const used = clamp01(window.percent / 100)
  const mine = Math.min(used, Math.max(0, window.mine) / 100)
  const projected = Math.min(1, projectedOf(window) ?? 0)

  return [
    { from: 0, to: used - mine, ink: INK.othersOnTrack },
    { from: used - mine, to: used, ink: INK.mine },
    ...(projected > used ? [{ from: used, to: projected, ink: HATCH }] : []),
  ]
}

// A subagent's state as its row's tile shows it.
export const STATE_TILES: Readonly<Record<string, { icon: IconName; ink: string }>> = {
  pending: { icon: 'clock', ink: INK.mine },
  running: { icon: 'loader', ink: INK.mine },
  waiting: { icon: 'pause', ink: INK.mine },
  completed: { icon: 'check', ink: INK.grey },
  failed: { icon: 'cross', ink: INK.red },
  killed: { icon: 'stop', ink: INK.grey },
}

// How the desktop draws an update's lines after its gist: what Claude
// decided by a star in the accent, what it takes as true unchecked by a
// question in blue, and what it does next by an arrow, dim; each with the
// words a reader hears for its icon.
export const MARK_LOOKS: Readonly<
  Record<'decision' | 'assumption' | 'next', { icon: IconName; ink: string; color?: string; alt: string }>
> = {
  decision: { icon: 'star', ink: INK.mine, color: 'claude', alt: 'Decided' },
  assumption: { icon: 'question', ink: INK.sky, color: 'suggestion', alt: 'To check' },
  next: { icon: 'arrow', ink: INK.grey, alt: 'Next' },
}

// The icon of a tool call as `actionOf` words it: a file read or written, a
// search, a command, the web, or any other tool.
export const toolIconOf = (action: string): IconName => {
  const tool = action.split(':')[0] ?? ''

  if (/^(?:Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'file'
  if (/^(?:Grep|Glob|ToolSearch|LS)$/.test(tool)) return 'search'
  if (/^(?:Bash|PowerShell)$/.test(tool)) return 'terminal'
  if (/^(?:WebFetch|WebSearch)$/.test(tool)) return 'globe'

  return 'tool'
}

// "Opus 5.5 · high · ctx 38.2k": a desktop row's line under its task, the
// model of the subagent's latest request, the effort it asked for and,
// while it works, what its latest request carried; a part not seen left
// out. Its tokens stand on a line of their own.
export const figureMeta = (figure: SubagentFigures | undefined, isWorking: boolean) =>
  figure === undefined
    ? []
    : [
        figure.model === undefined ? null : modelNameOf(figure.model),
        figure.effort ?? null,
        isWorking && figure.context !== undefined ? `ctx ${formatTokens(figure.context)}` : null,
      ].filter((part): part is string => part !== null)

// The cells a subagent's lines under its own stand in by: its tile's width
// and the gap beside it.
export const ROW_INDENT = 5

export type DesktopUi = ElementTable<'desktop'>
