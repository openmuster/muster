import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import type { WatchContext } from './watch.ts'

const WATCHER_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'MUSTER_DIR', 'MUSTER_BOARD', 'MUSTER_CONFIG', 'MUSTER_URL', 'MUSTER_INSECURE_HTTP']

/**
 * What a watcher's command starts with: built from nothing, then the few names above. The host holds
 * the platforms' secrets in its own environment, and what it wakes is often an agent reading text a
 * stranger wrote, so nothing else is passed on unless the watcher names it.
 */
export function watcherEnv(extra: Record<string, string>, allow: readonly string[] = [], from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...WATCHER_ENV, ...allow]) if (from[name] !== undefined) env[name] = from[name]!
  return { ...env, ...extra }
}

/** Whether a gate's output says not to wake: its last non-empty line is JSON with `wake: false`. */
export function gateSaysNo(stdout: string): boolean {
  const last = stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  if (!last) return false
  try {
    return (JSON.parse(last) as { wake?: unknown }).wake === false
  } catch {
    return false
  }
}

/** A command as its words, or worked out from the event: never a string a shell splits. */
export type Argv = string[] | ((context: WatchContext) => string[])

export type CommandOptions = {
  /** Names to pass on from this process's environment, beside PATH, HOME and the board's own. Nothing else is. */
  env?: string[]
  /** Run first: when the last line it prints is JSON with `wake: false`, the command isn't run. */
  gate?: Argv
  /** How long a command told to stop (at the watcher's timeout) has before it is killed. Default 5 seconds. */
  grace?: number
}

/** What a command ended with, and what it printed. */
type Ended = { code: number | null; signal: NodeJS.Signals | null; stdout: string }

/** The most of a command's output kept: a gate's answer is its last line. */
const KEPT = 64 * 1024

/**
 * Runs a command in a process group of its own. A gate (`answer`) is read whole: settled once it has
 * exited and its output has closed, so an answer printed by a child it left behind is heard. A command
 * that wakes something (`wake`) writes to this process's output and is settled when it exits: what it
 * started in the background (an agent) lives on, and nothing here waits for it or kills it. Until it is
 * settled, `signal` tells the group to stop, and kills it after `grace`.
 */
function run(argv: string[], env: Record<string, string>, signal: AbortSignal, grace: number, mode: 'answer' | 'wake'): Promise<Ended> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const settle = (ended: Omit<Ended, 'stdout'>) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', stop)
      // A kill already on its way stays on its way: a child that ignored SIGTERM and let go of the output is still killed.
      resolve({ ...ended, stdout })
    }
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', mode === 'answer' ? 'pipe' : 'inherit', 'inherit'], detached: true })
    const group = (name: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, name)
      } catch {
        // Gone already.
      }
    }
    function stop() {
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), grace).unref()
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > KEPT) stdout = stdout.slice(-KEPT)
    })
    // A command that can't start is one that failed, as a shell says it: 127.
    child.on('error', () => settle({ code: 127, signal: null }))
    child.on(mode === 'answer' ? 'close' : 'exit', (code: number | null, killed: NodeJS.Signals | null) => settle({ code, signal: killed }))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * What a command a watcher wakes starts with: nothing of this process's environment but PATH, HOME and
 * the like, the names the watcher passes on, and a pointer to what happened. Never the text: the
 * command reads the thread itself, as the profile it is woken as.
 */
export function pointer(context: WatchContext): Record<string, string> {
  const { event, watcher, board } = context
  const env: Record<string, string> = {
    MUSTER_WATCHER: watcher.name,
    MUSTER_THREAD: event.thread === null ? '' : String(event.thread),
    MUSTER_CHANNEL: event.channel ?? '',
    MUSTER_EVENT: String(event.seq),
    MUSTER_EVENT_TYPE: event.type,
    MUSTER_ATTEMPT: String(context.attempt),
  }
  if (watcher.as !== null) env.MUSTER_PROFILE = watcher.as
  // The board the handle has, whatever this process's environment says: a module may name its own.
  const where = board.backend.where
  if (board.backend.kind === 'file' && where !== ':memory:') {
    env.MUSTER_DIR = dirname(where)
    env.MUSTER_BOARD = basename(where, '.db')
  }
  return env
}

const wordsOf = (argv: Argv, context: WatchContext): string[] => {
  const words = typeof argv === 'function' ? argv(context) : argv
  if (!Array.isArray(words) || words.length === 0 || !words.every((word) => typeof word === 'string')) throw new Error('A command is a list of words, the first the program to run.')
  return words
}

/**
 * A watcher's `run` that starts a command, the way to wake an agent: `command(['./wake.sh'])`, or
 * `command(({ event }) => ['./wake.sh', String(event.thread)])`. It is woken with a pointer in its
 * environment (`MUSTER_THREAD`, `MUSTER_EVENT`, ...) and nothing else of this process's but what `env`
 * names. Exit 0 is delivered; anything else is a failed try. At the watcher's timeout its process group
 * is stopped.
 */
export function command(argv: Argv, options: CommandOptions = {}): (context: WatchContext) => Promise<void> {
  const grace = options.grace ?? 5000
  return async (context) => {
    const env = watcherEnv(pointer(context), options.env ?? [])
    // The board is the one the pointer names: nothing from this process's environment may point elsewhere.
    const named = new Set(options.env ?? [])
    const elsewhere = ['MUSTER_URL', 'MUSTER_INSECURE_HTTP', ...(pointer(context).MUSTER_DIR === undefined ? ['MUSTER_DIR', 'MUSTER_BOARD'] : [])]
    for (const name of elsewhere) if (!named.has(name)) delete env[name]
    if (options.gate !== undefined) {
      const gate = await run(wordsOf(options.gate, context), env, context.signal, grace, 'answer')
      if (gateSaysNo(gate.stdout)) return
    }
    const words = wordsOf(argv, context)
    const ended = await run(words, env, context.signal, grace, 'wake')
    if (ended.code === 0) return
    const why = ended.code === null ? `killed by ${ended.signal ?? 'a signal'}` : `exit ${ended.code}`
    throw Object.assign(new Error(`${words[0]} ended with ${why}`), { why })
  }
}
