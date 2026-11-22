import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { board, file, http, listen } from '../src/index.ts'
import { loadOidc, OIDC_LIVE_MAX, subMatches, subPattern, type Trust } from '../src/serve/oidc.ts'
import { cli, cliStart, reason, tempDir } from './helpers.ts'

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const closers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

/**
 * A real issuer on this machine: a discovery document, a set of keys, and tokens signed with a key it
 * made. It counts the requests it is sent, so a test can tell what the board asked it for.
 */
async function issuer(options: { describeAs?: string } = {}) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let keys = [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }]
  let hits = 0
  let down = false
  let url = ''
  let instead: ((res: import('node:http').ServerResponse) => void) | null = null
  const server: Server = createServer((req, res) => {
    hits += 1
    if (down) return void res.writeHead(503).end()
    if (instead && req.url === '/keys') return instead(res)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') return void res.end(JSON.stringify({ issuer: options.describeAs ?? url, jwks_uri: `${url}/keys` }))
    if (req.url === '/keys') return void res.end(JSON.stringify({ keys }))
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = {}, key: KeyObject = pair.privateKey) => {
    const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header })}.${b64(claims)}`
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`
  }
  return {
    url,
    pair,
    sign,
    hits: () => hits,
    setDown: (value: boolean) => void (down = value),
    answerKeysWith: (answer: typeof instead) => void (instead = answer),
    rotate(kid: string) {
      const next = generateKeyPairSync('rsa', { modulusLength: 2048 })
      keys = [{ ...next.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }]
      return next.privateKey
    },
  }
}

const AUDIENCE = 'https://board.example'
const SUB = 'repo:acme/api:ref:refs/heads/main'

/** A served board that trusts one workload of the issuer, on a clock the test holds. */
async function served(idp: Awaited<ReturnType<typeof issuer>>, trust: Partial<Trust>[] = [{}]) {
  let now = Date.parse('2026-01-01T00:00:00Z')
  const backend = file({ memory: true, principal: 'local:user:ada', now: () => new Date(now) })
  const key = Buffer.alloc(32, 7)
  const oidc: Trust[] = trust.map((entry, at) => ({ name: `ci-${at + 1}`, issuer: idp.url, audience: AUDIENCE, sub: SUB, as: 'ci', can: { 'ci/': ['read', 'post', 'label'] }, ttl: 900, ...entry }))
  const serving = await listen({ backend, key, oidc, now: () => now })
  closers.push(() => serving.close())
  const exchange = (token: unknown) => http({ url: serving.url, token: '' }).tokens.exchange({ token: token as string })
  const claims = (extra: Record<string, unknown> = {}) => ({ iss: idp.url, aud: AUDIENCE, sub: SUB, iat: now / 1000, exp: now / 1000 + 300, jti: Math.random().toString(36), ...extra })
  return { serving, backend, exchange, claims, owner: board({ backend }), advance: (ms: number) => void (now += ms), at: () => now }
}

