import type { Context } from '../core/context.ts'
import { PROGRESS } from '../model.ts'
import type { Sync } from './engine.ts'
import { SEND_MS, type WorkingStep } from './types.ts'

/** Calls to one platform a tick makes at most, so a burst of runs never holds up the next tick's deliveries. */
const CALLS_PER_TICK = 20
/** How long a call that failed waits before it is tried again: a platform that refuses isn't asked every second. */
const RETRY_MS = 60_000
/** A progress message nobody has changed for this long no longer counts: a run that died never shows as working for good. */
const LONGEST_MS = 24 * 60 * 60_000
/** A claim older than this is from a process that died mid-call. */
const CLAIM_STALE_MS = 2 * SEND_MS

type Row = { thread: number; message: number; active: number; text: string; state: string | null; refreshed: number; claim: number | null; retry_at: number }

/**
 * Shows on each platform that can show it which synced threads are being worked on. A thread is, while a
 * message on it is labelled `progress=open`: any of them, so a run handing over to the next on the same
 * thread never turns it off in between. What was last told to each platform is kept beside the log, with
 * what the platform gave back to find it again, so a process that starts again goes on from there; when to
 * tell it again (`workingTtl`) and when to try a failed call again are stored times, looked at each tick.
 * Runs after deliveries, so a run's summary is on the platform before it stops showing as working.
 */
export async function workingPending(ctx: Context, sync: Sync, fetcher: typeof fetch = fetch): Promise<{ called: number; failed: number }> {
  let called = 0
  let failed = 0
  for (const [key, provider] of Object.entries(sync)) {
    if (!provider.working) continue
    const now = ctx.now().getTime()
    const open = ctx.db.raw
      .prepare("select id, thread, text from messages where json_extract(labels, '$.progress') = 'open' and deleted = 0 and no_sync = 0 and coalesce(edited_at, at) > ? order by id")
      .all(new Date(now - LONGEST_MS).toISOString()) as { id: number; thread: number; text: string }[]
    // The newest of a thread's open messages says what it is doing now.
    const wanted = new Map(open.map((message) => [message.thread, message]))
    const rows = new Map((ctx.db.raw.prepare('select thread, message, active, text, state, refreshed, claim, retry_at from sync_working where key = ?').all(key) as Row[]).map((row) => [row.thread, row]))
    const steps: { thread: number; step: WorkingStep; message: number; text: string }[] = []
    for (const [thread, message] of wanted) {
      const row = rows.get(thread)
      const step = !row || !row.active ? 'start' : row.text !== message.text ? 'text' : provider.workingTtl !== undefined && now - row.refreshed >= provider.workingTtl ? 'refresh' : null
      if (step) steps.push({ thread, step, message: message.id, text: message.text })
    }
    for (const [thread, row] of rows) {
      if (!row.active || wanted.has(thread)) continue
      // What the message says now, its last words on the run.
      const last = ctx.db.raw.prepare('select text from messages where id = ? and deleted = 0').get(row.message) as { text: string } | undefined
      steps.push({ thread, step: 'end', message: row.message, text: last?.text ?? row.text })
    }
    let calls = 0
    for (const { thread, step, message, text } of steps) {
      if (calls >= CALLS_PER_TICK) break
      const row = rows.get(thread)
      if (row && row.retry_at > now) continue
      const link = ctx.db.raw.prepare('select l.external, l.thread_external, l.place, m.no_sync from links l join messages m on m.id = l.message where l.message = ? and l.key = ?').get(thread, key) as
        | { external: string; thread_external: string | null; place: string | null; no_sync: number }
        | undefined
      // Not a thread this platform has, or one whose replies stay on the board: nothing is shown there.
      if (!link || !link.place || link.no_sync || !provider.mirrors(link.place)) {
        if (row?.active) ctx.db.write(() => ctx.db.raw.prepare('update sync_working set active = 0 where key = ? and thread = ?').run(key, thread))
        continue
      }
      // Claimed before the call, in one write: another process on this board that got here first is making it.
      const mine = ctx.db.write(() => {
        const held = ctx.db.raw.prepare('select claim from sync_working where key = ? and thread = ?').get(key, thread) as { claim: number | null } | undefined
        if (held?.claim && held.claim > now - CLAIM_STALE_MS) return false
        ctx.db.raw
          .prepare('insert into sync_working (key, thread, message, active, text, state, refreshed, claim, retry_at) values (?, ?, ?, 0, ?, null, 0, ?, 0) on conflict (key, thread) do update set claim = excluded.claim')
          .run(key, thread, message, '', now)
        return true
      })
      if (!mine) continue
      calls++
      try {
        const state = await provider.working({ place: link.place, threadExternal: link.thread_external ?? link.external }, step, { text, state: row?.state ? JSON.parse(row.state) : null }, fetcher)
        ctx.db.write(() =>
          ctx.db.raw
            .prepare('update sync_working set message = ?, active = ?, text = ?, state = ?, refreshed = ?, claim = null, retry_at = 0 where key = ? and thread = ?')
            .run(message, step === 'end' ? 0 : 1, text, state === undefined || state === null ? null : JSON.stringify(state), now, key, thread),
        )
        called++
      } catch {
        // Best effort, like an edit: the board's own thread says where the run is. Tried again in a while.
        ctx.db.write(() => ctx.db.raw.prepare('update sync_working set claim = null, retry_at = ? where key = ? and thread = ?').run(now + RETRY_MS, key, thread))
        failed++
      }
    }
  }
  return { called, failed }
}
