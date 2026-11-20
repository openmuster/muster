import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Failure, misuse } from '../failure.ts'
import type { Attachment, Caller } from '../model.ts'
import { messageFor, type Context } from './context.ts'

/** The largest file a board takes in one request. */
export const FILE_MAX = 25 * 1024 * 1024

/** Where a board's files live: a folder beside its file, each named by the hash of what it holds. */
export const filesDir = (ctx: Context) => (ctx.db.path === ':memory:' ? null : ctx.db.path.replace(/\.db$/, '') + '.files')

const memory = new WeakMap<object, Map<string, Buffer>>()
const held = (ctx: Context) => {
  let map = memory.get(ctx.db.raw)
  if (!map) memory.set(ctx.db.raw, (map = new Map()))
  return map
}

/** Stores a file and returns the record a message carries. The same bytes stored twice are one file. */
export function filePut(ctx: Context, _caller: Caller, request: { name: string; type?: string; data: string }): Attachment {
  if (typeof request.name !== 'string' || request.name.length === 0 || request.name.length > 255) throw misuse('invalid_file', 'A file needs a name of at most 255 characters.')
  const bytes = Buffer.from(request.data, 'base64')
  if (bytes.length > FILE_MAX) throw new Failure('file_too_large', `${request.name} is over 25 MB.`, { hint: 'Compress it, or link to it.' })
  const id = createHash('sha256').update(bytes).digest('hex')
  const dir = filesDir(ctx)
  if (dir === null) held(ctx).set(id, bytes)
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existsSync(join(dir, id))) writeFileSync(join(dir, id), bytes, { mode: 0o600 })
  }
  return { id, name: request.name, type: request.type ?? 'application/octet-stream', size: bytes.length }
}

/** A file, for a caller who can read the message that carries it. A file's ID alone opens nothing. */
export function fileGet(ctx: Context, caller: Caller, request: { message: number; id: string }): Attachment & { data: string } {
  const message = messageFor(ctx, caller, request.message)
  const record = message.attachments.find((file) => file.id === request.id)
  if (!record || !/^[0-9a-f]{64}$/.test(request.id)) throw new Failure('not_found', `Message ${request.message} carries no such file.`)
  const dir = filesDir(ctx)
  let bytes: Buffer | undefined
  if (dir === null) bytes = held(ctx).get(request.id)
  else {
    try {
      bytes = readFileSync(join(dir, request.id))
    } catch {
      bytes = undefined
    }
  }
  if (!bytes) throw new Failure('not_found', `The board no longer has ${record.name}.`)
  return { ...record, data: bytes.toString('base64') }
}

/** Whether the board has a file: a message may only carry files that were stored. */
export function fileKnown(ctx: Context, id: string): boolean {
  const dir = filesDir(ctx)
  return /^[0-9a-f]{64}$/.test(id) && (dir === null ? held(ctx).has(id) : existsSync(join(dir, id)))
}
