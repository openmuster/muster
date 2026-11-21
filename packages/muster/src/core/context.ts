import { createHash } from 'node:crypto'
import { Failure, misuse } from '../failure.ts'
import { actorId, inScope, LIMITS, type Attachment, type By, type Caller, type Message, type Permission } from '../model.ts'
import { append, type Draft } from '../store/log.ts'
import { blocksIn } from './blocks.ts'
import type { Db } from '../store/sqlite.ts'

/** How many a read returns: what was asked, held to a ceiling. Anything but a whole number of at least 1 is refused, so no value slips past the ceiling. */
export function limitOf(limit: number | undefined, normally: number, most: number): number {
  if (limit === undefined || limit === null) return normally
  if (!Number.isInteger(limit) || limit < 1) throw misuse('invalid_limit', '--limit is a whole number of at least 1.')
  return Math.min(limit, most)
}

/** What every operation gets: the open file, the clock, and a way to check whether a process lives. */
export type Context = {
  db: Db
  now: () => Date
  /** Whether the process a claim recorded is still the one running. Injected in tests. */
  alive: (pid: number, start: string) => boolean
}

export const byOf = (caller: Caller): By => ({ principal: caller.principal, profile: caller.profile })

/** Whether `caller` may do `permission` in `channel`. A caller with no `can` may do everything. */
export function allowed(caller: Caller, channel: string, permission: Permission): boolean {
  if (!caller.can) return true
  // A private channel is reached only by a token that names it: `*` and a subtree above it don't.
  const exact = caller.privates?.includes(channel) === true
  for (const [pattern, permissions] of Object.entries(caller.can)) {
    if (exact && pattern !== channel) continue
    const matches = pattern === '*' || inScope(channel, pattern.endsWith('/') ? { path: pattern.slice(0, -1), tree: true } : { path: pattern, tree: false })
    if (matches && (permissions.includes(permission) || permissions.includes('manage'))) return true
  }
  return false
}

export function authorize(caller: Caller, channel: string, permission: Permission) {
  if (allowed(caller, channel, permission)) return
  // A channel a caller can't read doesn't exist for it.
  if (permission === 'read' || !allowed(caller, channel, 'read')) throw new Failure('not_found', `No channel "${channel}".`)
  throw new Failure('forbidden', `You can't ${permission} in "${channel}".`, { hint: 'Ask whoever runs the board for access.' })
}

type MessageRow = {
  id: number
  channel: string
  thread: number
  re: number | null
  reply_to: number | null
  principal: string
  profile: string | null
  text: string
  labels: string
  reactions: string
  attachments: string
  revision: number
  deleted: number
  no_sync: number
  at: string
  edited_at: string | null
  activity: number
}

export const toMessage = (db: Db, row: MessageRow): Message => ({
  id: row.id,
  channel: row.channel,
  thread: row.thread,
  re: row.re,
  replyTo: row.reply_to,
  by: { principal: row.principal, profile: row.profile },
  text: row.text,
  labels: JSON.parse(row.labels) as Record<string, string>,
  reactions: JSON.parse(row.reactions) as Record<string, string[]>,
  attachments: JSON.parse(row.attachments) as Attachment[],
  blocks: row.deleted === 1 ? [] : blocksIn(db, row.text),
  revision: row.revision,
  deleted: row.deleted === 1,
  noSync: row.no_sync === 1,
  at: row.at,
  editedAt: row.edited_at,
})

export function findMessage(db: Db, id: number): Message | null {
  const row = db.raw.prepare('select * from messages where id = ?').get(id) as MessageRow | undefined
  return row ? toMessage(db, row) : null
}

/** The message with that ID, for a caller who may read its channel. Anything else is `not_found`. */
export function messageFor(ctx: Context, caller: Caller, id: number): Message {
  const message = Number.isSafeInteger(id) ? findMessage(ctx.db, id) : null
  if (!message || !allowed(caller, message.channel, 'read')) throw new Failure('not_found', `No message ${id}.`)
  return message
}

export const fingerprintOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Runs a write once per idempotency key. A repeat with the same request gets the first answer, read
 * again; the same key on a different request is refused.
 */
export function once<T>(
  ctx: Context,
  caller: Caller,
  key: string | undefined,
  request: unknown,
  run: (emit: (draft: Draft) => ReturnType<typeof append>) => { answer: T; ref: unknown },
  recall: (ref: any) => T,
): T {
  const at = ctx.now().toISOString()
  return ctx.db.write(() => {
    const emit = (draft: Draft) => append(ctx.db, draft, at)
    if (key === undefined) return run(emit).answer
    if (key.length === 0 || key.length > LIMITS.idempotencyKey) throw new Failure('invalid_idempotency_key', 'An idempotency key is 1 to 200 characters.', { exit: 2 })
    const scoped = `${actorId(byOf(caller))}\n${key}`
    const fingerprint = fingerprintOf(request)
    const seen = ctx.db.raw.prepare('select fingerprint, answer from idempotency where key = ?').get(scoped) as { fingerprint: string; answer: string } | undefined
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new Failure('idempotency_mismatch', 'That idempotency key was used for a different request.', { hint: 'Use a new key for a new request.' })
      }
      return recall(JSON.parse(seen.answer))
    }
    const { answer, ref } = run(emit)
    emit({ type: 'idem.recorded', by: byOf(caller), data: { idem: { key: scoped, fingerprint, answer: ref } } })
    return answer
  })
}
