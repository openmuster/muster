import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Failure, misuse } from '../failure.ts'
import { channelScope, inScope, labelFilter, matchesLabels, profileName, type By, type Caller, type Message } from '../model.ts'
import { append, type Draft } from '../store/log.ts'
import { allowed, authorize, byOf, findMessage, limitOf, messageFor, once, type Context } from './context.ts'
import { hooks, post, type PostRequest } from './messages.ts'

export const LEASE_MIN_S = 30
export const LEASE_DEFAULT_S = 900
export const LEASE_MAX_S = 3600
/** How long past its last renewal a claim is kept for a holder whose process is still alive. */
export const STALE_BACKSTOP_S = 3600
/** How many claims may end without a result before the board holds the task. */
export const MAX_ATTEMPTS = 2
export const NEEDS_MAX = 20
export const NEEDS_WALK_MAX = 500
export const FROM_MAX = 32
export const PLAN_MAX = 100
const RESULT_MAX = 1000
const KIND = /^[a-z0-9][a-z0-9_.-]{0,63}$/

export const TASK_STATES = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled'] as const
export type TaskState = (typeof TASK_STATES)[number]
export const OPEN_STATES: readonly TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']

export type Task = {
  id: number
  channel: string
  owner: By
  for: string | null
  state: TaskState
  needs: number[]
  hold: { kind: string; reason: string | null } | null
  result: string | null
  reason: string | null
  claim: { by: By; until: string; epoch: number } | null
  attempts: number
  rounds: number
}

type TaskRow = {
  id: number
  owner: string
  owner_profile: string | null
  for_profile: string | null
  state: TaskState
  hold_kind: string | null
  hold_reason: string | null
  result: string | null
  reason: string | null
  epoch: number
  claim_principal: string | null
  claim_profile: string | null
  claim_until: string | null
  claim_token: string | null
  claim_renewed: string | null
  claim_pid: number | null
  claim_pid_start: string | null
  attempts: number
  rounds: number
}

type Emit = (draft: Draft) => { seq: number }

const rowOf = (ctx: Context, id: number) => ctx.db.raw.prepare('select * from tasks where id = ?').get(id) as TaskRow | undefined

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
const sameHash = (token: string, hash: string) => {
  const a = Buffer.from(hashOf(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Whether a claim's lease has run out. */
const lapsed = (row: TaskRow, now: number) => row.state === 'claimed' && Date.parse(row.claim_until!) <= now

/** Whether a lapsed claim is kept because the process that holds it is still the one running. */
function kept(ctx: Context, row: TaskRow, now: number): boolean {
  if (row.claim_pid === null || row.claim_pid_start === null) return false
  if (now - Date.parse(row.claim_renewed!) >= STALE_BACKSTOP_S * 1000) return false
  return ctx.alive(row.claim_pid, row.claim_pid_start)
}

function toTask(ctx: Context, row: TaskRow, root: Message): Task {
  const now = ctx.now().getTime()
  // A claim whose lease ran out is over whenever anyone looks, whatever the row still says.
  const over = lapsed(row, now) && !kept(ctx, row, now)
  const needs = (ctx.db.raw.prepare('select needs from needs where task = ? order by needs').all(row.id) as { needs: number }[]).map((need) => need.needs)
  return {
    id: row.id,
    channel: root.channel,
    owner: { principal: row.owner, profile: row.owner_profile },
    for: row.for_profile,
    state: over ? 'ready' : row.state,
    needs,
    hold: row.state === 'blocked' ? { kind: row.hold_kind!, reason: row.hold_reason } : null,
    result: row.result,
    reason: row.reason,
    claim: row.state === 'claimed' && !over ? { by: { principal: row.claim_principal!, profile: row.claim_profile }, until: row.claim_until!, epoch: row.epoch } : null,
    attempts: row.attempts,
    rounds: row.rounds,
  }
}

export function findTask(ctx: Context, id: number): Task | null {
  const row = rowOf(ctx, id)
  if (!row) return null
  const root = findMessage(ctx.db, id)
  return root ? toTask(ctx, row, root) : null
}

const view = (ctx: Context, id: number) => findTask(ctx, id)!

function taskFor(ctx: Context, caller: Caller, id: number): { row: TaskRow; root: Message } {
  const root = messageFor(ctx, caller, id)
  const row = root.re === null ? rowOf(ctx, root.id) : undefined
  if (!row) throw new Failure('not_a_task', `${id} isn't a task.`, { next: [`mu tasks create ${id}`] })
  return { row, root }
}

/**
 * Brings a task whose lease ran out up to date, inside a write: a live local holder keeps it for
 * another lease; anything else gives it back, and the board holds a task that keeps being dropped.
 */
function settleLapse(ctx: Context, row: TaskRow, root: Message, emit: Emit): TaskRow {
  const now = ctx.now().getTime()
  if (!lapsed(row, now)) return row
  const board: By = { principal: 'board', profile: null }
  if (kept(ctx, row, now)) {
    const until = Math.min(now + LEASE_DEFAULT_S * 1000, Date.parse(row.claim_renewed!) + STALE_BACKSTOP_S * 1000)
    emit({ type: 'task.extended', by: board, channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, until: new Date(until).toISOString() } })
    return rowOf(ctx, row.id)!
  }
  emit({ type: 'task.expired', by: board, channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, from: 'claimed' } })
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    emit({
      type: 'task.blocked',
      by: board,
      channel: root.channel,
      thread: root.id,
      data: { id: row.id, kind: 'failing', reason: `${row.attempts + 1} claims ended without a result.`, from: 'ready' },
    })
  }
  return rowOf(ctx, row.id)!
}

