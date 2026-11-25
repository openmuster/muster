import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import type { FeedEvent, Filter } from '../core/reads.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { kindsValid } from '../model.ts'
import { isEnv, nameOf, type Env } from '../config/env.ts'
import { checkFilter } from '../watch/watch.ts'
import { holdLease, LEASE_TTL, type Held } from './lease.ts'

/**
 * An outgoing webhook, from the operator's config file: what to listen for and where to send it. Like
 * a watcher it is never read from a board, so nothing written to one can make the daemon call a URL.
 */
export type Hook = {
  name: string
  url: string
  /** The name of the environment variable that holds the signing secret. The secret itself is never in the file. */
  secret: string
  tail: Filter
  /** What a delivery carries: a pointer to the event, or the event as `mu tail --json` prints it. */
  body: 'pointer' | 'event'
}

/** A hook with its secret read from the environment: what the daemon sends with. */
export type ArmedHook = Hook & { key: string }

export type HookDeps = {
  now: () => number
  fetch: typeof fetch
  /** Milliseconds one request may take. */
  timeout?: number
  /** Milliseconds one hook may spend sending in one pass. */
  budget?: number
}

export type HookState = { attempts: number; retryAt: number }
export type Sent = { ok: boolean; status: number | null; error?: string }

export const HOOK_ATTEMPTS = 8
/** Events one hook sends in one tick, so a busy board or a slow receiver never holds up schedules and watchers. */
export const HOOK_BATCH = 20
const BUDGET = 10_000
const MIN_SECRET = 16

/** What the daemon writes on a thread when it gives up on an event. `mu daemon check` reads past it, as it does a watcher's. */
export const DROPPED = /^outgoing webhook ".*" couldn't deliver event \d+/

export const hooksPath = () => join(configDir(), 'hooks.json')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The operator's outgoing webhooks. A file that is missing means none; one that is wrong is a config error. */
export function loadHooks(path = hooksPath()): Hook[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { hooks?: unknown } | null)?.hooks
  if (!Array.isArray(list)) throw new Failure('invalid_config', `${path} needs a "hooks" array.`)
  const names = new Set<string>()
  return list.map((entry: Partial<Hook> | null, index) => {
    const secret = entry?.secret
    const hook = checkHook(entry, index, names, { where: path, fail: (why) => new Failure('invalid_config', why), filter: (name, tail) => {
      if (typeof tail !== 'object' || tail === null || Array.isArray(tail)) throw new Failure('invalid_config', `"tail" of hook "${name}" in ${path} is a filter, as an object.`)
      if ((tail as Filter).kinds !== undefined && !kindsValid((tail as Filter).kinds)) throw new Failure('invalid_config', `"kinds" of hook "${name}" in ${path} is a list of hold kinds, each with "!" in front to leave it out.`)
      return tail as Filter
    } })
    if (typeof secret !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) throw new Failure('invalid_config', `"secret" of hook "${hook.name}" in ${path} names an environment variable: "env:NAME".`)
    return { ...hook, secret: secret.slice(4) }
  })
}

/** An outgoing webhook as `board({ hooks })` takes it: a `hooks.json` entry, with its secret named by `env()`. */
export type HookOptions = {
  name: string
  url: string
  /** The environment variable that holds the signing secret: `env('AUDIT_SECRET')`. Read when the host starts. */
  secret: Env
  /** What to send: a filter like `mu tail`'s. Left out, every event. */
  tail?: Filter
  /** What a delivery carries. Default `pointer`. */
  body?: 'pointer' | 'event'
}

const HOOK_KEYS = new Set(['name', 'url', 'secret', 'tail', 'body'])
/** Where a module's hooks are, as their errors say. */
export const IN_CODE = 'board({ hooks })'

/** Hooks in code and a `hooks.json` at once would be two lists of one thing, sent by two hosts under two leases: refused. */
export function hooksFileClash(where = IN_CODE): Failure | null {
  if (!existsSync(hooksPath())) return null
  return new Failure('invalid_config', `${where} declares outgoing webhooks, and ${hooksPath()} is there too.`, { hint: "Keep hooks in one place: move each entry into board({ hooks }), with secret: env('NAME') for \"env:NAME\", and delete hooks.json." })
}

/**
 * Checks the hooks given to `board()` when it is called, by the rules `hooks.json` keeps, so a bad one
 * is the module's mistake, said once with its name. The secret is kept as the name of its variable.
 */
export function checkHooks(hooks: unknown): Hook[] {
  if (hooks === undefined) return []
  const fail = (why: string) => new Failure('invalid_hook', why, { exit: 2 })
  if (!Array.isArray(hooks)) throw fail("`hooks` is a list of outgoing webhooks: [{ name, url, secret: env('NAME'), tail }].")
  const names = new Set<string>()
  return hooks.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`Hook ${index + 1} in ${IN_CODE} is not an object: { name, url, secret, tail }.`)
    const hook = checkHook(entry as Partial<Hook>, index, names, { where: IN_CODE, fail, filter: (name, tail) => checkFilter(name, tail, (why) => fail(`Hook "${name}" ${why}`)) })
    for (const key of Object.keys(entry)) if (!HOOK_KEYS.has(key)) throw fail(`Hook "${hook.name}" in ${IN_CODE} has "${key}", which a hook doesn't take. It takes ${[...HOOK_KEYS].join(', ')}.`)
    const secret = (entry as { secret?: unknown }).secret
    if (!isEnv(secret)) throw fail(`"secret" of hook "${hook.name}" in ${IN_CODE} names an environment variable with env(): secret: env('${typeof secret === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(secret) ? secret : 'NAME'}'). The secret itself is never in the module.`)
    return { ...hook, secret: nameOf(secret) }
  })
}

