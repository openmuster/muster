import { misuse } from '../failure.ts'
import type { Context } from './context.ts'

/**
 * A role one process at a time holds for a board, such as `tick`: a row in the board's own file, so it
 * needs no lock file, no `ps`, and nothing beside a board kept in memory. The deadline is data, like a
 * task's claim: a holder that stops renewing has let go once `expires` passes, whoever looks.
 *
 * `epoch` rises each time the role changes hands, and never goes back (release keeps the row), so a
 * holder that renews with the epoch it was given learns at once that someone else has had it since.
 */
export type Lease = { name: string; holder: string | null; epoch: number; expires: number }

/** Taken: the role is yours until `expires` unless renewed. Not taken: who has it, and until when. */
export type Taken = { held: true; epoch: number; expires: number } | { held: false; holder: string; epoch: number; expires: number }

const NAME = /^[a-z0-9][a-z0-9_.:-]{0,127}$/
/** Who holds a role: an ID each holder makes for itself, never a pid that could be someone else's later. */
const HOLDER = /^[\x21-\x7e]{1,200}$/

function checked(name: string, holder: string, ttl: number) {
  if (!NAME.test(name)) throw misuse('invalid_lease', `"${name}" isn't a lease name.`)
  if (!HOLDER.test(holder)) throw misuse('invalid_lease', 'A lease holder is 1 to 200 printable characters with no spaces.')
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400_000) throw misuse('invalid_lease', 'A lease lasts from 1 millisecond to a day.')
}

const row = (c: Context, name: string) => c.db.raw.prepare('select name, holder, epoch, expires from leases where name = ?').get(name) as Lease | undefined

/**
 * Takes `name` for `holder` for `ttl` milliseconds, if nobody else holds it now. One write transaction:
 * of any number of processes taking a lapsed lease at once, exactly one gets it.
 */
export function take(c: Context, request: { name: string; holder: string; ttl: number }): Taken {
  checked(request.name, request.holder, request.ttl)
  return c.db.write(() => {
    const now = c.now().getTime()
    const was = row(c, request.name)
    if (was?.holder != null && was.expires > now && was.holder !== request.holder) return { held: false, holder: was.holder, epoch: was.epoch, expires: was.expires }
    // Taking again what you hold already is a renewal: the same epoch, a new deadline.
    const epoch = was?.holder === request.holder && was.expires > now ? was.epoch : (was?.epoch ?? 0) + 1
    const expires = now + request.ttl
    c.db.raw
      .prepare('insert into leases (name, holder, epoch, expires) values (?, ?, ?, ?) on conflict (name) do update set holder = excluded.holder, epoch = excluded.epoch, expires = excluded.expires')
      .run(request.name, request.holder, epoch, expires)
    return { held: true, epoch, expires }
  })
}

/**
 * Pushes the deadline out by `ttl` from now. False when the lease is no longer this holder's at this
 * epoch. A holder that is late but whom nobody has replaced still holds it: a laptop that slept past
 * its deadline renews when it wakes, unless someone took over meanwhile.
 */
export function renew(c: Context, request: { name: string; holder: string; epoch: number; ttl: number }): { held: boolean; expires: number } {
  checked(request.name, request.holder, request.ttl)
  return c.db.write(() => {
    const expires = c.now().getTime() + request.ttl
    const changed = c.db.raw.prepare('update leases set expires = ? where name = ? and holder = ? and epoch = ?').run(expires, request.name, request.holder, request.epoch).changes
    return changed > 0 ? { held: true, expires } : { held: false, expires: row(c, request.name)?.expires ?? 0 }
  })
}

/** Lets go, so the next taker needn't wait out the deadline. The row stays, so the epoch keeps rising. */
export function release(c: Context, request: { name: string; holder: string; epoch: number }): void {
  c.db.write(() => {
    c.db.raw.prepare('update leases set holder = null, expires = 0 where name = ? and holder = ? and epoch = ?').run(request.name, request.holder, request.epoch)
  })
}

/** Who holds `name` now, if anyone: a lapsed or released lease reads as nobody's. */
export function holder(c: Context, name: string): { holder: string; epoch: number; expires: number } | null {
  const was = row(c, name)
  if (!was || was.holder == null || was.expires <= c.now().getTime()) return null
  return { holder: was.holder, epoch: was.epoch, expires: was.expires }
}
