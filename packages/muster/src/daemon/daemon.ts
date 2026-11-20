import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { takeLock } from './lock.ts'
import { runWatcher, type Deps, type Watcher, type WatchState } from './watchers.ts'

export const watchersPath = () => join(configDir(), 'watchers.json')

/** The operator's watchers. A file that is missing means none; one that is wrong is a config error. */
export function loadWatchers(path = watchersPath()): Watcher[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { watchers?: unknown }).watchers
  if (!Array.isArray(list)) throw new Failure('invalid_config', `${path} needs a "watchers" array.`)
  const names = new Set<string>()
  return list.map((entry: Watcher, index) => {
    if (typeof entry?.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(entry.name)) throw new Failure('invalid_config', `Watcher ${index + 1} in ${path} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
    if (names.has(entry.name)) throw new Failure('invalid_config', `Two watchers in ${path} are named "${entry.name}".`)
    names.add(entry.name)
    if (!Array.isArray(entry.run) || entry.run.length === 0 || !entry.run.every((part) => typeof part === 'string')) throw new Failure('invalid_config', `Watcher "${entry.name}" needs "run": the command as an array of strings.`)
    return { name: entry.name, tail: entry.tail ?? {}, run: entry.run, ...(entry.gate ? { gate: entry.gate } : {}), ...(entry.as ? { as: entry.as } : {}), ...(entry.every !== undefined ? { every: entry.every } : {}), ...(Array.isArray(entry.env) ? { env: entry.env.map(String) } : {}) }
  })
}

const WATCHER_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'MUSTER_DIR', 'MUSTER_BOARD', 'MUSTER_CONFIG', 'MUSTER_URL']

/**
 * What a watcher's command starts with: built from nothing, then the few names above. The daemon holds
 * the platforms' secrets in its own environment, and what it wakes is often an agent reading text a
 * stranger wrote, so nothing else is passed on unless the watcher's config names it.
 */
export function watcherEnv(extra: Record<string, string>, allow: readonly string[] = [], from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...WATCHER_ENV, ...allow]) if (from[name] !== undefined) env[name] = from[name]!
  return { ...env, ...extra }
}

/** Runs a command to its end and keeps what it printed. A command that can't start counts as a failure. */
export const spawnCommand: Deps['spawn'] = (command, env, allow) =>
  new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { env: watcherEnv(env, allow), stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', () => resolve({ code: 127, stdout }))
    child.on('exit', (code) => resolve({ code, stdout }))
  })

export type DaemonOptions = {
  team: Board
  /** The lock file: one per board, shared with `mu serve`, so only one process ticks. */
  lock: string
  watchers: Watcher[]
  stop: AbortSignal
  log: (line: string) => void
  deps?: Partial<Deps>
  /** Milliseconds between ticks. A tick is cheap; a long sleep would only delay what is due. */
  interval?: number
}

/** One pass: send what is due, then run each watcher. Returns what it did, for logs and tests. */
export async function tickOnce(team: Board, watchers: Watcher[], states: Map<string, WatchState>, deps: Deps) {
  const schedules = await team.scheduleTick()
  await team.backend.syncTick()
  const watched: Record<string, Awaited<ReturnType<typeof runWatcher>>> = {}
  for (const watcher of watchers) {
    let state = states.get(watcher.name)
    if (!state) states.set(watcher.name, (state = { last: -Infinity, attempts: 0 }))
    watched[watcher.name] = await runWatcher(team, watcher, state, deps)
  }
  return { schedules, watched }
}

/**
 * The board's ticker: schedules and watchers, until told to stop. Returns 'held' at once when another
 * process already ticks for this board.
 */
export async function runDaemon(options: DaemonOptions): Promise<'stopped' | 'held'> {
  const lock = takeLock(options.lock)
  if (!lock) return 'held'
  const deps: Deps = { now: () => Date.now(), spawn: spawnCommand, ...options.deps }
  const states = new Map<string, WatchState>()
  try {
    while (!options.stop.aborted) {
      try {
        const did = await tickOnce(options.team, options.watchers, states, deps)
        for (const id of did.schedules.sent) options.log(`sent      schedule ${id}`)
        for (const id of did.schedules.skipped) options.log(`skipped   schedule ${id}`)
        for (const [name, result] of Object.entries(did.watched)) {
          if (result.woke.length) options.log(`woke      ${name}  ${result.woke.length}`)
          if (result.failed.length) options.log(`failed    ${name}  at ${result.failed[0]}`)
        }
      } catch (error) {
        options.log(`error     ${(error as Error).message}`)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, options.interval ?? 1000)
        function done() {
          clearTimeout(timer)
          options.stop.removeEventListener('abort', done)
          resolve()
        }
        options.stop.addEventListener('abort', done)
      })
    }
    return 'stopped'
  } finally {
    lock.release()
  }
}
