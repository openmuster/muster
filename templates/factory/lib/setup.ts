import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Step = { name: string; done: boolean; detail: string; fix?: string }

/** A path as people write it: the home directory is `~`. */
export const tilde = (path: string): string => {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * What a factory needs, checked against what is on this machine now: a watcher that wakes the agent,
 * a platform to hear from, and something running the two. Each step says what to run when it isn't done.
 */
export function setup(options: { config: string; board: string; channel: string }): Step[] {
  const watchersFile = join(options.config, 'watchers.json')
  const parsed = read(watchersFile) as { watchers?: { name?: string; tail?: { channel?: string }; run?: string[] }[] } | { name?: string }[] | null
  const watchers = Array.isArray(parsed) ? parsed : (parsed?.watchers ?? [])
  const watcher = (watchers as { name?: string; tail?: { channel?: string }; run?: string[] }[]).find((entry) => entry.tail?.channel === `${options.channel}/` || entry.tail?.channel === options.channel)
  const command = watcher?.run?.[0]
  const sync = read(join(options.config, 'sync.json')) as Record<string, { type?: string }> | null
  const platforms = Object.entries(sync ?? {}).map(([key, entry]) => `${key} (${entry.type ?? 'unknown'})`)
  const ticking = existsSync(`${options.board}.tick.lock`)
  return [
    {
      name: 'a watcher wakes the agent',
      done: watcher !== undefined && command !== undefined && (!command.startsWith('/') || existsSync(command)),
      detail: watcher ? (command && command.startsWith('/') && !existsSync(command) ? `"${watcher.name}" runs ${tilde(command)}, which isn't there` : `"${watcher.name}" on #${options.channel}/`) : `no watcher on #${options.channel}/ in ${tilde(watchersFile)}`,
      ...(watcher ? {} : { fix: `copy this template's watchers.json to ${tilde(watchersFile)} and give wake.sh its full path` }),
    },
    {
      name: 'a platform to hear from',
      done: platforms.length > 0,
      detail: platforms.length ? platforms.join(', ') : 'none: the factory hears only what is posted on the board',
      ...(platforms.length ? {} : { fix: `optional: copy sync.json to ${tilde(join(options.config, 'sync.json'))} and point the platform's webhook at /api/board/webhooks/<name>` }),
    },
    {
      name: 'the board is being served',
      done: ticking,
      detail: ticking ? 'a daemon or mu serve is running for this board' : 'nothing is sending schedules or running watchers',
      ...(ticking ? {} : { fix: 'mu serve   (or mu daemon run, without webhooks)' }),
    },
  ]
}
