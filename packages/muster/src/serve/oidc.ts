import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import { profileName, type Permission } from '../model.ts'

/**
 * A workload the board's owner trusts to sign in with a token its platform signed: a CI job, with the
 * OIDC token its runner gives it. It is the owner's configuration, in a file beside the board's key and
 * never on a board, and it says everything the board token will be: who it writes as and where.
 */
export type Trust = {
  name: string
  /** Who signed the token, exactly as its `iss` says. */
  issuer: string
  /** Who the token must be made out to: this board, by a name the owner chose. Never read from a request. */
  audience: string
  /** Which workload: the token's `sub`, exactly, or a prefix ending in `*` after a `:` or `/`. */
  sub: string
  /** The profile the board token writes as. */
  as: string
  can: Record<string, Permission[]>
  /** How long the board token lives, in seconds. */
  ttl: number
  /** Where the issuer's keys are, when it publishes no discovery document. */
  jwks?: string
  /** What the job writes stays on the board, and goes to no platform sync is set up with. */
  noSync?: true
}

export const oidcPath = () => join(configDir(), 'oidc.json')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const WORKLOAD: Permission[] = ['read', 'post', 'react', 'label']
export const OIDC_TTL_DEFAULT = 900
export const OIDC_TTL_MAX = 3600
/** How many board tokens one trusted workload may hold at once, so a job in a loop can't use up the board's. */
export const OIDC_LIVE_MAX = 50
const TOKEN_MAX = 8192
const KEYS_BODY_MAX = 256 * 1024
const KEYS_FRESH_MS = 10 * 60_000
const KEYS_RETRY_MS = 60_000
const FETCH_MS = 5000
const SKEW_S = 60

/** A URL the board may fetch keys from or trust as an issuer: https, or plain http to this machine alone. */
function safeUrl(input: unknown): URL | null {
  if (typeof input !== 'string') return null
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return null
  if (url.username || url.password || url.hash || url.search) return null
  return url
}

/**
 * A `sub` is unique within an issuer, and an issuer like GitLab.com signs for every customer it has under
 * one `iss`. So every trust names one: exactly, or by a prefix whose `*` comes right after a `:` or `/`,
 * which is where a platform puts the boundary between names, with at least two parts before it.
 */
export function subPattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 1024) return null
  const star = pattern.indexOf('*')
  if (star === -1) return pattern
  if (star !== pattern.length - 1) return null
  const before = pattern[star - 1]
  if (before !== ':' && before !== '/') return null
  // What comes before that boundary names an owner, not only a kind of name: `repo:acme/*` is one
  // organisation's repositories, and `repo:*` would be every repository its platform has.
  const owner = pattern.slice(0, star - 1)
  if (!/[:/]/.test(owner) || owner.split(/[:/]/).some((segment) => segment.length === 0)) return null
  return pattern
}

export const subMatches = (pattern: string, sub: string) => (pattern.endsWith('*') ? sub.startsWith(pattern.slice(0, -1)) && sub.length > pattern.length - 1 : sub === pattern)

function seconds(input: unknown): number | null {
  if (input === undefined) return OIDC_TTL_DEFAULT
  if (typeof input === 'number') return input
  const match = typeof input === 'string' ? /^([0-9]+)(s|m|h)?$/.exec(input) : null
  return match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] ?? 's']! : null
}

