import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * The registry for a board on a file: a log, one line per token made and one per token stopped.
 * Lines are only ever added, so two processes writing at once lose nothing, and a revocation can't
 * be undone by a write that read the file a moment earlier.
 */
export function fileRegistry(where: string, dir = configDir()): Registry {
  const folder = join(dir, 'tokens')
  const path = join(folder, createHash('sha256').update(where).digest('hex').slice(0, 16) + '.log')
  type Line = { made: TokenRecord } | { revoked: string }
  /** Every token and whether it was stopped, or null when the file is there but can't be read as what we wrote. */
  let cached: { stamp: string; tokens: Map<string, TokenRecord> | null } | null = null
  /** Read once per change to the file, not once per request. */
  const load = (): Map<string, TokenRecord> | null => {
    let stamp: string
    try {
      const stat = statSync(path)
      stamp = `${stat.size}:${stat.mtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      return null
    }
    if (cached?.stamp === stamp) return cached.tokens
    const tokens = parse()
    cached = { stamp, tokens }
    return tokens
  }
  const parse = (): Map<string, TokenRecord> | null => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      return null
    }
    // A last line with no newline is a write caught halfway: it isn't there yet, and isn't damage.
    if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
    const tokens = new Map<string, TokenRecord>()
    const stopped = new Set<string>()
    try {
      for (const raw of text.split('\n')) {
        if (!raw) continue
        const line = JSON.parse(raw) as Line
        if ('made' in line) tokens.set(line.made.id, { ...line.made, revoked: false })
        else if (typeof line.revoked === 'string') stopped.add(line.revoked)
        else return null
      }
    } catch {
      return null
    }
    for (const id of stopped) {
      const found = tokens.get(id)
      if (found) found.revoked = true
      // A revocation for a token whose own line is missing still counts.
      else tokens.set(id, { id, profile: null, can: null, exp: Number.MAX_SAFE_INTEGER, at: 0, revoked: true })
    }
    return tokens
  }
  /** One writer at a time, so tidying the log can't drop a line another process is adding. */
  const locked = <T>(work: () => T): T => {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const lock = `${path}.lock`
    const mine = `${process.pid}:${randomBytes(6).toString('hex')}`
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const waited = Date.now()
    for (;;) {
      try {
        writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 })
        break
      } catch {
        // Someone holds it. It is taken over only when its holder is provably gone: the process that
        // wrote it no longer runs, or it has sat there far longer than any write takes.
        let gone = false
        try {
          const holder = Number(readFileSync(lock, 'utf8').split(':')[0])
          const age = Date.now() - statSync(lock).mtimeMs
          gone = age > 30_000 || (Number.isInteger(holder) && holder > 0 && !running(holder))
        } catch {
          // It went away between the two looks: try again.
        }
        if (gone) rmSync(lock, { force: true })
        else if (Date.now() - waited > 60_000) throw new Failure('token_list_busy', "The board's list of tokens is being written by another process.", { hint: 'Try again.' })
        else Atomics.wait(pause, 0, 0, 5)
      }
    }
    try {
      return work()
    } finally {
      // Only our own lock is ours to remove.
      try {
        if (readFileSync(lock, 'utf8') === mine) rmSync(lock, { force: true })
      } catch {
        // Already gone.
      }
    }
  }
  const add = (line: Line) =>
    locked(() => {
      const tokens = parse()
      if (tokens === null) throw unreadable()
      const live = [...tokens.values()].filter((token) => token.exp * 1000 > Date.now())
      if ('made' in line && live.filter((token) => !token.revoked).length >= TOKENS_MAX) {
        throw new Failure('too_many_tokens', `This board has ${TOKENS_MAX} live tokens, which is the most it keeps.`, { hint: 'Revoke some with mu token revoke, or wait for them to run out.' })
      }
      // The log is rewritten without what ran out once that is most of it, so it can't grow without end.
      if (tokens.size > 64 && live.length < tokens.size / 2) {
        const kept: Line[] = []
        for (const token of live) {
          if (token.at > 0) kept.push({ made: { ...token, revoked: false } })
          if (token.revoked) kept.push({ revoked: token.id })
        }
        const next = `${path}.${process.pid}.tmp`
        writeFileSync(next, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
        renameSync(next, path)
      }
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    })
  const unreadable = () => new Failure('token_list_unreadable', `The board's list of tokens at ${path} can't be read.`, { hint: 'Until it can, no token with an ID is accepted. Restore the file, or move it aside and make new tokens.' })
  return {
    record: (token) => add({ made: token }),
    revoke(id) {
      const tokens = load()
      if (tokens === null) throw unreadable()
      if (!tokens.has(id)) return false
      add({ revoked: id })
      return true
    },
    // A list that can't be read can't say a token is still good, so none is.
    revoked: (id) => {
      const tokens = load()
      return tokens === null || tokens.get(id)?.revoked === true
    },
    list(now) {
      const tokens = load()
      if (tokens === null) throw unreadable()
      return [...tokens.values()].filter((token) => token.exp * 1000 > now && token.at > 0)
    },
  }
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // No such process means gone; not being allowed to signal it means it is there.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
