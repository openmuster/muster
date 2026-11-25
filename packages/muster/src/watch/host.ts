import { Failure } from '../failure.ts'
import type { FeedEvent } from '../core/reads.ts'
import type { Board } from '../handle.ts'
import type { Fence } from '../core/deliveries.ts'
import { loadWatchers, watchersPath } from '../daemon/daemon.ts'
import { holderId, holdLease, LEASE_TTL, type Held, type Leases } from '../daemon/lease.ts'
import { DELIVERY_ATTEMPTS } from '../daemon/watchers.ts'
import type { Watcher, WatchEvent } from './watch.ts'
import { syncLoop } from '../sync/host.ts'

/** A host running a board's watchers: stop it, and `done` settles once each run in flight has been recorded. */
export type Host = { stop(): void; done: Promise<void> }

export type StartOptions = {
  /** Stops the host when it aborts, like `stop()`. */
  signal?: AbortSignal
  /** Where the host says what it did and what failed. Default: standard error. */
  log?: (line: string) => void
  /** Each watcher's lease, in milliseconds: how long it lasts unrenewed, how often it is renewed, how often a waiting host looks. */
  lease?: { ttl?: number; every?: number; wait?: number }
  /** How long `stop()` waits for a run in flight once it has signalled it, in milliseconds. Default 5 seconds. */
  grace?: number
}

/** What one pass over the watchers did. `held` names those another host runs, so this one left them alone. */
export type Delivered = { delivered: number; failed: number; held: string[] }

/** The longest a watcher's loop waits between looks when nothing comes. */
const QUIET = 1000
/** How long a stopped host waits for the run in flight, unless told otherwise. */
const GRACE = 5000
/** The most threads one pass looks at, and the most events it keeps to deliver: the rest wait for the next pass. */
const MAX_LANES = 500
const MAX_EVENTS = 2000
/** The most of the log one pass reads, in seqs, whatever it keeps: the next pass reads on from there. */
export const LOOK_AHEAD = 5000
/** The most events one `coalesce` run stands for. */
export const MAX_COALESCED = 500

/** Where a watcher's reading has got to in this process, when a pass stopped short of the board's head. */
export type WatchState = { resume: number | null; floor: number; blocked: Set<string> }

export const stateOf = (states: Map<string, WatchState>, name: string): WatchState => {
  let state = states.get(name)
  if (!state) states.set(name, (state = { resume: null, floor: Infinity, blocked: new Set() }))
  return state
}

/** Lets the event loop run: the file backend's calls are synchronous, so awaiting them never yields. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))

const remote = (team: Board) =>
  new Failure('watch_remote', `The board at ${team.backend.where} is reached over HTTP: watchers run where its file is.`, { hint: 'Start them in a process on the machine that has the board, or in mu serve there.' })

const leasesOf = (team: Board): Leases => {
  if (!team.backend.leases) throw remote(team)
  return team.backend.leases
}

const deliveriesOf = (team: Board) => {
  if (!team.backend.deliveries) throw remote(team)
  return team.backend.deliveries
}

/** Events in one thread are delivered in order; each thread on its own. An event with no thread is its channel's. */
const laneOf = (event: FeedEvent) => (event.thread !== null ? String(event.thread) : `c:${event.channel ?? ''}`)

/**
 * One thread's events in a pass. A thread that is waiting (for its first event's next try, or gathering
 * under `coalesce`) keeps only that first event: what comes after it in the thread can't go first, and
 * mustn't take room from other threads.
 */
type Lane = { head: FeedEvent; waiting: boolean; events: FeedEvent[]; seqs: number[]; last: FeedEvent }

type Pass = { delivered: number; failed: number; lost?: true }

/**
 * Delivers what a watcher has not had yet. Each thread's events go in order, and a thread whose event
 * fails waits for its own next try without holding up any other. Every try is counted before it is
 * made, and each result is recorded under the watcher's lease, so a host that lost the lease records
 * nothing. `halt` (a stop, or the lease lost) ends the pass before its next run, and signals the one in flight.
 *
 * Its place is the cursor `watch:<name>`, kept as its profile: everything at or below it is delivered.
 * The first pass puts it at the board's head, so a watcher starts from now.
 */
