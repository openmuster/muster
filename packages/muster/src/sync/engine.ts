import { Failure } from '../failure.ts'
import type { Context } from '../core/context.ts'
import { findMessage } from '../core/context.ts'
import { head } from '../core/reads.ts'
import { holdIfEdited } from '../core/tasks.ts'
import type { By } from '../model.ts'
import { append, toEvent } from '../store/log.ts'
import { DELIVERY_ATTEMPTS, IMPORT_ATTEMPTS, type Inbound, type Provider, type Received } from './types.ts'

export type Sync = Record<string, Provider>

const board: By = { principal: 'board', profile: null }

/**
 * Takes a platform's webhook: checks it is the platform's, stores what it carried, and only then
 * answers. A stored event is imported right away, and again by the ticker if that fails.
 */
export function receive(ctx: Context, sync: Sync, key: string, received: Received): { status: number; body: string } {
  const provider = sync[key]
  if (!provider) return { status: 404, body: 'no such sync' }
  try {
    provider.verify(received)
  } catch {
    return { status: 401, body: 'bad signature' }
  }
  const challenge = provider.challenge?.(received)
  if (challenge) return { status: 200, body: challenge }
  let events: Inbound[]
  try {
    events = provider.parse(received)
  } catch {
    // Something this board doesn't read. Saying so again won't help the platform.
    return { status: 200, body: 'ignored' }
  }
  try {
    ctx.db.write(() => {
      for (const event of events) {
        ctx.db.raw.prepare('insert or ignore into inbox (key, id, received, payload) values (?, ?, ?, ?)').get(key, event.id, ctx.now().toISOString(), JSON.stringify(event))
      }
    })
  } catch {
    // Not stored: the platform must send it again.
    return { status: 500, body: 'not stored' }
  }
  importPending(ctx, sync, key)
  return { status: 200, body: 'ok' }
}

/** Imports what is in the inbox, oldest first, a platform thread at a time: one bad event holds only its own thread. */
export function importPending(ctx: Context, sync: Sync, only?: string): { imported: number; failed: number } {
  let imported = 0
  let failed = 0
  const rows = ctx.db.raw.prepare('select key, id, payload, attempts from inbox where done = 0 order by received, id').all() as { key: string; id: string; payload: string; attempts: number }[]
  const stuck = new Set<string>()
  for (const row of rows) {
    if (only !== undefined && row.key !== only) continue
    const provider = sync[row.key]
    if (!provider) continue
    const event = JSON.parse(row.payload) as Inbound
    const lane = `${row.key}\n${event.thread}`
    if (stuck.has(lane)) continue
    try {
      ctx.db.write(() => {
        importOne(ctx, provider, row.key, event)
        ctx.db.raw.prepare('update inbox set done = 1 where key = ? and id = ?').get(row.key, row.id)
      })
      imported++
    } catch {
      failed++
      const attempts = row.attempts + 1
      ctx.db.write(() => ctx.db.raw.prepare('update inbox set attempts = ?, done = ? where key = ? and id = ?').get(attempts, attempts >= IMPORT_ATTEMPTS ? 1 : 0, row.key, row.id))
      if (attempts < IMPORT_ATTEMPTS) stuck.add(lane)
    }
  }
  return { imported, failed }
}

