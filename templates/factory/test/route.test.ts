import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { board, type Board } from 'muster'

const HERE = fileURLToPath(new URL('..', import.meta.url))

let server: ChildProcess | null = null
let url = ''
let team: Board
let token = ''

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

/** A request with exactly these headers, `Host` among them: `fetch` won't send another name. */
const ask = (path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown; until?: string } = {}) =>
  new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = request(`${url}${path}`, { method: options.method ?? 'POST', headers: options.headers }, (res) => {
      let body = ''
      const done = () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body })
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (options.until && body.includes(options.until)) {
          done()
          req.destroy()
        }
      })
      res.on('end', done)
    })
    req.on('error', reject)
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })

// The built factory, as `next start` serves it, on a board and a config folder of the test's own.
beforeAll(async () => {
  if (!existsSync(join(HERE, '.next', 'BUILD_ID'))) throw new Error('The factory is not built: run pnpm build (pnpm check does) first.')
  const dir = mkdtempSync(join(tmpdir(), 'factory-route-'))
  const env = { MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config') }
  // This process makes the token the way `mu token create` would, with the key kept for that board.
  Object.assign(process.env, env)
  team = board()
  token = (await team.backend.tokens.create({ profile: null, can: {}, ttl: 3600 })).token
  await team.post({ channel: 'factory/intake', text: 'first' })
  const port = await freePort()
  server = spawn(join(HERE, 'node_modules', '.bin', 'next'), ['start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, HOME: dir, NEXT_TELEMETRY_DISABLED: '1' },
  })
  let output = ''
  server.stdout!.on('data', (chunk) => (output += chunk))
  server.stderr!.on('data', (chunk) => (output += chunk))
  url = `http://127.0.0.1:${port}`
  for (let tries = 0; ; tries++) {
    if (server.exitCode !== null || tries > 120) throw new Error(`next start didn't come up:\n${output}`)
    if (await fetch(`${url}/api/board/health`).then((response) => response.ok, () => false)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}, 60_000)

afterAll(() => {
  team?.close()
  try {
    // Its own process group, so whatever Next started goes with it.
    process.kill(-server!.pid!, 'SIGTERM')
  } catch {
    // Already gone.
  }
})

describe('the factory route, built and started', () => {
  it('serves the board at /api/board through team.fetch, held to a token', async () => {
    const authorization = `Bearer ${token}`
    expect((await ask('/api/board/health', { method: 'GET' })).status).toBe(200)
    const refused = await ask('/api/board/head')
    expect([refused.status, JSON.parse(refused.body).error.reason]).toEqual([401, 'unauthorized'])
    const head = await ask('/api/board/head', { headers: { authorization } })
    expect([head.status, JSON.parse(head.body)]).toEqual([200, { ok: 1 }])
    const posted = await ask('/api/board/post', { headers: { authorization, 'content-type': 'application/json' }, body: { args: [{ channel: 'factory/intake', text: 'over the route' }] } })
    expect(posted.status).toBe(200)
    expect((await team.readChannel({ channel: 'factory/intake' })).threads.map((thread) => thread.message.text)).toContain('over the route')
    // The feed comes through Next as it is written, not when it ends.
    const feed = await ask('/api/board/feed?after=0', { method: 'GET', headers: { authorization }, until: 'event: message.posted' })
    expect([feed.status, feed.type]).toEqual([200, 'text/event-stream'])
    expect(feed.body).toContain('"text":"first"')
  })

  it('refuses a request that came for another name', async () => {
    const answer = await ask('/api/board/head', { headers: { authorization: `Bearer ${token}`, host: 'evil.example' } })
    expect(answer.status).toBe(403)
  })
})