async function pass(team: Board, watcher: Watcher, fence: Fence, state: WatchState, halt: AbortSignal, grace: number, log: (line: string) => void): Promise<Pass> {
  const store = deliveriesOf(team)
  const me = watcher.as !== undefined ? team.as(watcher.as) : team
  const who = await me.whoami()
  const caller = { principal: who.principal, profile: who.profile }
  const out: Pass = { delivered: 0, failed: 0 }
  const lost = () => {
    out.lost = true
    return out
  }
  const cursor = await me.cursorGet(fence.name)
  if (cursor === null) return (await store.advance(caller, { watcher: watcher.name, to: await me.head(), fence })).held ? out : lost()
  const { rows, now } = await store.read({ watcher: watcher.name, after: cursor })
  const known = new Map(rows.map((row) => [row.seq, row]))
  const waits = (head: FeedEvent) => {
    const row = known.get(head.seq)
    return (row !== undefined && row.retryAt > now) || (watcher.coalesce !== undefined && Date.parse(head.at) + watcher.coalesce > now)
  }
  // Read a stretch of the log, keeping what this pass can deliver: a thread's first event, and the
  // events after it only while that thread can go now. `dropped` is the oldest event left for later.
  // A stretch is at most LOOK_AHEAD seqs, counted whether an event is kept or not, so a pass never reads
  // an unbounded part of a busy board; the next pass reads on from where this one stopped, and comes
  // back round to the cursor once it reaches the head.
  const end = await me.head()
  if (state.resume === null || state.resume <= cursor || state.resume > end) {
    state.resume = null
    state.floor = Infinity
    state.blocked = new Set()
  }
  const start = state.resume ?? cursor
  const lanes = new Map<string, Lane>()
  // Threads with an event this pass leaves undelivered: their later events wait behind it, in this
  // stretch and the next ones, until the reading comes back round.
  const blocked = new Set(state.blocked)
  let kept = 0
  let dropped = Infinity
  let read = start
  const leave = (name: string, seq: number) => {
    dropped = Math.min(dropped, seq)
    blocked.add(name)
  }
  while (read < end && read - start < LOOK_AHEAD && lanes.size < MAX_LANES && kept < MAX_EVENTS) {
    const page = await me.events({ after: read, filter: watcher.tail, limit: 500, through: Math.min(read + 500, end) })
    for (const event of page.events) {
      if (known.get(event.seq)?.done || own(watcher, event)) continue
      const name = laneOf(event)
      if (state.blocked.has(name)) {
        leave(name, event.seq)
        continue
      }
      let lane = lanes.get(name)
      if (!lane) {
        if (lanes.size >= MAX_LANES) {
          leave(name, event.seq)
          continue
        }
        lane = { head: event, waiting: waits(event), events: [], seqs: [], last: event }
        lanes.set(name, lane)
      }
      if (watcher.coalesce !== undefined) {
        // One run stands for at most so many events: the rest are the next run's.
        if (lane.seqs.length < MAX_COALESCED) {
          lane.seqs.push(event.seq)
          lane.last = event
        } else leave(name, event.seq)
      } else if (!lane.waiting && kept < MAX_EVENTS) {
        lane.events.push(event)
        kept += 1
      } else if (event !== lane.head) {
        leave(name, event.seq)
      }
    }
    read = page.cursor
    await yieldNow()
  }
  const settled = new Set<number>()
  lanes: for (const [name, lane] of lanes) {
    if (lane.waiting) continue
    const units: Unit[] = watcher.coalesce !== undefined ? [{ event: lane.last, key: lane.head, seqs: lane.seqs }] : lane.events.map((event) => ({ event, key: event, seqs: [event.seq] }))
    for (const unit of units) {
      if (halt.aborted) break lanes
      // Settled already in this pass: a give-up note taken back, recorded with the event it is about.
      if (unit.seqs.every((seq) => settled.has(seq))) continue
      const row = known.get(unit.key.seq)
      // Its last try ended with its host: counted, and there are no more.
      if (row && row.attempts >= DELIVERY_ATTEMPTS) {
        const gone = await giveUp(me, store, watcher, unit, 'its host stopped during the last try', fence, log)
        if (!gone) return lost()
        for (const seq of gone) settled.add(seq)
        continue
      }
      const begun = await store.begin({ watcher: watcher.name, seq: unit.key.seq, lane: name, fence })
      if (!begun.held) return lost()
      const failure = await runOnce(me, watcher, unit, begun.attempts, halt, grace)
      await yieldNow()
      if (failure === null) {
        if (!(await store.finish({ watcher: watcher.name, seqs: unit.seqs, fence })).held) return lost()
        for (const seq of unit.seqs) settled.add(seq)
        out.delivered += 1
        continue
      }
      out.failed += 1
      log(`failed    ${watcher.name}  at ${unit.key.seq}  try ${begun.attempts} of ${DELIVERY_ATTEMPTS}  ${failure.message}`)
      if (begun.attempts < DELIVERY_ATTEMPTS) continue lanes
      // That was its last try. The rest of its thread goes on.
      const gone = await giveUp(me, store, watcher, unit, failure.why, fence, log)
      if (!gone) return lost()
      for (const seq of gone) settled.add(seq)
    }
  }
  // Everything at or below the cursor is delivered: it stops below the oldest event that isn't, in this
  // stretch or one read before it since the reading last came back round.
  let oldest = Math.min(dropped, state.floor)
  for (const [name, lane] of lanes) {
    for (const seq of [lane.head.seq, ...lane.events.map((event) => event.seq), ...lane.seqs]) {
      if (settled.has(seq)) continue
      oldest = Math.min(oldest, seq)
      blocked.add(name)
    }
  }
  const to = oldest === Infinity ? read : oldest - 1
  if (to > cursor && !(await store.advance(caller, { watcher: watcher.name, to, fence })).held) return lost()
  if (read >= end) state.resume = null
  else {
    state.resume = read
    state.floor = oldest
    state.blocked = blocked
  }
  return out
}

