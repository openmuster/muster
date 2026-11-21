import { Failure, misuse } from '../failure.ts'
import { actorId, channelScope, inScope, labelFilter, LIMITS, matchesLabels, profileName, type BoardEvent, type Caller, type LabelFilter, type Message } from '../model.ts'
import { toEvent } from '../store/log.ts'
import { allowed, findMessage, limitOf, messageFor, toMessage, type Context } from './context.ts'
import { findTask, type Task } from './tasks.ts'

export type ThreadSummary = { message: Message; replies: number; last: Message | null; task: Task | null }

export type Filter = {
  /** A channel or a subtree (`db/`). */
  channel?: string
  /** One thread, by its root. */
  re?: number
  labels?: string[]
  by?: string
  mentions?: string
  text?: string
  types?: string[]
}

export const head = (ctx: Context): number => (ctx.db.raw.prepare('select coalesce(max(seq), 0) as s from events').get() as { s: number }).s

const clampLimit = (limit: number | undefined) => limitOf(limit, LIMITS.read, LIMITS.readMax)

/** Whether an actor's ID is the one a `--mentions` names: the whole ID, or its profile or the end of its principal. */
const named = (id: string, who: string) => id === who || id.endsWith(`+${who}`) || id.endsWith(`:${who}`)

/** The actors a stored text mentions: a mention is kept in the text as `@[actor-id]`. */
const mentionedIn = (text: string) => [...text.matchAll(/@\[([^\]\s]+)\]/g)].map((match) => match[1]!)

/** The rowids a full-text query matches, or null when there is no query. */
function textMatches(ctx: Context, text: string | undefined): Set<number> | null {
  if (text === undefined) return null
  const query = '"' + text.replaceAll('"', '""') + '"'
  const rows = ctx.db.raw.prepare('select rowid from messages_fts where messages_fts match ?').all(query) as { rowid: number }[]
  return new Set(rows.map((row) => row.rowid))
}

export function readChannel(
  ctx: Context,
  caller: Caller,
  request: { channel: string; after?: number; before?: number; limit?: number; labels?: string[]; text?: string; mentions?: string },
): { threads: ThreadSummary[]; cursor: number; older: number | null; more: boolean } {
  const scope = channelScope(request.channel)
  if (!scope.tree && !allowed(caller, scope.path, 'read')) throw new Failure('not_found', `No channel "${scope.path}".`)
  const limit = clampLimit(request.limit)
  const filters = (request.labels ?? []).map(labelFilter)
  const found = textMatches(ctx, request.text)
  const cursor = head(ctx)

  const where = scope.tree ? "(channel = ? or channel like ? escape '\\')" : 'channel = ?'
  const args: (string | number)[] = scope.tree ? [scope.path, scope.path.replaceAll('%', '\\%').replaceAll('_', '\\_') + '/%'] : [scope.path]
  let sql = `select * from messages where re is null and deleted = 0 and ${where}`
  if (request.after !== undefined) {
    sql += ' and activity > ?'
    args.push(request.after)
  }
  if (request.before !== undefined) {
    sql += ' and activity < ?'
    args.push(request.before)
  }
  sql += ' order by activity desc'
  const rows = ctx.db.raw.prepare(sql).all(...args) as Parameters<typeof toMessage>[1][]

  const threads: ThreadSummary[] = []
  let more = false
  let oldest: number | null = null
  for (const row of rows) {
    const message = toMessage(ctx.db, row)
    if (!allowed(caller, message.channel, 'read')) continue
    if (!matchesLabels(message.labels, filters)) continue
    if (found) {
      const inThread = ctx.db.raw.prepare('select id from messages where thread = ?').all(message.id) as { id: number }[]
      if (!inThread.some((reply) => found.has(reply.id))) continue
    }
    if (request.mentions !== undefined) {
      // In the root or any reply still there: a thread is where someone was asked.
      const said = ctx.db.raw.prepare("select text from messages where thread = ? and deleted = 0 and text like '%@[%'").all(message.id) as { text: string }[]
      if (!said.some((reply) => mentionedIn(reply.text).some((id) => named(id, request.mentions!)))) continue
    }
    if (threads.length === limit) {
      more = true
      break
    }
    const stats = ctx.db.raw.prepare('select count(*) as n, max(id) as last from messages where thread = ? and re is not null and deleted = 0').get(message.id) as { n: number; last: number | null }
    threads.push({ message, replies: stats.n, last: stats.last === null ? null : findMessage(ctx.db, stats.last), task: findTask(ctx, message.id) })
    oldest = row.activity
  }
  return { threads, cursor, older: more ? oldest : null, more }
}

