import type * as blocks from '../core/blocks.ts'
import type { MintRequest, Registry, TokenRecord } from '../serve/tokens.ts'
import type { JoinRecord, Joins } from '../serve/joins.ts'
import type * as deliveries from '../core/deliveries.ts'
import type * as files from '../core/files.ts'
import type * as leases from '../core/leases.ts'
import type * as messages from '../core/messages.ts'
import type * as reads from '../core/reads.ts'
import type * as schedules from '../core/schedules.ts'
import type * as tasks from '../core/tasks.ts'
import type * as workflows from '../core/workflows.ts'
import type { Caller } from '../model.ts'

type Op<F> = F extends (ctx: any, caller: Caller, request: infer R) => infer T ? (caller: Caller, request: R) => Promise<T> : never
type Read<F> = F extends (ctx: any, caller: Caller, request?: infer R) => infer T ? (caller: Caller, request?: R) => Promise<T> : never

/**
 * What a board answers. `file()` answers from the SQLite file in this process; `http()` asks a
 * `mu serve`. The handle calls nothing else, so a new backend is these methods and the conformance suite.
 */
export type Backend = {
  kind: 'file' | 'http'
  /** Where the board is, for people: a path or a URL. */
  where: string
  /** Who a request with no token is from, on a backend that decides that itself. */
  self(profile: string | null): Promise<Caller>
  /** The board's own list of tokens, where it has one: what `mu serve` checks each request's token against. */
  registry?: () => Registry
  /** The key this board's tokens are signed with, where it keeps one: the one `mu serve` and `team.fetch` check tokens with. */
  signingKey?: () => Buffer
  /** The board's tokens: making one, listing them, stopping one. For the owner, or a token as wide as the owner's. */
  tokens: {
    create(request: MintRequest): Promise<{ token: string; record: TokenRecord }>
    list(): Promise<{ tokens: TokenRecord[] }>
    revoke(request: { id: string }): Promise<{ revoked: string }>
    /** A workload's own token, signed by its platform, for a board token: on a served board whose owner trusts that workload. */
    exchange(request: { token: string }): Promise<{ token: string; record: TokenRecord; trust: string }>
  }
  /**
   * Roles one process at a time holds for this board (the ticker is `tick`), where the board keeps them:
   * only a backend that has the board's file. A board at a URL is ticked by the server it is on.
   */
  leases?: {
    take(request: { name: string; holder: string; ttl: number }): Promise<leases.Taken>
    renew(request: { name: string; holder: string; epoch: number; ttl: number }): Promise<{ held: boolean; expires: number }>
    release(request: { name: string; holder: string; epoch: number }): Promise<void>
    holder(name: string): Promise<ReturnType<typeof leases.holder>>
  }
  /**
   * Where each watcher declared in code stands: what it delivered above its cursor and what it is
   * trying. Only a backend that has the board's file: watchers run where it is.
   */
  deliveries?: {
    read(request: { watcher: string; after: number }): Promise<ReturnType<typeof deliveries.read>>
    begin(request: Parameters<typeof deliveries.begin>[1]): Promise<ReturnType<typeof deliveries.begin>>
    finish(request: Parameters<typeof deliveries.finish>[1]): Promise<ReturnType<typeof deliveries.finish>>
    advance(caller: Caller, request: Parameters<typeof deliveries.advance>[2]): Promise<ReturnType<typeof deliveries.advance>>
  }
  /** The board's own requests to join, where it keeps them: what `mu serve` answers them from. */
  joinStore?: () => Joins
  /** Asking to join (no token needed), and answering: listing, approving with what the token may do, refusing. */
  joins: {
    ask(request: { profile: string; note?: string }): Promise<{ code: string; secret: string; expires: number }>
    poll(request: { code: string; secret: string }): Promise<{ state: 'pending' } | { state: 'approved'; token: string } | { state: 'denied' }>
    list(): Promise<{ joins: JoinRecord[] }>
    approve(request: { code: string; can: Record<string, string[]>; ttl: number; noSync?: boolean }): Promise<{ join: JoinRecord; record: TokenRecord }>
    deny(request: { code: string }): Promise<{ join: JoinRecord }>
  }

  post: Op<typeof messages.post>
  reply: Op<typeof messages.reply>
  edit: Op<typeof messages.edit>
  remove: Op<typeof messages.remove>
  label: Op<typeof messages.label>
  react: Op<typeof messages.react>
  createChannel: Op<typeof messages.createChannel>
  workflowRequest: Op<typeof workflows.request>

  readChannel: Op<typeof reads.readChannel>
  readThread: Op<typeof reads.readThread>
  events: Op<typeof reads.events>
  channels: Read<typeof reads.channels>
  search: Op<typeof reads.search>
  actors(caller: Caller): Promise<ReturnType<typeof reads.actors>>
  head(caller: Caller): Promise<number>
  cursorGet(caller: Caller, name: string): Promise<number | null>
  cursorSet(caller: Caller, name: string, seq: number): Promise<void>

  taskCreate: Op<typeof tasks.create>
  taskPlan: Op<typeof tasks.plan>
  taskClaim: Op<typeof tasks.claim>
  taskRenew: Op<typeof tasks.renew>
  taskRelease: Op<typeof tasks.release>
  taskComplete: Op<typeof tasks.complete>
  taskFail: Op<typeof tasks.fail>
  taskBlock: Op<typeof tasks.block>
  taskUnblock: Op<typeof tasks.unblock>
  taskReopen: Op<typeof tasks.reopen>
  taskCancel: Op<typeof tasks.cancel>
  taskAssign: Op<typeof tasks.assign>
  taskNeeds: Op<typeof tasks.setNeeds>
  taskList: Read<typeof tasks.list>
  task(caller: Caller, id: number): Promise<tasks.Task | null>

  budgetSet: Op<typeof tasks.setBudget>
  budgets(caller: Caller): Promise<ReturnType<typeof tasks.budgets>>

  filePut: Op<typeof files.filePut>
  fileGet: Op<typeof files.fileGet>

  schemaAdd: Op<typeof blocks.schemaAdd>
  schemaList(caller: Caller): Promise<ReturnType<typeof blocks.schemaList>>

  scheduleCreate: Op<typeof schedules.create>
  scheduleCancel: Op<typeof schedules.cancel>
  scheduleList(caller: Caller): Promise<ReturnType<typeof schedules.list>>
  /** Sends what is due now. Whoever holds the board's `tick` lease calls it. */
  scheduleTick(caller: Caller): Promise<ReturnType<typeof schedules.tick>>

  /**
   * Takes a platform's webhook for the sync named `key`. Only the server that owns the board answers this.
   * `skipped` says what it carried that was late, and not applied.
   */
  syncReceive(key: string, received: { headers: Record<string, string | undefined>; body: string }): Promise<{ status: number; body: string; skipped?: string[] }>
  /** The names of the platforms this board syncs with, as configured: none means a tick has nothing to do. */
  readonly syncs?: readonly string[]
  /** Throws, saying why, when the sync can't run: a secret it names with `env()` isn't set. Said to the owner only. */
  syncCheck?(): void
  /** Imports what is waiting and delivers what is owed. Whoever holds the board's `sync` lease calls it. */
  syncTick(): Promise<{ imported: number; delivered: number; failed: number; skipped?: string[] }>

  /** Writes a consistent copy of the board to `path`, while others keep writing. File boards only. */
  backup(path: string): Promise<{ path: string; files?: string }>

  close(): void
}
