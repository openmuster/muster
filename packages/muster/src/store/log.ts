import { actorId, handleOf, type BoardEvent, type By } from '../model.ts'
import type { Db } from './sqlite.ts'

/** An event before the log has given it a place. */
export type Draft = {
  type: string
  by: By
  channel?: string | null
  /** The root it belongs to. `'self'` on a root's own `message.posted`: its thread is its own seq. */
  thread?: number | 'self' | null
  data: Record<string, unknown>
}

type Row = { seq: number; at: string; type: string; principal: string; profile: string | null; channel: string | null; thread: number | null; data: string }

export const toEvent = (row: Row): BoardEvent => ({
  seq: row.seq,
  at: row.at,
  type: row.type,
  by: { principal: row.principal, profile: row.profile },
  channel: row.channel,
  thread: row.thread,
  data: JSON.parse(row.data) as Record<string, unknown>,
})

/** The seq the next event gets. Called inside the write transaction, so nothing can take it first. */
export function nextSeq(db: Db): number {
  const row = db.raw.prepare("select seq from sqlite_sequence where name = 'events'").get() as { seq: number } | undefined
  return (row?.seq ?? 0) + 1
}

/** Appends one event and applies it to the tables. Runs inside a write transaction. */
export function append(db: Db, draft: Draft, at: string): BoardEvent {
  const seq = nextSeq(db)
  const event: BoardEvent = {
    seq,
    at,
    type: draft.type,
    by: draft.by,
    channel: draft.channel ?? null,
    thread: draft.thread === 'self' ? seq : (draft.thread ?? null),
    data: draft.data,
  }
  db.raw
    .prepare('insert into events (seq, at, type, principal, profile, channel, thread, data) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .get(seq, at, event.type, event.by.principal, event.by.profile, event.channel, event.thread, JSON.stringify(event.data))
  apply(db, event)
  return event
}

const json = (value: unknown) => JSON.stringify(value)

/**
 * Takes a message out of the search index.
 *
 * Writes in this file step their statements with get(), never run(): once the search index has written
 * to its own tables, SQLite's last row ID is a number too large for run() to report, and it throws.
 */
function unindex(db: Db, id: unknown) {
  if (!Number.isSafeInteger(id)) return
  db.raw.exec(`delete from messages_fts where rowid = ${id as number}`)
}

/**
 * What one event does to the tables. The log is the only input: a fold of every event through this
 * function, into an empty file, gives the same tables a live board has.
 */
export function apply(db: Db, event: BoardEvent) {
  const { raw } = db
  const data = event.data as Record<string, any>

  raw
    .prepare(
      `insert into actors (principal, profile, handle, first_seq, last_seq) values (?, ?, ?, ?, ?)
       on conflict (principal, profile) do update set last_seq = excluded.last_seq`,
    )
    .get(event.by.principal, event.by.profile ?? '', handleOf(event.by), event.seq, event.seq)

  if (data.idem) {
    raw.prepare('insert or ignore into idempotency (key, fingerprint, answer, seq) values (?, ?, ?, ?)').get(data.idem.key, data.idem.fingerprint, json(data.idem.answer ?? null), event.seq)
  }

  switch (event.type) {
    case 'channel.created':
      raw.prepare('insert or ignore into channels (path, created_seq, private) values (?, ?, ?)').get(data.path, event.seq, data.private ? 1 : 0)
      break

    case 'message.posted': {
      raw.prepare('insert or ignore into channels (path, created_seq, private) values (?, ?, 0)').get(event.channel, event.seq)
      raw
        .prepare(
          `insert into messages (id, channel, thread, re, reply_to, principal, profile, text, labels, attachments, no_sync, at, activity)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .get(
          event.seq,
          event.channel,
          event.thread,
          data.re ?? null,
          data.replyTo ?? null,
          event.by.principal,
          event.by.profile,
          data.text,
          json(data.labels ?? {}),
          json(data.attachments ?? []),
          data.noSync ? 1 : 0,
          event.at,
          event.seq,
        )
      raw.prepare('insert into messages_fts (rowid, text) values (?, ?)').get(event.seq, data.text)
      if (data.origin) {
        raw.prepare('insert or ignore into links (message, key, external, thread_external, place) values (?, ?, ?, ?, ?)').get(event.seq, data.origin.key, data.origin.external, data.origin.thread ?? null, data.origin.place ?? null)
      }
      if (data.schedule) {
        raw.prepare('insert into slots (schedule, slot, message) values (?, ?, ?)').get(data.schedule.id, data.schedule.slot, event.seq)
        raw.prepare('update schedules set fired = fired + 1, next_at = ? where id = ?').get(data.schedule.next ?? null, data.schedule.id)
      }
      break
    }

    case 'message.edited':
      raw.prepare('update messages set text = ?, revision = ?, edited_at = ? where id = ?').get(data.text, data.revision, event.at, data.id)
      unindex(db, data.id)
      raw.prepare('insert into messages_fts (rowid, text) values (?, ?)').get(data.id, data.text)
      break

    case 'message.deleted':
      raw
        .prepare("update messages set text = '', labels = '{}', reactions = '{}', attachments = '[]', deleted = 1, revision = revision + 1, edited_at = ? where id = ?")
        .get(event.at, data.id)
      unindex(db, data.id)
      break

    case 'labels.changed': {
      const row = raw.prepare('select labels from messages where id = ?').get(data.id) as { labels: string } | undefined
      if (!row) break
      const labels = JSON.parse(row.labels) as Record<string, string>
      for (const key of (data.unset ?? []) as string[]) delete labels[key]
      Object.assign(labels, data.set ?? {})
      raw.prepare('update messages set labels = ? where id = ?').get(json(labels), data.id)
      break
    }

    case 'reaction.added':
    case 'reaction.removed': {
      const row = raw.prepare('select reactions from messages where id = ?').get(data.id) as { reactions: string } | undefined
      if (!row) break
      const reactions = JSON.parse(row.reactions) as Record<string, string[]>
      const who = actorId(event.by)
      const current = reactions[data.emoji] ?? []
      const next = event.type === 'reaction.added' ? (current.includes(who) ? current : [...current, who]) : current.filter((actor) => actor !== who)
      if (next.length) reactions[data.emoji] = next
      else delete reactions[data.emoji]
      raw.prepare('update messages set reactions = ? where id = ?').get(json(reactions), data.id)
      break
    }

    case 'sync.delivered':
      raw.prepare('insert or ignore into links (message, key, external, thread_external, place) values (?, ?, ?, ?, ?)').get(data.id, data.key, data.external, data.thread ?? null, data.place ?? null)
      break

    case 'budget.set':
      if (data.usd === null) raw.prepare('delete from budgets where channel = ?').get(data.channel)
      else raw.prepare('insert into budgets (channel, usd) values (?, ?) on conflict (channel) do update set usd = excluded.usd').get(data.channel, data.usd)
      break

    case 'schema.registered':
      raw.prepare('insert or ignore into schemas (name, version, schema) values (?, ?, ?)').get(data.name, data.version, json(data.schema))
      break

    case 'schedule.created':
      raw
        .prepare('insert into schedules (id, principal, profile, channel, thread, text, every_s, times, until, next_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .get(event.seq, event.by.principal, event.by.profile, event.channel, data.thread ?? null, data.text, data.every ?? null, data.times ?? null, data.until ?? null, data.first)
      break

    case 'schedule.canceled':
      raw.prepare('update schedules set canceled = 1, next_at = null where id = ?').get(data.id)
      break

    case 'schedule.skipped':
      raw.prepare('update schedules set next_at = ? where id = ?').get(data.next ?? null, data.id)
      break

    default:
      if (event.type.startsWith('task.')) applyTask(db, event)
  }

  if (event.thread !== null) raw.prepare('update messages set activity = ? where id = ?').get(event.seq, event.thread)
}

/** Sets or clears the label the board keeps a task's state in, on the task's root. */
function taskLabel(db: Db, id: number, state: string) {
  const row = db.raw.prepare('select labels from messages where id = ?').get(id) as { labels: string } | undefined
  if (!row) return
  const labels = JSON.parse(row.labels) as Record<string, string>
  labels['board.task'] = state
  db.raw.prepare('update messages set labels = ? where id = ?').get(json(labels), id)
}

function applyTask(db: Db, event: BoardEvent) {
  const { raw } = db
  const data = event.data as Record<string, any>
  const id = data.id as number
  const touch = (sets: string, ...values: unknown[]) =>
    raw.prepare(`update tasks set ${sets}, updated_seq = ? where id = ?`).get(...(values as never[]), event.seq, id)
  const clearClaim = 'claim_principal = null, claim_profile = null, claim_until = null, claim_token = null, claim_renewed = null, claim_pid = null, claim_pid_start = null'
  const state = (next: string) => taskLabel(db, id, next)

  switch (event.type) {
    case 'task.created':
      raw
        .prepare('insert into tasks (id, owner, owner_profile, for_profile, state, created_seq, updated_seq) values (?, ?, ?, ?, ?, ?, ?)')
        .get(id, event.by.principal, event.by.profile, data.for ?? null, data.state, event.seq, event.seq)
      for (const need of (data.needs ?? []) as number[]) raw.prepare('insert or ignore into needs (task, needs) values (?, ?)').get(id, need)
      state(data.state)
      break
    case 'task.ready':
      touch(`state = 'ready', hold_kind = null, hold_reason = null, ${clearClaim}`)
      state('ready')
      break
    case 'task.waiting':
      touch(`state = 'waiting', hold_kind = null, hold_reason = null, ${clearClaim}`)
      state('waiting')
      break
    case 'task.claimed':
      touch(
        "state = 'claimed', epoch = ?, claim_principal = ?, claim_profile = ?, claim_until = ?, claim_token = ?, claim_renewed = ?, claim_pid = ?, claim_pid_start = ?",
        data.epoch,
        event.by.principal,
        event.by.profile,
        data.until,
        data.token,
        event.at,
        data.pid ?? null,
        data.pidStart ?? null,
      )
      state('claimed')
      break
    case 'task.renewed':
      touch('claim_until = ?, claim_renewed = ?', data.until, event.at)
      break
    case 'task.extended':
      touch('claim_until = ?', data.until)
      break
    case 'task.released':
      touch(`state = 'ready', ${clearClaim}`)
      state('ready')
      break
    case 'task.expired':
      touch(`state = 'ready', attempts = attempts + 1, ${clearClaim}`)
      state('ready')
      break
    case 'task.blocked':
      touch(`state = 'blocked', hold_kind = ?, hold_reason = ?, ${clearClaim}`, data.kind, data.reason ?? null)
      state('blocked')
      break
    case 'task.completed':
      touch(`state = 'completed', result = ?, ${clearClaim}`, data.result ?? null)
      state('completed')
      break
    case 'task.failed':
      touch(`state = 'failed', reason = ?, attempts = attempts + ?, ${clearClaim}`, data.reason ?? null, data.counts === false ? 0 : 1)
      state('failed')
      break
    case 'task.canceled':
      touch(`state = 'canceled', ${clearClaim}`)
      state('canceled')
      break
    case 'task.reopened':
      touch(`state = ?, result = null, reason = null, attempts = 0, rounds = rounds + ?, ${clearClaim}`, data.state, data.round ? 1 : 0)
      state(data.state)
      break
    case 'task.assigned':
      touch('for_profile = ?', data.for ?? null)
      break
    case 'task.needs_changed':
      raw.prepare('delete from needs where task = ?').get(id)
      for (const need of (data.needs ?? []) as number[]) raw.prepare('insert or ignore into needs (task, needs) values (?, ?)').get(id, need)
      break
  }
}