/**
 * One delivery: the event the run is handed (its writes are keyed by it), the event its tries are
 * counted on, and every event it settles. One per event; with `coalesce`, one per thread, the newest
 * standing for the rest and the oldest keeping count, so new events don't reset its tries.
 */
type Unit = { event: FeedEvent; key: FeedEvent; seqs: number[] }

const spanOf = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`)

/**
 * Runs the watcher once. A run still going at its `timeout`, or when `halt` fires, has its `signal`
 * aborted, so the board it was given refuses its writes and a command is told to stop. At its timeout it
 * is left behind at once; on a halt it gets `grace` to finish. Null when it worked; otherwise what to
 * log, and what its note would say.
 */
async function runOnce(me: Board, watcher: Watcher, unit: Unit, attempt: number, halt: AbortSignal, grace: number): Promise<{ message: string; why: string } | null> {
  const controller = new AbortController()
  const board = keyed(me, watcher.name, `watch:${watcher.name}:${unit.event.seq}`, controller.signal)
  const timers: ReturnType<typeof setTimeout>[] = []
  let onHalt = () => {}
  const cut = new Promise<'timeout' | 'stopped'>((resolve) => {
    timers.push(
      setTimeout(() => {
        controller.abort(new Failure('watch_aborted', `Watcher "${watcher.name}" ran past its timeout of ${spanOf(watcher.timeout)}.`))
        resolve('timeout')
      }, watcher.timeout),
    )
    onHalt = () => {
      controller.abort(new Failure('watch_aborted', `Watcher "${watcher.name}"'s host stopped, or another host took the watcher over.`))
      timers.push(setTimeout(() => resolve('stopped'), grace))
    }
    if (halt.aborted) onHalt()
    else halt.addEventListener('abort', onHalt, { once: true })
  })
  const running = Promise.resolve().then(() => watcher.run({ event: unit.event as WatchEvent, board, signal: controller.signal, watcher: { name: watcher.name, as: watcher.as ?? null }, attempt }))
  // A run left behind may still fail later: that is not this host's to report again.
  running.catch(() => {})
  try {
    const ended = await Promise.race([running.then(() => 'ok' as const), cut])
    if (ended === 'timeout') return { message: `timed out after ${spanOf(watcher.timeout)}`, why: `timed out after ${spanOf(watcher.timeout)}` }
    if (ended === 'stopped') return { message: 'its host stopped during it', why: 'its host stopped during it' }
    return null
  } catch (error) {
    const why = (error as { why?: unknown }).why
    return { message: (error as Error)?.message ?? String(error), why: typeof why === 'string' ? why : 'it threw' }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    halt.removeEventListener('abort', onHalt)
  }
}

/**
 * The writes that make something, which a retry must not make twice. Each gets a key from the event and
 * how many of its kind the run has made, unless it brought its own. Setting a label, editing, reacting or
 * deleting land where they land whatever the try, and a later try's value is the one that counts, so
 * they get no key.
 */
const KEYED = new Set(['post', 'reply', 'taskCreate', 'taskPlan'])

const refused = (watcher: string, what: string) => new Failure('forbidden', `Watcher "${watcher}"'s run can't ${what} the board it was given.`, { hint: 'The host owns it: it closes the board, and starts and stops the watchers.' })

