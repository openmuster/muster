import { describe, expect, it } from 'vitest'
import { file } from '../src/index.ts'
import { JOINS_MAX } from '../src/serve/joins.ts'
import { cli, cliStart, clock, reason, tempDir } from './helpers.ts'

async function serve(extra: string[] = ['--allow-joins']) {
  const dir = tempDir()
  await cli(dir, ['post', 'general', 'board exists'])
  const serving = cliStart(dir, ['serve', '--port', '0', '--print-token', ...extra])
  for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  const url = /MUSTER_URL=(\S+)/.exec(serving.output())![1]!
  const owner = /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]!
  return { dir, url, owner, serving, stop: async () => (serving.child.kill('SIGTERM'), await serving.done) }
}

/** Starts `mu join` and waits for the code it prints for the owner. */
async function ask(dir: string, url: string, args: string[] = []) {
  const joining = cliStart(dir, ['join', url, '--as', 'fixer', '--json', ...args])
  let stderr = ''
  joining.child.stderr.on('data', (chunk) => (stderr += chunk))
  for (let i = 0; i < 100 && !/code {5}\S+/.test(stderr); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  return { joining, code: /code {5}(\S+)/.exec(stderr)?.[1] ?? '' }
}

describe('joining a served board', () => {
  it('is closed unless the owner opens it', async () => {
    const board = await serve([])
    const run = await cli(board.dir, ['join', board.url, '--as', 'fixer', '--json'])
    expect([run.code, JSON.parse(run.stderr).error.reason]).toEqual([1, 'joins_closed'])
    expect(board.serving.output()).not.toContain('joins  open')
    await board.stop()
  }, 20_000)

  it('an agent asks, the owner sees the code and approves with channels, and the agent gets a token held to them', async () => {
    const board = await serve()
    expect(board.serving.output()).toContain('joins  open')
    const { joining, code } = await ask(board.dir, board.url, ['--note', 'the review bot'])
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    const listed = JSON.parse((await cli(board.dir, ['join', 'list', '--json'])).stdout).joins
    expect(listed).toMatchObject([{ code, profile: 'fixer', note: 'the review bot', state: 'pending' }])
    const refused = await cli(board.dir, ['join', 'approve', code, '--json'])
    expect([refused.code, JSON.parse(refused.stderr).error.reason]).toEqual([2, 'invalid_token'])
    expect((await cli(board.dir, ['join', 'approve', code.toLowerCase().replace('-', ''), '--can', 'work/=read,post', '--ttl', '1h'])).stdout).toMatch(new RegExp(`^approved  ${code}  fixer  until `))
    const joined = await joining.done
    expect(joined.code).toBe(0)
    const { token, url, profile } = JSON.parse(joined.stdout)
    expect([url, profile]).toEqual([board.url, 'fixer'])
    const env = { MUSTER_URL: board.url, MUSTER_TOKEN: token }
    expect(JSON.parse((await cli(board.dir, ['post', 'work/intake', 'joined', '--as', 'lead', '--json'], { env })).stdout).message.by.profile).toBe('fixer')
    const elsewhere = await cli(board.dir, ['post', 'general', 'not here', '--json'], { env })
    expect([elsewhere.code, JSON.parse(elsewhere.stderr).error.reason]).toEqual([1, 'not_found'])
    // Picked up: the request is gone, and the token is on the board's list, where it can be revoked.
    expect(JSON.parse((await cli(board.dir, ['join', 'list', '--json'])).stdout).joins).toEqual([])
    expect(JSON.parse((await cli(board.dir, ['token', 'list', '--json'])).stdout).tokens.map((made: { profile: string }) => made.profile)).toContain('fixer')
    await board.stop()
  }, 30_000)

  it('a refused request ends the wait with join_denied', async () => {
    const board = await serve()
    const { joining, code } = await ask(board.dir, board.url)
    expect((await cli(board.dir, ['join', 'deny', code])).stdout).toBe(`denied  ${code}  fixer\n`)
    const joined = await joining.done
    expect([joined.code, JSON.parse(joined.stderr.slice(joined.stderr.indexOf('{'))).error.reason]).toEqual([1, 'join_denied'])
    await board.stop()
  }, 30_000)

  it('only the agent that asked picks up the token, and only once', async () => {
    const board = await serve()
    const call = (route: string, request: object) => fetch(`${board.url}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: [request] }) }).then((response) => response.json() as Promise<any>)
    const asked = (await call('joinAsk', { profile: 'fixer' })).ok
    await cli(board.dir, ['join', 'approve', asked.code, '--can', 'work/=read'])
    expect((await call('joinPoll', { code: asked.code, secret: 'guessed' })).error.reason).toBe('unknown_join')
    expect((await call('joinPoll', { code: asked.code, secret: asked.secret })).ok).toMatchObject({ state: 'approved', token: expect.stringMatching(/^mu1\./) })
    expect((await call('joinPoll', { code: asked.code, secret: asked.secret })).error.reason).toBe('unknown_join')
    expect((await call('joinAsk', { profile: 'fixer', note: 'x'.repeat(5000) })).error.reason).toBe('body_too_large')
    await board.stop()
  }, 20_000)

  it('the owner can answer over HTTP, by the rules for making a token there', async () => {
    const board = await serve()
    const env = { MUSTER_URL: board.url, MUSTER_TOKEN: board.owner }
    const first = (await fetch(`${board.url}/joinAsk`, { method: 'POST', body: JSON.stringify({ args: [{ profile: 'fixer' }] }) }).then((response) => response.json() as Promise<any>)).ok
    const everywhere = await cli(board.dir, ['join', 'approve', first.code, '--can', '*=read', '--json'], { env })
    expect([everywhere.code, JSON.parse(everywhere.stderr).error.reason]).toEqual([2, 'invalid_token'])
    expect((await cli(board.dir, ['join', 'approve', first.code, '--can', 'work/=read'], { env })).code).toBe(0)
    const narrow = (await cli(board.dir, ['token', 'create', '--as', 'x', '--can', 'work/=read'])).stdout.trim()
    const list = await cli(board.dir, ['join', 'list', '--json'], { env: { ...env, MUSTER_TOKEN: narrow } })
    expect([list.code, JSON.parse(list.stderr).error.reason]).toEqual([1, 'forbidden'])
    await board.stop()
  }, 20_000)
})

describe('requests to join, kept by the board', () => {
  it(`keeps at most ${JOINS_MAX} waiting, and forgets one after 15 minutes`, async () => {
    const time = clock()
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now })
    for (let i = 0; i < JOINS_MAX; i++) await backend.joins.ask({ profile: `agent-${i}` })
    expect(await reason(backend.joins.ask({ profile: 'one-more' }))).toBe('too_many_joins')
    time.advance(15 * 60_000)
    expect((await backend.joins.list()).joins).toEqual([])
    const asked = await backend.joins.ask({ profile: 'one-more' })
    expect(await reason(backend.joins.ask({ profile: 'Not A Name!' }))).not.toBe('did not fail')
    for (const note of ['ok\u001b[2K\rK7Q4-M2XD reviewer approved', 'two\nlines', 'right\u202eto left', 'c1\u009bcontrol']) expect(await reason(backend.joins.ask({ profile: 'spoof', note }))).toBe('invalid_note')
    expect(await backend.joins.poll({ code: asked.code, secret: asked.secret })).toEqual({ state: 'pending' })
    expect(await reason(backend.joins.approve({ code: 'K7Q4-M2XD', can: { work: ['read'] }, ttl: 3600 }))).toBe('unknown_join')
    await backend.joins.deny({ code: asked.code })
    expect(await reason(backend.joins.approve({ code: asked.code, can: { work: ['read'] }, ttl: 3600 }))).toBe('join_answered')
  })
})
