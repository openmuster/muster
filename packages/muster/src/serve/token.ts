import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import type { Permission } from '../model.ts'

export type Claims = {
  /** The principal the token speaks for. */
  sub: string
  /** The profile it is held to. Null lets the bearer name one per request. */
  profile: string | null
  /** What it may do, by channel pattern. Absent means everything. */
  can?: Record<string, Permission[]>
  /** When it stops working, in seconds since the epoch. */
  exp: number
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/**
 * The key a board's tokens are signed with. It is made once and kept, so a restart of `mu serve`
 * doesn't strand every client holding a token.
 */
export function boardKey(where: string, dir = configDir()): Buffer {
  const folder = join(dir, 'keys')
  const path = join(folder, createHash('sha256').update(where).digest('hex').slice(0, 16) + '.key')
  try {
    return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url')
  } catch {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    try {
      writeFileSync(path, b64(key), { mode: 0o600, flag: 'wx' })
      return key
    } catch {
      // Another process made it first.
      return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url')
    }
  }
}

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest()

export function mint(key: Buffer, claims: Claims): string {
  const body = `mu1.${b64(JSON.stringify(claims))}`
  return `${body}.${b64(sign(key, body))}`
}

const unauthorized = (message: string) => new Failure('unauthorized', message, { hint: 'Get a token from whoever runs the board: mu token create.' })

/** The claims of a token this board signed and that hasn't run out. Anything else is refused the same way. */
export function verify(key: Buffer, token: string | undefined, now: number): Claims {
  if (!token) throw unauthorized('This board needs a token.')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'mu1') throw unauthorized("That isn't a token for this board.")
  const given = Buffer.from(parts[2]!, 'base64url')
  const expected = sign(key, `${parts[0]}.${parts[1]}`)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("That isn't a token for this board.")
  let claims: Claims
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Claims
  } catch {
    throw unauthorized("That isn't a token for this board.")
  }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') throw unauthorized("That isn't a token for this board.")
  if (claims.exp * 1000 <= now) throw unauthorized('That token has run out.')
  return claims
}
