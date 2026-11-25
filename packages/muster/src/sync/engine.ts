import { Failure } from '../failure.ts'
import type { Context } from '../core/context.ts'
import { findMessage } from '../core/context.ts'
import { fileBytes } from '../core/files.ts'
import { head } from '../core/reads.ts'
import { holdIfEdited } from '../core/tasks.ts'
import { LIMITS, labelKey, labelValue, type By } from '../model.ts'
import { append, toEvent } from '../store/log.ts'
import { FILTERED, withLines } from './files.ts'
import { DELIVERY_ATTEMPTS, IMPORT_ATTEMPTS, SEND_MS, type Inbound, type Provider, type Received } from './types.ts'

export type Sync = Record<string, Provider>

const board: By = { principal: 'board', profile: null }

/**
 * A platform's labels, held to what a person's own are held to: a key or a value the board wouldn't take
 * from `mu label` is left out, and so is whatever comes after the most a message carries. So nothing
 * sync writes is a label a person can't then change or take off.
 */
function taken(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(labels)) {
    if (Object.keys(out).length >= LIMITS.labels) break
    try {
      out[labelKey(name)] = labelValue(name, value)
    } catch {
      // Not a label the board keeps: the rest of the event still is.
    }
  }
  return out
}

/** A delivery older than this is from a process that died mid-send, and no longer holds imports. */
const SENDING_STALE_MS = 2 * SEND_MS

/** Whether a delivery to this platform is out, from this process or another on the same board. */
function isSending(ctx: Context, key: string) {
  const after = new Date(ctx.now().getTime() - SENDING_STALE_MS).toISOString()
  return ctx.db.raw.prepare('select 1 from sending where key = ? and since > ?').get(key, after) !== undefined
}

/**
 * Takes a platform's webhook: checks it is the platform's, stores what it carried, and only then
 * answers. A stored event is imported right away, and again by the ticker if that fails.
 */
export function receive(ctx: Context, sync: Sync, key: string, received: Received): { status: number; body: string; skipped?: string[] } {
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
  const { stale } = importPending(ctx, sync, key)
  return { status: 200, body: 'ok', ...(stale.length ? { skipped: stale } : {}) }
}

/** Imports what is in the inbox, oldest first, a platform thread at a time: one bad event holds only its own thread. */
export function importPending(ctx: Context, sync: Sync, only?: string): { imported: number; failed: number; stale: string[] } {
  let imported = 0
  let failed = 0
  const stale: string[] = []
  // What a board imported before it stopped keeping payloads: emptied once, the first time it is looked at.
  if (ctx.db.raw.prepare("select 1 from inbox where done = 1 and payload != '{}' limit 1").get()) ctx.db.write(() => ctx.db.raw.prepare("update inbox set payload = '{}' where done = 1 and payload != '{}'").get())
  const rows = ctx.db.raw.prepare('select key, id, payload, attempts from inbox where done = 0 order by received, id').all() as { key: string; id: string; payload: string; attempts: number }[]
  const stuck = new Set<string>()
  for (const row of rows) {
    if (only !== undefined && row.key !== only) continue
    const provider = sync[row.key]
    if (!provider || isSending(ctx, row.key)) continue
    const event = JSON.parse(row.payload) as Inbound
    const lane = `${row.key}\n${event.thread}`
    if (stuck.has(lane)) continue
    // Its files are fetched on the ticker first; the rest of its thread waits for it.
    if (event.files?.length) {
      stuck.add(lane)
      continue
    }
    try {
      ctx.db.write(() => {
        const late = importOne(ctx, provider, row.key, event)
        if (late) stale.push(late)
        // On the board now, or not for it: the row stays, so the same delivery is never taken twice, and what it
        // carried goes. The inbox is bookkeeping, not a second copy of what people wrote.
        ctx.db.raw.prepare("update inbox set done = 1, payload = '{}' where key = ? and id = ?").get(row.key, row.id)
      })
      imported++
    } catch {
      failed++
      const attempts = row.attempts + 1
      ctx.db.write(() => ctx.db.raw.prepare("update inbox set attempts = ?, done = ?, payload = case when ? = 1 then '{}' else payload end where key = ? and id = ?").get(attempts, attempts >= IMPORT_ATTEMPTS ? 1 : 0, attempts >= IMPORT_ATTEMPTS ? 1 : 0, row.key, row.id))
      if (attempts < IMPORT_ATTEMPTS) stuck.add(lane)
    }
  }
  return { imported, failed, stale }
}

/**
 * Where the newest change applied to a platform thing (an issue, a comment) is kept: when the platform says it was
 * made, in ms. A cursor, so it is bookkeeping in the board's file and outlasts a restart; under `sync:`, so a caller
 * held to channels can't move it.
 */
