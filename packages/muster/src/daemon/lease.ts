import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import type { Backend } from '../backend/types.ts'

/** How long the ticker's lease lasts unrenewed: how long a ticker that died silently holds up the next. */
export const LEASE_TTL = 30_000
/** How often a holder renews. A few renewals fit in one lease, so a slow write or a busy board costs none. */
export const LEASE_EVERY = 5_000
/** How often a process waiting for a lease looks again. */
export const LEASE_WAIT = 1_000

export type Leases = NonNullable<Backend['leases']>

/** A lease this process holds, renewed in the background until released. */
export type Held = {
  holder: string
  epoch: number
  /** True once a renewal found the lease in someone else's hands: stop doing what it guards. */
  lost(): boolean
  release(): Promise<void>
}

/** An ID for one holder: which machine and process, for people reading it, and random, so no two are ever the same. */
export const holderId = () => `${hostname().replace(/[^\x21-\x7e]/g, '-').slice(0, 64) || 'host'}:${process.pid}:${randomBytes(6).toString('hex')}`

/**
 * Takes the lease `name`, waiting while its holder may be gone. A holder that renews while this waits
 * is alive, and the answer is null at once. One that doesn't has died, or slept: its lease lapses
 * within `ttl` and this process takes it. So a daemon restarted right after a crash takes over from its
 * own dead self, instead of finding the lease held and leaving nothing to tick.
 */
export async function holdLease(
  leases: Leases,
  name: string,
  options: { ttl?: number; every?: number; wait?: number; sleep: (ms: number) => Promise<void>; stop: AbortSignal; holder?: string },
): Promise<Held | null> {
  const ttl = options.ttl ?? LEASE_TTL
  const every = options.every ?? LEASE_EVERY
  const wait = options.wait ?? LEASE_WAIT
  const holder = options.holder ?? holderId()
  // Bounded by tries, not by a clock: a lease whose holder neither renews nor lapses (a clock that
  // doesn't move) is held after as many looks as a lease could last.
  const tries = Math.ceil(ttl / wait) + 2
  let seen: { holder: string; epoch: number; expires: number } | null = null
  for (let attempt = 0; ; attempt++) {
    const taken = await leases.take({ name, holder, ttl })
    if (taken.held) return heartbeat(leases, name, holder, taken.epoch, ttl, every)
    if (seen && (seen.holder !== taken.holder || seen.epoch !== taken.epoch || seen.expires !== taken.expires)) return null
    seen = { holder: taken.holder, epoch: taken.epoch, expires: taken.expires }
    if (attempt >= tries || options.stop.aborted) return null
    await options.sleep(wait)
    if (options.stop.aborted) return null
  }
}

function heartbeat(leases: Leases, name: string, holder: string, epoch: number, ttl: number, every: number): Held {
  let lost = false
  let beating: Promise<unknown> = Promise.resolve()
  const timer = setInterval(() => {
    beating = leases
      .renew({ name, holder, epoch, ttl })
      .then((renewed) => {
        if (!renewed.held) lost = true
      })
      // A renewal that fails (a busy board) is tried at the next beat. Only an answer that someone else
      // has it now means lost: stopping on an error would leave the board with no ticker at all.
      .catch(() => {})
  }, every)
  timer.unref()
  return {
    holder,
    epoch,
    lost: () => lost,
    async release() {
      clearInterval(timer)
      await beating
      if (lost) return
      try {
        await leases.release({ name, holder, epoch })
      } catch {
        // It lapses on its own.
      }
    },
  }
}
