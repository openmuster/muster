import { Failure } from '../failure.ts'
import type { Attachment, Message } from '../model.ts'

/** What a platform sent, as the parts a provider needs to check and read it. */
export type Received = { headers: Record<string, string | undefined>; body: string }

/** One thing that happened on a platform, in board terms. */
export type Inbound = {
  /** The platform's own ID for this event: importing it twice does nothing. */
  id: string
  /** The platform thing the board thread mirrors: an issue, a Slack thread. */
  thread: string
  /** This message's own ID on the platform. */
  external: string
  /** Who wrote it there. Empty when the platform doesn't say: the change is then put down to the sync itself. */
  author: string
  /** Where on the platform it happened: a repo, a team, a channel. Mapped to a board channel by config. */
  place: string
  kind: 'root' | 'reply' | 'labels' | 'edit' | 'delete'
  text?: string
  labels?: Record<string, string>
  /** Label keys to take off the thread: a property the platform thread no longer has, such as its priority. */
  unset?: string[]
  /**
   * Key prefixes under which the thread says what the platform says (`tag.`, `assignee.`): a key under one
   * that `labels` doesn't carry is taken off. An event names a prefix only when it carries the whole set.
   */
  owns?: string[]
  /**
   * When the platform says it changed, for a `labels` event read on catching up: a label the board has changed
   * since then is newer than it, and is left as it is.
   */
  at?: string
  /**
   * When the platform says the thing this event is about (an issue, a comment) last changed, as its own clock has
   * it: Linear's `updatedAt`. An update or an edit no newer than the newest one applied to the same thing is late
   * (a retry, or one held up) and is skipped. Without it, an event is applied in the order it arrived.
   */
  updated?: string
  /**
   * A platform whose webhooks say only what changed, not what it now says (Notion's), marks the event `unread`:
   * its provider's `read` fills it in on the ticker, before it is imported, while the webhook was answered at once.
   */
  unread?: true
  /** Whether the app itself wrote it: its own echoes are never imported. */
  self?: boolean
  /**
   * The platform thread itself, when the event is about one the board may never have seen (a comment on
   * an issue opened before sync, or while the board was down). The board starts the thread from it first. An
   * empty `author` is a platform that doesn't say who opened it: the thread is put down to the sync itself.
   */
  parent?: { author: string; text: string; labels: Record<string, string> }
  /** Files the message carries on the platform, still to be fetched. Never holds a credential. */
  files?: Remote[]
  /** What fetching them gave: files on the board, and a line for each one that was not taken. */
  fetched?: { attachments: Attachment[]; notes: string[]; tries: number; withheld?: number }
}

/** How many bytes a file may have, and what to say when it has more. */
export type Limit = { max: number; over: string }

/** A file on the platform, as an event names it. `id` is the platform's own, when it has one. */
export type Remote = { url: string; name: string; id?: string; type?: string; size?: number; skip?: string }

/**
 * What a platform made of a board message. A new thread also says what an imported one would carry as
 * labels (which issue it became, its kind, its state), so a thread started on the board reads like one
 * that came in.
 */
export type Delivery = { external: string; thread?: string; labels?: Record<string, string>; files?: string[] }

/** A board file's bytes, for a provider sending it out: null when the board no longer has it. */
export type ReadFile = (id: string) => Buffer | null

/** A platform: how to check that a webhook is its own, read it, and send a message back. */
export type Provider = ProviderExtras & {
  type: string
  /** Throws unless the request carries the platform's signature for this body. */
  verify(received: Received): void
  /** A webhook that is the platform checking the URL, answered at once. */
  challenge?(received: Received): string | null
  parse(received: Received): Inbound[]
  /** The board channel a place maps to, or null when it isn't synced. */
  channelFor(place: string, kind: string): string | null
  /** The platform place a board channel mirrors to, for a thread started on the board, or null. */
  placeFor(channel: string): string | null
  /** Whether board replies in a synced thread go back to the platform. */
  mirrors(place: string): boolean
  /** Posts a board message on the platform. `threadExternal` is null for a new root. */
  deliver(message: Message, target: { place: string; threadExternal: string | null }, fetcher: typeof fetch, read: ReadFile): Promise<Delivery>
}

