import { Failure, misuse } from '../failure.ts'
import { actorId, channelPath, labelKey, labelValue, LIMITS, messageText, type Attachment, type Caller, type Message } from '../model.ts'
import { checkBlocks } from './blocks.ts'
import { fileKnown } from './files.ts'
import { authorize, allowed, byOf, findMessage, messageFor, once, type Context } from './context.ts'

export type PostRequest = {
  channel: string
  text: string
  labels?: Record<string, string>
  attachments?: Attachment[]
  noSync?: boolean
  idempotencyKey?: string
}

export type ReplyRequest = {
  to: number
  text: string
  /** Post only if nothing landed in the thread after this message. */
  after?: number
  labels?: Record<string, string>
  attachments?: Attachment[]
  noSync?: boolean
  idempotencyKey?: string
}

const MENTION = /(^|[\s(])@([a-z0-9][a-z0-9_.-]*)/g
const SETTLED = /@\[([^\]\s]+)\]/g

/** Stores each `@handle` that names exactly one known actor as `@[actor-id]`, and says who was mentioned. */
export function settleMentions(ctx: Context, text: string): { text: string; mentions: string[] } {
  const mentions = new Set<string>()
  const settled = text.replace(MENTION, (whole, lead: string, handle: string) => {
    const rows = ctx.db.raw.prepare('select principal, profile from actors where handle = ?').all(handle) as { principal: string; profile: string }[]
    if (rows.length !== 1) return whole
    const id = actorId({ principal: rows[0]!.principal, profile: rows[0]!.profile || null })
    mentions.add(id)
    return `${lead}@[${id}]`
  })
  for (const match of settled.matchAll(SETTLED)) mentions.add(match[1]!)
  return { text: settled, mentions: [...mentions] }
}

function cleanLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels ?? {})) out[labelKey(key)] = labelValue(key, String(value))
  if (Object.keys(out).length > LIMITS.labels) throw misuse('too_many_labels', `A message carries at most ${LIMITS.labels} labels.`)
  return out
}

function knownFiles(ctx: Context, attachments: Attachment[]) {
  for (const file of attachments) if (!fileKnown(ctx, file.id)) throw new Failure('unknown_file', `The board has no file ${file.name}.`, { hint: 'Attach it with --attach, which stores it first.' })
}

function cleanAttachments(attachments: Attachment[] | undefined): Attachment[] {
  const list = attachments ?? []
  if (list.length > LIMITS.attachments) {
    throw new Failure('too_many_attachments', `A message carries at most ${LIMITS.attachments} files.`, { hint: 'Attach the rest in another reply.' })
  }
  return list.map(({ id, name, type, size }) => {
    const file = { id: String(id), name: String(name), type: String(type), size: Number(size) }
    // The same room `filePut` gives a name: a record is stored with the message, so it is held to a size too.
    if (file.name.length > 255 || file.type.length > 255) throw misuse('invalid_file', "A file's name and type are at most 255 characters each.")
    return file
  })
}

