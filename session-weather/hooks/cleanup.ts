// Deletes the mod's files not written for the days the settings name.

import type { EngineInterface } from 'claude-code'
import { DEBUG_FOLDER } from './debug'
import { deleteFiles, fileNameOf, joinPath, modFolder, tell } from './files'
import { DAY, plural } from './format'
import { LOG_FOLDER } from './log'
import { settings } from './settings'
import { SPEND_FOLDER } from './spend'
import { TURNS_FOLDER } from './turns'

// The folders the mod writes its files in, which the clean-up keeps within
// the setting's days: the thinking and debug logs, the spend files and the
// saved turns.
const KEPT_FOLDERS = [LOG_FOLDER, DEBUG_FOLDER, SPEND_FOLDER, TURNS_FOLDER] as const

// When this module last looked for old files: once a day at most, and a
// reload, its own, looks again.
let cleanedAt = Number.NEGATIVE_INFINITY

// Deletes the mod's files that nothing has written for the setting's days
// (30 unless set; 0 keeps them all): each session's logs, spend and saved
// turns, by when its file was last written. The session's own files stay.
// Only files of the mod's kinds, in its own folders, never a link.
export async function cleanUp ($: EngineInterface) {
  const now = await $.clock.now()

  if (settings.cleanupDays === 0 || now - cleanedAt < DAY) return

  cleanedAt = now
  const sessionId = await $.session.id()
  const own = new Set([fileNameOf(sessionId, 'md'), fileNameOf(sessionId, 'json')])
  const before = now - settings.cleanupDays * DAY
  const old: string[] = []

  for (const folder of KEPT_FOLDERS) {
    const dir = await modFolder($, folder)
    const entries = dir === null ? [] : await $.fs.list(dir).catch(() => [])

    for (const entry of entries) {
      const isOld = entry.kind === 'file' && !entry.isLink && entry.mtimeMs < before
      const isKind = /\.(?:md|json)$/.test(entry.name) && !own.has(entry.name)

      if (dir !== null && isOld && isKind) old.push(joinPath(dir, entry.name))
    }
  }

  if (old.length > 0 && !(await deleteFiles($, old))) {
    tell($, `Session Weather: not every file older than ${plural(settings.cleanupDays, 'day')} was deleted.`, {
      to: 'debug',
    })
  }
}
