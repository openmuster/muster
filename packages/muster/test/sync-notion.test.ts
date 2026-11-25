import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { board, file, notion } from '../src/index.ts'
import { notionTokenFile } from '../src/sync/providers.ts'
import { clock, tempDir } from './helpers.ts'

const TOKEN = 'secret_abcdefghijklmnopqrstuvwxyz0123456789'
const DB = '1a2b3c4d-0000-4000-8000-00000000d00b'
const OTHER_DB = '9f9f9f9f-0000-4000-8000-0000000000ff'
const BOT = 'b0700000-0000-4000-8000-000000000b07'
const sign = (body: string, secret = TOKEN) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const saved = process.env.MUSTER_CONFIG
afterEach(() => {
  if (saved === undefined) delete process.env.MUSTER_CONFIG
  else process.env.MUSTER_CONFIG = saved
})

type Page = { id: string; db: string; title: string; markdown: string; status?: string; by: string; editedBy: string; edited: string; url: string }
type Comment = { id: string; page: string; text: string; by: string; created: string; edited: string }

/** Notion's API, standing in: pages and comments it holds, and what was asked of it. */
function fakeNotion() {
  const pages = new Map<string, Page>()
  const comments = new Map<string, Comment>()
  const asked: { method: string; path: string; body: any; version: string | null }[] = []
  let made = 0
  let down: () => boolean = () => false
  const pageJson = (page: Page) => ({
    object: 'page',
    id: page.id,
    url: page.url,
    parent: { type: 'data_source_id', data_source_id: page.db, database_id: page.db },
    created_by: { object: 'user', id: page.by },
    last_edited_by: { object: 'user', id: page.editedBy },
    last_edited_time: page.edited,
    properties: { Name: { type: 'title', title: [{ plain_text: page.title }] }, ...(page.status ? { Status: { type: 'status', status: { name: page.status } } } : {}) },
  })
  const commentJson = (comment: Comment) => ({ object: 'comment', id: comment.id, parent: { type: 'page_id', page_id: comment.page }, created_by: { object: 'user', id: comment.by }, created_time: comment.created, last_edited_time: comment.edited, rich_text: [{ plain_text: comment.text }] })
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace(/^\/v1/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    asked.push({ method, path: path + parsed.search, body, version: new Headers(init?.headers).get('notion-version') })
    const id = (raw: string) => raw.replace(/-/g, '')
    let match: RegExpExecArray | null
    if ((match = /^\/pages\/([^/]+)\/markdown$/.exec(path))) {
      if (down()) return new Response('{}', { status: 500 })
      const page = pages.get(id(match[1]!))
      return page ? Response.json({ object: 'page_markdown', markdown: page.markdown }) : new Response('{}', { status: 404 })
    }
    if ((match = /^\/pages\/([^/]+)$/.exec(path))) {
      const page = pages.get(id(match[1]!))
      return page ? Response.json(pageJson(page)) : new Response('{}', { status: 404 })
    }
    if (path === '/pages' && method === 'POST') {
      const page: Page = { id: `ffff0000-0000-4000-8000-${String(++made).padStart(12, '0')}`, db: body.parent.data_source_id, title: body.properties.Name.title[0].text.content, markdown: '', by: BOT, editedBy: BOT, edited: '2026-01-01T00:00:00.000Z', url: 'https://www.notion.so/new' }
      pages.set(id(page.id), page)
      return Response.json(pageJson(page))
    }
    if ((match = /^\/data_sources\/([^/]+)$/.exec(path))) return Response.json({ object: 'data_source', properties: { Name: { type: 'title' }, Status: { type: 'status' } } })
    if ((match = /^\/data_sources\/([^/]+)\/query$/.exec(path))) {
      const after = body.filter.last_edited_time.after as string
      const results = [...pages.values()].filter((page) => id(page.db) === id(match![1]!) && page.edited > after).sort((a, b) => a.edited.localeCompare(b.edited)).map(pageJson)
      return Response.json({ object: 'list', results, has_more: false, next_cursor: null })
    }
    if (path === '/comments' && method === 'GET') {
      const block = id(parsed.searchParams.get('block_id') ?? '')
      return Response.json({ object: 'list', results: [...comments.values()].filter((comment) => id(comment.page) === block).map(commentJson), has_more: false })
    }
    if (path === '/comments' && method === 'POST') {
      const comment: Comment = { id: `cccc0000-0000-4000-8000-${String(++made).padStart(12, '0')}`, page: body.parent.page_id, text: body.rich_text.map((each: any) => each.text.content).join(''), by: BOT, created: '2026-01-01T00:00:00.000Z', edited: '2026-01-01T00:00:00.000Z' }
      comments.set(id(comment.id), comment)
      return Response.json(commentJson(comment))
    }
    if ((match = /^\/comments\/([^/]+)$/.exec(path))) {
      const comment = comments.get(id(match[1]!))
      if (method === 'DELETE') return Response.json({ deleted: comments.delete(id(match[1]!)) })
      return comment ? Response.json(commentJson(comment)) : new Response('{}', { status: 404 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { pages, comments, asked, fetcher, set markdownDown(check: () => boolean) { down = check } }
}

function setup(options: { dir?: string; secret?: string } = {}) {
  const time = clock()
  const api = fakeNotion()
  const sync = { nt: notion({ secret: options.secret ?? TOKEN, token: 'ntn_token', bot: BOT, databases: { [DB.replace(/-/g, '')]: 'cards/notion' } }) }
  const open = () => file({ ...(options.dir ? { dir: options.dir } : { memory: true }), principal: 'local:user:ada', now: time.now, sync, fetch: api.fetcher })
  const backend = open()
  const team = board({ backend })
  let n = 0
  /** A webhook as Notion sends it: signed with the verification token, saying only what changed. */
  const hook = (type: string, entity: { id: string; type: string }, data: Record<string, unknown> = {}, author = 'u-ada', id = `evt-${++n}`) => {
    const body = JSON.stringify({ id, timestamp: time.now().toISOString(), workspace_id: 'ws', subscription_id: 'sub', integration_id: 'int', type, authors: [{ id: author, type: author === BOT ? 'bot' : 'person' }], attempt_number: 1, entity, data })
    return backend.syncReceive('nt', { headers: { 'x-notion-signature': sign(body) }, body })
  }
  const page = (pageId: string, fields: Partial<Page> = {}) => {
    const made: Page = { id: pageId, db: DB, title: 'Stacks should show a count', markdown: 'Each stack row shows how many are in it.', status: 'Not started', by: 'u-ada', editedBy: 'u-ada', edited: time.now().toISOString(), url: `https://www.notion.so/${pageId.replace(/-/g, '')}`, ...fields }
    api.pages.set(pageId.replace(/-/g, ''), made)
    return made
  }
  const threads = async () => (await team.readChannel({ channel: 'cards/notion' })).threads
  return { time, api, backend, team, hook, page, threads, open }
}

const P1 = 'aaaa0000-0000-4000-8000-000000000001'
const C1 = 'cccc1111-0000-4000-8000-000000000001'

describe('sync: Notion', () => {
  it("answers Notion's one unsigned request, its verification token, by writing the token for the operator alone, and refuses anything else unsigned", async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { backend, threads } = setup({ secret: 'pending' })
    const body = JSON.stringify({ verification_token: TOKEN })
    expect(await backend.syncReceive('nt', { headers: {}, body })).toEqual({ status: 200, body: 'ok' })
    expect(readFileSync(notionTokenFile(), 'utf8').trim()).toBe(TOKEN)
    expect(statSync(notionTokenFile()).mode & 0o777).toBe(0o600)
    expect(notionTokenFile()).toBe(join(process.env.MUSTER_CONFIG!, 'notion-verification-token'))
    // Someone else's token, sent after it, is answered the same but never written over the first.
    expect(await backend.syncReceive('nt', { headers: {}, body: JSON.stringify({ verification_token: 'secret_PlantedByAnyoneElse0123456789' }) })).toEqual({ status: 200, body: 'ok' })
    expect(readFileSync(notionTokenFile(), 'utf8').trim()).toBe(TOKEN)
    // A board that has its secret takes nothing unsigned, a verification token included.
    const configured = setup()
    expect((await configured.backend.syncReceive('nt', { headers: {}, body })).status).toBe(401)
    // Anything else unsigned, or signed with another secret, is refused, and imports nothing.
    const event = JSON.stringify({ id: 'x', type: 'page.created', entity: { id: P1, type: 'page' } })
    expect((await backend.syncReceive('nt', { headers: {}, body: event })).status).toBe(401)
    expect((await backend.syncReceive('nt', { headers: { 'x-notion-signature': sign(event, 'secret_other_other_other') }, body: event })).status).toBe(401)
    expect((await backend.syncReceive('nt', { headers: {}, body: JSON.stringify({ verification_token: TOKEN, type: 'page.created' }) })).status).toBe(401)
    await backend.syncTick()
    expect(await threads()).toEqual([])
  })

  it('a page made in a mapped database is a thread: its title and text, by who made it, its Status a label, read from Notion once the webhook is answered', async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { hook, page, threads, backend, api } = setup()
    page(P1)
    expect(await hook('page.created', { id: P1, type: 'page' }, { parent: { id: DB, type: 'database' } })).toEqual({ status: 200, body: 'ok' })
    // Answered before Notion was asked anything: what the page says is read on the ticker.
    expect(api.asked).toEqual([])
    await backend.syncTick()
    const [thread] = await threads()
    expect(thread!.message.text).toBe('Stacks should show a count\n\nEach stack row shows how many are in it.')
    expect(thread!.message.by.principal).toBe('nt:user:u-ada')
    expect(thread!.message.labels).toMatchObject({ kind: 'page', state: 'not-started', ref: `https://www.notion.so/${P1.replace(/-/g, '')}` })
    expect(api.asked.every((each) => each.version === '2026-03-11')).toBe(true)
  })

  it("a page in a database this sync doesn't map, and a retried event, bring in nothing more", async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { hook, page, threads, backend } = setup()
    page('bbbb0000-0000-4000-8000-000000000002', { db: OTHER_DB })
    await hook('page.created', { id: 'bbbb0000-0000-4000-8000-000000000002', type: 'page' })
    page(P1)
    await hook('page.created', { id: P1, type: 'page' }, {}, 'u-ada', 'evt-same')
    await hook('page.created', { id: P1, type: 'page' }, {}, 'u-ada', 'evt-same')
    await backend.syncTick()
    expect((await threads()).map((thread) => thread.message.text.split('\n')[0])).toEqual(['Stacks should show a count'])
  })

  it('comments are replies, edited and deleted as they are on Notion; a change to the page edits its first message and its Status label', async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { hook, page, threads, backend, team, api, time } = setup()
    page(P1)
    await hook('page.created', { id: P1, type: 'page' })
    await backend.syncTick()
    api.comments.set(C1.replace(/-/g, ''), { id: C1, page: P1, text: 'make the count grey', by: 'u-maya', created: time.now().toISOString(), edited: time.now().toISOString() })
    await hook('comment.created', { id: C1, type: 'comment' }, { page_id: P1, discussion_id: 'd1', parent: { id: P1, type: 'page' } }, 'u-maya')
    await backend.syncTick()
    const root = (await threads())[0]!.message.id
    const replies = async () => (await team.readThread({ id: root })).replies.filter((reply) => !reply.deleted).map((reply) => [reply.text, reply.by.principal])
    expect(await replies()).toEqual([['make the count grey', 'nt:user:u-maya']])
    time.advance(60_000)
    api.comments.get(C1.replace(/-/g, ''))!.text = 'make the count light grey'
    api.comments.get(C1.replace(/-/g, ''))!.edited = time.now().toISOString()
    await hook('comment.updated', { id: C1, type: 'comment' }, { page_id: P1 }, 'u-maya')
    await backend.syncTick()
    expect(await replies()).toEqual([['make the count light grey', 'nt:user:u-maya']])
    time.advance(60_000)
    Object.assign(api.pages.get(P1.replace(/-/g, ''))!, { title: 'Stacks show a count', status: 'In progress', edited: time.now().toISOString(), editedBy: 'u-maya' })
    await hook('page.properties_updated', { id: P1, type: 'page' }, { updated_properties: ['title', 'status'] }, 'u-maya')
    await backend.syncTick()
    const now = (await team.readThread({ id: root })).message
    expect(now.text.split('\n')[0]).toBe('Stacks show a count')
    expect(now.labels.state).toBe('in-progress')
    api.comments.delete(C1.replace(/-/g, ''))
    await hook('comment.deleted', { id: C1, type: 'comment' }, { page_id: P1 }, 'u-maya')
    await backend.syncTick()
    expect(await replies()).toEqual([])
  })

  it("a page whose text can't be read now keeps what the board has, and is read again later", async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { hook, page, threads, backend, api } = setup()
    page(P1)
    await hook('page.created', { id: P1, type: 'page' })
    await backend.syncTick()
    Object.assign(api.pages.get(P1.replace(/-/g, ''))!, { markdown: 'Now with a second paragraph.' })
    const realFetch = api.fetcher
    let down = true
    // The stand-in answers 500 for the page's text while it is down.
    api.markdownDown = () => down
    await hook('page.content_updated', { id: P1, type: 'page' })
    await backend.syncTick()
    expect((await threads())[0]!.message.text).toBe('Stacks should show a count\n\nEach stack row shows how many are in it.')
    down = false
    await backend.syncTick()
    expect((await threads())[0]!.message.text).toBe('Stacks should show a count\n\nNow with a second paragraph.')
    void realFetch
  })

  it("a reply on the board goes to Notion as a comment on the page, and Notion's echo of it isn't brought back", async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const { hook, page, threads, backend, team, api } = setup()
    page(P1)
    await hook('page.created', { id: P1, type: 'page' })
    await backend.syncTick()
    const root = (await threads())[0]!.message.id
    await team.reply({ to: root, text: 'On it: card #12.' })
    await backend.syncTick()
    const posted = api.asked.find((each) => each.method === 'POST' && each.path === '/comments')!
    expect(posted.body).toEqual({ parent: { page_id: P1.replace(/-/g, '') }, rich_text: [{ text: { content: 'On it: card #12.' } }] })
    const [made] = [...api.comments.values()]
    await hook('comment.created', { id: made!.id, type: 'comment' }, { page_id: P1 }, BOT)
    await backend.syncTick()
    expect((await team.readThread({ id: root })).replies.map((reply) => reply.text)).toEqual(['On it: card #12.'])
  })

  it('what changed on Notion while the board was down arrives when it starts again, once', async () => {
    process.env.MUSTER_CONFIG = tempDir()
    const dir = tempDir()
    const first = setup({ dir })
    first.page(P1)
    await first.hook('page.created', { id: P1, type: 'page' })
    await first.backend.syncTick()
    first.backend.close()
    first.time.advance(3_600_000)
    const later = first.time.now().toISOString()
    Object.assign(first.api.pages.get(P1.replace(/-/g, ''))!, { status: 'Done', edited: later, editedBy: 'u-maya' })
    first.page('dddd0000-0000-4000-8000-000000000004', { title: 'Made while the board was down', markdown: 'Arrives whole.', edited: later, by: 'u-maya' })
    first.api.comments.set('c2', { id: 'cccc2222-0000-4000-8000-000000000002', page: P1, text: 'said while you were down', by: 'u-maya', created: later, edited: later })
    const backend = first.open()
    await backend.syncTick()
    await backend.syncTick()
    const team = board({ backend })
    const threads = (await team.readChannel({ channel: 'cards/notion' })).threads
    expect(threads.map((thread) => thread.message.text.split('\n')[0]).sort()).toEqual(['Made while the board was down', 'Stacks should show a count'])
    const old = threads.find((thread) => thread.message.text.startsWith('Stacks'))!
    expect((await team.readThread({ id: old.message.id })).replies.map((reply) => reply.text)).toEqual(['said while you were down'])
    // Its Status moved while the board was down: the thread says so now.
    expect(old.message.labels.state).toBe('done')
    // Started again with nothing new: the same answer brings in nothing twice.
    await backend.syncTick()
    expect((await team.readChannel({ channel: 'cards/notion' })).threads).toHaveLength(2)
    expect((await team.readThread({ id: old.message.id })).replies).toHaveLength(1)
    void existsSync
  })
})
