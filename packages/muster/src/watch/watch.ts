import { Failure } from '../failure.ts'
import { channelScope, forName, kindsValid, labelFilter, profileName } from '../model.ts'
import type { Task } from '../core/tasks.ts'
import type { FeedEvent, Filter } from '../core/reads.ts'
import type { Board } from '../handle.ts'
import type { Message } from '../model.ts'

type MessageType = 'message.posted' | 'message.edited' | 'message.deleted'
type TaskType = 'task.created' | 'task.ready' | 'task.claimed' | 'task.renewed' | 'task.released' | 'task.expired' | 'task.blocked' | 'task.completed' | 'task.failed' | 'task.canceled' | 'task.reopened' | 'task.assigned' | 'task.needs_changed' | 'task.waiting' | 'task.extended'
type OtherType = 'channel.created' | 'labels.changed' | 'reaction.added' | 'reaction.removed' | 'schedule.created' | 'schedule.canceled' | 'schedule.skipped' | 'schema.registered' | 'budget.set' | 'sync.delivered'

/**
 * An event as a watcher gets it: exactly what `mu tail --json` prints for it, narrowed by `type`. A
 * message event carries its message as it is now (a tombstone once deleted), a task event its task.
 */
export type WatchEvent =
  | (Omit<FeedEvent, 'type' | 'message' | 'task'> & { type: MessageType; message: Message; task?: undefined })
  | (Omit<FeedEvent, 'type' | 'message' | 'task'> & { type: TaskType; task: Task; message?: undefined })
  | (Omit<FeedEvent, 'type' | 'message' | 'task'> & { type: OtherType; message?: undefined; task?: undefined })

/** A length of time: milliseconds, or `500ms`, `30s`, `5m`, `1h`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h'}`

/** What a watcher is handed each time it runs. */
export type WatchContext = {
  /** The event that woke it. With `coalesce`, the newest of its thread's events since the last run. */
  event: WatchEvent
  /**
   * The board, writing as the watcher's `as` profile when it has one. Its writes are keyed by the event,
   * so a retry after a throw doesn't write them twice; once the run is aborted it refuses to write.
   */
  board: Board
  /** Aborts when the run's `timeout` is up: stop, and write nothing more. */
  signal: AbortSignal
  /** Which watcher this is, and the profile it writes as. */
  watcher: { name: string; as: string | null }
  /** Which try this is for this event: 1, then up to 5. */
  attempt: number
}

/**
 * A watcher declared in code beside the board: what it listens for, and what it does. It runs where
 * the board's file is, one host at a time, from the moment it is first started: what was on the board
 * before wakes nothing.
 */
export type Watch = {
  /** What to listen for: a filter like `mu tail`'s. */
  tail: Filter
  /** Called once for each event that matches. A throw is a failed delivery, tried again. */
  run: (context: WatchContext) => unknown
  /** The profile it writes as. Its own writes never wake it; a message it scheduled does. */
  as?: string
  /** How long one run may take before it is aborted and counted as failed. Default `60s`. */
  timeout?: Duration
  /**
   * Gathers a thread's events: once its oldest undelivered event is this old, the run gets the newest
   * of them, once, standing for the rest. For a watcher that wakes an agent who reads the thread itself.
   */
  coalesce?: Duration
}

/** A watcher as `board()` checked it: its name beside it, its lengths of time in milliseconds. */
export type Watcher = Omit<Watch, 'timeout' | 'coalesce'> & { name: string; timeout: number; coalesce?: number }

