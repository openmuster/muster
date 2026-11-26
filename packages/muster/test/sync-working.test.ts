import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { board, file, slack } from '../src/index.ts'
import type { Provider } from '../src/sync/types.ts'
import { clock, tempDir } from './helpers.ts'

const SECRET = 'whsec'
const MIN = 60_000

/**
 * A board synced with a Slack channel, through a provider that can show a thread as being worked on (or
 * can't, with `plain`). The platform is the only fake: what it was sent, and what it was told about working.
 */
function setup(options: { plain?: boolean; ttl?: number; refuse?: () => boolean; slow?: number; dir?: string } = {}) {
  const time = clock()
  const sent: { url: string; body: any }[] = []
  const told: { thread: string; place: string; step: string; text: string; state: unknown }[] = []
  let made = 9000
  let given = 0
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({ ok: true, ts: `1700000000.${++made}` })
  }) as typeof fetch
  const base = slack({ secret: SECRET, token: 'xoxb', bot: 'B0BOT', channels: { C123: 'general', C777: 'quiet' }, now: () => time.now().getTime() })
  const chat: Provider = options.plain
    ? base
    : {
        ...base,
        // Only C123 sends anything back.
        mirrors: (place) => place === 'C123',
        ...(options.ttl !== undefined ? { workingTtl: options.ttl } : {}),
        async working(target, step, now) {
          if (options.refuse?.()) throw new Error('the platform said no')
          told.push({ thread: target.threadExternal, place: target.place, step, text: now.text, state: now.state })
          // A platform that takes its time to answer, so another process's tick passes while this call is out.
          if (options.slow) await new Promise((done) => setTimeout(done, options.slow))
          // What a platform gives to find the indicator again: the first call's, kept from then on.
          return now.state ?? { session: `s-${++given}` }
        },
      }
  const open = () => file({ ...(options.dir ? { dir: options.dir } : { memory: true }), principal: 'local:user:ada', now: time.now, sync: { chat }, fetch: fetcher })
  const backend = open()
  const team = board({ backend })
  let event = 0
  const hook = (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ type: 'event_callback', event_id: `Ev${++event}`, event: { type: 'message', user: 'U1', ...payload } })
    const stamp = String(Math.floor(time.now().getTime() / 1000))
    return backend.syncReceive('chat', { headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${body}`).digest('hex')}` }, body })
  }
  /** A thread that came in from Slack, as the board has it. */
  const thread = async (channel = 'C123', ts = '1700000000.000100') => {
    await backend.syncTick()
    await hook({ channel, text: 'the footer says 2025', ts })
    return (await team.readChannel({ channel: channel === 'C123' ? 'general' : 'quiet' })).threads[0]!.message.id
  }
  const daemon = team.as('workflows')
  const begin = (to: number, text = 'started card: 3 tasks in general/card-9') => daemon.reply({ to, text, labels: { progress: 'open' } })
  const end = (id: number) => daemon.label({ id, set: { progress: 'done' } })
  const steps = () => told.map((each) => each.step)
  return { time, sent, told, steps, backend, team, daemon, open, hook, thread, begin, end }
}

