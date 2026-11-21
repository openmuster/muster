import type { Board } from './handle.ts'

export type Check = { name: string; ok: boolean; detail?: string }

const reasonOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'threw'
  }
  return 'did not fail'
}

/**
 * What any backend must do, checked through a handle, in a channel of its own. A backend that passes
 * behaves like a board to everything built on one. It writes real messages: point it at a scratch board.
 */
export async function conformance(team: Board): Promise<Check[]> {
  const out: Check[] = []
  const channel = `conformance/${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const check = async (name: string, run: () => Promise<boolean | string>) => {
    try {
      const result = await run()
      out.push(result === true ? { name, ok: true } : { name, ok: false, detail: result === false ? 'the check failed' : result })
    } catch (error) {
      out.push({ name, ok: false, detail: String((error as Error).message ?? error) })
    }
  }
  const a = team.as('conformance-a')
  const b = team.as('conformance-b')

  let root = 0
  await check('a post is a thread root written by its caller', async () => {
    const message = await a.post({ channel, text: 'root' })
    root = message.id
    return message.re === null && message.thread === message.id && message.by.profile === 'conformance-a'
  })
  await check('a reply to a reply lands on the root', async () => {
    const first = await b.reply({ to: root, text: 'one' })
    const second = await a.reply({ to: first.id, text: 'two' })
    return second.re === root && second.replyTo === first.id
  })
  await check('a thread reads back in order', async () => (await team.readThread({ id: root })).replies.map((reply) => reply.text).join() === 'one,two')
  await check('an idempotency key posts once and refuses a different request', async () => {
    const first = await a.post({ channel, text: 'once', idempotencyKey: `k-${channel}` })
    const again = await a.post({ channel, text: 'once', idempotencyKey: `k-${channel}` })
    return first.id === again.id && (await reasonOf(a.post({ channel, text: 'other', idempotencyKey: `k-${channel}` }))) === 'idempotency_mismatch'
  })
  await check('reply --after refuses when something landed since', async () => (await reasonOf(a.reply({ to: root, text: 'late', after: root }))) === 'newer_message')
  await check('a conditional label has one winner', async () => {
    await a.label({ id: root, set: { owner: 'a' }, ifUnset: ['owner'] })
    return (await reasonOf(b.label({ id: root, set: { owner: 'b' }, ifUnset: ['owner'] }))) === 'label_conflict'
  })
  await check('the board keeps its own labels', async () => (await reasonOf(a.label({ id: root, set: { 'board.task': 'completed' } }))) === 'reserved_label')
  await check('an edit raises the revision and a stale one is refused', async () => {
    const edited = await a.edit({ id: root, text: 'root, edited', ifRevision: 1 })
    return edited.revision === 2 && (await reasonOf(a.edit({ id: root, text: 'x', ifRevision: 1 }))) === 'revision_conflict'
  })
  await check("a profile can't change another profile's message", async () => (await reasonOf(b.edit({ id: root, text: 'theirs' }))) === 'not_yours')
  await check('a cursor shows only what came after it', async () => {
    const { cursor } = await team.readChannel({ channel })
    if ((await team.readChannel({ channel, after: cursor })).threads.length !== 0) return 'something was newer than the cursor just read'
    await b.react({ id: root, emoji: 'eyes' })
    return (await team.readChannel({ channel, after: cursor })).threads.length === 1
  })
  await check('the feed resumes from its cursor with no gap or repeat', async () => {
    const start = await team.head()
    for (let i = 0; i < 5; i++) await a.post({ channel, text: `feed ${i}` })
    const seen: string[] = []
    let after = start
    for (;;) {
      const page = await team.events({ after, filter: { channel, types: ['message.posted'] }, limit: 2 })
      if (page.events.length === 0) break
      seen.push(...page.events.map((event) => String(event.data.text)))
      after = page.cursor
    }
    return seen.join() === 'feed 0,feed 1,feed 2,feed 3,feed 4' || `saw ${seen.join()}`
  })

  let work = 0
  let token = ''
  await check('a task is ready, and waits for what it needs', async () => {
    work = (await a.taskCreate({ channel, text: 'work' })).task.id
    const waits = (await a.taskCreate({ channel, text: 'after', needs: [work] })).task
    return waits.state === 'waiting' && (await reasonOf(b.taskClaim({ id: waits.id }))) === 'task_waiting'
  })
  await check('one claim at a time', async () => {
    token = (await b.taskClaim({ id: work, lease: 60 })).token
    return (await reasonOf(a.taskClaim({ id: work }))) === 'task_claimed'
  })
  await check("a write without the claim's token changes nothing", async () => (await reasonOf(a.taskComplete({ id: work, token: 'not-it', result: 'x' }))) === 'claim_lost' && (await team.task(work))?.state === 'claimed')
  await check('completing readies what waited', async () => {
    const done = await b.taskComplete({ id: work, token, result: 'done' })
    return done.task.state === 'completed' && done.readied.length === 1
  })
  await check("a claim's secret is not in the feed", async () => !JSON.stringify(await team.events({ after: 0, filter: { channel } })).includes(token))
  await check('a block holds a task with a kind, and unblock readies it', async () => {
    const task = (await a.taskCreate({ channel, text: 'ask' })).task
    const held = await a.taskBlock({ id: task.id, reason: '?', kind: 'awaiting_approval' })
    return held.task.hold?.kind === 'awaiting_approval' && (await a.taskUnblock({ id: task.id })).task.state === 'ready'
  })
  await check('the last active tasks are listed on request, the latest last', async () => {
    const first = (await a.taskCreate({ channel, text: 'made first' })).task.id
    const second = (await a.taskCreate({ channel, text: 'made second' })).task.id
    await b.reply({ to: first, text: 'said last' })
    const latest = (await team.taskList({ channel, state: 'all', latest: true, limit: 2 })).tasks.map((task) => task.id)
    return latest.join() === `${second},${first}` || `listed ${latest.join()}`
  })
  await check('what does not exist is not found', async () => (await reasonOf(team.readThread({ id: 2_000_000_000 }))) === 'not_found')
  return out
}