const leaseMs = (seconds: number | undefined) => {
  const lease = seconds ?? LEASE_DEFAULT_S
  if (!Number.isFinite(lease) || lease < LEASE_MIN_S || lease > LEASE_MAX_S) {
    throw misuse('invalid_lease', `A lease is ${LEASE_MIN_S} seconds to 1 hour.`)
  }
  return lease * 1000
}

const manages = (caller: Caller, channel: string) => caller.can !== undefined && allowed(caller, channel, 'manage')

/** Whether `caller` owns the task: its principal made it, and as a profile only the profile that made it. */
const owns = (caller: Caller, row: TaskRow) => caller.principal === row.owner && (caller.profile === null || caller.profile === row.owner_profile)

function mustOwn(caller: Caller, row: TaskRow, root: Message) {
  if (owns(caller, row) || manages(caller, root.channel)) return
  throw new Failure('task_not_owned', `Task ${row.id} isn't yours to change.`, { hint: 'Its owner can, or the agent that holds it.' })
}

/**
 * The holder's proof: the task is still claimed under the token the board gave. A caller that sends a
 * token held a claim once, so whatever became of the task that claim is lost, and it must stop. One that
 * sends none never held it: it is told where the task stands, and what comes first.
 */
function fence(ctx: Context, row: TaskRow, token: string | undefined) {
  if (row.state === 'claimed' && token && row.claim_token && sameHash(token, row.claim_token)) return
  const read = [`mu read ${row.id}`]
  if (token) {
    throw new Failure('claim_lost', `You no longer hold task ${row.id}.`, {
      hint: "Stop working it and say so in its thread. Don't settle it.",
      next: read,
    })
  }
  if (row.state === 'claimed') {
    throw new Failure('claim_lost', `Task ${row.id} is held under a claim, and this isn't it.`, {
      hint: "Only its holder settles it. If that was you, stop and say so in its thread.",
      next: read,
    })
  }
  if (row.state === 'ready') {
    throw new Failure('task_ready', `Nobody holds task ${row.id}: it is ready.`, { hint: 'Claim it first: only the claim that holds a task settles it.', next: [`mu tasks claim ${row.id}`] })
  }
  if (row.state === 'blocked') {
    // The kind is the board's word. The reason is someone's own, and is read in the thread, not here.
    throw new Failure('task_blocked', `Task ${row.id} is blocked${row.hold_kind ? `: ${row.hold_kind}` : ''}.`, {
      hint: 'Nobody holds it. Once its owner unblocks it, it can be claimed.',
      next: read,
    })
  }
  if (row.state === 'waiting') {
    const needs = (ctx.db.raw.prepare("select n.needs as id from needs n join tasks t on t.id = n.needs where n.task = ? and t.state != 'completed' order by n.needs").all(row.id) as { id: number }[]).map((need) => `task ${need.id}`)
    throw new Failure('task_waiting', `Task ${row.id} waits for ${needs.length ? needs.join(', ') : 'what it needs'}.`, { hint: 'It can be claimed once what it waits for completes.', next: read })
  }
  throw new Failure('task_finished', `Task ${row.id} is ${row.state}.`, { hint: "It is settled: nothing settles it again.", next: read })
}

function needsOf(ctx: Context, caller: Caller, self: number | null, ids: readonly number[]): number[] {
  const needs = [...new Set(ids)]
  if (needs.length > NEEDS_MAX) throw new Failure('invalid_needs', `A task waits for at most ${NEEDS_MAX} others.`)
  for (const id of needs) {
    if (id === self) throw new Failure('invalid_needs', `A task can't wait for itself.`)
    const row = rowOf(ctx, id)
    const root = row ? findMessage(ctx.db, id) : null
    if (!row || !root || !allowed(caller, root.channel, 'read')) throw new Failure('invalid_needs', `${id} isn't a task.`)
    if (row.state === 'canceled') throw new Failure('invalid_needs', `Task ${id} was canceled, so nothing can wait for it.`)
  }
  if (self !== null) {
    // Nothing it would wait for may wait, however indirectly, for it.
    const seen = new Set<number>()
    const queue = [...needs]
    while (queue.length) {
      const id = queue.pop()!
      if (id === self) throw new Failure('invalid_needs', `That would make task ${self} wait for itself.`)
      if (seen.has(id)) continue
      seen.add(id)
      if (seen.size > NEEDS_WALK_MAX) throw new Failure('invalid_needs', 'Those tasks wait for too many others to check.')
      for (const next of ctx.db.raw.prepare('select needs from needs where task = ?').all(id) as { needs: number }[]) queue.push(next.needs)
    }
  }
  return needs
}

