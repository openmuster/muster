// Starts one agent session on one thread. The factory's watcher runs this file with `command()`, so it starts
// in a clean environment: PATH, HOME, the board's own variables (MUSTER_DIR, MUSTER_PROFILE=factory,
// MUSTER_EVENT, ...) and the names `lib/board.ts` passes on. It gets a pointer, never the text: the agent
// reads the thread itself.
//
//   node lib/wake.ts <thread>
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { board, type Board } from '@openmuster/muster'

/** This file, by its full path: what the watcher runs. */
export const WAKE = fileURLToPath(import.meta.url)
const AGENT = join(dirname(WAKE), '..', 'AGENT.md')

/** An environment, as read here: names to values. */
type Env = Record<string, string | undefined>

/** What the agent is told: how to work on the board (AGENT.md), and which thread changed. Nothing the thread says. */
export function brief(thread: string, instructions: string = readFileSync(AGENT, 'utf8')): string {
  return `${instructions}\nThread ${thread} changed. Open it with: mu read ${thread}\nWork out what happened after your last reply, and respond only if it concerns you.\n`
}

/**
 * What an agent started on this machine gets: what any process needs (PATH, HOME, ...), the pointer the
 * watcher's `command()` gave (the board, the profile, the thread and event), and the model key. Nothing
 * else this wake was given: never the sandbox's Vercel token or the GitHub App's key, which only `mu run
 * --runner vercel` needs.
 */
export const AGENT_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
  'MUSTER_DIR', 'MUSTER_BOARD', 'MUSTER_CONFIG', 'MUSTER_PROFILE',
  'MUSTER_WATCHER', 'MUSTER_THREAD', 'MUSTER_CHANNEL', 'MUSTER_EVENT', 'MUSTER_EVENT_TYPE', 'MUSTER_ATTEMPT',
  'ANTHROPIC_API_KEY',
]

/** The environment an agent on this machine starts with: only the names in AGENT_ENV, from this wake's. */
export const agentEnv = (env: Env): Env => Object.fromEntries(AGENT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]))

/** The agent's command, as words: FACTORY_AGENT split on spaces, or Claude Code headless. */
export const agentWords = (env: Env): string[] => (env.FACTORY_AGENT ?? 'claude --print').split(' ').filter(Boolean)

/** `mu run`'s words for one wake in a cloud sandbox: Vercel's, or E2B's with FACTORY_RUNNER=e2b. */
export function sandboxWords(task: number, env: Env): string[] {
  return ['run', String(task), '--runner', env.FACTORY_RUNNER === 'e2b' ? 'e2b' : 'vercel', '--agent', 'claude', '--as', 'factory', ...(env.FACTORY_REPO ? ['--repo', env.FACTORY_REPO] : []), ...(env.FACTORY_PUSH === '1' ? ['--push'] : [])]
}

/** Runs a command with this process's output, `input` on its stdin, and resolves with how it exited. */
function run(words: string[], options: { input?: string; env?: Env } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(words[0]!, words.slice(1), { stdio: [options.input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'], env: (options.env ?? process.env) as NodeJS.ProcessEnv })
    child.stdin?.end(options.input)
    child.on('error', () => resolve(127))
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}

/**
 * In a cloud sandbox: the wake becomes a task in factory-runs, outside factory/, so the watcher never sees
 * it and people's channels don't fill with instructions. The agent's token reaches both, for an hour. The
 * task is keyed by the event that woke it, so a wake tried again makes no second task.
 */
async function inSandbox(team: Board, thread: string, env: Env): Promise<number> {
  const made = await team.taskCreate({ channel: 'factory-runs', text: brief(thread), labels: { wake: thread }, ...(env.MUSTER_EVENT ? { idempotencyKey: `factory-wake-${env.MUSTER_EVENT}` } : {}) })
  const permissions = ['read', 'post', 'react', 'label']
  const { token } = await team.backend.tokens.create({ profile: 'factory', can: { 'factory/': permissions, 'factory-runs': permissions }, ttl: 3600, sandbox: true })
  // The token is one for a sandbox: the board holds it to the routes a sandbox may call, which E2B's network can't.
  // Only `mu run` gets the sandbox's settings (Vercel or E2B, the GitHub App, MUSTER_SANDBOX_URL): it starts the
  // sandbox and pushes from here. The agent in the sandbox gets none of them, only its token for the board.
  return run(['mu', ...sandboxWords(made.task.id, env)], { env: { ...env, MUSTER_AGENT_TOKEN: token } })
}

/** One wake: the agent on this machine, or in a cloud sandbox with FACTORY_RUNNER=vercel or e2b. Resolves with its exit code. */
export async function wake(thread: string, env: Env = process.env): Promise<number> {
  if (env.FACTORY_RUNNER === 'vercel' || env.FACTORY_RUNNER === 'e2b') {
    const team = board()
    try {
      return await inSandbox(team, thread, env)
    } finally {
      team.close()
    }
  }
  return run(agentWords(env), { input: brief(thread), env: agentEnv(env) })
}

if (process.argv[1] === WAKE) {
  const thread = process.argv[2] ?? ''
  if (!/^\d+$/.test(thread)) {
    process.stderr.write(`wake.ts: not a thread ID: ${thread}\n`)
    process.exit(2)
  }
  process.exit(await wake(thread))
}
