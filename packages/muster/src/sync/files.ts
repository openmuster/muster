import type { Context } from '../core/context.ts'
import { FILE_MAX, storeBytes } from '../core/files.ts'
import { Failure } from '../failure.ts'
import { LIMITS, type Attachment } from '../model.ts'
import type { Sync } from './engine.ts'
import { SEND_MS, type Inbound } from './types.ts'

/** How many ticks a file that failed for a reason that may pass is tried before its message goes without it. */
export const FETCH_TRIES = 5

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
export const withLines = (text: string, lines: string[]) => (lines.length ? `${text}\n\n${lines.join('\n')}`.trim() : text)

/**
 * Fetches a file from a platform's own file host, and from nowhere else: https, a host on the list, no
 * redirect followed, and no more than a board file may hold, read a chunk at a time. The credential in
 * `headers` therefore only ever goes to that host.
 */
export async function fetchFile(fetcher: typeof fetch, url: string, options: { hosts: string[]; headers?: Record<string, string>; size?: number }): Promise<{ bytes: Buffer; type?: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw refused('not a link the board can read')
  }
  if (parsed.protocol !== 'https:' || !options.hosts.includes(parsed.hostname) || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') throw refused(`not on ${options.hosts.join(' or ')}`)
  if (options.size !== undefined && options.size > FILE_MAX) throw refused(`${sizeOf(options.size)}, over 25 MB`)
  const response = await fetcher(parsed.href, { headers: options.headers ?? {}, redirect: 'manual', signal: AbortSignal.timeout(SEND_MS) })
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw refused('the platform sent it somewhere else')
  if (response.status >= 400 && response.status < 500) throw refused(`the platform answered ${response.status}`)
  if (!response.ok) throw new Failure(`platform_${response.status}`, `The platform answered ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (declared > FILE_MAX) throw refused(`${sizeOf(declared)}, over 25 MB`)
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body?.getReader()
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > FILE_MAX) {
      await reader.cancel()
      throw refused('over 25 MB')
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
 * never fetched for.
 */
export async function fetchFiles(ctx: Context, sync: Sync, fetcher: typeof fetch): Promise<void> {
  const rows = ctx.db.raw.prepare("select key, id, payload from inbox where done = 0 and payload like '%\"files\":%' order by received, id").all() as { key: string; id: string; payload: string }[]
  for (const row of rows) {
    const provider = sync[row.key]
    const event = JSON.parse(row.payload) as Inbound
    if (!provider || !event.files?.length) continue
    const { files, ...rest } = event
    const tries = (event.fetched?.tries ?? 0) + 1
    const attachments: Attachment[] = []
    const notes: string[] = []
    let again = false
    const linked = (key: string, external: string) => ctx.db.raw.prepare('select 1 from links where key = ? and external = ?').get(key, external) !== undefined
    // A message whose every file the board put there is the board's own, come back: not imported.
    const ours = files.every((file) => file.id !== undefined && linked(`${row.key}/files`, `file:${file.id}`))
    if (!event.self && !ours && !linked(row.key, event.external)) {
      for (const [index, file] of files.entries()) {
        if (index >= LIMITS.attachments) {
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
        try {
          const got = await provider.download(file, fetcher)
          attachments.push({ id: storeBytes(ctx, got.bytes), name: safeName(file.name), type: safeType(file.type ?? got.type), size: got.bytes.length })
        } catch (error) {
          if (error instanceof Failure && error.reason === 'file_refused') notes.push(noteIn(file.name, error.message))
          else if (tries < FETCH_TRIES) again = true
          else notes.push(noteIn(file.name, 'the platform did not hand it over'))
        }
      }
    }
    // Tried again on the next tick, all of it: a file stored twice is one file.
    const next: Inbound = again ? { ...event, fetched: { attachments: [], notes: [], tries } } : { ...rest, ...(ours ? { self: true } : {}), fetched: { attachments, notes, tries } }
    ctx.db.write(() => ctx.db.raw.prepare('update inbox set payload = ? where key = ? and id = ? and done = 0').get(JSON.stringify(next), row.key, row.id))
  }
}