type Rules = { where: string; fail: (why: string) => Failure; filter: (name: string, tail: unknown) => Filter }

/** What a hook needs wherever it is declared: a name of its own, a URL that keeps what it carries private, a filter and a body. */
function checkHook(entry: Partial<Hook> | null, index: number, names: Set<string>, rules: Rules): Omit<Hook, 'secret'> {
  const { where, fail } = rules
  const name = entry?.name
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw fail(`Hook ${index + 1} in ${where} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
  if (names.has(name)) throw fail(`Two hooks in ${where} are named "${name}".`)
  names.add(name)
  let url: URL
  try {
    url = new URL(String(entry?.url))
  } catch {
    throw fail(`Hook "${name}" in ${where} needs a "url".`)
  }
  // A delivery can carry what the board says, and a signature proves who sent it, not that nobody read it.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw fail(`Hook "${name}" in ${where} needs an https URL. Plain http is only for this machine.`)
  if (url.username || url.password) throw fail(`Hook "${name}" in ${where} has a password in its URL. The signature is how a receiver knows it is you.`)
  const body = entry?.body ?? 'pointer'
  if (body !== 'pointer' && body !== 'event') throw fail(`"body" of hook "${name}" in ${where} is "pointer" or "event".`)
  const tail = rules.filter(name, entry?.tail ?? {})
  return { name, url: url.href, tail, body }
}

/** Reads each hook's secret from the environment. One that is missing or short is a config error, not an unsigned send. */
export function armHooks(hooks: Hook[], env: NodeJS.ProcessEnv = process.env, path: string = hooksPath()): ArmedHook[] {
  return hooks.map((hook) => {
    const key = env[hook.secret]
    if (!key) throw new Failure('invalid_config', `${hook.secret} isn't set, and hook "${hook.name}" in ${path} signs with it.`)
    if (Buffer.byteLength(key) < MIN_SECRET) throw new Failure('invalid_config', `${hook.secret} is too short to sign with: hook "${hook.name}" needs ${MIN_SECRET} characters or more.`)
    return { ...hook, key }
  })
}

/** The signature a receiver checks: HMAC-SHA256, in hex, over the delivery's ID, its time and the exact bytes of the body. */
export const sign = (key: string, delivery: string, timestamp: number, body: string) => createHmac('sha256', key).update(`${delivery}.${timestamp}.${body}`).digest('hex')

const pointer = (event: FeedEvent) => ({ seq: event.seq, type: event.type, at: event.at, channel: event.channel, thread: event.thread, by: event.by })

/** One signed POST. Anything but a 2xx answer is a failure: a redirect is not followed, so a body never goes where the config didn't say. */
export async function send(hook: ArmedHook, delivery: string, event: unknown, deps: HookDeps): Promise<Sent> {
  const body = JSON.stringify({ hook: hook.name, delivery, event })
  const timestamp = Math.floor(deps.now() / 1000)
  try {
    const response = await deps.fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeout ?? 10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'muster',
        'muster-delivery': delivery,
        'muster-timestamp': String(timestamp),
        'muster-signature': `v1=${sign(hook.key, delivery, timestamp, body)}`,
      },
      body,
    })
    await response.body?.cancel().catch(() => {})
    return { ok: response.status >= 200 && response.status < 300, status: response.status }
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    return { ok: false, status: null, error: (error as Error).name === 'TimeoutError' ? 'timed out' : (cause?.code ?? cause?.message ?? (error as Error).message) }
  }
}

/** A signed delivery that is no event, for `mu daemon check`: proof the URL answers and the receiver accepts the signature. */
export const ping = (hook: ArmedHook, deps: HookDeps) => send(hook, `${hook.name}.ping.${deps.now()}`, { type: 'ping', at: new Date(deps.now()).toISOString() }, deps)

export const why = (sent: Sent) => (sent.status === null ? (sent.error ?? 'no answer') : `HTTP ${sent.status}`)

/** Seconds to wait after the nth failure in a row: 5, 10, 20, and so on, to five minutes at most. */
const backoff = (attempts: number) => Math.min(5 * 2 ** (attempts - 1), 300) * 1000

/**
 * Runs one hook once: sends what matched since its cursor, one delivery per event, in order, and moves
 * the cursor only past what was delivered. A failure waits and tries the same event again, so a
 * receiver sees every event at least once and never out of order. An event that still fails after
 * eight tries is recorded on its thread and passed over, so one bad event never holds the rest for ever.
 *
 * `notes` holds the IDs of those records, as the board gave them back. No hook sends one on, or a dead
 * receiver would feed itself. They are known by ID and never by their words, so nobody can write a
 * message that a hook leaves out.
 */
