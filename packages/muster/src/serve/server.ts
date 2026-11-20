import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Backend } from '../backend/types.ts'
import { Failure, misuse } from '../failure.ts'
import { profileName, type Caller } from '../model.ts'
import { verify } from './token.ts'

/** What a client may call. `scheduleTick` is the ticker's, never a client's. */
export const ROUTES = [
  'post', 'reply', 'edit', 'remove', 'label', 'react', 'createChannel',
  'readChannel', 'readThread', 'events', 'channels', 'search', 'actors', 'head', 'cursorGet', 'cursorSet',
  'taskCreate', 'taskPlan', 'taskClaim', 'taskRenew', 'taskRelease', 'taskComplete', 'taskFail', 'taskBlock',
  'taskUnblock', 'taskReopen', 'taskCancel', 'taskAssign', 'taskNeeds', 'taskList', 'task',
  'scheduleCreate', 'scheduleCancel', 'scheduleList', 'schemaAdd', 'schemaList', 'filePut', 'fileGet', 'budgetSet', 'budgets',
] as const
const ALLOWED = new Set<string>(ROUTES)

export const MOUNT = '/api/board'
/** Room for one file, as base64, and its envelope. */
const BODY_MAX = 36 * 1024 * 1024

const statusOf = (failure: Failure) =>
  failure.reason === 'unauthorized' ? 401 : failure.reason === 'forbidden' ? 403 : failure.reason === 'not_found' ? 404 : failure.exit === 2 ? 400 : failure.reason === 'internal' ? 500 : 409

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_MAX) throw misuse('body_too_large', 'A request body is at most 36 MB.')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw misuse('invalid_json', "The request body isn't JSON.")
  }
}

export type ServeOptions = {
  backend: Backend
  key: Buffer
  now?: () => number
  /** Host names requests may come for, beside the address it listens on. */
  hosts?: readonly string[]
  /** Milliseconds between looks at the log for an open feed. */
  feedInterval?: number
}

/**
 * The board over HTTP. Every request names its caller with a token this board signed: the token fixes
 * the principal and what it may do, and nothing in a request body can change either.
 */
export function createHandler(options: ServeOptions) {
  const now = options.now ?? (() => Date.now())
  const extra = new Set((options.hosts ?? []).map((host) => host.toLowerCase()))

  const callerOf = (req: IncomingMessage): Caller => {
    const header = req.headers.authorization
    const claims = verify(options.key, header?.startsWith('Bearer ') ? header.slice(7) : undefined, now())
    const asked = req.headers['x-muster-profile']
    // A token held to a profile writes as that profile, whatever the request asks for.
    const profile = claims.profile ?? (typeof asked === 'string' && asked.length > 0 ? profileName(asked) : null)
    return { principal: claims.sub, profile, ...(claims.can ? { can: claims.can } : {}) }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const host = (req.headers.host ?? '').toLowerCase()
      const name = host.replace(/:\d+$/, '')
      // A page on another site can make a browser send requests here under a name it controls.
      if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]' && !extra.has(name) && !extra.has(host)) throw new Failure('forbidden', `This board doesn't answer for "${host}".`)
      const url = new URL(req.url ?? '/', 'http://board')
      if (!url.pathname.startsWith(MOUNT + '/')) throw new Failure('not_found', 'No such route.')
      if (url.pathname.startsWith(MOUNT + '/webhooks/') && req.method === 'POST') {
        // A platform can't hold a token of ours: its own signature, checked by the provider, is what proves it.
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > BODY_MAX) throw misuse('body_too_large', 'A request body is at most 36 MB.')
          chunks.push(chunk as Buffer)
        }
        const headers: Record<string, string | undefined> = {}
        for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value[0] : value
        const answer = await options.backend.syncReceive(url.pathname.slice((MOUNT + '/webhooks/').length), { headers, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(answer.status, { 'content-type': 'text/plain' })
        return res.end(answer.body)
      }
      const route = url.pathname.slice(MOUNT.length + 1)
      const caller = callerOf(req)
      if (route === 'whoami' && req.method === 'GET') return send(res, 200, { ok: { principal: caller.principal, profile: caller.profile, can: caller.can ?? null } })
      if (route === 'feed' && req.method === 'GET') {
        // A live feed: every matching event after a cursor, as it happens. `id:` is the cursor to come back with.
        const filter: Record<string, unknown> = {}
        for (const key of ['channel', 'by', 'mentions', 'text'] as const) if (url.searchParams.get(key)) filter[key] = url.searchParams.get(key)
        if (url.searchParams.get('re')) filter.re = Number(url.searchParams.get('re'))
        if (url.searchParams.getAll('label').length) filter.labels = url.searchParams.getAll('label')
        if (url.searchParams.getAll('type').length) filter.types = url.searchParams.getAll('type')
        const resume = req.headers['last-event-id'] ?? url.searchParams.get('after')
        let after = resume !== null && resume !== undefined && /^\d+$/.test(String(resume)) ? Number(resume) : await options.backend.head(caller)
        // Checked once before the stream opens, so a bad filter is an error and not an empty feed.
        await options.backend.events(caller, { after, filter, limit: 1 })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`: connected\n\n`)
        let open = true
        req.on('close', () => (open = false))
        let quiet = 0
        while (open) {
          const page = await options.backend.events(caller, { after, filter })
          after = page.cursor
          for (const event of page.events) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          quiet = page.events.length ? 0 : quiet + 1
          // A comment now and then keeps a quiet connection from being closed by whatever sits between.
          if (quiet > 0 && quiet % 30 === 0) res.write(`: ${after}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, options.feedInterval ?? 500))
        }
        return
      }
      if (!ALLOWED.has(route)) throw new Failure('not_found', 'No such route.')
      if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
      const body = (await bodyOf(req)) as { args?: unknown[] }
      const args = Array.isArray(body.args) ? body.args : []
      const result = await (options.backend[route as (typeof ROUTES)[number]] as (caller: Caller, ...rest: unknown[]) => Promise<unknown>)(caller, ...args)
      send(res, 200, { ok: result === undefined ? null : result })
    } catch (error) {
      if (error instanceof Failure) return send(res, statusOf(error), { error: error.toJSON(), exit: error.exit })
      send(res, 500, { error: { reason: 'internal', message: error instanceof Error ? error.message : String(error) }, exit: 1 })
    }
  }
}

export function listen(options: ServeOptions & { port?: number }): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer(createHandler(options))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}${MOUNT}`,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}
