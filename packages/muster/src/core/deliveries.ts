import type { Caller } from '../model.ts'
import type { Context } from './context.ts'
import { cursorOwner } from './reads.ts'

/**
 * Where a watcher stands with the events above its cursor: those it has delivered, and those it is
 * trying, with how many tries they have had and when the next is due. Bookkeeping like cursors and
 * leases: not in the log, and pruned as the cursor passes.
 */
export type Delivery = { seq: number; lane: string; attempts: number; retryAt: number; done: boolean }

/** The lease a watcher's host holds: each write below checks it, so a host that lost it records nothing. */
export type Fence = { name: string; holder: string; epoch: number }

const holds = (c: Context, fence: Fence) => c.db.raw.prepare('select 1 from leases where name = ? and holder = ? and epoch = ?').get(fence.name, fence.holder, fence.epoch) !== undefined

/** The rows above `after`, and the board's clock, which every deadline here is measured on. */
export function read(c: Context, request: { watcher: string; after: number }): { rows: Delivery[]; now: number } {
  const rows = c.db.raw.prepare('select seq, lane, attempts, retry_at as retryAt, done from deliveries where watcher = ? and seq > ? order by seq').all(request.watcher, request.after) as (Omit<Delivery, 'done'> & { done: number })[]
  return { rows: rows.map((row) => ({ ...row, done: row.done === 1 })), now: c.now().getTime() }
}

/** How many times a watcher tries one event before it gives up on it and says so on its thread. */
export const DELIVERY_ATTEMPTS = 5

/** The first wait before a failed event is tried again; each try after doubles it. */
export const RETRY_FIRST = 10_000
/** The longest wait between two tries of one event. */
export const RETRY_MOST = 10 * 60_000

/** How long after its `attempts`-th try an event may be tried again: 10s, 20s, 40s... up to ten minutes. */
export const retryDelay = (attempts: number) => Math.min(RETRY_MOST, RETRY_FIRST * 2 ** (attempts - 1))

/**
 * Counts a try before it is made, and says when the next may be: so a run that takes its host down with
 * it still counts, and a crash can't retry one event for ever.
 */
export function begin(c: Context, request: { watcher: string; seq: number; lane: string; fence: Fence }): { held: false } | { held: true; attempts: number } {
  return c.db.write(() => {
    if (!holds(c, request.fence)) return { held: false as const }
    const was = c.db.raw.prepare('select attempts from deliveries where watcher = ? and seq = ?').get(request.watcher, request.seq) as { attempts: number } | undefined
    const attempts = (was?.attempts ?? 0) + 1
    c.db.raw
      .prepare('insert into deliveries (watcher, seq, lane, attempts, retry_at, done) values (?, ?, ?, ?, ?, 0) on conflict (watcher, seq) do update set attempts = excluded.attempts, retry_at = excluded.retry_at')
      .run(request.watcher, request.seq, request.lane, attempts, c.now().getTime() + retryDelay(attempts))
    return { held: true as const, attempts }
  })
}

/** Marks events delivered, or never to be: one a watcher gave up on, its note about it, events a later one stood for. */
export function finish(c: Context, request: { watcher: string; seqs: number[]; fence: Fence }): { held: boolean } {
  return c.db.write(() => {
    if (!holds(c, request.fence)) return { held: false }
    const mark = c.db.raw.prepare("insert into deliveries (watcher, seq, lane, attempts, retry_at, done) values (?, ?, '', 0, 0, 1) on conflict (watcher, seq) do update set done = 1")
    for (const seq of request.seqs) mark.run(request.watcher, seq)
    return { held: true }
  })
}

/** Moves the watcher's cursor up to `to`, everything at or below it delivered, and forgets the rows it passed. */
export function advance(c: Context, caller: Caller, request: { watcher: string; to: number; fence: Fence }): { held: boolean } {
  return c.db.write(() => {
    if (!holds(c, request.fence)) return { held: false }
    c.db.raw
      .prepare('insert into cursors (name, profile, seq) values (?, ?, ?) on conflict (name, profile) do update set seq = max(seq, excluded.seq)')
      .run(`watch:${request.watcher}`, cursorOwner(caller), request.to)
    c.db.raw.prepare('delete from deliveries where watcher = ? and seq <= ?').run(request.watcher, request.to)
    return { held: true }
  })
}
