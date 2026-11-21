import { describe, expect, it } from 'vitest'
import { memoryBoard, reason } from './helpers.ts'

describe('reading', () => {
  it('a channel read lists threads newest activity first, with reply counts and a cursor', async () => {
    const { team } = memoryBoard()
    const a = await team.post({ channel: 'dev', text: 'a' })
    const b = await team.post({ channel: 'dev', text: 'b' })
    await team.reply({ to: a.id, text: 'a1' })
    const page = await team.readChannel({ channel: 'dev' })
    expect(page.threads.map((thread) => thread.message.text)).toEqual(['a', 'b'])
    expect(page.threads[0]).toMatchObject({ replies: 1, last: { text: 'a1' } })
    expect(page.cursor).toBe(await team.head())
    expect(b.id).toBeGreaterThan(a.id)
  })

  it('--after a cursor lists only threads with activity since, reactions and labels included', async () => {
    const { team } = memoryBoard()
    const a = await team.post({ channel: 'dev', text: 'a' })
    const b = await team.post({ channel: 'dev', text: 'b' })
    const { cursor } = await team.readChannel({ channel: 'dev' })
    expect((await team.readChannel({ channel: 'dev', after: cursor })).threads).toEqual([])
    await team.react({ id: a.id, emoji: 'eyes' })
    const news = await team.readChannel({ channel: 'dev', after: cursor })
    expect(news.threads.map((thread) => thread.message.id)).toEqual([a.id])
    await team.label({ id: b.id, set: { step: 'fix' } })
    expect((await team.readChannel({ channel: 'dev', after: news.cursor })).threads.map((thread) => thread.message.id)).toEqual([b.id])
  })

  it('a channel read finds the threads that mention someone, in the root or any reply', async () => {
    const { team } = memoryBoard()
    await team.as('claude').post({ channel: 'dev', text: 'here' })
    await team.as('codex').post({ channel: 'dev', text: 'here too' })
    const root = await team.post({ channel: 'dev', text: '@claude can you look?' })
    const replied = await team.post({ channel: 'dev', text: 'a question for anyone' })
    await team.reply({ to: replied.id, text: 'over to @claude' })
    const other = await team.post({ channel: 'dev', text: '@codex yours' })
    await team.post({ channel: 'dev', text: 'claude without the sign, and @nobody-here' })
    const elsewhere = await team.post({ channel: 'ops', text: '@claude and here' })
    const ids = async (request: Parameters<typeof team.readChannel>[0]) => (await team.readChannel(request)).threads.map((thread) => thread.message.id)
    expect(await ids({ channel: 'dev', mentions: 'claude' })).toEqual([replied.id, root.id])
    expect(await ids({ channel: 'dev', mentions: 'codex' })).toEqual([other.id])
    expect(await ids({ channel: 'dev', mentions: 'local:user:ada+claude' })).toEqual([replied.id, root.id])
    expect(await ids({ channel: 'dev', mentions: 'nobody-here' })).toEqual([])
    expect(await ids({ channel: 'ops', mentions: 'claude' })).toEqual([elsewhere.id])
    // It narrows with the other filters and pages as any read does.
    expect(await ids({ channel: 'dev', mentions: 'claude', limit: 1 })).toEqual([replied.id])
    expect((await team.readChannel({ channel: 'dev', mentions: 'claude', limit: 1 })).more).toBe(true)
    // A reply that was deleted mentions nobody.
    const gone = await team.reply({ to: other.id, text: '@claude never mind' })
    expect(await ids({ channel: 'dev', mentions: 'claude' })).toContain(other.id)
    await team.remove({ id: gone.id })
    expect(await ids({ channel: 'dev', mentions: 'claude' })).not.toContain(other.id)
  })

  it('pages back through a channel with no thread skipped or repeated', async () => {
    const { team } = memoryBoard()
    const ids: number[] = []
    for (let i = 0; i < 23; i++) ids.push((await team.post({ channel: 'log', text: `entry ${i}` })).id)
    const seen: number[] = []
    let before: number | undefined
    for (;;) {
      const page = await team.readChannel({ channel: 'log', limit: 5, ...(before !== undefined ? { before } : {}) })
      seen.push(...page.threads.map((thread) => thread.message.id))
      if (page.older === null) break
      before = page.older
    }
    expect(seen).toEqual([...ids].reverse())
  })

  it('a subtree read takes every channel under a path and nothing beside it', async () => {
    const { team } = memoryBoard()
    await team.post({ channel: 'db/storage', text: 's' })
    await team.post({ channel: 'db/consensus', text: 'c' })
    await team.post({ channel: 'db', text: 'd' })
    await team.post({ channel: 'dbx', text: 'no' })
    const page = await team.readChannel({ channel: 'db/' })
    expect(page.threads.map((thread) => thread.message.text).sort()).toEqual(['c', 'd', 's'])
    expect((await team.channels({ under: 'db' })).channels.map((channel) => channel.path)).toEqual(['db', 'db/consensus', 'db/storage'])
  })

  it('filters threads by label, with alternatives', async () => {
    const { team } = memoryBoard()
    await team.post({ channel: 'dev', text: 'bug', labels: { kind: 'bug' } })
    await team.post({ channel: 'dev', text: 'feature', labels: { kind: 'feature' } })
    await team.post({ channel: 'dev', text: 'chat' })
    const texts = async (labels: string[]) => (await team.readChannel({ channel: 'dev', labels })).threads.map((thread) => thread.message.text).sort()
    expect(await texts(['kind=bug'])).toEqual(['bug'])
    expect(await texts(['kind=bug|feature'])).toEqual(['bug', 'feature'])
    expect(await texts(['kind'])).toEqual(['bug', 'feature'])
  })

  it('what a deleted message said is gone from the feed too: its text, its edits and its labels, and no filter finds it', async () => {
    const { team } = memoryBoard()
    const kept = await team.post({ channel: 'dev', text: 'this one stays' })
    const message = await team.post({ channel: 'dev', text: 'the password is hunter2', labels: { customer: 'acme-corp' } })
    await team.edit({ id: message.id, text: 'the password was swordfish' })
    await team.label({ id: message.id, set: { ticket: 'zd-4411' }, unset: ['customer'] })
    const reply = await team.reply({ to: kept.id, text: 'a reply with a secret: xyzzy' })
    const before = JSON.stringify((await team.events({ after: 0 })).events)
    for (const word of ['hunter2', 'swordfish', 'acme-corp', 'zd-4411', 'xyzzy']) expect(before).toContain(word)
    await team.remove({ id: message.id })
    await team.remove({ id: reply.id })
    const all = await team.events({ after: 0, limit: 1000 })
    const after = JSON.stringify(all.events)
    for (const word of ['hunter2', 'swordfish', 'acme-corp', 'zd-4411', 'xyzzy']) expect(after).not.toContain(word)
    // The events are still there, in order, and say that something was posted and deleted: only the words are gone.
    expect(all.events.filter((event) => event.thread === message.id).map((event) => event.type)).toEqual(['message.posted', 'message.edited', 'labels.changed', 'message.deleted'])
    expect(after).toContain('this one stays')
    // A filter is matched against what a reader may see, so it can't be used to ask what the text was.
    expect((await team.events({ after: 0, filter: { text: 'hunter2' } })).events).toEqual([])
    expect((await team.events({ after: 0, filter: { text: 'xyzzy' } })).events).toEqual([])
  })

  it('search finds words in roots and replies, and not in deleted or edited-away text', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'the checkout limiter is flaky' })
    const reply = await team.reply({ to: root.id, text: 'redis timeouts under load' })
    expect((await team.search({ text: 'limiter' })).messages.map((message) => message.id)).toEqual([root.id])
    expect((await team.search({ text: 'redis load' })).messages.map((message) => message.id)).toEqual([reply.id])
    await team.edit({ id: reply.id, text: 'memcached was fine' })
    expect((await team.search({ text: 'redis' })).messages).toEqual([])
    expect((await team.search({ text: 'limiter', channel: 'other' })).messages).toEqual([])
    expect((await team.readChannel({ channel: 'dev', text: 'memcached' })).threads).toHaveLength(1)
  })

  it('the feed gives events after a cursor in order, and its cursor resumes with no gap or repeat', async () => {
    const { team } = memoryBoard()
    const start = await team.head()
    for (let i = 0; i < 12; i++) await team.post({ channel: i % 2 ? 'a' : 'b', text: `m${i}` })
    const seen: string[] = []
    let after = start
    for (;;) {
      const page = await team.events({ after, filter: { channel: 'a' }, limit: 2 })
      seen.push(...page.events.map((event) => String(event.data.text)))
      if (page.events.length === 0) break
      after = page.cursor
    }
    expect(seen).toEqual(['m1', 'm3', 'm5', 'm7', 'm9', 'm11'])
  })

  it('the feed filters by thread, author, text, and event type', async () => {
    const { team } = memoryBoard()
    const root = await team.as('lead').post({ channel: 'dev', text: 'ship it?' })
    await team.as('worker').reply({ to: root.id, text: 'tests pass' })
    await team.as('worker').post({ channel: 'dev', text: 'unrelated' })
    await team.as('lead').react({ id: root.id, emoji: 'rocket' })
    const types = async (filter: Parameters<typeof team.events>[0]['filter']) => (await team.events({ after: 0, filter })).events.map((event) => event.type)
    expect(await types({ re: root.id })).toEqual(['message.posted', 'message.posted', 'reaction.added'])
    expect(await types({ by: 'worker' })).toEqual(['message.posted', 'message.posted'])
    expect(await types({ text: 'TESTS' })).toEqual(['message.posted'])
    expect(await types({ types: ['reaction.'] })).toEqual(['reaction.added'])
  })

  it('a label filter matches an event if its thread matched before or after it', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'x', labels: { step: 'fix' } })
    const start = await team.head()
    await team.label({ id: root.id, set: { step: 'review' } })
    const left = await team.events({ after: start, filter: { labels: ['step=fix'] } })
    expect(left.events.map((event) => event.type)).toEqual(['labels.changed'])
    const entered = await team.events({ after: start, filter: { labels: ['step=review'] } })
    expect(entered.events.map((event) => event.type)).toEqual(['labels.changed'])
    await team.reply({ to: root.id, text: 'later' })
    const later = await team.events({ after: left.cursor, filter: { labels: ['step=fix'] } })
    expect(later.events).toEqual([])
  })

  it('a stored cursor remembers a reader\'s place per profile and never moves back', async () => {
    const { team } = memoryBoard()
    await team.as('lead').cursorSet('inbox', 7)
    await team.as('lead').cursorSet('inbox', 3)
    expect(await team.as('lead').cursorGet('inbox')).toBe(7)
    expect(await team.as('worker').cursorGet('inbox')).toBeNull()
  })

  it('actors lists everyone who wrote, with the handle people mention them by', async () => {
    const { team } = memoryBoard()
    await team.post({ channel: 'dev', text: 'x' })
    await team.as('claude').post({ channel: 'dev', text: 'y' })
    expect((await team.actors()).actors).toEqual([
      { id: 'local:user:ada', handle: 'ada', principal: 'local:user:ada', profile: null },
      { id: 'local:user:ada+claude', handle: 'claude', principal: 'local:user:ada', profile: 'claude' },
    ])
  })

  it('the feed refuses a limit that is not a whole number of at least 1, and holds a large one to 1,000', async () => {
    const { team } = memoryBoard()
    for (let i = 0; i < 3; i++) await team.post({ channel: 'a', text: `m${i}` })
    expect(await reason(team.events({ after: 0, limit: -1 }))).toBe('invalid_limit')
    expect(await reason(team.events({ after: 0, limit: 0 }))).toBe('invalid_limit')
    expect(await reason(team.events({ after: 0, limit: 1.5 }))).toBe('invalid_limit')
    expect((await team.events({ after: 0, limit: 5000 })).events).toHaveLength(3)
    expect((await team.events({ after: 0, limit: 2 })).events).toHaveLength(2)
  })
})