/** The state a task with these needs rests in: ready once everything it waits for completed. */
function restingState(ctx: Context, needs: readonly number[]): 'ready' | 'waiting' {
  for (const id of needs) if (rowOf(ctx, id)?.state !== 'completed') return 'waiting'
  return 'ready'
}

function readyDependents(ctx: Context, id: number, emit: Emit) {
  const board: By = { principal: 'board', profile: null }
  for (const { task } of ctx.db.raw.prepare('select task from needs where needs = ? order by task').all(id) as { task: number }[]) {
    const row = rowOf(ctx, task)
    if (!row || row.state !== 'waiting') continue
    const needs = (ctx.db.raw.prepare('select needs from needs where task = ?').all(task) as { needs: number }[]).map((need) => need.needs)
    if (restingState(ctx, needs) !== 'ready') continue
    const root = findMessage(ctx.db, task)!
    emit({ type: 'task.ready', by: board, channel: root.channel, thread: task, data: { id: task, from: 'waiting' } })
  }
}

/**
 * Gives back the time a machine was asleep. A lease runs on the wall clock, which keeps going while
 * nothing on the machine can renew; every claim that was live when the gap began gets the gap added.
 */
export function grace(ctx: Context, gapMs: number, since: number): number[] {
  const extended: number[] = []
  ctx.db.write(() => {
    const rows = ctx.db.raw.prepare("select * from tasks where state = 'claimed'").all() as TaskRow[]
    for (const row of rows) {
      if (Date.parse(row.claim_until!) <= since) continue
      const root = findMessage(ctx.db, row.id)
      if (!root) continue
      const until = new Date(Date.parse(row.claim_until!) + gapMs).toISOString()
      append(ctx.db, { type: 'task.extended', by: { principal: 'board', profile: null }, channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, until, why: 'asleep' } }, ctx.now().toISOString())
      extended.push(row.id)
    }
  })
  return extended
}

/** What the tasks under a channel have cost so far: the sum of their `cost` labels, which whoever runs an agent writes. */
export function spent(ctx: Context, channel: string): number {
  const rows = ctx.db.raw
    .prepare("select m.labels as labels from tasks t join messages m on m.id = t.id where m.channel = ? or m.channel like ? escape '\\'")
    .all(channel, channel.replaceAll('%', '\\%').replaceAll('_', '\\_') + '/%') as { labels: string }[]
  let sum = 0
  for (const row of rows) {
    const cost = Number((JSON.parse(row.labels) as Record<string, string>).cost)
    if (Number.isFinite(cost) && cost > 0) sum += cost
  }
  return sum
}

/** The budget that has run out for a channel, if one has: its own, or one set on a channel above it. */
function overBudget(ctx: Context, channel: string): { channel: string; usd: number; spent: number } | null {
  const parts = channel.split('/')
  for (let depth = parts.length; depth >= 1; depth--) {
    const at = parts.slice(0, depth).join('/')
    const row = ctx.db.raw.prepare('select usd from budgets where channel = ?').get(at) as { usd: number } | undefined
    if (!row) continue
    const used = spent(ctx, at)
    if (used >= row.usd) return { channel: at, usd: row.usd, spent: used }
  }
  return null
}

const refuseOverBudget = (ctx: Context, channel: string) => {
  const over = overBudget(ctx, channel)
  return over ? new Failure('over_budget', `#${over.channel} has spent $${over.spent.toFixed(2)} of its $${over.usd.toFixed(2)} budget.`, { hint: 'Its owner can raise it: mu budget <channel> <usd>.', data: over }) : null
}

/** Sets what the tasks under a channel may cost in all, or lifts the limit with null. Work already claimed carries on; no new claim is given past it. */
export function setBudget(ctx: Context, caller: Caller, request: { channel: string; usd: number | null }): { channel: string; usd: number | null; spent: number } {
  const channel = channelScope(request.channel.replace(/\/$/, '')).path
  if (request.usd !== null && !(Number.isFinite(request.usd) && request.usd > 0)) throw misuse('invalid_budget', 'A budget is an amount in dollars, more than 0.')
  if (caller.can !== undefined && !allowed(caller, channel, 'manage')) throw new Failure('forbidden', `You can't set a budget for "${channel}".`)
  return ctx.db.write(() => {
    append(ctx.db, { type: 'budget.set', by: byOf(caller), channel, data: { channel, usd: request.usd } }, ctx.now().toISOString())
    return { channel, usd: request.usd, spent: spent(ctx, channel) }
  })
}

