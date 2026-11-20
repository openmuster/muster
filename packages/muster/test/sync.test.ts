import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { board, file, github, linear, loadSync, slack } from '../src/index.ts'
import { cli, cliStart, clock, tempDir } from './helpers.ts'

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const SECRET = 'whsec'

function setup(options: { mirror?: boolean; fail?: () => boolean } = {}) {
  const time = clock()
  const sent: { url: string; body: any; auth: string | null }[] = []
  let made = 9000
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (options.fail?.()) return new Response('{"message":"nope"}', { status: 502 })
    sent.push({ url: String(url), body, auth: new Headers(init?.headers).get('authorization') })
    made += 1
    if (String(url).includes('slack')) return Response.json({ ok: true, ts: `1700000000.${made}` })
    if (String(url).includes('linear')) return Response.json({ data: { commentCreate: { success: true, comment: { id: `lc-${made}` } } } })
    return Response.json({ id: made }, { status: 201 })
  }) as typeof fetch
  const sync = {
    gh: github({ secret: SECRET, token: 'ghs_token', bot: 'muster[bot]', repos: { 'acme/web': { issues: 'web/issues', pulls: 'web/prs', mirror: options.mirror === true }, 'acme/api': 'api' } }),
    lin: linear({ secret: SECRET, token: 'lin_token', bot: 'bot-user', teams: { ENG: 'eng' } }),
    chat: slack({ secret: SECRET, token: 'xoxb', bot: 'B0BOT', channels: { C123: 'general' }, now: () => time.now().getTime() }),
  }
  const backend = file({ memory: true, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
  const team = board({ backend })
  let delivery = 0
  const gh = (event: string, payload: unknown, opts: { secret?: string; id?: string } = {}) => {
    const body = JSON.stringify(payload)
    return backend.syncReceive('gh', { headers: { 'x-github-event': event, 'x-github-delivery': opts.id ?? `d-${++delivery}`, 'x-hub-signature-256': `sha256=${sign(opts.secret ?? SECRET, body)}` }, body })
  }
  const lin = (payload: unknown) => {
    const body = JSON.stringify(payload)
    return backend.syncReceive('lin', { headers: { 'linear-delivery': `l-${++delivery}`, 'linear-signature': sign(SECRET, body) }, body })
  }
  const chat = (payload: unknown, stampOffset = 0) => {
    const body = JSON.stringify(payload)
    const stamp = String(Math.floor(time.now().getTime() / 1000) + stampOffset)
    return backend.syncReceive('chat', { headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': `v0=${sign(SECRET, `v0:${stamp}:${body}`)}` }, body })
  }
  return { team, backend, time, sent, gh, lin, chat }
}

const repo = { full_name: 'acme/web' }
const issue = (number: number, title = 'Login redirects to evil.example', body = 'Steps: ...') => ({ number, title, body })
const texts = async (team: ReturnType<typeof setup>['team'], channel: string) => (await team.readChannel({ channel })).threads.map((thread) => thread.message.text)

describe('sync: GitHub', () => {
  it('an issue becomes a thread in its mapped channel, written by its GitHub author, and its comments become replies', async () => {
    const { team, gh } = setup()
    expect(await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })).toEqual({ status: 200, body: 'ok' })
    await gh('issue_comment', { action: 'created', issue: issue(7), comment: { id: 501, body: 'I can reproduce this' }, repository: repo, sender: { login: 'maya' } })
    const page = await team.readChannel({ channel: 'web/issues' })
    expect(page.threads).toHaveLength(1)
    const root = page.threads[0]!.message
    expect(root).toMatchObject({ text: 'Login redirects to evil.example\n\nSteps: ...', by: { principal: 'gh:user:nico', profile: null }, labels: { kind: 'issue', state: 'open', ref: 'acme/web#7', source: 'gh' } })
    const thread = await team.readThread({ id: root.id })
    expect(thread.replies.map((reply) => [reply.text, reply.by.principal])).toEqual([['I can reproduce this', 'gh:user:maya']])
  })

  it('pull requests go to their own channel, and reviews, CI runs and closing arrive as labels', async () => {
    const { team, gh } = setup()
    const pull = { number: 12, title: 'Fix the redirect', body: '' }
    await gh('pull_request', { action: 'opened', pull_request: pull, repository: repo, sender: { login: 'nico' } })
    await gh('pull_request_review', { action: 'submitted', pull_request: pull, review: { id: 9, state: 'CHANGES_REQUESTED', body: 'needs a test' }, repository: repo, sender: { login: 'maya' } })
    await gh('workflow_run', { action: 'completed', workflow_run: { name: 'CI / Unit Tests', conclusion: 'failure', pull_requests: [{ number: 12 }] }, repository: repo, sender: { login: 'github-actions' } })
    await gh('pull_request', { action: 'closed', pull_request: { ...pull, merged: true }, repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/prs' })).threads[0]!.message
    expect(root.labels).toMatchObject({ kind: 'pr', state: 'merged', review: 'changes_requested', 'ci.ci-unit-tests': 'failure' })
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['needs a test'])
    expect(await texts(team, 'web/issues')).toEqual([])
  })

  it('refuses a webhook with a wrong or missing signature, and stores nothing', async () => {
    const { team, gh, backend } = setup()
    expect((await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'eve' } }, { secret: 'guess' })).status).toBe(401)
    expect((await backend.syncReceive('gh', { headers: { 'x-github-event': 'issues' }, body: '{}' })).status).toBe(401)
    expect((await backend.syncReceive('nope', { headers: {}, body: '{}' })).status).toBe(404)
    expect((await team.channels()).channels).toEqual([])
  })

  it('a webhook delivered twice is imported once', async () => {
    const { team, gh } = setup()
    const payload = { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } }
    await gh('issues', payload, { id: 'same-delivery' })
    await gh('issues', payload, { id: 'same-delivery' })
    await gh('issues', payload, { id: 'redelivered-under-a-new-id' })
    expect(await texts(team, 'web/issues')).toHaveLength(1)
  })

  it('a repo that is not mapped is ignored, and so is an event the board does not read', async () => {
    const { team, gh } = setup()
    expect((await gh('issues', { action: 'opened', issue: issue(1), repository: { full_name: 'other/repo' }, sender: { login: 'x' } })).status).toBe(200)
    expect((await gh('star', { action: 'created', repository: repo, sender: { login: 'x' } })).status).toBe(200)
    expect((await team.channels()).channels).toEqual([])
  })

  it('by default nothing goes back to GitHub: a reply on the board stays on the board', async () => {
    const { team, gh, backend, sent } = setup()
    await backend.syncTick()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    await team.as('fixer').reply({ to: root.id, text: 'looking into it' })
    expect(await backend.syncTick()).toMatchObject({ delivered: 0 })
    expect(sent).toEqual([])
  })

  it('with mirror on, a board reply is posted as a comment once, and the comment coming back is not imported again', async () => {
    const { team, gh, backend, sent } = setup({ mirror: true })
    await backend.syncTick()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    await team.as('fixer').reply({ to: root.id, text: 'fixed in #12' })
    await team.as('fixer').reply({ to: root.id, text: 'internal note', noSync: true })
    expect(await backend.syncTick()).toMatchObject({ delivered: 1 })
    expect(await backend.syncTick()).toMatchObject({ delivered: 0 })
    expect(sent).toEqual([{ url: 'https://api.github.com/repos/acme/web/issues/7/comments', body: { body: 'fixed in #12' }, auth: 'Bearer ghs_token' }])
    await gh('issue_comment', { action: 'created', issue: issue(7), comment: { id: 9001, body: 'fixed in #12' }, repository: repo, sender: { login: 'muster[bot]' } })
    await gh('issue_comment', { action: 'created', issue: issue(7), comment: { id: 9001, body: 'fixed in #12' }, repository: repo, sender: { login: 'some-other-login' } })
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['fixed in #12', 'internal note'])
  })

  it('a delivery that fails is tried again, and after five tries the failure is on the thread and the next message goes', async () => {
    let failing = true
    const { team, gh, backend, sent } = setup({ mirror: true, fail: () => failing })
    await backend.syncTick()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    await team.reply({ to: root.id, text: 'first' })
    await team.reply({ to: root.id, text: 'second' })
    for (let i = 0; i < 4; i++) expect(await backend.syncTick()).toMatchObject({ delivered: 0, failed: 1 })
    expect(sent).toEqual([])
    await backend.syncTick()
    failing = false
    await backend.syncTick()
    expect(sent.map((call) => call.body.body)).toEqual(['second'])
    const failed = (await team.events({ after: 0, filter: { types: ['sync.failed'] } })).events
    expect(failed.map((event) => [event.thread, event.data.key, event.data.error])).toEqual([[root.id, 'gh', 'platform_502']])
  })

  it('labels a platform sets never leave the board, and board labels never go to the platform', async () => {
    const { team, gh, backend, sent } = setup({ mirror: true })
    await backend.syncTick()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    await team.label({ id: root.id, set: { owner: 'fixer' } })
    await team.react({ id: root.id, emoji: 'eyes' })
    await backend.syncTick()
    expect(sent).toEqual([])
  })
})

