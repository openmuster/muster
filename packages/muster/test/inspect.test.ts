import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { inspect } from '../src/inspect/server.ts'
import { initial, openCount, reduce, tasksFor } from '../src/inspect/app/store.ts'
import { notices, show } from '../src/inspect/app/notify.ts'
import { board as handle, file } from '../src/index.ts'
import type { TaskListing } from '../src/core/tasks.ts'
import type { Message } from '../src/model.ts'

async function page() {
  const backend = file({ memory: true, principal: 'local:user:ada' })
  const serving = await inspect({ backend, bundle: new URL('./helpers.ts', import.meta.url).pathname })
  const board = (route: string, init: { token?: string; origin?: string | null; body?: unknown; method?: string } = {}) =>
    fetch(`${serving.url}/board/${route}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.token !== '' ? { 'x-muster-inspect': init.token ?? serving.token } : {}), ...(init.origin === null ? {} : { origin: init.origin ?? serving.url }) },
      ...(init.method === 'GET' ? {} : { body: JSON.stringify(init.body ?? { args: [] }) }),
    })
  return { serving, board, backend }
}

describe('the inspector', () => {
  it('serves the same page for any path, so a view is a link, and never sends its token: that is only in the link it hands back', async () => {
    const { serving } = await page()
    for (const path of ['/', '/c/db%2Fstorage?thread=5', '/activity', '/app.js']) {
      const response = await fetch(serving.url + path)
      const body = await response.text()
      // Anything on this machine can ask for these, so nothing in them may let it act as you.
      expect(body).not.toContain(serving.token)
      response.headers.forEach((value) => expect(value).not.toContain(serving.token))
      if (path === '/app.js') continue
      expect(response.headers.get('content-type')).toMatch(/text\/html/)
      expect(body).toContain('<script type="module" src="/app.js">')
    }
    expect(serving.link).toBe(`${serving.url}/#k=${serving.token}`)
    expect(serving.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    await serving.close()
  })

  it('says who the page belongs to, as a mention of them reads, only to the page', async () => {
    const { serving, board } = await page()
    expect(await (await board('whoami')).json()).toEqual({ ok: 'local:user:ada' })
    expect((await board('whoami', { token: 'wrong' })).status).toBe(401)
    expect((await board('whoami', { origin: 'http://evil.example' })).status).toBe(403)
    await serving.close()
  })

  it('the page reads and writes the board through the proxy, as you or as a profile you pick', async () => {
    const { serving, board } = await page()
    const posted = await (await board('post', { body: { args: [{ channel: 'dev', text: 'from the page' }], as: 'claude' } })).json()
    expect(posted.ok).toMatchObject({ channel: 'dev', by: { principal: 'local:user:ada', profile: 'claude' } })
    const read = await (await board('readChannel', { body: { args: [{ channel: 'dev' }] } })).json()
    expect(read.ok.threads).toHaveLength(1)
    const refused = await board('reply', { body: { args: [{ to: 999, text: 'x' }] } })
    expect([refused.status, (await refused.json()).error.reason]).toEqual([404, 'not_found'])
    await serving.close()
  })

  it('refuses a board request without the page token, with a wrong one, or from another origin', async () => {
    const { serving, board } = await page()
    expect((await board('head', { token: '' })).status).toBe(401)
    expect((await board('head', { token: 'x'.repeat(32) })).status).toBe(401)
    expect((await board('head', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await board('head', { origin: null })).status).toBe(403)
    expect((await board('head', { method: 'GET' })).status).toBe(404)
    expect((await board('scheduleTick')).status).toBe(404)
    expect((await board('head')).status).toBe(200)
    await serving.close()
  })

  it('lists requests to join and approves one as you, with the page token and origin like any write', async () => {
    const { serving, board, backend } = await page()
    const asked = await backend.joins.ask({ profile: 'reviewer', note: 'the review bot' })
    expect((await (await board('joinList')).json()).ok.joins).toMatchObject([{ code: asked.code, profile: 'reviewer', note: 'the review bot', state: 'pending' }])
    expect((await board('joinApprove', { origin: 'https://evil.example', body: { args: [{ code: asked.code, can: { 'work/': ['read'] }, ttl: 3600 }] } })).status).toBe(403)
    const approved = await (await board('joinApprove', { body: { args: [{ code: asked.code, can: { 'work/': ['read', 'post'] }, ttl: 3600 }] } })).json()
    expect(approved.ok).toMatchObject({ join: { state: 'approved' }, record: { profile: 'reviewer', can: { 'work/': ['read', 'post'] } } })
    expect(await backend.joins.poll({ code: asked.code, secret: asked.secret })).toMatchObject({ state: 'approved', token: expect.stringMatching(/^mu1\./) })
    await serving.close()
  })

  it('carries its tab icon inline, as an image its own policy allows, so it asks the network for nothing', async () => {
    const { serving } = await page()
    const response = await fetch(serving.url + '/')
    const icon = /<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/.exec(await response.text())?.[1]
    expect(icon).toBeDefined()
    expect(decodeURIComponent(icon!.slice('data:image/svg+xml,'.length))).toMatch(/^<svg [^>]*viewBox="0 0 16 16"/)
    expect(response.headers.get('content-security-policy')).toMatch(/img-src [^;]*data:/)
    await serving.close()
  })

  it('answers only for its own host name', async () => {
    const { serving } = await page()
    const port = new URL(serving.url).port
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).end()
    })
    expect(status).toBe(403)
    await serving.close()
  })
})

