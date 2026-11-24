// When a run's container stays and when it goes, as a plain function: no Workers runtime here, so it is tested as it runs.

/** How long a container is kept after its agent exits, for the CLI to read what it changed. */
export const KEEP_MS = 15 * 60_000

/** What a run's object knows when it decides. */
export type RunState = {
  now: number
  /** Whether the container is still up. */
  running: boolean
  /** When the run must end, whatever else is going on. */
  deadline: number
  /** Whether the CLI asked to read the run's changes once the agent exits (`--push`). */
  attach: boolean
  /** When the agent was seen to have exited, if it has. */
  exitedAt?: number
  /** Until when a call from the CLI is reading the container. A call in progress is never cut off, but holds it no longer than its own limit. */
  busyUntil?: number
}

/**
 * `wait`: leave the container as it is, and check again. `end`: remove it now.
 * The deadline wins over everything; a call in progress over the rest; after the agent exits the
 * container stays only for a run that asked to be read, and only for `KEEP_MS`.
 */
export function decide(state: RunState): 'wait' | 'end' {
  if (!state.running) return 'end'
  if (state.now >= state.deadline) return 'end'
  if (state.busyUntil !== undefined && state.now < state.busyUntil) return 'wait'
  if (state.exitedAt === undefined) return 'wait'
  return state.attach && state.now < state.exitedAt + KEEP_MS ? 'wait' : 'end'
}

/** An exit code as the agent's shell wrote it: anything else in that file is the agent's, and means nothing. */
export function exitCode(text: string): number | null {
  const trimmed = text.trim()
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null
}

/** A stream read to its end or to `max + 1` bytes, whichever comes first; past `max`, `stop` is called once and no more is read. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null | undefined, max: number, stop: () => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  // Aborted, the read waiting on the stream ends at once, with what was read so far.
  signal?.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = max + 1 - size
      const part = value.length > room ? value.subarray(0, room) : value
      chunks.push(part)
      size += part.length
      if (size > max) {
        stop()
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A stream passed on as it is, but errored once more than `max` bytes went through it: a file that grew is not handed out whole. */
export function capStream(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let size = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length
        if (size > max) controller.error(new Error(`more than ${max} bytes`))
        else controller.enqueue(chunk)
      },
    }),
  )
}

/** What `exec` is asked to run, from a request body: null when it isn't `{ cmd, args, env? }` of strings. */
export function execRequest(body: unknown): { cmd: string; args: string[]; env: Record<string, string> } | null {
  if (!body || typeof body !== 'object') return null
  const { cmd, args, env } = body as { cmd?: unknown; args?: unknown; env?: unknown }
  if (typeof cmd !== 'string' || cmd === '' || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return null
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((value) => typeof value === 'string'))) return null
  return { cmd, args: args as string[], env: (env as Record<string, string> | undefined) ?? {} }
}

/**
 * What the Worker logs when a run ends: why, and how the agent exited. What the run printed is its own
 * business, and can hold anything the agent read, so its tail is logged only when the Worker's owner set
 * `LOG_TAIL` to `1`: it then sits in Cloudflare's logs for as long as those are kept.
 */
export function ended(why: string, exitCode: number | null, tail: string, logTail: string | undefined): { event: 'run.ended'; why: string; exitCode: number | null; tail?: string } {
  return { event: 'run.ended', why, exitCode, ...(logTail === '1' ? { tail } : {}) }
}

/**
 * How dependencies were installed, from the install script's exit code and the last line it printed:
 * `pnpm`, `npm`, `yarn`, `bun` or `none`, or `failed (exit n)`
 * (`failed (no exit code)` when it was killed before it gave one). Anything else it printed means nothing.
 */
export function installed(code: number | null, last: string): string {
  if (code === null) return 'failed (no exit code)'
  if (code !== 0) return `failed (exit ${code})`
  const said = /^installed (pnpm|npm|yarn|bun|none)$/.exec(last.trim())
  return said ? said[1]! : 'none'
}

