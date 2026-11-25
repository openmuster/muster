import { createHmac, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { board, file, github, http, listen, mint, type Backend, type Board, type BoardOptions } from '../src/index.ts'
import { tempDir } from './helpers.ts'

type Asked = { method?: string; path: string; headers?: Record<string, string>; body?: unknown; raw?: string; host?: string }
type Answer = { status: number; type: string | null; body: string }

const closers: (() => Promise<void> | void)[] = []
afterAll(async () => {
  for (const close of closers.splice(0)) await close()
})

/** One board on disk, served both ways: by `mu serve`'s server, and by `team.fetch`, with one key. */
async function both(options: Omit<BoardOptions, 'dir' | 'key'> = {}) {
  const dir = tempDir()
  const key = randomBytes(32)
  const team = board({ ...options, dir: join(dir, 'board'), key })
  const server = await listen({ backend: team.backend, key, feedInterval: 20 })
  closers.push(() => server.close(), () => team.close())
  const port = Number(new URL(server.url).port)
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = (claims: Partial<Parameters<typeof mint>[1]> = {}) => mint(key, { sub: 'local:user:ada', profile: null, exp, ...claims })

  /** Asks `mu serve`, over a socket, with exactly these headers. Reads a feed up to its first event. */
  const viaServe = (asked: Asked): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const text = asked.raw ?? (asked.body === undefined ? undefined : JSON.stringify(asked.body))
      const req = httpRequest({ host: '127.0.0.1', port, path: asked.path, method: asked.method ?? 'POST', headers: { host: asked.host ?? `127.0.0.1:${port}`, ...asked.headers } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.includes('\nid: ') || body.startsWith('id: ')) {
            resolve({ status: res.statusCode ?? 0, type: (res.headers['content-type'] as string | undefined) ?? null, body })
            req.destroy()
          }
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: (res.headers['content-type'] as string | undefined) ?? null, body }))
      })
      req.on('error', reject)
      req.end(text)
    })

  /** Asks `team.fetch` the same thing, as a web Request. */
  const viaFetch = async (asked: Asked, on: Board = team): Promise<Answer> => {
    // Detached, as a route exports it: `export const GET = team.fetch`.
    const GET = on.fetch
    const text = asked.raw ?? (asked.body === undefined ? undefined : JSON.stringify(asked.body))
    const response = await GET(
      new Request(`http://127.0.0.1:${port}${asked.path}`, {
        method: asked.method ?? 'POST',
        headers: { host: asked.host ?? `127.0.0.1:${port}`, ...asked.headers },
        ...(text === undefined ? {} : { body: text }),
      }),
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
      if (body.includes('\nid: ') || body.startsWith('id: ')) {
        await reader.cancel()
        break
      }
    }
    return { status: response.status, type: response.headers.get('content-type'), body }
  }
  return { team, token, viaServe, viaFetch, port }
}