export function readThread(ctx: Context, caller: Caller, request: { id: number; after?: number; labels?: string[] }): { message: Message; replies: Message[]; task: Task | null; cursor: number } {
  const target = messageFor(ctx, caller, request.id)
  const root = target.re === null ? target : findMessage(ctx.db, target.thread)!
  const filters = (request.labels ?? []).map(labelFilter)
  const cursor = head(ctx)
  const rows = ctx.db.raw
    .prepare('select * from messages where thread = ? and re is not null and id > ? order by id')
    .all(root.id, request.after ?? 0) as Parameters<typeof toMessage>[1][]
  const replies = rows.map((row) => toMessage(ctx.db, row)).filter((reply) => !reply.deleted && matchesLabels(reply.labels, filters))
  return { message: root, replies, task: findTask(ctx, root.id), cursor }
}

type Compiled = {
  scope: ReturnType<typeof channelScope> | null
  re: number | null
  labels: LabelFilter[]
  by: string | null
  mentions: string | null
  text: string | null
  types: string[] | null
}

function compile(filter: Filter): Compiled {
  return {
    scope: filter.channel === undefined ? null : channelScope(filter.channel),
    re: filter.re ?? null,
    labels: (filter.labels ?? []).map(labelFilter),
    by: filter.by ?? null,
    mentions: filter.mentions ?? null,
    text: filter.text?.toLowerCase() ?? null,
    types: filter.types ?? null,
  }
}

/** Whether an actor reference a filter gives (`ada`, `local:user:ada`, `local:user:ada+claude`) names who wrote an event. */
function names(reference: string, event: BoardEvent): boolean {
  const id = actorId(event.by)
  if (reference === id || reference === event.by.principal) return true
  return reference === (event.by.profile ?? event.by.principal.slice(event.by.principal.lastIndexOf(':') + 1))
}

function matches(ctx: Context, caller: Caller, event: BoardEvent, filter: Compiled, roots: Map<number, Message | null>): boolean {
  if (event.type === 'idem.recorded') return false
  if (event.channel === null) return false
  if (!allowed(caller, event.channel, 'read')) return false
  if (filter.scope && !inScope(event.channel, filter.scope)) return false
  if (filter.re !== null && event.thread !== filter.re) return false
  if (filter.types && !filter.types.some((type) => (type.endsWith('.') ? event.type.startsWith(type) : event.type === type))) return false
  if (filter.by !== null && !names(filter.by, event)) return false
  const data = event.data as Record<string, any>
  if (filter.mentions !== null) {
    const mentioned = (data.mentions ?? []) as string[]
    if (!mentioned.some((id) => named(id, filter.mentions!))) return false
  }
  if (filter.text !== null && !(typeof data.text === 'string' && data.text.toLowerCase().includes(filter.text))) return false
  if (filter.labels.length > 0) {
    if (event.thread === null) return false
    let root = roots.get(event.thread)
    if (root === undefined) {
      root = findMessage(ctx.db, event.thread)
      roots.set(event.thread, root)
    }
    // An event matches if its thread matched before it or after it: a label that leaves a filter is news for that filter.
    const after = root ? matchesLabels(root.labels, filter.labels) : false
    const before = event.type === 'labels.changed' && data.id === event.thread ? matchesLabels((data.before ?? {}) as Record<string, string>, filter.labels) : false
    const stateBefore = typeof data.from === 'string' && root ? matchesLabels({ ...root.labels, 'board.task': data.from }, filter.labels) : false
    if (!after && !before && !stateBefore) return false
  }
  return true
}

