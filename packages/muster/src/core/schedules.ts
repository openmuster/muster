import { Failure, misuse } from '../failure.ts'
import { channelPath, messageText, type By, type Caller } from '../model.ts'
import { append } from '../store/log.ts'
import { allowed, authorize, byOf, findMessage, messageFor, type Context } from './context.ts'

export type Schedule = {
  id: number
  by: By
  channel: string
  thread: number | null
  text: string
  every: number | null
  times: number | null
  until: string | null
  fired: number
  next: string | null
  canceled: boolean
}

export const EVERY_MIN_S = 60
/** How late a slot may be and still be sent: half the period, between two minutes and two hours. */
export const graceMs = (everyS: number | null) => Math.min(Math.max((everyS ?? 240) * 500, 120_000), 7_200_000)
/** At most this many schedules catch up in one tick after downtime; the rest wait for the next. */
export const CATCH_UP_MAX = 5

type Row = { id: number; principal: string; profile: string | null; channel: string; thread: number | null; text: string; every_s: number | null; times: number | null; until: string | null; fired: number; next_at: string | null; canceled: number }

const toSchedule = (row: Row): Schedule => ({
  id: row.id,
  by: { principal: row.principal, profile: row.profile },
  channel: row.channel,
  thread: row.thread,
  text: row.text,
  every: row.every_s,
  times: row.times,
  until: row.until,
  fired: row.fired,
  next: row.next_at,
  canceled: row.canceled === 1,
})

export type ScheduleRequest = {
  /** A channel to post in, or a thread to reply in. */
  channel?: string
  thread?: number
  text: string
  /** When the first one goes out. Default: one period from now, or now for a one-off. */
  at?: string
  /** Seconds between sends. */
  every?: number
  times?: number
  until?: string
}

export function create(ctx: Context, caller: Caller, request: ScheduleRequest): Schedule {
  const text = messageText(request.text)
  if (request.every !== undefined && (!Number.isFinite(request.every) || request.every < EVERY_MIN_S)) throw misuse('invalid_schedule', `--every is at least ${EVERY_MIN_S} seconds.`)
  if (request.times !== undefined && (!Number.isInteger(request.times) || request.times < 1)) throw misuse('invalid_schedule', '--times is a whole number of at least 1.')
  for (const instant of [request.at, request.until]) if (instant !== undefined && Number.isNaN(Date.parse(instant))) throw misuse('invalid_schedule', `"${instant}" isn't a time.`)
  const now = ctx.now()
  const first = request.at !== undefined ? new Date(request.at) : new Date(now.getTime() + (request.every ?? 0) * 1000)
  return ctx.db.write(() => {
    let channel: string
    let thread: number | null = null
    if (request.thread !== undefined) {
      const target = messageFor(ctx, caller, request.thread)
      channel = target.channel
      thread = target.thread
    } else if (request.channel !== undefined) channel = channelPath(request.channel)
    else throw misuse('invalid_schedule', 'Name a channel or a thread.')
    authorize(caller, channel, 'post')
    const event = append(
      ctx.db,
      { type: 'schedule.created', by: byOf(caller), channel, thread, data: { thread, text, first: first.toISOString(), every: request.every ?? null, times: request.every === undefined ? 1 : (request.times ?? null), until: request.until ?? null } },
      now.toISOString(),
    )
    return find(ctx, event.seq)!
  })
}

/** Whether `caller` made the schedule: the same principal, and as a profile only that profile's own. */
const mine = (caller: Caller, schedule: Schedule) => caller.principal === schedule.by.principal && (caller.profile === null || caller.profile === schedule.by.profile)

const find = (ctx: Context, id: number) => {
  const row = ctx.db.raw.prepare('select * from schedules where id = ?').get(id) as Row | undefined
  return row ? toSchedule(row) : null
}

export function list(ctx: Context, caller: Caller): { schedules: Schedule[] } {
  const rows = ctx.db.raw.prepare('select * from schedules where canceled = 0 and next_at is not null order by id').all() as Row[]
  return { schedules: rows.map(toSchedule).filter((schedule) => allowed(caller, schedule.channel, 'read') && (mine(caller, schedule) || caller.can === undefined || allowed(caller, schedule.channel, 'manage'))) }
}

export function cancel(ctx: Context, caller: Caller, request: { id: number }): Schedule {
  return ctx.db.write(() => {
    const schedule = find(ctx, request.id)
    if (!schedule) throw new Failure('not_found', `No schedule ${request.id}.`)
    // One a caller can't see doesn't exist for it; one it can see is its own to cancel, or its channel's manager's.
    if (!allowed(caller, schedule.channel, 'read')) throw new Failure('not_found', `No schedule ${request.id}.`)
    if (!mine(caller, schedule) && !(caller.can !== undefined && allowed(caller, schedule.channel, 'manage'))) throw new Failure('not_yours', `Schedule ${request.id} isn't yours to cancel.`)
    if (!schedule.canceled) append(ctx.db, { type: 'schedule.canceled', by: byOf(caller), channel: schedule.channel, thread: schedule.thread, data: { id: schedule.id } }, ctx.now().toISOString())
    return find(ctx, request.id)!
  })
}

/**
 * Sends what is due. Each send is one transaction that also records its slot, so a slot is sent once
 * however many processes tick, and a crash between two sends loses neither. After downtime a schedule
 * sends one message for all the slots it missed, if the latest of them is within its grace.
 */
export function tick(ctx: Context): { sent: number[]; skipped: number[] } {
  const now = ctx.now().getTime()
  const due = (ctx.db.raw.prepare('select id from schedules where canceled = 0 and next_at is not null and next_at <= ? order by next_at').all(new Date(now).toISOString()) as { id: number }[]).slice(0, CATCH_UP_MAX)
  const sent: number[] = []
  const skipped: number[] = []
  for (const { id } of due) {
    ctx.db.write(() => {
      const row = ctx.db.raw.prepare('select * from schedules where id = ?').get(id) as Row
      if (row.canceled === 1 || row.next_at === null || Date.parse(row.next_at) > now) return
      const by: By = { principal: row.principal, profile: row.profile }
      // The slot to send is the latest one due: the ones before it were missed, and one message stands for them.
      let slot = Date.parse(row.next_at)
      if (row.every_s !== null) slot += Math.floor((now - slot) / (row.every_s * 1000)) * row.every_s * 1000
      const fired = row.fired + 1
      const following = row.every_s === null ? null : slot + row.every_s * 1000
      const over = following === null || (row.times !== null && fired >= row.times) || (row.until !== null && following > Date.parse(row.until))
      const next = over ? null : new Date(following!).toISOString()
      const at = new Date(now).toISOString()
      const root = row.thread === null ? null : findMessage(ctx.db, row.thread)
      if (now - slot > graceMs(row.every_s) || (row.thread !== null && (!root || root.deleted))) {
        append(ctx.db, { type: 'schedule.skipped', by: { principal: 'board', profile: null }, channel: row.channel, thread: row.thread, data: { id, slot: new Date(slot).toISOString(), next } }, at)
        skipped.push(id)
        return
      }
      if (ctx.db.raw.prepare('select 1 from slots where schedule = ? and slot = ?').get(id, new Date(slot).toISOString())) return
      append(
        ctx.db,
        {
          type: 'message.posted',
          by,
          channel: row.channel,
          thread: row.thread ?? 'self',
          data: { re: row.thread, replyTo: null, text: row.text, labels: {}, attachments: [], noSync: false, mentions: [], schedule: { id, n: fired, slot: new Date(slot).toISOString(), next } },
        },
        at,
      )
      sent.push(id)
    })
  }
  return { sent, skipped }
}