describe('team.fetch', () => {
  it('answers what mu serve answers: health, refusals, a read, a write and the first event of a feed', async () => {
    const { team, token, viaServe, viaFetch } = await both()
    const owner = `Bearer ${token()}`
    await team.post({ channel: 'factory/intake', text: 'first' })
    await team.post({ channel: 'security', text: 'unfixed CVE' })
    const held = `Bearer ${token({ profile: 'fixer', can: { 'factory/': ['read'] } })}`
    const same: Asked[] = [
      { method: 'GET', path: '/api/board/health' },
      { path: '/api/board/head' },
      { path: '/api/board/head', headers: { authorization: 'Bearer nonsense' } },
      { path: '/api/board/head', headers: { authorization: `Bearer ${mint(randomBytes(32), { sub: 'local:user:ada', profile: null, exp: 9_999_999_999 })}` } },
      { path: '/api/board/head', headers: { authorization: owner } },
      { method: 'GET', path: '/api/board/whoami', headers: { authorization: held } },
      { method: 'GET', path: '/api/board/head', headers: { authorization: owner } },
      { path: '/api/board/nope', headers: { authorization: owner } },
      { path: '/elsewhere', headers: { authorization: owner } },
      { path: '/api/board/scheduleTick', headers: { authorization: owner } },
      { path: '/api/board/readChannel', headers: { authorization: owner }, body: { args: [{ channel: 'factory/' }] } },
      { path: '/api/board/readChannel', headers: { authorization: held }, body: { args: [{ channel: 'security' }] } },
      { path: '/api/board/post', headers: { authorization: held }, body: { args: [{ channel: 'factory/intake', text: 'not allowed' }] } },
      { path: '/api/board/joinAsk', body: { args: [{ profile: 'stranger' }] } },
      { path: '/api/board/tokenExchange', body: { args: [{ token: 'x' }] } },
      { path: '/api/board/webhooks/github' },
      { path: '/api/board/head', headers: { authorization: owner }, host: 'evil.example' },
      { method: 'GET', path: '/api/board/feed?after=0&channel=factory/', headers: { authorization: held } },
    ]
    for (const asked of same) {
      const [served, fetched] = [await viaServe(asked), await viaFetch(asked)]
      expect(fetched, `${asked.method ?? 'POST'} ${asked.path}`).toEqual(served)
    }
    // A write: each answers with its own message, as the same caller, and the board then reads the same either way.
    const write = (text: string): Asked => ({ path: '/api/board/post', headers: { authorization: owner, 'x-muster-profile': 'claude' }, body: { args: [{ channel: 'factory/intake', text, by: { principal: 'local:user:root', profile: null } }] } })
    const [served, fetched] = [await viaServe(write('from serve')), await viaFetch(write('from fetch'))]
    expect([served.status, fetched.status]).toEqual([200, 200])
    const shape = (answer: Answer) => {
      const { ok } = JSON.parse(answer.body) as { ok: { by: unknown; channel: string; text: string } }
      return { by: ok.by, channel: ok.channel }
    }
    expect(shape(fetched)).toEqual(shape(served))
    expect(shape(fetched)).toEqual({ by: { principal: 'local:user:ada', profile: 'claude' }, channel: 'factory/intake' })
    const read: Asked = { path: '/api/board/readChannel', headers: { authorization: owner }, body: { args: [{ channel: 'factory/' }] } }
    const after = await viaFetch(read)
    expect(after).toEqual(await viaServe(read))
    expect(after.body).toContain('from serve')
    expect(after.body).toContain('from fetch')
  })

  it('streams a feed as it happens, and stops when the reader goes away', async () => {
    const logged: string[] = []
    const { team, token, port } = await both({ serve: { log: (line) => logged.push(line) } })
    const response = await team.fetch(new Request(`http://127.0.0.1:${port}/api/board/feed`, { headers: { authorization: `Bearer ${token()}`, host: `127.0.0.1:${port}` } }))
    expect([response.status, response.headers.get('content-type')]).toEqual([200, 'text/event-stream'])
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = decoder.decode((await reader.read()).value)
    expect(text).toBe(': connected\n\n')
    // Answered before anything happened: the feed is open, and what is posted now arrives on it.
    await team.post({ channel: 'general', text: 'later' })
    while (!text.includes('event: message.posted')) text += decoder.decode((await reader.read()).value)
    expect(text).toContain('"text":"later"')
    await reader.cancel()
    // Gone means gone: what happens next isn't written to a stream nobody reads, which would fail in the owner's log.
    await team.post({ channel: 'general', text: 'after the reader left' })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(logged).toEqual([])
  })

  it('serves under the base it is given, and nowhere else', async () => {
    const { token, viaFetch } = await both({ serve: { base: '/team/board' } })
    const authorization = `Bearer ${token()}`
    expect((await viaFetch({ path: '/team/board/head', headers: { authorization } })).status).toBe(200)
    expect((await viaFetch({ method: 'GET', path: '/team/board/health' })).status).toBe(200)
    // Not under the base: not even the path mu serve uses.
    // Paths as long as the base, or longer, that aren't under it: the base is matched, not just its length skipped.
    for (const path of ['/api/board/head', '/team/boardhead', '/team/board', '/team/head', '/head', '/aaaa/bbbbb/head', '/team/boarx/head', '/xxxx/yyyyy/whoami']) {
      const answer = await viaFetch({ path, headers: { authorization } })
      expect([path, answer.status, JSON.parse(answer.body).error.reason]).toEqual([path, 404, 'not_found'])
    }
    expect(() => board({ serve: { base: 'team' } })).toThrow(/base/)
    expect(() => board({ serve: { base: '/team/' } })).toThrow(/base/)
  })

  it('refuses a host it was not given, and answers for one it was', async () => {
    const { token, viaFetch } = await both({ serve: { hosts: ['board.example.com'] } })
    const authorization = `Bearer ${token()}`
    const refused = await viaFetch({ path: '/api/board/head', headers: { authorization }, host: 'evil.example' })
    expect([refused.status, JSON.parse(refused.body).error.reason]).toEqual([403, 'forbidden'])
    // The name is the Host the client sent, not whatever the URL was rebuilt with.
    expect((await viaFetch({ path: '/api/board/head', headers: { authorization }, host: 'board.example.com' })).status).toBe(200)
    expect((await viaFetch({ path: '/api/board/head', headers: { authorization }, host: 'BOARD.example.com:443' })).status).toBe(200)
    expect((await viaFetch({ path: '/api/board/head', headers: { authorization }, host: 'board.example.com.evil.example' })).status).toBe(403)
  })

  it('needs a token for a read and for a write: there is no way in without one', async () => {
    const { viaFetch } = await both()
    for (const asked of [
      { path: '/api/board/readChannel', body: { args: [{ channel: 'general' }] } },
      { path: '/api/board/post', body: { args: [{ channel: 'general', text: 'anonymous' }] } },
      { path: '/api/board/post', headers: { authorization: 'Bearer ' }, body: { args: [{ channel: 'general', text: 'empty' }] } },
      { method: 'GET', path: '/api/board/feed?after=0' },
    ] as Asked[]) {
      const answer = await viaFetch(asked)
      expect([asked.path, answer.status, JSON.parse(answer.body).error.reason]).toEqual([asked.path, 401, 'unauthorized'])
    }
  })

  it('refuses a request that names no host, rather than taking the name from its URL', async () => {
    const { token, port, team } = await both()
    const answer = await team.fetch(new Request(`http://127.0.0.1:${port}/api/board/head`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } }))
    expect([answer.status, (await answer.json()).error.reason]).toEqual([403, 'forbidden'])
  })

  it('a failure before it can answer is the same short 500, said to the owner, and the next request tries again', async () => {
    const dir = tempDir()
    const key = randomBytes(32)
    const backend = file({ dir: join(dir, 'board'), key })
    let tries = 0
    const flaky: Backend = { ...backend, signingKey: () => (tries++ === 0 ? (() => { throw new Error('EACCES: /home/ada/.config/muster/keys/x.key') })() : key) }
    const logged: string[] = []
    const team = board({ backend: flaky, serve: { log: (line) => logged.push(line) } })
    closers.push(() => team.close())
    const token = mint(key, { sub: 'local:user:ada', profile: null, exp: Math.floor(Date.now() / 1000) + 3600 })
    const head = () => team.fetch(new Request('http://127.0.0.1/api/board/head', { method: 'POST', headers: { authorization: `Bearer ${token}`, host: '127.0.0.1' } }))
    const failed = await head()
    const text = await failed.text()
    expect([failed.status, JSON.parse(text).error.reason]).toEqual([500, 'internal'])
    expect(text).not.toContain('/home/ada')
    expect(logged.join('\n')).toContain('EACCES')
    expect((await head()).status).toBe(200)
  })

  it("takes a webhook for the handle's sync: signed by the platform, with no token", async () => {
    const secret = 'webhook-secret'
    const { team, viaServe, viaFetch } = await both({ sync: { gh: github({ secret, repos: { 'acme/web': 'web' } }) } })
    const hook = (number: number, title: string, signature?: string): Asked => {
      const raw = JSON.stringify({ action: 'opened', issue: { number, title, body: '' }, repository: { full_name: 'acme/web' }, sender: { login: 'nico' } })
      const signed = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
      return { path: '/api/board/webhooks/gh', headers: { 'x-github-event': 'issues', 'x-github-delivery': `d-${number}`, 'x-hub-signature-256': signature ?? signed }, raw }
    }
    // Tampered with, or signed with another secret: refused the same way by both.
    const forged = await viaFetch(hook(1, 'forged', 'sha256=bad'))
    expect(forged).toEqual(await viaServe(hook(1, 'forged', 'sha256=bad')))
    expect(forged.status).toBe(401)
    expect((await viaFetch(hook(2, 'through team.fetch'))).status).toBe(200)
    expect((await viaServe(hook(3, 'through mu serve'))).status).toBe(200)
    expect((await team.readChannel({ channel: 'web' })).threads.map((thread) => thread.message.text).sort()).toEqual(['through mu serve', 'through team.fetch'])
  })

  it("holds a body to mu serve's limits as it arrives", async () => {
    const { viaFetch } = await both()
    const answer = await viaFetch({ path: '/api/board/webhooks/github', body: 'x'.repeat(1024 * 1024 + 1) })
    expect([answer.status, JSON.parse(answer.body).error.reason]).toEqual([400, 'body_too_large'])
  })

  it('serves only a board on this machine: a handle on a board at a URL refuses', async () => {
    const { token, port } = await both()
    const remote = board({ backend: http({ url: `http://127.0.0.1:${port}/api/board`, token: token() }) })
    const answer = await remote.fetch(new Request(`http://127.0.0.1:${port}/api/board/head`, { method: 'POST', headers: { authorization: `Bearer ${token()}` } }))
    expect([answer.status, (await answer.json()).error.reason]).toEqual([403, 'forbidden'])
  })

  it('a token from mu token create works on it: one key, the board kept on disk', async () => {
    const dir = tempDir()
    const config = join(dir, 'config')
    const before = process.env.MUSTER_CONFIG
    process.env.MUSTER_CONFIG = config
    try {
      const team = board({ dir: join(dir, 'board') })
      closers.push(() => team.close())
      const made = await team.backend.tokens.create({ profile: null, can: {}, ttl: 3600 })
      const head = (authorization: string) => team.fetch(new Request('http://localhost:3000/api/board/head', { method: 'POST', headers: { authorization, host: 'localhost:3000' } }))
      expect((await head(`Bearer ${made.token}`)).status).toBe(200)
      await team.backend.tokens.revoke({ id: made.record.id })
      const revoked = await head(`Bearer ${made.token}`)
      expect([revoked.status, (await revoked.json()).error.reason]).toEqual([401, 'unauthorized'])
    } finally {
      if (before === undefined) delete process.env.MUSTER_CONFIG
      else process.env.MUSTER_CONFIG = before
    }
  })
})

