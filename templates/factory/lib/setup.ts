import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Step = { name: string; done: boolean; detail: string; fix?: string }

/** A watcher as the board module declares it: its name, and what it listens for. */
export type Declared = { name: string; tail: { channel?: string } }

/** A platform the board module syncs with: its key and its type. */
export type Synced = { key: string; type: string }

/** Who holds each role on the board now, by its lease's name (`tick`, `sync`, `watch:<name>`): a holder ID, or null when nobody does. */
export type Holders = Record<string, string | null>

/** A path as people write it: the home directory is `~`. */
export const tilde = (path: string): string => {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** A lease holder as people read it: `machine:pid:random` is the machine and the process. */
export const holderName = (holder: string): string => {
  const [machine, pid] = holder.split(':')
  return pid ? `${machine} (pid ${pid})` : holder
}

const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The names in a watchers.json, in either of the shapes the daemon reads. */
const namesIn = (path: string): string[] => {
  const parsed = read(path) as { watchers?: { name?: string }[] } | { name?: string }[] | null
  const list = Array.isArray(parsed) ? parsed : (parsed?.watchers ?? [])
  return list.map((entry) => entry?.name).filter((name): name is string => typeof name === 'string')
}

/**
 * What a factory needs, checked against what runs now: the watcher `lib/board.ts` declares, run by a host
 * that holds its lease (`watch:<name>`); a platform to hear from, the module's sync, kept by a host that holds
 * `sync`; and a process holding the board's `tick` lease, which sends schedules. Each step says who holds its
 * role, or what to run when nobody does.
 */
export function setup(options: { config: string; channel: string; watchers: readonly Declared[]; sync: readonly Synced[]; holders: Holders }): Step[] {
  const watcher = options.watchers.find((entry) => entry.tail.channel === `${options.channel}/` || entry.tail.channel === options.channel)
  const watchersFile = join(options.config, 'watchers.json')
  // A watcher in watchers.json named like the module's would share its place on the board: start() refuses it.
  const clash = watcher && namesIn(watchersFile).includes(watcher.name)
  const runner = watcher ? (options.holders[`watch:${watcher.name}`] ?? null) : null
  const platforms = options.sync.map((entry) => `${entry.key} (${entry.type})`).join(', ')
  const syncer = options.holders.sync ?? null
  // A sync.json left from before is read by a daemon run without a module, which could take the sync lease with it.
  const syncFile = join(options.config, 'sync.json')
  const leftover = platforms.length > 0 && existsSync(syncFile)
  const ticker = options.holders.tick ?? null
  return [
    {
      name: 'a watcher wakes the agent',
      done: watcher !== undefined && runner !== null && !clash,
      detail: !watcher
        ? `no watcher on #${options.channel}/ in lib/board.ts`
        : clash
          ? `"${watcher.name}" is in lib/board.ts and in ${tilde(watchersFile)}: the host refuses to run both`
          : runner
            ? `"${watcher.name}" on #${options.channel}/, run by ${holderName(runner)}`
            : `"${watcher.name}" on #${options.channel}/ is declared, and nothing runs it`,
      ...(!watcher
        ? { fix: `declare one in lib/board.ts: watch: { ${options.channel}: { tail: { channel: '${options.channel}/' }, run } }` }
        : clash
          ? { fix: `remove "${watcher.name}" from ${tilde(watchersFile)}` }
          : runner
            ? {}
            : { fix: 'pnpm host   (node host.ts, in this folder)' }),
    },
    {
      name: 'a platform to hear from',
      done: platforms.length > 0 && syncer !== null && !leftover,
      detail: !platforms
        ? 'none: the factory hears only what is posted on the board'
        : leftover
          ? `${platforms} is in lib/board.ts, and ${tilde(syncFile)} is there too: a daemon without a module would sync that instead`
          : syncer
          ? `${platforms}, synced by ${holderName(syncer)}`
          : `${platforms} is declared, and nothing syncs it: no catch-up, nothing sent`,
      ...(!platforms
        ? { fix: "optional: declare one in lib/board.ts's sync, and point the platform's webhook at /api/board/webhooks/<key>" }
        : leftover
          ? { fix: `move what ${tilde(syncFile)} lists into lib/board.ts, and delete it` }
          : syncer
          ? {}
          : { fix: 'pnpm host   (node host.ts, in this folder, with the sync\'s secrets set)' }),
    },
    {
      name: 'the board is being served',
      done: ticker !== null,
      detail: ticker ? `tick held by ${holderName(ticker)}: a daemon or mu serve sends schedules` : 'nobody holds tick: nothing sends schedules',
      ...(ticker ? {} : { fix: 'mu daemon run --no-module   (host.ts runs this module)' }),
    },
  ]
}
