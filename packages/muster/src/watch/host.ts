import { Failure } from '../failure.ts'
import type { FeedEvent } from '../core/reads.ts'
import type { Board } from '../handle.ts'
import { holderId, holdLease, LEASE_TTL, type Held, type Leases } from '../daemon/lease.ts'
import type { Watcher } from './watch.ts'

/** A host running a board's watchers: stop it, and `done` settles once each run in flight has been recorded. */
export type Host = { stop(): void; done: Promise<void> }

export type StartOptions = {
  /** Stops the host when it aborts, like `stop()`. */
  signal?: AbortSignal
  /** Where the host says what it did and what failed. Default: standard error. */
  log?: (line: string) => void
  /** Each watcher's lease, in milliseconds: how long it lasts unrenewed, how often it is renewed, how often a waiting host looks. */
  lease?: { ttl?: number; every?: number; wait?: number }
}

/** What one pass over the watchers did. `held` names those another host runs, so this one left them alone. */
export type Delivered = { delivered: number; failed: number; held: string[] }

/** The longest a watcher's loop waits between looks when nothing comes. */
const QUIET = 1000

/** Lets the event loop run: the file backend's calls are synchronous, so awaiting them never yields. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))

const leasesOf = (team: Board): Leases => {
  const leases = team.backend.leases
  if (!leases) throw new Failure('watch_remote', `The board at ${team.backend.where} is reached over HTTP: watchers run where its file is.`, { hint: 'Start them in a process on the machine that has the board, or in mu serve there.' })
  return leases
}

/**
 * Delivers what a watcher has not had yet, oldest first. Its place is the cursor `watch:<name>`, kept as
 * its profile; the first pass puts it at the board's head, so a watcher starts from now.
 */
async function pass(team: Board, watcher: Watcher, log: (line: string) => void): Promise<{ delivered: number; failed: number }> {
  const me = watcher.as !== undefined ? team.as(watcher.as) : team
  const name = `watch:${watcher.name}`
  let cursor = await me.cursorGet(name)
  if (cursor === null) {
    cursor = await me.head()
    await me.cursorSet(name, cursor)
    return { delivered: 0, failed: 0 }
  }
  const page = await me.events({ after: cursor, filter: watcher.tail, limit: 500 })
  let delivered = 0
  for (const event of page.events) {
    if (own(watcher, event)) continue
    try {
      await watcher.run({ event, board: me, watcher: { name: watcher.name, as: watcher.as ?? null } })
    } catch (error) {
      log(`failed    ${watcher.name}  at ${event.seq}  ${(error as Error).message}`)
      if (event.seq - 1 > cursor) await me.cursorSet(name, event.seq - 1)
      return { delivered, failed: 1 }
    }
    delivered += 1
    await me.cursorSet(name, event.seq)
    await yieldNow()
  }
  if (page.cursor > cursor) await me.cursorSet(name, page.cursor)
  return { delivered, failed: 0 }
}

/** A watcher's own writes never wake it, but a message it scheduled does: that is how it asks to be woken later. */
const own = (watcher: Watcher, event: FeedEvent) => watcher.as !== undefined && event.by.profile === watcher.as && !(event.data as { schedule?: unknown }).schedule

/** Runs each watcher once, under its lease: for tests, and for a host that runs on a timer of its own. */
export async function deliver(team: Board, watchers: Watcher[], log: (line: string) => void = () => {}): Promise<Delivered> {
  const out: Delivered = { delivered: 0, failed: 0, held: [] }
  if (watchers.length === 0) return out
  const leases = leasesOf(team)
  const holder = holderId()
  for (const watcher of watchers) {
    const lease = `watch:${watcher.name}`
    const taken = await leases.take({ name: lease, holder, ttl: LEASE_TTL })
    if (!taken.held) {
      out.held.push(watcher.name)
      continue
    }
    try {
      const did = await pass(team, watcher, log)
      out.delivered += did.delivered
      out.failed += did.failed
    } finally {
      await leases.release({ name: lease, holder, epoch: taken.epoch })
    }
  }
  return out
}

/** A sleep that a stop cuts short. */
const sleeper = (stop: AbortSignal) => (ms: number) =>
  new Promise<void>((resolve) => {
    if (stop.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      stop.removeEventListener('abort', done)
      resolve()
    }
    stop.addEventListener('abort', done)
  })

/**
 * One watcher's loop: take its lease, deliver while holding it, and stand by while another host holds
 * it, ready to take over when that host stops renewing. Nothing it meets ends it but a stop.
 */
async function loop(team: Board, watcher: Watcher, stop: AbortSignal, options: StartOptions, log: (line: string) => void): Promise<void> {
  const leases = leasesOf(team)
  const sleep = sleeper(stop)
  const ttl = options.lease?.ttl ?? LEASE_TTL
  let said = ''
  const fail = (error: unknown) => {
    const message = (error as Error).message
    if (message !== said) log(`error     ${watcher.name}  ${message}`)
    said = message
  }
  while (!stop.aborted) {
    let held: Held | null = null
    try {
      held = await holdLease(leases, `watch:${watcher.name}`, { ...options.lease, sleep, stop })
    } catch (error) {
      fail(error)
      await sleep(QUIET)
      continue
    }
    if (!held) {
      // Another host runs it. Look again once its lease could have lapsed.
      await sleep(ttl)
      continue
    }
    let quiet = 100
    try {
      while (!stop.aborted) {
        if (held.lost()) {
          log(`lost      ${watcher.name}  another host runs it now`)
          break
        }
        try {
          const did = await pass(team, watcher, log)
          said = ''
          quiet = did.delivered + did.failed > 0 ? 100 : Math.min(quiet * 2, QUIET)
        } catch (error) {
          fail(error)
          quiet = QUIET
        }
        await yieldNow()
        await sleep(quiet)
      }
    } finally {
      await held.release()
    }
  }
}

const HOSTS = Symbol.for('muster.watch.hosts')
/** The hosts running in this process, by board: kept on `globalThis`, so two copies of a module (as Next.js loads) share them. */
const hosts = (): Map<unknown, Host> => ((globalThis as Record<symbol, unknown>)[HOSTS] ??= new Map()) as Map<unknown, Host>

/**
 * Starts the board's watchers in this process, each in its own loop, and returns at once. Never await
 * `done` where a server starts up: it settles only when the host stops. A second `start()` for the same
 * board in this process returns the host already running.
 */
export function start(team: Board, watchers: Watcher[], options: StartOptions = {}): Host {
  if (watchers.length > 0) leasesOf(team)
  const backend = team.backend
  // A board in memory is its own: two of them share a path (":memory:") and nothing else.
  const key = backend.kind === 'file' && backend.where !== ':memory:' ? backend.where : backend
  const running = hosts().get(key)
  if (running) return running
  const log = options.log ?? ((line: string) => process.stderr.write(`muster: ${line}\n`))
  const controller = new AbortController()
  const stopNow = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', stopNow, { once: true })
  const loops = watchers.map((watcher) =>
    // A loop doesn't throw; if one ever did, the host says so rather than leave a rejection nobody awaits.
    loop(team, watcher, controller.signal, options, log).catch((error) => log(`stopped   ${watcher.name}  ${(error as Error).message}`)),
  )
  const done = Promise.all(loops).then(() => {
    options.signal?.removeEventListener('abort', stopNow)
    if (hosts().get(key) === host) hosts().delete(key)
  })
  const host: Host = { stop: stopNow, done }
  hosts().set(key, host)
  return host
}