describe('sync: a thread being worked on, shown on a platform that can show it', () => {
  it('tells the platform when work starts and when it ends, and sends no comment for the message that says so', async () => {
    const { backend, daemon, sent, told, thread, begin, end } = setup()
    const root = await thread()
    const progress = await begin(root)
    await backend.syncTick()
    expect(told).toEqual([{ thread: 'C123:1700000000.000100', place: 'C123', step: 'start', text: 'started card: 3 tasks in general/card-9', state: null }])
    // Nothing new: nothing more is told.
    await backend.syncTick()
    expect(told).toHaveLength(1)
    await daemon.reply({ to: root, text: 'card finished: 3 completed, 0 failed, 0 canceled' })
    await end(progress.id)
    await backend.syncTick()
    expect(told.at(-1)).toMatchObject({ step: 'end', state: { session: 's-1' } })
    expect(told).toHaveLength(2)
    // The summary went out as a comment; the progress message never did.
    expect(sent.map((each) => each.body.text)).toEqual(['card finished: 3 completed, 0 failed, 0 canceled'])
  })

  it('says what the message says now when it is edited, with what the platform gave back, and edits no comment for it', async () => {
    const { backend, daemon, sent, told, thread, begin, end } = setup()
    const progress = await begin(await thread())
    await backend.syncTick()
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in general/card-9\n#11 completed, #13 claimed, #15 waiting' })
    await backend.syncTick()
    expect(told.at(-1)).toEqual({ thread: 'C123:1700000000.000100', place: 'C123', step: 'text', text: 'started card: 3 tasks in general/card-9\n#11 completed, #13 claimed, #15 waiting', state: { session: 's-1' } })
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in general/card-9\n#11 completed, #13 completed, #15 completed' })
    await end(progress.id)
    await backend.syncTick()
    // Its last words go with the end, in one call.
    expect(told.slice(2)).toEqual([{ thread: 'C123:1700000000.000100', place: 'C123', step: 'end', text: 'started card: 3 tasks in general/card-9\n#11 completed, #13 completed, #15 completed', state: { session: 's-1' } }])
    expect(sent).toEqual([])
  })

  it('stays on while one run hands over to the next on the same thread, goes off only with the last, and on again when work is reopened', async () => {
    const { backend, daemon, steps, thread, begin, end } = setup()
    const root = await thread()
    const triage = await begin(root, 'started triage: 1 tasks in general/triage-5')
    await backend.syncTick()
    // The next run starts and the first ends between two ticks, as a daemon does it in one pass.
    const card = await begin(root)
    await end(triage.id)
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'text'])
    await end(card.id)
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'text', 'end'])
    await daemon.label({ id: card.id, set: { progress: 'open' } })
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'text', 'end', 'start'])
  })

  it('tells the platform again every workingTtl while the work goes on, by the clock, and not before', async () => {
    const { backend, time, steps, thread, begin } = setup({ ttl: 50 * MIN })
    await begin(await thread())
    await backend.syncTick()
    time.advance(49 * MIN)
    await backend.syncTick()
    expect(steps()).toEqual(['start'])
    time.advance(MIN)
    await backend.syncTick()
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'refresh'])
  })

  it('stops showing work nobody has touched for a day, so a run that died is not shown as working for good', async () => {
    const { backend, time, steps, thread, begin } = setup()
    await begin(await thread())
    await backend.syncTick()
    time.advance(24 * 60 * MIN + 1)
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'end'])
    time.advance(60 * MIN)
    await backend.syncTick()
    expect(steps()).toEqual(['start', 'end'])
  })

  it('tries a call the platform refused again after a minute, not every tick', async () => {
    let refusing = true
    const { backend, time, steps, thread, begin } = setup({ refuse: () => refusing })
    await begin(await thread())
    await backend.syncTick()
    refusing = false
    await backend.syncTick()
    time.advance(59_000)
    await backend.syncTick()
    expect(steps()).toEqual([])
    time.advance(1_000)
    await backend.syncTick()
    expect(steps()).toEqual(['start'])
  })

  it('goes on from what it last told the platform when the board starts again', async () => {
    const first = setup({ dir: tempDir() })
    const progress = await first.begin(await first.thread())
    await first.backend.syncTick()
    first.backend.close()
    const again = first.open()
    await board({ backend: again }).as('workflows').label({ id: progress.id, set: { progress: 'done' } })
    await again.syncTick()
    expect(first.told.map((each) => [each.step, each.state])).toEqual([
      ['start', null],
      ['end', { session: 's-1' }],
    ])
    again.close()
  })

  it('makes each call once when two processes tick the same board at once', async () => {
    const first = setup({ dir: tempDir(), slow: 100 })
    await first.begin(await first.thread())
    const second = first.open()
    await Promise.all([first.backend.syncTick(), second.syncTick()])
    expect(first.steps()).toEqual(['start'])
    first.backend.close()
    second.close()
  })

  it('shows nothing for a thread the platform has no copy of, one whose replies stay on the board, or a message held to the board', async () => {
    const { backend, team, daemon, steps, thread, begin } = setup()
    // Started on the board, in a channel that isn't synced.
    const local = await team.post({ channel: 'notes', text: 'ours alone' })
    await begin(local.id)
    // Synced in, from a place that takes nothing back.
    await begin(await thread('C777', '1700000000.000900'))
    // On a thread that does show, but said with noSync.
    await daemon.reply({ to: await thread(), text: 'started card: 1 tasks in general/card-3', labels: { progress: 'open' }, noSync: true })
    await backend.syncTick()
    expect(steps()).toEqual([])
  })

  it('sends the progress message as a comment, and its edits as edits, to a platform with no way of its own to show it', async () => {
    const { backend, daemon, sent, thread, begin } = setup({ plain: true })
    const progress = await begin(await thread())
    await backend.syncTick()
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in general/card-9\n#11 claimed, #13 waiting, #15 waiting' })
    await backend.syncTick()
    expect(sent.map((each) => [each.url.split('/').pop(), each.body.text])).toEqual([
      ['chat.postMessage', 'started card: 3 tasks in general/card-9'],
      ['chat.update', 'started card: 3 tasks in general/card-9\n#11 claimed, #13 waiting, #15 waiting'],
    ])
  })

  it('a board made at store version 9 gets the table, and shows work on it', async () => {
    const dir = tempDir()
    const first = setup({ dir })
    const root = await first.thread()
    first.backend.close()
    // Back to what the release before this wrote: the same tables, without this one and its index.
    const raw = new DatabaseSync(join(dir, 'main.db'))
    raw.exec('drop table sync_working; drop index messages_progress; pragma user_version = 9')
    raw.close()
    const again = first.open()
    await board({ backend: again }).as('workflows').reply({ to: root, text: 'started card: 1 tasks in general/card-3', labels: { progress: 'open' } })
    await again.syncTick()
    expect(first.steps()).toEqual(['start'])
    again.close()
  })
})
