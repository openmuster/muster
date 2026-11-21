import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Backend } from '../backend/types.ts'
import { Failure } from '../failure.ts'
import { profileName, type Caller } from '../model.ts'
import { ROUTES } from '../serve/server.ts'

const ALLOWED = new Set<string>(ROUTES)

const PAGE = (token: string, title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script>window.__MUSTER__ = ${JSON.stringify({ token })}</script>
<script type="module" src="/app.js"></script>
</body>
</html>`

/** Where the built page bundle is: beside this file once built, or in `dist` when run from source. */
function bundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, 'inspect', 'app.js'), join(here, 'app.js'), join(here, '..', '..', 'dist', 'inspect', 'app.js')].find((path) => {
    try {
      readFileSync(path, { flag: 'r' })
      return true
    } catch {
      return false
    }
  }) ?? join(here, '..', '..', 'dist', 'inspect', 'app.js')
}

export type InspectOptions = { backend: Backend; port?: number; bundle?: string; title?: string }

/**
 * The inspector: a page, its bundle, and `/board/*`, a proxy that acts as you. Because it acts as you
 * it trusts nothing but its own page: it listens on 127.0.0.1, answers only for its own host name,
 * needs the token it gave the page on every board request, and the page's own origin on writes.
 */
export function inspect(options: InspectOptions): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(24).toString('base64url')
  let origin = ''
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(text)
  }
  const sameToken = (given: string | undefined) => {
    if (!given) return false
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase()
      if (`http://${host}` !== origin && `http://${host.replace('localhost', '127.0.0.1')}` !== origin) throw new Failure('forbidden', `The inspector doesn't answer for "${host}".`)
      const url = new URL(req.url ?? '/', origin)
      if (req.method === 'GET' && url.pathname === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(options.bundle ?? bundlePath()))
      }
      if (url.pathname.startsWith('/board/')) {
        if (!sameToken(req.headers['x-muster-inspect'] as string | undefined)) throw new Failure('unauthorized', 'That request is not from this inspector page.')
        if (req.method !== 'POST') throw new Failure('not_found', 'No such route.')
        // Another site can't read the token, but check the origin too: writes come from this page or not at all.
        if (req.headers.origin !== origin) throw new Failure('forbidden', 'Writes come from the inspector page.')
        const route = url.pathname.slice('/board/'.length)
        const answering = route === 'joinList' || route === 'joinApprove' || route === 'joinDeny'
        if (!ALLOWED.has(route) && !answering) throw new Failure('not_found', 'No such route.')
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { args?: unknown[]; as?: string | null }) : {}
        // Requests to join are answered as you, the board's owner, the way `mu join approve` would.
        if (answering) {
          const joins = options.backend.joins
          const [request] = (body.args ?? []) as [never]
          const result = route === 'joinList' ? await joins.list() : route === 'joinDeny' ? await joins.deny(request) : await joins.approve(request)
          return send(res, 200, { ok: result })
        }
        const caller: Caller = await options.backend.self(body.as ? profileName(body.as) : null)
        const result = await (options.backend[route as (typeof ROUTES)[number]] as (caller: Caller, ...rest: unknown[]) => Promise<unknown>)(caller, ...(body.args ?? []))
        return send(res, 200, { ok: result === undefined ? null : result })
      }
      if (req.method === 'GET') {
        // Every path is the page: the view is in the URL.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" })
        return res.end(PAGE(token, options.title ?? 'muster'))
      }
      throw new Failure('not_found', 'No such route.')
    } catch (error) {
      if (error instanceof Failure) return send(res, error.reason === 'unauthorized' ? 401 : error.reason === 'forbidden' ? 403 : error.reason === 'not_found' ? 404 : error.exit === 2 ? 400 : 409, { error: error.toJSON() })
      send(res, 500, { error: { reason: 'internal', message: error instanceof Error ? error.message : String(error) } })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ url: origin, token, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }) })
    })
  })
}
