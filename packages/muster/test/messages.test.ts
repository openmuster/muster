import { describe, expect, it } from 'vitest'
import { memoryBoard, reason } from './helpers.ts'

describe('messages', () => {
  it('a post is a thread root, and a reply to a reply lands on the root', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'deploy is red' })
    const first = await team.reply({ to: root.id, text: 'looking' })
    const second = await team.reply({ to: first.id, text: 'found it' })
    expect(root).toMatchObject({ re: null, thread: root.id, channel: 'dev', revision: 1 })
    expect(second).toMatchObject({ re: root.id, thread: root.id, replyTo: first.id })
    expect(first.replyTo).toBeNull()
    const thread = await team.readThread({ id: second.id })
    expect(thread.message.id).toBe(root.id)
    expect(thread.replies.map((reply) => reply.text)).toEqual(['looking', 'found it'])
  })

  it('who wrote a message comes from the caller, never from what was sent', async () => {
    const { team } = memoryBoard()
    const forged = { channel: 'dev', text: 'hi', by: { principal: 'local:user:mallory', profile: null } } as never
    const message = await team.as('claude').post(forged)
    expect(message.by).toEqual({ principal: 'local:user:ada', profile: 'claude' })
  })

  it('refuses text that is empty or over 10,000 characters, and more than 10 files', async () => {
    const { team } = memoryBoard()
    expect(await reason(team.post({ channel: 'dev', text: '' }))).toBe('empty_text')
    expect(await reason(team.post({ channel: 'dev', text: 'x'.repeat(10_001) }))).toBe('text_too_long')
    await team.post({ channel: 'dev', text: 'x'.repeat(10_000) })
    const stored = await team.filePut({ name: 'f', data: Buffer.from('x').toString('base64') })
    const files = Array.from({ length: 11 }, (_, i) => ({ ...stored, name: `f${i}` }))
    expect(await reason(team.post({ channel: 'dev', text: 'files', attachments: files }))).toBe('too_many_attachments')
  })

  it('refuses a channel that is not a lowercase path', async () => {
    const { team } = memoryBoard()
    for (const channel of ['Dev', 'dev//x', '', 'dev/', '/dev', 'de v']) expect(await reason(team.post({ channel, text: 'x' }))).toBe('invalid_channel')
    expect((await team.post({ channel: '#db/storage', text: 'x' })).channel).toBe('db/storage')
  })

  it('settles a mention of a known actor and leaves an unknown one as written', async () => {
    const { team } = memoryBoard()
    await team.as('claude').post({ channel: 'dev', text: 'here' })
    const message = await team.post({ channel: 'dev', text: 'ping @claude and @nobody' })
    expect(message.text).toBe('ping @[local:user:ada+claude] and @nobody')
    const feed = await team.events({ after: 0, filter: { mentions: 'claude' } })
    expect(feed.events.map((event) => event.message?.id)).toEqual([message.id])
  })

  it('an edit raises the revision, and --if-revision refuses a stale one', async () => {
    const { team } = memoryBoard()
    const message = await team.post({ channel: 'dev', text: 'v1' })
    const edited = await team.edit({ id: message.id, text: 'v2', ifRevision: 1 })
    expect(edited).toMatchObject({ text: 'v2', revision: 2 })
    expect(edited.editedAt).not.toBeNull()
    expect(await reason(team.edit({ id: message.id, text: 'v3', ifRevision: 1 }))).toBe('revision_conflict')
    expect((await team.readThread({ id: message.id })).message.text).toBe('v2')
  })

  it("a profile changes only its own messages; the principal itself changes its profiles' too", async () => {
    const { team } = memoryBoard()
    const mine = await team.as('claude').post({ channel: 'dev', text: 'mine' })
    expect(await reason(team.as('codex').edit({ id: mine.id, text: 'theirs' }))).toBe('not_yours')
    expect(await reason(team.as('codex').remove({ id: mine.id }))).toBe('not_yours')
    expect((await team.edit({ id: mine.id, text: 'fixed' })).text).toBe('fixed')
  })

  it('a delete leaves a tombstone without text, labels, or reactions', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'secret plan', labels: { kind: 'plan' } })
    const reply = await team.reply({ to: root.id, text: 'oops' })
    await team.react({ id: reply.id, emoji: 'eyes' })
    const gone = await team.remove({ id: reply.id })
    expect(gone).toMatchObject({ deleted: true, text: '', labels: {}, reactions: {} })
    expect((await team.readThread({ id: root.id })).replies).toEqual([])
    expect((await team.search({ text: 'oops' })).messages).toEqual([])
  })

  it('labels: sets, unsets, and refuses bad keys, long values, and the board\'s own keys', async () => {
    const { team } = memoryBoard()
    const message = await team.post({ channel: 'dev', text: 'x', labels: { step: 'fix' } })
    const labeled = await team.label({ id: message.id, set: { verdict: 'pass' }, unset: ['step'] })
    expect(labeled.labels).toEqual({ verdict: 'pass' })
    expect(await reason(team.label({ id: message.id, set: { Verdict: 'x' } }))).toBe('invalid_label')
    expect(await reason(team.label({ id: message.id, set: { v: 'x'.repeat(257) } }))).toBe('invalid_label')
    expect(await reason(team.label({ id: message.id, set: { v: 'a\nb' } }))).toBe('invalid_label')
    expect(await reason(team.label({ id: message.id, set: { 'board.task': 'completed' } }))).toBe('reserved_label')
    expect(await reason(team.post({ channel: 'dev', text: 'x', labels: { 'board.task': 'ready' } }))).toBe('reserved_label')
  })

  it('a conditional label change lands only when the label is as the caller expects', async () => {
    const { team } = memoryBoard()
    const message = await team.post({ channel: 'dev', text: 'who takes this?' })
    await team.as('fixer').label({ id: message.id, set: { owner: 'fixer' }, ifUnset: ['owner'] })
    expect(await reason(team.as('other').label({ id: message.id, set: { owner: 'other' }, ifUnset: ['owner'] }))).toBe('label_conflict')
    expect(await reason(team.label({ id: message.id, set: { owner: 'x' }, if: { owner: 'other' } }))).toBe('label_conflict')
    const moved = await team.label({ id: message.id, set: { owner: 'next' }, if: { owner: 'fixer' } })
    expect(moved.labels.owner).toBe('next')
  })

  it('reactions add once per actor and come off again', async () => {
    const { team } = memoryBoard()
    const message = await team.post({ channel: 'dev', text: 'x' })
    await team.as('a').react({ id: message.id, emoji: ':eyes:' })
    await team.as('a').react({ id: message.id, emoji: 'eyes' })
    const two = await team.as('b').react({ id: message.id, emoji: 'eyes' })
    expect(two.reactions.eyes).toEqual(['local:user:ada+a', 'local:user:ada+b'])
    const one = await team.as('a').react({ id: message.id, emoji: 'eyes', remove: true })
    expect(one.reactions.eyes).toEqual(['local:user:ada+b'])
    expect((await team.as('b').react({ id: message.id, emoji: 'eyes', remove: true })).reactions).toEqual({})
  })

  it('reply --after posts only if nothing landed since', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'ship it?' })
    const seen = await team.reply({ to: root.id, text: 'checking' })
    const late = await team.as('other').reply({ to: root.id, text: 'wait, no' })
    expect(await reason(team.reply({ to: root.id, text: 'shipped', after: seen.id }))).toBe('newer_message')
    expect((await team.reply({ to: root.id, text: 'holding', after: late.id })).text).toBe('holding')
  })

  it('an idempotency key makes a retry post once, and refuses a different request', async () => {
    const { team } = memoryBoard()
    const first = await team.post({ channel: 'dev', text: 'deployed a1b2', idempotencyKey: 'deploy-a1b2' })
    const again = await team.post({ channel: 'dev', text: 'deployed a1b2', idempotencyKey: 'deploy-a1b2' })
    expect(again.id).toBe(first.id)
    expect((await team.readChannel({ channel: 'dev' })).threads).toHaveLength(1)
    expect(await reason(team.post({ channel: 'dev', text: 'deployed c3d4', idempotencyKey: 'deploy-a1b2' }))).toBe('idempotency_mismatch')
    const other = await team.as('codex').post({ channel: 'dev', text: 'deployed a1b2', idempotencyKey: 'deploy-a1b2' })
    expect(other.id).not.toBe(first.id)
  })

  it('a key matched by shape gives a retry with other words the first answer, and refuses one that writes somewhere else', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'dev', text: 'build broke' })
    const other = await team.post({ channel: 'dev', text: 'another' })
    const shape = { idempotencyKey: 'wake-7-reply-1', idempotencyMatch: 'shape' as const }
    const first = await team.reply({ to: root.id, text: 'looking at it', ...shape })
    expect((await team.reply({ to: root.id, text: 'on it now', ...shape })).id).toBe(first.id)
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['looking at it'])
    expect(await reason(team.reply({ to: other.id, text: 'looking at it', ...shape }))).toBe('idempotency_mismatch')
    expect(await reason(team.label({ id: root.id, set: { seen: 'yes' }, ...shape }))).toBe('idempotency_mismatch')
    // Labels and tasks keep their place the same way.
    const labelled = { idempotencyKey: 'wake-7-label-1', idempotencyMatch: 'shape' as const }
    await team.label({ id: root.id, set: { step: 'fix' }, ...labelled })
    expect((await team.label({ id: root.id, set: { step: 'review' }, ...labelled })).labels.step).toBe('fix')
    // Without it, a key still compares the whole request.
    await team.reply({ to: root.id, text: 'exact', idempotencyKey: 'exact-1' })
    expect(await reason(team.reply({ to: root.id, text: 'exactly', idempotencyKey: 'exact-1' }))).toBe('idempotency_mismatch')
  })

  it('a message that does not exist is not found, whatever is asked of it', async () => {
    const { team } = memoryBoard()
    expect(await reason(team.readThread({ id: 99 }))).toBe('not_found')
    expect(await reason(team.reply({ to: 99, text: 'x' }))).toBe('not_found')
    expect(await reason(team.edit({ id: 99, text: 'x' }))).toBe('not_found')
    expect(await reason(team.label({ id: 99, set: { a: 'b' } }))).toBe('not_found')
    expect(await reason(team.react({ id: 99, emoji: 'eyes' }))).toBe('not_found')
  })

  it("a file's name and type on a message are held to 255 characters, and one change unsets at most 64 labels", async () => {
    const { team } = memoryBoard()
    const stored = await team.filePut({ name: 'f', data: Buffer.from('x').toString('base64') })
    expect(await reason(team.post({ channel: 'dev', text: 'long name', attachments: [{ ...stored, name: 'n'.repeat(256) }] }))).toBe('invalid_file')
    expect(await reason(team.post({ channel: 'dev', text: 'long type', attachments: [{ ...stored, type: 't'.repeat(256) }] }))).toBe('invalid_file')
    const message = await team.post({ channel: 'dev', text: 'at the edge', attachments: [{ ...stored, name: 'n'.repeat(255), type: 't'.repeat(255) }] })
    expect(message.attachments[0]!.name).toHaveLength(255)
    const keys = (count: number) => Array.from({ length: count }, (_, i) => `k${i}`)
    expect(await reason(team.label({ id: message.id, unset: keys(65) }))).toBe('too_many_labels')
    await team.label({ id: message.id, unset: keys(64) })
  })
})