export function budgets(ctx: Context, caller: Caller): { budgets: { channel: string; usd: number; spent: number }[] } {
  const rows = ctx.db.raw.prepare('select channel, usd from budgets order by channel').all() as { channel: string; usd: number }[]
  return { budgets: rows.filter((row) => allowed(caller, row.channel, 'read')).map((row) => ({ ...row, spent: spent(ctx, row.channel) })) }
}

export type CreateRequest = (PostRequest | { thread: number; idempotencyKey?: string }) & {
  needs?: number[]
  for?: string
  claim?: { lease?: number; pid?: number; pidStart?: string }
}

function makeTask(
  ctx: Context,
  caller: Caller,
  root: Message,
  options: { needs?: readonly number[]; for?: string | undefined; state?: 'ready' | 'waiting' },
  emit: Emit,
) {
  if (rowOf(ctx, root.id)) throw new Failure('already_a_task', `${root.id} is already a task.`)
  const needs = options.state ? [...(options.needs ?? [])] : needsOf(ctx, caller, null, options.needs ?? [])
  emit({
    type: 'task.created',
    by: byOf(caller),
    channel: root.channel,
    thread: root.id,
    data: { id: root.id, state: options.state ?? restingState(ctx, needs), needs, for: options.for === undefined ? null : profileName(options.for) },
  })
}

function claimNow(ctx: Context, caller: Caller, row: TaskRow, root: Message, claim: { lease?: number; pid?: number; pidStart?: string }, emit: Emit): string {
  const token = randomBytes(16).toString('base64url')
  const until = new Date(ctx.now().getTime() + leaseMs(claim.lease)).toISOString()
  emit({
    type: 'task.claimed',
    by: byOf(caller),
    channel: root.channel,
    thread: root.id,
    data: { id: row.id, epoch: row.epoch + 1, until, token: hashOf(token), pid: claim.pid ?? null, pidStart: claim.pidStart ?? null, from: 'ready' },
  })
  return token
}

export function create(ctx: Context, caller: Caller, request: CreateRequest): { task: Task; message: Message; token?: string } {
  if ('thread' in request) {
    return once(
      ctx,
      caller,
      request.idempotencyKey,
      { op: 'tasks.create', thread: request.thread, needs: request.needs ?? [], for: request.for ?? null },
      (emit) => {
        const root = messageFor(ctx, caller, request.thread)
        if (root.re !== null) throw new Failure('not_a_root', `${request.thread} is a reply; a task is a thread's first message.`, { next: [`mu tasks create ${root.thread}`] })
        authorize(caller, root.channel, 'post')
        makeTask(ctx, caller, root, { needs: request.needs ?? [], for: request.for }, emit)
        const token = request.claim && rowOf(ctx, root.id)!.state === 'ready' ? claimNow(ctx, caller, rowOf(ctx, root.id)!, root, request.claim, emit) : undefined
        return { answer: { task: view(ctx, root.id), message: findMessage(ctx.db, root.id)!, ...(token ? { token } : {}) }, ref: root.id }
      },
      (id: number) => ({ task: view(ctx, id), message: findMessage(ctx.db, id)! }),
    )
  }
  const { needs, for: assignee, claim, idempotencyKey, ...message } = request
  return once(
    ctx,
    caller,
    idempotencyKey,
    { op: 'tasks.create', message, needs: needs ?? [], for: assignee ?? null },
    (emit) => {
      // The transaction is already open: post() joins it through the same write.
      const root = postInside(ctx, caller, message, emit)
      makeTask(ctx, caller, root, { needs: needs ?? [], for: assignee }, emit)
      const token = claim && rowOf(ctx, root.id)!.state === 'ready' ? claimNow(ctx, caller, rowOf(ctx, root.id)!, root, claim, emit) : undefined
      return { answer: { task: view(ctx, root.id), message: findMessage(ctx.db, root.id)!, ...(token ? { token } : {}) }, ref: root.id }
    },
    (id: number) => ({ task: view(ctx, id), message: findMessage(ctx.db, id)! }),
  )
}

/** Posts a root from inside a write that is already open. */
function postInside(ctx: Context, caller: Caller, request: PostRequest, emit: Emit): Message {
  const nested: Context = { ...ctx, db: { ...ctx.db, write: (fn) => fn() } }
  void emit
  return post(nested, caller, { ...request, idempotencyKey: undefined } as PostRequest)
}

/** What a task in a plan waits for: an earlier task by its key, or a task already on the board by its ID. Either may be written bare. */
export type PlanNeed = { key: string } | { id: number } | string | number
export type PlanTask = { key: string; text: string; labels?: Record<string, string>; needs?: PlanNeed[]; for?: string }

