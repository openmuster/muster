import { OIDC_LIVE_MAX, verifier, type Trust } from './oidc.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Backend } from '../backend/types.ts'
import { VERSION } from '../version.ts'
import { Failure, misuse } from '../failure.ts'
import { profileName, WORKFLOWS_PROFILE, type Caller } from '../model.ts'
import { memoryRegistry, mintToken, type MintRequest, type Registry } from './tokens.ts'
import { verify, type Claims } from './token.ts'

/** What a client may call. `scheduleTick` is the ticker's, never a client's. */
export const ROUTES = [
  'post', 'reply', 'edit', 'remove', 'label', 'react', 'createChannel', 'workflowRequest',
  'readChannel', 'readThread', 'events', 'channels', 'search', 'actors', 'head', 'cursorGet', 'cursorSet',
  'taskCreate', 'taskPlan', 'taskClaim', 'taskRenew', 'taskRelease', 'taskComplete', 'taskFail', 'taskBlock',
  'taskUnblock', 'taskReopen', 'taskCancel', 'taskAssign', 'taskNeeds', 'taskList', 'task',
  'scheduleCreate', 'scheduleCancel', 'scheduleList', 'schemaAdd', 'schemaList', 'filePut', 'fileGet', 'budgetSet', 'budgets',
] as const
const ALLOWED = new Set<string>(ROUTES)

/** Removes `pid` and `pidStart` from a request, at any depth. */
function withoutPids(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 6) return
  if (!Array.isArray(value)) {
    delete (value as { pid?: unknown }).pid
    delete (value as { pidStart?: unknown }).pidStart
  }
  for (const inner of Object.values(value)) withoutPids(inner, depth + 1)
}

export const MOUNT = '/api/board'
/** Room for one file, as base64, and its envelope. */
const BODY_MAX = 36 * 1024 * 1024
/** A webhook is read before anything can say who sent it, so it gets far less room than a request with a token. */
const WEBHOOK_MAX = 1024 * 1024

const statusOf = (failure: Failure) =>
  failure.reason === 'unauthorized' ? 401 : failure.reason === 'forbidden' ? 403 : failure.reason === 'not_found' ? 404 : failure.exit === 2 ? 400 : failure.reason === 'internal' ? 500 : 409

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

async function bodyOf(req: IncomingMessage, max = BODY_MAX): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) throw misuse('body_too_large', `A request body here is at most ${max >= 1024 * 1024 ? `${Math.round(max / 1024 / 1024)} MB` : `${max} bytes`}.`)
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
  /** The board's list of tokens it made. Default: the backend's own. */
  tokens?: Registry
  /** Host names requests may come for, beside the address it listens on. */
  hosts?: readonly string[]
  /** Milliseconds between looks at the log for an open feed. */
  feedInterval?: number
  /**
   * MCP over HTTP at `/api/board/mcp`, for agents on other machines. It is handed one JSON-RPC message
   * and the caller's own token and profile, so the tool can do exactly what that token can, and no more.
   */
  mcp?: (message: unknown, as: { token: string; profile: string | null }) => Promise<object | null>
  /** Whether an agent with no token may ask to join. Off unless the owner says so. */
  allowJoins?: boolean
  /** The workloads the owner trusts to sign in with their platform's token. None unless the owner names some. */
  oidc?: readonly Trust[]
  /** How the board reaches an issuer for its keys. Default: `fetch`. */
  fetch?: typeof fetch
  /** Where the board says what only its owner should read, such as why an issuer's keys couldn't be fetched. */
  log?: (line: string) => void
}

/**
 * The board over HTTP. Every request names its caller with a token this board signed: the token fixes
 * the principal and what it may do, and nothing in a request body can change either.
 */
