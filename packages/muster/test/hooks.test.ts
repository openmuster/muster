import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tickOnce } from '../src/daemon/daemon.ts'
import { HOOK_ATTEMPTS, HOOK_BATCH, armHooks, loadHooks, runHook, type ArmedHook, type HookState } from '../src/daemon/hooks.ts'
import { cli, cliStart, memoryBoard, reason, tempDir } from './helpers.ts'

const KEY = 'a-secret-of-thirty-two-characters'
type Got = { delivery: string; signed: boolean; age: number; raw: string; headers: Record<string, string>; body: { hook: string; delivery: string; event: Record<string, any> } }

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()))
})

/**
 * A real receiver on this machine. It checks each signature the way the docs tell a receiver to, with
 * its own copy of the secret, and answers with whatever the test last told it to.
 */
async function receiver(key = KEY, now: () => number = () => Date.now()) {
  const got: Got[] = []
  const state: { answer: number | 'hang'; location?: string } = { answer: 200 }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const delivery = String(request.headers['muster-delivery'])
      const timestamp = String(request.headers['muster-timestamp'])
      const expected = `v1=${createHmac('sha256', key).update(`${delivery}.${timestamp}.${raw}`).digest('hex')}`
      got.push({ delivery, signed: request.headers['muster-signature'] === expected, age: Math.floor(now() / 1000) - Number(timestamp), raw, headers: request.headers as Record<string, string>, body: JSON.parse(raw) })
      if (state.answer === 'hang') return
      response.writeHead(state.answer, state.location ? { location: state.location } : {}).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))))
  return { got, state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/in` }
}

function setUp(url: string, extra: Partial<ArmedHook> = {}) {
  const { team, time } = memoryBoard()
  const hook: ArmedHook = { name: 'phone', url, secret: 'HOOK_SECRET', key: KEY, tail: { channel: 'work/' }, body: 'pointer', ...extra }
  const state: HookState = { attempts: 0, retryAt: -Infinity }
  const deps = { now: () => time.now().getTime(), fetch, timeout: 2000 }
  const notes = new Set<number>()
  return { team, time, hook, run: () => runHook(team, hook, state, deps, notes) }
}

describe('outgoing webhooks', () => {
  it('sends one signed delivery for each matching event, in order, and only what happened after the hook began', async () => {
    const there = await receiver()
    const { team, time, run } = setUp(there.url)
    const before = await team.post({ channel: 'work/api', text: 'written before the hook existed' })
    expect(await run()).toMatchObject({ sent: [] })
    const first = await team.post({ channel: 'work/api', text: 'the login redirect is wrong' })
    await team.post({ channel: 'general', text: 'not in the hook\'s channels' })
    const second = await team.reply({ to: first.id, text: 'looking' })
    expect((await run()).sent).toHaveLength(2)
    expect(there.got.map((each) => [each.delivery, each.signed, each.body.event.type, each.body.event.thread])).toEqual([
      [`phone.${first.id}`, true, 'message.posted', first.id],
      [`phone.${second.id}`, true, 'message.posted', first.id],
    ])
    expect(there.got[0]!.body).toMatchObject({ hook: 'phone', delivery: `phone.${first.id}`, event: { seq: first.id, channel: 'work/api', at: time.now().toISOString() } })
    expect(there.got.some((each) => each.delivery === `phone.${before.id}`)).toBe(false)
    // Nothing is sent twice.
    expect((await run()).sent).toEqual([])
    expect(there.got).toHaveLength(2)
  })

  it('carries a pointer and none of the words, unless the config asks for the event', async () => {
    const there = await receiver()
    const pointing = setUp(there.url)
    await pointing.run()
    await pointing.team.post({ channel: 'work/api', text: 'the customer is Initech' })
    await pointing.run()
    expect(JSON.stringify(there.got[0]!.body)).not.toContain('Initech')
    expect(Object.keys(there.got[0]!.body.event).sort()).toEqual(['at', 'by', 'channel', 'seq', 'thread', 'type'])

    const whole = setUp(there.url, { body: 'event' })
    await whole.run()
    await whole.team.post({ channel: 'work/api', text: 'the customer is Initech' })
    await whole.run()
    expect(there.got[1]!.body.event.message.text).toBe('the customer is Initech')
  })

  it('a task event reaches a hook that filters on its type', async () => {
    const there = await receiver()
    const { team, run } = setUp(there.url, { tail: { types: ['task.blocked'] }, body: 'event' })
    await run()
    const { task } = await team.taskCreate({ channel: 'work', text: 'ship it' })
    await team.taskBlock({ id: task.id, kind: 'question', reason: 'which region?' })
    await run()
    expect(there.got.map((each) => each.body.event.type)).toEqual(['task.blocked'])
    expect(there.got[0]!.body.event.thread).toBe(task.id)
  })

  it('a delivery that fails is tried again after a wait, under the same ID and a new time, and later events wait behind it', async () => {
    const there = await receiver(KEY)
    const { team, time, run } = setUp(there.url)
    await run()
    const first = await team.post({ channel: 'work/api', text: 'one' })
    const second = await team.post({ channel: 'work/api', text: 'two' })
    there.state.answer = 500
    expect(await run()).toMatchObject({ sent: [], failed: [first.id], why: 'HTTP 500' })
    // Not before its wait is over.
    time.advance(4000)
    expect(await run()).toMatchObject({ sent: [], failed: [] })
    expect(there.got).toHaveLength(1)
    time.advance(1000)
    there.state.answer = 204
    expect((await run()).sent).toEqual([first.id, second.id])
    expect(there.got.map((each) => each.delivery)).toEqual([`phone.${first.id}`, `phone.${first.id}`, `phone.${second.id}`])
    expect(there.got.every((each) => each.signed)).toBe(true)
  })

  it('signs the time it was sent, so a receiver can refuse an old request played back', async () => {
    const { team, time, run, hook } = setUp('http://127.0.0.1:1/')
    const there = await receiver(KEY, () => time.now().getTime())
    hook.url = there.url
    await run()
    await team.post({ channel: 'work/api', text: 'one' })
    there.state.answer = 503
    await run()
    time.advance(60_000)
    there.state.answer = 200
    await run()
    expect(there.got.map((each) => [each.signed, each.age])).toEqual([[true, 0], [true, 0]])
  })

  it(`an event that fails ${HOOK_ATTEMPTS} times is passed over and recorded on its thread, and the daemon never sends its own record on`, async () => {
    const there = await receiver()
    const { team, time, run } = setUp(there.url)
    await run()
    const root = await team.post({ channel: 'work/api', text: 'one' })
    there.state.answer = 500
    let last = await run()
    for (let tries = 1; tries < HOOK_ATTEMPTS; tries++) {
      expect(last).toMatchObject({ failed: [root.id], dropped: [] })
      time.advance(301_000)
      last = await run()
    }
    expect(last).toMatchObject({ failed: [], dropped: [root.id] })
    expect(there.got).toHaveLength(HOOK_ATTEMPTS)
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual([`outgoing webhook "phone" couldn't deliver event ${root.id} after ${HOOK_ATTEMPTS} tries (HTTP 500).`])
    // The receiver is back: the note about the failure matches the filter, and still isn't delivered.
    there.state.answer = 200
    const next = await team.post({ channel: 'work/api', text: 'two' })
    expect((await run()).sent).toEqual([next.id])
    expect(there.got).toHaveLength(HOOK_ATTEMPTS + 1)
    expect((await run()).sent).toEqual([])
    // Only the daemon's own record is left out. The same words from anyone else are an event like any other.
    const forged = await team.as('mallory').reply({ to: root.id, text: `outgoing webhook "phone" couldn't deliver event ${root.id} after ${HOOK_ATTEMPTS} tries (HTTP 500).` })
    expect((await run()).sent).toEqual([forged.id])
  })

  it('a slow receiver gets what fits in one pass, and the rest in the next', async () => {
    const there = await receiver()
    const { team, time } = setUp(there.url)
    const hook: ArmedHook = { name: 'phone', url: there.url, secret: 'HOOK_SECRET', key: KEY, tail: {}, body: 'pointer' }
    const state: HookState = { attempts: 0, retryAt: -Infinity }
    const slow: typeof fetch = async (...args) => (await new Promise((resolve) => setTimeout(resolve, 60)), fetch(...args))
    const deps = { now: () => time.now().getTime(), fetch: slow, budget: 100 }
    await runHook(team, hook, state, deps)
    for (let i = 0; i < 8; i++) await team.post({ channel: 'work', text: `message ${i}` })
    const first = (await runHook(team, hook, state, deps)).sent
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(first.length).toBeLessThan(8)
    let all = [...first]
    for (let pass = 0; pass < 8 && all.length < 8; pass++) all = [...all, ...(await runHook(team, hook, state, deps)).sent]
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(there.got.map((each) => each.body.event.seq)).toEqual(all)
  })

  it('does not follow a redirect: a body goes only where the config says', async () => {
    const elsewhere = await receiver()
    const there = await receiver()
    there.state.answer = 307
    there.state.location = elsewhere.url
    const { team, run } = setUp(there.url)
    await run()
    const root = await team.post({ channel: 'work/api', text: 'one' })
    expect(await run()).toMatchObject({ sent: [], failed: [root.id], why: 'HTTP 307' })
    expect(elsewhere.got).toEqual([])
  })

  it('a receiver that never answers costs one timeout, and counts as a failure', async () => {
    const there = await receiver()
    there.state.answer = 'hang'
    const { team, time } = setUp(there.url)
    const hook: ArmedHook = { name: 'phone', url: there.url, secret: 'HOOK_SECRET', key: KEY, tail: {}, body: 'pointer' }
    const state: HookState = { attempts: 0, retryAt: -Infinity }
    const deps = { now: () => time.now().getTime(), fetch, timeout: 100 }
    await runHook(team, hook, state, deps)
    const root = await team.post({ channel: 'work', text: 'one' })
    await team.post({ channel: 'work', text: 'two' })
    const started = Date.now()
    expect(await runHook(team, hook, state, deps)).toMatchObject({ failed: [root.id], why: 'timed out' })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('a receiver that is not there is a failure, not a crash', async () => {
    const gone = await receiver()
    await open.pop()!()
    const { team, run } = setUp(gone.url)
    await run()
    const root = await team.post({ channel: 'work/api', text: 'one' })
    expect(await run()).toMatchObject({ failed: [root.id], why: 'ECONNREFUSED' })
  })

  it(`sends at most ${HOOK_BATCH} events in one pass and carries on from there in the next`, async () => {
    const there = await receiver()
    const { team, run } = setUp(there.url)
    await run()
    for (let i = 0; i < HOOK_BATCH + 3; i++) await team.post({ channel: 'work/api', text: `message ${i}` })
    expect((await run()).sent).toHaveLength(HOOK_BATCH)
    expect((await run()).sent).toHaveLength(3)
    const seqs = there.got.map((each) => each.body.event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(HOOK_BATCH + 3)
  })

  it('a 4xx is a failure that waits and tries again, not a delivery', async () => {
    const there = await receiver()
    const { team, time, run } = setUp(there.url)
    await run()
    const root = await team.post({ channel: 'work/api', text: 'one' })
    there.state.answer = 401
    expect(await run()).toMatchObject({ sent: [], failed: [root.id], dropped: [], why: 'HTTP 401' })
    time.advance(5000)
    there.state.answer = 202
    expect((await run()).sent).toEqual([root.id])
  })

  it('a restart picks up from the cursor on the board: nothing sent twice, nothing skipped', async () => {
    const there = await receiver()
    const { team, hook } = setUp(there.url)
    const time = { now: () => Date.parse('2026-01-01T00:00:00.000Z') }
    const deps = { now: time.now, fetch, timeout: 2000 }
    const daemon = () => ({ attempts: 0, retryAt: -Infinity })
    let state = daemon()
    await runHook(team, hook, state, deps)
    const first = await team.post({ channel: 'work/api', text: 'one' })
    const second = await team.post({ channel: 'work/api', text: 'two' })
    expect((await runHook(team, hook, state, deps)).sent).toEqual([first.id, second.id])
    const third = await team.post({ channel: 'work/api', text: 'three' })
    there.state.answer = 500
    expect(await runHook(team, hook, state, deps)).toMatchObject({ failed: [third.id] })
    // The daemon stops and starts again: its wait and its count are gone, the cursor is not.
    state = daemon()
    there.state.answer = 200
    const fourth = await team.post({ channel: 'work/api', text: 'four' })
    expect((await runHook(team, hook, state, deps)).sent).toEqual([third.id, fourth.id])
    expect(there.got.map((each) => each.delivery)).toEqual([first, second, third, third, fourth].map((each) => `phone.${each.id}`))
  })

  it('an event with no thread that fails eight times is passed over without a note', async () => {
    const there = await receiver()
    const { team, time, run } = setUp(there.url, { tail: { types: ['schedule.created'] } })
    await run()
    const before = await team.head()
    await team.scheduleCreate({ channel: 'work', text: 'standup', at: '2026-01-02T00:00:00.000Z' })
    there.state.answer = 500
    let last = await run()
    for (let tries = 1; tries < HOOK_ATTEMPTS; tries++) {
      time.advance(301_000)
      last = await run()
    }
    expect(last.dropped).toHaveLength(1)
    expect(there.got[0]!.body.event.thread).toBeNull()
    // Nothing was written to the board for it: the only event since is the schedule itself.
    expect((await team.events({ after: before, filter: {}, limit: 50 })).events.map((each) => each.type)).toEqual(['schedule.created'])
    there.state.answer = 200
    await team.scheduleCreate({ channel: 'work', text: 'retro', at: '2026-01-03T00:00:00.000Z' })
    expect((await run()).sent).toHaveLength(1)
  })

  it('a hook whose receiver is down never holds up another hook in the same tick', async () => {
    const up = await receiver()
    const down = await receiver()
    down.state.answer = 503
    const { team, time, hook } = setUp(up.url)
    const broken: ArmedHook = { ...hook, name: 'pager', url: down.url }
    const hooks = { list: [broken, hook], states: new Map<string, HookState>(), deps: { now: () => time.now().getTime(), fetch } }
    const deps = { now: () => time.now().getTime(), spawn: async () => ({ code: 0, stdout: '' }) }
    await tickOnce(team, [], new Map(), deps, hooks)
    const root = await team.post({ channel: 'work/api', text: 'one' })
    const did = await tickOnce(team, [], new Map(), deps, hooks)
    expect(did.hooked.pager).toMatchObject({ failed: [root.id], why: 'HTTP 503' })
    expect(did.hooked.phone!.sent).toEqual([root.id])
    expect(up.got).toHaveLength(1)
  })

  it('a tick sends hooks after schedules and watchers', async () => {
    const there = await receiver()
    const { team, time, hook } = setUp(there.url, { tail: { channel: 'work', types: ['message.posted'] } })
    const hooks = { list: [hook], states: new Map<string, HookState>(), deps: { now: () => time.now().getTime(), fetch } }
    const deps = { now: () => time.now().getTime(), spawn: async () => ({ code: 0, stdout: '' }) }
    await tickOnce(team, [], new Map(), deps, hooks)
    await team.scheduleCreate({ channel: 'work', text: 'standup', at: '2026-01-01T00:10:00.000Z' })
    time.advance(10 * 60_000)
    const did = await tickOnce(team, [], new Map(), deps, hooks)
    expect(did.hooked.phone!.sent).toHaveLength(1)
    expect(there.got.map((each) => each.body.event.type)).toEqual(['message.posted'])
  })
})

describe('the receiver in the docs', () => {
  /**
   * The verify function exactly as the outgoing-webhooks page prints it, run with a clock of the test's
   * choosing, so the page can't drift from what the daemon sends. The code is this repo's own docs.
   */
  const documented = (now = () => Date.now()) => {
    const page = readFileSync(new URL('../docs/01-concepts/15-outgoing-webhooks.md', import.meta.url), 'utf8')
    const code = /## Verify it[\s\S]*?```js\n([\s\S]*?)```/.exec(page)![1]!.replace(/^import .*\n/m, '')
    return new Function('createHmac', 'timingSafeEqual', 'Date', `${code}\nreturn fromMuster`)(createHmac, timingSafeEqual, { now }) as (headers: Record<string, string>, raw: string, secret: string) => boolean
  }

  it('accepts what the daemon sends, and refuses it changed, under another secret, unsigned, or played back late', async () => {
    const there = await receiver()
    const { team, time, run } = setUp(there.url, { body: 'event' })
    await run()
    await team.post({ channel: 'work/api', text: 'the login redirect is wrong' })
    await run()
    const [got] = there.got
    const fromMuster = documented(() => time.now().getTime())
    expect(fromMuster(got!.headers, got!.raw, KEY)).toBe(true)
    expect(fromMuster(got!.headers, got!.raw.replace('redirect', 'redirekt'), KEY)).toBe(false)
    expect(fromMuster(got!.headers, got!.raw, 'another-secret-of-thirty-two-chars')).toBe(false)
    expect(fromMuster({ ...got!.headers, 'muster-signature': '' }, got!.raw, KEY)).toBe(false)
    expect(fromMuster({ ...got!.headers, 'muster-delivery': 'phone.999' }, got!.raw, KEY)).toBe(false)
    // The docs say to check the bytes before parsing: the same object printed again is not the same bytes.
    expect(fromMuster(got!.headers, JSON.stringify(JSON.parse(got!.raw), null, 1), KEY)).toBe(false)
    const sentAt = Number(got!.headers['muster-timestamp']) * 1000
    expect(documented(() => sentAt + 299_000)(got!.headers, got!.raw, KEY)).toBe(true)
    expect(documented(() => sentAt + 301_000)(got!.headers, got!.raw, KEY)).toBe(false)
  })
})

describe('the hooks file', () => {
  const write = (hooks: unknown) => {
    const dir = tempDir()
    writeFileSync(join(dir, 'hooks.json'), typeof hooks === 'string' ? hooks : JSON.stringify(hooks))
    return join(dir, 'hooks.json')
  }
  const good = { name: 'phone', url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' }
  const refuses = (path: string) => {
    try {
      loadHooks(path)
    } catch (error) {
      return (error as Error).message
    }
    return 'loaded'
  }

  it('a missing file means no hooks, and a hook starts as a pointer with no filter', () => {
    expect(loadHooks(join(tempDir(), 'hooks.json'))).toEqual([])
    expect(loadHooks(write({ hooks: [good] }))).toEqual([{ name: 'phone', url: 'https://hooks.example.com/in', secret: 'HOOK_SECRET', tail: {}, body: 'pointer' }])
  })

  it('takes a kind filter, and refuses one that is not a list of kinds', () => {
    expect(loadHooks(write({ hooks: [{ ...good, tail: { types: ['task.blocked'], kinds: ['!backlog'] } }] }))[0]!.tail).toEqual({ types: ['task.blocked'], kinds: ['!backlog'] })
    expect(refuses(write({ hooks: [{ ...good, tail: { kinds: '!backlog' } }] }))).toMatch(/"kinds" of hook "phone"/)
    expect(refuses(write({ hooks: [{ ...good, tail: { kinds: ['Not A Kind'] } }] }))).toMatch(/"kinds" of hook "phone"/)
  })

  it('refuses a secret written into the file: it names an environment variable', () => {
    expect(refuses(write({ hooks: [{ ...good, secret: 'hunter2hunter2hunter2' }] }))).toMatch(/"secret" of hook "phone" .* names an environment variable/)
    expect(refuses(write({ hooks: [{ name: 'phone', url: good.url }] }))).toMatch(/names an environment variable/)
  })

  it('refuses plain http anywhere but this machine, and a password in the URL', () => {
    expect(refuses(write({ hooks: [{ ...good, url: 'http://hooks.example.com/in' }] }))).toMatch(/needs an https URL/)
    expect(refuses(write({ hooks: [{ ...good, url: 'ftp://hooks.example.com/in' }] }))).toMatch(/needs an https URL/)
    expect(refuses(write({ hooks: [{ ...good, url: 'https://ada:pw@hooks.example.com/in' }] }))).toMatch(/password in its URL/)
    expect(refuses(write({ hooks: [{ ...good, url: 'http://127.0.0.1:8787/in' }] }))).toBe('loaded')
    expect(refuses(write({ hooks: [{ ...good, url: 'http://localhost:8787/in' }] }))).toBe('loaded')
  })

  it('refuses what it cannot read: bad JSON, no name, no URL, two of one name, an unknown body', () => {
    expect(refuses(write('{ not json'))).toMatch(/hooks\.json isn't JSON/)
    expect(refuses(write({ nothing: true }))).toMatch(/needs a "hooks" array/)
    expect(refuses(write({ hooks: [{ ...good, name: 'Phone!' }] }))).toMatch(/needs a "name"/)
    expect(refuses(write({ hooks: [{ name: 'phone', secret: good.secret }] }))).toMatch(/needs a "url"/)
    expect(refuses(write({ hooks: [good, good] }))).toMatch(/Two hooks .* are named "phone"/)
    expect(refuses(write({ hooks: [{ ...good, body: 'everything' }] }))).toMatch(/"pointer" or "event"/)
  })

  it('will not send unsigned: a secret that is unset or short stops the daemon from taking the hook', async () => {
    const [hook] = loadHooks(write({ hooks: [good] }))
    expect(await reason(Promise.resolve().then(() => armHooks([hook!], {})))).toBe('invalid_config')
    expect(await reason(Promise.resolve().then(() => armHooks([hook!], { HOOK_SECRET: 'short' })))).toBe('invalid_config')
    expect(armHooks([hook!], { HOOK_SECRET: KEY })[0]!.key).toBe(KEY)
  })
})

describe('hooks from the command line', () => {
  const setUpDir = (hooks: unknown[], watchers?: unknown[]) => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'hooks.json'), JSON.stringify({ hooks }))
    if (watchers) writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers }))
    return dir
  }

  it('mu daemon run delivers a board event to a receiver that verifies it', async () => {
    const there = await receiver()
    const dir = setUpDir([{ name: 'phone', url: there.url, secret: 'env:HOOK_SECRET', tail: { channel: 'work/' }, body: 'event' }])
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'], { HOOK_SECRET: KEY })
    // Waited for, not timed: on a busy machine the daemon takes longer to start and to deliver.
    const until = async (done: () => boolean, ms = 15_000) => {
      for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await until(() => /^hooks {5}1$/m.test(daemon.output()))
    await cli(dir, ['post', 'work/api', 'needs a look'])
    await until(() => there.got.length > 0)
    daemon.child.kill('SIGTERM')
    const ended = await daemon.done
    expect(ended.code).toBe(0)
    expect(ended.stdout).toMatch(/^hooks {5}1$/m)
    expect(ended.stdout).toMatch(/^sent {6}hook phone {2}1$/m)
    expect(there.got.map((each) => [each.signed, each.body.event.message.text])).toEqual([[true, 'needs a look']])
  }, 40_000)

  it('mu serve sends hooks too, and says on its error output what a receiver refused', async () => {
    const there = await receiver()
    const dir = setUpDir([{ name: 'phone', url: there.url, secret: 'env:HOOK_SECRET', tail: { channel: 'work/' } }])
    await cli(dir, ['post', 'general', 'board exists'])
    const serving = cliStart(dir, ['serve', '--port', '0', '--print-token'], { HOOK_SECRET: KEY })
    let stderr = ''
    serving.child.stderr.on('data', (chunk) => (stderr += chunk))
    for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await cli(dir, ['post', 'work/api', 'needs a look'])
    for (let i = 0; i < 100 && there.got.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(there.got.map((each) => [each.signed, each.body.event.channel])).toEqual([[true, 'work/api']])
    there.state.answer = 500
    await cli(dir, ['post', 'work/api', 'and another'])
    for (let i = 0; i < 100 && !stderr.includes('failed'); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    serving.child.kill('SIGTERM')
    expect((await serving.done).code).toBe(0)
    expect(stderr).toMatch(/^failed {4}hook phone {2}at \d+ {2}HTTP 500$/m)
  }, 20_000)

  it('mu serve with a hook it cannot sign for serves the board, says why, and keeps its watchers', async () => {
    const dir = setUpDir([{ name: 'phone', url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' }], [{ name: 'lead', tail: { channel: 'work/' }, run: ['sh', '-c', 'echo woke >> "$HOME/woke"'], every: 1 }])
    await cli(dir, ['post', 'general', 'board exists'])
    const serving = cliStart(dir, ['serve', '--port', '0', '--print-token'])
    let stderr = ''
    serving.child.stderr.on('data', (chunk) => (stderr += chunk))
    for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const env = { MUSTER_URL: /MUSTER_URL=(\S+)/.exec(serving.output())![1]!, MUSTER_TOKEN: /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]! }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect((await cli(dir, ['post', 'work/api', 'over http'], { env })).code).toBe(0)
    for (let i = 0; i < 100 && !existsSync(join(dir, 'woke')); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    serving.child.kill('SIGTERM')
    await serving.done
    expect(stderr).toMatch(/^error: HOOK_SECRET isn't set, and hook "phone"/)
    expect(stderr).toMatch(/No outgoing webhooks are sent/)
    expect(existsSync(join(dir, 'woke'))).toBe(true)
  }, 20_000)

  it('a hook whose secret is not set parks the daemon, and it says which variable', async () => {
    const dir = setUpDir([{ name: 'phone', url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' }])
    const run = await cli(dir, ['daemon', 'run'])
    expect(run.code).toBe(0)
    expect(run.stderr).toMatch(/^error: HOOK_SECRET isn't set, and hook "phone"/)
  })

  it('mu daemon check <hook> sends a signed ping and says what the receiver answered', async () => {
    const there = await receiver()
    const dir = setUpDir([{ name: 'phone', url: there.url, secret: 'env:HOOK_SECRET' }])
    const run = await cli(dir, ['daemon', 'check', 'phone'], { env: { HOOK_SECRET: KEY } })
    expect([run.code, run.stderr]).toEqual([0, ''])
    expect(run.stdout).toMatch(/^delivered {2}phone {2}HTTP 200 {2}in \d+ms\n$/)
    expect(there.got.map((each) => [each.signed, each.body.event.type, each.delivery.startsWith('phone.ping.')])).toEqual([[true, 'ping', true]])

    there.state.answer = 401
    const refused = await cli(dir, ['daemon', 'check', 'phone', '--json'], { env: { HOOK_SECRET: KEY } })
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stderr).error).toMatchObject({ reason: 'hook_failed', data: { hook: 'phone', status: 401 } })
  })

  it('mu daemon status lists hooks, and one name cannot be both a watcher and a hook', async () => {
    const dir = setUpDir([{ name: 'phone', url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' }])
    const status = JSON.parse((await cli(dir, ['daemon', 'status', '--json'])).stdout)
    expect(status).toMatchObject({ watchers: [], hooks: ['phone'] })
    const clash = setUpDir([{ name: 'lead', url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' }], [{ name: 'lead', run: ['true'] }])
    const run = await cli(clash, ['daemon', 'check', 'lead', '--json'])
    expect(JSON.parse(run.stderr).error.reason).toBe('invalid_config')
  })
})
