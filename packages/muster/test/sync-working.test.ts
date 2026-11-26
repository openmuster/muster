import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { board, file, http, linear, listen, mint, slack } from '../src/index.ts'
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
    const shown = await thread()
    await daemon.reply({ to: shown, text: 'started card: 1 tasks in general/card-3', labels: { progress: 'open' }, noSync: true })
    // And one said with noSync, then edited and only then labelled, by a caller that may sync: still the board's alone.
    const kept = await daemon.reply({ to: shown, text: 'for the board only', noSync: true })
    await daemon.edit({ id: kept.id, text: 'for the board only, edited' })
    await daemon.label({ id: kept.id, set: { progress: 'open' } })
    await backend.syncTick()
    expect(steps()).toEqual([])
  })

  it('shows nothing a caller held to the board wrote: not its edit of a progress message, its label on one, or its closing of one', async () => {
    const { backend, time, daemon, told, steps, thread, begin } = setup()
    const root = await thread()
    const progress = await begin(root)
    const plain = await daemon.reply({ to: root, text: 'notes, not progress' })
    await backend.syncTick()
    // The same board over HTTP, for a token that may write but is held to the board.
    const key = randomBytes(32)
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    const held = board({ backend: http({ url: server.url, token: mint(key, { sub: 'local:user:ada', profile: 'workflows', exp: Math.floor(time.now().getTime() / 1000) + 3600, noSync: true }) }) })
    try {
      await held.edit({ id: progress.id, text: 'a secret the platform must not see' })
      await held.label({ id: plain.id, set: { progress: 'open' } })
      await backend.syncTick()
      expect(steps()).toEqual(['start'])
      await held.label({ id: progress.id, set: { progress: 'done' } })
      await backend.syncTick()
      expect(steps()).toEqual(['start'])
      // A message it edited, labelled afterwards by a caller that may sync: shown with the words it had before.
      await held.edit({ id: plain.id, text: 'another secret' })
      await daemon.label({ id: plain.id, set: { progress: 'open' } })
      await backend.syncTick()
      expect(told.at(-1)).toMatchObject({ step: 'text', text: 'notes, not progress' })
      await daemon.label({ id: plain.id, set: { progress: 'done' } })
      await backend.syncTick()
      // The daemon's own closing goes out, with the words the platform last had from a caller that may sync.
      await daemon.label({ id: progress.id, set: { progress: 'open' } })
      await daemon.label({ id: progress.id, set: { progress: 'done' } })
      await backend.syncTick()
      expect(told.map((each) => [each.step, each.text])).toEqual([
        ['start', 'started card: 3 tasks in general/card-9'],
        ['text', 'notes, not progress'],
        ['text', 'started card: 3 tasks in general/card-9'],
        ['end', 'started card: 3 tasks in general/card-9'],
      ])
    } finally {
      await server.close()
    }
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
    // Back to what the release before this wrote: the same tables, without these two.
    const raw = new DatabaseSync(join(dir, 'main.db'))
    raw.exec('drop table sync_working; drop table sync_progress; pragma user_version = 9')
    raw.close()
    const again = first.open()
    await board({ backend: again }).as('workflows').reply({ to: root, text: 'started card: 1 tasks in general/card-3', labels: { progress: 'open' } })
    await again.syncTick()
    expect(first.steps()).toEqual(['start'])
    again.close()
  })
})

