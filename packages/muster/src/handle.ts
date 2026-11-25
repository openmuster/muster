import { file, type FileOptions } from './backend/file.ts'
import type { Backend } from './backend/types.ts'
import type { Caller } from './model.ts'
import { mount, type MountOptions } from './serve/fetch.ts'
import { deliver, start, type Delivered, type Host, type StartOptions, type WatchState } from './watch/host.ts'
import { checkWatchers, type Watch } from './watch/watch.ts'

export type BoardOptions = FileOptions & {
  /** Where the board lives. Default: `file()` with the options beside it. */
  backend?: Backend
  /** The profile this handle writes as. Default: `MUSTER_PROFILE`, or the principal itself. */
  as?: string | null
  /**
   * Watchers by name: what to listen for and what to do. Declaring them starts nothing: `start()` does,
   * in the process you choose.
   */
  watch?: Record<string, Watch>
  /** How `fetch` serves the board: the path it is mounted at, and the host names it answers for. */
  serve?: MountOptions
}

type Bound<F> = F extends (caller: Caller, ...rest: infer A) => infer T ? (...rest: A) => T : never
type Methods = Omit<Backend, 'kind' | 'where' | 'self' | 'close'>

/** A board, as one caller: every read and write the CLI, a UI, or your code makes. */
export type Board = { [K in keyof Methods]: Bound<Methods[K]> } & {
  backend: Backend
  /** The same board, writing as one of your profiles. */
  as(profile: string | null): Board
  whoami(): Promise<{ principal: string; profile: string | null; mode: 'file' | 'serve'; where: string }>
  /** Runs the watchers in this process until stopped, and returns at once. Never await `done` in a server's startup. */
  start(options?: StartOptions): Host
  /** Runs each watcher once on what it has not had yet, and says what happened. For tests. */
  deliver(): Promise<Delivered>
  /**
   * What `mu serve` serves for this board, as a web `Request → Response` handler: its routes, the live feed,
   * webhooks for its sync, every request held to a token. `export const GET = team.fetch, POST = team.fetch`.
   */
  fetch(request: Request): Promise<Response>
  close(): void
}

const METHODS = [
  'post', 'reply', 'edit', 'remove', 'label', 'react', 'createChannel', 'workflowRequest',
  'readChannel', 'readThread', 'events', 'channels', 'search', 'actors', 'head', 'cursorGet', 'cursorSet',
  'taskCreate', 'taskPlan', 'taskClaim', 'taskRenew', 'taskRelease', 'taskComplete', 'taskFail', 'taskBlock',
  'taskUnblock', 'taskReopen', 'taskCancel', 'taskAssign', 'taskNeeds', 'taskList', 'task',
  'scheduleCreate', 'scheduleCancel', 'scheduleList', 'scheduleTick', 'schemaAdd', 'schemaList', 'filePut', 'fileGet', 'budgetSet', 'budgets',
] as const satisfies readonly (keyof Methods)[]

/** A handle on a board: `board()` is the default board in `~/.muster`, as you. */
export function board(options: BoardOptions = {}): Board {
  const { backend: given, as: profile, watch, serve, ...fileOptions } = options
  // Checked now, so a bad watcher is the module's mistake, said once. Nothing is opened or started.
  const watchers = checkWatchers(watch)
  // Where each watcher's reading has got to, shared by start() and deliver() on this handle.
  const states = new Map<string, WatchState>()
  const backend = given ?? file(fileOptions)
  // Opens nothing until its first request.
  const served = mount(backend, { ...serve, ...(fileOptions.now ? { now: fileOptions.now } : {}) })
  let root: Board
  const make = (as: string | null): Board => {
    let caller: Promise<Caller> | null = null
    const who = () => (caller ??= backend.self(as))
    const handle = {
      backend,
      as: (next: string | null) => make(next),
      async whoami() {
        const me = await who()
        return { principal: me.principal, profile: me.profile, mode: backend.kind === 'file' ? ('file' as const) : ('serve' as const), where: backend.where }
      },
      start: (startOptions?: StartOptions) => start(root, watchers, states, startOptions),
      deliver: () => deliver(root, watchers, states),
      fetch: served,
      close: () => backend.close(),
    } as Record<string, unknown>
    for (const name of METHODS) {
      handle[name] = async (...args: unknown[]) => (backend[name] as (caller: Caller, ...rest: unknown[]) => unknown)(await who(), ...args)
    }
    return handle as unknown as Board
  }
  const fromEnv = process.env.MUSTER_PROFILE
  root = make(profile !== undefined ? profile : fromEnv && fromEnv.length > 0 ? fromEnv : null)
  return root
}
