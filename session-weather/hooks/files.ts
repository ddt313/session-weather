// The mod's files under the Claude config folder: their paths, writes and
// deletes.

import type { EngineInterface, UiLogOptions } from 'claude-code'

const present = (value: string | undefined) => (value === undefined || value === '' ? undefined : value)

// Joined with the separator the base path is written with.
export const joinPath = (base: string, ...parts: string[]) => {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'

  return [base.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

// A folder of the mod's in the configuration directory as Claude Code finds
// it: the variable that moves it, else `.claude` in the home directory as
// Node reads it, the profile on Windows (where every process has
// OS=Windows_NT) and HOME elsewhere: a USERPROFILE that WSL passes on names
// the Windows profile, or no path of this host. Null where no directory is
// known.
export async function modFolder ($: EngineInterface, folder: readonly string[]) {
  const moved = present(await $.env.get('CLAUDE_CONFIG_DIR'))
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = isWindows
    ? (present(await $.env.get('USERPROFILE')) ?? present(await $.env.get('HOME')))
    : present(await $.env.get('HOME'))
  const dir = moved ?? (home === undefined ? undefined : joinPath(home, '.claude'))

  return dir === undefined ? null : joinPath(dir, ...folder)
}

// The name of the session's own file of a kind: its id, made safe.
export const fileNameOf = (sessionId: string, extension: string) => `${sessionId.replace(/[^\w.-]/g, '_')}.${extension}`

// A file of the session's own in a folder of the mod's, Markdown unless
// said; null where no directory is known.
export async function sessionFile ($: EngineInterface, folder: readonly string[], sessionId: string, extension = 'md') {
  const dir = await modFolder($, folder)

  return dir === null ? null : joinPath(dir, fileNameOf(sessionId, extension))
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A line to the transcript, or where `options` sends it; lost where it
// cannot go, the mod going on without it.
export function tell($: EngineInterface, text: string, options?: UiLogOptions) {
  try {
    $.ui.log(text, options)
  } catch {
    // The line is lost.
  }
}

// Writes the session's file in `folder` whole, with what `change` makes of
// the text it holds ('' while there is none). A file there that cannot be
// read is left as it is, not written over.
export async function rewrite (
  $: EngineInterface,
  folder: readonly string[],
  change: (text: string, sessionId: string) => string | Promise<string>,
) {
  const sessionId = await $.session.id()
  const path = await sessionFile($, folder, sessionId)

  if (path === null) return

  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, await change(text, sessionId))
}

// Files of the mod's deleted at most this many to a command.
const DELETE_BATCH = 50

// Deletes the files at `paths`, all of them the mod's own. Its file API
// deletes nothing, so a command of the host's does: PowerShell on Windows,
// which reads the paths on its input, never from a command line a path's
// `&` or space could break; rm elsewhere, run with no shell. A file already
// gone is no error. Resolves whether every command ran clean.
export async function deleteFiles ($: EngineInterface, paths: readonly string[]) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  let isClean = true

  for (let at = 0; at < paths.length; at += DELETE_BATCH) {
    const batch = paths.slice(at, at + DELETE_BATCH)
    const { exitCode } = isWindows
      ? await $.process.run(
          [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$input | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }',
          ],
          { stdin: batch.join('\n') },
        )
      : await $.process.run(['rm', '-f', '--', ...batch])

    if (exitCode !== 0) isClean = false
  }

  return isClean
}
