import { createServer, request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { board, boardKey, file, http, listen, mint, verify } from '../src/index.ts'
import { processStart } from '../src/process.ts'
import { TOKENS_MAX } from '../src/serve/tokens.ts'
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

  it('a token that may only read changes nothing: no delete, no task change, and never a cursor the daemon reads from', async () => {
    const { as, owner, server } = await served()
    const mine = await owner.post({ channel: 'work', text: 'the owner wrote this' })
    const hers = await owner.as('lead').post({ channel: 'work', text: 'lead wrote this' })
    const task = (await owner.as('lead').taskCreate({ channel: 'work', text: 't' })).task
    const held = (await owner.as('lead').taskCreate({ channel: 'work', text: 'held' })).task
    await owner.as('lead').taskBlock({ id: held.id, reason: 'wait' })
    const failed = (await owner.as('lead').taskCreate({ channel: 'work', text: 'failed', claim: {} }))
    await owner.as('lead').taskFail({ id: failed.task.id, token: failed.token!, reason: 'no' })
    // The token the access page shows: it reads everything, and is held to no profile, so it "is" the owner.
    const reader = as({ can: { '*': ['read'] } })
    expect(await reason(reader.remove({ id: mine.id }))).toBe('forbidden')
    expect(await reason(reader.remove({ id: hers.id }))).toBe('forbidden')
    expect(await reason(reader.taskCancel({ id: task.id }))).toBe('forbidden')
    expect(await reason(reader.taskAssign({ id: task.id, for: 'x' }))).toBe('forbidden')
    expect(await reason(reader.taskNeeds({ id: task.id, needs: [held.id] }))).toBe('forbidden')
    expect(await reason(reader.taskBlock({ id: task.id, reason: 'mine now' }))).toBe('forbidden')
    expect(await reason(reader.taskUnblock({ id: held.id }))).toBe('forbidden')
    expect(await reason(reader.taskReopen({ id: failed.task.id }))).toBe('forbidden')
    const standup = await owner.scheduleCreate({ channel: 'work', text: 'standup', every: 600 })
    expect(await reason(reader.scheduleCancel({ id: standup.id }))).toBe('forbidden')
    expect((await owner.scheduleList()).schedules.map((schedule) => schedule.id)).toEqual([standup.id])
    expect((await owner.readThread({ id: mine.id })).message.deleted).toBe(false)
    expect((await owner.task(task.id))?.state).toBe('ready')
    // One held to a profile is no better off for its own profile's words and tasks.
    const own = await owner.as('bot').post({ channel: 'work', text: 'bot wrote this' })
    const ownTask = (await owner.as('bot').taskCreate({ channel: 'work', text: 'bot made this' })).task
    const bot = as({ profile: 'bot', can: { work: ['read'] } })
    expect(await reason(bot.remove({ id: own.id }))).toBe('forbidden')
    expect(await reason(bot.taskCancel({ id: ownTask.id }))).toBe('forbidden')
    const ownSchedule = await owner.as('bot').scheduleCreate({ channel: 'work', text: 'bot scheduled this', every: 600 })
    expect(await reason(bot.scheduleCancel({ id: ownSchedule.id }))).toBe('forbidden')
    // With `post` the same profile deletes and cancels what is its own, and still nothing of anyone else's.
    const writer = as({ profile: 'bot', can: { work: ['read', 'post'] } })
    expect(await reason(writer.remove({ id: hers.id }))).toBe('not_yours')
    expect((await writer.remove({ id: own.id })).deleted).toBe(true)
    expect((await writer.taskCancel({ id: ownTask.id })).task.state).toBe('canceled')
    expect((await writer.scheduleCancel({ id: ownSchedule.id })).canceled).toBe(true)
    // The daemon's own cursors: a watcher that runs as `bot`, the owner's webhook.
    await owner.cursorSet('hook:alerts', 3)
    await owner.as('bot').cursorSet('watch:factory', 3)
    for (const token of [reader, bot, writer]) {
      expect(await reason(token.cursorSet('hook:alerts', Number.MAX_SAFE_INTEGER))).toBe('forbidden')
      expect(await reason(token.cursorSet('watch:factory', Number.MAX_SAFE_INTEGER))).toBe('forbidden')
      expect(await reason(token.cursorSet('sync:gh', Number.MAX_SAFE_INTEGER))).toBe('forbidden')
    }
    expect([await owner.cursorGet('hook:alerts'), await owner.as('bot').cursorGet('watch:factory')]).toEqual([3, 3])
    // A reader's own cursor, under a name of its own, still works.
    await bot.cursorSet('inbox', 9)
    expect(await bot.cursorGet('inbox')).toBe(9)
    await server.close()
  })

  it("a schedule in a private channel isn't listed for a token that holds only the subtree above it", async () => {
    const { as, owner, server } = await served()
    await owner.createChannel({ path: 'work/secret', private: true })
    await owner.scheduleCreate({ channel: 'work/secret', text: 'rotate the leaked key', every: 600 })
    const open = await owner.scheduleCreate({ channel: 'work/open', text: 'standup', every: 600 })
    // Held to no profile, so every schedule the owner's principal made is "its own".
    const above = as({ can: { 'work/': ['read'] } })
    expect((await above.scheduleList()).schedules.map((schedule) => schedule.id)).toEqual([open.id])
    const named = as({ can: { 'work/secret': ['read'] } })
    expect((await named.scheduleList()).schedules.map((schedule) => schedule.text)).toEqual(['rotate the leaked key'])
    await server.close()
  })

  it('a schedule stops with the token that made it: once the owner revokes the token, nothing more is sent in its name', async () => {
    const { server, as, owner, time } = await served()
    const made = await as().backend.tokens.create({ profile: 'worker', can: { work: ['read', 'post'] }, ttl: 3000 })
    const worker = board({ backend: http({ url: server.url, token: made.token }) })
    const schedule = await worker.scheduleCreate({ channel: 'work', text: 'still here', every: 60 })
    const kept = await owner.as('lead').scheduleCreate({ channel: 'work', text: 'standup', every: 60 })
    time.advance(61_000)
    expect(await owner.scheduleTick()).toMatchObject({ sent: [schedule.id, kept.id], canceled: [] })
    await as().backend.tokens.revoke({ id: made.record.id })
    time.advance(61_000)
    expect(await owner.scheduleTick()).toMatchObject({ sent: [kept.id], canceled: [schedule.id] })
    time.advance(61_000)
    expect(await owner.scheduleTick()).toMatchObject({ sent: [kept.id], canceled: [] })
    const texts = (await owner.readChannel({ channel: 'work' })).threads.map((thread) => `${thread.message.by.profile}: ${thread.message.text}`)
    expect(texts.filter((text) => text === 'worker: still here')).toHaveLength(1)
    expect((await owner.scheduleList()).schedules.map((each) => each.id)).toEqual([kept.id])
    // A stop is remembered past the token's own end, and past new tokens being made: a schedule that
    // comes due only after its revoked token would have run out is still canceled.
    const slow = await as().backend.tokens.create({ profile: 'slow', can: { work: ['read', 'post'] }, ttl: 60 })
    const later = await board({ backend: http({ url: server.url, token: slow.token }) }).scheduleCreate({ channel: 'work', text: 'much later', at: new Date(time.now().getTime() + 600_000).toISOString() })
    await as().backend.tokens.revoke({ id: slow.record.id })
    time.advance(601_000)
    await as().backend.tokens.create({ profile: 'other', can: { work: ['read'] }, ttl: 60 })
    expect((await owner.scheduleTick()).canceled).toContain(later.id)
    // A token that only ran out was never stopped: what it scheduled goes on, as the access page says.
    const brief = await as().backend.tokens.create({ profile: 'brief', can: { work: ['read', 'post'] }, ttl: 60 })
    const late = await board({ backend: http({ url: server.url, token: brief.token }) }).scheduleCreate({ channel: 'work', text: 'after my time', every: 120 })
    time.advance(121_000)
    expect((await owner.scheduleTick()).sent).toContain(late.id)
    await server.close()
  })

  it('a token held to channels has 20 schedules going at most; the owner has no such limit', async () => {
    const { server, as, owner } = await served()
    const made = await as().backend.tokens.create({ profile: 'worker', can: { work: ['read', 'post'] }, ttl: 600 })
    const worker = board({ backend: http({ url: server.url, token: made.token }) })
    const ids: number[] = []
    for (let i = 0; i < 20; i++) ids.push((await worker.scheduleCreate({ channel: 'work', text: `n${i}`, every: 60 })).id)
    expect(await reason(worker.scheduleCreate({ channel: 'work', text: 'one more', every: 60 }))).toBe('too_many_schedules')
    await worker.scheduleCancel({ id: ids[0]! })
    expect((await worker.scheduleCreate({ channel: 'work', text: 'room again', every: 60 })).text).toBe('room again')
    for (let i = 0; i < 25; i++) await owner.as('worker').scheduleCreate({ channel: 'work', text: `o${i}`, every: 60 })
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
      const serving = cliStart(dir, ['serve', '--port', '0', '--print-token'])
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
    // The printed token is one the board has a record of: it is listed, and its owner can stop it.
    const id = /mu token revoke (\S+) stops it/.exec(first.serving.output())![1]!
    const listed = JSON.parse((await cli(dir, ['token', 'list', '--json'])).stdout).tokens as { id: string; profile: string | null; can: unknown }[]
    expect(listed.find((token) => token.id === id)).toMatchObject({ profile: null, can: null })
    expect((await cli(dir, ['token', 'revoke', id])).stdout).toBe(`revoked  ${id}\n`)
    const stopped = await cli(dir, ['read', 'general', '--json'], { env: { MUSTER_URL: second.env.MUSTER_URL, MUSTER_TOKEN: first.env.MUSTER_TOKEN } })
    expect([stopped.code, JSON.parse(stopped.stderr).error.reason]).toEqual([1, 'unauthorized'])
    expect((await cli(dir, ['read', 'general', '--json'], { env: second.env })).code).toBe(0)
    second.serving.child.kill('SIGTERM')
    await second.serving.done
  }, 30_000)

  it('listening beyond this machine needs the name it is reached by, and then prints no token for a log to keep', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'from the file'])
    const bare = await cli(dir, ['serve', '--port', '0', '--host', '0.0.0.0', '--json'])
    expect([bare.code, JSON.parse(bare.stderr).error.reason]).toEqual([2, 'allow_host_required'])
    const serving = cliStart(dir, ['serve', '--port', '0', '--no-token'], { MUSTER_HOST: '0.0.0.0', MUSTER_ALLOW_HOSTS: 'board.example.com, board.internal' })
    for (let i = 0; i < 100 && !serving.output().includes('token  '); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const output = serving.output()
    expect(output).toContain('listen 0.0.0.0  for board.example.com, board.internal')
    expect(output).toContain('token  none printed: make one with mu token create')
    expect(output).not.toMatch(/mu1\./)
    const url = /url {4}(\S+)/.exec(output)![1]!
    const health = await fetch(`${url}/health`)
    expect([health.status, await health.json()]).toEqual([200, { ok: { version: expect.any(String) } }])
    const token = (await cli(dir, ['token', 'create', '--can', 'general=read'])).stdout.trim()
    // fetch won't send a Host header of a caller's choosing; a proxy in front of the board does.
    const as = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${url}/whoami`, { headers: { authorization: `Bearer ${token}`, host } }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
      })
    expect(await as('board.internal')).toBe(200)
    expect(await as('elsewhere.example')).toBe(403)
    serving.child.kill('SIGTERM')
    await serving.done
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
    // A token held to no profile names one per request, and gets no new allowance for each name it thinks of.
    const loose = as({ can: { 'work/': ['read', 'post'] } })
    for (let i = 0; i < 4; i++) await loose.as(`name-${i}`).filePut({ name: `g${i}`, data: Buffer.alloc(24 * 1024 * 1024, 2 + i).toString('base64') })
    expect(await reason(loose.as('another').filePut({ name: 'g5', data }))).toBe('file_allowance')
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
    // A maker held to a profile can only make a token for that same profile, and passes on its own limits.
    const fixed = as({ profile: 'lead', noSync: true })
    expect(await reason(fixed.backend.tokens.create({ profile: 'someone-else', can: { 'work/': ['read'] }, ttl: 600 }))).toBe('forbidden')
    const child = await fixed.backend.tokens.create({ profile: 'lead', can: { 'work/': ['read', 'post'] }, ttl: 600 })
    expect((await board({ backend: http({ url: server.url, token: child.token }) }).post({ channel: 'work', text: 'kept local' })).noSync).toBe(true)
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

  it('the token list is the board\'s own: two handles on one file see each other\'s tokens and revocations, and it has a ceiling', async () => {
    const dir = tempDir()
    const a = board({ dir, principal: 'local:user:ada' })
    const b = board({ dir, principal: 'local:user:ada' })
    const one = await a.backend.tokens.create({ profile: 'p', can: { 'work/': ['read'] }, ttl: 600 })
    const two = await b.backend.tokens.create({ profile: 'q', can: { 'work/': ['read'] }, ttl: 600 })
    await a.backend.tokens.revoke({ id: one.record.id })
    await b.backend.tokens.create({ profile: 'r', can: { 'work/': ['read'] }, ttl: 600 })
    expect((await b.backend.tokens.list()).tokens.map((token) => [token.profile, token.revoked]).sort()).toEqual([['p', true], ['q', false], ['r', false]])
    expect([a.backend.registry!().revoked(one.record.id), a.backend.registry!().revoked(two.record.id), a.backend.registry!().revoked('never-made')]).toEqual([true, false, true])
    // No more than the ceiling of tokens that still work; what ran out makes room.
    const time = clock()
    const full = file({ memory: true, principal: 'local:user:ada', now: time.now })
    for (let i = 0; i < TOKENS_MAX; i++) await full.tokens.create({ profile: 'p', can: { 'work/': ['read'] }, ttl: 600 })
    expect(await reason(full.tokens.create({ profile: 'p', can: { 'work/': ['read'] }, ttl: 600 }))).toBe('too_many_tokens')
    time.advance(601_000)
    expect((await full.tokens.create({ profile: 'p', can: { 'work/': ['read'] }, ttl: 600 })).record.profile).toBe('p')
  })

  it('a token revoked from the command line is refused by a board being served from the same file', async () => {
    const time = clock()
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now })
    const key = randomBytes(32)
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    const made = await file({ memory: true }).tokens.create({ profile: 'x', can: { 'w/': ['read'] }, ttl: 600 }).catch(() => null)
    expect(made).not.toBeNull()
    // The owner, on the board's machine, makes a token with the server's key and later stops it.
    const mine = mint(key, { sub: 'local:user:ada', profile: 'fixer', can: { 'work/': ['read', 'post'] }, exp: Math.floor(time.now().getTime() / 1000) + 600, jti: 'tok-1' })
    backend.registry!().record({ id: 'tok-1', profile: 'fixer', can: { 'work/': ['read', 'post'] }, exp: Math.floor(time.now().getTime() / 1000) + 600, at: 1, revoked: false })
    const agent = board({ backend: http({ url: server.url, token: mine }) })
    await agent.post({ channel: 'work', text: 'before' })
    await backend.tokens.revoke({ id: 'tok-1' })
    expect(await reason(agent.post({ channel: 'work', text: 'after' }))).toBe('unauthorized')
    // A token carrying an ID this board never recorded is refused too, however well it is signed.
    const unknown = mint(key, { sub: 'local:user:ada', profile: 'fixer', can: { 'work/': ['read'] }, exp: Math.floor(time.now().getTime() / 1000) + 600, jti: 'not-ours' })
    expect(await reason(board({ backend: http({ url: server.url, token: unknown }) }).readChannel({ channel: 'work' }))).toBe('unauthorized')
    await server.close()
  })

  it('a webhook body over 1 MB is refused before anything reads it, with no token asked', async () => {
    const { server, raw } = await served()
    const big = await raw('/webhooks/gh', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
    expect([big.status, (await big.json()).error.reason]).toEqual([400, 'body_too_large'])
    // Under the cap it gets as far as the sync, which this board has none of.
    expect((await raw('/webhooks/gh', { method: 'POST', body: 'x'.repeat(1024) })).status).not.toBe(400)
    await server.close()
  })

  it('a feed that is open ends when its token is revoked', async () => {
    const time = clock()
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now })
    const key = randomBytes(32)
    const server = await listen({ backend, key, now: () => time.now().getTime(), feedInterval: 20 })
    const exp = Math.floor(time.now().getTime() / 1000) + 600
    const token = mint(key, { sub: 'local:user:ada', profile: 'fixer', can: { 'work/': ['read'] }, exp, jti: 'tok-feed' })
    backend.registry!().record({ id: 'tok-feed', profile: 'fixer', can: { 'work/': ['read'] }, exp, at: 1, revoked: false })
    const response = await fetch(`${server.url}/feed?channel=work`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    await reader.read()
    await backend.tokens.revoke({ id: 'tok-feed' })
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return 'ended'
    })()
    expect(await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve('still open'), 1500))])).toBe('ended')
    await reader.cancel().catch(() => {})
    await server.close()
  })

  it("a token made for a sandbox calls the routes a sandbox may and no others, whatever network it is behind", async () => {
    const { as, owner, raw, token, server, time } = await served()
    const can = { 'work/': ['read', 'post', 'react', 'label'] as const }
    const sandbox = token({ profile: 'fixer', can: can as never, sandbox: true })
    const agent = as({ profile: 'fixer', can: can as never, sandbox: true })
    // The work of a task is open to it.
    const task = await agent.post({ channel: 'work/web', text: 'fix the header' })
    expect((await agent.taskList({ channel: 'work/web' })).tasks).toEqual([])
    expect((await agent.reply({ to: task.id, text: 'on it' })).by.profile).toBe('fixer')
    expect((await agent.readThread({ id: task.id })).replies.map((reply) => reply.text)).toEqual(['on it'])
    expect(await (await raw('/whoami', { headers: { authorization: `Bearer ${sandbox}` } })).json()).toMatchObject({ ok: { profile: 'fixer', sandbox: true } })
    // What a board does later, and what starts work elsewhere, is not: the same token without the mark may.
    await owner.post({ channel: 'work/web', text: 'a thread' })
    expect(await reason(agent.scheduleCreate({ channel: 'work/web', text: 'later', every: 600 }))).toBe('forbidden')
    expect(await reason(agent.scheduleList())).toBe('forbidden')
    expect(await reason(agent.scheduleCancel({ id: 1 }))).toBe('forbidden')
    expect(await reason(agent.cursorSet('mine', 1))).toBe('forbidden')
    expect(await reason(agent.cursorGet('mine'))).toBe('forbidden')
    expect(await reason(agent.workflowRequest({ thread: task.id, workflow: 'fix' } as never))).toBe('forbidden')
    const unmarked = as({ profile: 'fixer', can: can as never })
    expect((await unmarked.scheduleCreate({ channel: 'work/web', text: 'later', every: 600 })).id).toBeDefined()
    await unmarked.cursorSet('mine', 1)
    // Nor are the routes outside the board's own, the ones that take no token included: the token closes them.
    const post = (path: string, authorization?: string) => raw(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ args: [{}] }) })
    for (const path of ['/mcp', '/joinAsk', '/joinPoll', '/joinList', '/tokenExchange', '/tokenCreate', '/tokenList', '/nothing']) {
      const answer = await post(path, `Bearer ${sandbox}`)
      expect([path, answer.status, (await answer.json()).error.reason]).toEqual([path, 403, 'forbidden'])
    }
    expect((await raw('/feed?channel=work/web', { headers: { authorization: `Bearer ${sandbox}` } })).status).toBe(403)
    expect((await raw('/whoami', { method: 'POST', headers: { authorization: `Bearer ${sandbox}` } })).status).toBe(403)
    // Without a token those routes answer as they did.
    expect((await (await post('/joinAsk')).json()).error.reason).toBe('joins_closed')
    // A sandbox's token that ran out opens nothing either: it is refused as any other is.
    time.advance(3601_000)
    expect((await post('/head', `Bearer ${sandbox}`)).status).toBe(401)
    await server.close()
  })

  it('a token is made for a sandbox only when asked for exactly that', async () => {
    const { as, key, time, server } = await served()
    const claims = async (request: Record<string, unknown>) => verify(key, (await as().backend.tokens.create({ profile: 'fixer', can: { 'work/': ['read', 'post'] }, ttl: 600, ...request } as never)).token, time.now().getTime())
    expect((await claims({ sandbox: true })).sandbox).toBe(true)
    expect('sandbox' in (await claims({}))).toBe(false)
    expect('sandbox' in (await claims({ sandbox: 'yes' }))).toBe(false)
    await server.close()
  })
})

/**
 * A board behind a tunnel or proxy that can be cut: while it is down it answers 502 with a page of its
 * own, as a gateway does. It counts the requests for each route, so a test knows when a command is in its loop.
 */
async function behindGateway() {
  const { server, token, owner } = await served()
  const target = new URL(server.url)
  const state = { down: false }
  const polls: Record<string, number> = {}
  const gateway = createServer((req, res) => {
    const route = (req.url ?? '').slice((req.url ?? '').lastIndexOf('/') + 1)
    polls[route] = (polls[route] ?? 0) + 1
    if (state.down) return res.writeHead(502, { 'content-type': 'text/html' }).end('<html>502 Bad Gateway</html>')
    const upstream = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const port = (gateway.address() as { port: number }).port
  /** Until a command has asked for a route once more: it is in its loop, past what it does once at the start. */
  const polling = async (route: string, more = 1) => {
    const from = polls[route] ?? 0
    while ((polls[route] ?? 0) < from + more) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return {
    state,
    polls,
    polling,
    owner,
    dir: tempDir(),
    env: { MUSTER_URL: `http://127.0.0.1:${port}${target.pathname}`, MUSTER_TOKEN: token() },
    async close() {
      gateway.close()
      await server.close()
    },
  }
}

