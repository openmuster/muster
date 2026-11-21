import { Failure, misuse } from '../failure.ts'
import type { Caller } from '../model.ts'
import type { Db } from '../store/sqlite.ts'
import { append } from '../store/log.ts'
import { byOf, type Context } from './context.ts'

/** Data a message carries beside its text: a fenced block that names the schema it follows. */
export type Block = { schema: string; data: unknown }

const FENCE = /```json#([a-z0-9][a-z0-9_.-]{0,63})@([1-9][0-9]*)[ \t]*\n([\s\S]*?)\n```/g
const NAME = /^([a-z0-9][a-z0-9_.-]{0,63})@([1-9][0-9]*)$/

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; additionalProperties?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }

const typeOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value)

/** What is wrong with `value` under `schema`, with where, or null. The part of JSON Schema a board needs, and no more. */
export function violation(schema: Schema, value: unknown, at = '$'): string | null {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) return `${at} is ${actual === 'object' || actual === 'array' || actual === 'integer' ? `an ${actual}` : actual}, not ${allowed.join(' or ')}`
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) return `${at} isn't one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} is under ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} is over ${schema.maximum}`
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} is shorter than ${schema.minLength}`
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const found = violation(schema.items, value[i], `${at}[${i}]`)
      if (found) return found
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) return `${at}.${key} is missing`
    for (const [key, inner] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const found = violation(inner, record[key], `${at}.${key}`)
        if (found) return found
      }
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in (schema.properties ?? {}))) return `${at}.${key} isn't in the schema`
  }
  return null
}

/** The blocks in a message's text, parsed. A program reads these and never the text. */
export function blocksOf(text: string): Block[] {
  const out: Block[] = []
  for (const match of text.matchAll(FENCE)) {
    try {
      out.push({ schema: `${match[1]}@${match[2]}`, data: JSON.parse(match[3]!) })
    } catch {
      // Refused on write; text written before its schema existed is shown as text.
    }
  }
  return out
}

/**
 * The blocks a stored message carries: each one that follows a schema the board has. A write through the
 * board was checked already, but text also arrives from a platform under sync, and that never was: so a
 * program that reads `blocks` is given only what the schema allows, wherever the text came from.
 */
export function blocksIn(db: Db, text: string): Block[] {
  const out: Block[] = []
  for (const match of text.matchAll(FENCE)) {
    const row = db.raw.prepare('select schema from schemas where name = ? and version = ?').get(match[1]!, Number(match[2])) as { schema: string } | undefined
    if (!row) continue
    try {
      const data: unknown = JSON.parse(match[3]!)
      if (violation(JSON.parse(row.schema) as Schema, data) === null) out.push({ schema: `${match[1]}@${match[2]}`, data })
    } catch {
      // Not JSON: it is text, and stays text.
    }
  }
  return out
}

/** Refuses text whose blocks aren't JSON, name a schema nobody registered, or don't follow it. */
export function checkBlocks(ctx: Context, text: string) {
  for (const match of text.matchAll(FENCE)) {
    const name = `${match[1]}@${match[2]}`
    const row = ctx.db.raw.prepare('select schema from schemas where name = ? and version = ?').get(match[1]!, Number(match[2])) as { schema: string } | undefined
    if (!row) throw new Failure('unknown_schema', `No schema "${name}".`, { next: ['mu schemas'] })
    let data: unknown
    try {
      data = JSON.parse(match[3]!)
    } catch (error) {
      throw new Failure('invalid_block', `The ${name} block isn't JSON: ${(error as Error).message}.`)
    }
    const wrong = violation(JSON.parse(row.schema) as Schema, data)
    if (wrong) throw new Failure('invalid_block', `The ${name} block doesn't follow its schema: ${wrong}.`, { data: { schema: name, at: wrong.split(' ')[0] } })
  }
}

/** Registers a schema under a name and a version. It never changes after: a new shape is a new version. */
export function schemaAdd(ctx: Context, caller: Caller, request: { name: string; schema: unknown }): { name: string; created: boolean } {
  const match = NAME.exec(request.name)
  if (!match) throw misuse('invalid_schema', `"${request.name}" isn't a schema name.`, 'A schema is named name@version: sandbox@1.')
  if (request.schema === null || typeof request.schema !== 'object' || Array.isArray(request.schema)) throw misuse('invalid_schema', 'A schema is a JSON object.')
  if (caller.can !== undefined && !Object.values(caller.can).some((permissions) => permissions.includes('manage'))) throw new Failure('forbidden', "You can't register schemas on this board.")
  return ctx.db.write(() => {
    const have = ctx.db.raw.prepare('select schema from schemas where name = ? and version = ?').get(match[1]!, Number(match[2])) as { schema: string } | undefined
    if (have) {
      if (have.schema !== JSON.stringify(request.schema)) throw new Failure('schema_exists', `${request.name} is registered and never changes.`, { hint: `Register ${match[1]}@${Number(match[2]) + 1}.` })
      return { name: request.name, created: false }
    }
    append(ctx.db, { type: 'schema.registered', by: byOf(caller), data: { name: match[1], version: Number(match[2]), schema: request.schema } }, ctx.now().toISOString())
    return { name: request.name, created: true }
  })
}

export function schemaList(ctx: Context): { schemas: { name: string; schema: unknown }[] } {
  const rows = ctx.db.raw.prepare('select name, version, schema from schemas order by name, version').all() as { name: string; version: number; schema: string }[]
  return { schemas: rows.map((row) => ({ name: `${row.name}@${row.version}`, schema: JSON.parse(row.schema) as unknown })) }
}
