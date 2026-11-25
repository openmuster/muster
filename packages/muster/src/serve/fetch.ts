import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Backend } from '../backend/types.ts'
import { Failure, misuse } from '../failure.ts'
import { createHandler, MOUNT } from './server.ts'

export type MountOptions = {
  /** The path the board is mounted at, as a request's URL has it: `/api/board` unless you say otherwise. */
  base?: string
  /**
   * Host names requests may come for, beside this machine's (`127.0.0.1`, `localhost`, `[::1]`). Default: the
   * names in `MUSTER_ALLOW_HOSTS`, as for `mu serve`. Any other `Host` is refused.
   */
  hosts?: readonly string[]
  /** Where the board says what only its owner should read, such as why a request failed. Default: standard error. */
  log?: (line: string) => void
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>

/** Hop-by-hop and framing headers: the server that sends the `Response` sets its own. */
const FRAMING = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding'])
const NO_BODY = new Set([101, 204, 205, 304])

/** Checks a base path once, when the board is declared, so a typo is the module's mistake and not every request's. */
export function checkBase(base: string | undefined): string {
  if (base === undefined) return MOUNT
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(base)) throw misuse('invalid_base', `"${base}" isn't a base path: it starts with "/" and doesn't end with one, like "/api/board".`)
  return base
}

/** A request's body, a chunk at a time. One left unread, as when it is too large, is cancelled. */
async function* chunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return
  const reader = body.getReader()
  let done = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      yield next.value
    }
    done = true
  } finally {
    if (!done) await reader.cancel().catch(() => {})
  }
}

/** The answer to a request that failed for a reason only the owner should read: the same as `mu serve`'s. */
const failed = () => Response.json({ error: { reason: 'internal', message: 'The board failed to answer. Whoever runs it can see why in its output.' }, exit: 1 }, { status: 500, headers: { 'cache-control': 'no-store' } })

/**
 * `mu serve`'s own handler, answering a web `Request`. Nothing is answered differently: the request is
 * handed to the same code, under the path that code knows, and what it writes becomes the `Response`.
 */
export function toFetch(handler: Handler, base: string, log: (line: string) => void): (request: Request) => Promise<Response> {
  return (request) => {
    const url = new URL(request.url)
    // Only what is under the base reaches the board's routes. Anything else is given a path that answers 404
    // after the host is checked, as `mu serve` answers a path outside its mount.
    const path = url.pathname.startsWith(base + '/') ? MOUNT + url.pathname.slice(base.length) : '/'
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => (headers[name] = value))
    // The name is the `Host` the client sent. A request without one is refused, as `mu serve` refuses it: the
    // URL's host is whatever the runtime rebuilt it with, not what the client asked for.
    const events = new EventEmitter()
    let left = false
    const req = {
      method: request.method,
      url: path + url.search,
      headers,
      on(name: string, listener: () => void) {
        // A client that left before this was listened for has still left.
        if (name === 'close' && left) queueMicrotask(listener)
        else events.on(name, listener)
        return req
      },
      // Read as it comes, so the handler's limits stop a large body while it is arriving.
      [Symbol.asyncIterator]: () => chunks(request.body),
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>
    let closed = false
    const gone = () => {
      left = true
      if (closed) return
      closed = true
      events.emit('close')
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (given) => {
        controller = given
      },
      // The client went away: an open feed stops at its next turn.
      cancel: gone,
    })
    request.signal?.addEventListener('abort', () => {
      const open = !closed
      gone()
      if (open) controller.error(new Error('The request was aborted.'))
    })
    const write = (chunk: unknown) => {
      if (closed || chunk === undefined || chunk === null) return
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as Uint8Array))
    }

    return new Promise<Response>((resolve) => {
      const res = {
        // The response starts at its head, so a feed is answered at once and written as it goes.
        writeHead(status: number, given: Record<string, string | number> = {}) {
          const out = new Headers()
          for (const [name, value] of Object.entries(given)) if (!FRAMING.has(name.toLowerCase())) out.set(name, String(value))
          resolve(new Response(NO_BODY.has(status) ? null : stream, { status, headers: out }))
          return res
        },
        write(chunk: unknown) {
          write(chunk)
          return true
        },
        end(chunk?: unknown) {
          write(chunk)
          if (closed) return res
          closed = true
          controller.close()
          return res
        },
      }
      handler(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch((error: unknown) => {
        // The handler answers every failure itself; this is only if it couldn't.
        resolve(failed())
        log(`error  ${request.method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }
}

/**
 * `team.fetch`: what `mu serve` serves for this board, as a web `Request → Response` handler. Inert until its
 * first request: the board's file and its key are opened then, as `mu serve` opens them.
 */
export function mount(backend: Backend, options: MountOptions & { now?: () => Date } = {}): (request: Request) => Promise<Response> {
  const base = checkBase(options.base)
  const log = options.log ?? ((line: string) => console.error(line))
  let served: ((request: Request) => Promise<Response>) | null = null
  const make = () => {
    const key = backend.signingKey?.()
    if (!key) {
      // A handle on a board at a URL has no key to check a token with: serving it would be serving someone else's board.
      const refused = new Failure('forbidden', 'team.fetch serves a board on this machine: this handle is on a board at a URL.')
      return async () => Response.json({ error: refused.toJSON(), exit: refused.exit }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    const hosts = options.hosts ?? (process.env.MUSTER_ALLOW_HOSTS ?? '').split(',').map((name) => name.trim()).filter(Boolean)
    const now = options.now
    return toFetch(createHandler({ backend, key, hosts, log, ...(now ? { now: () => now().getTime() } : {}) }), base, log)
  }
  return async (request) => {
    try {
      served ??= make()
    } catch (error) {
      // Such as a key file it can't read: said to the owner, never to the caller, and tried again next request.
      log(`error  ${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : String(error)}`)
      return failed()
    }
    return served(request)
  }
}
