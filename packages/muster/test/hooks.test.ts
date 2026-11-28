import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOOK_ATTEMPTS, HOOK_BATCH, runHook, type ArmedHook, type HookState } from '../src/daemon/hooks.ts'
import { board, env } from '../src/index.ts'
import { memoryBoard } from './helpers.ts'

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
})

describe('hooks in a host', () => {
  it('a hook whose receiver is down never holds up another hook', async () => {
    const up = await receiver()
    const down = await receiver()
    down.state.answer = 503
    process.env.HOOK_SECRET = KEY
    const team = board({
      memory: true,
      principal: 'local:user:ada',
      hooks: [
        { name: 'pager', url: down.url, secret: env('HOOK_SECRET'), tail: { channel: 'work/' } },
        { name: 'phone', url: up.url, secret: env('HOOK_SECRET'), tail: { channel: 'work/' } },
      ],
    })
    const log: string[] = []
    const host = team.start({ log: (line) => log.push(line) })
    try {
      // Each hook starts from now: wait until both have taken their place before writing.
      await vi.waitFor(async () => expect([await team.cursorGet('hook:pager'), await team.cursorGet('hook:phone')]).not.toContain(null), { timeout: 5000 })
      const root = await team.post({ channel: 'work/api', text: 'one' })
      await vi.waitFor(() => expect(up.got.map((each) => each.delivery)).toEqual([`phone.${root.id}`]), { timeout: 5000 })
      expect(log).toContain(`failed    hook pager  at ${root.id}  HTTP 503`)
    } finally {
      host.stop()
      await host.done
      team.close()
      delete process.env.HOOK_SECRET
    }
  })
})

describe('the receiver in the docs', () => {
  /**
   * The verify function exactly as the outgoing-webhooks page prints it, run with a clock of the test's
   * choosing, so the page can't drift from what the daemon sends. The code is this repo's own docs.
   */
  const documented = (now = () => Date.now()) => {
    const page = readFileSync(new URL('../docs/01-concepts/15-outgoing-webhooks.md', import.meta.url), 'utf8')
    const code = /### How a receiver checks the signature[\s\S]*?```js\n([\s\S]*?)```/.exec(page)![1]!.replace(/^import .*\n/m, '')
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