/** One step of a dependency install: a host given its gate or closed, the install itself, or every process it left killed. */
export type InstallStep = { do: 'open'; host: string; gate: 'board' | 'model' | 'registry' } | { do: 'close'; host: string } | { do: 'install' } | { do: 'kill' } | { do: 'check' }

/**
 * The order a dependency install runs in. The repository's own code runs during it (a pnpmfile, a yarn
 * plugin), so the board and the model are closed first and only the registries are open, to read. After
 * it the registries close, everything it left running is killed (and the exit file it may have written
 * removed), the run is checked to be still going, and only then are the board and the model given back
 * their gates, for the agent.
 */
export function installSteps(hosts: { board: string; model?: string; registries: string[] }): InstallStep[] {
  const credentialed: { do: 'open'; host: string; gate: 'board' | 'model' }[] = [{ do: 'open', host: hosts.board, gate: 'board' }, ...(hosts.model ? [{ do: 'open' as const, host: hosts.model, gate: 'model' as const }] : [])]
  return [
    ...credentialed.map((step) => ({ do: 'close' as const, host: step.host })),
    ...hosts.registries.map((host) => ({ do: 'open' as const, host, gate: 'registry' as const })),
    { do: 'install' },
    ...hosts.registries.map((host) => ({ do: 'close' as const, host })),
    { do: 'kill' },
    // A run stopped or timed out meanwhile gets nothing opened again.
    { do: 'check' },
    ...credentialed,
  ]
}

/**
 * The most `start` may take before the agent starts: the CLI waits for its answer, and Node's fetch gives
 * up after 5 minutes without one. What is left of it after setup and the clone is the install's.
 */
export const START_BUDGET_MS = 4 * 60_000
/** The longest an install runs, whatever is left of the budget; and the least worth starting one with. */
export const INSTALL_MS = 3 * 60_000
export const INSTALL_MIN_MS = 15_000

/** How long the install may run, `startedAt` being when start began: null when too little is left to try. */
/** What is left of start's budget, `startedAt` being when start began: what setup and the clone may still take. */
export function timeLeft(startedAt: number, now: number): number {
  return Math.max(0, START_BUDGET_MS - (now - startedAt))
}

/** What start says of an install it didn't begin, for want of time. */
export const INSTALL_SKIPPED = 'failed (timeout)'

export function installBudget(startedAt: number, now: number): number | null {
  const left = Math.min(INSTALL_MS, timeLeft(startedAt, now))
  return left >= INSTALL_MIN_MS ? left : null
}

/**
 * Whether the exit file says the agent exited. Before the agent has started, it is the repository's
 * install that could have written it, and it means nothing.
 */
export function agentExited(agentStarted: boolean | undefined, marker: string): boolean {
  // Unset in a run a Worker started before this flag was written down: its agent had started.
  return agentStarted !== false && marker.trim() !== ''
}

/** Whether a run is still going, as start needs before it gives the agent its gates: not stopped, timed out or closed. */
export function stillGoing(state: { started: boolean; running: boolean; closed: boolean; exitedAt?: number }): boolean {
  return state.started && state.running && !state.closed && state.exitedAt === undefined
}

/** How long a command is given past its own `timeout` before it is let go of here. */
export const KILL_GRACE_MS = 10_000

/**
 * A command's output, read as `readCapped` does, for no longer than `ms` of wall-clock time. `timeout` in the
 * container kills its command's process group, but a child that left it (setsid, a daemon) can hold the pipe
 * open for ever: then `stop` is called, the read is given up, and what was read so far comes back.
 */
export async function readWithin(stream: ReadableStream<Uint8Array> | null | undefined, max: number, ms: number, stop: () => void): Promise<{ bytes: Uint8Array; timedOut: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stop()
    controller.abort()
  }, ms)
  try {
    return { bytes: await readCapped(stream, max, stop, controller.signal), timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** What a promise gives within `ms`, or `fallback` once that has passed: an exit code that never comes is not waited on. */
export async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<F>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))
  try {
    return await Promise.race([promise, late])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
