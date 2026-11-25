import { Failure } from '../failure.ts'
import { labelFilter } from '../model.ts'
import type { Watcher } from './watchers.ts'

/** What `mu daemon check` writes so a watcher's filter matches it: a new thread, or a reply in the one it watches. */
export type CheckWrite =
  | { kind: 'post'; channel: string; text: string; labels: Record<string, string>; as?: string }
  | { kind: 'reply'; to: number; text: string; as?: string }

/** How the daemon marks a wake it gave up on, so a check doesn't take it for an answer. */
export const GAVE_UP = /^watcher ".*" couldn't deliver a wake-up/

const notCheckable = (watcher: Watcher, why: string) =>
  new Failure('watcher_not_checkable', `Watcher "${watcher.name}" can't be checked with a message: ${why}`, { hint: 'Check it by hand: write what it listens for, and watch the thread.' })

const inScope = (channel: string, scope: string) => (scope.endsWith('/') ? channel.startsWith(scope) : channel === scope)

/**
 * Works out a write the watcher's own filter would match, or says why there is none. It is built from
 * the filter, so a check exercises the same path a real wake takes: the filter, the gate, the command.
 */
export function checkWrite(watcher: Watcher, options: { in?: string; principal?: string } = {}): CheckWrite {
  const tail = watcher.tail
  if (tail.types && !tail.types.some((type) => type === 'message.posted' || (type.endsWith('.') && 'message.posted'.startsWith(type)))) {
    throw notCheckable(watcher, `it listens for ${tail.types.join(', ')}, not for messages.`)
  }
  // A plain kind keeps only blocks, and a message is never one.
  const only = (tail.kinds ?? []).filter((kind) => !kind.startsWith('!'))
  if (only.length) throw notCheckable(watcher, `it listens only for tasks held as ${only.join(', ')}, not for messages.`)
  let as: string | undefined
  if (tail.by !== undefined) {
    if (tail.by.includes(':')) throw notCheckable(watcher, `it listens only to ${tail.by}.`)
    as = tail.by
  }
  // The watcher never wakes for what its own profile writes.
  if (as !== undefined && as === watcher.as) throw notCheckable(watcher, `it listens only to ${as}, which is its own profile.`)
  const parts = [`Watcher check for "${watcher.name}". If a watcher woke you for this, reply in this thread with anything.`]
  if (tail.mentions !== undefined) parts.push(`@${tail.mentions.split(/[:+]/).at(-1)}`)
  // A mention by ID, settled as written: a profile that has never written on the board has no handle to settle.
  if (tail.for !== undefined) parts.push(/[:+]/.test(tail.for) ? `@[${tail.for}]` : options.principal ? `@[${options.principal}+${tail.for}]` : `@${tail.for}`)
  if (tail.text !== undefined) parts.push(tail.text)
  const text = parts.join(' ')
  if (tail.re !== undefined) {
    if (tail.labels?.length) throw notCheckable(watcher, 'it watches one thread and also filters on labels.')
    return { kind: 'reply', to: tail.re, text, ...(as ? { as } : {}) }
  }
  let channel = options.in
  if (channel === undefined) {
    if (tail.channel === undefined || tail.channel.endsWith('/')) {
      throw new Failure('missing_channel', `Watcher "${watcher.name}" listens to ${tail.channel ? `everything under ${tail.channel}` : 'every channel'}: say where to write the check.`, {
        exit: 2,
        next: [`mu daemon check ${watcher.name} --in ${tail.channel ?? ''}checks`],
      })
    }
    channel = tail.channel
  } else if (tail.channel !== undefined && !inScope(channel, tail.channel)) {
    throw new Failure('watcher_not_checkable', `Watcher "${watcher.name}" doesn't listen to ${channel}, only to ${tail.channel}.`)
  }
  const labels: Record<string, string> = {}
  for (const filter of (tail.labels ?? []).map(labelFilter)) labels[filter.key] = filter.values?.[0] ?? 'check'
  return { kind: 'post', channel, text, labels, ...(as ? { as } : {}) }
}
