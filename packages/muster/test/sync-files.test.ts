import { createHmac } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { board, file, github, linear, slack } from '../src/index.ts'
import { clock, tempDir } from './helpers.ts'

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const SECRET = 'whsec'
const SLACK_TOKEN = 'xoxb-slack-credential-1234'
const LINEAR_TOKEN = 'lin_api_linear-credential-5678'
const TRACE = Buffer.from('{"trace":[1,2,3]}')
const MB = 1024 * 1024

type Call = { url: string; method: string; auth: string | null; headers: Headers; body: unknown }

/** A board on disk, synced with Slack, Linear and GitHub, whose platforms are a fetcher that answers like them. */
function setup(answers: Record<string, (call: Call) => Response | undefined> = {}, filter?: (text: string) => string | null) {
  const time = clock()
  const dir = tempDir()
  const calls: Call[] = []
  let made = 100
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const raw = init?.body
    const body = typeof raw === 'string' ? (raw.startsWith('{') ? JSON.parse(raw) : raw) : raw instanceof Uint8Array ? Buffer.from(raw) : raw
    const call = { url, method: init?.method ?? 'GET', auth: headers.get('authorization'), headers, body }
    calls.push(call)
    made += 1
    for (const [prefix, answer] of Object.entries(answers)) if (url.startsWith(prefix)) {
      const given = answer(call)
      if (given) return given
    }
    // Slack's file host hands a file to its bot token, and its sign-in page to anyone else.
    if (url.startsWith('https://files.slack.com/files-pri/')) return call.auth === `Bearer ${SLACK_TOKEN}` ? new Response(TRACE, { headers: { 'content-type': 'application/json' } }) : new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })
    if (url.startsWith('https://files.slack.com/upload/')) return new Response(`OK - ${(body as Buffer).length}`)
    if (url === 'https://slack.com/api/files.getUploadURLExternal') return Response.json({ ok: true, upload_url: `https://files.slack.com/upload/v1/u${made}`, file_id: `FUP${made}` })
    if (url === 'https://slack.com/api/files.completeUploadExternal') return Response.json({ ok: true, files: [] })
    if (url.startsWith('https://slack.com/api/')) return Response.json({ ok: true, ts: `1700000000.${made}` })
    if (url.startsWith('https://uploads.linear.app/')) return call.auth === LINEAR_TOKEN ? new Response(TRACE, { headers: { 'content-type': 'image/png' } }) : new Response('no', { status: 401 })
    if (url.startsWith('https://storage.googleapis.com/')) return new Response('', { status: 200 })
    if (url === 'https://api.linear.app/graphql') {
      const query = String((body as { query: string }).query)
      if (query.includes('fileUpload')) return Response.json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.googleapis.com/linear-uploads/u${made}?X-Goog-Signature=abc`, assetUrl: `https://uploads.linear.app/org/u${made}`, headers: [{ key: 'x-goog-meta-x', value: '1' }] } } } })
      return Response.json({ data: { commentCreate: { success: true, comment: { id: 'lc-board' } } } })
    }
    if (url.startsWith('https://api.github.com/')) return Response.json({ id: made, number: made }, { status: 201 })
    return new Response('a host the board should never reach', { status: 200 })
  }) as typeof fetch
  const sync = {
    chat: { ...slack({ secret: SECRET, token: SLACK_TOKEN, bot: 'B0BOT', channels: { C123: 'general' }, now: () => time.now().getTime() }), ...(filter ? { filter } : {}) },
    lin: linear({ secret: SECRET, token: LINEAR_TOKEN, teams: { ENG: 'eng' } }),
    gh: github({ secret: SECRET, token: 'ghs_github-credential', bot: 'muster[bot]', repos: { 'acme/web': { issues: 'web/issues', mirror: true } } }),
  }
  const backend = file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
  const team = board({ backend })
  const chat = (event: Record<string, unknown>, id: string) => {
    const body = JSON.stringify({ type: 'event_callback', event_id: id, event: { type: 'message', channel: 'C123', ...event } })
    const stamp = String(Math.floor(time.now().getTime() / 1000))
    return backend.syncReceive('chat', { headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${sign(SECRET, `v0:${stamp}:${body}`)}` }, body })
  }
  const lin = (payload: unknown) => {
    const body = JSON.stringify(payload)
    return backend.syncReceive('lin', { headers: { 'linear-signature': sign(SECRET, body) }, body })
  }
  /** Every byte the board keeps: its database, its log beside it, and its files. */
  const stored = () => {
    const parts: Buffer[] = []
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.files')) for (const one of readdirSync(join(dir, name))) parts.push(readFileSync(join(dir, name, one)))
      else parts.push(readFileSync(join(dir, name)))
    }
    return Buffer.concat(parts).toString('latin1')
  }
  return { team, backend, calls, chat, lin, stored }
}

const slackFile = (over: Record<string, unknown> = {}) => ({ id: 'F1', name: 'trace.json', mimetype: 'application/json', size: TRACE.length, url_private: 'https://files.slack.com/files-pri/T1-F1/trace.json', ...over })

describe('sync: files from Slack', () => {
  it("answers the webhook at once, fetches the file on the ticker with the bot token from Slack's file host, and the message carries it", async () => {
    const { team, backend, calls, chat } = setup()
    expect(await chat({ subtype: 'file_share', user: 'U1', text: 'the trace', ts: '1.1', files: [slackFile()] }, 'Ev1')).toEqual({ status: 200, body: 'ok' })
    // Not imported while its file isn't fetched: nothing was fetched before the answer.
    expect((await team.readChannel({ channel: 'general' })).threads).toHaveLength(0)
    expect(calls).toHaveLength(0)
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    expect(thread!.message).toMatchObject({ text: 'the trace', attachments: [{ name: 'trace.json', type: 'application/json', size: TRACE.length }] })
    const got = await team.fileGet({ message: thread!.message.id, id: thread!.message.attachments[0]!.id })
    expect(Buffer.from(got.data, 'base64')).toEqual(TRACE)
    expect(calls.map((call) => [call.url, call.auth])).toEqual([['https://files.slack.com/files-pri/T1-F1/trace.json', `Bearer ${SLACK_TOKEN}`]])
  })

  it('a reply in the thread waits for the file before it, so the thread keeps its order', async () => {
    const { team, backend, chat } = setup()
    await chat({ subtype: 'file_share', user: 'U1', text: 'the trace', ts: '1.1', files: [slackFile()] }, 'Ev1')
    await chat({ user: 'U2', text: 'thanks', ts: '1.2', thread_ts: '1.1' }, 'Ev2')
    expect((await team.readChannel({ channel: 'general' })).threads).toHaveLength(0)
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    expect(thread!.message.attachments).toHaveLength(1)
    expect((await team.readThread({ id: thread!.message.id })).replies.map((reply) => reply.text)).toEqual(['thanks'])
  })

  it('never fetches from a host that is not Slack, never follows a redirect, and says so in the message', async () => {
    const { team, backend, calls, chat } = setup({ 'https://files.slack.com/files-pri/T1-F3/': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }) })
    await chat({
      subtype: 'file_share', user: 'U1', text: 'three files', ts: '1.1',
      files: [
        slackFile({ id: 'F2', name: 'a.txt', url_private: 'https://evil.example/a.txt' }),
        slackFile({ id: 'F3', name: 'b.txt', url_private: 'https://files.slack.com/files-pri/T1-F3/b.txt' }),
        slackFile({ id: 'F4', name: 'c.txt', url_private: 'https://files.slack.com.evil.example/c.txt' }),
        slackFile({ id: 'F5', name: 'doc', mode: 'external', is_external: true, url_private: 'https://docs.example/doc' }),
      ],
    }, 'Ev1')
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    expect(thread!.message.attachments).toEqual([])
    expect(thread!.message.text).toBe(['three files', '', '[file not imported: a.txt: not on files.slack.com]', '[file not imported: b.txt: the platform sent it somewhere else]', '[file not imported: c.txt: not on files.slack.com]', '[file not imported: doc: a link to somewhere outside Slack]'].join('\n'))
    // The only request was to Slack's own host, and no credential went anywhere else.
    expect(calls.map((call) => call.url)).toEqual(['https://files.slack.com/files-pri/T1-F3/b.txt'])
  })

  it('a file over 25 MB is named, not fetched, and so is the eleventh file on one message', async () => {
    const { team, backend, calls, chat } = setup()
    const many = Array.from({ length: 11 }, (_, index) => slackFile({ id: `F${index}`, name: `f${index}.json` }))
    await chat({ subtype: 'file_share', user: 'U1', text: 'big', ts: '1.1', files: [slackFile({ name: 'core.dump', size: 26 * MB })] }, 'Ev1')
    await chat({ subtype: 'file_share', user: 'U1', text: 'many', ts: '1.2', files: many }, 'Ev2')
    await backend.syncTick()
    const threads = (await team.readChannel({ channel: 'general' })).threads.map((thread) => thread.message)
    const big = threads.find((message) => message.text.startsWith('big'))!
    expect(big).toMatchObject({ text: 'big\n\n[file not imported: core.dump: 26.0 MB, over 25 MB]', attachments: [] })
    const lots = threads.find((message) => message.text.startsWith('many'))!
    // Ten files with the same bytes are one stored file, carried ten times.
    expect(lots.attachments).toHaveLength(10)
    expect(lots.text).toBe('many\n\n[file not imported: f10.json: a message carries at most 10 files]')
    expect(calls).toHaveLength(10)
  })

  it('without files:read Slack sends its sign-in page: refused, and the message says why', async () => {
    const { team, backend, chat } = setup({ 'https://files.slack.com/files-pri/': () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }) })
    await chat({ subtype: 'file_share', user: 'U1', text: '', ts: '1.1', files: [slackFile({ size: undefined })] }, 'Ev1')
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    expect(thread!.message).toMatchObject({ text: '[file not imported: trace.json: Slack sent a page, not the file: does the app have files:read?]', attachments: [] })
  })

  it('a platform that fails is tried on later ticks, then the message comes without the file and says so', async () => {
    let failing = 3
    const { team, backend, chat } = setup({ 'https://files.slack.com/files-pri/T1-F1/': () => (failing-- > 0 ? new Response('busy', { status: 503 }) : undefined) })
    await chat({ subtype: 'file_share', user: 'U1', text: 'retried', ts: '1.1', files: [slackFile()] }, 'Ev1')
    for (let tick = 0; tick < 3; tick++) await backend.syncTick()
    expect((await team.readChannel({ channel: 'general' })).threads).toHaveLength(0)
    await backend.syncTick()
    expect((await team.readChannel({ channel: 'general' })).threads[0]!.message.attachments).toHaveLength(1)

    const down = setup({ 'https://files.slack.com/files-pri/': () => new Response('down', { status: 500 }) })
    await down.chat({ subtype: 'file_share', user: 'U1', text: 'lost', ts: '1.1', files: [slackFile()] }, 'Ev1')
    for (let tick = 0; tick < 5; tick++) await down.backend.syncTick()
    expect((await down.team.readChannel({ channel: 'general' })).threads[0]!.message).toMatchObject({ text: 'lost\n\n[file not imported: trace.json: the platform did not hand it over]', attachments: [] })
  })

  it('a file in a channel that is not mapped is never fetched', async () => {
    const { backend, calls, chat } = setup()
    await chat({ channel: 'C999', subtype: 'file_share', user: 'U1', text: 'elsewhere', ts: '1.1', files: [slackFile()] }, 'Ev1')
    await backend.syncTick()
    expect(calls).toHaveLength(0)
  })

  it("the operator's filter: a message it drops fetches nothing; one it changes keeps no file and says so; the lines about files go through it", async () => {
    const filter = (text: string) => (text.includes('DROP') ? null : text.replace('secret', '[gone]').replace('core.dump', 'a-dump'))
    const { team, backend, calls, chat } = setup({}, filter)
    await chat({ subtype: 'file_share', user: 'U1', text: 'DROP this', ts: '1.1', files: [slackFile()] }, 'Ev1')
    await chat({ subtype: 'file_share', user: 'U1', text: 'a secret trace', ts: '1.2', files: [slackFile()] }, 'Ev2')
    await chat({ subtype: 'file_share', user: 'U1', text: 'big', ts: '1.3', files: [slackFile({ name: 'core.dump', size: 26 * MB })] }, 'Ev3')
    await backend.syncTick()
    expect(calls).toHaveLength(0)
    const messages = (await team.readChannel({ channel: 'general' })).threads.map((thread) => thread.message)
    expect(messages.map((message) => [message.text, message.attachments.length]).sort()).toEqual([
      ['a [gone] trace\n\n[files not imported: the filter changed this message]', 0],
      ['big\n\n[file not imported: a-dump: 26.0 MB, over 25 MB]', 0],
    ])
  })

  it('a filter that passes the text as it is, even with a newline added, keeps the files', async () => {
    const { team, backend, chat } = setup({}, (text) => `${text}\n`)
    await chat({ subtype: 'file_share', user: 'U1', text: 'the trace', ts: '1.1', files: [slackFile()] }, 'Ev1')
    await backend.syncTick()
    expect((await team.readChannel({ channel: 'general' })).threads[0]!.message.attachments).toHaveLength(1)
  })

  it('the same message sent again, under a new event ID, fetches nothing', async () => {
    const { team, backend, calls, chat } = setup()
    const message = { subtype: 'file_share', user: 'U1', text: 'once', ts: '1.1', files: [slackFile()] }
    await chat(message, 'Ev1')
    await backend.syncTick()
    await chat(message, 'Ev1')
    await chat(message, 'Ev1-again')
    await backend.syncTick()
    expect(calls).toHaveLength(1)
    expect((await team.readChannel({ channel: 'general' })).threads).toHaveLength(1)
  })
})

describe('sync: files to Slack', () => {
  it('uploads a board file to Slack, shares it into the thread after the text, and its copy coming back is not imported', async () => {
    const { team, backend, calls, chat } = setup()
    await chat({ user: 'U1', text: 'send me the trace', ts: '1.1' }, 'Ev1')
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    const stored = await team.filePut({ name: 'trace.json', type: 'application/json', data: TRACE.toString('base64') })
    await team.reply({ to: thread!.message.id, text: 'here', attachments: [stored] })
    await backend.syncTick()
    const sent = calls.filter((call) => call.url.includes('slack.com'))
    expect(sent.map((call) => call.url.replace(/u\d+$/, 'u'))).toEqual(['https://slack.com/api/files.getUploadURLExternal', 'https://files.slack.com/upload/v1/u', 'https://slack.com/api/chat.postMessage', 'https://slack.com/api/files.completeUploadExternal'])
    expect(sent[1]).toMatchObject({ method: 'POST', auth: null, body: TRACE })
    expect(sent[2]!.body).toEqual({ channel: 'C123', thread_ts: '1.1', text: 'here' })
    expect(new URLSearchParams(String(sent[0]!.body)).get('length')).toBe(String(TRACE.length))
    const fileId = String(sent[1]!.url).replace(/.*\/u/, 'FUP')
    expect(sent[3]!.body).toEqual({ files: [{ id: fileId, title: 'trace.json' }], channel_id: 'C123', thread_ts: '1.1' })
    // Slack's share of the file, as if it came with no bot ID to know it by: the board knows it by the file's ID.
    await chat({ subtype: 'file_share', user: 'UBOTUSER', text: '', ts: '1.9', thread_ts: '1.1', files: [slackFile({ id: fileId })] }, 'Ev2')
    await backend.syncTick()
    expect((await team.readThread({ id: thread!.message.id })).replies.map((reply) => reply.text)).toEqual(['here'])
    expect(calls.filter((call) => call.url.startsWith('https://files.slack.com/files-pri/'))).toHaveLength(0)
    // Someone sharing that file again with words of their own is imported like anyone.
    await chat({ subtype: 'file_share', user: 'U2', text: 'is this the one?', ts: '1.10', thread_ts: '1.1', files: [slackFile({ id: fileId })] }, 'Ev3')
    await backend.syncTick()
    const replies = (await team.readThread({ id: thread!.message.id })).replies
    expect(replies.map((reply) => [reply.text, reply.attachments.length])).toEqual([['here', 1], ['is this the one?', 1]])
  })

  it('when Slack takes the bytes but will not share them, the posted text is changed to say so, and nothing is posted twice', async () => {
    const { team, backend, calls, chat } = setup({ 'https://slack.com/api/files.completeUploadExternal': () => Response.json({ ok: false, error: 'not_in_channel' }) })
    await chat({ user: 'U1', text: 'go', ts: '1.1' }, 'Ev1')
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    const stored = await team.filePut({ name: 'trace.json', data: TRACE.toString('base64') })
    await team.reply({ to: thread!.message.id, text: 'here', attachments: [stored] })
    await backend.syncTick()
    await backend.syncTick()
    expect(calls.filter((call) => call.url.endsWith('chat.postMessage'))).toHaveLength(1)
    const update = calls.find((call) => call.url.endsWith('chat.update'))!
    expect(update.body).toMatchObject({ channel: 'C123', text: 'here\n\n[file not sent: trace.json: Slack did not take it]' })
  })

  it('a file Slack will not take is named in the text, and the text still goes once', async () => {
    const { team, backend, calls, chat } = setup({ 'https://slack.com/api/files.getUploadURLExternal': () => Response.json({ ok: true, upload_url: 'https://evil.example/upload', file_id: 'FX' }) })
    await chat({ user: 'U1', text: 'go', ts: '1.1' }, 'Ev1')
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    const stored = await team.filePut({ name: 'trace.json', data: TRACE.toString('base64') })
    await team.reply({ to: thread!.message.id, text: 'here', attachments: [stored] })
    await backend.syncTick()
    await backend.syncTick()
    expect(calls.some((call) => call.url.startsWith('https://evil.example'))).toBe(false)
    expect(calls.filter((call) => call.url.endsWith('chat.postMessage')).map((call) => (call.body as { text: string }).text)).toEqual(['here\n\n[file not sent: trace.json: Slack did not take it]'])
  })
})

describe('sync: files with Linear', () => {
  const issue = { type: 'Issue', action: 'create', data: { id: 'iss-1', identifier: 'ENG-1', title: 'Crash', description: 'see ![shot.png](https://uploads.linear.app/org/a/b) and [notes](https://example.com/notes)', team: { key: 'ENG' }, creatorId: 'u1' } }

  it("fetches a file uploaded to Linear with the key, sent only to Linear's upload host; any other link stays text", async () => {
    const { team, backend, calls, lin } = setup()
    await lin(issue)
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'eng' })).threads
    expect(thread!.message).toMatchObject({ text: `Crash\n\n${issue.data.description}`, attachments: [{ name: 'shot.png', type: 'image/png', size: TRACE.length }] })
    expect(calls.map((call) => [call.url, call.auth])).toEqual([['https://uploads.linear.app/org/a/b', LINEAR_TOKEN]])
  })

  it('a file over 25 MB with no size given is cut off as it is read', async () => {
    const { team, backend, lin } = setup({ 'https://uploads.linear.app/': () => new Response(new Uint8Array(25 * MB + 1)) })
    await lin(issue)
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'eng' })).threads
    expect(thread!.message.attachments).toEqual([])
    expect(thread!.message.text.split('\n').pop()).toBe('[file not imported: shot.png: over 25 MB]')
  })

  it("uploads a board file to Linear's storage without the key, and links it from the comment; the comment's echo is not fetched", async () => {
    const { team, backend, calls, lin, stored } = setup()
    await lin({ ...issue, data: { ...issue.data, description: 'no files' } })
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'eng' })).threads
    const shot = await team.filePut({ name: 'shot.png', type: 'image/png', data: TRACE.toString('base64') })
    const log = await team.filePut({ name: 'run.log', type: 'text/plain', data: Buffer.from('log').toString('base64') })
    await team.reply({ to: thread!.message.id, text: 'two files', attachments: [shot, log] })
    await backend.syncTick()
    const puts = calls.filter((call) => call.method === 'PUT')
    expect(puts.map((call) => [call.auth, call.headers.get('x-goog-meta-x'), call.headers.get('content-type')])).toEqual([[null, '1', 'image/png'], [null, '1', 'text/plain']])
    const comment = calls.find((call) => String((call.body as { query?: string }).query).includes('commentCreate'))!
    const body = (comment.body as { variables: { input: { body: string } } }).variables.input.body
    expect(body).toMatch(/^two files\n\n!\[shot\.png\]\(https:\/\/uploads\.linear\.app\/org\/u\d+\)\n\[run\.log\]\(https:\/\/uploads\.linear\.app\/org\/u\d+\)$/)
    // Linear sends the board's own comment back, links and all: it is the board's, so nothing is fetched or imported.
    const before = calls.length
    await lin({ type: 'Comment', action: 'create', data: { id: 'lc-board', issueId: 'iss-1', body, team: { key: 'ENG' }, userId: 'u-me' } })
    await backend.syncTick()
    expect(calls.length).toBe(before)
    expect((await team.readThread({ id: thread!.message.id })).replies.map((reply) => reply.text)).toEqual(['two files'])
    // Neither token is anywhere the board keeps what it was sent.
    expect(stored()).not.toContain(LINEAR_TOKEN)
    expect(stored()).not.toContain(SLACK_TOKEN)
  })
})

describe('sync: files to GitHub', () => {
  it('has no upload API: a board file is named in the comment, and stays on the board', async () => {
    const { team, backend, calls } = setup()
    await backend.syncTick()
    const stored = await team.filePut({ name: 'fix.patch', data: Buffer.from('x'.repeat(2048)).toString('base64') })
    await team.post({ channel: 'web/issues', text: 'Login breaks\nsee the patch', attachments: [stored] })
    await backend.syncTick()
    const opened = calls.find((call) => call.url === 'https://api.github.com/repos/acme/web/issues')!
    expect(opened.body).toEqual({ title: 'Login breaks', body: 'see the patch\n\n[file not sent: fix.patch (2 KB): GitHub takes no uploads, it is on the board]' })
  })
})

describe('sync: files and credentials', () => {
  it('no platform credential is stored anywhere on the board, in events, inbox, links or files', async () => {
    const { team, backend, chat, lin, stored } = setup()
    await chat({ subtype: 'file_share', user: 'U1', text: 'in', ts: '1.1', files: [slackFile()] }, 'Ev1')
    await lin({ type: 'Issue', action: 'create', data: { id: 'iss-1', identifier: 'ENG-1', title: 'T', description: '![s](https://uploads.linear.app/o/a)', team: { key: 'ENG' } } })
    await backend.syncTick()
    const [thread] = (await team.readChannel({ channel: 'general' })).threads
    const out = await team.filePut({ name: 'out.json', data: TRACE.toString('base64') })
    await team.reply({ to: thread!.message.id, text: 'out', attachments: [out] })
    await backend.syncTick()
    expect((await team.readChannel({ channel: 'eng' })).threads[0]!.message.attachments).toHaveLength(1)
    const everything = stored()
    for (const token of [SLACK_TOKEN, LINEAR_TOKEN, 'ghs_github-credential']) expect(everything).not.toContain(token)
  })
})
