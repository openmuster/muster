import type { Message } from '../model.ts'

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
  /** Who wrote it there. */
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
  /** Whether the app itself wrote it: its own echoes are never imported. */
  self?: boolean
  /**
   * The platform thread itself, when the event is about one the board may never have seen (a comment on
   * an issue opened before sync, or while the board was down). The board starts the thread from it first.
   */
  parent?: { author: string; text: string; labels: Record<string, string> }
}

/**
 * What a platform made of a board message. A new thread also says what an imported one would carry as
 * labels (which issue it became, its kind, its state), so a thread started on the board reads like one
 * that came in.
 */
export type Delivery = { external: string; thread?: string; labels?: Record<string, string> }

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
  deliver(message: Message, target: { place: string; threadExternal: string | null }, fetcher: typeof fetch): Promise<Delivery>
}

/** What a provider may also do. Each is optional: a platform that can't simply doesn't. */
export type ProviderExtras = {
  /** Changes a message the board delivered earlier. Best effort: a failure is skipped. */
  update?(external: string, text: string, place: string, fetcher: typeof fetch): Promise<void>
  /** Removes a message the board delivered earlier. Best effort. */
  remove?(external: string, place: string, fetcher: typeof fetch): Promise<void>
  /** What happened on the platform since a time, for when webhooks were missed while the board was down. */
  catchUp?(since: string, fetcher: typeof fetch): Promise<Inbound[]>
  /** Runs on text as it comes in: returns what to keep, or null to drop the event. From the operator's config. */
  filter?(text: string): string | null
}

export const DELIVERY_ATTEMPTS = 5

/** How long a platform has to answer. A delivery out holds that platform's imports, so it can't hang. */
export const SEND_MS = 30_000

export const IMPORT_ATTEMPTS = 10
