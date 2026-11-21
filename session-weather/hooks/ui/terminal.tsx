// The terminal pane's look: its blocks in cards with a round border, as the
// desktop's stand on a fill of their own, and its bars as a Raster, a row of
// colored cells, as the desktop draws them in Svg.

import { clamp01, INK, SKIES } from './look'
import type { Stretch } from './look'

// A card on the terminal: a round border, dim in the theme's own text color
// so it reads on a dark theme or a light one, and a cell of room each side.
export const TERMINAL_CARD = {
  flexDirection: 'column',
  borderStyle: 'round',
  borderDimColor: true,
  paddingX: 1,
} as const

// The columns a card's border and padding take across, and the rows its
// border takes down.
export const CARD_INSET = 4
export const CARD_ROWS = 2

// Colors as the Raster packs them: 0x00RRGGBB, or the terminal's own.
const DEFAULT_INK = 0x01000000

const rgbOf = (hex: string) => Number.parseInt(hex.replace('#', ''), 16)

// The bar's inks on the terminal, which knows no alpha: the track a grey
// darker than what other sessions used, this session's part in the theme's
// yellow as its words are, the projection hatched in red, a mark light.
export const BAR_INK = {
  track: 0x4a4a4a,
  others: 0x9a9a9a,
  mine: rgbOf(INK.amber),
  hatch: rgbOf(INK.red),
  mark: 0xd8d8d8,
} as const

// The glyphs: a heavy line for a run and the track, its left half where a
// run ends mid-cell, a dashed one for the projection, a bar across for a mark.
const GLYPH = { run: 0x2501, half: 0x2578, hatch: 0x254d, mark: 0x2503 } as const

// A run along the bar, from and to as shares of its length, in an ink or,
// for a projection, the hatch.
export type CellRun = { from: number; to: number; ink: number | 'hatch' }

// One cell as the bar draws it: its glyph and its ink.
export type BarCell = { glyph: string; ink: number }

// The bar `cells` wide: each cell takes the run its middle falls in, a run
// that covers only its left half drawn as a half line, the track elsewhere;
// each mark (0 to 1) stands across its cell.
export const barCellsOf = (cells: number, runs: readonly CellRun[], marks: readonly number[] = []): BarCell[] => {
  const shown = runs.filter(run => run.to > run.from)
  const out = Array.from({ length: cells }, (_, at): BarCell => {
    const middle = (at + 0.5) / cells
    const run = shown.find(one => one.from <= middle && middle < one.to)

    if (run !== undefined) {
      return run.ink === 'hatch'
        ? { glyph: String.fromCodePoint(GLYPH.hatch), ink: BAR_INK.hatch }
        : { glyph: String.fromCodePoint(GLYPH.run), ink: run.ink }
    }

    // A run ending in this cell's left half, past its first quarter.
    const half = shown.find(one => one.ink !== 'hatch' && one.to > at / cells + 0.25 / cells && one.to <= middle && one.from <= at / cells)

    return half !== undefined && half.ink !== 'hatch'
      ? { glyph: String.fromCodePoint(GLYPH.half), ink: half.ink }
      : { glyph: String.fromCodePoint(GLYPH.run), ink: BAR_INK.track }
  })

  for (const mark of marks) {
    out[Math.max(0, Math.min(cells - 1, Math.floor(clamp01(mark) * cells)))] = {
      glyph: String.fromCodePoint(GLYPH.mark),
      ink: BAR_INK.mark,
    }
  }

  return out
}

// The cells packed as a Raster takes them: per cell its code point, its ink
// and the terminal's own background, little-endian, in base64.
export const packCells = (cells: readonly BarCell[]) => {
  const words = new Uint32Array(cells.length * 3)

  cells.forEach((cell, at) => {
    words[at * 3] = cell.glyph.codePointAt(0) ?? 0x20
    words[at * 3 + 1] = cell.ink
    words[at * 3 + 2] = DEFAULT_INK
  })

  return base64Of(new Uint8Array(words.buffer))
}

// Standard padded base64, written out: the module's library types stop at
// ES2023, before `Uint8Array.prototype.toBase64`.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64Of = (bytes: Uint8Array) => {
  let out = ''

  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at] ?? 0
    const b = bytes[at + 1] ?? 0
    const c = bytes[at + 2] ?? 0
    const n = (a << 16) | (b << 8) | c

    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += at + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += at + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }

  return out
}

// The bar's props for a Raster of one row: its key, unique in the pane.
export const barRasterOf = (key: string, cells: number, runs: readonly CellRun[], marks: readonly number[] = []) => ({
  key,
  columns: cells,
  rows: 1,
  cells: packCells(barCellsOf(cells, runs, marks)),
})

// The ink of the context's bar by the sky, as the desktop's tile has it.
export const skyInkOf = (label: string | undefined) => {
  const ink = label === undefined ? undefined : SKIES[label]?.ink

  return ink === undefined ? BAR_INK.others : rgbOf(ink)
}

// A window's runs as the desktop's `limitStretches` lays them, in the
// terminal's inks.
export const cellRunsOf = (stretches: readonly Stretch[]): CellRun[] =>
  stretches.map(one => ({
    from: one.from,
    to: one.to,
    ink: one.ink === 'hatch' ? 'hatch' : one.ink === INK.mine ? BAR_INK.mine : BAR_INK.others,
  }))

// How many cells a bar takes: the card's width inside, as many as a Raster
// holds at most.
const BAR_MAX = 512

export const barWidthOf = (inner: number) => Math.max(10, Math.min(BAR_MAX, inner))