const NEED_SHAPE = 'A need is an earlier task\'s key or a task\'s ID: { "key": "a" } or { "id": 12 }, or either one bare, "a" or 12.'
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0
const show = (value: unknown) => JSON.stringify(value) ?? String(value)

/**
 * What each task of a plan waits for, checked before anything is written: a plan comes from a file or a
 * request, so nothing about its shape is taken on trust. A bare string is a key when the plan has that
 * key, and otherwise a task's ID.
 */
function planNeeds(tasks: readonly PlanTask[]): ({ key: string } | { id: number })[][] {
  const keys = new Set<string>()
  for (const task of tasks as readonly unknown[]) {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) throw misuse('invalid_plan', `${show(task)} isn't a task.`, 'A task in a plan is { "key", "text", "labels", "needs" }.')
    const { key, text } = task as { key?: unknown; text?: unknown }
    if (typeof key !== 'string' || key.length === 0) throw misuse('invalid_plan', 'Every task in a plan needs a "key".')
    if (keys.has(key)) throw misuse('invalid_plan', `Two tasks share the key "${key}".`)
    if (typeof text !== 'string') throw misuse('invalid_plan', `"${key}" has no "text": the text is the job.`)
    const { labels, for: assignee } = task as { labels?: unknown; for?: unknown }
    if (labels !== undefined && (typeof labels !== 'object' || labels === null || Array.isArray(labels))) throw misuse('invalid_plan', `"${key}" has labels that aren't { "k": "v" }: ${show(labels)}.`)
    if (assignee !== undefined && typeof assignee !== 'string') throw misuse('invalid_plan', `"${key}" is for ${show(assignee)}, which isn't a profile's name.`)
    keys.add(key)
  }
  const earlier = new Set<string>()
  return tasks.map((task) => {
    const refuse = (what: string) => misuse('invalid_plan', `"${task.key}" ${what}`, NEED_SHAPE)
    const byKey = (key: string) => {
      if (!earlier.has(key)) throw refuse(`waits for "${key}", which isn't earlier in the plan.`)
      return { key }
    }
    const needs: unknown = task.needs ?? []
    if (!Array.isArray(needs)) throw refuse(`has needs that aren't a list: ${show(needs)}.`)
    const settled = needs.map((need: unknown) => {
      if (isId(need)) return { id: need }
      if (typeof need === 'string') {
        if (keys.has(need)) return byKey(need)
        if (/^#?[1-9][0-9]*$/.test(need)) return { id: Number(need.replace('#', '')) }
        throw refuse(`waits for "${need}", which is neither a key in this plan nor a task's ID.`)
      }
      if (typeof need === 'object' && need !== null) {
        const { key, id } = need as { key?: unknown; id?: unknown }
        if (isId(id) && key === undefined) return { id }
        if (typeof key === 'string' && id === undefined) {
          if (!keys.has(key)) throw refuse(`waits for "${key}", which isn't a key in this plan.`)
          return byKey(key)
        }
      }
      throw refuse(`has a need that isn't one: ${show(need)}.`)
    })
    earlier.add(task.key)
    return settled
  })
}

/** Queues a whole plan in one write: each task after the ones it waits for, by its key. */
export function plan(ctx: Context, caller: Caller, request: { channel: string; tasks: PlanTask[]; idempotencyKey?: string }): { tasks: (Task & { key: string })[] } {
  if (!Array.isArray(request.tasks) || request.tasks.length === 0) throw misuse('empty_plan', 'A plan is a JSON array of tasks, with at least one.')
  if (request.tasks.length > PLAN_MAX) throw new Failure('plan_too_large', `A plan holds at most ${PLAN_MAX} tasks.`, { hint: 'Queue it in several writes.' })
  const needed = planNeeds(request.tasks)
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'tasks.plan', channel: request.channel, tasks: request.tasks },
    (emit) => {
      const made = new Map<string, number>()
      request.tasks.forEach((task, at) => {
        const needs = needed[at]!.map((need) => ('id' in need ? need.id : made.get(need.key)!))
        const root = postInside(ctx, caller, { channel: request.channel, text: task.text, ...(task.labels ? { labels: task.labels } : {}) }, emit)
        makeTask(ctx, caller, root, { needs, for: task.for }, emit)
        made.set(task.key, root.id)
      })
      const ids = [...made.entries()]
      return { answer: { tasks: ids.map(([key, id]) => ({ ...view(ctx, id), key })) }, ref: ids }
    },
    (ids: [string, number][]) => ({ tasks: ids.map(([key, id]) => ({ ...view(ctx, id), key })) }),
  )
}

export type ClaimRequest = {
  id?: number
  /** Take the oldest ready task in this channel or subtree. */
  ready?: string
  labels?: string[]
  /** Other owners whose tasks to take, by principal. */
  from?: string[]
  lease?: number
  pid?: number
  pidStart?: string
}

