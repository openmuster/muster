import { describe, expect, it } from 'vitest'
import { board as handle } from '../src/index.ts'
import { HTTP, memoryBoard } from './helpers.ts'

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