describe('a workload signs in with its platform\'s token', () => {
  it('gets a board token held to what the owner said: the profile, the channels, and a short life', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const made = await b.exchange(idp.sign(b.claims()))
    expect(made).toMatchObject({ trust: 'ci-1', record: { profile: 'ci', can: { 'ci/': ['read', 'post', 'label'] }, exp: b.at() / 1000 + 900 } })
    const job = board({ backend: http({ url: b.serving.url, token: made.token }), as: 'someone-else' })
    // It writes as the profile the trust names, whatever it asks to be, under a principal that is the trust's name.
    const posted = await job.post({ channel: 'ci/builds', text: 'build 42 passed' })
    expect(posted.by).toEqual({ principal: 'oidc:ci-1', profile: 'ci' })
    // A channel it wasn't given is one it can't tell exists.
    expect(await reason(job.post({ channel: 'general', text: 'elsewhere' }))).toBe('not_found')
    expect(await reason(job.react({ id: posted.id, emoji: 'eyes' }))).toBe('forbidden')
    // It makes no tokens and answers no requests to join, and the owner can stop it like any other.
    expect(await reason(job.backend.tokens.create({ profile: 'ci', can: { 'ci/': ['read'] }, ttl: 60 }))).toBe('forbidden')
    expect(await reason(job.backend.tokens.list())).toBe('forbidden')
    expect(await reason(job.backend.joins.list())).toBe('forbidden')
    expect((await b.owner.backend.tokens.list()).tokens.map((token) => token.id)).toEqual([made.record.id])
    await b.owner.backend.tokens.revoke({ id: made.record.id })
    expect(await reason(job.readChannel({ channel: 'ci/' }))).toBe('unauthorized')
  })

  it('a task the owner queued is one the job takes by ID, or with --from the owner', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const job = board({ backend: http({ url: b.serving.url, token: (await b.exchange(idp.sign(b.claims()))).token }) })
    const { task } = await b.owner.taskCreate({ channel: 'ci/builds', text: 'run the release checks' })
    expect(await reason(job.taskClaim({ ready: 'ci/' }))).toBe('nothing_ready')
    expect((await job.taskClaim({ ready: 'ci/', from: ['local:user:ada'] })).task.id).toBe(task.id)
  })

  it('refuses a token one way until its signature is the issuer\'s, and asks an issuer nobody named for nothing', async () => {
    const idp = await issuer()
    const stranger = await issuer()
    const b = await served(idp)
    const good = b.claims()
    const [header, body] = idp.sign(good).split('.') as [string, string, string]
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const publicPem = idp.pair.publicKey.export({ type: 'spki', format: 'pem' }) as string
    const hs256 = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${body}`
    const attempts: Record<string, unknown> = {
      'nothing': undefined,
      'not a token': 'hello',
      'two parts': `${header}.${body}`,
      'no algorithm': `${b64({ alg: 'none', typ: 'JWT' })}.${body}.`,
      'the public key as a shared secret': `${hs256}.${createHmac('sha256', publicPem).update(hs256).digest('base64url')}`,
      'another key': idp.sign(good, {}, forged),
      'a changed claim': `${header}.${b64({ ...good, sub: 'repo:acme/api:ref:refs/heads/main', aud: AUDIENCE, extra: true })}.${idp.sign(good).split('.')[2]}`,
      'another issuer\'s token': stranger.sign({ ...good, iss: stranger.url }),
      'a token far too long': idp.sign({ ...good, pad: 'x'.repeat(9000) }),
    }
    for (const [what, token] of Object.entries(attempts)) {
      const failure = await b.exchange(token).then(() => null, (error: { reason: string; message: string }) => error)
      expect([what, failure?.reason, failure?.message]).toEqual([what, 'unauthorized', "That isn't a token this board takes."])
    }
    expect(stranger.hits()).toBe(0)
    expect((await b.owner.backend.tokens.list()).tokens).toEqual([])
  })

  it('says which claim didn\'t fit once the issuer vouches for the token', async () => {
    const idp = await issuer()
    const b = await served(idp, [{ sub: 'repo:acme/api:*' }])
    const message = async (extra: Record<string, unknown>) => b.exchange(idp.sign(b.claims(extra))).then(() => 'taken', (error: { reason: string; message: string }) => `${error.reason}: ${error.message}`)
    expect(await message({ aud: 'https://another.example' })).toBe("forbidden: That token isn't made out to this board.")
    expect(await message({ aud: undefined })).toBe("forbidden: That token isn't made out to this board.")
    expect(await message({ exp: b.at() / 1000 - 120 })).toBe('forbidden: That token has run out.')
    expect(await message({ exp: undefined })).toContain('says no time it runs out')
    expect(await message({ nbf: b.at() / 1000 + 600 })).toContain("isn't good yet")
    expect(await message({ sub: undefined })).toBe('forbidden: That token names no subject.')
    // A prefix stops at the boundary the platform draws: another repository whose name starts the same isn't it.
    expect(await message({ sub: 'repo:acme/api-evil:ref:refs/heads/main' })).toBe('forbidden: This board trusts no workload named "repo:acme/api-evil:ref:refs/heads/main".')
    expect(await message({ sub: 'repo:acme/api:' })).toContain('trusts no workload')
    expect(await message({ sub: 'repo:acme/api:pull_request' })).toBe('taken')
    expect(await message({ aud: ['https://another.example', AUDIENCE] })).toBe('taken')
  })

  it('takes a workload token once, and holds one workload to so many board tokens at a time', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const token = idp.sign(b.claims())
    await b.exchange(token)
    expect(await reason(b.exchange(token))).toBe('forbidden')
    for (let i = 1; i < OIDC_LIVE_MAX; i++) await b.exchange(idp.sign(b.claims()))
    expect(await reason(b.exchange(idp.sign(b.claims())))).toBe('too_many_tokens')
    // The owner's own tokens are not what ran out, and when the workload's run out it signs in again.
    expect((await b.owner.backend.tokens.create({ profile: 'lead', ttl: 3600 })).record.profile).toBe('lead')
    b.advance(16 * 60_000)
    expect((await b.exchange(idp.sign(b.claims()))).trust).toBe('ci-1')
  })

  it('fetches an issuer\'s keys once, again for a key it hasn\'t seen at most once a minute, and says when it can\'t', async () => {
    const idp = await issuer()
    const b = await served(idp)
    await b.exchange(idp.sign(b.claims()))
    await b.exchange(idp.sign(b.claims()))
    expect(idp.hits()).toBe(2)
    // A new key, under a new ID: within the minute the board doesn't ask again, so a flood of unknown IDs costs the issuer nothing.
    const next = idp.rotate('k2')
    expect(await reason(b.exchange(idp.sign(b.claims(), { kid: 'k2' }, next)))).toBe('unauthorized')
    expect(idp.hits()).toBe(2)
    b.advance(61_000)
    expect((await b.exchange(idp.sign(b.claims(), { kid: 'k2' }, next))).trust).toBe('ci-1')
    expect(idp.hits()).toBe(4)
    // An issuer that is down is said to be down, and isn't asked again for a minute.
    const other = await issuer()
    const c = await served(other)
    other.setDown(true)
    expect(await reason(c.exchange(other.sign(c.claims())))).toBe('issuer_unreachable')
    expect(await reason(c.exchange(other.sign(c.claims())))).toBe('issuer_unreachable')
    expect(other.hits()).toBe(1)
    other.setDown(false)
    c.advance(61_000)
    expect((await c.exchange(other.sign(c.claims()))).trust).toBe('ci-1')
  })

  it('asks an issuer once for a burst of sign-ins', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const made = await Promise.all(Array.from({ length: 20 }, () => b.exchange(idp.sign(b.claims()))))
    expect(made).toHaveLength(20)
    expect(idp.hits()).toBe(2)
  })

  it('a token written another way is the same token: not taken twice, and not taken at all unless it is plain base64url', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const token = idp.sign(b.claims())
    const [header, body, signature] = token.split('.') as [string, string, string]
    const standard = Buffer.from(signature, 'base64url').toString('base64')
    await b.exchange(token)
    for (const again of [`${header}.${body}.${standard}`, `${header}.${body}.${signature}=`, `${header}.${body}.${signature}\n`, ` ${token}`]) {
      const refusal = await reason(b.exchange(again))
      expect([again === token, ['unauthorized', 'forbidden'].includes(refusal)]).toEqual([false, true])
    }
    expect((await b.owner.backend.tokens.list()).tokens).toHaveLength(1)
  })

  it("a token that got no board token isn't spent", async () => {
    const idp = await issuer()
    const b = await served(idp)
    for (let i = 0; i < OIDC_LIVE_MAX; i++) await b.exchange(idp.sign(b.claims()))
    const waiting = idp.sign(b.claims({ exp: b.at() / 1000 + 3600 }))
    expect(await reason(b.exchange(waiting))).toBe('too_many_tokens')
    b.advance(16 * 60_000)
    expect((await b.exchange(waiting)).trust).toBe('ci-1')
    expect(await reason(b.exchange(waiting))).toBe('forbidden')
  })

  it('says an issuer is unreachable without saying why to someone with no token', async () => {
    const idp = await issuer({ describeAs: 'https://token.actions.githubusercontent.com' })
    const b = await served(idp)
    const failure = await b.exchange(idp.sign(b.claims())).then(() => null, (error: { reason: string; hint?: string }) => error)
    expect(failure?.reason).toBe('issuer_unreachable')
    expect(failure?.hint).not.toContain('another issuer')
    expect(failure?.hint).not.toContain('/keys')
  })

  it('reads no more of an issuer\'s answer than a set of keys is, however it is sent', async () => {
    const big = await issuer()
    big.answerKeysWith((res) => {
      // No length said, and far more than keys: it must be dropped as it arrives, not read to the end.
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      let sent = 0
      const more = () => {
        while (sent < 64 * 1024 * 1024 && res.write(chunk)) sent += chunk.length
        if (sent < 64 * 1024 * 1024 && !res.destroyed) res.once('drain', more)
        else res.end()
      }
      res.on('error', () => {})
      more()
    })
    const b = await served(big)
    const before = process.memoryUsage().rss
    expect(await reason(b.exchange(big.sign(b.claims())))).toBe('issuer_unreachable')
    expect(process.memoryUsage().rss - before).toBeLessThan(40 * 1024 * 1024)
    const packed = await issuer()
    packed.answerKeysWith((res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)))
    })
    const c = await served(packed)
    expect(await reason(c.exchange(packed.sign(c.claims())))).toBe('issuer_unreachable')
  })

  it('keeps the keys it has when an issuer fails to answer for new ones', async () => {
    const idp = await issuer()
    const b = await served(idp)
    await b.exchange(idp.sign(b.claims()))
    b.advance(61_000)
    idp.setDown(true)
    // An unknown key ID makes the board ask again, and the issuer is down: nobody gets in with it.
    expect(await reason(b.exchange(idp.sign(b.claims(), { kid: 'unknown' })))).toBe('unauthorized')
    // The job the issuer really signed for still does.
    expect((await b.exchange(idp.sign(b.claims()))).trust).toBe('ci-1')
  })

  it('the most exact trust that fits is the one that applies, whatever the file\'s order', async () => {
    const idp = await issuer()
    const b = await served(idp, [{ sub: 'repo:acme/*', as: 'org' }, { sub: 'repo:acme/api:*', as: 'api' }, { sub: SUB, as: 'main', noSync: true }])
    expect((await b.exchange(idp.sign(b.claims()))).record.profile).toBe('main')
    expect((await b.exchange(idp.sign(b.claims({ sub: 'repo:acme/api:pull_request' })))).record.profile).toBe('api')
    expect((await b.exchange(idp.sign(b.claims({ sub: 'repo:acme/web:ref:refs/heads/main' })))).record.profile).toBe('org')
  })

  it('a workload\'s file allowance is its trust\'s, however many tokens it trades for', async () => {
    const idp = await issuer()
    const b = await served(idp)
    const job = async () => board({ backend: http({ url: b.serving.url, token: (await b.exchange(idp.sign(b.claims()))).token }) })
    // Each file differs, so each is stored: 24 MB at a time against the 100 MB a narrowed caller has in a day.
    const store = async (team: Awaited<ReturnType<typeof job>>, at: number) => reason(team.filePut({ name: `log-${at}.bin`, data: Buffer.alloc(24 * 1024 * 1024, at + 1).toString('base64') }))
    const results: string[] = []
    for (let i = 0; i < 5; i++) results.push(await store(await job(), i))
    expect(results).toEqual(['did not fail', 'did not fail', 'did not fail', 'did not fail', 'file_allowance'])
  }, 30_000)

  it('takes no keys from an issuer that describes itself as another', async () => {
    const idp = await issuer({ describeAs: 'https://token.actions.githubusercontent.com' })
    const b = await served(idp)
    expect(await reason(b.exchange(idp.sign(b.claims())))).toBe('issuer_unreachable')
  })

  it('is closed on a board whose owner named no workload', async () => {
    const backend = file({ memory: true, principal: 'local:user:ada' })
    const serving = await listen({ backend, key: Buffer.alloc(32, 7) })
    closers.push(() => serving.close())
    expect(await reason(http({ url: serving.url, token: '' }).tokens.exchange({ token: 'a.b.c' }))).toBe('exchange_closed')
  })
})

describe('the owner\'s trusts', () => {
  it('a subject is exact, or a prefix whose * follows a : or / with something before it', () => {
    for (const pattern of ['repo:acme/api:ref:refs/heads/main', 'repo:acme/api:*', 'project_path:acme/*', 'repo:acme/*', 'system:serviceaccount:ci:*']) expect([pattern, subPattern(pattern)]).toEqual([pattern, pattern])
    for (const pattern of ['*', ':*', '/*', 'repo*', 'repo:acme/api*', 'repo:*:ref', 'repo:**', 'repo:*', 'project_path:*', 'acme/*', 'repo::*', '', 3, undefined]) expect([pattern, subPattern(pattern)]).toEqual([pattern, null])
    expect(subMatches('repo:acme/api:*', 'repo:acme/api:ref:refs/heads/main')).toBe(true)
    expect(subMatches('repo:acme/api:*', 'repo:acme/api-evil:ref:refs/heads/main')).toBe(false)
    expect(subMatches('repo:acme/api:*', 'repo:acme/api:')).toBe(false)
    expect(subMatches('repo:acme/api:ref:refs/heads/main', 'repo:acme/api:ref:refs/heads/main2')).toBe(false)
  })

  it('a file that is wrong stops the board, saying which trust and what it needs', () => {
    const dir = tempDir()
    const path = join(dir, 'oidc.json')
    const good = { name: 'ci', issuer: 'https://token.actions.githubusercontent.com', audience: 'https://board.example', sub: 'repo:acme/api:*', as: 'ci', can: { 'ci/': ['read', 'post'] } }
    const load = (entry: Record<string, unknown>) => {
      writeFileSync(path, JSON.stringify({ trust: [entry] }))
      try {
        return loadOidc(path)
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(loadOidc(join(dir, 'none.json'))).toEqual([])
    expect(load(good)).toEqual([{ ...good, ttl: 900 }])
    expect(load({ ...good, ttl: '30m' })).toMatchObject([{ ttl: 1800 }])
    const wrong: [Record<string, unknown>, string][] = [
      [{ ...good, name: 'CI Main' }, 'needs a "name"'],
      [{ ...good, issuer: 'http://issuer.example' }, 'needs an "issuer"'],
      [{ ...good, issuer: 'https://user:pass@issuer.example' }, 'needs an "issuer"'],
      [{ ...good, audience: '' }, 'needs an "audience"'],
      [{ ...good, audience: undefined }, 'needs an "audience"'],
      [{ ...good, sub: undefined }, 'needs a "sub"'],
      [{ ...good, sub: '*' }, 'needs a "sub"'],
      [{ ...good, sub: 'repo:acme/api*' }, 'needs a "sub"'],
      [{ ...good, as: undefined }, 'needs "as"'],
      [{ ...good, can: {} }, 'needs "can"'],
      [{ ...good, can: undefined }, 'needs "can"'],
      [{ ...good, can: { '*': ['read'] } }, 'names every channel'],
      [{ ...good, can: { 'ci/': ['manage'] } }, "aren't from"],
      [{ ...good, can: { 'ci/': [] } }, "aren't from"],
      [{ ...good, ttl: '2h' }, 'has a "ttl"'],
      [{ ...good, ttl: 30 }, 'has a "ttl"'],
      [{ ...good, jwks: 'http://keys.example/jwks' }, 'has a "jwks"'],
      [{ ...good, sub: 'repo:*' }, 'needs a "sub"'],
      [{ ...good, can: JSON.parse('{"__proto__":["read"]}') }, "isn't a channel"],
      [{ ...good, can: { 'Work Items': ['read'] } }, "isn't a channel"],
      [{ ...good, noSync: 'yes' }, 'has a "noSync"'],
    ]
    for (const [entry, says] of wrong) expect([says, String(load(entry)).includes(says)]).toEqual([says, true])
    writeFileSync(path, '{ not json')
    expect(() => loadOidc(path)).toThrow(/isn't JSON/)
    writeFileSync(path, JSON.stringify({ trust: [good, good] }))
    expect(() => loadOidc(path)).toThrow(/Two trusts/)
    writeFileSync(path, JSON.stringify({ trust: [good, { ...good, name: 'other', jwks: 'https://keys.example/jwks' }] }))
    expect(() => loadOidc(path)).toThrow(/one issuer and different "jwks"/)
  })
})

describe('mu token exchange', () => {
  it('a job trades its token for a board token and works with it; the token is never an argument', async () => {
    const idp = await issuer()
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'oidc.json'), JSON.stringify({ trust: [{ name: 'ci-main', issuer: idp.url, audience: AUDIENCE, sub: SUB, as: 'ci', can: { 'ci/': ['read', 'post'] }, ttl: '15m' }] }))
    await cli(dir, ['post', 'general', 'board exists'])
    const serving = cliStart(dir, ['serve', '--port', '0', '--no-token'])
    for (let i = 0; i < 100 && !serving.output().includes('token  none'); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(serving.output()).toContain('oidc   1 workload signs in with mu token exchange: ci-main')
    const url = /url {4}(\S+)/.exec(serving.output())![1]!
    const now = Date.now() / 1000
    const jwt = () => idp.sign({ iss: idp.url, aud: AUDIENCE, sub: SUB, iat: now, exp: now + 300, jti: Math.random().toString(36) })
    // A runner elsewhere: its own home, no token for the board, only the one its platform gave it.
    const runner = tempDir()
    const piped = await cli(runner, ['token', 'exchange', '-'], { env: { MUSTER_URL: url }, input: jwt() })
    expect([piped.code, piped.stderr]).toEqual([0, ''])
    const token = piped.stdout.trim()
    expect(token).toMatch(/^mu1\./)
    const fromEnv = await cli(runner, ['token', 'exchange', '--json'], { env: { MUSTER_URL: url, MUSTER_OIDC_TOKEN: jwt() } })
    expect(JSON.parse(fromEnv.stdout)).toMatchObject({ trust: 'ci-main', claims: { profile: 'ci', can: { 'ci/': ['read', 'post'] } } })
    const posted = await cli(runner, ['post', 'ci/builds', 'build 42 passed'], { env: { MUSTER_URL: url, MUSTER_TOKEN: token } })
    expect(posted.code).toBe(0)
    expect((await cli(runner, ['whoami', '--json'], { env: { MUSTER_URL: url, MUSTER_TOKEN: token } })).stdout).toContain('"principal": "oidc:ci-main"')
    expect((await cli(runner, ['post', 'general', 'elsewhere', '--json'], { env: { MUSTER_URL: url, MUSTER_TOKEN: token } })).stderr).toContain('"reason": "not_found"')
    const none = await cli(runner, ['token', 'exchange'], { env: { MUSTER_URL: url } })
    expect([none.code, none.stderr.split('\n')[0]]).toEqual([2, "error: Give your platform's token on stdin, as mu token exchange -, or in MUSTER_OIDC_TOKEN."])
    // The job's token goes to the board and nowhere a redirect points, and never over plain http to another machine.
    let leaked = ''
    const thief = createServer((req, res) => {
      req.on('data', (chunk) => (leaked += chunk))
      req.on('end', () => res.end('{}'))
    })
    const bouncer = createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${(thief.address() as { port: number }).port}/api/board/tokenExchange` }).end())
    await new Promise<void>((resolve) => thief.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => bouncer.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise((resolve) => thief.close(() => resolve())), () => new Promise((resolve) => bouncer.close(() => resolve())))
    const bounced = await cli(runner, ['token', 'exchange', '-', '--json'], { env: { MUSTER_URL: `http://127.0.0.1:${(bouncer.address() as { port: number }).port}/api/board` }, input: jwt() })
    expect(bounced.code).not.toBe(0)
    expect(leaked).toBe('')
    const plain = await cli(runner, ['token', 'exchange', '-', '--json'], { env: { MUSTER_URL: 'http://board.example/api/board' }, input: jwt() })
    expect([plain.code, JSON.parse(plain.stderr).error.reason]).toEqual([2, 'insecure_url'])
    const local = await cli(dir, ['token', 'exchange', '-', '--json'], { input: jwt() })
    expect(JSON.parse(local.stderr).error.reason).toBe('exchange_closed')
    serving.child.kill('SIGTERM')
    await serving.done
  }, 30_000)

  it('a trust file that is wrong stops mu serve before it listens', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'oidc.json'), JSON.stringify({ trust: [{ name: 'ci', issuer: 'https://issuer.example', audience: 'x', sub: '*', as: 'ci', can: { 'ci/': ['read'] } }] }))
    const run = await cli(dir, ['serve', '--port', '0', '--no-token'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('needs a "sub"')
    expect(run.stdout).not.toContain('url ')
  }, 20_000)
})
