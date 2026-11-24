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
export async function readCapped(stream: ReadableStream<Uint8Array> | null | undefined, max: number, stop: () => void): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
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
