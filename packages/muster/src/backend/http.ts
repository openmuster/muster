import { Failure } from '../failure.ts'
import type { Caller } from '../model.ts'
import { ROUTES } from '../serve/server.ts'
import type { Backend } from './types.ts'

export type HttpOptions = {
  /** The board's URL, as `mu serve` prints it: `http://127.0.0.1:4100/api/board`. */
  url: string | Promise<string>
  token: string
  fetch?: typeof fetch
}

/** A board at a URL, answered by a `mu serve`. The token says who you are and what you may do. */
export function http(options: HttpOptions): Backend {
  const doFetch = options.fetch ?? fetch
  let shown = typeof options.url === 'string' ? options.url : '(starting)'
  const base = async () => (shown = (await options.url).replace(/\/$/, ''))

  async function call(route: string, caller: Caller | { profile: string | null }, init: { method: 'GET' | 'POST'; args?: unknown[] }): Promise<unknown> {
    let response: Response
    try {
      response = await doFetch(`${await base()}/${route}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(caller.profile ? { 'x-muster-profile': caller.profile } : {}),
          ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.method === 'POST' ? { body: JSON.stringify({ args: init.args ?? [] }) } : {}),
      })
    } catch (error) {
      throw new Failure('network_error', `Couldn't reach the board at ${shown}.`, { hint: String((error as Error).cause ?? (error as Error).message) })
    }
    let body: { ok?: unknown; error?: { reason: string; message: string; hint?: string; next?: string[]; data?: Record<string, unknown> }; exit?: 1 | 2 }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new Failure('bad_answer', `The board at ${shown} answered ${response.status} with something that isn't JSON.`)
    }
    if (body.error) {
      throw new Failure(body.error.reason, body.error.message, {
        ...(body.error.hint ? { hint: body.error.hint } : {}),
        ...(body.error.next ? { next: body.error.next } : {}),
        ...(body.error.data ? { data: body.error.data } : {}),
        exit: body.exit ?? 1,
      })
    }
    return body.ok
  }

  const backend = {
    kind: 'http',
    get where() {
      return shown
    },
    async self(profile: string | null) {
      return (await call('whoami', { profile }, { method: 'GET' })) as Caller
    },
    scheduleTick: async () => {
      throw new Failure('forbidden', 'The board itself sends what is due.')
    },
    syncReceive: async () => ({ status: 404, body: 'the board itself takes webhooks' }),
    syncTick: async () => ({ imported: 0, delivered: 0, failed: 0 }),
    backup: async () => {
      throw new Failure('forbidden', 'A backup is made on the machine the board is on.')
    },
    close() {},
  } as Record<string, unknown>
  for (const route of ROUTES) backend[route] = (caller: Caller, ...args: unknown[]) => call(route, caller, { method: 'POST', args })
  return backend as unknown as Backend
}