export function claim(ctx: Context, caller: Caller, request: ClaimRequest): { task: Task; token: string } {
  // What a claim learns on the way (a lease that ran out, a task to hold) is kept even when it takes nothing:
  // a refusal after that is returned, and thrown once the write has landed.
  const outcome = claimOrRefusal(ctx, caller, request)
  if (outcome instanceof Failure) throw outcome
  return outcome
}

function claimOrRefusal(ctx: Context, caller: Caller, request: ClaimRequest): { task: Task; token: string } | Failure {
  return once<{ task: Task; token: string } | Failure>(
    ctx,
    caller,
    undefined,
    null,
    (emit) => {
      if (request.id !== undefined) {
        const found = taskFor(ctx, caller, request.id)
        authorize(caller, found.root.channel, 'label')
        const row = settleLapse(ctx, found.row, found.root, emit)
        if (row.state !== 'ready') {
          const finished = row.state === 'completed' || row.state === 'failed' || row.state === 'canceled'
          const refusal = new Failure(finished ? 'task_finished' : row.state === 'claimed' ? 'task_claimed' : `task_${row.state}`, `Task ${row.id} is ${row.state}.`, {
            next: [`mu read ${row.id}`],
          })
          return { answer: refusal, ref: null }
        }
        if (row.for_profile !== null && row.for_profile !== caller.profile) {
          throw new Failure('task_assigned', `Task ${row.id} is for ${row.for_profile}.`)
        }
        const broke = refuseOverBudget(ctx, found.root.channel)
        if (broke) return { answer: broke, ref: null }
        const token = claimNow(ctx, caller, row, found.root, request, emit)
        return { answer: { task: view(ctx, row.id), token }, ref: null }
      }
      if (request.ready === undefined) throw misuse('nothing_to_claim', 'Name a task, or --ready <channel>.')
      const scope = channelScope(request.ready)
      const from = [...new Set(request.from ?? [])]
      if (from.length > FROM_MAX) throw misuse('invalid_from', `--from takes at most ${FROM_MAX} owners.`)
      for (const owner of from) if (!/^[^\s:]+:\S+$/.test(owner) || owner.includes('+')) throw misuse('invalid_from', `"${owner}" isn't an owner's ID.`, 'Use the ID from `mu actors`, cut at the "+".')
      const owners = new Set([caller.principal, ...from])
      const filters = (request.labels ?? []).map(labelFilter)
      const candidates = ctx.db.raw.prepare("select * from tasks where state in ('ready', 'claimed') order by id").all() as TaskRow[]
      let pick: { row: TaskRow; root: Message } | null = null
      let overspent: Failure | null = null
      for (const candidate of candidates) {
        if (!owners.has(candidate.owner)) continue
        if (candidate.for_profile !== null && candidate.for_profile !== caller.profile) continue
        const root = findMessage(ctx.db, candidate.id)
        if (!root || root.deleted || !inScope(root.channel, scope) || !allowed(caller, root.channel, 'label')) continue
        if (!matchesLabels(root.labels, filters)) continue
        const row = settleLapse(ctx, candidate, root, emit)
        if (row.state !== 'ready') continue
        const broke = refuseOverBudget(ctx, root.channel)
        if (broke) {
          overspent ??= broke
          continue
        }
        // A task assigned to this profile goes before the pool.
        if (row.for_profile !== null) {
          pick = { row, root }
          break
        }
        pick ??= { row, root }
      }
      if (!pick && overspent) return { answer: overspent, ref: null }
      if (!pick) {
        return { answer: new Failure('nothing_ready', `Nothing is ready in ${request.ready}.`, { hint: "That isn't a failure of the work: there is nothing to take." }), ref: null }
      }
      const token = claimNow(ctx, caller, pick.row, pick.root, request, emit)
      return { answer: { task: view(ctx, pick.row.id), token }, ref: null }
    },
    () => {
      throw new Error('unreachable')
    },
  )
}

type Held = { id: number; token?: string | undefined }

function write<T>(ctx: Context, caller: Caller, run: (emit: Emit) => T): T {
  return once(ctx, caller, undefined, null, (emit) => ({ answer: run(emit), ref: null }), () => {
    throw new Error('unreachable')
  })
}

export function renew(ctx: Context, caller: Caller, request: Held & { lease?: number }): { task: Task } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    fence(ctx, row, request.token)
    const until = new Date(ctx.now().getTime() + leaseMs(request.lease)).toISOString()
    emit({ type: 'task.renewed', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, until } })
    return { task: view(ctx, row.id) }
  })
}

export function release(ctx: Context, caller: Caller, request: Held): { task: Task } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    fence(ctx, row, request.token)
    emit({ type: 'task.released', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, from: 'claimed' } })
    return { task: view(ctx, row.id) }
  })
}

const outcome = (text: string | undefined, what: string) => {
  if (text !== undefined && text.length > RESULT_MAX) throw new Failure('text_too_long', `A ${what} holds up to ${RESULT_MAX.toLocaleString('en-US')} characters.`, { hint: 'Put the rest in a reply.' })
  return text ?? null
}

