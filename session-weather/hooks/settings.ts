// The pane's names and the person's settings, read from the manifest's
// `userConfig` fields.

import type { ConfigValue, PluginOptions } from 'claude-code'

export const COMMAND = 'session-weather'
// Turns the summary's debug log on and off.
export const DEBUG_COMMAND = 'session-weather-debug'
export const PANE = 'session-weather'
export const TITLE = 'Session Weather'
// The rows the pane asks for where it sits inline above the prompt (the
// terminal's main screen); a dock beside the transcript ignores it.
export const PANE_ROWS = 12

// The person's settings: the manifest's `userConfig` fields, each a row in
// `/config`. The language Haiku writes the thinking summary in, the seconds
// between its requests, how far toward compaction (`levelOf`) the forecast
// turns to Compact soon and the toast warns, the days after which the mod's
// files not written since are deleted (`cleanUp`), and how many recent turns
// the wide layout keeps. A load reads them as `register` begins, and a
// change in `/config` reloads the mod with the new values, so it takes
// effect at once.
//
// A value of the right type outside its range is held to the range, here
// and as it is set in `/config`, never refused: the manifest declares no
// `min` or `max`, which would stop the whole mod from loading over a typo in
// settings.json.
type Settings = { language: string; gapSeconds: number; compactAt: number; cleanupDays: number; recentTurns: number }

const DEFAULT_LANGUAGE = 'English'
// Room for any language's name; a longer value is cut.
const MAX_LANGUAGE = 40
// Under 5 seconds a typo would ask Haiku nearly every tick (each second);
// over 120, three gaps (`maxSilence`) would leave the pane silent for more
// than six minutes while notes wait.
const GAP_SECONDS = { fallback: 15, min: 5, max: 120 }
// The bands under it stay where they are: under 76 it would swallow Storm,
// from 75, whole, so a lower value counts as 76.
const COMPACT_SOON = { fallback: 90, min: 76, max: 100 }
// 0 keeps every file; ten years is as good as forever.
const CLEANUP_DAYS = { fallback: 30, min: 0, max: 3650 }
// Each turn keeps up to its newest 100 updates, 30 subagents and 100 tool
// calls, in `$.state` and in a persisted session's file, which the file API
// holds under 4 MiB: thirty turns of them all, some 70 KB a turn, stay
// within it. The list scrolls, so it keeps all thirty unless set lower.
const RECENT_TURNS = { fallback: 30, min: 1, max: 30 }

// The language named, on one trimmed line; the default where none is.
const languageOf = (value: unknown) => {
  const named = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LANGUAGE).trim() : ''

  return named === '' ? DEFAULT_LANGUAGE : named
}

// A whole number held to `range`; its fallback where the value is no number.
const numberIn = (value: unknown, range: { fallback: number; min: number; max: number }) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, Math.round(value)))
    : range.fallback

// Each setting by its manifest field, and how a value given for it is held
// to what the mod uses.
const FIELDS: Record<string, (value: unknown) => string | number> = {
  summaryLanguage: languageOf,
  summaryGapSeconds: value => numberIn(value, GAP_SECONDS),
  compactSoonPercent: value => numberIn(value, COMPACT_SOON),
  cleanupDays: value => numberIn(value, CLEANUP_DAYS),
  recentTurns: value => numberIn(value, RECENT_TURNS),
}

// The settings in `options`, a field left out or of the wrong type at its
// default.
export const settingsOf = (options: PluginOptions): Settings => ({
  language: languageOf(options.summaryLanguage),
  gapSeconds: numberIn(options.summaryGapSeconds, GAP_SECONDS),
  compactAt: numberIn(options.compactSoonPercent, COMPACT_SOON),
  cleanupDays: numberIn(options.cleanupDays, CLEANUP_DAYS),
  recentTurns: numberIn(options.recentTurns, RECENT_TURNS),
})

// The settings this load runs with; `register` takes them first. The
// module's own: the defaults until then.
export let settings = settingsOf({})
export const setSettings = (value: typeof settings) => {
  settings = value
}

// The setting a `/config` row's key names, `session-weather.<field>`, the
// plugin's name with or without its marketplace; undefined for any other row.
const SETTING_KEY = /^session-weather(?:@[^.]+)?\.(\w+)$/

export const settingFieldOf = (key: string) => {
  const field = SETTING_KEY.exec(key)?.[1]

  return field !== undefined && field in FIELDS ? field : undefined
}

// A value set for one of the settings, held as a load holds it: a number to
// its range, a language to one trimmed line. A value of another kind goes on
// as it came, for the engine to refuse.
export const heldValue = (field: string, value: ConfigValue): ConfigValue => {
  const hold = FIELDS[field]
  const isText = field === 'summaryLanguage'

  if (hold === undefined || typeof value !== (isText ? 'string' : 'number')) return value

  return hold(value)
}

// Whether the summary's language is Vietnamese, by any of its usual names:
// the pane's few words about the summary (`statusOf`) follow it there, and
// are English otherwise, as the rest of the pane is.
export const isVietnamese = (language: string) => /^(?:vietnamese|tiếng việt|tieng viet|vi(?:-vn)?)$/iu.test(language)