/** What a provider may also do. Each is optional: a platform that can't simply doesn't. */
export type ProviderExtras = {
  /** Changes a message the board delivered earlier. Best effort: a failure is skipped. */
  update?(external: string, text: string, place: string, fetcher: typeof fetch): Promise<void>
  /** Removes a message the board delivered earlier. Best effort. */
  remove?(external: string, place: string, fetcher: typeof fetch): Promise<void>
  /**
   * What happened on the platform since a time, for when webhooks were missed while the board was down. A read
   * cut short also says where the next one starts (`resume`), so what it didn't reach is read then, not skipped.
   * `resume` must be later than `since`. If getting there meant going past changes it couldn't read, `skipped`
   * says when they were made.
   */
  catchUp?(since: string, fetcher: typeof fetch): Promise<Inbound[] | { events: Inbound[]; resume: string; skipped?: string }>
  /** Bytes of files this sync may bring in a day, from the operator's config. */
  filesPerDay?: number
  /** Fetches a file an event named, from the platform's own file host only. Throws a Failure: `file_refused` is final. */
  download?(file: Remote, fetcher: typeof fetch, limit: Limit): Promise<{ bytes: Buffer; type?: string }>
  /**
   * Reads what an `unread` event is about from the platform: the events to import in its place, none to drop it.
   * Runs on the ticker; a throw is tried again on a later tick, a few times.
   */
  read?(event: Inbound, fetcher: typeof fetch): Promise<Inbound[]>
  /** Runs on text as it comes in: returns what to keep, or null to drop the event. From the operator's config. */
  filter?(text: string): string | null
  /**
   * Shows on the platform that a synced thread is being worked on, where the platform has a way to show it
   * that isn't a message. Called when the work starts, when what it says changed (`text`), every `workingTtl`
   * while it goes on (`refresh`), and when it ends. `now.text` is the progress message as it reads; `now.state`
   * is whatever the last call for this thread returned (null on the first), kept for it across restarts: what
   * the platform gave to find the same indicator again. A provider with this gets no comment for a progress
   * message: the indicator is how the platform shows it. Best effort: a throw is tried again in a while.
   */
  working?(target: { place: string; threadExternal: string }, step: WorkingStep, now: { text: string; state: unknown }, fetcher: typeof fetch): Promise<unknown>
  /** How long the platform keeps showing it without being told again, in milliseconds. None: until it is told to stop. */
  workingTtl?: number
}

/** Why `working` is called: see there. */
export type WorkingStep = 'start' | 'text' | 'refresh' | 'end'

export const DELIVERY_ATTEMPTS = 5

/** How long a platform has to answer. A delivery out holds that platform's imports, so it can't hang. */
export const SEND_MS = 30_000

export const IMPORT_ATTEMPTS = 10

/**
 * How long a platform may be down before what waits on it is given up: an outage uses none of an event's tries
 * (`IMPORT_ATTEMPTS`, `DELIVERY_ATTEMPTS`), since it says nothing about the event, so this is what ends a wait.
 */
export const OUTAGE_MS = 24 * 3_600_000

/** The longest a platform that keeps failing as if down is left alone between tries. */
export const OUTAGE_PAUSE_MS = 300_000

const SLACK_DOWN = new Set(['slack_ratelimited', 'slack_internal_error', 'slack_fatal_error', 'slack_service_unavailable', 'slack_request_timeout'])

/**
 * Whether an error says the platform is down or busy, rather than anything about what was asked of it: a 5xx, a
 * 429, Slack's own words for those, no answer at all, or none in time.
 */
export function isOutage(error: unknown): boolean {
  if (error instanceof Failure) {
    const status = /^platform_(\d+)$/.exec(error.reason)
    if (status) return Number(status[1]) === 429 || Number(status[1]) >= 500
    return SLACK_DOWN.has(error.reason)
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true
  return error instanceof TypeError && error.message === 'fetch failed'
}