/**
 * The board a run writes through. Each write that makes something, without a key of its own, gets one
 * matched by shape (what it is and where): so a try after a throw gets the first try's answers instead
 * of writing again, and a try that writes somewhere else fails loudly. Once the run is aborted, every
 * call is refused, through its `backend` too.
 */
function keyed(me: Board, watcher: string, prefix: string, signal: AbortSignal, counts = new Map<string, number>()): Board {
  const check = () => {
    if (signal.aborted) throw signal.reason instanceof Failure ? signal.reason : new Failure('watch_aborted', `Watcher "${watcher}"'s run was aborted: it may not write now.`)
  }
  const guarded = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, prop, receiver) {
        const value = Reflect.get(inner, prop, receiver) as unknown
        if (prop === 'close') return () => { throw refused(watcher, 'close') }
        if (typeof value === 'object' && value !== null && typeof prop === 'string' && ['leases', 'deliveries', 'tokens', 'joins'].includes(prop)) return guarded(value)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          try {
            check()
          } catch (error) {
            return Promise.reject(error)
          }
          return (value as (...rest: unknown[]) => unknown).apply(inner, args)
        }
      },
    })
  return new Proxy(me, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'as') return (profile: string | null) => keyed(target.as(profile), watcher, prefix, signal, counts)
      if (prop === 'backend') return guarded(target.backend)
      if (prop === 'close' || prop === 'start' || prop === 'deliver') return () => { throw refused(watcher, prop === 'close' ? 'close' : 'start or deliver on') }
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      return async (request?: unknown, ...rest: unknown[]) => {
        check()
        if (!KEYED.has(prop) || request === null || typeof request !== 'object' || (request as { idempotencyKey?: unknown }).idempotencyKey !== undefined) {
          return (value as (...args: unknown[]) => unknown).call(target, request, ...rest)
        }
        const n = (counts.get(prop) ?? 0) + 1
        counts.set(prop, n)
        try {
          return await (value as (...args: unknown[]) => unknown).call(target, { ...request, idempotencyKey: `${prefix}:${prop}:${n}`, idempotencyMatch: 'shape' }, ...rest)
        } catch (error) {
          if ((error as { reason?: unknown }).reason !== 'idempotency_mismatch') throw error
          throw new Failure('idempotency_mismatch', `Watcher "${watcher}" made its ${prop} number ${n} somewhere else than on an earlier try at this event: a try after a throw has to write to the same places.`, {
            hint: 'Pass your own idempotencyKey to a write whose place can change between tries.',
          })
        }
      }
    },
  })
}

/**
 * Stops trying an event, and says so on its thread, once. Only while the lease is still this host's;
 * the note is keyed by the event and matched by shape, so a second try at giving up (after a crash
 * between the note and its record) gets the first note back, whatever it said. The note is marked
 * delivered with the event, so it never wakes the watcher that wrote it.
 */
async function giveUp(me: Board, store: ReturnType<typeof deliveriesOf>, watcher: Watcher, unit: Unit, why: string, fence: Fence, log: (line: string) => void): Promise<number[] | null> {
  if (!(await store.finish({ watcher: watcher.name, seqs: [], fence })).held) return null
  const seqs = [...unit.seqs]
  if (unit.key.thread !== null) {
    const text = `watcher "${watcher.name}" couldn't deliver a wake-up after ${DELIVERY_ATTEMPTS} tries (${why}).`
    const note = await me.reply({ to: unit.key.thread, text, noSync: true, idempotencyKey: `watch:${watcher.name}:${unit.key.seq}:gave-up`, idempotencyMatch: 'shape' }).catch(() => null)
    if (note) seqs.push(note.id)
  }
  log(`gave up   ${watcher.name}  at ${unit.key.seq}  after ${DELIVERY_ATTEMPTS} tries (${why})`)
  return (await store.finish({ watcher: watcher.name, seqs, fence })).held ? seqs : null
}

/** A watcher's own writes never wake it, but a message it scheduled does: that is how it asks to be woken later. */
const own = (watcher: Watcher, event: FeedEvent) => watcher.as !== undefined && event.by.profile === watcher.as && !(event.data as { schedule?: unknown }).schedule

