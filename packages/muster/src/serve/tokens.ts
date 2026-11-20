import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure, misuse } from '../failure.ts'
import { profileName, type Permission } from '../model.ts'
import { mint, type Claims } from './token.ts'

/** What the board remembers of a token it made: enough to list it and to stop it, never the token itself. */
export type TokenRecord = { id: string; profile: string | null; can: Record<string, Permission[]> | null; exp: number; at: number; revoked: boolean }

/** The tokens a board has made, kept beside its key: outside the board's file, with the operator's own things. */
export type Registry = {
  record(token: TokenRecord): void
  revoke(id: string): boolean
  revoked(id: string): boolean
  list(now: number): TokenRecord[]
}

/** A registry that lives as long as the process, for tests and for a board in memory. */
export function memoryRegistry(): Registry {
  const tokens = new Map<string, TokenRecord>()
  return {
    record: (token) => void tokens.set(token.id, token),
    revoke(id) {
      const found = tokens.get(id)
      if (found) found.revoked = true
      return found !== undefined
    },
    revoked: (id) => tokens.get(id)?.revoked === true,
    list: (now) => [...tokens.values()].filter((token) => token.exp * 1000 > now),
  }
}

/** The registry for a board on a file: one small JSON file, rewritten whole and swapped in. */
export function fileRegistry(where: string, dir = configDir()): Registry {
  const folder = join(dir, 'tokens')
  const path = join(folder, createHash('sha256').update(where).digest('hex').slice(0, 16) + '.json')
  const load = (): TokenRecord[] => {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { tokens: TokenRecord[] }).tokens
    } catch {
      return []
    }
  }
  const save = (tokens: TokenRecord[]) => {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const next = `${path}.${process.pid}.tmp`
    // A token that ran out can be forgotten: it no longer opens anything.
    writeFileSync(next, JSON.stringify({ tokens: tokens.filter((token) => token.exp * 1000 > Date.now()) }, null, 2), { mode: 0o600 })
    renameSync(next, path)
  }
  return {
    record: (token) => save([...load(), token]),
    revoke(id) {
      const tokens = load()
      const found = tokens.find((token) => token.id === id)
      if (!found) return false
      found.revoked = true
      save(tokens)
      return true
    },
    revoked: (id) => load().find((token) => token.id === id)?.revoked === true,
    list: (now) => load().filter((token) => token.exp * 1000 > now),
  }
}

export const PERMISSIONS: Permission[] = ['read', 'post', 'react', 'label', 'manage']
/** The longest a token made over HTTP lives. One for a person, made on the board's machine, has no such cap. */
export const REMOTE_TTL_MAX = 24 * 3600

export type MintRequest = { profile?: string | null; can?: Record<string, string[]>; ttl: number; noSync?: boolean }

/**
 * Makes a token. `maker` is who asks: null on the board's own machine, where the owner may make any
 * token, or the claims of the token a remote caller holds. A remote caller gets less: only a token
 * narrower than their own, held to a profile and to named channels, short-lived, and never from a
 * token that was itself made this way, so a token can't be used to make more.
 */
export function mintToken(key: Buffer, registry: Registry, maker: { principal: string; claims: Claims | null }, request: MintRequest, now: number): { token: string; record: TokenRecord } {
  const remote = maker.claims !== null
  const can: Record<string, Permission[]> = {}
  for (const [pattern, permissions] of Object.entries(request.can ?? {})) {
    if (!Array.isArray(permissions) || permissions.length === 0) throw misuse('invalid_permission', `"${pattern}" needs at least one permission.`)
    for (const permission of permissions) if (!PERMISSIONS.includes(permission as Permission)) throw misuse('invalid_permission', `"${permission}" isn't a permission.`, 'One of: read, post, react, label, manage.')
    can[pattern] = permissions as Permission[]
  }
  const profile = request.profile ? profileName(request.profile) : null
  if (!Number.isFinite(request.ttl) || request.ttl < 60) throw misuse('invalid_ttl', 'A token lives at least a minute.')
  let exp = Math.floor(now / 1000 + request.ttl)
  if (remote) {
    const held = maker.claims!
    if (held.can || held.minted) throw new Failure('forbidden', "A token that is held to channels, or was made from another, can't make tokens.", { hint: 'Ask whoever runs the board.' })
    if (profile === null) throw misuse('invalid_token', 'A token made this way is held to a profile: say which.')
    if (Object.keys(can).length === 0) throw misuse('invalid_token', 'A token made this way is held to channels: name them.')
    if (Object.keys(can).includes('*')) throw misuse('invalid_token', "A token made this way can't reach every channel.")
    if (Object.values(can).some((permissions) => permissions.includes('manage'))) throw misuse('invalid_token', "A token made this way can't manage a channel.")
    if (request.ttl > REMOTE_TTL_MAX) throw misuse('invalid_ttl', 'A token made this way lives a day at most.')
    exp = Math.min(exp, held.exp)
  }
  const id = randomBytes(9).toString('base64url')
  const claims: Claims = { sub: maker.principal, profile, ...(Object.keys(can).length ? { can } : {}), exp, jti: id, ...(remote ? { minted: true } : {}), ...(request.noSync ? { noSync: true } : {}) }
  const record: TokenRecord = { id, profile, can: Object.keys(can).length ? can : null, exp, at: Math.floor(now / 1000), revoked: false }
  registry.record(record)
  return { token: mint(key, claims), record }
}