/** The owner's trusted workloads. A file that is missing means none; one that is wrong is a config error, and the board doesn't start. */
export function loadOidc(path = oidcPath()): Trust[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { trust?: unknown } | null)?.trust
  if (!Array.isArray(list)) throw new Failure('invalid_config', `${path} needs a "trust" array.`)
  const names = new Set<string>()
  const trusts = list.map((entry: Record<string, unknown> | null, index): Trust => {
    const name = entry?.name
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Failure('invalid_config', `Trust ${index + 1} in ${path} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
    if (names.has(name)) throw new Failure('invalid_config', `Two trusts in ${path} are named "${name}".`)
    names.add(name)
    const wrong = (what: string) => new Failure('invalid_config', `Trust "${name}" in ${path} ${what}`)
    if (!safeUrl(entry?.issuer)) throw wrong('needs an "issuer": the https URL its tokens name as "iss". Plain http is only for this machine.')
    const audience = entry?.audience
    if (typeof audience !== 'string' || audience.length === 0 || audience.length > 512) throw wrong('needs an "audience": the name the token must be made out to, such as this board\'s URL.')
    const sub = subPattern(entry?.sub)
    if (sub === null) throw wrong('needs a "sub": the workload\'s subject, exactly, or a prefix ending in "*" right after a ":" or "/", like "repo:acme/api:*".')
    let as: string
    try {
      as = profileName(String(entry?.as ?? ''))
    } catch {
      throw wrong('needs "as": the profile its token writes as.')
    }
    // No prototype: a key like "__proto__" is a channel pattern that fails the check below, never a way to an empty object.
    const can: Record<string, Permission[]> = Object.create(null) as Record<string, Permission[]>
    const given = entry?.can
    if (typeof given !== 'object' || given === null || Array.isArray(given) || Object.keys(given).length === 0) throw wrong('needs "can": the channels it may use, like { "ci/": ["read", "post"] }.')
    for (const [pattern, permissions] of Object.entries(given as Record<string, unknown>)) {
      if (pattern === '*' || pattern.length === 0) throw wrong('names every channel in "can". Name the ones a job needs.')
      if (!/^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*\/?$/.test(pattern)) throw wrong(`has "${pattern}" in "can", which isn't a channel or a path ending in "/".`)
      if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some((permission) => !WORKLOAD.includes(permission as Permission))) throw wrong(`has permissions for "${pattern}" that aren't from: ${WORKLOAD.join(', ')}.`)
      can[pattern] = permissions as Permission[]
    }
    const ttl = seconds(entry?.ttl)
    if (ttl === null || !Number.isInteger(ttl) || ttl < 60 || ttl > OIDC_TTL_MAX) throw wrong('has a "ttl" that isn\'t 1 minute to 1 hour, like "15m".')
    if (entry?.jwks !== undefined && !safeUrl(entry.jwks)) throw wrong('has a "jwks" that isn\'t an https URL.')
    if (entry?.noSync !== undefined && typeof entry.noSync !== 'boolean') throw wrong('has a "noSync" that isn\'t true or false.')
    return { name, issuer: entry!.issuer as string, audience, sub, as, can: { ...can }, ttl, ...(entry?.jwks !== undefined ? { jwks: entry.jwks as string } : {}), ...(entry?.noSync === true ? { noSync: true as const } : {}) }
  })
  // An issuer has one set of keys: two trusts that say otherwise can't both be right.
  for (const trust of trusts) {
    const other = trusts.find((candidate) => candidate.issuer === trust.issuer && candidate.jwks !== trust.jwks)
    if (other) throw new Failure('invalid_config', `Trusts "${trust.name}" and "${other.name}" in ${path} name one issuer and different "jwks".`)
  }
  return trusts
}

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string }
type Keys = { at: number; jwks: Jwk[]; failed?: Failure }

const refused = () => new Failure('unauthorized', "That isn't a token this board takes.", { hint: 'A board takes a workload\'s token only from an issuer its owner named, signed with that issuer\'s key.' })
const part = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A token that was taken. `release` gives it back when no board token came of it, so a refusal after this point doesn't cost the job its token. */
export type Verified = { trust: Trust; sub: string; exp: number; release: () => void }

/**
 * Checks a workload's token against the owner's trusts. Until its signature is verified it is refused
 * one way, whatever is wrong with it, and nothing is fetched for an issuer the owner didn't name. After
 * that, the refusal says which claim didn't fit, since only the issuer's own workloads get that far.
 */
