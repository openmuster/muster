import { Failure } from '../failure.ts'
import { channelScope, forName, labelFilter, profileName } from '../model.ts'
import type { FeedEvent, Filter } from '../core/reads.ts'
import type { Board } from '../handle.ts'

/** What a watcher is handed each time it runs. */
export type WatchContext = {
  /** The event that woke it: what `mu tail --json` prints for it. */
  event: FeedEvent
  /** The board, writing as the watcher's `as` profile when it has one. */
  board: Board
  /** Which watcher this is, and the profile it writes as. */
  watcher: { name: string; as: string | null }
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
}

/** A watcher as `board()` checked it: its name beside it. */
export type Watcher = Watch & { name: string }

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const WATCH_KEYS = new Set(['tail', 'run', 'as'])
const FILTER_KEYS = new Set(['channel', 're', 'labels', 'by', 'mentions', 'text', 'types', 'for'])

const wrong = (name: string, why: string) => new Failure('invalid_watch', `Watcher "${name}" ${why}`, { exit: 2 })

/** Runs a check that throws a misuse, and says which watcher it was about. */
function named<T>(name: string, what: string, check: () => T): T {
  try {
    return check()
  } catch (error) {
    throw wrong(name, `has ${what}: ${(error as Error).message}`)
  }
}

function checkFilter(name: string, tail: unknown): Filter {
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
    if (given.as !== undefined) named(name, 'an "as" that is not a profile name', () => profileName(given.as as string))
    return { name, tail, run: given.run as Watch['run'], ...(given.as !== undefined ? { as: given.as as string } : {}) }
  })
}