export async function runHook(team: Board, hook: ArmedHook, state: HookState, deps: HookDeps, notes: Set<number> = new Set()): Promise<{ sent: number[]; failed: number[]; dropped: number[]; why?: string }> {
  const out: { sent: number[]; failed: number[]; dropped: number[]; why?: string } = { sent: [], failed: [], dropped: [] }
  if (deps.now() < state.retryAt) return out
  const name = `hook:${hook.name}`
  let cursor = await team.cursorGet(name)
  if (cursor === null) {
    // A new hook starts from now: it never replays a board's history at a receiver.
    cursor = await team.head()
    await team.cursorSet(name, cursor)
  }
  const page = await team.events({ after: cursor, filter: hook.tail, limit: HOOK_BATCH })
  let reached = page.cursor
  const started = Date.now()
  for (const event of page.events) {
    if (event.type === 'message.posted' && notes.has(event.seq)) continue
    if (Date.now() - started > (deps.budget ?? BUDGET)) {
      reached = event.seq - 1
      break
    }
    const sent = await send(hook, `${hook.name}.${event.seq}`, hook.body === 'event' ? event : pointer(event), deps)
    if (sent.ok) {
      state.attempts = 0
      out.sent.push(event.seq)
      continue
    }
    out.why = why(sent)
    state.attempts += 1
    if (state.attempts < HOOK_ATTEMPTS) {
      // Stop before this event: the cursor stays behind it, and it is tried again after a wait.
      state.retryAt = deps.now() + backoff(state.attempts)
      reached = event.seq - 1
      out.failed.push(event.seq)
      break
    }
    state.attempts = 0
    out.dropped.push(event.seq)
    if (event.thread !== null) {
      const note = await team.reply({ to: event.thread, text: `outgoing webhook "${hook.name}" couldn't deliver event ${event.seq} after ${HOOK_ATTEMPTS} tries (${out.why}).`, noSync: true }).catch(() => null)
      if (note) notes.add(note.id)
    }
  }
  if (reached > cursor) await team.cursorSet(name, reached)
  return out
}

/** The lease a board module's hooks are sent under: one host sends them all, so each goes out once, in order. */
export const HOOKS_LEASE = 'hooks'

export type HostHooksOptions = {
  log: (line: string) => void
  /** The `hooks` lease, in milliseconds: how long it lasts unrenewed, how often it is renewed, how often a waiting host looks. */
  lease?: { ttl?: number; every?: number; wait?: number }
  /** Milliseconds between passes. */
  interval?: number
  deps?: Partial<HookDeps>
}

/**
 * Sends a board module's hooks while this process holds the `hooks` lease, and stands by while another
 * holds it, ready to take over when that one stops renewing. Each pass is `runHook` for each hook, in
 * the order given: the same deliveries, signatures, tries and order as hooks the daemon sends from
 * `hooks.json`. Nothing it meets ends it but a stop.
 */
export async function hostHooks(team: Board, hooks: ArmedHook[], stop: AbortSignal, options: HostHooksOptions): Promise<void> {
  const leases = team.backend.leases
  if (!leases || hooks.length === 0) return
  const { log } = options
  const sleep = (ms: number) =>
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
  const deps: HookDeps = { now: () => Date.now(), fetch, ...options.deps }
  // What each hook has been through since this host started, and the notes it wrote: kept across leases, as the daemon keeps them across ticks.
  const states = new Map<string, HookState>()
  const notes = new Set<number>()
  let said = ''
  const fail = (error: unknown) => {
    const message = (error as Error).message
    if (message !== said) log(`error     hooks  ${message}`)
    said = message
  }
  while (!stop.aborted) {
    let held: Held | null = null
    try {
      held = await holdLease(leases, HOOKS_LEASE, { ...options.lease, sleep, stop })
    } catch (error) {
      fail(error)
      await sleep(1000)
      continue
    }
    if (!held) {
      // Another host sends them. Look again once its lease could have lapsed.
      await sleep(options.lease?.ttl ?? LEASE_TTL)
      continue
    }
    try {
      while (!stop.aborted) {
        if (held.lost()) {
          log('lost      hooks  another host sends them now')
          break
        }
        for (const hook of hooks) {
          if (stop.aborted || held.lost()) break
          let state = states.get(hook.name)
          if (!state) states.set(hook.name, (state = { attempts: 0, retryAt: -Infinity }))
          try {
            const result = await runHook(team, hook, state, deps, notes)
            said = ''
            if (result.sent.length) log(`sent      hook ${hook.name}  ${result.sent.length}`)
            if (result.failed.length) log(`failed    hook ${hook.name}  at ${result.failed[0]}  ${result.why}`)
            if (result.dropped.length) log(`dropped   hook ${hook.name}  ${result.dropped.join(' ')}  ${result.why}`)
          } catch (error) {
            fail(error)
          }
        }
        await sleep(options.interval ?? 1000)
      }
    } finally {
      await held.release()
    }
  }
}