describe('a wait over a URL, through an outage', () => {
  it('mu wait started before a gateway answers 502 gets what was posted during it', async () => {
    const { state, polling, owner, dir, env, close } = await behindGateway()
    const head = (await owner.head()) as number
    const waiting = cliStart(dir, ['wait', 'work', '--after', String(head), '--timeout', '30s', '--json'], env)
    await polling('events')
    state.down = true
    await owner.post({ channel: 'work', text: 'posted while the gateway was down' })
    // The wait has been refused at least once before the gateway comes back.
    await polling('events')
    state.down = false
    const waited = await waiting.done
    expect(waited.code).toBe(0)
    expect(JSON.parse(waited.stdout).event.data.text).toBe('posted while the gateway was down')
    await close()
  }, 60_000)

  it('claim --ready --wait and inbox --wait ride it out too, once they are waiting', async () => {
    const { state, polls, polling, owner, dir, env, close } = await behindGateway()
    const claiming = cliStart(dir, ['tasks', 'claim', '--ready', 'work', '--wait', '30s', '--json', '--as', 'fixer'], env)
    const inbox = cliStart(dir, ['inbox', '--wait', '30s', '--json', '--as', 'fixer'], env)
    while (!polls.taskClaim || !polls.events) await new Promise((resolve) => setTimeout(resolve, 20))
    state.down = true
    await Promise.all([polling('taskClaim'), polling('events')])
    await owner.taskCreate({ channel: 'work', text: 'fix it', for: 'fixer' })
    state.down = false
    expect((await claiming.done).code).toBe(0)
    expect(JSON.parse((await inbox.done).stdout).items.length).toBeGreaterThan(0)
    await close()
  }, 60_000)

  it('an outage that outlasts the deadline says what went wrong, and one from the start is said at once', async () => {
    const { state, polling, dir, env, close } = await behindGateway()
    const outlasting = cliStart(dir, ['wait', 'work', '--timeout', '3s', '--json'], env)
    await polling('events')
    state.down = true
    const outlasted = await outlasting.done
    expect([outlasted.code, JSON.parse(outlasted.stderr).error.reason]).toEqual([1, 'bad_answer'])
    // Out of reach from the first request: said as any command says it, not waited for until --timeout.
    const startedAt = Date.now()
    const unreached = await cli(dir, ['wait', 'work', '--timeout', '30s', '--json'], { env })
    expect([unreached.code, JSON.parse(unreached.stderr).error.reason]).toEqual([1, 'bad_answer'])
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    await close()
  }, 60_000)

  it('a tail follows through an outage, and Ctrl-C during one stops at once, not after the pause', async () => {
    const { state, polling, dir, env, close } = await behindGateway()
    const tailing = cliStart(dir, ['tail', 'work'], env)
    await polling('events')
    state.down = true
    // Tries at about 0, 0.5, 1.5 and 3.5 s: at 4 s it is in a pause that runs to 7.5 s.
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const stoppedAt = Date.now()
    tailing.child.kill('SIGINT')
    expect((await tailing.done).code).toBe(130)
    expect(Date.now() - stoppedAt).toBeLessThan(2000)
    await close()
  }, 60_000)

  it("a refusal isn't an outage: it ends the wait at once", async () => {
    const { dir, env, close } = await behindGateway()
    const refused = await cli(dir, ['wait', 'work', '--timeout', '30s', '--json'], { env: { ...env, MUSTER_TOKEN: 'not-a-token' } })
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stderr).error.reason).not.toBe('bad_answer')
    await close()
  }, 60_000)
})
