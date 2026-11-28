import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  /** Its ID in the board's list of tokens, by which it can be stopped. Absent on tokens from before there was one. */
  jti?: string
  /** It was made over HTTP from another token, so it can't make more. */
  minted?: true
  /** What its bearer writes stays on the board, whatever the request says. */
  noSync?: true
  /** It was made for an agent in a sandbox: it calls the routes a sandbox may, and no others. */
  sandbox?: true
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url')

/**
 * The key a board's tokens are signed with. It is made once and kept, so a restart of `mu serve`
 * doesn't strand every client holding a token.
 */
const keyName = (where: string) => createHash('sha256').update(where).digest('hex').slice(0, 16)

export function boardKey(where: string, dir = configDir()): Buffer {
  const folder = join(dir, 'keys')
  const path = join(folder, keyName(where) + '.key')
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

/**
 * Keys a board signed with before its current one, kept so the tokens they signed stay good until the owner
 * drops them (`mu token drop-old-keys`). Read when `mu serve` starts.
 */
export function retiredKeys(where: string, dir = configDir()): Buffer[] {
  const folder = join(dir, 'keys')
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const prefix = `${keyName(where)}.`
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.retired'))
    .sort()
    .map((name) => Buffer.from(readFileSync(join(folder, name), 'utf8').trim(), 'base64url'))
}

/**
 * Puts a new signing key in place of the board's current one, which is kept as retired: tokens it signed still
 * work, and every token made from now on is signed with the new one. Returns how many keys are retired.
 */
export function rotateKey(where: string, now: Date, dir = configDir()): { retired: number } {
  boardKey(where, dir)
  const folder = join(dir, 'keys')
  renameSync(join(folder, `${keyName(where)}.key`), join(folder, `${keyName(where)}.${now.toISOString().replace(/[:.]/g, '-')}.retired`))
  boardKey(where, dir)
  return { retired: retiredKeys(where, dir).length }
}

/** Deletes a board's retired keys, which stops every token they signed. Returns how many there were. */
export function dropRetiredKeys(where: string, dir = configDir()): { dropped: number } {
  const folder = join(dir, 'keys')
  const prefix = `${keyName(where)}.`
  let dropped = 0
  try {
    for (const name of readdirSync(folder)) {
      if (!name.startsWith(prefix) || !name.endsWith('.retired')) continue
      rmSync(join(folder, name))
      dropped++
    }
  } catch {
    // No keys folder: nothing was retired.
  }
  return { dropped }
}

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest()

export function mint(key: Buffer, claims: Claims): string {
  const body = `mu1.${b64(JSON.stringify(claims))}`
  return `${body}.${b64(sign(key, body))}`
}

const unauthorized = (message: string) => new Failure('unauthorized', message, { hint: 'Get a token from whoever runs the board: mu token create.' })

/** The claims of a token this board signed and that hasn't run out. Anything else is refused the same way. */
export function verify(key: Buffer | readonly Buffer[], token: string | undefined, now: number): Claims {
  if (!token) throw unauthorized('This board needs a token.')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'mu1') throw unauthorized("That isn't a token for this board.")
  const given = Buffer.from(parts[2]!, 'base64url')
  // The current key, then any the board retired and still keeps: every one is checked, so how long this takes
  // says nothing about which one matched.
  let signed = false
  for (const each of Buffer.isBuffer(key) ? [key] : key) {
    const expected = sign(each, `${parts[0]}.${parts[1]}`)
    if (given.length === expected.length && timingSafeEqual(given, expected)) signed = true
  }
  if (!signed) throw unauthorized("That isn't a token for this board.")
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
