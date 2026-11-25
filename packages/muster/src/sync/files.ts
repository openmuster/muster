import type { Context } from '../core/context.ts'
import { FILE_MAX, storeBytes } from '../core/files.ts'
import { Failure } from '../failure.ts'
import { LIMITS, type Attachment } from '../model.ts'
import type { Sync } from './engine.ts'
import { SEND_MS, type Inbound, type Limit, type Remote } from './types.ts'

/** How many ticks a file that failed for a reason that may pass is tried before its message goes without it. */
export const FETCH_TRIES = 5

/** What files one sync may bring onto the board in a day (UTC), unless its `filesPerDay` says otherwise. */
export const SYNC_FILES_PER_DAY = 500 * 1024 * 1024

/** What one tick fetches at most, in bytes and time: the rest waits for the next, so schedules and watchers keep theirs. */
export const TICK_BYTES = 50 * 1024 * 1024
export const TICK_MS = 20_000

/**
 * Bytes of files each sync stored, by UTC day. Bookkeeping, like `cursors`: not a board fact, not in the log.
 * Counted when bytes are stored and never taken back, so deleting a message, or a message never imported,
 * gives none of a day's allowance back. Made here too, for a board made before it existed.
 */
const ensureCount = (ctx: Context) => ctx.db.raw.exec('create table if not exists sync_files (key text not null, day text not null, bytes integer not null, primary key (key, day)) without rowid')
const today = (ctx: Context) => ctx.now().toISOString().slice(0, 10)
const storedToday = (ctx: Context, key: string) => Number((ctx.db.raw.prepare('select bytes from sync_files where key = ? and day = ?').get(key, today(ctx)) as { bytes: number } | undefined)?.bytes ?? 0)

/** A file that will not be fetched however often it is tried: the reason is said in the message instead. */
export const refused = (why: string) => new Failure('file_refused', why)

/** A file's name as the board keeps it: one line, no path, no brackets that would end a note, at most 255 characters. */
export const safeName = (name: string) => name.replace(/[\u0000-\u001f\u007f/\\[\]]/g, '_').slice(0, 255) || 'file'