export type FeedEvent = BoardEvent & { message?: Message; task?: Task }

/** What `tail` and `wait` read: the events after a cursor that match, oldest first, and where to read on from. */
export function events(ctx: Context, caller: Caller, request: { after?: number; filter?: Filter; limit?: number }): { events: FeedEvent[]; cursor: number } {
  const filter = compile(request.filter ?? {})
  if (filter.re !== null) messageFor(ctx, caller, filter.re)
  const limit = limitOf(request.limit, 200, 1000)
  const after = request.after ?? head(ctx)
  const roots = new Map<number, Message | null>()
  const gone = new Map<number, boolean>()
  const out: FeedEvent[] = []
  let cursor = after
  // Read in pages so a quiet filter on a busy board still moves its cursor forward.
  for (;;) {
    const rows = ctx.db.raw.prepare('select * from events where seq > ? order by seq limit 500').all(cursor) as Parameters<typeof toEvent>[0][]
    if (rows.length === 0) break
    for (const row of rows) {
      // What a reader sees of the event is also what a filter is matched against: a filter on text can't
      // find what a delete took away.
      const event = { ...toEvent(row) }
      event.data = shown(ctx, event, gone)
      if (matches(ctx, caller, event, filter, roots)) {
        const data = event.data as Record<string, any>
        const feed: FeedEvent = { ...event }
        const id = typeof data.id === 'number' ? data.id : event.type === 'message.posted' ? event.seq : null
        if (event.type.startsWith('message.') && id !== null) {
          const message = findMessage(ctx.db, id)
          if (message) feed.message = message
        }
        if (event.type.startsWith('task.') && id !== null) {
          const task = findTask(ctx, id)
          if (task) feed.task = task
        }
        out.push(feed)
      }
      cursor = event.seq
      if (out.length === limit) return { events: out, cursor }
    }
    if (rows.length < 500) break
  }
  return { events: out, cursor }
}

/**
 * An event as readers see it. A claim's secret never leaves the store. And the log keeps every event as
 * it was written, so what a deleted message said is dropped here, on the way out: its text, its labels
 * and its files, in the event that posted it and in every edit and label change since.
 */
function shown(ctx: Context, event: BoardEvent, gone: Map<number, boolean>): Record<string, unknown> {
  const { token: _token, idem: _idem, jti: _jti, ...rest } = event.data as Record<string, unknown>
  const carries = event.type === 'message.posted' || event.type === 'message.edited' || event.type === 'labels.changed'
  const id = event.type === 'message.posted' ? event.seq : rest.id
  if (!carries || typeof id !== 'number') return rest
  let deleted = gone.get(id)
  if (deleted === undefined) {
    deleted = (ctx.db.raw.prepare('select deleted from messages where id = ?').get(id) as { deleted: number } | undefined)?.deleted === 1
    gone.set(id, deleted)
  }
  if (!deleted) return rest
  const blank: Record<string, unknown> = { text: '', labels: {}, attachments: [], mentions: [], set: {}, unset: [], before: {} }
  for (const key of Object.keys(rest)) if (key in blank) rest[key] = blank[key]
  return rest
}

