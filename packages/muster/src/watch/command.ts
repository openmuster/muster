import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { watcherEnv } from '../daemon/daemon.ts'
import { gateSaysNo } from '../daemon/watchers.ts'
import type { WatchContext } from './watch.ts'

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
 * Runs a command to its end, in a process group of its own. Settled once the process has exited and
 * its output has closed, so a gate whose answer comes from a child it left behind is read whole. On
 * `signal`, the group is told to stop, and killed after `grace`.
 */
function run(argv: string[], env: Record<string, string>, signal: AbortSignal, grace: number): Promise<Ended> {
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
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
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
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > KEPT) stdout = stdout.slice(-KEPT)
    })
    // A command that can't start is one that failed, as a shell says it: 127.
    child.on('error', () => settle({ code: 127, signal: null }))
    child.on('close', (code, killed) => settle({ code, signal: killed }))
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
    if (options.gate !== undefined) {
      const gate = await run(wordsOf(options.gate, context), env, context.signal, grace)
      if (gateSaysNo(gate.stdout)) return
    }
    const words = wordsOf(argv, context)
    const ended = await run(words, env, context.signal, grace)
    if (ended.code === 0) return
    const why = ended.code === null ? `killed by ${ended.signal ?? 'a signal'}` : `exit ${ended.code}`
    throw Object.assign(new Error(`${words[0]} ended with ${why}`), { why })
  }
}
