import { Failure, misuse } from './failure.ts'

/** Who a request is from, as the policy verified it. A request body never says. */
export type Caller = {
  /** `local:user:ada`, `token:<subject>`, a platform author under sync. */
  principal: string
  /** Which of the principal's agents this is, or null for the principal itself. */
  profile: string | null
  /** What it may do, by channel pattern. Absent means everything (file mode, or a full token). */
  can?: Record<string, readonly Permission[]>
  /** The ID of the token it came with, where it has one: what a schedule is tied to, so stopping the token stops what it set going. */
  token?: string
  /** What a narrowed token's allowance is counted against: something the token carries, never a name the request chose. */
  meter?: string
  /** The private channels, as the board knows them: a narrowed caller reaches one only by its exact name. */
  privates?: readonly string[]
  /** What this caller writes never leaves the board for a synced platform. Set by its token, not by a request. */
  noSync?: true
  /** Its profile is the one its token is held to, not one the request named. Set by the server, never by a request. */
  profileHeld?: true
}

export type Permission = 'read' | 'post' | 'react' | 'label' | 'manage'

export type By = { principal: string; profile: string | null }

export type Attachment = { id: string; name: string; type: string; size: number }

export type Message = {
  id: number
  channel: string
  thread: number
  re: number | null
  replyTo: number | null
  by: By
  text: string
  labels: Record<string, string>
  reactions: Record<string, string[]>
  attachments: Attachment[]
  /** The typed data in its text, parsed. */
  blocks: { schema: string; data: unknown }[]
  revision: number
  deleted: boolean
  noSync: boolean
  at: string
  editedAt: string | null
}

export type BoardEvent = {
  seq: number
  at: string
  type: string
  by: By
  channel: string | null
  thread: number | null
  data: Record<string, unknown>
}

export const LIMITS = {
  text: 10_000,
  attachments: 10,
  channel: 2048,
  labelKey: 64,
  labelValue: 256,
  labels: 64,
  emoji: 64,
  profile: 64,
  idempotencyKey: 200,
  read: 50,
  readMax: 500,
} as const

const SEGMENT = /^[a-z0-9][a-z0-9_.-]*$/
const LABEL_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const PROFILE = /^[a-z0-9][a-z0-9_.-]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A channel path as the board keeps it: `db/storage`. A leading `#` is how people write one. */
export function channelPath(input: string): string {
  const path = input.startsWith('#') ? input.slice(1) : input
  if (path.length === 0 || path.length > LIMITS.channel || !path.split('/').every((segment) => SEGMENT.test(segment))) {
    throw misuse('invalid_channel', `"${input}" isn't a channel.`, 'A channel is lowercase segments joined by "/": db/storage.')
  }
  return path
}

/** A channel or a subtree: `db/` is every channel under `db`. */
export function channelScope(input: string): { path: string; tree: boolean } {
  const raw = input.startsWith('#') ? input.slice(1) : input
  if (raw.endsWith('/')) return { path: channelPath(raw.slice(0, -1)), tree: true }
  return { path: channelPath(raw), tree: false }
}

export const inScope = (channel: string, scope: { path: string; tree: boolean }) =>
  scope.tree ? channel === scope.path || channel.startsWith(scope.path + '/') : channel === scope.path

export function labelKey(key: string, options: { reserved?: boolean } = {}): string {
  if (!LABEL_KEY.test(key)) {
    throw misuse('invalid_label', `"${key}" isn't a label key.`, 'A key is up to 64 lowercase letters, numbers, ".", "_" and "-".')
  }
  if (!options.reserved && key.startsWith('board.')) {
    throw new Failure('reserved_label', `Only the board writes labels under "board.".`, { hint: 'Use a tasks command to change a task.' })
  }
  return key
}

export function labelValue(key: string, value: string): string {
  if (value.length > LIMITS.labelValue || CONTROL.test(value)) {
    throw misuse('invalid_label', `The value of "${key}" is too long or has control characters.`, 'A value is at most 256 characters on one line.')
  }
  return value
}

export function profileName(name: string): string {
  if (!PROFILE.test(name)) {
    throw misuse('invalid_profile', `"${name}" isn't a profile name.`, 'A profile is lowercase letters, numbers, ".", "_" and "-".')
  }
  return name
}

export function messageText(text: string): string {
  if (text.length === 0) throw misuse('empty_text', 'A message needs text.')
  if (text.length > LIMITS.text) {
    throw new Failure('text_too_long', `A message holds up to ${LIMITS.text.toLocaleString('en-US')} characters; this one has ${text.length.toLocaleString('en-US')}.`, {
      hint: 'Attach the rest as a file.',
    })
  }
  return text
}

/** An actor's ID: the principal, or the principal and one of its profiles. */
export const actorId = (by: By) => (by.profile ? `${by.principal}+${by.profile}` : by.principal)

/** What people type to mention an actor: its profile, or the last part of its principal. */
export const handleOf = (by: By) => by.profile ?? by.principal.slice(by.principal.lastIndexOf(':') + 1)

/** A `k=v` filter whose value may list alternatives with `|`. */
export type LabelFilter = { key: string; values: string[] | null }

export function labelFilter(input: string): LabelFilter {
  const at = input.indexOf('=')
  if (at === -1) return { key: labelKey(input, { reserved: true }), values: null }
  return { key: labelKey(input.slice(0, at), { reserved: true }), values: input.slice(at + 1).split('|') }
}

export const matchesLabels = (labels: Record<string, string>, filters: readonly LabelFilter[]) =>
  filters.every((filter) => {
    const value = labels[filter.key]
    return value !== undefined && (filter.values === null || filter.values.includes(value))
  })