describe('sync: threads started on the board', () => {
  it('with mirror on, a thread posted in a mapped channel opens an issue, replies follow it there, and the issue coming back is not imported twice', async () => {
    const { team, gh, backend, sent } = setup({ mirror: true })
    await backend.syncTick()
    const root = await team.as('lead').post({ channel: 'web/issues', text: 'Login redirect is open\n\nSteps to reproduce: ...' })
    await team.post({ channel: 'web/prs', text: 'a thread where nothing mirrors issues' })
    await team.post({ channel: 'web/issues', text: 'kept local', noSync: true })
    expect(await backend.syncTick()).toMatchObject({ delivered: 1 })
    expect(sent).toEqual([{ url: 'https://api.github.com/repos/acme/web/issues', body: { title: 'Login redirect is open', body: 'Steps to reproduce: ...' }, auth: 'Bearer ghs_token' }])
    await gh('issues', { action: 'opened', issue: { number: undefined, title: 'x', body: '' }, repository: repo, sender: { login: 'muster[bot]' } })
    await team.reply({ to: root.id, text: 'fixed' })
    await backend.syncTick()
    expect(sent[1]!.url).toMatch(/\/repos\/acme\/web\/issues\/undefined\/comments$|\/issues\/\d+\/comments$/)
    expect(sent[1]!.body).toEqual({ body: 'fixed' })
    expect((await team.readChannel({ channel: 'web/issues' })).threads).toHaveLength(2)
  })

  it('a Slack-mapped channel posts a new thread to Slack and later replies into it; a Linear team gets an issue', async () => {
    const { team, backend, sent } = setup()
    await backend.syncTick()
    const hello = await team.post({ channel: 'general', text: 'deploy at 3pm' })
    await backend.syncTick()
    expect(sent[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', body: { channel: 'C123', text: 'deploy at 3pm' } })
    expect(sent[0]!.body.thread_ts).toBeUndefined()
    await team.reply({ to: hello.id, text: 'moved to 4pm' })
    await backend.syncTick()
    expect(sent[1]!.body).toMatchObject({ channel: 'C123', text: 'moved to 4pm', thread_ts: expect.stringMatching(/^1700000000\./) })
  })
})

describe('sync: Linear', () => {
  it('an issue becomes a thread, a comment a reply, a state change a label, and a board reply goes back as a comment', async () => {
    const { team, lin, backend, sent } = setup()
    await backend.syncTick()
    await lin({ type: 'Issue', action: 'create', data: { id: 'iss-1', identifier: 'ENG-42', title: 'CVE-2026-1', description: 'bump the parser', team: { key: 'ENG' }, creatorId: 'u-nico', state: { name: 'Todo' } } })
    await lin({ type: 'Comment', action: 'create', data: { id: 'c-1', body: 'which versions?', issueId: 'iss-1', userId: 'u-maya', issue: { team: { key: 'ENG' } } } })
    await lin({ type: 'Issue', action: 'update', data: { id: 'iss-1', team: { key: 'ENG' }, state: { name: 'In Progress' } } })
    const root = (await team.readChannel({ channel: 'eng' })).threads[0]!.message
    expect(root).toMatchObject({ text: 'CVE-2026-1\n\nbump the parser', by: { principal: 'lin:user:u-nico' }, labels: { ref: 'ENG-42', state: 'in-progress' } })
    await team.as('fixer').reply({ to: root.id, text: 'all 3.x' })
    expect(await backend.syncTick()).toMatchObject({ delivered: 1 })
    expect(sent[0]).toMatchObject({ url: 'https://api.linear.app/graphql', auth: 'lin_token', body: { variables: { input: { issueId: 'iss-1', body: 'all 3.x' } } } })
    await lin({ type: 'Comment', action: 'create', data: { id: 'lc-9001', body: 'all 3.x', issueId: 'iss-1', userId: 'bot-user', issue: { team: { key: 'ENG' } } } })
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['which versions?', 'all 3.x'])
  })

  it('refuses a wrong signature', async () => {
    const { backend } = setup()
    expect((await backend.syncReceive('lin', { headers: { 'linear-signature': 'deadbeef' }, body: '{}' })).status).toBe(401)
  })
})

describe('sync: Slack', () => {
  it('answers the URL check, imports a channel message as a thread and a threaded message as a reply, and replies back in the Slack thread', async () => {
    const { team, chat, backend, sent } = setup()
    await backend.syncTick()
    expect(await chat({ type: 'url_verification', challenge: 'abc123' })).toEqual({ status: 200, body: 'abc123' })
    await chat({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message', channel: 'C123', user: 'U1', text: 'deploy is red', ts: '1700000000.000100' } })
    await chat({ type: 'event_callback', event_id: 'Ev2', event: { type: 'message', channel: 'C123', user: 'U2', text: 'looking', ts: '1700000000.000200', thread_ts: '1700000000.000100' } })
    await chat({ type: 'event_callback', event_id: 'Ev3', event: { type: 'message', subtype: 'channel_join', channel: 'C123', user: 'U3', text: 'joined', ts: '1700000000.000300' } })
    await chat({ type: 'event_callback', event_id: 'Ev4', event: { type: 'message', channel: 'C999', user: 'U1', text: 'unmapped', ts: '1700000000.000400' } })
    const page = await team.readChannel({ channel: 'general' })
    expect(page.threads.map((thread) => [thread.message.text, thread.message.by.principal, thread.replies])).toEqual([['deploy is red', 'chat:user:U1', 1]])
    await team.as('fixer').reply({ to: page.threads[0]!.message.id, text: 'rolled back' })
    await backend.syncTick()
    expect(sent[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', auth: 'Bearer xoxb', body: { channel: 'C123', thread_ts: '1700000000.000100', text: 'rolled back' } })
    await chat({ type: 'event_callback', event_id: 'Ev5', event: { type: 'message', channel: 'C123', bot_id: 'B0BOT', text: 'rolled back', ts: '1700000000.9001', thread_ts: '1700000000.000100' } })
    expect((await team.readThread({ id: page.threads[0]!.message.id })).replies.map((reply) => reply.text)).toEqual(['looking', 'rolled back'])
  })

  it('refuses a wrong signature and a correctly signed request that is more than five minutes old', async () => {
    const { chat, backend } = setup()
    expect((await backend.syncReceive('chat', { headers: { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=00' }, body: '{}' })).status).toBe(401)
    expect((await chat({ type: 'event_callback', event_id: 'old', event: { type: 'message', channel: 'C123', user: 'U1', text: 'replayed', ts: '1' } }, -301)).status).toBe(401)
    expect((await chat({ type: 'event_callback', event_id: 'ok', event: { type: 'message', channel: 'C123', user: 'U1', text: 'fresh', ts: '2' } }, -10)).status).toBe(200)
  })
})

describe('sync: edits, deletes, filters and catching up', () => {
  it('a comment edited or deleted on GitHub is edited or deleted on the board, by its GitHub author', async () => {
    const { team, gh } = setup()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    await gh('issue_comment', { action: 'created', issue: issue(7), comment: { id: 501, body: 'first draft' }, repository: repo, sender: { login: 'maya' } })
    await gh('issue_comment', { action: 'created', issue: issue(7), comment: { id: 502, body: 'to be removed' }, repository: repo, sender: { login: 'maya' } })
    await gh('issue_comment', { action: 'edited', issue: issue(7), comment: { id: 501, body: 'final wording' }, repository: repo, sender: { login: 'maya' } })
    await gh('issue_comment', { action: 'deleted', issue: issue(7), comment: { id: 502, body: 'to be removed' }, repository: repo, sender: { login: 'maya' } })
    await gh('issues', { action: 'edited', issue: issue(7, 'Login redirect, retitled', 'new body'), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    expect(root).toMatchObject({ text: 'Login redirect, retitled\n\nnew body', revision: 2 })
    const replies = (await team.readThread({ id: root.id })).replies
    expect(replies.map((reply) => [reply.text, reply.revision])).toEqual([['final wording', 2]])
  })

  it('with mirror on, editing or deleting a delivered reply changes its copy on the platform, once', async () => {
    const { team, gh, backend, sent } = setup({ mirror: true })
    await backend.syncTick()
    await gh('issues', { action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    const reply = await team.reply({ to: root.id, text: 'fixd' })
    const local = await team.reply({ to: root.id, text: 'never left', noSync: true })
    await backend.syncTick()
    await team.edit({ id: reply.id, text: 'fixed' })
    await team.edit({ id: local.id, text: 'still local' })
    await backend.syncTick()
    expect(sent.at(-1)).toMatchObject({ url: 'https://api.github.com/repos/acme/web/issues/comments/9001', body: { body: 'fixed' } })
    const before = sent.length
    await team.remove({ id: reply.id })
    await backend.syncTick()
    await backend.syncTick()
    expect(sent).toHaveLength(before + 1)
    expect(sent.at(-1)!.url).toBe('https://api.github.com/repos/acme/web/issues/comments/9001')
  })

  it('Slack: a changed message is edited on the board and a deleted one removed; a board edit updates the Slack copy', async () => {
    const { team, chat, backend, sent } = setup()
    await backend.syncTick()
    await chat({ type: 'event_callback', event_id: 'E1', event: { type: 'message', channel: 'C123', user: 'U1', text: 'deploy at 3', ts: '10.1' } })
    await chat({ type: 'event_callback', event_id: 'E2', event: { type: 'message', channel: 'C123', user: 'U2', text: 'ok', ts: '10.2', thread_ts: '10.1' } })
    await chat({ type: 'event_callback', event_id: 'E3', event: { type: 'message', subtype: 'message_changed', channel: 'C123', ts: '10.3', message: { user: 'U1', text: 'deploy at 4', ts: '10.1' } } })
    await chat({ type: 'event_callback', event_id: 'E4', event: { type: 'message', subtype: 'message_deleted', channel: 'C123', ts: '10.4', deleted_ts: '10.2', previous_message: { user: 'U2', ts: '10.2', thread_ts: '10.1' } } })
    const thread = (await team.readChannel({ channel: 'general' })).threads[0]!
    expect([thread.message.text, thread.replies]).toEqual(['deploy at 4', 0])
    const mine = await team.reply({ to: thread.message.id, text: 'rolling bck' })
    await backend.syncTick()
    await team.edit({ id: mine.id, text: 'rolling back' })
    await backend.syncTick()
    expect(sent.at(-1)).toMatchObject({ url: 'https://slack.com/api/chat.update', body: { channel: 'C123', text: 'rolling back' } })
  })

  it("the operator's filter sees text on its way in: it can rewrite it, or drop the event", async () => {
    const { backend, team } = (() => {
      const made = setup()
      return made
    })()
    void backend
    void team
    const dir = tempDir()
    const path = join(dir, 'sync.json')
    writeFileSync(join(dir, 'scrub.sh'), '#!/bin/sh\ntext=$(cat)\ncase "$text" in *DROP*) exit 1;; esac\nprintf %s "$text" | sed "s/ghp_[A-Za-z0-9]*/[removed]/g"\n', { mode: 0o755 })
    writeFileSync(path, JSON.stringify({ gh: { type: 'github', secret: 'env:S', repos: { 'acme/web': 'web' }, filter: [join(dir, 'scrub.sh')] } }))
    const sync = loadSync(path, { S: SECRET, PATH: process.env.PATH })
    const filtered = file({ memory: true, principal: 'local:user:ada', sync })
    const send = (id: string, body: string) => {
      const payload = JSON.stringify({ action: 'opened', issue: { number: Number(id), title: body, body: '' }, repository: repo, sender: { login: 'nico' } })
      return filtered.syncReceive('gh', { headers: { 'x-github-event': 'issues', 'x-github-delivery': `f-${id}`, 'x-hub-signature-256': `sha256=${sign(SECRET, payload)}` }, body: payload })
    }
    await send('1', 'my token is ghp_abc123 oops')
    await send('2', 'DROP this one')
    const seen = (await board({ backend: filtered }).readChannel({ channel: 'web' })).threads.map((thread) => thread.message.text)
    expect(seen).toEqual(['my token is [removed] oops'])
  })

  it('on starting, the ticker asks GitHub what it missed since the last thing it received, and imports it once', async () => {
    const time = clock()
    const asked: string[] = []
    const fetcher = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return Response.json(String(url).includes('/issues/comments?since=') ? [{ id: 777, body: 'said while you were down', user: { login: 'maya' }, issue_url: 'https://api.github.com/repos/acme/web/issues/7', html_url: 'https://github.com/acme/web/issues/7#issuecomment-777' }] : [])
    }) as typeof fetch
    const dir = tempDir()
    const sync = { gh: github({ secret: SECRET, token: 't', repos: { 'acme/web': 'web' } }) }
    const first = file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
    const payload = JSON.stringify({ action: 'opened', issue: issue(7), repository: repo, sender: { login: 'nico' } })
    await first.syncReceive('gh', { headers: { 'x-github-event': 'issues', 'x-github-delivery': 'c-1', 'x-hub-signature-256': `sha256=${sign(SECRET, payload)}` }, body: payload })
    first.close()
    time.advance(3_600_000)
    const second = file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
    await second.syncTick()
    await second.syncTick()
    expect(asked.filter((url) => url.includes('since=2026-01-01T00%3A00%3A00.000Z'))).toHaveLength(1)
    const team = board({ backend: second })
    const root = (await team.readChannel({ channel: 'web' })).threads[0]!.message
    expect((await team.readThread({ id: root.id })).replies.map((reply) => [reply.text, reply.by.principal])).toEqual([['said while you were down', 'gh:user:maya']])
    second.close()
  })
})

describe('sync: config and the webhook route', () => {
  it('reads platforms from the operator\'s file, with secrets named by environment variable and never written', () => {
    const dir = tempDir()
    const path = join(dir, 'sync.json')
    expect(loadSync(path, {})).toEqual({})
    writeFileSync(path, JSON.stringify({ gh: { type: 'github', secret: 'env:GH_SECRET', token: 'env:GH_TOKEN', repos: { 'acme/web': 'web' } } }))
    expect(Object.keys(loadSync(path, { GH_SECRET: 's' }))).toEqual(['gh'])
    expect(() => loadSync(path, {})).toThrow(/GH_SECRET isn't set/)
    writeFileSync(path, JSON.stringify({ gh: { type: 'github', secret: 'the-actual-secret', repos: {} } }))
    expect(() => loadSync(path, {})).toThrow(/names an environment variable/)
    writeFileSync(path, JSON.stringify({ gh: { type: 'jira', secret: 'env:X' } }))
    expect(() => loadSync(path, { X: 'x' })).toThrow(/github, linear, slack/)
  })

  it('mu serve takes a signed webhook with no token and the thread is on the board', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'sync.json'), JSON.stringify({ gh: { type: 'github', secret: 'env:GH_SECRET', repos: { 'acme/web': 'web' } } }))
    const serving = cliStart(dir, ['serve', '--port', '0'], { GH_SECRET: SECRET })
    for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const url = /MUSTER_URL=(\S+)/.exec(serving.output())![1]!
    const body = JSON.stringify({ action: 'opened', issue: issue(3, 'From a real webhook', ''), repository: repo, sender: { login: 'nico' } })
    const post = (signature: string) => fetch(`${url}/webhooks/gh`, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-github-delivery': 'd1', 'x-hub-signature-256': signature }, body })
    expect((await post('sha256=bad')).status).toBe(401)
    expect((await post(`sha256=${sign(SECRET, body)}`)).status).toBe(200)
    const page = JSON.parse((await cli(dir, ['read', 'web', '--json'])).stdout)
    expect(page.threads.map((thread: { message: { text: string } }) => thread.message.text)).toEqual(['From a real webhook'])
    serving.child.kill('SIGTERM')
    await serving.done
  }, 20_000)
})