/** Runs each watcher once, under its lease, taken for the pass and not renewed: for tests. */
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
      const did = await pass(team, watcher, { name, holder, epoch: taken.epoch }, stateOf(states, watcher.name), new AbortController().signal, GRACE, log)
      out.delivered += did.delivered
      out.failed += did.failed
    } finally {
      await leases.release({ name, holder, epoch: taken.epoch })
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
 * it, ready to take over when that host stops renewing. A renewal that finds the lease taken signals
 * the run in flight at once. Nothing it meets ends it but a stop.
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
    const taken = new AbortController()
    try {
      held = await holdLease(leases, `watch:${watcher.name}`, { ...options.lease, sleep, stop, onLost: () => taken.abort() })
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
    const halt = AbortSignal.any([stop, taken.signal])
    let quiet = 100
    try {
      while (!stop.aborted) {
        if (held.lost()) {
          log(`lost      ${watcher.name}  another host runs it now`)
          break
        }
        try {
          const did = await pass(team, watcher, { name: `watch:${watcher.name}`, holder: held.holder, epoch: held.epoch }, state, halt, options.grace ?? GRACE, log)
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
type Running = { host: Host; team: Board; names: string }
/** The hosts running in this process, by board: kept on `globalThis`, so two copies of a module (as Next.js loads) find each other. */
const hosts = (): Map<unknown, Running> => ((globalThis as Record<symbol, unknown>)[HOSTS] ??= new Map()) as Map<unknown, Running>

const namesOf = (watchers: Watcher[]) => watchers.map((watcher) => watcher.name).sort().join(', ') || 'none'

/** A watcher in `watchers.json` and one in code with the same name would share a cursor, and each skip what the other delivered. */
function refuseClash(watchers: Watcher[]) {
  let configured: { name: string }[]
  try {
    configured = loadWatchers()
  } catch {
    // A file the daemon can't read is the daemon's to say so.
    return
  }
  const both = watchers.find((watcher) => configured.some((entry) => entry.name === watcher.name))
  if (both) throw new Failure('invalid_watch', `Watcher "${both.name}" is in ${watchersPath()} and in code: they would share one place on the board.`, { exit: 2, hint: 'Rename one, or remove it from watchers.json.' })
}

/**
 * Starts the board's watchers in this process, each in its own loop, and returns at once. Never await
 * `done` where a server starts up: it settles only when the host stops. A second `start()` on the same
 * handle, or on another copy of the same module (the same watchers), returns the host already running;
 * one with other watchers for a board this process already runs is refused.
 */
export function start(team: Board, watchers: Watcher[], states: Map<string, WatchState>, options: StartOptions = {}, sync = false): Host {
  if (watchers.length > 0 || sync) leasesOf(team)
  if (watchers.length > 0) {
    leasesOf(team)
    deliveriesOf(team)
  }
  const backend = team.backend
  // A board in memory is its own: two of them share a path (":memory:") and nothing else.
  const key = backend.kind === 'file' && backend.where !== ':memory:' ? backend.where : backend
  const names = namesOf(watchers)
  const running = hosts().get(key)
  if (running) {
    if (running.team === team || running.names === names) return running.host
    throw new Failure('watch_started', `This process already runs the watchers of ${backend.where} from another board() handle (${running.names}); this one declares ${names}.`, {
      hint: 'Declare every watcher on one handle, and start that one.',
    })
  }
  refuseClash(watchers)
  const log = options.log ?? ((line: string) => process.stderr.write(`muster: ${line}\n`))
  const controller = new AbortController()
  const stopNow = () => {
    controller.abort()
    // A start() after this is a new host, though this one is still finishing what it ran.
    if (hosts().get(key)?.host === host) hosts().delete(key)
  }
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', stopNow, { once: true })
  const loops = watchers.map((watcher) =>
    // A loop doesn't throw; if one ever did, the host says so rather than leave a rejection nobody awaits.
    loop(team, watcher, controller.signal, options, stateOf(states, watcher.name), log).catch((error) => log(`stopped   ${watcher.name}  ${(error as Error).message}`)),
  )
  // The board's sync, under its own `sync` lease: one host sends to the platforms, whichever runs the watchers.
  if (sync) loops.push(syncLoop(team, leasesOf(team), controller.signal, sleeper(controller.signal), options, log).catch((error) => log(`stopped   sync  ${(error as Error).message}`)))
  const done = Promise.all(loops).then(() => {
    options.signal?.removeEventListener('abort', stopNow)
    if (hosts().get(key)?.host === host) hosts().delete(key)
  })
  const host: Host = { stop: stopNow, done }
  hosts().set(key, { host, team, names })
  return host
}
