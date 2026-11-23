import { describe, expect, it } from 'vitest'
import { board as handle } from '../src/index.ts'
import { cli, cliStart, HTTP, memoryBoard, tempDir } from './helpers.ts'

/** What a reader sees of its inbox, as one line per event. */
const lines = (events: Awaited<ReturnType<ReturnType<typeof memoryBoard>['team']['events']>>['events']) =>
  events.map((event) => `${event.for} ${event.message ? event.message.text : `task ${event.task?.id}`}`)

describe('events for one profile', () => {
  it('finds what mentions it, what is assigned to it and what answers it, and never its own', async () => {
    const { team, as } = memoryBoard()
    const lead = team.as('lead')
    const bob = as('local:user:bob')
    await lead.post({ channel: 'work', text: 'mine' })
    const root = (await team.events({ after: 0 })).events[0]!.message!
    await bob.post({ channel: 'work', text: '@lead look' })
    await bob.reply({ to: root.id, text: 'a thought on yours' })
    const unrelated = await bob.post({ channel: 'work', text: 'not for lead' })
    await bob.reply({ to: unrelated.id, text: 'nor this' })
    await bob.reply({ to: root.id, text: 'again, @lead' })
    await lead.reply({ to: root.id, text: 'my own reply' })
    const asked = await bob.post({ channel: 'work', text: 'who can help?' })
    await lead.reply({ to: asked.id, text: 'me' })
    await bob.reply({ to: asked.id, text: 'thanks' })
    await bob.post({ channel: 'work', text: 'for someone else: @[local:user:ada+other]' })
    const created = await bob.taskCreate({ channel: 'work', text: 'a task for lead', for: 'lead' })
    await bob.taskCreate({ channel: 'work', text: 'a task for other', for: 'other' })
    const plain = await bob.taskCreate({ channel: 'work', text: 'a task for none' })
    await bob.taskAssign({ id: plain.task.id, for: 'lead' })
    const elsewhere = await bob.taskCreate({ channel: 'work', text: 'another for none' })
    await bob.taskAssign({ id: elsewhere.task.id, for: 'other' })

    const got = await team.events({ after: 0, filter: { for: 'lead' } })
    expect(lines(got.events).filter((line) => !line.includes('task'))).toEqual([
      'mention @[local:user:ada+lead] look',
      'reply a thought on yours',
      'mention again, @[local:user:ada+lead]',
      'reply thanks',
    ])
    expect(got.events.filter((event) => event.type.startsWith('task.')).map((event) => [event.type, event.task!.id, event.for])).toEqual([
      ['task.created', created.task.id, 'assigned'],
      ['task.assigned', plain.task.id, 'assigned'],
    ])
    // Without the filter nothing carries the mark.
    expect((await team.events({ after: 0 })).events.some((event) => 'for' in event)).toBe(false)
  })

  it('does not hand one principal\'s mentions to another principal\'s profile of the same name', async () => {
    const { team, as } = memoryBoard()
    const bob = as('local:user:bob')
    await team.as('lead').post({ channel: 'work', text: 'here' })
    await bob.as('lead').post({ channel: 'work', text: 'here too' })
    await team.post({ channel: 'work', text: 'ping @[local:user:ada+lead]' })
    expect(lines((await team.events({ after: 0, filter: { for: 'lead' } })).events)).toEqual(['mention ping @[local:user:ada+lead]'])
    expect((await team.events({ after: 0, filter: { for: 'local:user:bob+lead' } })).events).toEqual([])
    // Bob's own `lead` is another actor: a bare name is the asker's, so Ada's mentions are not his.
    expect(lines((await bob.as('lead').events({ after: 0, filter: { for: 'lead' } })).events)).toEqual([])
    // A full actor ID names whoever it names, whoever asks.
    expect(lines((await bob.events({ after: 0, filter: { for: 'local:user:ada+lead' } })).events)).toEqual(['mention ping @[local:user:ada+lead]'])
  })

  it('does not count a reply to a thread whose message was deleted, or one the profile joined later', async () => {
    const { team, as } = memoryBoard()
    const bob = as('local:user:bob')
    const lead = team.as('lead')
    const thread = await bob.post({ channel: 'work', text: 'a question' })
    await bob.reply({ to: thread.id, text: 'before lead came' })
    const mine = await lead.reply({ to: thread.id, text: 'lead joins' })
    await bob.reply({ to: thread.id, text: 'after' })
    await lead.remove({ id: mine.id })
    await bob.reply({ to: thread.id, text: 'after the delete' })
    const other = await bob.post({ channel: 'work', text: 'another question' })
    await bob.reply({ to: other.id, text: 'early' })
    await lead.reply({ to: other.id, text: 'lead joins this one' })
    await bob.reply({ to: other.id, text: 'late' })
    expect(lines((await team.events({ after: 0, filter: { for: 'lead' } })).events)).toEqual(['reply late'])
  })

  it.skipIf(HTTP)('never shows a caller held to some channels an event outside them, even one that mentions them', async () => {
    const { team, as } = memoryBoard()
    const bob = as('local:user:bob')
    await team.as('lead').post({ channel: 'work', text: 'here' })
    await bob.post({ channel: 'secret', text: '@[local:user:ada+lead] private' })
    await bob.post({ channel: 'work', text: '@[local:user:ada+lead] open' })
    const narrow = handle({ backend: { ...team.backend, self: async () => ({ principal: 'local:user:ada', profile: 'lead', can: { 'work/': ['read'] } }) } })
    await bob.post({ channel: 'work/web', text: '@[local:user:ada+lead] in the tree' })
    const got = await narrow.events({ after: 0, filter: { for: 'lead' } })
    expect(lines(got.events)).toEqual(['mention @[local:user:ada+lead] open', 'mention @[local:user:ada+lead] in the tree'])
    const wide = await team.as('lead').events({ after: 0, filter: { for: 'lead' } })
    expect(lines(wide.events)).toEqual(['mention @[local:user:ada+lead] private', 'mention @[local:user:ada+lead] open', 'mention @[local:user:ada+lead] in the tree'])
  })
})

