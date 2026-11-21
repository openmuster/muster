import { describe, expect, it } from 'vitest'
import { memoryBoard, reason, HTTP } from './helpers.ts'

const MIN = 60_000

describe('tasks', () => {
  it('a task is a thread the board keeps a state for, in a label only the board writes', async () => {
    const { team } = memoryBoard()
    const { task, message } = await team.taskCreate({ channel: 'work', text: 'fix the login redirect', labels: { step: 'fix' } })
    expect(task).toMatchObject({ id: message.id, state: 'ready', needs: [], claim: null, owner: { principal: 'local:user:ada', profile: null } })
    expect((await team.readThread({ id: task.id })).message.labels).toEqual({ step: 'fix', 'board.task': 'ready' })
  })

  it('makes a task of an existing thread, once, and never of a reply', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'work', text: 'the cache is stale' })
    const reply = await team.reply({ to: root.id, text: 'confirmed' })
    expect((await team.taskCreate({ thread: root.id })).task.state).toBe('ready')
    expect(await reason(team.taskCreate({ thread: root.id }))).toBe('already_a_task')
    expect(await reason(team.taskCreate({ thread: reply.id }))).toBe('not_a_root')
    expect(await reason(team.taskClaim({ id: reply.id }))).toBe('not_a_task')
  })

  it('claim, renew, complete: one holder, a lease, and a final result', async () => {
    const { team, time } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const claimed = await team.as('worker').taskClaim({ id: task.id, lease: 300 })
    expect(claimed.task).toMatchObject({ state: 'claimed', claim: { by: { profile: 'worker' }, epoch: 1, until: '2026-01-01T00:05:00.000Z' } })
    expect(await reason(team.as('other').taskClaim({ id: task.id }))).toBe('task_claimed')
    time.advance(2 * MIN)
    const renewed = await team.as('worker').taskRenew({ id: task.id, token: claimed.token, lease: 300 })
    expect(renewed.task.claim?.until).toBe('2026-01-01T00:07:00.000Z')
    const done = await team.as('worker').taskComplete({ id: task.id, token: claimed.token, result: 'fixed in a1b2c3' })
    expect(done.task).toMatchObject({ state: 'completed', result: 'fixed in a1b2c3', claim: null })
    expect(await reason(team.as('worker').taskClaim({ id: task.id }))).toBe('task_finished')
  })

  it('refuses a lease under 30 seconds or over an hour', async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    expect(await reason(team.taskClaim({ id: task.id, lease: 29 }))).toBe('invalid_lease')
    expect(await reason(team.taskClaim({ id: task.id, lease: 3601 }))).toBe('invalid_lease')
    expect((await team.taskClaim({ id: task.id, lease: 3600 })).task.state).toBe('claimed')
  })

  it("the holder's writes are fenced: no token, a wrong token, or a claim since taken changes nothing", async () => {
    const { team, time } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const first = await team.as('a').taskClaim({ id: task.id, lease: 60 })
    expect(await reason(team.as('a').taskComplete({ id: task.id, result: 'x' }))).toBe('claim_lost')
    expect(await reason(team.as('a').taskComplete({ id: task.id, token: 'not-the-token', result: 'x' }))).toBe('claim_lost')
    time.advance(2 * MIN)
    const second = await team.as('b').taskClaim({ id: task.id })
    expect(second.task.claim?.epoch).toBe(2)
    // Each is started and given its handler at once: started together and awaited in turn, one that failed
    // before its turn came would be an error nobody caught.
    const late = await Promise.all([team.as('a').taskComplete({ id: task.id, token: first.token, result: 'late' }), team.as('a').taskRenew({ id: task.id, token: first.token }), team.as('a').taskRelease({ id: task.id, token: first.token }), team.as('a').taskFail({ id: task.id, token: first.token, reason: 'late' })].map(reason))
    expect(late).toEqual(late.map(() => 'claim_lost'))
    expect(late.length).toBeGreaterThanOrEqual(4)
    expect((await team.task(task.id))).toMatchObject({ state: 'claimed', claim: { by: { profile: 'b' }, epoch: 2 } })
  })

  it('a lease is data: past its deadline the task is ready to anyone who looks, with no timer', async () => {
    const { team, time } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    await team.as('a').taskClaim({ id: task.id, lease: 60 })
    time.advance(59_000)
    expect((await team.task(task.id))?.state).toBe('claimed')
    time.advance(1000)
    expect((await team.task(task.id))?.state).toBe('ready')
    expect((await team.taskList({ state: 'ready' })).tasks.map((listed) => listed.id)).toEqual([task.id])
    const start = await team.head()
    await team.as('b').taskClaim({ ready: 'work' })
    const feed = await team.events({ after: start, filter: { re: task.id } })
    expect(feed.events.map((event) => event.type)).toEqual(['task.expired', 'task.claimed'])
  })

  // On a file only: a process ID sent over HTTP names nothing on the board's machine, and is dropped there.
  it.skipIf(HTTP)('a lapsed claim is kept while the process that holds it is still running, for an hour at most', async () => {
    const { team, time, alive } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 'slow model call' })
    alive.add('4242@Mon Jan  1 00:00:00 2026')
    await team.as('a').taskClaim({ id: task.id, lease: 60, pid: 4242, pidStart: 'Mon Jan  1 00:00:00 2026' })
    time.advance(10 * MIN)
    expect((await team.task(task.id))?.state).toBe('claimed')
    expect(await reason(team.as('b').taskClaim({ ready: 'work' }))).toBe('nothing_ready')
    expect((await team.events({ after: 0, filter: { types: ['task.extended'] } })).events).toHaveLength(1)
    time.advance(51 * MIN)
    expect((await team.task(task.id))?.state).toBe('ready')
    expect((await team.as('b').taskClaim({ ready: 'work' })).task.claim?.by.profile).toBe('b')
  })

  it('a recycled pid is not the holder: the same pid with another start time keeps nothing', async () => {
    const { team, time, alive } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    await team.as('a').taskClaim({ id: task.id, lease: 60, pid: 4242, pidStart: 'Mon Jan  1 00:00:00 2026' })
    alive.add('4242@Tue Jan  2 09:00:00 2026')
    time.advance(2 * MIN)
    expect((await team.task(task.id))?.state).toBe('ready')
  })

  it('holds a task that keeps being dropped: after two claims end with no result it is blocked as failing', async () => {
    const { team, time } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 'crashes its worker' })
    await team.as('a').taskClaim({ id: task.id, lease: 60 })
    time.advance(2 * MIN)
    await team.as('b').taskClaim({ id: task.id, lease: 60 })
    time.advance(2 * MIN)
    expect(await reason(team.as('c').taskClaim({ ready: 'work' }))).toBe('nothing_ready')
    expect(await team.task(task.id)).toMatchObject({ state: 'blocked', hold: { kind: 'failing' }, attempts: 2 })
    await team.taskUnblock({ id: task.id })
    expect((await team.task(task.id))?.state).toBe('ready')
  })

  it('a failure that says it should not count (a quota or auth error) leaves the attempts alone', async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const claimed = await team.taskClaim({ id: task.id })
    const failed = await team.taskFail({ id: task.id, token: claimed.token, reason: 'usage limit reached', counts: false })
    expect(failed.task).toMatchObject({ state: 'failed', reason: 'usage limit reached', attempts: 0 })
  })

  it('needs: a task waits until everything it needs completed, and a failure readies nothing', async () => {
    const { team } = memoryBoard()
    const a = (await team.taskCreate({ channel: 'work', text: 'a' })).task
    const b = (await team.taskCreate({ channel: 'work', text: 'b' })).task
    const ship = (await team.taskCreate({ channel: 'work', text: 'ship', needs: [a.id, b.id] })).task
    expect(ship.state).toBe('waiting')
    expect(await reason(team.taskClaim({ id: ship.id }))).toBe('task_waiting')
    const heldA = await team.taskClaim({ id: a.id })
    expect((await team.taskComplete({ id: a.id, token: heldA.token })).readied).toEqual([])
    const heldB = await team.taskClaim({ id: b.id })
    await team.taskFail({ id: b.id, token: heldB.token, reason: 'no' })
    expect((await team.task(ship.id))?.state).toBe('waiting')
    await team.taskReopen({ id: b.id })
    const again = await team.taskClaim({ id: b.id })
    expect((await team.taskComplete({ id: b.id, token: again.token })).readied).toEqual([ship.id])
    expect((await team.task(ship.id))?.state).toBe('ready')
  })

  it('refuses needs that are not tasks, were canceled, are too many, or would wait for themselves', async () => {
    const { team } = memoryBoard()
    const a = (await team.taskCreate({ channel: 'work', text: 'a' })).task
    const b = (await team.taskCreate({ channel: 'work', text: 'b', needs: [a.id] })).task
    const plain = await team.post({ channel: 'work', text: 'not a task' })
    const gone = (await team.taskCreate({ channel: 'work', text: 'gone' })).task
    await team.taskCancel({ id: gone.id })
    expect(await reason(team.taskCreate({ channel: 'work', text: 'x', needs: [plain.id] }))).toBe('invalid_needs')
    expect(await reason(team.taskCreate({ channel: 'work', text: 'x', needs: [gone.id] }))).toBe('invalid_needs')
    expect(await reason(team.taskCreate({ channel: 'work', text: 'x', needs: Array.from({ length: 21 }, (_, i) => i + 1) }))).toBe('invalid_needs')
    expect(await reason(team.taskNeeds({ id: a.id, needs: [b.id] }))).toBe('invalid_needs')
    expect(await reason(team.taskNeeds({ id: a.id, needs: [a.id] }))).toBe('invalid_needs')
    expect((await team.taskNeeds({ id: b.id, needs: [] })).task.state).toBe('ready')
  })

  it('--ready hands out the oldest ready task of your own, by channel and label, assigned ones first', async () => {
    const { team } = memoryBoard()
    const fix = (await team.taskCreate({ channel: 'work/api', text: 'fix', labels: { step: 'fix' } })).task
    const review = (await team.taskCreate({ channel: 'work/api', text: 'review', labels: { step: 'review' } })).task
    const mine = (await team.taskCreate({ channel: 'work/web', text: 'for bob', for: 'bob' })).task
    await team.taskCreate({ channel: 'other', text: 'elsewhere' })
    expect((await team.as('bob').taskClaim({ ready: 'work/' })).task.id).toBe(mine.id)
    expect((await team.as('amy').taskClaim({ ready: 'work/', labels: ['step=review'] })).task.id).toBe(review.id)
    expect((await team.as('amy').taskClaim({ ready: 'work/' })).task.id).toBe(fix.id)
    expect(await reason(team.as('amy').taskClaim({ ready: 'work/' }))).toBe('nothing_ready')
  })

  it("a task for one profile is that profile's alone, by ID too", async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't', for: 'bob' })
    expect(await reason(team.as('amy').taskClaim({ id: task.id }))).toBe('task_assigned')
    expect(await reason(team.as('amy').taskClaim({ ready: 'work' }))).toBe('nothing_ready')
    await team.taskAssign({ id: task.id, for: null })
    expect((await team.as('amy').taskClaim({ ready: 'work' })).task.id).toBe(task.id)
  })

  it("--ready never takes a stranger's task unless --from names its owner", async () => {
    const ada = memoryBoard()
    const { task } = await ada.team.taskCreate({ channel: 'work', text: 'do as I say' })
    const eve = ada.as('local:user:eve')
    expect(await reason(eve.taskClaim({ ready: 'work' }))).toBe('nothing_ready')
    expect(await reason(eve.taskClaim({ ready: 'work', from: ['ada'] }))).toBe('invalid_from')
    expect(await reason(eve.taskClaim({ ready: 'work', from: ['local:user:ada+lead'] }))).toBe('invalid_from')
    expect((await eve.taskClaim({ ready: 'work', from: ['local:user:ada'] })).task.id).toBe(task.id)
  })

  it('only the owner changes an unclaimed task; another principal is refused', async () => {
    const ada = memoryBoard()
    const { task } = await ada.team.taskCreate({ channel: 'work', text: 't' })
    const eve = ada.as('local:user:eve')
    const attempts = await Promise.all([eve.taskCancel({ id: task.id }), eve.taskBlock({ id: task.id, reason: 'mine now' }), eve.taskAssign({ id: task.id, for: 'eve' }), eve.taskNeeds({ id: task.id, needs: [] }), eve.taskUnblock({ id: task.id })].map(reason))
    expect(attempts).toEqual(['task_not_owned', 'task_not_owned', 'task_not_owned', 'task_not_owned', 'task_not_owned'])
    expect((await ada.team.task(task.id))?.state).toBe('ready')
  })

  it("someone else's edit of a task's root holds the task as edited; the owner's own edit does not", async () => {
    const ada = memoryBoard()
    const { task } = await ada.team.taskCreate({ channel: 'work', text: 'fix /login' })
    await ada.team.edit({ id: task.id, text: 'fix /login and /signin' })
    expect((await ada.team.task(task.id))?.state).toBe('ready')
    await ada.as('local:user:eve').edit({ id: task.id, text: 'delete the database' })
    expect(await ada.team.task(task.id)).toMatchObject({ state: 'blocked', hold: { kind: 'edited' } })
    expect(await reason(ada.team.taskBlock({ id: task.id, kind: 'edited' }))).toBe('reserved_kind')
  })

  it("deleting a task's root cancels it", async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    await team.remove({ id: task.id })
    expect((await team.taskList({ state: 'canceled' })).tasks.map((listed) => listed.id)).toEqual([task.id])
  })

  it('block holds a task for a person with a kind of your own, and ends the claim', async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const claimed = await team.as('w').taskClaim({ id: task.id })
    const blocked = await team.as('w').taskBlock({ id: task.id, token: claimed.token, reason: 'ship at 100 or 500 rps?', kind: 'awaiting_approval' })
    expect(blocked.task).toMatchObject({ state: 'blocked', hold: { kind: 'awaiting_approval', reason: 'ship at 100 or 500 rps?' }, claim: null })
    expect(await reason(team.as('w').taskComplete({ id: task.id, token: claimed.token }))).toBe('claim_lost')
    expect((await team.taskUnblock({ id: task.id }))).toMatchObject({ changed: true, task: { state: 'ready' } })
    expect((await team.taskUnblock({ id: task.id })).changed).toBe(false)
    expect(await reason(team.taskBlock({ id: task.id, kind: 'Not A Kind' }))).toBe('invalid_kind')
  })

  it('a review that sends work back reopens the completed task as a new round', async () => {
    const { team } = memoryBoard()
    const work = (await team.taskCreate({ channel: 'work', text: 'limiter' })).task
    const review = (await team.taskCreate({ channel: 'work', text: 'review the limiter', needs: [work.id] })).task
    const held = await team.taskClaim({ id: work.id })
    await team.taskComplete({ id: work.id, token: held.token, result: 'done' })
    const reviewing = await team.taskClaim({ id: review.id })
    await team.taskFail({ id: review.id, token: reviewing.token, reason: 'changes requested: no test for the store being down' })
    expect(await reason(team.taskReopen({ id: work.id }))).toBe('task_finished')
    const back = await team.taskReopen({ id: work.id, round: true })
    expect(back.task).toMatchObject({ state: 'ready', rounds: 1, result: null })
  })

  it('a result or a reason over 1,000 characters is refused', async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const held = await team.taskClaim({ id: task.id })
    expect(await reason(team.taskComplete({ id: task.id, token: held.token, result: 'x'.repeat(1001) }))).toBe('text_too_long')
    expect((await team.task(task.id))?.state).toBe('claimed')
  })

  it('queues a plan in one write, each task after the ones it waits for, and a retry makes nothing twice', async () => {
    const { team } = memoryBoard()
    const plan = [
      { key: 'limiter', text: 'Add a rate limiter', labels: { role: 'worker' } },
      { key: 'review', text: 'Review the limiter', labels: { role: 'reviewer' }, needs: [{ key: 'limiter' }] },
    ]
    const made = await team.taskPlan({ channel: 'work/checkout', tasks: plan, idempotencyKey: 'checkout-limiter' })
    expect(made.tasks.map((task) => [task.key, task.state])).toEqual([['limiter', 'ready'], ['review', 'waiting']])
    expect(made.tasks[1]!.needs).toEqual([made.tasks[0]!.id])
    const again = await team.taskPlan({ channel: 'work/checkout', tasks: plan, idempotencyKey: 'checkout-limiter' })
    expect(again.tasks.map((task) => task.id)).toEqual(made.tasks.map((task) => task.id))
    expect((await team.taskList({ state: 'all' })).tasks).toHaveLength(2)
    expect(await reason(team.taskPlan({ channel: 'work', tasks: [{ key: 'a', text: 'a', needs: [{ key: 'later' }] }, { key: 'later', text: 'l' }] }))).toBe('invalid_plan')
    expect((await team.taskList({ state: 'all' })).tasks).toHaveLength(2)
  })

  it('lists open tasks oldest first by default, and any one state on request', async () => {
    const { team } = memoryBoard()
    const a = (await team.taskCreate({ channel: 'work', text: 'a' })).task
    const b = (await team.taskCreate({ channel: 'work', text: 'b', needs: [a.id] })).task
    const c = (await team.taskCreate({ channel: 'work', text: 'c' })).task
    const held = await team.taskClaim({ id: c.id })
    await team.taskComplete({ id: c.id, token: held.token })
    expect((await team.taskList()).tasks.map((task) => [task.id, task.state])).toEqual([[a.id, 'ready'], [b.id, 'waiting']])
    expect((await team.taskList({ state: 'completed' })).tasks.map((task) => task.id)).toEqual([c.id])
    expect((await team.taskList({ state: 'all' })).tasks).toHaveLength(3)
    expect(await reason(team.taskList({ state: 'done' as never }))).toBe('invalid_state')
  })

  it('a waiter on task outcomes hears a completion, a hold, and a failure, by the label the board keeps', async () => {
    const { team } = memoryBoard()
    const a = (await team.taskCreate({ channel: 'work', text: 'a' })).task
    const b = (await team.taskCreate({ channel: 'work', text: 'b' })).task
    const start = await team.head()
    const heldA = await team.taskClaim({ id: a.id })
    const heldB = await team.taskClaim({ id: b.id })
    await team.taskComplete({ id: a.id, token: heldA.token })
    await team.taskBlock({ id: b.id, token: heldB.token, reason: '?' })
    const feed = await team.events({ after: start, filter: { channel: 'work', labels: ['board.task=completed|blocked|failed'], types: ['task.completed', 'task.blocked', 'task.failed'] } })
    expect(feed.events.map((event) => [event.type, event.task?.id])).toEqual([['task.completed', a.id], ['task.blocked', b.id]])
  })

  it("a claim's secret never appears in the feed", async () => {
    const { team } = memoryBoard()
    const { task } = await team.taskCreate({ channel: 'work', text: 't' })
    const held = await team.taskClaim({ id: task.id })
    const feed = JSON.stringify(await team.events({ after: 0 }))
    expect(feed).not.toContain(held.token)
    expect(feed).not.toContain('"token"')
  })

  it('a machine that slept gives its leases the time back: a claim live when the gap began is extended by the gap', async () => {
    const { team, time } = memoryBoard()
    const live = (await team.taskCreate({ channel: 'work', text: 'held across the sleep' })).task
    const lapsed = (await team.taskCreate({ channel: 'work', text: 'already over before it' })).task
    await team.as('a').taskClaim({ id: lapsed.id, lease: 30 })
    time.advance(60_000)
    const held = await team.as('b').taskClaim({ id: live.id, lease: 600 })
    await team.scheduleTick()
    time.advance(1000)
    await team.scheduleTick()
    time.advance(2 * 60 * 60_000)
    expect((await team.task(live.id))?.state).toBe('ready')
    await team.scheduleTick()
    const after = await team.task(live.id)
    expect(after).toMatchObject({ state: 'claimed', claim: { by: { profile: 'b' } } })
    expect(Date.parse(after!.claim!.until) - Date.parse(held.task.claim!.until)).toBe(2 * 60 * 60_000)
    expect((await team.task(lapsed.id))?.state).toBe('ready')
    expect((await team.as('b').taskComplete({ id: live.id, token: held.token })).task.state).toBe('completed')
  })

  it('a budget on a channel stops new claims once its tasks have cost that much, and work already claimed carries on', async () => {
    const { team } = memoryBoard()
    await team.budgetSet({ channel: 'work', usd: 1 })
    const a = (await team.taskCreate({ channel: 'work/api', text: 'a' })).task
    const b = (await team.taskCreate({ channel: 'work/web', text: 'b' })).task
    const elsewhere = (await team.taskCreate({ channel: 'other', text: 'c' })).task
    const held = await team.taskClaim({ id: a.id })
    await team.label({ id: a.id, set: { cost: '1.25' } })
    expect(await reason(team.taskClaim({ id: b.id }))).toBe('over_budget')
    expect(await reason(team.taskClaim({ ready: 'work/' }))).toBe('over_budget')
    expect((await team.taskComplete({ id: a.id, token: held.token })).task.state).toBe('completed')
    expect((await team.taskClaim({ id: elsewhere.id })).task.state).toBe('claimed')
    expect((await team.budgets()).budgets).toEqual([{ channel: 'work', usd: 1, spent: 1.25 }])
    await team.budgetSet({ channel: 'work', usd: 5 })
    expect((await team.taskClaim({ ready: 'work/' })).task.id).toBe(b.id)
    await team.budgetSet({ channel: 'work', usd: null })
    expect((await team.budgets()).budgets).toEqual([])
    expect(await reason(team.budgetSet({ channel: 'work', usd: -1 }))).toBe('invalid_budget')
  })

  it("another profile of the owner's principal editing a task's brief holds it too: ownership is the principal and the profile", async () => {
    const { team } = memoryBoard()
    const { task } = await team.as('lead').taskCreate({ channel: 'work', text: 'fix /login' })
    await team.as('lead').edit({ id: task.id, text: 'fix /login and /signin' })
    expect((await team.task(task.id))?.state).toBe('ready')
    await team.edit({ id: task.id, text: 'the principal itself may' })
    expect((await team.task(task.id))?.state).toBe('ready')
  })

  it('a task list refuses a limit that is not a whole number of at least 1', async () => {
    const { team } = memoryBoard()
    for (let i = 0; i < 3; i++) await team.taskCreate({ channel: 'work', text: `t${i}` })
    expect(await reason(team.taskList({ limit: -1 }))).toBe('invalid_limit')
    expect(await reason(team.taskList({ limit: 0 }))).toBe('invalid_limit')
    expect(await reason(team.taskList({ limit: 1.5 }))).toBe('invalid_limit')
    expect((await team.taskList({ limit: 2 })).tasks).toHaveLength(2)
    expect((await team.taskList({ limit: 5000 })).tasks).toHaveLength(3)
  })
})
