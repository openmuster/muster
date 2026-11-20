import type { FeedEvent, Filter } from '../core/reads.ts'
import type { Board } from '../handle.ts'

/**
 * A watcher, from the operator's config file: what to listen for and the command to run. It is never
 * read from a board, so nothing written to one can make the daemon run a command.
 */
export type Watcher = {
  name: string
  tail: Filter
  /** The command, with `{thread}`, `{channel}`, `{seq}` and `{type}` filled in. */
  run: string[]
  /** A script that decides whether to wake at all: it says no by printing `{"wake": false}` last. */
  gate?: string[]
  /** The profile the watcher's command writes as. Its own writes never wake it; a message it scheduled does. */
  as?: string
  /** Names to pass on from the daemon's environment, beside PATH, HOME and the board's own. Nothing else is. */
  env?: string[]
  /** Seconds between runs. Events in between are delivered together, one wake per thread. Default 30. */
  every?: number
}

export const DELIVERY_ATTEMPTS = 5

export type Spawned = { code: number | null; stdout: string }
export type Deps = {
  now: () => number
  /** Runs a command to its end. Faked in tests. */
  spawn: (command: string[], env: Record<string, string>, allow?: readonly string[]) => Promise<Spawned>
}

export type WatchState = { last: number; attempts: number }

const fill = (part: string, event: FeedEvent) =>
  part
    .replaceAll('{thread}', event.thread === null ? '' : String(event.thread))
    .replaceAll('{channel}', event.channel ?? '')
    .replaceAll('{seq}', String(event.seq))
    .replaceAll('{type}', event.type)

/** Whether a gate's output says not to wake: its last non-empty line is JSON with `wake: false`. */
export function gateSaysNo(stdout: string): boolean {
  const last = stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  if (!last) return false
  try {
    return (JSON.parse(last) as { wake?: unknown }).wake === false
  } catch {
    return false
  }
}

/**
 * Runs one watcher once: reads what matched since its cursor, wakes once per thread with a pointer,
 * and moves the cursor only past what it delivered. A wake that keeps failing is recorded on its
 * thread after five tries, so one bad thread never holds the rest.
 */
export async function runWatcher(team: Board, watcher: Watcher, state: WatchState, deps: Deps): Promise<{ woke: number[]; failed: number[]; gated: number[] }> {
  const out = { woke: [] as number[], failed: [] as number[], gated: [] as number[] }
  if (deps.now() - state.last < (watcher.every ?? 30) * 1000) return out
  state.last = deps.now()
  const me = watcher.as ? team.as(watcher.as) : team
  const name = `watch:${watcher.name}`
  const cursor = (await me.cursorGet(name)) ?? (await me.head())
  if ((await me.cursorGet(name)) === null) await me.cursorSet(name, cursor)
  const page = await me.events({ after: cursor, filter: watcher.tail, limit: 500 })
  // One wake per thread: the newest event stands for the ones before it. The agent reads the thread itself.
  const latest = new Map<string, FeedEvent>()
  for (const event of page.events) {
    const own = watcher.as !== undefined && event.by.profile === watcher.as && !(event.data as { schedule?: unknown }).schedule
    if (!own) latest.set(String(event.thread ?? `c:${event.channel}`), event)
  }
  let reached = page.cursor
  for (const event of [...latest.values()].sort((a, b) => a.seq - b.seq)) {
    const env = { MUSTER_THREAD: event.thread === null ? '' : String(event.thread), MUSTER_CHANNEL: event.channel ?? '', MUSTER_EVENT: String(event.seq), MUSTER_EVENT_TYPE: event.type, ...(watcher.as ? { MUSTER_PROFILE: watcher.as } : {}) }
    if (watcher.gate && gateSaysNo((await deps.spawn(watcher.gate.map((part) => fill(part, event)), env, watcher.env)).stdout)) {
      out.gated.push(event.seq)
      continue
    }
    const ran = await deps.spawn(watcher.run.map((part) => fill(part, event)), env, watcher.env)
    if (ran.code === 0) {
      state.attempts = 0
      out.woke.push(event.seq)
      continue
    }
    state.attempts += 1
    if (state.attempts < DELIVERY_ATTEMPTS) {
      // Stop before this event: the cursor stays behind it, and the next run tries it again.
      reached = event.seq - 1
      out.failed.push(event.seq)
      break
    }
    state.attempts = 0
    out.failed.push(event.seq)
    if (event.thread !== null) {
      await me.reply({ to: event.thread, text: `watcher "${watcher.name}" couldn't deliver a wake-up after ${DELIVERY_ATTEMPTS} tries (exit ${ran.code ?? 'none'}).`, noSync: true }).catch(() => {})
    }
  }
  if (reached > cursor) await me.cursorSet(name, reached)
  return out
}
