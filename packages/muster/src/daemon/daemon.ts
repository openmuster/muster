import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { forName, kindsValid } from '../model.ts'
import { holdLease, type Held } from './lease.ts'
import { armHooks, hooksPath, loadHooks, runHook, type ArmedHook, type Hook, type HookDeps, type HookState } from './hooks.ts'
import { openRuns, runWorkflows, spawnWorker, type Ran, type RunDeps } from './runs.ts'
import { loadWorkflows, workflowsPath, type Workflow } from './workflows.ts'
import { runWatcher, type Deps, type Watcher, type WatchState } from './watchers.ts'

export const watchersPath = () => join(configDir(), 'watchers.json')

/** The operator's watchers. A file that is missing means none; one that is wrong is a config error. */
export function loadWatchers(path = watchersPath()): Watcher[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { watchers?: unknown }).watchers
  if (!Array.isArray(list)) throw new Failure('invalid_config', `${path} needs a "watchers" array.`)
  const names = new Set<string>()
  return list.map((entry: Watcher, index) => {
    if (typeof entry?.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(entry.name)) throw new Failure('invalid_config', `Watcher ${index + 1} in ${path} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
    if (names.has(entry.name)) throw new Failure('invalid_config', `Two watchers in ${path} are named "${entry.name}".`)
    names.add(entry.name)
    if (!Array.isArray(entry.run) || entry.run.length === 0 || !entry.run.every((part) => typeof part === 'string')) throw new Failure('invalid_config', `Watcher "${entry.name}" needs "run": the command as an array of strings.`)
    // A bad `for` would fail every tick and hold up the watchers after it: say so when the file is read.
    if (entry.tail?.for !== undefined) {
      try {
        if (typeof entry.tail.for !== 'string') throw new Error()
        forName(entry.tail.for)
      } catch {
        throw new Failure('invalid_config', `Watcher "${entry.name}" has a "for" that isn't a profile name or an actor ID: ${JSON.stringify(entry.tail.for)}.`)
      }
    }
    const kinds = entry.tail?.kinds as unknown
    if (kinds !== undefined && !kindsValid(kinds)) {
      throw new Failure('invalid_config', `Watcher "${entry.name}" has "kinds" that aren't a list of hold kinds, each with "!" in front to leave it out: ${JSON.stringify(kinds)}.`)
    }
    return { name: entry.name, tail: entry.tail ?? {}, run: entry.run, ...(entry.gate ? { gate: entry.gate } : {}), ...(entry.as ? { as: entry.as } : {}), ...(entry.every !== undefined ? { every: entry.every } : {}), ...(Array.isArray(entry.env) ? { env: entry.env.map(String) } : {}) }
  })
}

/**
 * Everything the daemon runs from the operator's config: watchers, outgoing webhooks and registered
 * workflows. `mu daemon check` takes a watcher or a hook by name, so one name can't be both, and a
 * workflow keeps its name to itself too.
 */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env, code?: InCode): { watchers: Watcher[]; hooks: Hook[]; workflows: Workflow[]; arm: () => ArmedHook[] } {
  const watchers = loadWatchers()
  const hooks = loadHooks()
  const both = hooks.find((hook) => watchers.some((watcher) => watcher.name === hook.name))
  if (both) throw new Failure('invalid_config', `A watcher in ${watchersPath()} and a hook in ${hooksPath()} are both named "${both.name}".`)
  const workflows = loadWorkflows()
  for (const workflow of workflows) {
    if (watchers.some((watcher) => watcher.name === workflow.name)) throw new Failure('invalid_config', `A workflow in ${workflowsPath()} and a watcher in ${watchersPath()} are both named "${workflow.name}".`)
    if (hooks.some((hook) => hook.name === workflow.name)) throw new Failure('invalid_config', `A workflow in ${workflowsPath()} and a hook in ${hooksPath()} are both named "${workflow.name}".`)
  }
  if (code) {
    const clash = clashWithCode(code, { watchers, hooks, workflows })
    if (clash) throw clash
  }
  return { watchers, hooks, workflows, arm: () => armHooks(hooks, env) }
}

/** The watchers a board module declares: where it is, and their names. */
export type InCode = { path: string; names: readonly string[] }

/**
 * A module's watcher named like a watcher, a hook or a workflow in the config files. A watcher's name is
 * its cursor and its lease, and `mu daemon check` takes any of them by name: one name is one thing.
 */
export function clashWithCode(code: InCode, config: { watchers?: readonly { name: string }[]; hooks?: readonly { name: string }[]; workflows?: readonly { name: string }[] }): Failure | null {
  const kinds = [
    ['watcher', watchersPath(), config.watchers ?? []],
    ['hook', hooksPath(), config.hooks ?? []],
    ['workflow', workflowsPath(), config.workflows ?? []],
  ] as const
  for (const name of code.names) {
    for (const [kind, path, list] of kinds) {
      if (list.some((entry) => entry.name === name)) {
        return new Failure('invalid_config', `A watcher in ${code.path} and a ${kind} in ${path} are both named "${name}".`, { hint: `Rename one: a name is one watcher, hook or workflow, whichever file it is in.` })
      }
    }
  }
  return null
}

const WATCHER_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'MUSTER_DIR', 'MUSTER_BOARD', 'MUSTER_CONFIG', 'MUSTER_URL', 'MUSTER_INSECURE_HTTP']

/**
 * What a watcher's command starts with: built from nothing, then the few names above. The daemon holds
 * the platforms' secrets in its own environment, and what it wakes is often an agent reading text a
 * stranger wrote, so nothing else is passed on unless the watcher's config names it.
 */