describe('sync: Slack as an agent shows a thread being worked on', () => {
  /** A board synced with a Slack channel by an app declared an agent, and a Slack that takes its calls. */
  function agent(options: { refuse?: () => string | null } = {}) {
    const time = clock()
    const sent: { method: string; auth: string | null; body: any }[] = []
    let made = 9000
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()!
      sent.push({ method, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) })
      const error = method === 'agents.sessions.setStatus' ? options.refuse?.() : null
      return Response.json(error ? { ok: false, error } : { ok: true, ts: `1700000000.${++made}` })
    }) as typeof fetch
    const chat = slack({ secret: SECRET, token: 'xoxb', bot: 'B0BOT', agent: true, channels: { C123: 'general' }, now: () => time.now().getTime() })
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now, sync: { chat }, fetch: fetcher })
    const team = board({ backend })
    const thread = async () => {
      await backend.syncTick()
      const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message', user: 'U1', channel: 'C123', text: 'the footer says 2025', ts: '1700000000.000100' } })
      const stamp = String(Math.floor(time.now().getTime() / 1000))
      await backend.syncReceive('chat', { headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${body}`).digest('hex')}` }, body })
      return (await team.readChannel({ channel: 'general' })).threads[0]!.message.id
    }
    const statuses = () => sent.filter((call) => call.method === 'agents.sessions.setStatus').map((call) => call.body.status)
    return { time, sent, statuses, backend, team, daemon: team.as('workflows'), thread }
  }

  it("sets the thread's session to processing while a run works and to active when it ends, and posts only the summary", async () => {
    const { backend, daemon, sent, thread } = agent()
    const root = await thread()
    const progress = await daemon.reply({ to: root, text: 'started card: 3 tasks in general/card-9', labels: { progress: 'open' } })
    await backend.syncTick()
    expect(sent).toEqual([{ method: 'agents.sessions.setStatus', auth: 'Bearer xoxb', body: { channel_id: 'C123', thread_ts: '1700000000.000100', status: 'processing' } }])
    // What the run says next starts Slack's hour over; Slack shows none of its words.
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in general/card-9\n#11 claimed, #13 waiting, #15 waiting' })
    await backend.syncTick()
    await daemon.reply({ to: root, text: 'card finished: 3 completed, 0 failed, 0 canceled' })
    await daemon.label({ id: progress.id, set: { progress: 'done' } })
    await backend.syncTick()
    expect(sent.slice(1).map((call) => [call.method, call.body.status ?? call.body.text])).toEqual([
      ['agents.sessions.setStatus', 'processing'],
      ['chat.postMessage', 'card finished: 3 completed, 0 failed, 0 canceled'],
      ['agents.sessions.setStatus', 'active'],
    ])
  })

  it('tells Slack again before its hour is up, while the run still works', async () => {
    const { backend, time, daemon, statuses, thread } = agent()
    await daemon.reply({ to: await thread(), text: 'started card: 3 tasks in general/card-9', labels: { progress: 'open' } })
    await backend.syncTick()
    time.advance(49 * MIN)
    await backend.syncTick()
    expect(statuses()).toEqual(['processing'])
    time.advance(MIN)
    await backend.syncTick()
    expect(statuses()).toEqual(['processing', 'processing'])
  })

  it('takes a refusal from Slack as a failure, and tries again in a minute', async () => {
    let error: string | null = 'feature_disabled'
    const { backend, time, daemon, statuses, thread } = agent({ refuse: () => error })
    const progress = await daemon.reply({ to: await thread(), text: 'started card: 3 tasks in general/card-9', labels: { progress: 'open' } })
    await backend.syncTick()
    error = null
    await backend.syncTick()
    expect(statuses()).toEqual(['processing'])
    time.advance(MIN)
    await backend.syncTick()
    // Told once it took it: the end is then said too.
    await daemon.label({ id: progress.id, set: { progress: 'done' } })
    await backend.syncTick()
    expect(statuses()).toEqual(['processing', 'processing', 'active'])
  })
})