export function complete(ctx: Context, caller: Caller, request: Held & { result?: string }): { task: Task; readied: number[] } {
  const result = outcome(request.result, 'result')
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    fence(ctx, row, request.token)
    emit({ type: 'task.completed', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, result, from: 'claimed' } })
    const before = new Set((ctx.db.raw.prepare("select id from tasks where state = 'ready'").all() as { id: number }[]).map((task) => task.id))
    readyDependents(ctx, row.id, emit)
    const readied = (ctx.db.raw.prepare("select id from tasks where state = 'ready' order by id").all() as { id: number }[]).map((task) => task.id).filter((id) => !before.has(id))
    return { task: view(ctx, row.id), readied }
  })
}

export function fail(ctx: Context, caller: Caller, request: Held & { reason?: string; counts?: boolean }): { task: Task } {
  const reason = outcome(request.reason, 'reason')
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    fence(ctx, row, request.token)
    emit({ type: 'task.failed', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, epoch: row.epoch, reason, counts: request.counts !== false, from: 'claimed' } })
    return { task: view(ctx, row.id) }
  })
}

export function block(ctx: Context, caller: Caller, request: Held & { reason?: string; kind?: string }): { task: Task } {
  const kind = request.kind ?? 'needs_input'
  if (!KIND.test(kind)) throw misuse('invalid_kind', `"${kind}" isn't a kind.`, 'A kind is lowercase letters, numbers, ".", "_" and "-".')
  if (kind === 'edited' || kind === 'failing') throw new Failure('reserved_kind', `Only the board holds a task as "${kind}".`)
  const reason = outcome(request.reason, 'reason')
  return write(ctx, caller, (emit) => {
    const found = taskFor(ctx, caller, request.id)
    const row = request.token ? found.row : settleLapse(ctx, found.row, found.root, emit)
    if (row.state === 'claimed') fence(ctx, row, request.token)
    else if (row.state === 'ready' || row.state === 'waiting') mustOwn(caller, row, found.root)
    else throw new Failure(`task_${row.state}`, `Task ${row.id} is ${row.state}.`)
    emit({ type: 'task.blocked', by: byOf(caller), channel: found.root.channel, thread: found.root.id, data: { id: row.id, kind, reason, from: row.state } })
    return { task: view(ctx, row.id) }
  })
}

export function unblock(ctx: Context, caller: Caller, request: { id: number }): { task: Task; changed: boolean } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    mustOwn(caller, row, root)
    if (row.state !== 'blocked') return { task: view(ctx, row.id), changed: false }
    const needs = (ctx.db.raw.prepare('select needs from needs where task = ?').all(row.id) as { needs: number }[]).map((need) => need.needs)
    emit({ type: `task.${restingState(ctx, needs)}`, by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, from: 'blocked' } })
    return { task: view(ctx, row.id), changed: true }
  })
}

export function reopen(ctx: Context, caller: Caller, request: { id: number; round?: boolean }): { task: Task; changed: boolean } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    mustOwn(caller, row, root)
    // A completed task comes back only as a new round: a review sent it back.
    const from = row.state === 'failed' || (row.state === 'completed' && request.round === true)
    if (!from) {
      if (row.state === 'completed') throw new Failure('task_finished', `Task ${row.id} is completed.`, { hint: 'Pass --round to send it back for another round.' })
      return { task: view(ctx, row.id), changed: false }
    }
    const needs = (ctx.db.raw.prepare('select needs from needs where task = ?').all(row.id) as { needs: number }[]).map((need) => need.needs)
    emit({ type: 'task.reopened', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, state: restingState(ctx, needs), round: request.round === true, from: row.state } })
    return { task: view(ctx, row.id), changed: true }
  })
}

export function cancel(ctx: Context, caller: Caller, request: { id: number }): { task: Task } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    mustOwn(caller, row, root)
    if (!OPEN_STATES.includes(row.state)) throw new Failure('task_finished', `Task ${row.id} is ${row.state}.`)
    emit({ type: 'task.canceled', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, from: row.state } })
    return { task: view(ctx, row.id) }
  })
}

export function assign(ctx: Context, caller: Caller, request: { id: number; for: string | null }): { task: Task } {
  const assignee = request.for === null ? null : profileName(request.for)
  return write(ctx, caller, (emit) => {
    const found = taskFor(ctx, caller, request.id)
    mustOwn(caller, found.row, found.root)
    const row = settleLapse(ctx, found.row, found.root, emit)
    if (!OPEN_STATES.includes(row.state)) throw new Failure('task_finished', `Task ${row.id} is ${row.state}.`)
    if (row.state === 'claimed') throw new Failure('task_claimed', `Task ${row.id} is claimed; assign it once it's released.`)
    emit({ type: 'task.assigned', by: byOf(caller), channel: found.root.channel, thread: found.root.id, data: { id: row.id, for: assignee } })
    return { task: view(ctx, row.id) }
  })
}