export function watcherEnv(extra: Record<string, string>, allow: readonly string[] = [], from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...WATCHER_ENV, ...allow]) if (from[name] !== undefined) env[name] = from[name]!
  return { ...env, ...extra }
}

/** Runs a command to its end and keeps what it printed. A command that can't start counts as a failure. */
export const spawnCommand: Deps['spawn'] = (command, env, allow) =>
  new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { env: watcherEnv(env, allow), stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', () => resolve({ code: 127, stdout }))
    child.on('exit', (code) => resolve({ code, stdout }))
  })

export type DaemonOptions = {
  team: Board
  /**
   * The `tick` lease, in the board's own file and shared with `mu serve`, so only one process ticks:
   * how long it lasts unrenewed and how often it is renewed, in milliseconds. Shorter in tests.
   */
  lease?: { ttl?: number; every?: number }
  watchers: Watcher[]
  /** Outgoing webhooks, with their secrets already read. */
  hooks?: ArmedHook[]
  /**
   * Registered workflows: what a request on a thread may start. Left out, requests aren't read at all, so
   * a workflows file that couldn't be loaded loses none: they are answered once it is fixed.
   */
  workflows?: Workflow[]
  stop: AbortSignal
  log: (line: string) => void
  deps?: Partial<Deps & HookDeps> & { spawnWorker?: RunDeps['spawn'] }
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

/** What a tick needs to send outgoing webhooks: the hooks, and what each has been through since the daemon started. */
export type Hooks = { list: ArmedHook[]; states: Map<string, HookState>; deps: HookDeps; notes?: Set<number> }

/** What a tick needs to start requested workflows: the registered ones, and how to start a worker. */
export type Workflows = { list: Workflow[]; deps: RunDeps }

/** One pass: send what is due, run each watcher, each outgoing webhook, then requested workflows. Returns what it did, for logs and tests. */
export async function tickOnce(team: Board, watchers: Watcher[], states: Map<string, WatchState>, deps: Deps, hooks?: Hooks, workflows?: Workflows) {
  const schedules = await team.scheduleTick()
  const synced = await team.backend.syncTick()
  const watched: Record<string, Awaited<ReturnType<typeof runWatcher>>> = {}
  for (const watcher of watchers) {
    let state = states.get(watcher.name)
    if (!state) states.set(watcher.name, (state = { last: -Infinity, attempts: 0 }))
    watched[watcher.name] = await runWatcher(team, watcher, state, deps)
  }
  const hooked: Record<string, Awaited<ReturnType<typeof runHook>>> = {}
  for (const hook of hooks?.list ?? []) {
    let state = hooks!.states.get(hook.name)
    if (!state) hooks!.states.set(hook.name, (state = { attempts: 0, retryAt: -Infinity }))
    hooked[hook.name] = await runHook(team, hook, state, hooks!.deps, (hooks!.notes ??= new Set()))
  }
  // Read even with none registered: a request for one this daemon hasn't got is answered, never left unsaid.
  const ran: Ran | null = workflows ? await runWorkflows(team, workflows.list, workflows.deps) : null
  return { schedules, watched, hooked, workflows: ran, synced }
}

/**
 * The board's ticker: schedules and watchers, until told to stop, while this process holds the board's
 * `tick` lease. Returns 'held' when another process ticks for this board, or takes over from this one.
 */
export async function runDaemon(options: DaemonOptions): Promise<'stopped' | 'held'> {
  const leases = options.team.backend.leases
  if (!leases) throw new Failure('forbidden', `The board at ${options.team.backend.where} is ticked by the server it is on.`, { hint: 'Run the daemon on that machine, or mu serve there.' })
  const deps: Deps & HookDeps = { now: () => Date.now(), spawn: spawnCommand, fetch, ...options.deps }
  const states = new Map<string, WatchState>()
  const hooks: Hooks = { list: options.hooks ?? [], states: new Map(), deps }
  const workflows: Workflows | undefined = options.workflows ? { list: options.workflows, deps: { spawn: options.deps?.spawnWorker ?? spawnWorker, now: deps.now, runs: openRuns() } } : undefined
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
  const began = deps.now()
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
        const did = await tickOnce(options.team, options.watchers, states, deps, hooks, workflows)
        failing = 0
        said = ''
        if (!steadied && deps.now() - began >= options.steady!.after) {
          steadied = true
          options.steady!.then()
        }
        for (const id of did.schedules.sent) options.log(`sent      schedule ${id}`)
        for (const id of did.schedules.skipped) options.log(`skipped   schedule ${id}`)
        for (const id of did.schedules.canceled) options.log(`canceled  schedule ${id}  its token was revoked`)
        for (const [name, result] of Object.entries(did.watched)) {
          if (result.woke.length) options.log(`woke      ${name}  ${result.woke.length}`)
          if (result.failed.length) options.log(`failed    ${name}  at ${result.failed[0]}`)
          if (result.slowed) options.log(`slowed    ${name}  its command keeps failing: next run in ${result.slowed}s`)
        }
        for (const [name, result] of Object.entries(did.hooked)) {
          if (result.sent.length) options.log(`sent      hook ${name}  ${result.sent.length}`)
          if (result.failed.length) options.log(`failed    hook ${name}  at ${result.failed[0]}  ${result.why}`)
          if (result.dropped.length) options.log(`dropped   hook ${name}  ${result.dropped.join(' ')}  ${result.why}`)
        }
        for (const note of did.synced.skipped ?? []) options.log(`skipped   sync ${note}`)
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
    await lease.release()
  }
}
