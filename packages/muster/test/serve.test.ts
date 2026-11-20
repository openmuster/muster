import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { board, boardKey, file, http, listen, mint, verify } from '../src/index.ts'
import { processStart } from '../src/process.ts'
import { cli, cliStart, clock, reason, tempDir } from './helpers.ts'

async function served() {
  const time = clock()
  const backend = file({ memory: true, principal: 'local:user:ada', now: time.now })
  const key = randomBytes(32)
  const server = await listen({ backend, key, now: () => time.now().getTime(), feedInterval: 20 })
  const exp = Math.floor(time.now().getTime() / 1000) + 3600
  const token = (claims: Partial<Parameters<typeof mint>[1]> = {}) => mint(key, { sub: 'local:user:ada', profile: null, exp, ...claims })
  const as = (claims: Partial<Parameters<typeof mint>[1]> = {}) => board({ backend: http({ url: server.url, token: token(claims) }) })
  const raw = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init)
  return { server, key, time, token, as, raw, owner: board({ backend }) }
}

describe('serve', () => {
  it('whoami over a token says serve mode and who the token speaks for', async () => {
    const { as, server } = await served()
    expect(await as().as('claude').whoami()).toEqual({ principal: 'local:user:ada', profile: 'claude', mode: 'serve', where: server.url })
    await server.close()
  })

  it('refuses no token, a forged one, one signed by another board, and one that ran out', async () => {
    const { server, raw, token, time } = await served()
    const post = (authorization?: string) => raw('/head', { method: 'POST', headers: authorization ? { authorization } : {} })
    expect((await post()).status).toBe(401)
    expect((await post('Bearer nonsense')).status).toBe(401)
    expect((await post(`Bearer ${mint(randomBytes(32), { sub: 'local:user:ada', profile: null, exp: 9_999_999_999 })}`)).status).toBe(401)
    const [head, body] = token().split('.')
    const forged = `${head}.${Buffer.from(JSON.stringify({ sub: 'local:user:root', profile: null, exp: 9_999_999_999 })).toString('base64url')}.${token().split('.')[2]}`
    expect(body).toBeDefined()
    expect((await post(`Bearer ${forged}`)).status).toBe(401)
    expect((await post(`Bearer ${token()}`)).status).toBe(200)
    time.advance(3601_000)
    const late = await post(`Bearer ${token()}`)
    expect([late.status, (await late.json()).error.reason]).toEqual([401, 'unauthorized'])
    await server.close()
  })

  it("a token held to a profile writes as that profile whatever the request asks, and can't forge who wrote", async () => {
    const { as, server } = await served()
    const fixer = as({ profile: 'fixer' })
    const message = await fixer.as('admin').post({ channel: 'work', text: 'hi', by: { principal: 'local:user:root', profile: null } } as never)
    expect(message.by).toEqual({ principal: 'local:user:ada', profile: 'fixer' })
    await server.close()
  })

  it('`can` narrows a token by channel and permission; a channel it cannot read does not exist for it', async () => {
    const { as, owner, server } = await served()
    const inside = await owner.post({ channel: 'factory/intake', text: 'bug' })
    const secret = await owner.post({ channel: 'security', text: 'unfixed CVE' })
    const agent = as({ profile: 'fixer', can: { 'factory/': ['read', 'post', 'react'], 'dev': ['read'] } })
    expect((await agent.reply({ to: inside.id, text: 'on it' })).text).toBe('on it')
    await agent.react({ id: inside.id, emoji: 'eyes' })
    expect(await reason(agent.label({ id: inside.id, set: { owner: 'fixer' } }))).toBe('forbidden')
    expect(await reason(agent.post({ channel: 'dev', text: 'x' }))).toBe('forbidden')
    expect(await reason(agent.readThread({ id: secret.id }))).toBe('not_found')
    expect(await reason(agent.reply({ to: secret.id, text: 'x' }))).toBe('not_found')
    expect(await reason(agent.readChannel({ channel: 'security' }))).toBe('not_found')
    expect(await reason(agent.post({ channel: 'security', text: 'x' }))).toBe('not_found')
    expect((await agent.channels()).channels.map((channel) => channel.path)).toEqual(['factory/intake'])
    expect((await agent.search({ text: 'CVE' })).messages).toEqual([])
    await owner.as('secops').post({ channel: 'security', text: 'only here' })
    expect((await agent.actors()).actors.map((actor) => actor.handle).sort()).toEqual(['ada', 'fixer'])
    expect((await agent.events({ after: 0 })).events.every((event) => event.channel === 'factory/intake')).toBe(true)
    expect((await agent.readChannel({ channel: 'factory/' })).threads).toHaveLength(1)
    await server.close()
  })

  it('a private channel is reached only by a token that names it: not by * and not by the subtree above it', async () => {
    const { as, owner, server } = await served()
    await owner.createChannel({ path: 'factory/security', private: true })
    const secret = await owner.post({ channel: 'factory/security', text: 'unfixed CVE-123' })
    await owner.post({ channel: 'factory/intake', text: 'public' })
    for (const can of [{ '*': ['read', 'post'] }, { 'factory/': ['read', 'post'] }] as const) {
      const agent = as({ profile: 'fixer', can: can as never })
      expect(await reason(agent.readThread({ id: secret.id }))).toBe('not_found')
      expect(await reason(agent.post({ channel: 'factory/security', text: 'x' }))).toBe('not_found')
      expect((await agent.channels()).channels.map((channel) => channel.path)).toEqual(['factory/intake'])
      expect((await agent.search({ text: 'CVE' })).messages).toEqual([])
      expect((await agent.readChannel({ channel: 'factory/' })).threads.map((thread) => thread.message.text)).toEqual(['public'])
    }
    const cleared = as({ profile: 'secops', can: { 'factory/security': ['read', 'post'] } })
    expect((await cleared.readThread({ id: secret.id })).message.text).toBe('unfixed CVE-123')
    expect((await owner.readChannel({ channel: 'factory/security' })).threads).toHaveLength(1)
    await server.close()
  })

  it('files go through the board too: stored once, carried by a message, and read back only by who can read that message', async () => {
    const { as, owner, server } = await served()
    const data = Buffer.from('{"spans": 3}').toString('base64')
    const agent = as({ profile: 'fixer', can: { 'factory/': ['read', 'post'] } })
    const file = await agent.filePut({ name: 'trace.json', type: 'application/json', data })
    expect(file).toMatchObject({ name: 'trace.json', size: 12 })
    expect((await agent.filePut({ name: 'again.json', data })).id).toBe(file.id)
    const message = await agent.post({ channel: 'factory/intake', text: 'the trace', attachments: [file] })
    expect(Buffer.from((await agent.fileGet({ message: message.id, id: file.id })).data, 'base64').toString()).toBe('{"spans": 3}')
    const secret = await owner.post({ channel: 'security', text: 'private', attachments: [await owner.filePut({ name: 'keys.txt', data: Buffer.from('hunter2').toString('base64') })] })
    expect(await reason(agent.fileGet({ message: secret.id, id: secret.attachments[0]!.id }))).toBe('not_found')
    expect(await reason(agent.fileGet({ message: message.id, id: secret.attachments[0]!.id }))).toBe('not_found')
    expect(await reason(agent.post({ channel: 'factory/intake', text: 'made up', attachments: [{ id: 'f'.repeat(64), name: 'x', type: 't', size: 1 }] }))).toBe('unknown_file')
    await server.close()
  })

  it('a narrowed token sees and cancels only schedules in channels it can read, and only its own', async () => {
    const { as, owner, server } = await served()
    const secret = await owner.scheduleCreate({ channel: 'security', text: 'rotate keys', every: 600 })
    const shared = await owner.as('lead').scheduleCreate({ channel: 'factory/intake', text: 'standup', every: 600 })
    const agent = as({ profile: 'fixer', can: { 'factory/': ['read', 'post'] } })
    const own = await agent.scheduleCreate({ channel: 'factory/intake', text: 'check the PR', every: 600 })
    expect((await agent.scheduleList()).schedules.map((schedule) => schedule.id)).toEqual([own.id])
    expect(await reason(agent.scheduleCancel({ id: secret.id }))).toBe('not_found')
    expect(await reason(agent.scheduleCancel({ id: shared.id }))).toBe('not_yours')
    expect((await agent.scheduleCancel({ id: own.id })).canceled).toBe(true)
    const manager = as({ profile: 'ops', can: { 'factory/': ['manage'] } })
    expect((await manager.scheduleCancel({ id: shared.id })).canceled).toBe(true)
    await server.close()
  })

  it('only a token that may manage registers a schema', async () => {
    const { as, server } = await served()
    expect(await reason(as({ can: { '*': ['read', 'post', 'label'] } }).schemaAdd({ name: 'a@1', schema: {} }))).toBe('forbidden')
    expect((await as({ can: { '*': ['manage'] } }).schemaAdd({ name: 'a@1', schema: {} })).created).toBe(true)
    await server.close()
  })

  it('a token that may manage a channel changes what is not its own there', async () => {
    const { as, owner, server } = await served()
    const task = (await owner.taskCreate({ channel: 'work', text: 't' })).task
    const helper = as({ sub: 'local:user:bo', can: { '*': ['read', 'post', 'label'] } })
    expect(await reason(helper.taskCancel({ id: task.id }))).toBe('task_not_owned')
    const manager = as({ sub: 'local:user:bo', can: { 'work': ['manage'] } })
    expect((await manager.taskCancel({ id: task.id })).task.state).toBe('canceled')
    await server.close()
  })

  it('answers only for its own host name, only on its routes, and never runs the ticker for a client', async () => {
    const { server, raw, token } = await served()
    const authorization = `Bearer ${token()}`
    const port = new URL(server.url).port
    // fetch won't send a Host of the caller's choosing; a browser tricked by DNS rebinding does.
    const rebind = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/board/head', method: 'POST', headers: { authorization, host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0))
      req.end()
    })
    expect(rebind).toBe(403)
    expect((await raw('/scheduleTick', { method: 'POST', headers: { authorization } })).status).toBe(404)
    expect((await raw('/close', { method: 'POST', headers: { authorization } })).status).toBe(404)
    expect((await raw('/self', { method: 'POST', headers: { authorization } })).status).toBe(404)
    expect((await raw('/head', { method: 'GET', headers: { authorization } })).status).toBe(400)
    expect((await raw('/post', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{ not json' })).status).toBe(400)
    await server.close()
  })

  it('the feed streams matching events as they happen, each with the cursor to come back with, and resumes from one', async () => {
    const { owner, server, token, raw } = await served()
    await owner.post({ channel: 'work', text: 'before the feed opened' })
    const open = async (query: string, headers: Record<string, string> = {}) => {
      const response = await raw(`/feed?${query}`, { headers: { authorization: `Bearer ${token()}`, ...headers } })
      const reader = response.body!.getReader()
      let text = ''
      const until = async (count: number) => {
        while ((text.match(/^data: /gm) ?? []).length < count) text += new TextDecoder().decode((await reader.read()).value)
        return [...text.matchAll(/^id: (\d+)\nevent: (\S+)\ndata: (.*)$/gm)].map((match) => ({ id: Number(match[1]), type: match[2], data: JSON.parse(match[3]!) }))
      }
      return { response, until, close: () => reader.cancel() }
    }
    const feed = await open('channel=work')
    expect(feed.response.headers.get('content-type')).toBe('text/event-stream')
    await owner.post({ channel: 'other', text: 'not for this feed' })
    const one = await owner.post({ channel: 'work', text: 'one' })
    await owner.reply({ to: one.id, text: 'two' })
    const seen = await feed.until(2)
    expect(seen.map((event) => [event.type, event.data.data.text])).toEqual([['message.posted', 'one'], ['message.posted', 'two']])
    await feed.close()
    const resumed = await open('channel=work', { 'last-event-id': String(seen[0]!.id) })
    expect((await resumed.until(1)).map((event) => event.data.data.text)).toEqual(['two'])
    await resumed.close()
    expect((await raw('/feed?channel=work')).status).toBe(401)
    await server.close()
  })

  it("a board's signing key is made once and kept, so tokens outlive a restart", () => {
    const dir = tempDir()
    const first = boardKey('/boards/main.db', dir)
    expect(boardKey('/boards/main.db', dir).equals(first)).toBe(true)
    expect(boardKey('/boards/other.db', dir).equals(first)).toBe(false)
    const token = mint(first, { sub: 'local:user:ada', profile: null, exp: 2_000_000_000 })
    expect(verify(boardKey('/boards/main.db', dir), token, 1_000_000_000_000).sub).toBe('local:user:ada')
  })

  it('mu serve prints a URL and a token; another process uses the board with them, and a restart keeps the token good', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'from the file'])
    const start = async () => {
      const serving = cliStart(dir, ['serve', '--port', '0'])
      for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
      const env = { MUSTER_URL: /MUSTER_URL=(\S+)/.exec(serving.output())![1]!, MUSTER_TOKEN: /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]! }
      return { serving, env }
    }
    const first = await start()
    expect((await cli(dir, ['post', 'general', 'over http', '--as', 'claude'], { env: first.env })).stdout).toBe('posted  #2  #general\n')
    expect((await cli(dir, ['whoami'], { env: first.env })).stdout).toContain('mode   serve: this token says who you are and what you may do')
    const scoped = (await cli(dir, ['token', 'create', '--as', 'fixer', '--can', 'factory/=read,post'])).stdout.trim()
    const denied = await cli(dir, ['post', 'general', 'x', '--json'], { env: { ...first.env, MUSTER_TOKEN: scoped } })
    expect([denied.code, JSON.parse(denied.stderr).error.reason]).toEqual([1, 'not_found'])
    first.serving.child.kill('SIGTERM')
    expect((await first.serving.done).code).toBe(0)
    const down = await cli(dir, ['read', 'general', '--json'], { env: first.env })
    expect([down.code, JSON.parse(down.stderr).error.reason]).toEqual([1, 'network_error'])
    const second = await start()
    const again = await cli(dir, ['read', 'general', '--json'], { env: { MUSTER_URL: second.env.MUSTER_URL, MUSTER_TOKEN: first.env.MUSTER_TOKEN } })
    expect(JSON.parse(again.stdout).threads.map((thread: { message: { text: string } }) => thread.message.text).sort()).toEqual(['from the file', 'over http'])
    second.serving.child.kill('SIGTERM')
    await second.serving.done
  }, 30_000)

  it('a board URL with no token is refused before anything is sent', async () => {
    const dir = tempDir()
    const run = await cli(dir, ['read', 'general', '--url', 'http://127.0.0.1:9/api/board', '--json'])
    expect([run.code, JSON.parse(run.stderr).error.reason]).toEqual([1, 'unauthorized'])
  })

  it('a process ID sent over HTTP is dropped: it could only name a process on the board\'s machine', async () => {
    const { server, as, time, owner } = await served()
    const task = (await owner.taskCreate({ channel: 'work', text: 't' })).task
    // This test's own process is alive here. Over a file that would keep a lapsed claim; over HTTP it must not.
    await as({ profile: 'a' }).taskClaim({ id: task.id, lease: 60, pid: process.pid, pidStart: processStart(process.pid) ?? undefined })
    time.advance(61_000)
    expect((await as({ profile: 'b' }).taskClaim({ id: task.id })).task.claim!.by.profile).toBe('b')
    // The same for a task made already claimed: that request carries one too.
    const made = (await as({ profile: 'a' }).taskCreate({ channel: 'work', text: 'u', claim: { lease: 60, pid: process.pid, pidStart: processStart(process.pid) ?? undefined } })).task
    time.advance(61_000)
    expect((await as({ profile: 'b' }).taskClaim({ id: made.id })).task.claim!.by.profile).toBe('b')
    await server.close()
  })

  it('a token that may post nowhere stores no file, and a narrowed one has a day\'s allowance', async () => {
    const { server, as } = await served()
    const data = Buffer.alloc(24 * 1024 * 1024, 1).toString('base64')
    expect(await reason(as({ profile: 'r', can: { 'work/': ['read', 'react', 'label'] } }).filePut({ name: 'f', data: 'eA==' }))).toBe('forbidden')
    const writer = as({ profile: 'w', can: { 'work/': ['read', 'post'] } })
    for (let i = 0; i < 4; i++) await writer.filePut({ name: `f${i}`, data })
    expect(await reason(writer.filePut({ name: 'f5', data }))).toBe('file_allowance')
    // The allowance is each token holder's own, and the owner has none to run out of.
    expect((await as({ profile: 'x', can: { 'work/': ['post'] } }).filePut({ name: 'f', data: 'eA==' })).size).toBe(1)
    await server.close()
  })

  it('makes a token for an agent over HTTP: narrower than the maker\'s, short-lived, and unable to make more', async () => {
    const { server, as, time, owner } = await served()
    const mine = as()
    const made = await mine.backend.tokens.create({ profile: 'fixer', can: { 'work/': ['read', 'post', 'label'] }, ttl: 600 })
    const agent = board({ backend: http({ url: server.url, token: made.token }) })
    // It writes as the profile it was made for, where it was let in, and nowhere else.
    expect((await agent.post({ channel: 'work/login', text: 'hi' })).by.profile).toBe('fixer')
    await owner.post({ channel: 'ops', text: 'private' })
    // A channel it wasn't let into answers as if it weren't there.
    expect(await reason(agent.post({ channel: 'ops', text: 'x' }))).toBe('not_found')
    expect(await reason(agent.readChannel({ channel: 'ops' }))).toBe('not_found')
    // It can't make tokens, list them or stop one.
    expect(await reason(agent.backend.tokens.create({ profile: 'x', can: { 'work/': ['read'] }, ttl: 600 }))).toBe('forbidden')
    expect(await reason(agent.backend.tokens.list())).toBe('forbidden')
    // Nor can any token already held to channels.
    expect(await reason(as({ profile: 'p', can: { 'work/': ['post'] } }).backend.tokens.create({ profile: 'x', can: { 'work/': ['read'] }, ttl: 600 }))).toBe('forbidden')
    // What may be asked for is held to less than the maker has.
    const ask = (request: Parameters<typeof mine.backend.tokens.create>[0]) => reason(mine.backend.tokens.create(request))
    expect(await ask({ can: { 'work/': ['read'] }, ttl: 600 })).toBe('invalid_token')
    expect(await ask({ profile: 'x', can: {}, ttl: 600 })).toBe('invalid_token')
    expect(await ask({ profile: 'x', can: { '*': ['read'] }, ttl: 600 })).toBe('invalid_token')
    expect(await ask({ profile: 'x', can: { 'work/': ['manage'] }, ttl: 600 })).toBe('invalid_token')
    expect(await ask({ profile: 'x', can: { 'work/': ['read'] }, ttl: 25 * 3600 })).toBe('invalid_ttl')
    expect(await ask({ profile: 'x', can: { 'work/': ['fly'] }, ttl: 600 })).toBe('invalid_permission')
    // It never outlives the token it was made from (an hour here), and it runs out when it says.
    expect((await mine.backend.tokens.create({ profile: 'x', can: { 'work/': ['read'] }, ttl: 7200 })).record.exp).toBe(Math.floor(time.now().getTime() / 1000) + 3600)
    time.advance(601_000)
    expect(await reason(agent.readChannel({ channel: 'work/' }))).toBe('unauthorized')
    await server.close()
  })

  it('a token the owner stops is refused at once, and the list says which are live', async () => {
    const { server, as } = await served()
    const mine = as()
    const made = await mine.backend.tokens.create({ profile: 'fixer', can: { 'work/': ['read', 'post'] }, ttl: 600 })
    const agent = board({ backend: http({ url: server.url, token: made.token }) })
    await agent.post({ channel: 'work', text: 'before' })
    expect((await mine.backend.tokens.list()).tokens.map((token) => [token.id, token.profile, token.revoked])).toEqual([[made.record.id, 'fixer', false]])
    expect(await mine.backend.tokens.revoke({ id: made.record.id })).toEqual({ revoked: made.record.id })
    expect(await reason(agent.post({ channel: 'work', text: 'after' }))).toBe('unauthorized')
    expect((await mine.backend.tokens.list()).tokens[0]!.revoked).toBe(true)
    expect(await reason(mine.backend.tokens.revoke({ id: 'nope' }))).toBe('not_found')
    await server.close()
  })

  it('a token marked to keep its words on the board does, whatever a request says, for edits and deletes too', async () => {
    const { server, as, owner } = await served()
    const made = await as().backend.tokens.create({ profile: 'fixer', can: { 'work/': ['read', 'post'] }, ttl: 600, noSync: true })
    const agent = board({ backend: http({ url: server.url, token: made.token }) })
    const posted = await agent.post({ channel: 'work', text: 'hello', noSync: false })
    expect(posted.noSync).toBe(true)
    const root = await owner.post({ channel: 'work', text: 'a thread that syncs' })
    expect((await agent.reply({ to: root.id, text: 'mine' })).noSync).toBe(true)
    await agent.edit({ id: posted.id, text: 'hello again' })
    await agent.remove({ id: posted.id })
    const events = (await owner.events({ after: 0 })).events.filter((event) => event.type === 'message.edited' || event.type === 'message.deleted')
    expect(events.map((event) => (event.data as { noSync?: boolean }).noSync)).toEqual([true, true])
    // The owner's own writes are unmarked.
    expect((await owner.post({ channel: 'work', text: 'x' })).noSync).toBe(false)
    await server.close()
  })
})
