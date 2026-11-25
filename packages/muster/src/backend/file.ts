import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '../core/context.ts'
import { messageFor } from '../core/context.ts'
import * as blocks from '../core/blocks.ts'
import * as deliveries from '../core/deliveries.ts'
import * as files from '../core/files.ts'
import * as leases from '../core/leases.ts'
import * as messages from '../core/messages.ts'
import * as reads from '../core/reads.ts'
import * as schedules from '../core/schedules.ts'
import * as tasks from '../core/tasks.ts'
import * as workflows from '../core/workflows.ts'
import { Failure, misuse } from '../failure.ts'
import { profileName, type Caller } from '../model.ts'
import { sameProcess } from '../process.ts'
import { ensureSchema } from '../store/schema.ts'
import { openDb, ownerOnly, type Db } from '../store/sqlite.ts'
import { catchUp, deliverPending, holdCatchUp, importPending, receive, type Sync } from '../sync/engine.ts'
import { fetchFiles } from '../sync/files.ts'
import { boardKey } from '../serve/token.ts'
import { dbRegistry, mintToken, type Registry } from '../serve/tokens.ts'
import { dbJoins } from '../serve/joins.ts'
import type { Backend } from './types.ts'

export type FileOptions = {
  /** The folder the board's file is in. Default: `MUSTER_DIR`, or `~/.muster`. */
  dir?: string
  /** The board's name: `<dir>/<name>.db`. Default `main`. */
  name?: string
  /** The key tokens are signed with, and the list of tokens made. Default: the ones kept for this board in the config folder. */
  key?: Buffer
  tokens?: Registry
  /** Keeps the board in memory: nothing is written, and it's gone with the process. For tests. */
  memory?: boolean
  now?: () => Date
  alive?: (pid: number, start: string) => boolean
  /** Who a caller with no token is. Default: this OS user. */
  principal?: string
  /** The platforms this board syncs with, from the operator's config. */
  sync?: Sync
  fetch?: typeof fetch
}

const BOARD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function boardPath(options: { dir?: string; name?: string } = {}): string {
  const name = options.name ?? process.env.MUSTER_BOARD ?? 'main'
  if (!BOARD_NAME.test(name)) throw misuse('invalid_board', `"${name}" isn't a board name.`, 'A board name is lowercase letters, numbers, "-" and "_".')
  const dir = options.dir ?? process.env.MUSTER_DIR ?? join(homedir(), '.muster')
  return join(resolve(dir), `${name}.db`)
}

