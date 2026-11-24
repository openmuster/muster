import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { board, file, github, linear } from '../src/index.ts'
import type { Provider } from '../src/sync/types.ts'
import { clock, tempDir } from './helpers.ts'

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const SECRET = 'whsec'

function setup() {
  const time = clock()
  let made = 9000
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    made += 1
    if (String(body.query).includes('teams(')) return Response.json({ data: { teams: { nodes: [{ id: 'team-eng' }] } } })
    if (String(body.query).includes('issueCreate')) return Response.json({ data: { issueCreate: { success: true, issue: { id: `li-${made}`, identifier: `ENG-${made}`, state: { name: 'Todo' } } } } })
    return Response.json({ data: { commentCreate: { success: true, comment: { id: `lc-${made}` } } } })
  }) as typeof fetch
  const sync = {
    gh: github({ secret: SECRET, repos: { 'acme/web': { issues: 'web/issues', pulls: 'web/prs' } } }),
    lin: linear({ secret: SECRET, token: 'lin_api_token', teams: { ENG: 'eng' } }),
  }
  const backend = file({ memory: true, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
  const team = board({ backend })
  const gh = (event: string, payload: unknown) => {
    const body = JSON.stringify(payload)
    return backend.syncReceive('gh', { headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${sign(SECRET, body)}` }, body })
  }
  const lin = (payload: unknown) => {
    const body = JSON.stringify(payload)
    return backend.syncReceive('lin', { headers: { 'linear-signature': sign(SECRET, body) }, body })
  }
  const labels = async (channel: string) => (await team.readChannel({ channel })).threads[0]!.message.labels
  const changes = async (channel: string) => (await team.events({ after: 0, limit: 1000 })).events.filter((event) => event.type === 'labels.changed' && event.channel === channel).length
  return { team, backend, gh, lin, labels, changes }
}

const linearIssue = (more: Record<string, unknown> = {}) => ({ id: 'iss-1', identifier: 'ENG-42', title: 'SAML sign-in', description: 'Okta first', team: { key: 'ENG' }, creatorId: 'u-nico', state: { name: 'Todo' }, ...more })
const repo = { full_name: 'acme/web' }
const ghIssue = (more: Record<string, unknown> = {}) => ({ number: 7, title: 'Login redirects', body: 'Steps: ...', state: 'open', user: { login: 'nico' }, ...more })

describe('sync: what a Linear issue is filed under', () => {
  it("an issue arrives with its labels, assignee, priority and project as the thread's labels", async () => {
    const { lin, labels } = setup()
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: 'Agent' }, { name: 'Needs Review' }], assignee: { id: 'u-1', name: 'Ada Lovelace', displayName: 'ada' }, assigneeId: 'u-1', priority: 2, priorityLabel: 'High', project: { name: 'Single Sign-On' }, projectId: 'p-1' }) })
    expect(await labels('eng')).toEqual({ kind: 'issue', ref: 'ENG-42', state: 'todo', source: 'lin', 'tag.agent': 'agent', 'tag.needs-review': 'needs review', 'assignee.ada': 'ada', priority: 'high', project: 'single sign-on' })
  })

  it('a label taken off in Linear is taken off the thread, and so are an assignee, a priority and a project it no longer has: what someone set by hand outside them stays', async () => {
    const { team, lin, labels } = setup()
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: 'Agent' }, { name: 'Bug' }], assignee: { id: 'u-1', displayName: 'ada' }, assigneeId: 'u-1', priority: 1, project: { name: 'SSO' }, projectId: 'p-1' }) })
    const root = (await team.readChannel({ channel: 'eng' })).threads[0]!.message
    await team.label({ id: root.id, set: { owner: 'fixer', 'tag.mine': 'mine' } })
    await lin({ type: 'Issue', action: 'update', data: linearIssue({ state: { name: 'In Progress' }, labels: [{ name: 'Bug' }, { name: 'Security' }], labelIds: ['l-2', 'l-3'], priority: 0, priorityLabel: 'No priority' }) })
    // `tag.mine` goes with the rest: under `tag.` the thread says what Linear says.
    expect(await labels('eng')).toEqual({ kind: 'issue', ref: 'ENG-42', state: 'in-progress', source: 'lin', owner: 'fixer', 'tag.bug': 'bug', 'tag.security': 'security' })
  })

  it("an update that doesn't say what the issue's labels are leaves them alone, and one that names an assignee without their details leaves the assignee", async () => {
    const { lin, labels } = setup()
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: 'Agent' }], assignee: { id: 'u-1', displayName: 'ada' }, assigneeId: 'u-1' }) })
    await lin({ type: 'Issue', action: 'update', data: { id: 'iss-1', team: { key: 'ENG' }, state: { name: 'Done' }, assigneeId: 'u-1' } })
    expect(await labels('eng')).toMatchObject({ state: 'done', 'tag.agent': 'agent', 'assignee.ada': 'ada' })
  })

  it('the last label taken off, sent as an empty list of IDs, clears the tags', async () => {
    const { lin, labels } = setup()
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: 'Agent' }] }) })
    await lin({ type: 'Issue', action: 'update', data: linearIssue({ labelIds: [] }) })
    expect(Object.keys(await labels('eng')).filter((key) => key.startsWith('tag.'))).toEqual([])
  })

  it('an update that changes nothing the board keeps writes nothing', async () => {
    const { lin, changes } = setup()
    const data = linearIssue({ labels: [{ name: 'Agent' }], priority: 3 })
    await lin({ type: 'Issue', action: 'create', data })
    await lin({ type: 'Issue', action: 'update', data: { ...data, title: 'SAML sign-in, renamed' } })
    expect(await changes('eng')).toBe(0)
  })

  it('a name becomes a key the board takes: cut to fit, nothing for a name with no letters, the same value whatever its case, and one key for two names that read the same', async () => {
    const { lin, labels } = setup()
    const long = 'x'.repeat(80)
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: '🐛' }, { name: long }, { name: 'bug!' }, { name: 'Bug' }, { name: 'Board.X' }, { name: 'two\nlines' }] }) })
    const got = await labels('eng')
    const tags = Object.fromEntries(Object.entries(got).filter(([key]) => key.startsWith('tag.')))
    expect(tags).toEqual({ [`tag.${'x'.repeat(60)}`]: long, 'tag.bug': 'bug', 'tag.board.x': 'board.x', 'tag.two-lines': 'two lines' })
    expect(Object.keys(got).every((key) => key.length <= 64)).toBe(true)
  })

  it('an issue with more labels than a message holds keeps the first forty, leaves room for a label of your own, and what sync set a person can unset', async () => {
    const { team, lin } = setup()
    await lin({ type: 'Issue', action: 'create', data: linearIssue({ labels: Array.from({ length: 90 }, (_, index) => ({ name: `l${String(index).padStart(2, '0')}` })) }) })
    const root = (await team.readChannel({ channel: 'eng' })).threads[0]!.message
    expect(Object.keys(root.labels).filter((key) => key.startsWith('tag.'))).toHaveLength(40)
    await team.label({ id: root.id, set: { started: 'yes' }, unset: ['tag.l00'] })
    expect((await team.readThread({ id: root.id })).message.labels).toMatchObject({ started: 'yes' })
    expect((await team.readThread({ id: root.id })).message.labels['tag.l00']).toBeUndefined()
  })

  it("a thread started on the board that opened an issue is filed as the issue is: a tag set by hand goes at the issue's next update", async () => {
    const { team, backend, lin } = setup()
    await backend.syncTick()
    const posted = await team.post({ channel: 'eng', text: 'Add SCIM\n\nlater', labels: { 'tag.agent': 'agent' } })
    await backend.syncTick()
    const before = (await team.readThread({ id: posted.id })).message.labels
    expect(before).toMatchObject({ 'tag.agent': 'agent', ref: 'ENG-9002' })
    await lin({ type: 'Issue', action: 'update', data: { id: 'li-9002', identifier: 'ENG-9002', team: { key: 'ENG' }, state: { name: 'Todo' }, labels: [], labelIds: [] } })
    expect((await team.readThread({ id: posted.id })).message.labels['tag.agent']).toBeUndefined()
  })
})

describe('sync: what a GitHub issue or pull request is filed under', () => {
  it('an issue arrives with its labels and assignees, and labelling, unlabelling, assigning and unassigning it change them', async () => {
    const { gh, labels } = setup()
    await gh('issues', { action: 'opened', issue: ghIssue({ labels: [{ name: 'bug' }], assignees: [{ login: 'Maya-Dev' }] }), repository: repo, sender: { login: 'nico' } })
    expect(await labels('web/issues')).toEqual({ kind: 'issue', state: 'open', ref: 'acme/web#7', source: 'gh', 'tag.bug': 'bug', 'assignee.maya-dev': 'maya-dev' })
    await gh('issues', { action: 'labeled', issue: ghIssue({ labels: [{ name: 'bug' }, { name: 'Agent' }], assignees: [{ login: 'Maya-Dev' }] }), repository: repo, sender: { login: 'nico' } })
    expect(await labels('web/issues')).toMatchObject({ 'tag.bug': 'bug', 'tag.agent': 'agent' })
    await gh('issues', { action: 'unlabeled', issue: ghIssue({ labels: [{ name: 'Agent' }], assignees: [{ login: 'Maya-Dev' }] }), repository: repo, sender: { login: 'nico' } })
    await gh('issues', { action: 'unassigned', issue: ghIssue({ labels: [{ name: 'Agent' }], assignees: [] }), repository: repo, sender: { login: 'nico' } })
    await gh('issues', { action: 'assigned', issue: ghIssue({ labels: [{ name: 'Agent' }], assignees: [{ login: 'nico' }] }), repository: repo, sender: { login: 'nico' } })
    expect(await labels('web/issues')).toEqual({ kind: 'issue', state: 'open', ref: 'acme/web#7', source: 'gh', 'tag.agent': 'agent', 'assignee.nico': 'nico' })
  })

  it('a pull request is filed the same way, in its own channel', async () => {
    const { gh, labels } = setup()
    await gh('pull_request', { action: 'opened', pull_request: ghIssue({ number: 9, labels: [{ name: 'ready' }], assignees: [] }), repository: repo, sender: { login: 'nico' } })
    await gh('pull_request', { action: 'labeled', pull_request: ghIssue({ number: 9, labels: [{ name: 'ready' }, { name: 'agent' }], assignees: [] }), repository: repo, sender: { login: 'nico' } })
    expect(await labels('web/prs')).toEqual({ kind: 'pr', state: 'open', ref: 'acme/web#9', source: 'gh', 'tag.ready': 'ready', 'tag.agent': 'agent' })
  })

  it('a label put on an issue the board never saw starts its thread, already filed', async () => {
    const { team, gh } = setup()
    await gh('issues', { action: 'labeled', issue: ghIssue({ number: 11, labels: [{ name: 'agent' }], assignees: [] }), repository: repo, sender: { login: 'maya' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    expect(root).toMatchObject({ text: 'Login redirects\n\nSteps: ...', by: { principal: 'gh:user:nico' }, labels: { ref: 'acme/web#11', 'tag.agent': 'agent' } })
  })

  it('after downtime, a label taken off meanwhile is taken off the thread, and one put on is there', async () => {
    const time = clock()
    const fetcher = (async (input: string | URL | Request) => {
      if (String(input).includes('/repos/acme/web/issues?state=all')) {
        return Response.json([ghIssue({ labels: [{ name: 'security' }], assignees: [], updated_at: '2026-01-01T00:30:00Z' })])
      }
      return Response.json([])
    }) as typeof fetch
    const dir = tempDir()
    const sync = { gh: github({ secret: SECRET, token: 't', repos: { 'acme/web': 'web' } }) }
    const first = file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
    const payload = JSON.stringify({ action: 'opened', issue: ghIssue({ labels: [{ name: 'agent' }], assignees: [{ login: 'maya' }] }), repository: repo, sender: { login: 'nico' } })
    await first.syncReceive('gh', { headers: { 'x-github-event': 'issues', 'x-hub-signature-256': `sha256=${sign(SECRET, payload)}` }, body: payload })
    first.close()
    time.advance(3_600_000)
    const second = file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
    await second.syncTick()
    const labels = (await board({ backend: second }).readChannel({ channel: 'web' })).threads[0]!.message.labels
    expect(labels).toEqual({ kind: 'issue', state: 'open', ref: 'acme/web#7', source: 'gh', 'tag.security': 'security' })
    second.close()
  })
})

describe('sync: labels a platform sends are held to the rules for your own', () => {
  it("a thread that is nearly full takes what fits and no more, and keeps what was on it", async () => {
    const { team, gh } = setup()
    await gh('issues', { action: 'opened', issue: ghIssue(), repository: repo, sender: { login: 'nico' } })
    const root = (await team.readChannel({ channel: 'web/issues' })).threads[0]!.message
    // Four from sync (kind, state, ref, source) and fifty-six by hand: four places left.
    await team.label({ id: root.id, set: Object.fromEntries(Array.from({ length: 56 }, (_, index) => [`mine.${index}`, 'x'])) })
    await gh('issues', { action: 'labeled', issue: ghIssue({ labels: Array.from({ length: 10 }, (_, index) => ({ name: `t${index}` })), assignees: [] }), repository: repo, sender: { login: 'nico' } })
    const labels = (await team.readThread({ id: root.id })).message.labels
    expect(Object.keys(labels)).toHaveLength(64)
    expect(Object.keys(labels).filter((key) => key.startsWith('tag.'))).toEqual(['tag.t0', 'tag.t1', 'tag.t2', 'tag.t3'])
    expect(labels['mine.55']).toBe('x')
  })

  it("a key or a value the board wouldn't take from a person is left out, on a new thread and on a later change, and the rest of the event still lands", async () => {
    const time = clock()
    // A stand-in platform that sends whatever its body says, as a provider with a fault in it might.
    const odd: Provider = {
      type: 'odd',
      verify() {},
      parse: ({ body }) => [JSON.parse(body)],
      channelFor: () => 'odd',
      placeFor: () => null,
      mirrors: () => false,
      deliver: async () => ({ external: 'none' }),
    }
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now, sync: { odd } })
    const team = board({ backend })
    const bad = { 'board.task': 'ready', [`k${'x'.repeat(70)}`]: 'long key', 'Upper': 'case', lines: 'two\nlines', big: 'v'.repeat(300) }
    const event = { author: 'u', place: 'p', thread: 't-1' }
    await backend.syncReceive('odd', { headers: {}, body: JSON.stringify({ ...event, id: 'e-1', kind: 'root', external: 't-1', text: 'a thread', labels: { ...bad, fine: 'yes' } }) })
    await backend.syncReceive('odd', { headers: {}, body: JSON.stringify({ ...event, id: 'e-2', kind: 'labels', external: 'e-2', labels: { ...bad, later: 'yes' }, unset: ['board.task'], owns: ['board.'] }) })
    const root = (await team.readChannel({ channel: 'odd' })).threads[0]!.message
    expect(root.labels).toEqual({ fine: 'yes', later: 'yes', source: 'odd' })
  })
})

describe('sync: what a Linear issue is filed under, after downtime', () => {
  const node = (id: string, more: Record<string, unknown> = {}) => ({ id, identifier: `ENG-${id}`, title: `Issue ${id}`, description: '', creator: { id: 'u-nico' }, team: { key: 'ENG' }, state: { name: 'Todo' }, priority: 0, assignee: null, project: null, labels: { nodes: [] }, updatedAt: '2026-01-01T00:30:00.000Z', ...more })
  async function downtime(listed: () => unknown[]) {
    const time = clock()
    const asked: string[] = []
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const query = String(JSON.parse(String(init?.body ?? '{}')).query)
      asked.push(query)
      if (query.includes('issues(')) return Response.json({ data: { issues: { nodes: listed(), pageInfo: { hasNextPage: false, endCursor: null } } } })
      return Response.json({ data: { comments: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } } } })
    }) as typeof fetch
    const dir = tempDir()
    const sync = { lin: linear({ secret: SECRET, token: 'lin_api_token', teams: { ENG: 'eng' } }) }
    const open = () => file({ dir, principal: 'local:user:ada', now: time.now, sync, fetch: fetcher })
    const first = open()
    const body = JSON.stringify({ type: 'Issue', action: 'create', data: linearIssue({ labels: [{ name: 'Agent' }, { name: 'Bug' }], priority: 1 }) })
    await first.syncReceive('lin', { headers: { 'linear-signature': sign(SECRET, body) }, body })
    return { time, open, first, asked }
  }

  it('a label taken off or put on while the board was down is taken off or put on the thread, and an issue made meanwhile arrives filed', async () => {
    const { time, open, first, asked } = await downtime(() => [
      node('iss-1', { labels: { nodes: [{ name: 'Bug' }, { name: 'Security' }] }, assignee: { id: 'u-1', name: 'Ada Lovelace', displayName: 'ada', url: 'https://linear.app/acme/profiles/ada' }, project: { name: 'SSO' } }),
      node('iss-2', { labels: { nodes: [{ name: 'Agent' }] }, priority: 2, updatedAt: '2026-01-01T00:40:00.000Z' }),
    ])
    first.close()
    time.advance(3_600_000)
    const second = open()
    await second.syncTick()
    const threads = (await board({ backend: second }).readChannel({ channel: 'eng' })).threads.map((thread) => thread.message.labels)
    expect(threads).toContainEqual({ kind: 'issue', ref: 'ENG-42', state: 'todo', source: 'lin', 'tag.bug': 'bug', 'tag.security': 'security', 'assignee.ada': 'ada', project: 'sso' })
    expect(threads).toContainEqual({ kind: 'issue', ref: 'ENG-iss-2', state: 'todo', source: 'lin', 'tag.agent': 'agent', priority: 'high' })
    // Linear is asked for what an issue is filed under, and never for an email.
    expect(asked.find((query) => query.includes('issues('))).toContain('labels { nodes { name } }')
    expect(asked.join(' ')).not.toContain('email')
    second.close()
  })

  it("a label set on the board after Linear's own change is the newer, and catching up leaves it; an older one goes", async () => {
    const { time, open, first } = await downtime(() => [node('iss-1', { labels: { nodes: [] }, priority: 1 })])
    const team = board({ backend: first })
    const root = (await team.readChannel({ channel: 'eng' })).threads[0]!.message
    // Linear's change is at half past; this one is at forty past.
    time.advance(2_400_000)
    await team.label({ id: root.id, set: { 'tag.keep': 'keep' } })
    first.close()
    time.advance(1_200_000)
    const second = open()
    await second.syncTick()
    const labels = (await board({ backend: second }).readChannel({ channel: 'eng' })).threads[0]!.message.labels
    expect(labels).toEqual({ kind: 'issue', ref: 'ENG-42', state: 'todo', source: 'lin', priority: 'urgent', 'tag.keep': 'keep' })
    second.close()
  })
})
