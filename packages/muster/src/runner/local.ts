import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent, ExitKind, Parsed, PermissionMode } from './agents.ts'

export type RunRequest = {
  agent: Agent
  /** What the agent is told. A pointer to the task, never its content. */
  prompt: string
  /** Where it works. */
  cwd: string
  /** Makes `cwd` a git worktree of this repository on a new branch, when it doesn't exist yet. */
  worktree?: { repo: string; branch: string; from?: string }
  /** What the agent's environment carries, beside PATH, HOME and what the agent itself names. */
  env?: Record<string, string>
  /** Names to pass through from this process's environment. Nothing else is inherited. */
  envAllow?: string[]
  permissionMode?: PermissionMode
  /** Folders beside `cwd` the agent must be able to write: the board's, so its own `mu` commands work in a sandbox. */
  writable?: string[]
  /** Load the person's whole agent setup instead of the lean one. */
  full?: boolean
  model?: string
  resume?: string
  /** Where its output is kept. */
  logDir: string
  /** Stops it after this long. */
  timeoutMs?: number
  signal?: AbortSignal
  /** How long it gets between being asked to stop and being killed. */
  graceMs?: number
  /** Removes the logs of earlier runs kept beside this one's (folders named `<task>-<time>`) once they are older than this. Left out, nothing is removed. */
  keepLogsMs?: number
  now?: () => number
}

/** How long `mu run` keeps a run's log: it is the agent's whole transcript, with whatever it read. */
export const KEEP_LOGS_MS = 30 * 86_400_000

/** Removes the logs of runs older than `keepMs` from the folder runs are kept in. Only folders named as a run's are touched. */
function pruneLogs(runs: string, keepMs: number, now: number) {
  let names: string[] = []
  try {
    names = readdirSync(runs)
  } catch {
    return
  }
  for (const name of names) {
    // A task's ID and the millisecond it started, as mu run names them: nothing else is touched.
    if (!/^\d+-\d{13}$/.test(name)) continue
    try {
      if (statSync(join(runs, name)).mtimeMs < now - keepMs) rmSync(join(runs, name), { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

export type RunResult = { kind: ExitKind; code: number | null; signal: NodeJS.Signals | null; parsed: Parsed; stdoutPath: string; stderrPath: string; pid: number; notStarted?: boolean }

// DO_NOT_TRACK is the opt-out every tool is asked to honour: an agent started here keeps it.
const ALWAYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'DO_NOT_TRACK']

/**
 * The environment an agent starts with: built from nothing, then PATH and HOME, what the agent itself
 * needs, and what the caller allows by name. Secrets in this process's environment don't reach it by
 * accident, and no marker makes it think it runs inside another agent.
 */
export function agentEnv(agent: Agent, request: Pick<RunRequest, 'env' | 'envAllow'>, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [...ALWAYS, ...agent.envKeys, ...(request.envAllow ?? [])]) {
    const value = from[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...request.env }
}

export function ensureWorktree(cwd: string, worktree: NonNullable<RunRequest['worktree']>) {
  if (existsSync(join(cwd, '.git'))) return
  mkdirSync(dirname(cwd), { recursive: true })
  execFileSync('git', ['-C', worktree.repo, 'worktree', 'add', '-b', worktree.branch, cwd, ...(worktree.from ? [worktree.from] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Runs an agent to its end in its own process group, and says how it ended. */
export function runLocal(request: RunRequest): { pid: number; done: Promise<RunResult>; stop(): void } {
  if (request.worktree) ensureWorktree(request.cwd, request.worktree)
  if (request.keepLogsMs !== undefined) pruneLogs(dirname(request.logDir), request.keepLogsMs, (request.now ?? Date.now)())
  // A log is everything the agent printed, and so everything it read: its owner's alone, whatever the folder above allows.
  mkdirSync(request.logDir, { recursive: true, mode: 0o700 })
  chmodSync(request.logDir, 0o700)
  const stdoutPath = join(request.logDir, 'stdout.log')
  const stderrPath = join(request.logDir, 'stderr.log')
  const out = openSync(stdoutPath, 'w', 0o600)
  const err = openSync(stderrPath, 'w', 0o600)
  const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe', ...(request.full ? { full: true } : {}), ...(request.writable ? { writable: request.writable } : {}), ...(request.resume ? { resume: request.resume } : {}), ...(request.model ? { model: request.model } : {}) })
  const child = spawn(bin, args, { cwd: request.cwd, env: agentEnv(request.agent, request), stdio: ['pipe', out, err], detached: true })
  closeSync(out)
  closeSync(err)
  child.stdin!.on('error', () => {})
  child.stdin!.end(request.prompt)

  let timedOut = false
  let stopped = false
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal)
    } catch {
      child.kill(signal)
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), request.graceMs ?? 5000).unref()
  }
  const timer = request.timeoutMs ? setTimeout(() => ((timedOut = true), stop()), request.timeoutMs) : null
  request.signal?.addEventListener('abort', stop)

  const done = new Promise<RunResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, failedToStart = false) => {
      if (timer) clearTimeout(timer)
      request.signal?.removeEventListener('abort', stop)
      // Whatever it started goes with it.
      if (!failedToStart) killGroup('SIGKILL')
      const read = (path: string) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return ''
        }
      }
      const parsed = request.agent.parse(read(stdoutPath))
      const kind: ExitKind = failedToStart ? 'crash' : timedOut ? 'timeout' : stopped ? 'stopped' : request.agent.classify({ code, signal, parsed, stderr: read(stderrPath).slice(-4000) })
      resolve({ kind, code, signal, parsed, stdoutPath, stderrPath, pid: child.pid ?? 0, ...(failedToStart ? { notStarted: true } : {}) })
    }
    child.on('error', () => finish(null, null, true))
    child.on('exit', (code, signal) => finish(code, signal))
  })
  return { pid: child.pid ?? 0, done, stop }
}