export function post(ctx: Context, caller: Caller, request: PostRequest): Message {
  const channel = channelPath(request.channel)
  authorize(caller, channel, 'post')
  const text = messageText(request.text)
  const labels = cleanLabels(request.labels)
  const attachments = cleanAttachments(request.attachments)
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'post', channel, text: request.text, labels, attachments, noSync: request.noSync === true },
    (emit) => {
      checkBlocks(ctx, text)
      knownFiles(ctx, attachments)
      const settled = settleMentions(ctx, text)
      const event = emit({
        type: 'message.posted',
        by: byOf(caller),
        channel,
        thread: 'self',
        data: { re: null, replyTo: null, text: settled.text, labels, attachments, noSync: request.noSync === true || caller.noSync === true, mentions: settled.mentions },
      })
      return { answer: findMessage(ctx.db, event.seq)!, ref: event.seq }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

export function reply(ctx: Context, caller: Caller, request: ReplyRequest): Message {
  const text = messageText(request.text)
  const labels = cleanLabels(request.labels)
  const attachments = cleanAttachments(request.attachments)
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'reply', to: request.to, text: request.text, labels, attachments, after: request.after ?? null, noSync: request.noSync === true },
    (emit) => {
      const target = messageFor(ctx, caller, request.to)
      authorize(caller, target.channel, 'post')
      const root = target.re === null ? target : findMessage(ctx.db, target.thread)!
      if (root.deleted) throw new Failure('not_found', `No message ${request.to}.`)
      if (request.after !== undefined) {
        const newest = (ctx.db.raw.prepare('select max(id) as id from messages where thread = ?').get(root.id) as { id: number }).id
        if (newest > request.after) {
          throw new Failure('newer_message', `Something landed in the thread after ${request.after}.`, {
            next: [`mu read ${root.id} --after ${request.after}`],
            data: { newest },
          })
        }
      }
      checkBlocks(ctx, text)
      knownFiles(ctx, attachments)
      const settled = settleMentions(ctx, text)
      const event = emit({
        type: 'message.posted',
        by: byOf(caller),
        channel: root.channel,
        thread: root.id,
        data: {
          re: root.id,
          replyTo: target.id === root.id ? null : target.id,
          text: settled.text,
          labels,
          attachments,
          noSync: request.noSync === true || root.noSync || caller.noSync === true,
          mentions: settled.mentions,
        },
      })
      return { answer: findMessage(ctx.db, event.seq)!, ref: event.seq }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

/** Whether `caller` wrote `message`: the same principal, and as a profile only that profile's own. */
export function wrote(caller: Caller, message: Message): boolean {
  if (caller.principal !== message.by.principal) return false
  return caller.profile === null || caller.profile === message.by.profile
}

function mayChange(caller: Caller, message: Message) {
  if (wrote(caller, message)) return
  if (caller.can && allowed(caller, message.channel, 'manage')) return
  if (!caller.can && caller.profile === null) return
  throw new Failure('not_yours', `Message ${message.id} isn't yours to change.`, { hint: 'Reply to it instead.' })
}

function checkRevision(message: Message, ifRevision: number | undefined) {
  if (ifRevision !== undefined && message.revision !== ifRevision) {
    throw new Failure('revision_conflict', `Message ${message.id} is at revision ${message.revision}, not ${ifRevision}.`, {
      next: [`mu read ${message.thread}`],
      data: { revision: message.revision },
    })
  }
}

export type EditHook = (ctx: Context, caller: Caller, message: Message, emit: Parameters<Parameters<typeof once>[4]>[0]) => void

/** What else a write does once it lands: a task's own rules, set by `tasks.ts` so messages don't import them. */
export const hooks: { edited?: EditHook; deleted?: EditHook } = {}

export function edit(ctx: Context, caller: Caller, request: { id: number; text: string; ifRevision?: number; idempotencyKey?: string }): Message {
  const text = messageText(request.text)
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'edit', id: request.id, text: request.text, ifRevision: request.ifRevision ?? null },
    (emit) => {
      const message = messageFor(ctx, caller, request.id)
      if (message.deleted) throw new Failure('not_found', `No message ${request.id}.`)
      authorize(caller, message.channel, 'post')
      const owns = wrote(caller, message)
      // A task's root may be edited by anyone who may post: the board then holds the task for its owner.
      if (!owns && !(message.re === null && message.labels['board.task'] !== undefined)) mayChange(caller, message)
      checkRevision(message, request.ifRevision)
      checkBlocks(ctx, text)
      const settled = settleMentions(ctx, text)
      emit({
        type: 'message.edited',
        by: byOf(caller),
        channel: message.channel,
        thread: message.thread,
        data: { id: message.id, text: settled.text, revision: message.revision + 1, mentions: settled.mentions, ...(caller.noSync ? { noSync: true } : {}) },
      })
      hooks.edited?.(ctx, caller, message, emit)
      return { answer: findMessage(ctx.db, message.id)!, ref: message.id }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

export function remove(ctx: Context, caller: Caller, request: { id: number; ifRevision?: number; idempotencyKey?: string }): Message {
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'delete', id: request.id, ifRevision: request.ifRevision ?? null },
    (emit) => {
      const message = messageFor(ctx, caller, request.id)
      // Deleting is a write: a token that may only read a channel deletes nothing in it, not even its own profile's words.
      authorize(caller, message.channel, 'post')
      if (message.deleted) return { answer: message, ref: message.id }
      mayChange(caller, message)
      checkRevision(message, request.ifRevision)
      emit({ type: 'message.deleted', by: byOf(caller), channel: message.channel, thread: message.thread, data: { id: message.id, ...(caller.noSync ? { noSync: true } : {}) } })
      hooks.deleted?.(ctx, caller, message, emit)
      return { answer: findMessage(ctx.db, message.id)!, ref: message.id }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

export type LabelRequest = {
  id: number
  set?: Record<string, string>
  unset?: string[]
  /** Change only if these labels have these values now. */
  if?: Record<string, string>
  /** Change only if these keys are unset now. */
  ifUnset?: string[]
  idempotencyKey?: string
}

export function label(ctx: Context, caller: Caller, request: LabelRequest): Message {
  const set = cleanLabels(request.set)
  if ((request.unset ?? []).length > LIMITS.labels) throw misuse('too_many_labels', `One change unsets at most ${LIMITS.labels} labels.`)
  const unset = (request.unset ?? []).map((key) => labelKey(key))
  if (Object.keys(set).length === 0 && unset.length === 0) throw misuse('nothing_to_label', 'Name a label to set or unset.')
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'label', id: request.id, set, unset, if: request.if ?? null, ifUnset: request.ifUnset ?? null },
    (emit) => {
      const message = messageFor(ctx, caller, request.id)
      if (message.deleted) throw new Failure('not_found', `No message ${request.id}.`)
      authorize(caller, message.channel, 'label')
      for (const [key, value] of Object.entries(request.if ?? {})) {
        if (message.labels[key] !== value) {
          throw new Failure('label_conflict', `"${key}" is ${message.labels[key] === undefined ? 'unset' : `"${message.labels[key]}"`}, not "${value}".`, {
            data: { labels: message.labels },
          })
        }
      }
      for (const key of request.ifUnset ?? []) {
        if (message.labels[key] !== undefined) {
          throw new Failure('label_conflict', `"${key}" is already "${message.labels[key]}".`, { data: { labels: message.labels } })
        }
      }
      const after = { ...message.labels }
      for (const key of unset) delete after[key]
      Object.assign(after, set)
      if (Object.keys(after).length > LIMITS.labels) throw misuse('too_many_labels', `A message carries at most ${LIMITS.labels} labels.`)
      emit({
        type: 'labels.changed',
        by: byOf(caller),
        channel: message.channel,
        thread: message.thread,
        data: { id: message.id, set, unset, before: message.labels },
      })
      return { answer: findMessage(ctx.db, message.id)!, ref: message.id }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

export function react(ctx: Context, caller: Caller, request: { id: number; emoji: string; remove?: boolean; idempotencyKey?: string }): Message {
  const emoji = request.emoji.replace(/^:|:$/g, '')
  if (emoji.length === 0 || emoji.length > LIMITS.emoji || /\s/.test(emoji)) throw misuse('invalid_emoji', `"${request.emoji}" isn't an emoji name.`)
  return once(
    ctx,
    caller,
    request.idempotencyKey,
    { op: 'react', id: request.id, emoji, remove: request.remove === true },
    (emit) => {
      const message = messageFor(ctx, caller, request.id)
      if (message.deleted) throw new Failure('not_found', `No message ${request.id}.`)
      authorize(caller, message.channel, 'react')
      const has = (message.reactions[emoji] ?? []).includes(actorId(byOf(caller)))
      if (has !== (request.remove === true)) return { answer: message, ref: message.id }
      emit({
        type: request.remove ? 'reaction.removed' : 'reaction.added',
        by: byOf(caller),
        channel: message.channel,
        thread: message.thread,
        data: { id: message.id, emoji },
      })
      return { answer: findMessage(ctx.db, message.id)!, ref: message.id }
    },
    (id: number) => findMessage(ctx.db, id)!,
  )
}

export function createChannel(ctx: Context, caller: Caller, request: { path: string; private?: boolean }): { path: string; created: boolean } {
  const path = channelPath(request.path)
  authorize(caller, path, 'post')
  return once(
    ctx,
    caller,
    undefined,
    null,
    (emit) => {
      const exists = ctx.db.raw.prepare('select 1 from channels where path = ?').get(path) !== undefined
      if (!exists) emit({ type: 'channel.created', by: byOf(caller), channel: path, data: { path, private: request.private === true } })
      return { answer: { path, created: !exists }, ref: null }
    },
    () => ({ path, created: false }),
  )
}