/** A content type, only when it is one: `type/subtype`, nothing else. */
const safeType = (type: string | undefined) => {
  const bare = (type ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(bare) ? bare : 'application/octet-stream'
}

export const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** The line a message carries for a file that did not come in with it. */
export const noteIn = (name: string, why: string) => `[file not imported: ${safeName(name)}: ${why}]`
/** The line a message carries on the platform for a board file that did not go out with it. */
export const noteOut = (name: string, why: string) => `[file not sent: ${safeName(name)}: ${why}]`
/** Said in place of a message's files when the operator's filter dropped or changed its text. */
export const FILTERED = '[files not imported: the filter changed this message]'
export const withLines = (text: string, lines: string[]) => (lines.length ? `${text}\n\n${lines.join('\n')}`.trim() : text)

/**
 * Fetches a file from a platform's own file host, and from nowhere else: https, a host on the list, no
 * redirect followed, and no more than a board file may hold, read a chunk at a time. The credential in
 * `headers` therefore only ever goes to that host.
 */
export async function fetchFile(fetcher: typeof fetch, url: string, options: { hosts: string[]; headers?: Record<string, string>; size?: number; limit?: Limit }): Promise<{ bytes: Buffer; type?: string }> {
  const { max, over } = options.limit ?? { max: FILE_MAX, over: 'over 25 MB' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw refused('not a link the board can read')
  }
  if (parsed.protocol !== 'https:' || !options.hosts.includes(parsed.hostname) || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') throw refused(`not on ${options.hosts.join(' or ')}`)
  if (options.size !== undefined && options.size > max) throw refused(`${sizeOf(options.size)}, ${over}`)
  const response = await fetcher(parsed.href, { headers: options.headers ?? {}, redirect: 'manual', signal: AbortSignal.timeout(SEND_MS) })
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw refused('the platform sent it somewhere else')
  if (response.status >= 400 && response.status < 500) throw refused(`the platform answered ${response.status}`)
  if (!response.ok) throw new Failure(`platform_${response.status}`, `The platform answered ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (declared > max) throw refused(`${sizeOf(declared)}, ${over}`)
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body?.getReader()
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw refused(over)
    }
    chunks.push(Buffer.from(value))
  }
  const type = response.headers.get('content-type')
  return { bytes: Buffer.concat(chunks), ...(type ? { type } : {}) }
}

/**
 * Fetches the files of events waiting in the inbox, before they are imported: a webhook is answered at
 * once, and this runs on the ticker. What it gives is written back into the event, and the files' URLs go
 * with the rest of its payload once it is imported. An event the board already has, or wrote itself, is
 * never fetched for. A file that came is kept when another on the same message is tried again.
 */
export async function fetchFiles(ctx: Context, sync: Sync, fetcher: typeof fetch, budget = { bytes: TICK_BYTES, ms: TICK_MS }): Promise<void> {
  const rows = ctx.db.raw.prepare("select key, id, payload from inbox where done = 0 and payload like '%\"files\":%' order by received, id").all() as { key: string; id: string; payload: string }[]
  if (rows.length) ctx.db.write(() => ensureCount(ctx))
  const started = performance.now()
  let spent = 0
  const spare = () => spent < budget.bytes && performance.now() - started < budget.ms
  const save = (row: { key: string; id: string }, next: Inbound) => ctx.db.write(() => ctx.db.raw.prepare('update inbox set payload = ? where key = ? and id = ? and done = 0').get(JSON.stringify(next), row.key, row.id))
  for (const row of rows) {
    if (!spare()) return
    const provider = sync[row.key]
    const event = JSON.parse(row.payload) as Inbound
    if (!provider || !event.files?.length) continue
    const { files, ...rest } = event
    const tries = event.fetched?.tries ?? 0
    const attachments: Attachment[] = [...(event.fetched?.attachments ?? [])]
    const notes: string[] = [...(event.fetched?.notes ?? [])]
    const linked = (key: string, external: string) => ctx.db.raw.prepare('select 1 from links where key = ? and external = ?').get(key, external) !== undefined
    // The board's own share of files it uploaded, come back: no text, in the thread it sent them to, and every file
    // its own. A person who shares one of them again, with words or elsewhere, is imported like anyone.
    const sentHere = (id: string) => ctx.db.raw.prepare("select 1 from links f join links m on m.message = f.message and m.key = ? where f.key = ? and f.external = ? and (m.thread_external = ? or m.external = ?)").get(row.key, `${row.key}/files`, `file:${id}`, event.thread, event.thread) !== undefined
    const ours = !(event.text ?? '').trim() && files.every((file) => file.id !== undefined && sentHere(file.id))
    // Nothing is fetched for a message the board won't keep: unmapped, or one the operator's filter drops or changes.
    const kept = provider.filter && event.text !== undefined ? provider.filter(event.text) : event.text
    const filtered = kept === null || (kept !== undefined && kept.trimEnd() !== (event.text ?? '').trimEnd())
    if (filtered || provider.channelFor(event.place, event.kind) === null) {
      save(row, { ...rest, fetched: { attachments: [], notes: [], tries, withheld: files.length } })
      continue
    }
    if (event.self || ours || linked(row.key, event.external)) {
      save(row, { ...rest, ...(ours ? { self: true } : {}), fetched: { attachments: [], notes: [], tries } })
      continue
    }
    const failed: Remote[] = []
    let left: Remote[] = []
    for (const [index, file] of files.entries()) {
      if (!spare()) {
        left = files.slice(index)
        break
      }
      if (attachments.length >= LIMITS.attachments) {
        notes.push(noteIn(file.name, `a message carries at most ${LIMITS.attachments} files`))
        continue
      }
      if (file.skip) {
        notes.push(noteIn(file.name, file.skip))
        continue
      }
      if (!provider.download) {
        notes.push(noteIn(file.name, 'this platform does not hand out files'))
        continue
      }
      // Anyone who can post in a synced place can send files: a day's allowance keeps them from filling the disk.
      const allowance = provider.filesPerDay ?? SYNC_FILES_PER_DAY
      const remaining = allowance - storedToday(ctx, row.key)
      const over = `over the ${sizeOf(allowance)} a day this sync may bring in`
      if (remaining <= 0) {
        notes.push(noteIn(file.name, over))
        continue
      }
      const limit: Limit = remaining < FILE_MAX ? { max: remaining, over } : { max: FILE_MAX, over: 'over 25 MB' }
      try {
        const got = await provider.download(file, fetcher, limit)
        spent += got.bytes.length
        // Counted in the same write as it is stored, and never given back.
        const id = ctx.db.write(() => {
          ctx.db.raw.prepare('insert into sync_files (key, day, bytes) values (?, ?, ?) on conflict (key, day) do update set bytes = bytes + excluded.bytes').get(row.key, today(ctx), got.bytes.length)
          return storeBytes(ctx, got.bytes)
        })
        attachments.push({ id, name: safeName(file.name), type: safeType(file.type ?? got.type), size: got.bytes.length })
      } catch (error) {
        if (error instanceof Failure && error.reason === 'file_refused') notes.push(noteIn(file.name, error.message))
        else if (tries + 1 < FETCH_TRIES) failed.push(file)
        else notes.push(noteIn(file.name, 'the platform did not hand it over'))
      }
    }
    // What failed is tried on a later tick, and only that; what wasn't reached waits without using a try.
    const waiting = [...failed, ...left]
    const next: Inbound = waiting.length ? { ...rest, files: waiting, fetched: { attachments, notes, tries: tries + (failed.length ? 1 : 0) } } : { ...rest, fetched: { attachments, notes, tries: tries + 1 } }
    save(row, next)
  }
}
