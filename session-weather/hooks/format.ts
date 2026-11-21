// Numbers, times, durations and text, written the way the pane shows them.

import type { SubagentFigures } from '../types'
import { settings } from './settings'

// Monochrome text symbols, not emoji, so each draws one cell wide.
export const forecast = (percent: number) => {
  if (percent < 25) return { icon: '☀', label: 'Clear', color: 'warning' }
  if (percent < 50) return { icon: '☁', label: 'Cloudy', color: undefined }
  if (percent < 75) return { icon: '☂', label: 'Showers', color: 'permission' }
  if (percent < settings.compactAt) return { icon: '☇', label: 'Storm', color: 'error' }

  return { icon: 'ϟ', label: 'Compact soon', color: 'error' }
}

// Thousands or millions, the unit picked after the rounding: 999,960 reads
// 1M, not 1000k.
export const formatTokens = (n: number) =>
  n >= 999_950
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`

export const formatDelta = (n: number) => (n < 0 ? `▼ -${formatTokens(-n)}` : `▲ +${formatTokens(n)}`)

// "14s", "2m 14s", "1h 5m".
export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000)

  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`

  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

// "$1.23"; "<$0.01" for a cost under a cent, "$0.00" for none.
export const formatCost = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

// "1 note", "3 notes".
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// "Fable 5.2" for the id `claude-fable-5-2`, a date or a mark after it left
// out; a model the engine names some other way stays as named.
export const modelNameOf = (model: string) => {
  const id = /^claude-([a-z]+)-(\d+)-(\d+)\b/i.exec(model)

  if (id === null) return model

  const [, family = '', major = '', minor = ''] = id

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const SECOND = 1000

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export const pad = (n: number) => String(n).padStart(2, '0')

// "2026-11-06 14:32 UTC+07:00": the host's time, its offset said.
export const formatWhen = (ms: number) => {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
  ].join(' ')
}

// "14:32", the host's time.
export const formatTime =(ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

// What a subagent's requests read and wrote, its own subagents' included.
export const tokensOf = (figure: SubagentFigures | undefined) => (figure === undefined ? 0 : figure.tokens + (figure.nested ?? 0))
