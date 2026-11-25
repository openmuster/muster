import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { holdLease, type Held } from './lease.ts'
import { syncLoop } from '../sync/host.ts'
import { openRuns, runWorkflows, spawnWorker, type Ran, type RunDeps } from './runs.ts'
import { loadWorkflows, workflowsPath, type Workflow } from './workflows.ts'

/** What a board module declares, by name: where it is, its watchers, and its outgoing webhooks. */
export type InCode = { path: string; names: readonly string[]; hooks?: readonly string[] }

/**
 * A module's watcher or hook named like a workflow in `workflows.json`. A watcher's name is its cursor
 * and its lease, and `mu daemon check` takes a watcher or a hook by name: one name is one thing.
 */
export function clashWithWorkflows(code: InCode, workflows: readonly { name: string }[]): Failure | null {
  for (const [mine, names] of [['watcher', code.names], ['hook', code.hooks ?? []]] as const) {
    for (const name of names) {
      if (workflows.some((workflow) => workflow.name === name)) {
        return new Failure('invalid_config', `A ${mine} in ${code.path} and a workflow in ${workflowsPath()} are both named "${name}".`, { hint: 'Rename one: a name is one watcher, hook or workflow.' })
      }
    }
  }
  return null
}

/** The registered workflows the daemon starts, refused when one is named like something the module declares. */
export function daemonWorkflows(code?: InCode): Workflow[] {
  const workflows = loadWorkflows()
  const clash = code ? clashWithWorkflows(code, workflows) : null
  if (clash) throw clash
  return workflows
}

export type DaemonOptions = {
  team: Board
  /**
   * The `tick` lease, in the board's own file and shared with `mu serve`, so only one process ticks:
   * how long it lasts unrenewed and how often it is renewed, in milliseconds. Shorter in tests.
   */
  lease?: { ttl?: number; every?: number }
  /**
   * Registered workflows: what a request on a thread may start. Left out, requests aren't read at all, so
   * a workflows file that couldn't be loaded loses none: they are answered once it is fixed.
   */
  workflows?: Workflow[]
  stop: AbortSignal
  log: (line: string) => void
  deps?: { now?: () => number; spawnWorker?: RunDeps['spawn'] }
  /** Milliseconds between ticks. A tick is cheap; a long sleep would only delay what is due. */
  interval?: number
  /**
   * Called once, after a tick that worked, when the daemon has been up `after` milliseconds by `deps.now`.
   * `mu daemon run` uses it to forget its recent starts: a run that stays up was not part of a storm.
   */
  steady?: { after: number; then: () => void }
  /** Waits between ticks, until the time is up or the daemon is told to stop. Faked in tests. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * The longest pause between ticks that keep failing. A board that can't be read is tried again, slowly.
 * Kept under the minute after which a gap between ticks reads as the machine asleep, and under the
 * shortest grace a schedule has, so a pause never skips a slot or extends a lease.
 */
export const FAILING_PAUSE = 30_000

/** What a tick needs to start requested workflows: the registered ones, and how to start a worker. */
export type Workflows = { list: Workflow[]; deps: RunDeps }

/** One pass: send what is due, then start requested workflows. Returns what it did, for logs and tests. */
export async function tickOnce(team: Board, workflows?: Workflows) {
  const schedules = await team.scheduleTick()
  // Read even with none registered: a request for one this daemon hasn't got is answered, never left unsaid.
  const ran: Ran | null = workflows ? await runWorkflows(team, workflows.list, workflows.deps) : null
  return { schedules, workflows: ran }
}

/**
 * The board's ticker: schedules and requested workflows, until told to stop, while this process holds the board's
 * `tick` lease. Returns 'held' when another process ticks for this board, or takes over from this one.
 */
export async function runDaemon(options: DaemonOptions): Promise<'stopped' | 'held'> {
  const leases = options.team.backend.leases
  if (!leases) throw new Failure('forbidden', `The board at ${options.team.backend.where} is ticked by the server it is on.`, { hint: 'Run the daemon on that machine, or mu serve there.' })
  const now = options.deps?.now ?? (() => Date.now())
  const workflows: Workflows | undefined = options.workflows ? { list: options.workflows, deps: { spawn: options.deps?.spawnWorker ?? spawnWorker, now, runs: openRuns() } } : undefined
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms)
        function done() {
          clearTimeout(timer)
          options.stop.removeEventListener('abort', done)
          resolve()
        }
        options.stop.addEventListener('abort', done)
      }))
  // Taken before the first tick, and failing like opening the board would: a board that can't be opened
  // is a start that failed, as it was with a lock file. A holder that is alive means another process
  // ticks; one that has died (this daemon, before launchd restarted it) is waited out, then replaced.
  const lease: Held | null = await holdLease(leases, 'tick', { ...options.lease, sleep, stop: options.stop })
  // Told to stop while it waited is a stop, not another process ticking.
  if (!lease) return options.stop.aborted ? 'stopped' : 'held'
  // A sync given to the backend (`board({ backend: file({ sync }) })`) runs beside the tick, under the board's
  // `sync` lease: the one a module's host takes too, so whichever processes run, one sends. A sync declared on
  // the handle (`board({ sync })`) is run by its start(), not here.
  const syncStop = new AbortController()
  const syncing = !options.team.sync?.length && options.team.backend.syncs?.length
    ? syncLoop(options.team, leases, AbortSignal.any([options.stop, syncStop.signal]), { ...(options.lease ? { lease: options.lease } : {}) }, options.log).catch((error) => options.log(`stopped   sync  ${(error as Error).message}`))
    : null
  const began = now()
  let steadied = !options.steady
  // Ticks that failed in a row, and the last error said: the same error is logged once, then at 2, 4, 8... in a row.
  let failing = 0
  let said = ''
  try {
    while (!options.stop.aborted) {
      // Lost only when someone else took it, after this process went longer than a lease without renewing
      // (a machine asleep, a board too busy to write): two tickers at once is what the lease is for.
      if (lease.lost()) {
        options.log('lost      the tick lease: another process ticks for this board now')
        return 'held'
      }
      try {
        const did = await tickOnce(options.team, workflows)
        failing = 0
        said = ''
        if (!steadied && now() - began >= options.steady!.after) {
          steadied = true
          options.steady!.then()
        }
        for (const id of did.schedules.sent) options.log(`sent      schedule ${id}`)
        for (const id of did.schedules.skipped) options.log(`skipped   schedule ${id}`)
        for (const id of did.schedules.canceled) options.log(`canceled  schedule ${id}  its token was revoked`)
        if (did.workflows?.started.length) options.log(`started   workflow  ${did.workflows.started.join(' ')}`)
        if (did.workflows?.refused.length) options.log(`refused   workflow  ${did.workflows.refused.join(' ')}`)
        if (did.workflows?.reported?.length) options.log(`reported  workflow  ${did.workflows.reported.join(' ')}`)
        if (did.workflows?.updated?.length) options.log(`updated   workflow  ${did.workflows.updated.join(' ')}`)
        if (did.workflows?.why) options.log(`failed    workflow  ${did.workflows.why}`)
      } catch (error) {
        const message = (error as Error).message
        failing += 1
        if (message !== said) options.log(`error     ${message}`)
        else if ((failing & (failing - 1)) === 0) options.log(`error     ${message}  (${failing} ticks in a row)`)
        said = message
      }
      const interval = options.interval ?? 1000
      await sleep(failing ? Math.min(FAILING_PAUSE, Math.max(interval, interval * 2 ** failing)) : interval)
    }
    return 'stopped'
  } finally {
    syncStop.abort()
    await syncing
    await lease.release()
  }
}