const task = (id: number, state: TaskListing['state']) => ({ id, state, text: `t${id}`, labels: {}, needs: [] }) as unknown as TaskListing
const message = (id: number, revision: number, text: string) => ({ id, revision, text }) as unknown as Message

describe('the page store', () => {
  it('sorts tasks into the tabs, with open meaning waiting, ready, claimed and blocked', () => {
    const state = reduce(initial, { type: 'snapshot', channels: [], cursor: 9, tasks: [task(1, 'ready'), task(2, 'waiting'), task(3, 'claimed'), task(4, 'blocked'), task(5, 'completed'), task(6, 'failed'), task(7, 'canceled')] })
    expect(tasksFor(state, 'open').map((item) => item.id)).toEqual([1, 2, 3, 4])
    expect(tasksFor(state, 'completed').map((item) => item.id)).toEqual([5])
    expect(tasksFor(state, 'all')).toHaveLength(7)
    expect(openCount(state)).toBe(4)
  })

  it('an older snapshot never replaces a newer one, and an older revision of a message never replaces a newer', () => {
    const newer = reduce(initial, { type: 'snapshot', channels: [], cursor: 10, tasks: [task(1, 'completed')] })
    const stale = reduce(newer, { type: 'snapshot', channels: [], cursor: 8, tasks: [task(1, 'ready')] })
    expect(stale.tasks[0]!.state).toBe('completed')
    const open = reduce(initial, { type: 'thread', message: message(1, 3, 'v3'), replies: [] })
    expect(reduce(open, { type: 'thread', message: message(1, 2, 'v2'), replies: [] }).open!.message.text).toBe('v3')
    expect(reduce(open, { type: 'thread', message: message(1, 4, 'v4'), replies: [] }).open!.message.text).toBe('v4')
  })

  it('your own write shows at once, then goes when the board confirms it, and leaves an error when it refuses', () => {
    const sending = reduce(initial, { type: 'sending', key: 'a', thread: 5, channel: 'dev', text: 'hello' })
    expect(sending.pending).toEqual([{ key: 'a', thread: 5, channel: 'dev', text: 'hello' }])
    expect(reduce(sending, { type: 'sent', key: 'a' }).pending).toEqual([])
    const refused = reduce(sending, { type: 'refused', key: 'a', error: 'No message 5.' })
    expect([refused.pending, refused.error]).toEqual([[], 'No message 5.'])
  })

  it('the activity list takes each event once, newest first', () => {
    const event = (seq: number) => ({ seq, type: 'message.posted' }) as never
    const first = reduce(initial, { type: 'events', events: [event(1), event(2)], cursor: 2 })
    const again = reduce(first, { type: 'events', events: [event(2), event(3)], cursor: 3 })
    expect(again.activity.map((item) => item.seq)).toEqual([3, 2, 1])
    expect(again.cursor).toBe(3)
  })
})

describe("the inspector's notifications", () => {
  /** A board with you on it, and what is new on it read for you, as the page reads it. */
  async function mentions(write: (team: ReturnType<typeof handle>) => Promise<unknown>) {
    const team = handle({ backend: file({ memory: true, principal: 'local:user:ada' }) })
    await team.post({ channel: 'general', text: 'here' })
    const after = await team.head()
    await write(team)
    return (await team.events({ after, filter: { for: 'local:user:ada', types: ['message.posted'] } })).events
  }

  it('one for each new message that mentions you, as you read it, and none for your own or another\'s', async () => {
    let asked = 0
    const events = await mentions(async (team) => {
      await team.post({ channel: 'general', text: '@claude yours' })
      await team.as('lead').post({ channel: 'general', text: 'no one in particular' })
      await team.as('lead').post({ channel: 'work/api', text: '@lead a note to self' })
      asked = (await team.as('claude').post({ channel: 'work/api', text: `@ada look at this ${'x'.repeat(300)}` })).id
    })
    const shown = notices(events, new Set())
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'claude mentioned you in #work/api', tag: `muster-${asked}`, href: `/c/work%2Fapi?thread=${asked}` })
    expect(shown[0]!.body.startsWith('@ada look at this x')).toBe(true)
    expect(shown[0]!.body.length).toBe(160)
    expect(shown[0]!.body.endsWith('…')).toBe(true)
  })

  it('none for what this tab wrote, whichever profile it wrote as', async () => {
    let mine = 0
    const events = await mentions(async (team) => {
      mine = (await team.as('reviewer').post({ channel: 'general', text: '@ada from the page' })).id
    })
    expect(notices(events, new Set()).length).toBe(1)
    expect(notices(events, new Set([mine]))).toEqual([])
  })

  it('a browser that refuses one still shows the rest, and a click opens the thread', async () => {
    const opened: string[] = []
    const made: { title: string; onclick: (() => void) | null; close(): void }[] = []
    const list = [
      { title: 'one', body: '', tag: 'muster-1', href: '/c/a?thread=1' },
      { title: 'two', body: '', tag: 'muster-2', href: '/c/a?thread=2' },
    ]
    const shown = show(list, (href) => opened.push(href), (title) => {
      if (title === 'one') throw new TypeError("Failed to construct 'Notification': Illegal constructor.")
      const note = { title, onclick: null as (() => void) | null, close() {} }
      made.push(note)
      return note as unknown as Notification
    })
    expect(shown).toBe(1)
    expect(made.map((note) => note.title)).toEqual(['two'])
    made[0]!.onclick!()
    expect(opened).toEqual(['/c/a?thread=2'])
  })
})