function importOne(ctx: Context, provider: Provider, key: string, event: Inbound) {
  // The app's own writes come back as webhooks; so does what the board itself delivered.
  if (event.self) return
  if (event.text !== undefined && provider.filter) {
    const kept = provider.filter(event.text)
    if (kept === null) return
    event = { ...event, text: kept }
  }
  if (event.kind === 'edit' || event.kind === 'delete') {
    const link = ctx.db.raw.prepare('select message from links where key = ? and external = ?').get(key, event.external) as { message: number } | undefined
    const target = link ? findMessage(ctx.db, link.message) : null
    if (!target || target.deleted) return
    const who: By = { principal: `${key}:user:${event.author}`, profile: null }
    const when = ctx.now().toISOString()
    if (event.kind === 'delete') append(ctx.db, { type: 'message.deleted', by: who, channel: target.channel, thread: target.thread, data: { id: target.id, origin: { key } } }, when)
    else if (event.text !== undefined && event.text !== target.text) {
      append(ctx.db, { type: 'message.edited', by: who, channel: target.channel, thread: target.thread, data: { id: target.id, text: event.text, revision: target.revision + 1, mentions: [], origin: { key } } }, when)
      // A task's brief changed from outside is instructions nobody on the board wrote: its owner looks first.
      holdIfEdited(ctx, who, target, (draft) => append(ctx.db, draft, when))
    }
    return
  }
  if (ctx.db.raw.prepare('select 1 from links where key = ? and external = ?').get(key, event.external) && event.kind !== 'labels') return
  const at = ctx.now().toISOString()
  const by: By = { principal: `${key}:user:${event.author}`, profile: null }
  const root = ctx.db.raw.prepare('select message from links where key = ? and external = ?').get(key, event.thread) as { message: number } | undefined

  if (event.kind === 'labels') {
    if (!root) return
    const message = findMessage(ctx.db, root.message)
    if (!message) return
    const set: Record<string, string> = {}
    for (const [name, value] of Object.entries(event.labels ?? {})) if (message.labels[name] !== value) set[name] = value
    if (Object.keys(set).length) append(ctx.db, { type: 'labels.changed', by, channel: message.channel, thread: message.thread, data: { id: message.id, set, unset: [], before: message.labels } }, at)
    return
  }

  if (event.kind === 'root' || !root) {
    const channel = provider.channelFor(event.place, event.kind)
    if (!channel) return
    // A reply whose root the board never saw starts the thread here.
    append(
      ctx.db,
      {
        type: 'message.posted',
        by,
        channel,
        thread: 'self',
        data: { re: null, replyTo: null, text: event.text ?? '', labels: { ...(event.labels ?? {}), source: key }, attachments: [], noSync: false, mentions: [], origin: { key, external: event.kind === 'root' ? event.external : event.thread, thread: event.thread, place: event.place } },
      },
      at,
    )
    if (event.kind === 'root') return
  }
  const linked = ctx.db.raw.prepare('select message from links where key = ? and external = ?').get(key, event.thread) as { message: number }
  const parent = findMessage(ctx.db, linked.message)!
  append(
    ctx.db,
    {
      type: 'message.posted',
      by,
      channel: parent.channel,
      thread: parent.thread,
      data: { re: parent.thread, replyTo: null, text: event.text ?? '', labels: {}, attachments: [], noSync: false, mentions: [], origin: { key, external: event.external, thread: event.thread, place: event.place } },
    },
    at,
  )
}

/**
 * Sends board replies in synced threads back to their platform, where the mapping mirrors. Each
 * message goes out once: a delivery is recorded with the ID the platform gave, and after five failed
 * tries the failure is recorded on the thread and the next message goes.
 */