export function verifier(trusts: readonly Trust[], options: { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void } = {}) {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const issuers = new Map<string, Trust[]>()
  for (const trust of trusts) issuers.set(trust.issuer, [...(issuers.get(trust.issuer) ?? []), trust])
  const cache = new Map<string, Keys>()
  const fetching = new Map<string, Promise<Jwk[]>>()
  const seen = new Map<string, number>()

  async function get(url: string): Promise<unknown> {
    // No redirect is followed: where the keys are is the issuer's own word, read from the issuer.
    // Nor is anything unpacked: a small body that inflates to a large one is read as the small one it is.
    const response = await doFetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_MS), headers: { accept: 'application/json', 'accept-encoding': 'identity' } })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    if (response.headers.get('content-encoding')) throw new Error(`${url} answered packed, which wasn't asked for`)
    // Counted as it arrives and dropped past the cap, so no answer is held in memory to be measured.
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body?.getReader()
    for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
      size += read.value.length
      if (size > KEYS_BODY_MAX) {
        await reader!.cancel().catch(() => {})
        throw new Error(`${url} answered more than a set of keys is`)
      }
      chunks.push(read.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function fetchKeys(issuer: string, trust: Trust): Promise<Jwk[]> {
    let where = trust.jwks
    if (where === undefined) {
      const document = (await get(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)) as { issuer?: unknown; jwks_uri?: unknown } | null
      if (document?.issuer !== issuer) throw new Error(`${issuer} describes itself as another issuer`)
      const uri = safeUrl(document.jwks_uri)
      // Plain http is for an issuer on this machine. One elsewhere can't point the board at this machine's own ports.
      if (!uri || (uri.protocol === 'http:' && new URL(issuer).protocol !== 'http:')) throw new Error(`${issuer} keeps its keys somewhere that isn't https`)
      where = uri.href
    }
    const set = (await get(where)) as { keys?: unknown } | null
    if (!Array.isArray(set?.keys)) throw new Error(`${where} isn't a set of keys`)
    return (set.keys as Jwk[]).filter((key) => typeof key === 'object' && key !== null)
  }

  /** The issuer's keys, kept for a while. `refresh` asks again for a key that wasn't there, at most once a minute for an issuer. */
  async function keysOf(issuer: string, refresh: boolean): Promise<Jwk[]> {
    const kept = cache.get(issuer)
    const age = kept ? now() - kept.at : Infinity
    if (kept && age < KEYS_RETRY_MS) {
      if (kept.failed) throw kept.failed
      return kept.jwks
    }
    if (kept && !kept.failed && !refresh && age < KEYS_FRESH_MS) return kept.jwks
    // One fetch for an issuer at a time, whoever asks: a burst of sign-ins is one question to the issuer.
    const under = fetching.get(issuer)
    if (under) return under
    const asking = fetchKeys(issuer, issuers.get(issuer)![0]!)
      .then(
        (jwks) => {
          cache.set(issuer, { at: now(), jwks })
          return jwks
        },
        (error: unknown) => {
          // Why is for the owner, in the board's own output. A caller with no token learns only that it failed.
          options.log?.(`oidc: couldn't get the keys of ${issuer}: ${(error as Error).message}`)
          // Keys it already has stay good: an issuer that fails once doesn't lock out the jobs it signed for.
          if (kept && !kept.failed && kept.jwks.length) {
            cache.set(issuer, { at: now(), jwks: kept.jwks })
            return kept.jwks
          }
          const failed = new Failure('issuer_unreachable', `Couldn't get the keys of ${issuer}.`, { hint: 'The board asks again in a minute. Whoever runs it can see why in its output.' })
          cache.set(issuer, { at: now(), jwks: [], failed })
          throw failed
        },
      )
      .finally(() => fetching.delete(issuer))
    fetching.set(issuer, asking)
    return asking
  }

  return async function verify(token: unknown): Promise<Verified> {
    if (typeof token !== 'string' || token.length > TOKEN_MAX) throw refused()
    const parts = token.split('.')
    // Each part as base64url writes it and no other way: bytes that decode the same must be the same text.
    if (parts.length !== 3 || parts.some((text) => !/^[A-Za-z0-9_-]+$/.test(text) || Buffer.from(text, 'base64url').toString('base64url') !== text)) throw refused()
    const header = part(parts[0]!)
    const claims = part(parts[1]!)
    // One algorithm, named here and not by the token: a token can't choose how it is checked.
    if (!header || !claims || header.alg !== 'RS256') throw refused()
    const issuer = claims.iss
    if (typeof issuer !== 'string' || !issuers.has(issuer)) throw refused()
    const signature = Buffer.from(parts[2]!, 'base64url')
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
    const usable = (key: Jwk) => key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256') && (typeof header.kid !== 'string' || key.kid === header.kid)
    const checks = (key: Jwk) => {
      try {
        const publicKey = createPublicKey({ key, format: 'jwk' })
        if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false
        return verifySignature('RSA-SHA256', signed, publicKey, signature)
      } catch {
        return false
      }
    }
    let candidates = (await keysOf(issuer, false)).filter(usable)
    if (candidates.length === 0) candidates = (await keysOf(issuer, true)).filter(usable)
    if (!candidates.slice(0, 8).some(checks)) throw refused()

    // From here the issuer vouches for the token, so it is told what didn't fit.
    const at = Math.floor(now() / 1000)
    const no = (message: string, hint?: string) => new Failure('forbidden', message, hint ? { hint } : {})
    if (typeof claims.exp !== 'number') throw no('That token says no time it runs out, so this board won\'t take it.')
    if (claims.exp + SKEW_S <= at) throw no('That token has run out.', 'Ask your platform for a new one: they live a few minutes.')
    for (const name of ['nbf', 'iat'] as const) if (typeof claims[name] === 'number' && (claims[name] as number) - SKEW_S > at) throw no('That token isn\'t good yet: check the clock of the machine that runs the board.')
    const sub = claims.sub
    if (typeof sub !== 'string' || sub.length === 0) throw no('That token names no subject.')
    const audiences = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).filter((aud): aud is string => typeof aud === 'string')
    const forBoard = issuers.get(issuer)!.filter((trust) => audiences.includes(trust.audience))
    if (forBoard.length === 0) throw no('That token isn\'t made out to this board.', 'Ask your platform for one with the audience the board\'s owner chose.')
    // The most exact trust that fits, whatever the file's order: an exact subject before a prefix, a longer prefix before a shorter.
    const trust = forBoard.filter((candidate) => subMatches(candidate.sub, sub)).sort((a, b) => Number(a.sub.endsWith('*')) - Number(b.sub.endsWith('*')) || b.sub.length - a.sub.length)[0]
    if (!trust) throw no(`This board trusts no workload named "${sub.slice(0, 200)}".`, 'Whoever runs the board names the workloads it takes, in its oidc.json.')
    // One board token for one workload token: a token someone copied opens nothing a second time. It is
    // known by what the issuer signed, which can't be written another way and still verify.
    const id = createHash('sha256').update(signed).digest('hex')
    for (const [old, until] of seen) if (until <= at) seen.delete(old)
    if (seen.has(id)) throw no('That token was already used here.', 'Ask your platform for a new one.')
    if (seen.size >= 10_000) throw new Failure('too_many_tokens', 'This board is taking more sign-ins than it keeps track of.', { hint: 'Try again in a minute.' })
    // Taken here, before anything else runs, so two requests with one token can't both pass.
    seen.set(id, claims.exp + SKEW_S)
    return { trust, sub, exp: claims.exp, release: () => void seen.delete(id) }
  }
}
