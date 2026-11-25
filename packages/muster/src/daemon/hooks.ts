import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import type { FeedEvent, Filter } from '../core/reads.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { kindsValid } from '../model.ts'

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
    const name = entry?.name
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Failure('invalid_config', `Hook ${index + 1} in ${path} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
    if (names.has(name)) throw new Failure('invalid_config', `Two hooks in ${path} are named "${name}".`)
    names.add(name)
    let url: URL
    try {
      url = new URL(String(entry?.url))
    } catch {
      throw new Failure('invalid_config', `Hook "${name}" in ${path} needs a "url".`)
    }
    // A delivery can carry what the board says, and a signature proves who sent it, not that nobody read it.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Failure('invalid_config', `Hook "${name}" in ${path} needs an https URL. Plain http is only for this machine.`)
    if (url.username || url.password) throw new Failure('invalid_config', `Hook "${name}" in ${path} has a password in its URL. The signature is how a receiver knows it is you.`)
    const secret = entry?.secret
    if (typeof secret !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) throw new Failure('invalid_config', `"secret" of hook "${name}" in ${path} names an environment variable: "env:NAME".`)
    const body = entry?.body ?? 'pointer'
    if (body !== 'pointer' && body !== 'event') throw new Failure('invalid_config', `"body" of hook "${name}" in ${path} is "pointer" or "event".`)
    const tail = entry?.tail ?? {}
    if (typeof tail !== 'object' || Array.isArray(tail)) throw new Failure('invalid_config', `"tail" of hook "${name}" in ${path} is a filter, as an object.`)
    if (tail.kinds !== undefined && !kindsValid(tail.kinds)) throw new Failure('invalid_config', `"kinds" of hook "${name}" in ${path} is a list of hold kinds, each with "!" in front to leave it out.`)
    return { name, url: url.href, secret: secret.slice(4), tail, body }
  })
}

/** Reads each hook's secret from the environment. One that is missing or short is a config error, not an unsigned send. */
export function armHooks(hooks: Hook[], env: NodeJS.ProcessEnv = process.env, path = hooksPath()): ArmedHook[] {
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
