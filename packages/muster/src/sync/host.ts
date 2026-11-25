import type { Board } from '../handle.ts'
import { holdLease, LEASE_TTL, type Held, type Leases } from '../daemon/lease.ts'

/** How often a host that holds the `sync` lease ticks: as often as the daemon ticks. */
const EVERY = 1000
/** The longest pause between ticks that keep failing, as the daemon's (`FAILING_PAUSE`). */
const FAILING_PAUSE = 30_000

/**
 * A board module's sync, in the process that started it: catch-up, files, imports and what goes out to the
 * platforms, under the board's `sync` lease, so two hosts never send one message twice. Stands by while
 * another host holds it, and takes over once that host stops renewing. Nothing it meets ends it but a stop.
 */
export async function syncLoop(team: Board, leases: Leases, stop: AbortSignal, sleep: (ms: number) => Promise<void>, options: { lease?: { ttl?: number; every?: number; wait?: number } }, log: (line: string) => void): Promise<void> {
  const ttl = options.lease?.ttl ?? LEASE_TTL
  let said = ''
  let failing = 0
  const fail = (error: unknown) => {
    const message = (error as Error).message
    failing += 1
    if (message !== said) log(`error     sync  ${message}`)
    else if ((failing & (failing - 1)) === 0) log(`error     sync  ${message}  (${failing} ticks in a row)`)
    said = message
  }
  while (!stop.aborted) {
    let held: Held | null = null
    try {
      held = await holdLease(leases, 'sync', { ...options.lease, sleep, stop })
    } catch (error) {
      fail(error)
      await sleep(EVERY)
      continue
    }
    if (!held) {
      // Another host syncs. Look again once its lease could have lapsed.
      await sleep(ttl)
      continue
    }
    try {
      while (!stop.aborted) {
        if (held.lost()) {
          log('lost      sync  another host syncs now')
          break
        }
        try {
          const did = await team.backend.syncTick()
          failing = 0
          said = ''
          for (const note of did.skipped ?? []) log(`skipped   sync ${note}`)
        } catch (error) {
          fail(error)
        }
        await sleep(failing ? Math.min(FAILING_PAUSE, EVERY * 2 ** failing) : EVERY)
      }
    } finally {
      await held.release()
    }
  }
}