/** A board whose reads are counted, and whose head is slow, so a client can leave before a feed has opened. */
function counted() {
  const dir = tempDir()
  const key = randomBytes(32)
  const backend = file({ dir: join(dir, 'board'), key })
  let reads = 0
  const slow: Backend = {
    ...backend,
    head: async (caller) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return backend.head(caller)
    },
    events: async (caller, request) => {
      reads++
      return backend.events(caller, request)
    },
  }
  const token = mint(key, { sub: 'local:user:ada', profile: null, exp: Math.floor(Date.now() / 1000) + 3600 })
  return { slow, key, token, reads: () => reads, close: () => backend.close() }
}

/** Whether the board is still being read for a feed nobody holds, 1.5 seconds after the client left. */
async function stillReading(reads: () => number) {
  await new Promise((resolve) => setTimeout(resolve, 800))
  const before = reads()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return reads() - before
}

describe('a feed the client leaves before it opens', () => {
  it('mu serve stops reading the board for it', async () => {
    const { slow, key, token, reads, close } = counted()
    const server = await listen({ backend: slow, key, feedInterval: 20 })
    closers.push(() => server.close(), close)
    const port = Number(new URL(server.url).port)
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/board/feed', method: 'GET', headers: { authorization: `Bearer ${token}` } })
    req.on('error', () => {})
    req.end()
    await new Promise((resolve) => setTimeout(resolve, 5))
    req.destroy()
    expect(await stillReading(reads)).toBe(0)
  })

  it('team.fetch stops reading the board for it', async () => {
    const { slow, token, reads, close } = counted()
    const team = board({ backend: slow })
    closers.push(close)
    const leave = new AbortController()
    const answered = team.fetch(new Request('http://127.0.0.1/api/board/feed', { headers: { authorization: `Bearer ${token}`, host: '127.0.0.1' }, signal: leave.signal })).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, 5))
    leave.abort()
    await answered
    expect(await stillReading(reads)).toBe(0)
  })
})