export function channels(ctx: Context, caller: Caller, request: { under?: string } = {}): { channels: { path: string; threads: number; activity: number | null }[] } {
  const scope = request.under === undefined ? null : channelScope(request.under.endsWith('/') ? request.under : request.under + '/')
  const rows = ctx.db.raw
    .prepare(
      `select c.path as path, count(m.id) as threads, max(m.activity) as activity
       from channels c left join messages m on m.channel = c.path and m.re is null and m.deleted = 0
       group by c.path order by c.path`,
    )
    .all() as { path: string; threads: number; activity: number | null }[]
  return { channels: rows.filter((row) => allowed(caller, row.path, 'read') && (!scope || inScope(row.path, scope))) }
}

export function actors(ctx: Context, caller?: Caller): { actors: { id: string; handle: string; principal: string; profile: string | null }[] } {
  const rows = ctx.db.raw.prepare("select principal, profile, handle from actors where principal != 'board' order by principal, profile").all() as { principal: string; profile: string; handle: string }[]
  // A token held to some channels sees only who wrote in them: a name is a fact about a channel too.
  const visible = (row: { principal: string; profile: string }) => {
    if (!caller?.can) return true
    const wrote = ctx.db.raw.prepare("select distinct channel from events where principal = ? and coalesce(profile, '') = ? and channel is not null").all(row.principal, row.profile) as { channel: string }[]
    return wrote.some((event) => allowed(caller, event.channel, 'read'))
  }
  return {
    actors: rows.filter(visible).map((row) => ({
      id: actorId({ principal: row.principal, profile: row.profile || null }),
      handle: row.handle,
      principal: row.principal,
      profile: row.profile || null,
    })),
  }
}

/** A reader's stored place: where it last read to, under a name of its choosing, per profile. */
export function cursorGet(ctx: Context, caller: Caller, name: string): number | null {
  const row = ctx.db.raw.prepare('select seq from cursors where name = ? and profile = ?').get(name, cursorOwner(caller)) as { seq: number } | undefined
  return row?.seq ?? null
}

export function cursorSet(ctx: Context, caller: Caller, name: string, seq: number): void {
  if (name.length === 0 || name.length > 100) throw misuse('invalid_cursor', 'A cursor name is 1 to 100 characters.')
  // A watcher, an outgoing webhook and a sync each know where they are by a cursor of this name, and a cursor
  // only moves forward: a token held to channels could silence one for good by moving it.
  if (caller.can && RESERVED_CURSOR.test(name)) throw new Failure('forbidden', `Cursors named "${name.slice(0, name.indexOf(':') + 1)}…" are the board's own.`, { hint: 'Use another name for yours.' })
  ctx.db.write(() => {
    ctx.db.raw
      .prepare('insert into cursors (name, profile, seq) values (?, ?, ?) on conflict (name, profile) do update set seq = max(seq, excluded.seq)')
      .get(name, cursorOwner(caller), seq)
  })
}

/** The names the daemon keeps its own places under: `watch:<watcher>`, `hook:<webhook>`, `sync:<platform>`. */
const RESERVED_CURSOR = /^(watch|hook|sync):/

const cursorOwner = (caller: Caller) => `${caller.principal}+${caller.profile === null ? '' : profileName(caller.profile)}`

export function search(ctx: Context, caller: Caller, request: { text: string; channel?: string; limit?: number }): { messages: Message[] } {
  if (request.text.trim().length === 0) throw misuse('empty_text', 'Say what to search for.')
  const scope = request.channel === undefined ? null : channelScope(request.channel)
  const limit = clampLimit(request.limit)
  const query = request.text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => '"' + word.replaceAll('"', '""') + '"')
    .join(' ')
  const rows = ctx.db.raw
    .prepare('select m.* from messages_fts f join messages m on m.id = f.rowid where messages_fts match ? order by m.id desc')
    .all(query) as Parameters<typeof toMessage>[1][]
  const messages: Message[] = []
  for (const row of rows) {
    const message = toMessage(ctx.db, row)
    if (message.deleted || !allowed(caller, message.channel, 'read')) continue
    if (scope && !inScope(message.channel, scope)) continue
    messages.push(message)
    if (messages.length === limit) break
  }
  return { messages }
}