export const DEFAULT_TIMEOUT = 60_000
const DAY = 86_400_000
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** A length of time in milliseconds, or null when it isn't one. */
export function millis(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  const match = typeof value === 'string' ? /^(\d+)(ms|s|m|h)$/.exec(value) : null
  return match ? Number(match[1]) * UNITS[match[2]!]! : null
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const WATCH_KEYS = new Set(['tail', 'run', 'as', 'timeout', 'coalesce'])
const FILTER_KEYS = new Set(['channel', 're', 'labels', 'by', 'mentions', 'text', 'types', 'kinds', 'for', 'root'])

const wrong = (name: string, why: string) => new Failure('invalid_watch', `Watcher "${name}" ${why}`, { exit: 2 })
const wrongWatch = wrong

/** Runs a check that throws a misuse, and says which watcher it was about. */
function namedWith<T>(name: string, what: string, check: () => T, fail: (name: string, why: string) => Failure = wrong): T {
  try {
    return check()
  } catch (error) {
    throw fail(name, `has ${what}: ${(error as Error).message}`)
  }
}

/** Checks a filter given in code. `fail` says whose it is: a watcher's unless told otherwise (a hook's, in `board({ hooks })`). */
export function checkFilter(name: string, tail: unknown, fail?: (why: string) => Failure): Filter {
  const wrong = fail ? (_name: string, why: string) => fail(why) : wrongWatch
  const named = <T>(name: string, what: string, check: () => T) => namedWith(name, what, check, wrong)
  if (tail === null || typeof tail !== 'object' || Array.isArray(tail)) throw wrong(name, 'needs a "tail": what to listen for, such as { channel: "work/" }.')
  const filter = tail as Record<string, unknown>
  for (const key of Object.keys(filter)) if (!FILTER_KEYS.has(key)) throw wrong(name, `has "${key}" in its tail, which isn't a filter. A filter takes ${[...FILTER_KEYS].join(', ')}.`)
  const string = (key: string) => {
    if (filter[key] !== undefined && (typeof filter[key] !== 'string' || filter[key] === '')) throw wrong(name, `has a "${key}" that isn't text.`)
    return filter[key] as string | undefined
  }
  const channel = string('channel')
  if (channel !== undefined) named(name, 'a channel that is not one', () => channelScope(channel))
  if (filter.re !== undefined && !(typeof filter.re === 'number' && Number.isSafeInteger(filter.re) && filter.re > 0)) throw wrong(name, 'has an "re" that isn\'t a message ID.')
  for (const key of ['labels', 'types'] as const) {
    const list = filter[key]
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === 'string' && item !== ''))) throw wrong(name, `has "${key}" that isn't a list of text.`)
  }
  for (const label of (filter.labels as string[] | undefined) ?? []) named(name, 'a label filter that is not one', () => labelFilter(label))
  string('by')
  string('mentions')
  string('text')
  const target = string('for')
  if (target !== undefined) named(name, 'a "for" that isn\'t a profile name or an actor ID', () => forName(target))
  if (filter.root !== undefined && typeof filter.root !== 'boolean') throw wrong(name, 'has a "root" that isn\'t true or false.')
  if (filter.kinds !== undefined && !kindsValid(filter.kinds)) throw wrong(name, 'has "kinds" that aren\'t a list of hold kinds, each with "!" in front to leave it out.')
  return { ...(filter as Filter) }
}

/**
 * Checks every watcher when `board()` is called, so a bad one is a mistake in the module, said once with
 * its name, and never a loop that fails each pass and holds up the rest.
 */
export function checkWatchers(watch: unknown): Watcher[] {
  if (watch === undefined) return []
  if (watch === null || typeof watch !== 'object' || Array.isArray(watch)) throw new Failure('invalid_watch', '`watch` is an object of watchers by name: { lead: { tail, run } }.', { exit: 2 })
  return Object.entries(watch as Record<string, unknown>).map(([name, entry]) => {
    if (!NAME.test(name)) throw new Failure('invalid_watch', `"${name}" isn't a watcher name: lowercase letters, numbers, ".", "_" and "-", up to 64.`, { exit: 2 })
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw wrong(name, 'is not an object: { tail, run }.')
    const given = entry as Record<string, unknown>
    for (const key of Object.keys(given)) if (!WATCH_KEYS.has(key)) throw wrong(name, `has "${key}", which a watcher doesn't take. It takes ${[...WATCH_KEYS].join(', ')}.`)
    const tail = checkFilter(name, given.tail)
    if (typeof given.run !== 'function') throw wrong(name, 'needs "run": a function, or command([...]).')
    if (given.as !== undefined && typeof given.as !== 'string') throw wrong(name, 'has an "as" that isn\'t a profile name.')
    if (given.as !== undefined) namedWith(name, 'an "as" that is not a profile name', () => profileName(given.as as string))
    const timeout = given.timeout === undefined ? DEFAULT_TIMEOUT : millis(given.timeout)
    if (timeout === null || timeout < 1 || timeout > DAY) throw wrong(name, 'has a "timeout" that isn\'t a length of time from 1ms to 24h, such as "60s".')
    const coalesce = given.coalesce === undefined ? undefined : millis(given.coalesce)
    if (coalesce === null || (coalesce !== undefined && coalesce > DAY)) throw wrong(name, 'has a "coalesce" that isn\'t a length of time up to 24h, such as "30s".')
    return { name, tail, run: given.run as Watch['run'], timeout, ...(coalesce !== undefined ? { coalesce } : {}), ...(given.as !== undefined ? { as: given.as as string } : {}) }
  })
}