export function createHandler(options: ServeOptions) {
  const now = options.now ?? (() => Date.now())
  const extra = new Set((options.hosts ?? []).map((host) => host.toLowerCase()))

  // The board's own list where it keeps one, so a token stopped with `mu token revoke` is stopped here too.
  const tokens = options.tokens ?? options.backend.registry?.() ?? memoryRegistry()
  const claimsOf = (req: IncomingMessage): Claims => {
    const header = req.headers.authorization
    const claims = verify(options.key, header?.startsWith('Bearer ') ? header.slice(7) : undefined, now())
    // A token the board's owner stopped is refused like one that ran out.
    if (claims.jti && tokens.revoked(claims.jti)) throw new Failure('unauthorized', 'That token was revoked.', { hint: 'Get a new one from whoever runs the board.' })
    return claims
  }
  const workloads = options.oidc?.length ? verifier(options.oidc, { now, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.log ? { log: options.log } : {}) }) : null
  // When each workload's board tokens run out, so one job in a loop can't use up what the board keeps.
  const live = new Map<string, number[]>()
  // A workload's file allowance is its trust's, not one for each token it trades for: a job can't sign in again for more room.
  const callerOf = (req: IncomingMessage): Caller => {
    const claims = claimsOf(req)
    const asked = req.headers['x-muster-profile']
    // A token held to a profile writes as that profile, whatever the request asks for.
    const profile = claims.profile ?? (typeof asked === 'string' && asked.length > 0 ? profileName(asked) : null)
    // The daemon's own profile: what it writes as marks a workflow's run, so only the board itself writes as it.
    if (profile === WORKFLOWS_PROFILE && claims.can) throw new Failure('forbidden', `Only the board itself writes as ${WORKFLOWS_PROFILE}.`, { hint: 'Use another profile.' })
    return { principal: claims.sub, profile, ...(claims.can ? { can: claims.can, meter: claims.sub.startsWith('oidc:') ? '' : (claims.jti ?? claims.profile ?? '') } : {}), ...(claims.noSync ? { noSync: true as const } : {}), ...(claims.profile ? { profileHeld: true as const } : {}), ...(claims.jti ? { token: claims.jti } : {}) }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const host = (req.headers.host ?? '').toLowerCase()
      const name = host.replace(/:\d+$/, '')
      // A page on another site can make a browser send requests here under a name it controls.
      if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]' && !extra.has(name) && !extra.has(host)) throw new Failure('forbidden', `This board doesn't answer for "${host}".`)
      const url = new URL(req.url ?? '/', 'http://board')
      // For a container's health check and a load balancer: no token, and nothing about the board.
      if (url.pathname === MOUNT + '/health' && req.method === 'GET') {
        // A sync that can't run is a board that isn't healthy: said without naming what it lacks, which is the owner's to read.
        try {
          options.backend.syncCheck?.()
        } catch (error) {
          options.log?.(`error  GET ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`)
          return send(res, 503, { error: { reason: 'unhealthy', message: "The board's sync isn't running. Whoever runs it can see why in its output." }, exit: 1 })
        }
        return send(res, 200, { ok: { version: VERSION } })
      }
      if (!url.pathname.startsWith(MOUNT + '/')) throw new Failure('not_found', 'No such route.')
      if (url.pathname.startsWith(MOUNT + '/webhooks/') && req.method === 'POST') {
        // A platform can't hold a token of ours: its own signature, checked by the provider, is what proves it.
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > WEBHOOK_MAX) throw misuse('body_too_large', 'A webhook body is at most 1 MB.')
          chunks.push(chunk as Buffer)
        }
        const headers: Record<string, string | undefined> = {}
        for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value[0] : value
        let answer: Awaited<ReturnType<Backend['syncReceive']>>
        try {
          answer = await options.backend.syncReceive(url.pathname.slice((MOUNT + '/webhooks/').length), { headers, body: Buffer.concat(chunks).toString('utf8') })
        } catch (error) {
          // Whoever sent it is unauthenticated: they get a plain 503 and send it again later; why is the owner's to read.
          options.log?.(`error  POST ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`)
          res.writeHead(503, { 'content-type': 'text/plain' })
          return res.end('sync unavailable')
        }
        for (const note of answer.skipped ?? []) options.log?.(`skipped sync ${note}`)
        res.writeHead(answer.status, { 'content-type': 'text/plain' })
        return res.end(answer.body)
      }
      const route = url.pathname.slice(MOUNT.length + 1)
      // Asking to join, and picking up the answer, are the only routes with no token: the asker has none yet.
      if (route === 'joinAsk' || route === 'joinPoll') {
        if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
        const store = options.allowJoins ? options.backend.joinStore?.() : undefined
        if (!store) throw new Failure('joins_closed', "This board doesn't take requests to join.", { hint: 'Ask whoever runs it for a token.' })
        const [request] = ((await bodyOf(req, 4096)) as { args?: unknown[] }).args ?? []
        const given = (request ?? {}) as Record<string, unknown>
        if (route === 'joinAsk') {
          if (typeof given.profile !== 'string') throw misuse('invalid_profile', 'Say the name to join under.')
          return send(res, 200, { ok: store.ask({ profile: given.profile, ...(typeof given.note === 'string' ? { note: given.note } : {}) }) })
        }
        if (typeof given.code !== 'string' || typeof given.secret !== 'string') throw misuse('invalid_code', 'Send the code and the secret the request answered with.')
        return send(res, 200, { ok: store.poll(given.code, given.secret) })
      }
      // A workload signs in with its platform's token, which is all it has: it is checked against the
      // owner's trusts, and what it gets is a board token like any other, held to what the trust says.
      if (route === 'tokenExchange') {
        if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
        if (!workloads) throw new Failure('exchange_closed', "This board takes no workload's token.", { hint: 'Ask whoever runs it for a token, or to name your workload in its oidc.json.' })
        const [request] = ((await bodyOf(req, 16 * 1024)) as { args?: unknown[] } | null)?.args ?? []
        const { trust, release } = await workloads((request as { token?: unknown } | null)?.token)
        try {
          const at = Math.floor(now() / 1000)
          const held = (live.get(trust.name) ?? []).filter((exp) => exp > at)
          if (held.length >= OIDC_LIVE_MAX) throw new Failure('too_many_tokens', `"${trust.name}" holds ${OIDC_LIVE_MAX} tokens that still work, which is the most one workload has at once.`, { hint: 'They run out on their own. A job needs one, and can use it for every command.' })
          const made = mintToken(options.key, tokens, { principal: `oidc:${trust.name}`, claims: null, workload: true }, { profile: trust.as, can: trust.can, ttl: trust.ttl, ...(trust.noSync ? { noSync: true } : {}) }, now())
          live.set(trust.name, [...held, made.record.exp])
          return send(res, 200, { ok: { token: made.token, record: made.record, trust: trust.name } })
        } catch (error) {
          // No board token came of it, so the job's token isn't spent.
          release()
          throw error
        }
      }
      const caller = callerOf(req)
      if (route === 'whoami' && req.method === 'GET') return send(res, 200, { ok: { principal: caller.principal, profile: caller.profile, can: caller.can ?? null, exp: claimsOf(req).exp } })
      // Tokens are the board's own business, not a backend's: the key is here. None of these is a route a
      // sandbox's policy lets through, and a token held to channels, or made from another, can't use them.
      if (route === 'tokenCreate' || route === 'tokenList' || route === 'tokenRevoke') {
        if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
        const held = claimsOf(req)
        if (held.can || held.minted) throw new Failure('forbidden', "A token that is held to channels, or was made from another, can't manage tokens.", { hint: 'Ask whoever runs the board.' })
        const [request] = ((await bodyOf(req)) as { args?: unknown[] }).args ?? []
        if (route === 'tokenList') return send(res, 200, { ok: { tokens: tokens.list(now()) } })
        if (route === 'tokenRevoke') {
          const id = (request as { id?: unknown } | undefined)?.id
          if (typeof id !== 'string' || !tokens.revoke(id)) throw new Failure('not_found', 'No such token.')
          return send(res, 200, { ok: { revoked: id } })
        }
        return send(res, 200, { ok: mintToken(options.key, tokens, { principal: held.sub, claims: held }, (request ?? {}) as MintRequest, now()) })
      }
      if (route === 'mcp' && options.mcp) {
        // A page in a browser can't hold a token, but refuse one that came from another site all the same.
        const origin = req.headers.origin
        if (origin !== undefined && origin !== 'null') {
          let from = ''
          try {
            from = new URL(origin).hostname.toLowerCase()
          } catch {
            // Not a URL: refused below.
          }
          if (from !== '127.0.0.1' && from !== 'localhost' && !extra.has(from)) throw new Failure('forbidden', `This board doesn't take MCP requests from "${origin}".`)
        }
        // One message per POST, answered in its response: there is no stream to open with GET.
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          return res.end()
        }
        const response = await options.mcp(await bodyOf(req), { token: (req.headers.authorization ?? '').slice(7), profile: caller.profile })
        if (response === null) {
          res.writeHead(202)
          return res.end()
        }
        return send(res, 200, response)
      }
      // Answering a request to join makes a token, so it takes what making one takes.
      if (route === 'joinList' || route === 'joinApprove' || route === 'joinDeny') {
        if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
        const held = claimsOf(req)
        if (held.can || held.minted) throw new Failure('forbidden', "A token that is held to channels, or was made from another, can't answer requests to join.", { hint: 'Ask whoever runs the board.' })
        const store = options.backend.joinStore?.()
        if (!store) throw new Failure('joins_closed', "This board doesn't keep requests to join.")
        const [request] = ((await bodyOf(req)) as { args?: unknown[] }).args ?? []
        const given = (request ?? {}) as { code?: unknown; can?: Record<string, string[]>; ttl?: unknown; noSync?: unknown }
        if (route === 'joinList') return send(res, 200, { ok: { joins: store.list() } })
        if (typeof given.code !== 'string') throw misuse('invalid_code', 'Say which request: its code.')
        if (route === 'joinDeny') return send(res, 200, { ok: { join: store.answer(given.code, null) } })
        const join = store.pending(given.code)
        const made = mintToken(options.key, tokens, { principal: held.sub, claims: held }, { profile: join.profile, can: given.can ?? {}, ttl: Number(given.ttl), ...(given.noSync === true ? { noSync: true } : {}) }, now())
        return send(res, 200, { ok: { join: store.answer(join.code, made.token), record: made.record } })
      }
      if (route === 'feed' && req.method === 'GET') {
        // Listened for before anything is awaited: a client that leaves while the feed is opening ends it too.
        let open = true
        req.on('close', () => (open = false))
        // A live feed: every matching event after a cursor, as it happens. `id:` is the cursor to come back with.
        const filter: Record<string, unknown> = {}
        for (const key of ['channel', 'by', 'mentions', 'text'] as const) if (url.searchParams.get(key)) filter[key] = url.searchParams.get(key)
        if (url.searchParams.get('re')) filter.re = Number(url.searchParams.get('re'))
        if (url.searchParams.getAll('label').length) filter.labels = url.searchParams.getAll('label')
        if (url.searchParams.getAll('type').length) filter.types = url.searchParams.getAll('type')
        if (url.searchParams.get('root') === 'true') filter.root = true
        if (url.searchParams.getAll('kind').length) filter.kinds = url.searchParams.getAll('kind')
        const resume = req.headers['last-event-id'] ?? url.searchParams.get('after')
        let after = resume !== null && resume !== undefined && /^\d+$/.test(String(resume)) ? Number(resume) : await options.backend.head(caller)
        // Checked once before the stream opens, so a bad filter is an error and not an empty feed.
        await options.backend.events(caller, { after, filter, limit: 1 })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        if (!open) return res.end()
        res.write(`: connected\n\n`)
        let quiet = 0
        while (open) {
          // The token is asked about on every turn, so a feed ends when its token is revoked or runs out.
          try {
            claimsOf(req)
          } catch {
            break
          }
          const page = await options.backend.events(caller, { after, filter })
          after = page.cursor
          // Written without waiting for a slow reader to drain: what it hasn't read yet is held in memory, unbounded.
          for (const event of page.events) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          quiet = page.events.length ? 0 : quiet + 1
          // A comment now and then keeps a quiet connection from being closed by whatever sits between.
          if (quiet > 0 && quiet % 30 === 0) res.write(`: ${after}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, options.feedInterval ?? 500))
        }
        res.end()
        return
      }
      if (!ALLOWED.has(route)) throw new Failure('not_found', 'No such route.')
      if (req.method !== 'POST') throw misuse('method_not_allowed', 'Board routes take POST.')
      const body = (await bodyOf(req)) as { args?: unknown[] }
      const args = Array.isArray(body.args) ? body.args : []
      // A process ID is checked on this machine, and the caller's process is on another: one sent over HTTP
      // could only ever name a process here, and keep a lapsed claim alive by it.
      // Wherever one rides in a request: a claim, or a task made already claimed.
      withoutPids(args)
      const result = await (options.backend[route as (typeof ROUTES)[number]] as (caller: Caller, ...rest: unknown[]) => Promise<unknown>)(caller, ...args)
      send(res, 200, { ok: result === undefined ? null : result })
    } catch (error) {
      if (error instanceof Failure) return send(res, statusOf(error), { error: error.toJSON(), exit: error.exit })
      // Not the board's own answer: a bug, or the machine's (a full disk, a file it can't open). What it says can
      // name paths and users on this machine, so it goes to the owner, in the board's output, and not to the caller.
      options.log?.(`error  ${req.method} ${(req.url ?? '').split('?')[0]}: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, { error: { reason: 'internal', message: 'The board failed to answer. Whoever runs it can see why in its output.' }, exit: 1 })
    }
  }
}

/** Whether an address to listen on is this machine only. */
export const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'

export function listen(options: ServeOptions & { port?: number; host?: string }): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1'
  // Listening beyond this machine without naming the hosts it answers for would refuse every request but
  // its own; worse, it would mean whoever set it up hasn't thought about which name the board is reached by.
  if (!isLoopback(host) && (options.hosts ?? []).length === 0) {
    throw misuse('allow_host_required', `Listening on ${host} needs the name the board is reached by: pass --allow-host.`)
  }
  // How this process reaches itself: loopback when it listens everywhere, or the one address it listens on.
  const self = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const hosts = isLoopback(self) ? options.hosts : [...(options.hosts ?? []), self]
  const server = createServer(createHandler({ ...options, ...(hosts ? { hosts } : {}) }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      const address = server.address() as { port: number }
      resolve({
        server,
        url: `http://${self}:${address.port}${MOUNT}`,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
      })
    })
  })
}
