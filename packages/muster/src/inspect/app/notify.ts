import type { FeedEvent } from '../../core/reads.ts'

/**
 * Browser notifications for the page's owner: a new message that mentions them. Which messages those are
 * is the board's own rule, the one `mu inbox` follows: the page reads its new events again `for` the
 * owner, and the board marks each mention, leaving out their own writes and anything since deleted.
 */

/** Whether this browser shows notifications, and what the person answered when asked. */
export type Permission = NotificationPermission | 'unsupported'

export function permission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** A stored mention as people typed it: `@[local:user:ada+claude]` reads `@claude`. */
export const readable = (text: string) => text.replace(/@\[([^\]\s]+)\]/g, (_whole, id: string) => `@${id.slice(Math.max(id.lastIndexOf('+'), id.lastIndexOf(':')) + 1)}`)

export type Notice = { title: string; body: string; tag: string; href: string }

const BODY = 160

/**
 * What to show for a page of events read `for` the owner: each mention, but none of what this tab wrote.
 * The page can write as a profile, and the board only knows the owner wrote it under their own name.
 */
export function notices(events: FeedEvent[], wrote: ReadonlySet<number>): Notice[] {
  const out: Notice[] = []
  for (const event of events) {
    if (event.for !== 'mention' || event.type !== 'message.posted' || wrote.has(event.seq) || event.channel === null) continue
    const data = event.data as { text?: unknown }
    const text = readable(event.message?.text ?? (typeof data.text === 'string' ? data.text : ''))
    const by = event.by.profile ?? event.by.principal.slice(event.by.principal.lastIndexOf(':') + 1)
    const thread = event.thread ?? event.seq
    out.push({
      title: `${by} mentioned you in #${event.channel}`,
      body: text.length > BODY ? `${text.slice(0, BODY - 1)}…` : text,
      // One notice per message, however many tabs of this page are open.
      tag: `muster-${event.seq}`,
      href: `/c/${encodeURIComponent(event.channel)}?thread=${thread}`,
    })
  }
  return out
}

/**
 * Shows each notice. A click brings this tab forward and opens the thread. A browser that refuses to
 * make one here (Chrome on Android shows them only from a service worker) throws: that notice is
 * skipped, and the rest are still shown.
 */
export function show(list: Notice[], open: (href: string) => void, make: (title: string, options: NotificationOptions) => Notification = (title, options) => new Notification(title, options)): number {
  let shown = 0
  for (const notice of list) {
    try {
      const note = make(notice.title, { body: notice.body, tag: notice.tag })
      note.onclick = () => {
        globalThis.focus?.()
        open(notice.href)
        note.close()
      }
      shown++
    } catch {
      // Not shown here; the page still has it.
    }
  }
  return shown
}
