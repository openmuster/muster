import { misuse } from '../failure.ts'
import { channelScope, inScope, type Caller } from '../model.ts'
import { allowed, findMessage, type Context } from './context.ts'

/**
 * How one group of tasks went. `rounds` is the average number of rounds, a task sent back with
 * `reopen --round` counting one more each time; `firstRound` is how many completed without being sent
 * back. `cost` sums the `cost` labels whoever ran an agent wrote, and `perTask` divides it by the
 * `costed` tasks that have one: an agent that reports no cost (Codex) adds to neither.
 */
export type ReportRow = {
  key: string | null
  tasks: number
  firstRound: number
  rounds: number
  failed: number
  failing: number
  needsInput: number
  cost: number
  costed: number
  perTask: number | null
}

export type Report = { channel: string | null; since: string; agents: ReportRow[]; workflows: ReportRow[] }

type Row = { id: number; state: string; rounds: number; at: string }

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

/**
 * How the tasks under a channel went since a time: grouped by the agent that ran them (the `agent` label
 * `mu run` writes) and by workflow (the `workflow` label a run's tasks are made with). A task counts when
 * its latest change is at or after `since`. Read only, from the tables and the log; the caller sees only
 * the tasks it may read.
 */
export function report(ctx: Context, caller: Caller, request: { channel?: string; since: string }): Report {
  const since = Date.parse(request.since)
  if (typeof request.since !== 'string' || !Number.isFinite(since)) throw misuse('invalid_since', `"${String(request.since)}" isn't a time.`, 'Give an ISO time: 2026-11-01T00:00:00Z.')
  const scope = request.channel === undefined ? null : { path: channelScope(request.channel.replace(/\/$/, '')).path, tree: true }
  const rows = ctx.db.raw
    .prepare('select t.id as id, t.state as state, t.rounds as rounds, e.at as at from tasks t join events e on e.seq = t.updated_seq order by t.id')
    .all() as Row[]
  // Each time a task was held, by kind: the log keeps every hold, the table only the latest.
  const holds = new Map<number, { needsInput: number; failing: boolean }>()
  const blocked = ctx.db.raw.prepare("select json_extract(data, '$.id') as id, json_extract(data, '$.kind') as kind from events where type = 'task.blocked'").all() as { id: number; kind: string | null }[]
  for (const hold of blocked) {
    const seen = holds.get(hold.id) ?? { needsInput: 0, failing: false }
    if (hold.kind === 'needs_input') seen.needsInput += 1
    if (hold.kind === 'failing') seen.failing = true
    holds.set(hold.id, seen)
  }
  const agents = new Map<string | null, ReportRow & { roundSum: number }>()
  const workflows = new Map<string | null, ReportRow & { roundSum: number }>()
  const add = (groups: typeof agents, key: string | null, row: Row, cost: number | null) => {
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { key, tasks: 0, firstRound: 0, rounds: 0, roundSum: 0, failed: 0, failing: 0, needsInput: 0, cost: 0, costed: 0, perTask: null }))
    const held = holds.get(row.id)
    group.tasks += 1
    group.roundSum += 1 + row.rounds
    if (row.state === 'completed' && row.rounds === 0) group.firstRound += 1
    if (row.state === 'failed') group.failed += 1
    if (held?.failing) group.failing += 1
    group.needsInput += held?.needsInput ?? 0
    if (cost !== null) {
      group.cost += cost
      group.costed += 1
    }
  }
  for (const row of rows) {
    if (Date.parse(row.at) < since) continue
    const root = findMessage(ctx.db, row.id)
    if (!root || !allowed(caller, root.channel, 'read')) continue
    if (scope && !inScope(root.channel, scope)) continue
    const value = Number(root.labels.cost)
    const cost = root.labels.cost !== undefined && Number.isFinite(value) && value >= 0 ? value : null
    add(agents, root.labels.agent ?? null, row, cost)
    if (root.labels.workflow !== undefined) add(workflows, root.labels.workflow, row, cost)
  }
  const finish = (groups: typeof agents): ReportRow[] =>
    [...groups.values()]
      .map(({ roundSum, ...group }) => ({ ...group, rounds: round(roundSum / group.tasks, 2), cost: round(group.cost, 4), perTask: group.costed ? round(group.cost / group.costed, 4) : null }))
      // The busiest first; ties by name, and tasks no agent was recorded for last.
      .sort((x, y) => y.tasks - x.tasks || (x.key === null ? 1 : y.key === null ? -1 : x.key.localeCompare(y.key)))
  return { channel: scope?.path ?? null, since: new Date(since).toISOString(), agents: finish(agents), workflows: finish(workflows) }
}
