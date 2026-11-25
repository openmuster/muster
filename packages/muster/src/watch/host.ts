import { Failure } from '../failure.ts'
import type { FeedEvent } from '../core/reads.ts'
import type { Board } from '../handle.ts'
import type { Fence } from '../core/deliveries.ts'
import { holderId, holdLease, LEASE_TTL, type Held, type Leases } from '../daemon/lease.ts'
import { DELIVERY_ATTEMPTS, SLOWEST } from '../daemon/watchers.ts'
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

/** What a watcher has been through in this process: failed runs in a row, across events, and when it may run again. */
export type WatchState = { failures: number; nextPass: number }

/**
 * The pause before a watcher's next pass once its runs have failed more times in a row than one event
 * is tried: then its code is broken, not the event. Each failure past that doubles it, up to ten
 * minutes; one run that works puts it back.
 */
export function slowedFor(failures: number): number {
  const over = failures - DELIVERY_ATTEMPTS
  return over < 1 ? 0 : Math.min(SLOWEST, 1000 * 2 ** (over + 1))
}

const deliveriesOf = (team: Board) => {
  const store = team.backend.deliveries
  if (!store) throw new Failure('watch_remote', `The board at ${team.backend.where} is reached over HTTP: watchers run where its file is.`, { hint: 'Start them in a process on the machine that has the board, or in mu serve there.' })
  return store
}

/** Events in one thread are delivered in order; each thread on its own. An event with no thread is its channel's. */
const laneOf = (event: FeedEvent) => (event.thread !== null ? String(event.thread) : `c:${event.channel ?? ''}`)

/** How many events a pass reads past its cursor, at most, looking for ones not yet delivered. */
const LOOK_AHEAD = 10_000

type Pass = { delivered: number; failed: number; lost?: true }

/**
 * Delivers what a watcher has not had yet. Each thread's events go in order, and a thread whose event
 * fails waits for its retry without holding up the others. Every try is counted before it is made, and
 * each result is recorded under the watcher's lease, so a host that lost the lease records nothing.
 *
 * Its place is the cursor `watch:<name>`, kept as its profile: everything at or below it is delivered.
 * The first pass puts it at the board's head, so a watcher starts from now.
 */
async function pass(team: Board, watcher: Watcher, fence: Fence, state: WatchState, log: (line: string) => void): Promise<Pass> {
  const store = deliveriesOf(team)
  const me = watcher.as !== undefined ? team.as(watcher.as) : team
  const who = await me.whoami()
  const caller = { principal: who.principal, profile: who.profile }
  const out: Pass = { delivered: 0, failed: 0 }
  const cursor = await me.cursorGet(fence.name)
  if (cursor === null) {
    if (!(await store.advance(caller, { watcher: watcher.name, to: await me.head(), fence })).held) out.lost = true
    return out
  }
  const { rows, now } = await store.read({ watcher: watcher.name, after: cursor })
  if (now < state.nextPass) return out
  const known = new Map(rows.map((row) => [row.seq, row]))
  // Past the events it has delivered, to those it hasn't: a thread that waits holds the cursor, not the rest.
  const lanes = new Map<string, FeedEvent[]>()
  const pending: FeedEvent[] = []
  let read = cursor
  for (;;) {
    const page = await me.events({ after: read, filter: watcher.tail, limit: 500 })
    for (const event of page.events) {
      if (known.get(event.seq)?.done || own(watcher, event)) continue
      const lane = laneOf(event)
      if (!lanes.has(lane)) lanes.set(lane, [])
      lanes.get(lane)!.push(event)
      pending.push(event)
    }
    read = page.cursor
    if (page.events.length < 500 || pending.length >= 500 || read - cursor >= LOOK_AHEAD) break
  }
  const settled = new Set<number>()
  const lost = () => {
    out.lost = true
    return out
  }
  lanes: for (const [lane, events] of lanes) {
    for (const event of events) {
      const row = known.get(event.seq)
      // Waiting for its next try: the rest of its thread waits behind it.
      if (row && row.retryAt > now) continue lanes
      // Its last try ended with its host: counted, and there are no more.
      if (row && row.attempts >= DELIVERY_ATTEMPTS) {
        if (!(await giveUp(me, store, watcher, event, 'its host stopped during the last try', fence, log))) return lost()
        settled.add(event.seq)
        continue
      }
      const begun = await store.begin({ watcher: watcher.name, seq: event.seq, lane, fence })
      if (!begun.held) return lost()
      const failure = await runOnce(me, watcher, event)
      await yieldNow()
      if (failure === null) {
        if (!(await store.finish({ watcher: watcher.name, seqs: [event.seq], fence })).held) return lost()
        settled.add(event.seq)
        state.failures = 0
        out.delivered += 1
        continue
      }
      out.failed += 1
      state.failures += 1
      log(`failed    ${watcher.name}  at ${event.seq}  try ${begun.attempts} of ${DELIVERY_ATTEMPTS}  ${failure.message}`)
      if (begun.attempts >= DELIVERY_ATTEMPTS) {
        if (!(await giveUp(me, store, watcher, event, failure.why, fence, log))) return lost()
        settled.add(event.seq)
      }
      // Its code is failing, not this event: stop here, and come back slower.
      if (slowedFor(state.failures) > 0) break lanes
      // The rest of this thread waits for this event's next try.
      if (!settled.has(event.seq)) continue lanes
    }
  }
  // Everything at or below the cursor is delivered: it stops below the oldest event that isn't.
  const waiting = pending.find((event) => !settled.has(event.seq))
  const to = waiting ? waiting.seq - 1 : read
  if (to > cursor && !(await store.advance(caller, { watcher: watcher.name, to, fence })).held) return lost()
  const pause = slowedFor(state.failures)
  if (out.failed > 0 && pause > 0) {
    state.nextPass = now + pause
    log(`slowed    ${watcher.name}  its runs keep failing: next pass in ${pause / 1000}s`)
  }
  return out
}