export async function deliverPending(ctx: Context, sync: Sync, fetcher: typeof fetch = fetch): Promise<{ delivered: number; failed: number }> {
  let delivered = 0
  let failed = 0
  for (const [key, provider] of Object.entries(sync)) {
    const name = `sync:${key}`
    const stored = ctx.db.raw.prepare("select seq from cursors where name = ? and profile = ''").get(name) as { seq: number } | undefined
    let cursor = stored?.seq ?? head(ctx)
    if (!stored) ctx.db.write(() => ctx.db.raw.prepare("insert or ignore into cursors (name, profile, seq) values (?, '', ?)").get(name, cursor))
    const rows = ctx.db.raw.prepare("select * from events where seq > ? and type in ('message.posted', 'message.edited', 'message.deleted') order by seq limit 200").all(cursor) as Parameters<typeof toEvent>[0][]
    for (const row of rows) {
      const event = toEvent(row)
      const data = event.data as Record<string, any>
      const advance = () => {
        cursor = event.seq
        ctx.db.write(() => ctx.db.raw.prepare("update cursors set seq = ? where name = ? and profile = ''").get(cursor, name))
      }
      if (event.type !== 'message.posted') {
        // A change to something this platform has a copy of follows it there, once, with no retry.
        const copy = ctx.db.raw.prepare('select external, place from links where message = ? and key = ?').get(data.id, key) as { external: string; place: string | null } | undefined
        const rootCopy = event.thread === null ? undefined : (ctx.db.raw.prepare('select place from links where message = ? and key = ?').get(event.thread, key) as { place: string | null } | undefined)
        const where = copy?.place ?? rootCopy?.place ?? null
        // A change by a caller held to the board stays on the board, like what that caller posts.
        if (copy && where && data.origin?.key !== key && !data.noSync && provider.mirrors(where)) {
          try {
            if (event.type === 'message.edited') await provider.update?.(copy.external, String(data.text ?? ''), where, fetcher)
            else await provider.remove?.(copy.external, where, fetcher)
          } catch {
            // Best effort: the board's copy is the record.
          }
        }
        advance()
        continue
      }
      const isRoot = data.re === null
      const rootLink = event.thread === null ? undefined : (ctx.db.raw.prepare('select external, thread_external, place from links where message = ? and key = ?').get(event.thread, key) as { external: string; thread_external: string | null; place: string | null } | undefined)
      // A reply goes where its thread already is; a thread started on the board goes where its channel mirrors to.
      const place = isRoot ? (event.channel === null ? null : provider.placeFor(event.channel)) : (rootLink?.place ?? null)
      if (data.origin?.key === key || data.noSync || !place || !provider.mirrors(place) || (isRoot ? rootLink !== undefined : !rootLink)) {
        advance()
        continue
      }
      const message = findMessage(ctx.db, event.seq)
      if (!message || message.deleted) {
        advance()
        continue
      }
      try {
        const threadExternal = isRoot ? null : (rootLink!.thread_external ?? rootLink!.external)
        const sent = await provider.deliver(message, { place, threadExternal }, fetcher)
        ctx.db.write(() => {
          const at = ctx.now().toISOString()
          append(ctx.db, { type: 'sync.delivered', by: board, channel: message.channel, thread: message.thread, data: { id: message.id, key, external: sent.external, thread: sent.thread ?? threadExternal, place } }, at)
          if (isRoot && sent.labels) {
            // The labels an imported thread would have had, so a reader can't tell where a thread started.
            const current = findMessage(ctx.db, message.id)!
            const set: Record<string, string> = {}
            for (const [name, value] of Object.entries({ ...sent.labels, source: key })) if (current.labels[name] !== value) set[name] = value
            if (Object.keys(set).length) append(ctx.db, { type: 'labels.changed', by: board, channel: current.channel, thread: current.thread, data: { id: current.id, set, unset: [], before: current.labels } }, at)
          }
          ctx.db.raw.prepare("update cursors set seq = ? where name = ? and profile = ''").get(event.seq, name)
        })
        cursor = event.seq
        delivered++
      } catch (error) {
        failed++
        const attempts = ((ctx.db.raw.prepare('select attempts from outbox_attempts where key = ? and seq = ?').get(key, event.seq) as { attempts: number } | undefined)?.attempts ?? 0) + 1
        if (attempts < DELIVERY_ATTEMPTS) {
          ctx.db.write(() => ctx.db.raw.prepare('insert into outbox_attempts (key, seq, attempts) values (?, ?, ?) on conflict (key, seq) do update set attempts = excluded.attempts').get(key, event.seq, attempts))
          // Later messages in this platform's queue wait their turn behind it.
          break
        }
        ctx.db.write(() => {
          append(ctx.db, { type: 'sync.failed', by: board, channel: message.channel, thread: message.thread, data: { id: message.id, key, error: error instanceof Failure ? error.reason : String((error as Error).message).slice(0, 200) } }, ctx.now().toISOString())
          ctx.db.raw.prepare("update cursors set seq = ? where name = ? and profile = ''").get(event.seq, name)
        })
        cursor = event.seq
      }
    }
  }
  return { delivered, failed }
}

/**
 * Asks each platform that can say what happened while the board wasn't listening, and puts it in the
 * inbox like any webhook. An event already imported changes nothing, so asking twice is safe.
 */
export async function catchUp(ctx: Context, sync: Sync, fetcher: typeof fetch = fetch): Promise<{ fetched: number }> {
  let fetched = 0
  for (const [key, provider] of Object.entries(sync)) {
    if (!provider.catchUp) continue
    const last = ctx.db.raw.prepare('select max(received) as at from inbox where key = ?').get(key) as { at: string | null }
    // Nothing ever received means nothing to catch up from: a new sync starts with what comes next.
    if (!last.at) continue
    let events: Inbound[]
    try {
      events = await provider.catchUp(last.at, fetcher)
    } catch {
      continue
    }
    ctx.db.write(() => {
      for (const event of events) ctx.db.raw.prepare('insert or ignore into inbox (key, id, received, payload) values (?, ?, ?, ?)').get(key, event.id, ctx.now().toISOString(), JSON.stringify(event))
    })
    fetched += events.length
  }
  if (fetched) importPending(ctx, sync)
  return { fetched }
}
