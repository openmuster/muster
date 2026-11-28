import type { FeedEvent, ThreadSummary } from '../core/reads.ts'
import type { Report, ReportRow } from '../core/report.ts'
import type { Task, TaskListing } from '../core/tasks.ts'
import type { By, Message } from '../model.ts'

/** How long ago, or how long until, in a word: `11s`, `5m`, `3h`, `2d`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : span(ms)
}

/** Who wrote something, as the board shows it: `claude via ada`, or `ada`. */
export function who(by: By): string {
  const person = by.principal.slice(by.principal.lastIndexOf(':') + 1)
  return by.profile ? `${by.profile} via ${person}` : person
}

const firstLine = (text: string, width: number) => {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > width ? line.slice(0, width - 1) + '…' : line
}

const indent = (text: string, by = 4) => text.split('\n').map((line) => ' '.repeat(by) + line).join('\n')

const labelsOf = (labels: Record<string, string>) =>
  Object.entries(labels)
    .filter(([key]) => !key.startsWith('board.'))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')

const reactionsOf = (message: Message) =>
  Object.entries(message.reactions)
    .map(([emoji, actors]) => `:${emoji}: ${actors.length}`)
    .join('  ')

export function messageLines(message: Message, now: number, options: { channel?: boolean } = {}): string {
  const head = [`#${message.id}`, `${who(message.by)} · ${span(now - Date.parse(message.at))}`]
  if (options.channel) head.push(`#${message.channel}`)
  if (message.editedAt && !message.deleted) head.push('edited')
  const lines = [head.join('  ')]
  lines.push(indent(message.deleted ? '(deleted)' : message.text))
  const labels = labelsOf(message.labels)
  if (labels) lines.push(indent(labels))
  if (message.attachments.length) lines.push(indent(message.attachments.map((file) => `[${file.name}]`).join(' ')))
  const reactions = reactionsOf(message)
  if (reactions) lines.push(indent(reactions))
  return lines.join('\n')
}

export function taskState(task: Task, now: number): string {
  if (task.state === 'claimed' && task.claim) return `claimed  ${who(task.claim.by)} · ${clock(Date.parse(task.claim.until) - now)} left`
  if (task.state === 'waiting') return `waiting  needs ${task.needs.map((id) => `#${id}`).join(' ')}`
  if (task.state === 'blocked' && task.hold) return `blocked  ${task.hold.kind}${task.hold.reason ? `: ${firstLine(task.hold.reason, 60)}` : ''}`
  if (task.state === 'completed') return `completed${task.result ? `  ${firstLine(task.result, 60)}` : ''}`
  if (task.state === 'failed') return `failed${task.reason ? `  ${firstLine(task.reason, 60)}` : ''}`
  return task.state
}

export function threadLines(thread: ThreadSummary, now: number): string {
  const lines = [messageLines(thread.message, now, { channel: true })]
  if (thread.task) lines.push(indent(taskState(thread.task, now)))
  if (thread.replies > 0 && thread.last) {
    lines.push(indent(`${thread.replies} ${thread.replies === 1 ? 'reply' : 'replies'}, last by ${who(thread.last.by)} · ${span(now - Date.parse(thread.last.at))}`))
  }
  return lines.join('\n')
}

export function taskRow(task: TaskListing, now: number): string {
  const labels = Object.entries(task.labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const parts = [`#${task.id}`.padEnd(6), task.state.padEnd(9), firstLine(task.text, 44)]
  if (labels) parts.push(labels)
  if (task.state === 'claimed' && task.claim) parts.push(`${who(task.claim.by)} · ${clock(Date.parse(task.claim.until) - now)} left`)
  if (task.state === 'waiting') parts.push(`needs ${task.needs.map((id) => `#${id}`).join(' ')}`)
  if (task.state === 'blocked' && task.hold) parts.push(task.hold.kind)
  if (task.for) parts.push(`for ${task.for}`)
  parts.push(`#${task.channel}`)
  return parts.join('  ')
}

export function eventLine(event: FeedEvent, now: number): string {
  const where = event.thread !== null ? `#${event.thread}` : (event.channel ?? '')
  const head = `${String(event.seq).padEnd(6)}  ${event.type.padEnd(16)}  ${where.padEnd(6)}  ${who(event.by)} · ${span(now - Date.parse(event.at))}`
  const data = event.data as Record<string, any>
  let detail = ''
  if (event.type === 'message.posted' || event.type === 'message.edited') detail = firstLine(String(data.text ?? ''), 70)
  else if (event.type === 'labels.changed') detail = [...Object.entries(data.set ?? {}).map(([k, v]) => `${k}=${v}`), ...((data.unset ?? []) as string[]).map((k) => `-${k}`)].join(' ')
  else if (event.type.startsWith('reaction.')) detail = `:${data.emoji}:`
  else if (event.type === 'task.completed') detail = firstLine(String(data.result ?? ''), 70)
  else if (event.type === 'task.failed' || event.type === 'task.blocked') detail = firstLine([data.kind, data.reason].filter(Boolean).join(': '), 70)
  return detail ? `${head}\n${indent(detail)}` : head
}

/**
 * A report as columns: one table by agent and, when any task had one, one by workflow. A cost is shown
 * only where an agent reported one; a task no agent was recorded for is `(none)`. A long name is never
 * cut, so two names alike are two rows: its row runs wider instead.
 */
export function reportText(report: Report): string {
  const day = report.since.slice(0, 10)
  const where = report.channel === null ? '' : ` in #${report.channel}`
  if (report.agents.length === 0) return `no tasks${where} since ${day}`
  const usd = (n: number | null) => (n === null ? '-' : `$${n.toFixed(2)}`)
  const head = (first: string) => `${first.padEnd(10)}  tasks  1st round  rounds  failed  failing  input  cost      per task`
  const row = (r: ReportRow) =>
    [
      (r.key ?? '(none)').padEnd(10),
      String(r.tasks).padStart(5),
      `${r.firstRound} ${Math.round((100 * r.firstRound) / r.tasks)}%`.padStart(9),
      r.rounds.toFixed(2).padStart(6),
      String(r.failed).padStart(6),
      String(r.failing).padStart(7),
      String(r.needsInput).padStart(5),
      (r.costed ? usd(r.cost) : '-').padEnd(8),
      r.costed ? usd(r.perTask) : '-',
    ].join('  ')
  const lines = [`since ${day}${where}`, head('agent'), ...report.agents.map(row)]
  if (report.workflows.length) lines.push(head('workflow'), ...report.workflows.map(row))
  return lines.join('\n')
}
