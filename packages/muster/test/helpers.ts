import { execFile, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { afterAll } from 'vitest'
import { board, file, http, listen, mint, type Board, type BoardOptions } from '../src/index.ts'

/** A clock a test moves by hand. */
export function clock(start = '2026-01-01T00:00:00.000Z') {
  let now = Date.parse(start)
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms
    },
  }
}

export const tempDir = () => mkdtempSync(join(tmpdir(), 'muster-test-'))

/** Which backend the suite runs on: the file in this process, or the same board behind `mu serve`. */
export const HTTP = process.env.MUSTER_BACKEND === 'http'
const closers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

/**
 * A board in memory, as Ada, on a clock the test holds. With MUSTER_BACKEND=http the same board is
 * reached through a server and tokens, so one suite checks both backends.
 */
export function memoryBoard(options: BoardOptions = {}) {
  const time = clock()
  const alive = new Set<string>()
  const backend = file({ memory: true, principal: 'local:user:ada', now: time.now, alive: (pid, start) => alive.has(`${pid}@${start}`), ...options })
  if (!HTTP) {
    /** The same board as another principal: someone who isn't its owner. */
    const as = (principal: string): Board => board({ backend: { ...backend, self: async (profile) => ({ principal, profile }) } })
    return { team: board({ backend }), time, alive, as }
  }
  const key = randomBytes(32)
  const serving = listen({ backend, key, now: () => time.now().getTime() })
  closers.push(async () => (await serving).close())
  const url = serving.then((server) => server.url)
  const token = (principal: string) => mint(key, { sub: principal, profile: null, exp: Math.floor(time.now().getTime() / 1000) + 10 * 365 * 86_400 })
  const as = (principal: string): Board => board({ backend: http({ url, token: token(principal) }) })
  const team = as('local:user:ada')
  // The ticker is the server's own: tests that send what is due call the board behind it.
  ;(team as { scheduleTick: unknown }).scheduleTick = () => backend.scheduleTick({ principal: 'board', profile: null })
  return { team, time, alive, as }
}

export const BIN = fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))

export type Ran = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Runs the CLI from source as a subprocess, on a board and a config folder of the test's own. */
export function cli(dir: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...options.env } },
      (error, stdout, stderr) => {
        const failed = error as (Error & { code?: number | string; signal?: NodeJS.Signals }) | null
        resolve({ code: failed ? (typeof failed.code === 'number' ? failed.code : null) : 0, signal: failed?.signal ?? null, stdout, stderr })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** Starts the CLI and leaves it running, for commands that wait. */
export function cliStart(dir: string, args: string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise<Ran>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, done, output: () => stdout, errors: () => stderr }
}

export const reason = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (error) {
    return (error as { reason?: string }).reason ?? `threw: ${String(error)}`
  }
  return 'did not fail'
}

export type { Board }