const appliedCursor = (key: string, thing: string) => `sync:${key}:applied:${thing}`

const timeOf = (updated: string | undefined) => {
  const time = updated === undefined ? Number.NaN : Date.parse(updated)
  return Number.isNaN(time) ? null : time
}

/** A line saying why an event is skipped, when one no older than it has been applied to the same thing. */
function late(ctx: Context, key: string, thing: string, updated: string | undefined): string | null {
  const time = timeOf(updated)
  if (time === null) return null
  const row = ctx.db.raw.prepare("select seq from cursors where name = ? and profile = ''").get(appliedCursor(key, thing)) as { seq: number } | undefined
  if (!row || row.seq < time) return null
  return `${key} ${thing}: a change made at ${new Date(time).toISOString()} came after one made at ${new Date(row.seq).toISOString()}, and was not applied`
}

/** Notes that a change the platform made at `updated` is applied to a thing: one no newer that comes later is late. */
function applied(ctx: Context, key: string, thing: string, updated: string | undefined) {
  const time = timeOf(updated)
  if (time === null) return
  ctx.db.raw.prepare("insert into cursors (name, profile, seq) values (?, '', ?) on conflict (name, profile) do update set seq = max(seq, excluded.seq)").get(appliedCursor(key, thing), time)
}

/**
 * Whether the board set this label on a message after a time: a catch-up read before a webhook imported a newer
 * state would otherwise put the older one back. The thread's first message counts, since it carries its labels.
 */
function changedSince(ctx: Context, message: number, name: string, at: string | undefined) {
  if (at === undefined || Number.isNaN(Date.parse(at))) return false
  const latest = ctx.db.raw
    .prepare("select max(at) as at from events where seq = ? or (type = 'labels.changed' and json_extract(data, '$.id') = ? and json_extract(data, '$.set.\"' || ? || '\"') is not null)")
    .get(message, message, name.replaceAll('"', '')) as { at: string | null }
  return latest.at !== null && Date.parse(latest.at) > Date.parse(at)
}

/** Imports one event. Returns a line saying so when it is late, and skipped. */
function importOne(ctx: Context, provider: Provider, key: string, event: Inbound): string | undefined {
  // The app's own writes come back as webhooks; so does what the board itself delivered.
  if (event.self) return
  // A platform resends what wasn't answered, later, and a webhook can be held up: one that says less than what the
  // board already applied for the same issue or comment would put an older state back. Removals stay final, so a
  // delete is never late.
  const thing = event.kind === 'labels' ? event.thread : event.external
  if (event.kind === 'labels' || event.kind === 'edit') {
    const skip = late(ctx, key, thing, event.updated)
    if (skip) return skip
  }
  // What its files gave: those that came, and a line for each that didn't, so none is lost without a word.
  let attachments = event.fetched?.attachments ?? []
  if (event.text !== undefined) event = { ...event, text: withLines(event.text, event.fetched?.notes ?? []) }
  if (event.text !== undefined && provider.filter) {
    // The filter sees the text and the lines about files, never the files: one that drops or changes the
    // message can't vouch for them, so none of them is kept, and the message says so in words the filter can't touch.
    const kept = provider.filter(event.text)
    if (kept === null) return
    if (kept.trimEnd() !== event.text.trimEnd() && (attachments.length > 0 || event.fetched?.withheld)) {
      attachments = []
      event = { ...event, text: withLines(kept, [FILTERED]) }
    } else event = { ...event, text: kept }
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
    if (event.kind === 'edit') applied(ctx, key, thing, event.updated)
    return
  }
  if (ctx.db.raw.prepare('select 1 from links where key = ? and external = ?').get(key, event.external) && event.kind !== 'labels') return
  const text = event.text ?? ''
  const at = ctx.now().toISOString()
  const by: By = { principal: event.author ? `${key}:user:${event.author}` : key, profile: null }
  let root = ctx.db.raw.prepare('select message from links where key = ? and external = ?').get(key, event.thread) as { message: number } | undefined

  // About a platform thread the board never saw, and carrying it: start the thread from it, as its opener wrote it.
  if (!root && event.kind !== 'root' && event.parent) {
    const channel = provider.channelFor(event.place, 'root')
    if (!channel) return
    const text = provider.filter ? provider.filter(event.parent.text) : event.parent.text
    if (text === null) return
    append(
      ctx.db,
      {
        type: 'message.posted',
        // A platform that doesn't say who opened it: the thread is put down to the sync itself.
        by: { principal: event.parent.author ? `${key}:user:${event.parent.author}` : key, profile: null },
        channel,
        thread: 'self',
        data: { re: null, replyTo: null, text, labels: { ...taken({ source: key, ...event.parent.labels }), source: key }, attachments: [], noSync: false, mentions: [], origin: { key, external: event.thread, thread: event.thread, place: event.place } },
      },
      at,
    )
    root = ctx.db.raw.prepare('select message from links where key = ? and external = ?').get(key, event.thread) as { message: number }
  }

  if (event.kind === 'labels') {
    if (!root) return
    const message = findMessage(ctx.db, root.message)
    if (!message) return
    const wanted = taken(event.labels ?? {})
    // What the platform thread no longer has: a property it names, and any key under a prefix it owns.
    const unset = new Set((event.unset ?? []).filter((name) => name in message.labels))
    for (const prefix of event.owns ?? []) for (const name of Object.keys(message.labels)) if (name.startsWith(prefix) && !(name in wanted)) unset.add(name)
    for (const name of unset) if (name.startsWith('board.') || name in wanted) unset.delete(name)
    const set: Record<string, string> = {}
    let count = Object.keys(message.labels).length - unset.size
    // On catching up, a label the board has changed since the platform's own change is the newer, and stays.
    for (const name of unset) if (changedSince(ctx, message.id, name, event.at)) unset.delete(name)
    for (const [name, value] of Object.entries(wanted)) {
      if (message.labels[name] === value || changedSince(ctx, message.id, name, event.at)) continue
      if (!(name in message.labels) && ++count > LIMITS.labels) continue
      set[name] = value
    }
    if (Object.keys(set).length || unset.size) append(ctx.db, { type: 'labels.changed', by, channel: message.channel, thread: message.thread, data: { id: message.id, set, unset: [...unset], before: message.labels } }, at)
    // Noted even when it changed nothing here: an older one after it would still say less than this one did.
    applied(ctx, key, thing, event.updated)
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
        data: { re: null, replyTo: null, text: event.kind === 'root' ? text : (event.text ?? ''), labels: { ...taken({ source: key, ...(event.labels ?? {}) }), source: key }, attachments: event.kind === 'root' ? attachments : [], noSync: false, mentions: [], origin: { key, external: event.kind === 'root' ? event.external : event.thread, thread: event.thread, place: event.place } },
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
      data: { re: parent.thread, replyTo: null, text, labels: {}, attachments, noSync: false, mentions: [], origin: { key, external: event.external, thread: event.thread, place: event.place } },
    },
    at,
  )
  // A comment read with its latest edit: an older edit's webhook, after it, is late.
  applied(ctx, key, event.external, event.updated)
}