/** A board in a SQLite file, answered in this process. Every process that opens it is one trust domain. */
export function file(options: FileOptions = {}): Backend {
  let resolved: string | null = null
  // Worked out on first use, so a bad name is that call's failure, like any other.
  const where = () => (resolved ??= options.memory ? ':memory:' : boardPath(options))
  let db: Db | null = null
  let checkpointed = 0
  let ticked = 0
  let held = false
  /** Once per process, before the first webhook or catch-up: where catching up starts is what was received before. */
  const hold = () => {
    if (held) return
    held = true
    holdCatchUp(ctx(), options.sync ?? {})
  }
  const open = (): Db => {
    if (db) return db
    const path = where()
    const opened = openDb(path)
    try {
      ensureSchema(opened)
    } catch (error) {
      opened.close()
      if (String((error as Error).message).startsWith('store_too_new')) {
        throw new Failure('store_too_new', `The board at ${path} was made by a newer muster.`, { hint: 'Update muster.' })
      }
      throw error
    }
    db = opened
    return opened
  }
  const ctx = (): Context => ({ db: open(), now: options.now ?? (() => new Date()), alive: options.alive ?? sameProcess })
  /** The board's list of the tokens it made: a table in the board itself. */
  const registry = (): Registry => options.tokens ?? dbRegistry(open(), () => (options.now ?? (() => new Date()))().getTime())
  const principal = options.principal ?? `local:user:${userInfo().username.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`

  // A caller held to some channels is told which are private, so the rules can keep it out of them.
  const narrowed = (c: Context, caller: Caller): Caller =>
    caller.can ? { ...caller, privates: (c.db.raw.prepare('select path from channels where private = 1').all() as { path: string }[]).map((row) => row.path) } : caller

  const op =
    <R, T>(fn: (ctx: Context, caller: Caller, request: R) => T) =>
    async (caller: Caller, request: R): Promise<T> => {
      const c = ctx()
      return fn(c, narrowed(c, caller), request)
    }

  return {
    kind: 'file',
    get where() {
      return where()
    },
    async self(profile) {
      return { principal, profile: profile === null ? null : profileName(profile) }
    },
    registry,
    leases: {
      take: async (request) => leases.take(ctx(), request),
      renew: async (request) => leases.renew(ctx(), request),
      release: async (request) => leases.release(ctx(), request),
      holder: async (name) => leases.holder(ctx(), name),
    },
    deliveries: {
      read: async (request) => deliveries.read(ctx(), request),
      begin: async (request) => deliveries.begin(ctx(), request),
      finish: async (request) => deliveries.finish(ctx(), request),
      advance: async (caller, request) => deliveries.advance(ctx(), caller, request),
    },
    joinStore: () => dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime()),
    // On the board's own machine the caller is its owner: they answer requests to join.
    joins: {
      ask: async (request) => dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime()).ask(request),
      poll: async (request) => dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime()).poll(request.code, request.secret),
      list: async () => ({ joins: dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime()).list() }),
      approve: async (request) => {
        const joins = dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime())
        const join = joins.pending(request.code)
        if (Object.keys(request.can ?? {}).length === 0) throw misuse('invalid_token', 'Say what the agent may do: --can <channel>=read,post.')
        const made = mintToken(options.key ?? boardKey(where()), registry(), { principal, claims: null }, { profile: join.profile, can: request.can, ttl: request.ttl, ...(request.noSync ? { noSync: true } : {}) }, (options.now ?? (() => new Date()))().getTime())
        return { join: joins.answer(join.code, made.token), record: made.record }
      },
      deny: async (request) => ({ join: dbJoins(open(), () => (options.now ?? (() => new Date()))().getTime()).answer(request.code, null) }),
    },
    // On the board's own machine the caller is its owner, who may make any token.
    tokens: {
      create: async (request) => mintToken(options.key ?? boardKey(where()), registry(), { principal, claims: null }, request, (options.now ?? (() => new Date()))().getTime()),
      list: async () => ({ tokens: registry().list((options.now ?? (() => new Date()))().getTime()) }),
      revoke: async (request) => {
        if (!registry().revoke(request.id)) throw new Failure('not_found', 'No such token.')
        return { revoked: request.id }
      },
      exchange: async () => {
        throw new Failure('exchange_closed', 'A board on this machine needs no token.', { hint: "A workload's token is exchanged at a served board: pass --url or set MUSTER_URL." })
      },
    },
    post: op(messages.post),
    reply: op(messages.reply),
    edit: op(messages.edit),
    remove: op(messages.remove),
    label: op(messages.label),
    react: op(messages.react),
    createChannel: op(messages.createChannel),
    workflowRequest: op(workflows.request),
    readChannel: op(reads.readChannel),
    readThread: op(reads.readThread),
    events: op(reads.events),
    channels: async (caller, request) => {
      const c = ctx()
      return reads.channels(c, narrowed(c, caller), request)
    },
    search: op(reads.search),
    actors: async (caller) => {
      const c = ctx()
      return reads.actors(c, narrowed(c, caller))
    },
    head: async () => reads.head(ctx()),
    cursorGet: async (caller, name) => reads.cursorGet(ctx(), caller, name),
    cursorSet: async (caller, name, seq) => reads.cursorSet(ctx(), caller, name, seq),
    taskCreate: op(tasks.create),
    taskPlan: op(tasks.plan),
    taskClaim: op(tasks.claim),
    taskRenew: op(tasks.renew),
    taskRelease: op(tasks.release),
    taskComplete: op(tasks.complete),
    taskFail: op(tasks.fail),
    taskBlock: op(tasks.block),
    taskUnblock: op(tasks.unblock),
    taskReopen: op(tasks.reopen),
    taskCancel: op(tasks.cancel),
    taskAssign: op(tasks.assign),
    taskNeeds: op(tasks.setNeeds),
    taskList: async (caller, request) => {
      const c = ctx()
      return tasks.list(c, narrowed(c, caller), request)
    },
    task: async (caller, id) => {
      const c = ctx()
      messageFor(c, narrowed(c, caller), id)
      return tasks.findTask(c, id)
    },
    budgetSet: op(tasks.setBudget),
    budgets: async (caller) => {
      const c = ctx()
      return tasks.budgets(c, narrowed(c, caller))
    },
    filePut: op(files.filePut),
    fileGet: op(files.fileGet),
    schemaAdd: op(blocks.schemaAdd),
    schemaList: async () => blocks.schemaList(ctx()),
    scheduleCreate: op(schedules.create),
    scheduleCancel: op(schedules.cancel),
    scheduleList: async (caller) => {
      const c = ctx()
      return schedules.list(c, narrowed(c, caller))
    },
    scheduleTick: async () => {
      const c = ctx()
      // The ticker also keeps the write-ahead log from growing while readers hold it open.
      const now = c.now().getTime()
      // Ticks come every second. A long gap between two means the machine slept: leases get that time back.
      if (ticked !== 0 && now - ticked > 60_000) tasks.grace(c, now - ticked, ticked)
      ticked = now
      if (now - checkpointed >= 300_000) {
        checkpointed = now
        try {
          c.db.raw.exec('pragma wal_checkpoint(passive)')
        } catch {
          // A busy checkpoint is tried again next time.
        }
      }
      return schedules.tick(c, (token) => registry().stopped(token))
    },
    backup: async (path) => {
      const target = resolve(path)
      if (existsSync(target)) throw new Failure('exists', `There is already a file at ${target}.`, { hint: 'Name a new file: a backup never writes over one.' })
      const filesTo = target.replace(/\.db$/, '') + '.files'
      if (existsSync(filesTo)) throw new Failure('exists', `There is already something at ${filesTo}.`, { hint: 'Name a new file: a backup never writes over one.' })
      // A copy of every message, wherever it is put: made empty and its owner's alone to read before
      // SQLite writes into it, so it is never readable by others, not even while it is written.
      ownerOnly(target)
      ctx().db.raw.exec(`vacuum into '${target.replaceAll("'", "''")}'`)
      // Files are stored by what they hold and never change, so copying them after the database is enough:
      // every file the copy names is there, and one stored since is harmless.
      const from = files.filesDir(ctx())
      if (from && existsSync(from)) {
        mkdirSync(filesTo, { mode: 0o700 })
        chmodSync(filesTo, 0o700)
        cpSync(from, filesTo, { recursive: true })
        return { path: target, files: filesTo }
      }
      return { path: target }
    },
    syncReceive: async (key, received) => {
      hold()
      return receive(ctx(), options.sync ?? {}, key, received)
    },
    syncTick: async () => {
      const sync = options.sync ?? {}
      if (Object.keys(sync).length === 0) return { imported: 0, delivered: 0, failed: 0 }
      // What the platforms sent while nothing here was listening: noted once per process, read on every tick until
      // a read gets to the end, so one that was refused or cut short, or noted by `mu serve`, is still read.
      hold()
      const caught = await catchUp(ctx(), sync, options.fetch ?? fetch)
      // Files that came with a webhook, or a catch-up read, are fetched here, not while the platform waits for its answer.
      await fetchFiles(ctx(), sync, options.fetch ?? fetch)
      const inbound = importPending(ctx(), sync)
      const outbound = await deliverPending(ctx(), sync, options.fetch ?? fetch)
      return { imported: inbound.imported, delivered: outbound.delivered, failed: inbound.failed + outbound.failed, ...(caught.skipped.length ? { skipped: caught.skipped } : {}) }
    },
    close() {
      db?.close()
      db = null
    },
  }
}

/** The open file behind a `file()` backend, for the fold test and the daemon. Not part of the handle. */
export const internals = { openDb, ensureSchema }
