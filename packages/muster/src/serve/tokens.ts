import { randomBytes } from 'node:crypto'
import { Failure, misuse } from '../failure.ts'
import { profileName, type Permission } from '../model.ts'
import type { Db } from '../store/sqlite.ts'
import { mint, type Claims } from './token.ts'

/** What the board remembers of a token it made: enough to list it and to stop it, never the token itself. */
export type TokenRecord = { id: string; profile: string | null; can: Record<string, Permission[]> | null; exp: number; at: number; revoked: boolean }

/** The tokens a board has made. */
export type Registry = {
  record(token: TokenRecord): void
  revoke(id: string): boolean
  /** Whether a token with this ID is to be refused: it was stopped, or the board has no record of making it. */
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
    revoked: (id) => tokens.get(id)?.revoked !== false,
    list: (now) => [...tokens.values()].filter((token) => token.exp * 1000 > now),
  }
}

/**
 * The registry for a board: a table in the board's own file. The store already writes one
 * transaction at a time and never half a row, so a revocation can't be lost to another writer or to
 * a crash, and there is no file of ours to lock, mend or tidy.
 */
export function dbRegistry(db: Db, clock: () => number = () => Date.now()): Registry {
  type Row = { id: string; profile: string | null; can: string | null; exp: number; at: number; revoked: number }
  const view = (row: Row): TokenRecord => ({ id: row.id, profile: row.profile, can: row.can ? (JSON.parse(row.can) as Record<string, Permission[]>) : null, exp: row.exp, at: row.at, revoked: row.revoked === 1 })
  return {
    record(token) {
      db.write(() => {
        const now = Math.floor(clock() / 1000)
        // What ran out opens nothing, so it is forgotten as new ones are made.
        db.raw.prepare('delete from tokens where exp <= ?').run(now)
        const live = (db.raw.prepare('select count(*) as n from tokens where revoked = 0').get() as { n: number }).n
        if (live >= TOKENS_MAX) throw new Failure('too_many_tokens', `This board has ${TOKENS_MAX} live tokens, which is the most it keeps.`, { hint: 'Revoke some with mu token revoke, or wait for them to run out.' })
        db.raw.prepare('insert into tokens (id, profile, can, exp, at, revoked) values (?, ?, ?, ?, ?, 0)').run(token.id, token.profile, token.can ? JSON.stringify(token.can) : null, token.exp, token.at)
      })
    },
    revoke(id) {
      return db.write(() => (db.raw.prepare('update tokens set revoked = 1 where id = ? returning id').get(id) as { id: string } | undefined) !== undefined)
    },
    // Every token with an ID was written here when it was made. One the board has no record of (a board
    // restored from before it, or a row removed) can't be vouched for, so it is treated as stopped.
    revoked: (id) => (db.raw.prepare('select revoked from tokens where id = ?').get(id) as { revoked: number } | undefined)?.revoked !== 0,
    list: (now) => (db.raw.prepare('select * from tokens where exp > ? order by at, id').all(Math.floor(now / 1000)) as Row[]).map(view),
  }
}

/** How many tokens that still work a board keeps at once. A run's token lives minutes, so this is far more than a team needs. */
export const TOKENS_MAX = 1000

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
    // A maker that is itself held to a profile speaks only as that one, so it can't make a token that speaks as another.
    if (held.profile !== null && profile !== held.profile) throw new Failure('forbidden', `This token writes as ${held.profile}, so it can only make a token for ${held.profile}.`)
    if (Object.keys(can).length === 0) throw misuse('invalid_token', 'A token made this way is held to channels: name them.')
    if (Object.keys(can).includes('*')) throw misuse('invalid_token', "A token made this way can't reach every channel.")
    if (Object.values(can).some((permissions) => permissions.includes('manage'))) throw misuse('invalid_token', "A token made this way can't manage a channel.")
    if (request.ttl > REMOTE_TTL_MAX) throw misuse('invalid_ttl', 'A token made this way lives a day at most.')
    exp = Math.min(exp, held.exp)
  }
  const id = randomBytes(9).toString('base64url')
  const claims: Claims = { sub: maker.principal, profile, ...(Object.keys(can).length ? { can } : {}), exp, jti: id, ...(remote ? { minted: true } : {}), ...(request.noSync || maker.claims?.noSync ? { noSync: true } : {}) }
  const record: TokenRecord = { id, profile, can: Object.keys(can).length ? can : null, exp, at: Math.floor(now / 1000), revoked: false }
  registry.record(record)
  return { token: mint(key, claims), record }
}