/** Runs the watcher on one event. Null when it worked; otherwise what to say about it. */
async function runOnce(me: Board, watcher: Watcher, event: FeedEvent): Promise<{ message: string; why: string } | null> {
  try {
    await watcher.run({ event, board: me, watcher: { name: watcher.name, as: watcher.as ?? null } })
    return null
  } catch (error) {
    const why = (error as { why?: unknown }).why
    return { message: (error as Error)?.message ?? String(error), why: typeof why === 'string' ? why : 'it threw' }
  }
}

/**
 * Stops trying an event, and says so on its thread, once: the note's key makes a second one the first.
 * The note is marked delivered with it, so it never wakes the watcher that wrote it.
 */
async function giveUp(me: Board, store: ReturnType<typeof deliveriesOf>, watcher: Watcher, event: FeedEvent, why: string, fence: Fence, log: (line: string) => void): Promise<boolean> {
  const seqs = [event.seq]
  if (event.thread !== null) {
    const text = `watcher "${watcher.name}" couldn't deliver a wake-up after ${DELIVERY_ATTEMPTS} tries (${why}).`
    const note = await me.reply({ to: event.thread, text, noSync: true, idempotencyKey: `watch:${watcher.name}:${event.seq}:gave-up` }).catch(() => null)
    if (note) seqs.push(note.id)
  }
  log(`gave up   ${watcher.name}  at ${event.seq}  after ${DELIVERY_ATTEMPTS} tries (${why})`)
  return (await store.finish({ watcher: watcher.name, seqs, fence })).held
}

/** A watcher's own writes never wake it, but a message it scheduled does: that is how it asks to be woken later. */
const own = (watcher: Watcher, event: FeedEvent) => watcher.as !== undefined && event.by.profile === watcher.as && !(event.data as { schedule?: unknown }).schedule

/** Runs each watcher once, under its lease: for tests, and for a host that runs on a timer of its own. */
export async function deliver(team: Board, watchers: Watcher[], states: Map<string, WatchState>, log: (line: string) => void = () => {}): Promise<Delivered> {
  const out: Delivered = { delivered: 0, failed: 0, held: [] }
  if (watchers.length === 0) return out
  const leases = leasesOf(team)
  const holder = holderId()
  for (const watcher of watchers) {
    const name = `watch:${watcher.name}`
    const taken = await leases.take({ name, holder, ttl: LEASE_TTL })
    if (!taken.held) {
      out.held.push(watcher.name)
      continue
    }
    try {
      const did = await pass(team, watcher, { name, holder, epoch: taken.epoch }, stateOf(states, watcher.name), log)
      out.delivered += did.delivered
      out.failed += did.failed
    } finally {
      await leases.release({ name, holder, epoch: taken.epoch })
    }
  }
  return out
}

export const stateOf = (states: Map<string, WatchState>, name: string): WatchState => {
  let state = states.get(name)
  if (!state) states.set(name, (state = { failures: 0, nextPass: -Infinity }))
  return state
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
async function loop(team: Board, watcher: Watcher, stop: AbortSignal, options: StartOptions, state: WatchState, log: (line: string) => void): Promise<void> {
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
          const did = await pass(team, watcher, { name: `watch:${watcher.name}`, holder: held.holder, epoch: held.epoch }, state, log)
          said = ''
          if (did.lost) {
            log(`lost      ${watcher.name}  another host runs it now`)
            break
          }
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
export function start(team: Board, watchers: Watcher[], states: Map<string, WatchState>, options: StartOptions = {}): Host {
  if (watchers.length > 0) {
    leasesOf(team)
    deliveriesOf(team)
  }
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
    loop(team, watcher, controller.signal, options, stateOf(states, watcher.name), log).catch((error) => log(`stopped   ${watcher.name}  ${(error as Error).message}`)),
  )
  const done = Promise.all(loops).then(() => {
    options.signal?.removeEventListener('abort', stopNow)
    if (hosts().get(key) === host) hosts().delete(key)
  })
  const host: Host = { stop: stopNow, done }
  hosts().set(key, host)
  return host
}