export function setNeeds(ctx: Context, caller: Caller, request: { id: number; needs: number[] }): { task: Task } {
  return write(ctx, caller, (emit) => {
    const { row, root } = taskFor(ctx, caller, request.id)
    mustOwn(caller, row, root)
    if (row.state !== 'waiting' && row.state !== 'ready' && row.state !== 'blocked') throw new Failure(`task_${row.state}`, `Task ${row.id} is ${row.state}.`)
    const needs = needsOf(ctx, caller, row.id, request.needs)
    emit({ type: 'task.needs_changed', by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, needs } })
    if (row.state !== 'blocked') {
      const next = restingState(ctx, needs)
      if (next !== row.state) emit({ type: `task.${next}`, by: byOf(caller), channel: root.channel, thread: root.id, data: { id: row.id, from: row.state } })
    }
    return { task: view(ctx, row.id) }
  })
}

export type TaskListing = Task & { text: string; labels: Record<string, string>; by: By; at: string }

/**
 * The tasks a caller may read, the first made first. With `latest` it is the `limit` last active instead,
 * the latest last: a thread is active when something is said in it, so a claim renewed in silence
 * doesn't count. `more` says some that matched were left out.
 */
export function list(
  ctx: Context,
  caller: Caller,
  request: { channel?: string; state?: TaskState | 'open' | 'all'; labels?: string[]; limit?: number; latest?: boolean } = {},
): { tasks: TaskListing[]; more: boolean } {
  const scope = request.channel === undefined ? null : channelScope(request.channel)
  const filters = (request.labels ?? []).map(labelFilter)
  const want = request.state ?? 'open'
  if (want !== 'open' && want !== 'all' && !TASK_STATES.includes(want)) throw misuse('invalid_state', `"${want}" isn't a task state.`, `One of: open, all, ${TASK_STATES.join(', ')}.`)
  const limit = limitOf(request.limit, 200, 1000)
  const latest = request.latest === true
  const rows = ctx.db.raw.prepare('select * from tasks order by id').all() as TaskRow[]
  const tasks: TaskListing[] = []
  let more = false
  for (const row of rows) {
    const root = findMessage(ctx.db, row.id)
    if (!root || !allowed(caller, root.channel, 'read')) continue
    if (scope && !inScope(root.channel, scope)) continue
    const { 'board.task': _state, ...labels } = root.labels
    if (!matchesLabels(root.labels, filters)) continue
    const task = toTask(ctx, row, root)
    if (want === 'open' ? !OPEN_STATES.includes(task.state) : want !== 'all' && task.state !== want) continue
    if (!latest && tasks.length === limit) {
      more = true
      break
    }
    tasks.push({ ...task, text: root.text, labels, by: root.by, at: root.at })
  }
  if (!latest) return { tasks, more }
  // IDs are given in the order things were written, so a thread's newest message is its highest ID.
  const newest = ctx.db.raw.prepare('select max(id) as id from messages where thread = ? and deleted = 0')
  const active = new Map(tasks.map((task) => [task.id, (newest.get(task.id) as { id: number | null }).id ?? task.id]))
  // A sort keeps ties as they came, and no two messages share an ID.
  const kept = tasks.sort((x, y) => active.get(x.id)! - active.get(y.id)!).slice(-limit)
  return { tasks: kept, more: tasks.length > limit }
}

/** Holds an open task whose first message was changed by someone other than its owner. Sync calls it for edits a platform sends. */
export function holdIfEdited(ctx: Context, editor: By, message: Message, emit: Emit) {
  hooks.edited?.(ctx, { principal: editor.principal, profile: editor.profile }, message, emit as never)
}

// A task's root has rules a plain message doesn't: an edit by someone else holds it, and deleting it cancels it.
hooks.edited = (ctx, caller, message, emit) => {
  const row = message.re === null ? rowOf(ctx, message.id) : undefined
  // The same test as every other owner check: the principal, and as a profile only the one that made the task.
  if (!row || !OPEN_STATES.includes(row.state) || owns(caller, row)) return
  if (row.state === 'blocked' && row.hold_kind === 'edited') return
  emit({
    type: 'task.blocked',
    by: { principal: 'board', profile: null },
    channel: message.channel,
    thread: message.id,
    data: { id: row.id, kind: 'edited', reason: 'Someone other than its owner edited the task.', from: row.state },
  })
}

hooks.deleted = (ctx, _caller, message, emit) => {
  const row = message.re === null ? rowOf(ctx, message.id) : undefined
  if (!row || !OPEN_STATES.includes(row.state)) return
  emit({ type: 'task.canceled', by: { principal: 'board', profile: null }, channel: message.channel, thread: message.id, data: { id: row.id, from: row.state } })
}