const PERSON = process.env.USER ?? 'ada'

describe('mu inbox', () => {
  /** A board with lead's profile known, one mention and one assignment for it, and one post that is not for it. */
  async function busy() {
    const dir = tempDir()
    await cli(dir, ['post', 'work/api', 'lead is here', '--as', 'lead'])
    await cli(dir, ['post', 'work/api', '@lead please look\nsecond line', '--as', 'bob'])
    await cli(dir, ['post', 'work/api', 'not for lead', '--as', 'bob'])
    await cli(dir, ['tasks', 'create', 'work', 'ship it', '--as', 'bob'])
    await cli(dir, ['tasks', 'assign', '4', '--for', 'lead', '--as', 'bob'])
    return dir
  }

  it('lists a mention and an assignment, then nothing, because the cursor moved', async () => {
    const dir = await busy()
    const first = await cli(dir, ['inbox', '--as', 'lead'])
    expect(first.code).toBe(0)
    expect(first.stdout.trimEnd().split('\n')).toEqual(['mention   #2  work/api  bob: @[local:user:' + PERSON + '+lead] please look', 'assigned  #4  work  bob: ship it'])
    const second = await cli(dir, ['inbox', '--as', 'lead'])
    expect(second).toMatchObject({ code: 0, stdout: '' })
    await cli(dir, ['post', 'work/api', '@lead again', '--as', 'bob'])
    expect((await cli(dir, ['inbox', '--as', 'lead'])).stdout).toMatch(/^mention {3}#\d+ {2}work\/api {2}bob: @\[[^\]]+\] again\n$/)
  })

  it('with --peek reads without moving the cursor', async () => {
    const dir = await busy()
    const a = await cli(dir, ['inbox', '--as', 'lead', '--peek'])
    const b = await cli(dir, ['inbox', '--as', 'lead', '--peek'])
    expect(a.stdout).not.toBe('')
    expect(b.stdout).toBe(a.stdout)
    await cli(dir, ['inbox', '--as', 'lead'])
    expect((await cli(dir, ['inbox', '--as', 'lead', '--peek'])).stdout).toBe('')
  })

  it('prints one document with --json, and an empty one when nothing is new', async () => {
    const dir = await busy()
    const got = JSON.parse((await cli(dir, ['inbox', '--as', 'lead', '--json'])).stdout)
    expect(Object.keys(got)).toEqual(['items', 'cursor'])
    expect(got.items.map((item: { kind: string; event: { for: string } }) => [item.kind, item.event.for])).toEqual([['mention', 'mention'], ['assigned', 'assigned']])
    expect(got.items[0].event.message.text).toMatch(/^@\[local:user:[^+]+\+lead\] please look\nsecond line$/)
    expect(typeof got.cursor).toBe('number')
    expect(JSON.parse((await cli(dir, ['inbox', '--as', 'lead', '--json'])).stdout)).toEqual({ items: [], cursor: got.cursor })
  })

  it('never shows the words of a message deleted since, and a deleted reply stays an item with no text', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'lead is here', '--as', 'lead'])
    await cli(dir, ['post', 'work', '@lead secret', '--as', 'bob'])
    await cli(dir, ['reply', '1', 'a reply', '--as', 'bob'])
    await cli(dir, ['reply', '1', 'another', '--as', 'bob'])
    await cli(dir, ['delete', '2', '--as', 'bob'])
    await cli(dir, ['delete', '3', '--as', 'bob'])
    const peek = await cli(dir, ['inbox', '--as', 'lead', '--peek', '--json'])
    expect(peek.stdout).not.toContain('secret')
    expect(peek.stdout).not.toContain('a reply')
    const json = JSON.parse(peek.stdout)
    expect(json.items.map((item: { kind: string }) => item.kind)).toEqual(['reply', 'reply'])
    const run = await cli(dir, ['inbox', '--as', 'lead'])
    expect(run.stdout).toBe('reply     #1  work  bob:\nreply     #1  work  bob: another\n')
  })

  it('keeps a cursor for each profile: one reading its inbox leaves another its own items', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here', '--as', 'lead'])
    await cli(dir, ['post', 'work', 'here too', '--as', 'other'])
    await cli(dir, ['post', 'work', '@lead one', '--as', 'bob'])
    await cli(dir, ['post', 'work', '@other two', '--as', 'bob'])
    expect((await cli(dir, ['inbox', '--as', 'lead'])).stdout).toMatch(/\+lead\] one\n$/)
    expect((await cli(dir, ['inbox', '--as', 'lead'])).stdout).toBe('')
    expect((await cli(dir, ['inbox', '--as', 'other'])).stdout).toMatch(/\+other\] two\n$/)
    expect((await cli(dir, ['inbox', '--as', 'other'])).stdout).toBe('')
  })

  it('with no profile the inbox is the principal\'s own, and has its own cursor', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here'])
    await cli(dir, ['post', 'work', 'lead is here', '--as', 'lead'])
    await cli(dir, ['reply', '1', 'for the principal', '--as', 'bob'])
    await cli(dir, ['post', 'work', '@lead for lead', '--as', 'bob'])
    const first = await cli(dir, ['inbox'])
    expect(first.stdout).toBe('reply     #1  work  bob: for the principal\n')
    expect((await cli(dir, ['inbox'])).stdout).toBe('')
    // lead's cursor is its own: it has not been read.
    expect((await cli(dir, ['inbox', '--as', 'lead', '--peek'])).stdout).toContain('mention')
  })

  it('refuses a --limit that is not a whole number of at least 1', async () => {
    const dir = tempDir()
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const run = await cli(dir, ['inbox', '--as', 'lead', '--limit', bad, '--json'])
      expect(run.code).toBe(2)
      expect(JSON.parse(run.stderr).error.reason).toBe('invalid_limit')
    }
  })

  it('exits 130 on Ctrl-C while waiting, with or without --json, and prints nothing', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here', '--as', 'lead'])
    for (const extra of [[], ['--json']]) {
      const waiting = cliStart(dir, ['inbox', '--as', 'lead', '--wait', '30s', ...extra])
      await new Promise((resolve) => setTimeout(resolve, 800))
      waiting.child.kill('SIGINT')
      const ended = await waiting.done
      expect(ended.code).toBe(130)
      expect(ended.stdout).toBe('')
    }
  })

  it('--limit holds the page and the next call carries on', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here', '--as', 'lead'])
    for (const n of [1, 2, 3]) await cli(dir, ['post', 'work', `@lead ${n}`, '--as', 'bob'])
    expect((await cli(dir, ['inbox', '--as', 'lead', '--limit', '2'])).stdout.trimEnd().split('\n')).toHaveLength(2)
    expect((await cli(dir, ['inbox', '--as', 'lead'])).stdout).toMatch(/\+lead\] 3\n$/)
  })

  it('--wait returns when something arrives, and says nothing on a quiet board', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here', '--as', 'lead'])
    expect(await cli(dir, ['inbox', '--as', 'lead', '--wait', '300ms'])).toMatchObject({ code: 0, stdout: '' })
    const waiting = cli(dir, ['inbox', '--as', 'lead', '--wait', '10s'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    await cli(dir, ['post', 'work', '@lead hello', '--as', 'bob'])
    const got = await waiting
    expect(got.code).toBe(0)
    expect(got.stdout).toMatch(/^mention {3}#\d+ {2}work {2}bob: @\[[^\]]+\] hello\n$/)
  })

  it('wait --for returns on a mention and not before', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'here', '--as', 'lead'])
    const quiet = await cli(dir, ['wait', '--for', 'lead', '--timeout', '300ms', '--json'])
    expect(quiet.code).toBe(1)
    const waiting = cli(dir, ['wait', '--for', 'lead', '--timeout', '10s', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    await cli(dir, ['post', 'work', 'unrelated', '--as', 'bob'])
    await cli(dir, ['post', 'work', '@lead hello', '--as', 'bob'])
    const got = await waiting
    expect(got.code).toBe(0)
    expect(JSON.parse(got.stdout).event).toMatchObject({ for: 'mention', message: { text: expect.stringMatching(/^@\[[^\]]+\] hello$/) } })
  })

  it('tail --for lists what is for a profile, with the reason', async () => {
    const dir = await busy()
    const tail = cliStart(dir, ['tail', '--for', 'lead', '--last', '10', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    tail.child.kill('SIGTERM')
    const run = await tail.done
    expect(run.stdout.trim().split('\n').map((line) => JSON.parse(line).for)).toEqual(['mention', 'assigned'])
  })
})