describe('sync: Linear as an agent shows an issue being worked on', () => {
  const APP_SECRET = 'app-whsec'
  const ISSUE = { id: 'iss-1', identifier: 'ENG-42', title: 'Crash', team: { key: 'ENG' }, creatorId: 'u-nico', state: { name: 'Todo' } }
  /** A board synced with a Linear team by an app with agent sessions on, and a Linear that takes its calls. */
  function agent(options: { agent?: boolean; dir?: string; gone?: () => string | null; refuse?: () => boolean } = {}) {
    const time = clock()
    const calls: { op: string; input?: any }[] = []
    let sessions = 0
    let comments = 0
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'lin_app_1', token_type: 'Bearer', expires_in: 2591999, scope: 'read write' })
      const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: { input?: any } }
      if (query.includes('viewer')) {
        calls.push({ op: 'viewer' })
        return Response.json({ data: { viewer: { id: 'u-app' } } })
      }
      if (query.includes('agentSessionCreateOnIssue')) {
        calls.push({ op: 'session', input: variables!.input })
        return Response.json({ data: { agentSessionCreateOnIssue: { success: true, agentSession: { id: `s-${++sessions}` } } } })
      }
      if (query.includes('agentActivityCreate')) {
        const input = variables!.input
        calls.push({ op: 'activity', input })
        // A session Linear no longer has, or a call it won't take just now: a 200 with errors, as Linear answers.
        if (options.gone?.() === input.agentSessionId || options.refuse?.()) return Response.json({ errors: [{ message: 'Entity not found' }] })
        return Response.json({ data: { agentActivityCreate: { success: true } } })
      }
      if (query.includes('commentCreate')) {
        calls.push({ op: 'comment', input: variables!.input })
        return Response.json({ data: { commentCreate: { success: true, comment: { id: `lc-${++comments}` } } } })
      }
      // What a board that starts again asks about the time it was away: nothing changed.
      const none = { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
      return Response.json({ data: { issues: none, comments: none } })
    }) as typeof fetch
    const lin = linear({ secret: SECRET, appSecret: APP_SECRET, clientId: 'client-1', clientSecret: 'shh', teams: { ENG: 'eng' }, now: () => time.now().getTime(), ...(options.agent === false ? {} : { agent: true }) })
    const open = () => file({ ...(options.dir ? { dir: options.dir } : { memory: true }), principal: 'local:user:ada', now: time.now, sync: { lin }, fetch: fetcher })
    const backend = open()
    const team = board({ backend })
    let delivery = 0
    const hook = (payload: unknown, secret = SECRET, to = backend) => {
      const body = JSON.stringify(payload)
      return to.syncReceive('lin', { headers: { 'linear-delivery': `l-${++delivery}`, 'linear-signature': createHmac('sha256', secret).update(body).digest('hex') }, body })
    }
    const issue = async () => {
      await backend.syncTick()
      await hook({ type: 'Issue', action: 'create', data: ISSUE })
      return (await team.readChannel({ channel: 'eng' })).threads[0]!.message.id
    }
    const daemon = team.as('workflows')
    const begin = (to: number) => daemon.reply({ to, text: 'started card: 3 tasks in eng/card-9', labels: { progress: 'open' } })
    const said = () => calls.filter((call) => call.op !== 'viewer').map((call) => (call.op === 'activity' ? [call.input.content.type, call.input.agentSessionId, call.input.content.body, call.input.ephemeral === true] : [call.op, call.input.issueId, call.input.body ?? null]))
    return { time, calls, said, backend, team, daemon, open, hook, issue, begin }
  }

  it('opens a session on the issue, says where the run is in notes that replace each other, and ends it with its last words', async () => {
    const { backend, daemon, said, issue, begin } = agent()
    const root = await issue()
    const progress = await begin(root)
    await backend.syncTick()
    expect(said()).toEqual([
      ['session', 'iss-1', null],
      ['thought', 's-1', 'started card: 3 tasks in eng/card-9', true],
    ])
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in eng/card-9\n#11 completed, #13 completed, #15 completed' })
    await backend.syncTick()
    await daemon.reply({ to: root, text: 'card finished: 3 completed, 0 failed, 0 canceled' })
    await daemon.label({ id: progress.id, set: { progress: 'done' } })
    await backend.syncTick()
    // The progress message was never a comment; the summary is one, and the session's response is not ephemeral.
    expect(said().slice(2)).toEqual([
      ['thought', 's-1', 'started card: 3 tasks in eng/card-9\n#11 completed, #13 completed, #15 completed', true],
      ['comment', 'iss-1', 'card finished: 3 completed, 0 failed, 0 canceled'],
      ['response', 's-1', 'started card: 3 tasks in eng/card-9\n#11 completed, #13 completed, #15 completed', false],
    ])
  })

  it("goes on in the same session for a later round, after the board started again, and tells Linear again before a session goes stale", async () => {
    const first = agent({ dir: tempDir() })
    const progress = await first.begin(await first.issue())
    await first.backend.syncTick()
    await first.daemon.label({ id: progress.id, set: { progress: 'done' } })
    await first.backend.syncTick()
    first.backend.close()
    const again = first.open()
    await board({ backend: again }).as('workflows').label({ id: progress.id, set: { progress: 'open' } })
    await again.syncTick()
    first.time.advance(24 * MIN)
    await again.syncTick()
    expect(first.said().map((each) => [each[0], each[1]])).toEqual([['session', 'iss-1'], ['thought', 's-1'], ['response', 's-1'], ['thought', 's-1']])
    first.time.advance(MIN)
    await again.syncTick()
    expect(first.said().at(-1)).toEqual(['thought', 's-1', 'started card: 3 tasks in eng/card-9', true])
    expect(first.said()).toHaveLength(5)
    again.close()
  })

  it('opens a new session when work starts and Linear no longer has the old one, but only tries again when a note in the middle of a run is refused', async () => {
    let gone: string | null = null
    let refusing = false
    const { backend, time, daemon, said, issue, begin } = agent({ gone: () => gone, refuse: () => refusing })
    const root = await issue()
    const progress = await begin(root)
    await backend.syncTick()
    refusing = true
    await daemon.edit({ id: progress.id, text: 'started card: 3 tasks in eng/card-9\n#11 claimed' })
    await backend.syncTick()
    refusing = false
    time.advance(MIN)
    await backend.syncTick()
    // Refused, then taken a minute later: the same session, and no second one.
    expect(said().filter((each) => each[0] === 'session')).toHaveLength(1)
    expect(said().at(-1)).toEqual(['thought', 's-1', 'started card: 3 tasks in eng/card-9\n#11 claimed', true])
    await daemon.label({ id: progress.id, set: { progress: 'done' } })
    await backend.syncTick()
    gone = 's-1'
    await daemon.label({ id: progress.id, set: { progress: 'open' } })
    await backend.syncTick()
    expect(said().slice(-3).map((each) => [each[0], each[1]])).toEqual([['thought', 's-1'], ['session', 'iss-1'], ['thought', 's-2']])
  })

  it("doesn't bring in what the session itself said as a comment, and still brings in a person's", async () => {
    const { backend, team, hook, issue, begin } = agent()
    const root = await issue()
    await begin(root)
    await backend.syncTick()
    // Linear writes the session's response on the issue as a comment by the app, and tells the workspace's webhook.
    await hook({ type: 'Comment', action: 'create', data: { id: 'c-resp', body: 'started card: 3 tasks in eng/card-9', issueId: 'iss-1', userId: 'u-app', issue: { team: { key: 'ENG' } } } })
    await hook({ type: 'Comment', action: 'create', data: { id: 'c-maya', body: 'thanks', issueId: 'iss-1', userId: 'u-maya', issue: { team: { key: 'ENG' } } } })
    expect((await team.readThread({ id: root })).replies.map((reply) => [reply.by.principal, reply.text])).toEqual([
      ['local:user:ada', 'started card: 3 tasks in eng/card-9'],
      ['lin:user:u-maya', 'thanks'],
    ])
  })

  it("takes the application's own webhook, signed with its own secret, and imports nothing from it", async () => {
    const { backend, team, hook, issue } = agent()
    const root = await issue()
    const event = { type: 'AgentSessionEvent', action: 'prompted', agentSession: { id: 's-1', issueId: 'iss-1' }, agentActivity: { content: { type: 'prompt', body: 'and the header?' } } }
    expect((await hook(event, APP_SECRET)).status).toBe(200)
    expect((await hook(event, 'someone-else')).status).toBe(401)
    await backend.syncTick()
    expect((await team.readThread({ id: root })).replies).toEqual([])
  })

  it('sends the progress message as a comment when the app has no agent sessions on', async () => {
    const { backend, said, issue, begin } = agent({ agent: false })
    await begin(await issue())
    await backend.syncTick()
    expect(said()).toEqual([['comment', 'iss-1', 'started card: 3 tasks in eng/card-9']])
  })
})
