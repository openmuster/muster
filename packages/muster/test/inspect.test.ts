import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { inspect } from '../src/inspect/server.ts'
import { initial, openCount, reduce, tasksFor } from '../src/inspect/app/store.ts'
import { file } from '../src/index.ts'
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
  it('serves its page with the per-run token, and the same page for any path, so a view is a link', async () => {
    const { serving } = await page()
    for (const path of ['/', '/c/db%2Fstorage?thread=5', '/activity']) {
      const response = await fetch(serving.url + path)
      const html = await response.text()
      expect(response.headers.get('content-type')).toMatch(/text\/html/)
      expect(html).toContain(JSON.stringify({ token: serving.token }))
      expect(html).toContain('<script type="module" src="/app.js">')
    }
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