/**
 * Sends board replies in synced threads back to their platform, where the mapping mirrors. Each
 * message goes out once: a delivery is recorded with the ID the platform gave, and after five failed
 * tries the failure is recorded on the thread and the next message goes.
 */
export async function deliverPending(ctx: Context, sync: Sync, fetcher: typeof fetch = fetch): Promise<{ delivered: number; failed: number; stale: string[] }> {
  let delivered = 0
  let failed = 0
  const stale: string[] = []
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
      // Claimed before it goes, in one write: a sender on this board that got here first is sending it, or has
      // sent it, and this one leaves it to them. A claim older than a send can take is from a sender that died.
      const claim = ctx.db.write(() => {
        const done = ctx.db.raw.prepare("select seq from cursors where name = ? and profile = ''").get(name) as { seq: number } | undefined
        if (done && done.seq >= event.seq) return { done: done.seq }
        const held = ctx.db.raw.prepare('select since from sending where key = ? and seq = ?').get(key, event.seq) as { since: string } | undefined
        if (held && Date.parse(held.since) > ctx.now().getTime() - SENDING_STALE_MS) return { held: true }
        ctx.db.raw.prepare('insert or replace into sending (key, seq, since) values (?, ?, ?)').get(key, event.seq, ctx.now().toISOString())
        return {}
      })
      if ('done' in claim) {
        cursor = claim.done!
        continue
      }
      // Later messages in this platform's queue wait behind it, as they wait behind a failure.
      if ('held' in claim) break
      try {
        const threadExternal = isRoot ? null : (rootLink!.thread_external ?? rootLink!.external)
        const sent = await provider.deliver(message, { place, threadExternal }, fetcher, (id) => fileBytes(ctx, id))
        ctx.db.write(() => {
          // Recorded and released at once: a webhook for it, imported after this, finds the link.
          ctx.db.raw.prepare('delete from sending where key = ? and seq = ?').get(key, event.seq)
          const at = ctx.now().toISOString()
          append(ctx.db, { type: 'sync.delivered', by: board, channel: message.channel, thread: message.thread, data: { id: message.id, key, external: sent.external, thread: sent.thread ?? threadExternal, place, ...(sent.files?.length ? { files: sent.files } : {}) } }, at)
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
        ctx.db.write(() => ctx.db.raw.prepare('delete from sending where key = ? and seq = ?').get(key, event.seq))
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
    // What the platform sent while it was being written to waited; its answers are recorded now.
    stale.push(...importPending(ctx, sync, key).stale)
  }
  return { delivered, failed, stale }
}

/**
 * Asks each platform that can say what happened while the board wasn't listening, and puts it in the
 * inbox like any webhook. An event already imported changes nothing, so asking twice is safe.
 */
/**
 * Notes where each platform's catch-up starts, the last event received, unless one is noted already. A process
 * calls it before it takes a webhook or catches up, so a webhook that comes first doesn't move it past the gap.
 * It stays until a catch-up from it reads to the end; one that fails leaves it.
 */
export function holdCatchUp(ctx: Context, sync: Sync) {
  for (const [key, provider] of Object.entries(sync)) {
    if (!provider.catchUp) continue
    const last = ctx.db.raw.prepare('select max(received) as at from inbox where key = ?').get(key) as { at: string | null }
    // Nothing ever received means nothing to catch up from: a new sync starts with what comes next. The board's
    // clock and the platform's may disagree a little: it starts a few minutes back, and what it reads again is known.
    if (last.at) ctx.db.write(() => ctx.db.raw.prepare("insert or ignore into cursors (name, profile, seq) values (?, '', ?)").get(`catchup:${key}`, Date.parse(last.at!) - CATCHUP_SKEW_MS))
  }
}

/** How far before the last event received a catch-up starts, for the board's clock and the platform's to differ. */
export const CATCHUP_SKEW_MS = 5 * 60_000
/** How long a platform that refused a catch-up is left before it is asked again; one cut short goes on sooner. */
const CATCHUP_REFUSED_WAIT_MS = 5 * 60_000
const CATCHUP_MORE_WAIT_MS = 60_000

export async function catchUp(ctx: Context, sync: Sync, fetcher: typeof fetch = fetch): Promise<{ fetched: number; skipped: string[] }> {
  let fetched = 0
  const skipped: string[] = []
  for (const [key, provider] of Object.entries(sync)) {
    if (!provider.catchUp) continue
    const name = `catchup:${key}`
    const pending = ctx.db.raw.prepare("select seq from cursors where name = ? and profile = ''").get(name) as { seq: number } | undefined
    if (!pending) continue
    // Deadlines are stored: a wait set by another process, or before a restart, holds too.
    const wait = `catchup-wait:${key}`
    const until = ctx.db.raw.prepare("select seq from cursors where name = ? and profile = ''").get(wait) as { seq: number } | undefined
    if (until && until.seq > ctx.now().getTime()) continue
    const waitFor = (ms: number) => ctx.db.raw.prepare("insert into cursors (name, profile, seq) values (?, '', ?) on conflict (name, profile) do update set seq = excluded.seq").get(wait, ctx.now().getTime() + ms)
    const last = { at: new Date(pending.seq).toISOString() }
    let events: Inbound[]
    let resume: number | undefined
    try {
      const read = await provider.catchUp(last.at, fetcher)
      events = Array.isArray(read) ? read : read.events
      if (!Array.isArray(read)) {
        resume = Date.parse(read.resume)
        if (read.skipped) skipped.push(`${key}: changes made at ${read.skipped} may not have been read`)
        // A start point only moves on: one that wouldn't is the provider's fault, and is kept rather than read again forever.
        if (Number.isNaN(resume) || resume <= pending.seq) {
          skipped.push(`${key}: catch-up from ${last.at} could not move on`)
          resume = pending.seq
        }
      }
    } catch {
      ctx.db.write(() => waitFor(CATCHUP_REFUSED_WAIT_MS))
      continue
    }
    ctx.db.write(() => {
      for (const event of events) ctx.db.raw.prepare('insert or ignore into inbox (key, id, received, payload) values (?, ?, ?, ?)').get(key, event.id, ctx.now().toISOString(), JSON.stringify(event))
      // Cut short, a later tick goes on from where this one got to; read to the end, it is done. Only from the point
      // it read from: another process on the board may have moved it meanwhile.
      if (resume !== undefined) {
        ctx.db.raw.prepare("update cursors set seq = ? where name = ? and profile = '' and seq = ?").get(resume, name, pending.seq)
        waitFor(CATCHUP_MORE_WAIT_MS)
      } else {
        ctx.db.raw.prepare("delete from cursors where name = ? and profile = '' and seq = ?").get(name, pending.seq)
        ctx.db.raw.prepare("delete from cursors where name = ? and profile = ''").get(wait)
      }
    })
    fetched += events.length
  }
  if (fetched) skipped.push(...importPending(ctx, sync).stale)
  return { fetched, skipped }
}
