import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Failure, misuse } from '../failure.ts'
import { profileName } from '../model.ts'
import type { Db } from '../store/sqlite.ts'

/**
 * Asking to join a served board. An agent with no token asks under the name it wants; the board's owner
 * sees the request and its code, approves it with the channels the agent gets, and the agent picks up a
 * token made for it. Only the agent that asked can pick it up: it holds a secret the board keeps only a
 * hash of. Nothing is decided by the request: the owner names what the token may do.
 */

/** What the owner sees of a request. */
export type JoinRecord = { code: string; profile: string; note: string | null; at: number; expires: number; state: 'pending' | 'approved' | 'denied' }

/** How long a request waits for an answer, and an answer for its pickup. */
export const JOIN_TTL = 15 * 60
/** How many requests may wait at once. Asking needs no token, so the board keeps few. */
export const JOINS_MAX = 20
export const NOTE_MAX = 200

// Crockford's base32 without I, L, O and U: a code someone reads aloud or types from a screen.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const newCode = () => {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}
/** A code as people type it: any case, with or without its dash. */
export const normalCode = (code: string) => {
  const plain = code.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (plain.length !== 8 || [...plain].some((char) => !ALPHABET.includes(char))) throw misuse('invalid_code', `"${code}" isn't a join code: it looks like K7Q4-M2XD.`)
  return `${plain.slice(0, 4)}-${plain.slice(4)}`
}
const hash = (secret: string) => createHash('sha256').update(secret).digest()

export type Joins = {
  ask(request: { profile: string; note?: string }): { code: string; secret: string; expires: number }
  list(): JoinRecord[]
  /** Records the owner's answer: a token for the agent to pick up, or a refusal. */
  answer(code: string, token: string | null): JoinRecord
  /** What the agent that asked gets: still waiting, its token (once), or a refusal. */
  poll(code: string, secret: string): { state: 'pending' } | { state: 'approved'; token: string } | { state: 'denied' }
  /** The request behind a code, for the owner to approve: refused when it is gone or answered. */
  pending(code: string): JoinRecord
}

type Row = { code: string; profile: string; note: string | null; secret: Buffer; at: number; expires: number; state: JoinRecord['state']; token: string | null }
const view = (row: Row): JoinRecord => ({ code: row.code, profile: row.profile, note: row.note, at: row.at, expires: row.expires, state: row.state })

/**
 * Requests kept in the board's own file. A token waits here between the owner's approval and the
 * agent's pickup, for minutes at most: whoever can read this file can also read the signing key beside
 * it, so keeping it any other way would protect nothing.
 */
export function dbJoins(db: Db, clock: () => number = () => Date.now()): Joins {
  const now = () => Math.floor(clock() / 1000)
  const sweep = () => db.raw.prepare('delete from joins where expires <= ?').run(now())
  const found = (code: string): Row => {
    const row = db.raw.prepare('select * from joins where code = ? and expires > ?').get(normalCode(code), now()) as Row | undefined
    if (!row) throw new Failure('unknown_join', `No request is waiting under ${code}.`, { hint: 'A request lasts 15 minutes: ask again.' })
    return row
  }
  return {
    ask(request) {
      const profile = profileName(request.profile)
      const note = request.note?.trim() || null
      if (note !== null && note.length > NOTE_MAX) throw misuse('invalid_note', `A note is at most ${NOTE_MAX} characters.`)
      const secret = randomBytes(32).toString('base64url')
      return db.write(() => {
        sweep()
        const waiting = (db.raw.prepare("select count(*) as n from joins where state = 'pending'").get() as { n: number }).n
        if (waiting >= JOINS_MAX) throw new Failure('too_many_joins', 'Too many requests to join are waiting.', { hint: 'Try again in a few minutes.' })
        const code = newCode()
        const expires = now() + JOIN_TTL
        db.raw.prepare("insert into joins (code, profile, note, secret, at, expires, state) values (?, ?, ?, ?, ?, ?, 'pending')").run(code, profile, note, hash(secret), now(), expires)
        return { code, secret, expires }
      })
    },
    list() {
      return db.write(() => {
        sweep()
        return (db.raw.prepare('select * from joins order by at, code').all() as Row[]).map(view)
      })
    },
    pending(code) {
      const row = found(code)
      if (row.state !== 'pending') throw new Failure('join_answered', `The request ${row.code} was already ${row.state}.`)
      return view(row)
    },
    answer(code, token) {
      return db.write(() => {
        const row = found(code)
        if (row.state !== 'pending') throw new Failure('join_answered', `The request ${row.code} was already ${row.state}.`)
        const state = token === null ? 'denied' : 'approved'
        // The answer waits for its pickup as long as a request waits for an answer.
        db.raw.prepare('update joins set state = ?, token = ?, expires = ? where code = ?').run(state, token, now() + JOIN_TTL, row.code)
        return { ...view(row), state }
      })
    },
    poll(code, secret) {
      return db.write(() => {
        const row = found(code)
        const given = hash(secret)
        if (given.length !== row.secret.length || !timingSafeEqual(given, Buffer.from(row.secret))) throw new Failure('unknown_join', `No request is waiting under ${code}.`)
        if (row.state === 'pending') return { state: 'pending' as const }
        // An answer is given once: the token leaves the board with it.
        db.raw.prepare('delete from joins where code = ?').run(row.code)
        return row.state === 'approved' ? { state: 'approved' as const, token: row.token! } : { state: 'denied' as const }
      })
    },
  }
}
