import { execFile, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { file } from '../src/backend/file.ts'
import { holdLease } from '../src/daemon/lease.ts'
import { clock, reason, tempDir } from './helpers.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/lease.ts', import.meta.url))
/** How the fixture is started: Node 22 says on stderr that its SQLite is experimental, which `bin.ts` keeps quiet for the CLI. */
const NODE_ARGS = ['--disable-warning=ExperimentalWarning', FIXTURE]

/** Runs the fixture as its own process and gives back what it printed. */
const fixture = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [...NODE_ARGS, ...args], { cwd: options.cwd, env: { PATH: process.env.PATH, ...options.env } }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? null) : 0, stdout, stderr }),
    )
  })

const SECOND = 1000

describe('leases', () => {
  it('one holder at a time: taken, refused to another, renewed, released, and the epoch only ever rises', async () => {
    const time = clock()
    const leases = file({ dir: tempDir(), now: time.now }).leases!
    const a = await leases.take({ name: 'tick', holder: 'a', ttl: 30 * SECOND })
    expect(a).toEqual({ held: true, epoch: 1, expires: time.now().getTime() + 30 * SECOND })
    expect(await leases.take({ name: 'tick', holder: 'b', ttl: 30 * SECOND })).toEqual({ held: false, holder: 'a', epoch: 1, expires: a.expires })
    // Other roles are other leases.
    expect(await leases.take({ name: 'watch:lead', holder: 'b', ttl: 30 * SECOND })).toMatchObject({ held: true, epoch: 1 })
    time.advance(20 * SECOND)
    expect(await leases.renew({ name: 'tick', holder: 'a', epoch: 1, ttl: 30 * SECOND })).toEqual({ held: true, expires: time.now().getTime() + 30 * SECOND })
    time.advance(20 * SECOND)
    // Renewed, it outlived its first deadline.
    expect(await leases.holder('tick')).toMatchObject({ holder: 'a', epoch: 1 })
    await leases.release({ name: 'tick', holder: 'a', epoch: 1 })
    expect(await leases.holder('tick')).toBeNull()
    // Released, the next taker needn't wait, and gets a new epoch.
    expect(await leases.take({ name: 'tick', holder: 'b', ttl: 30 * SECOND })).toMatchObject({ held: true, epoch: 2 })
    // The old holder's renewal is refused: it is told, and changes nothing.
    expect(await leases.renew({ name: 'tick', holder: 'a', epoch: 1, ttl: 30 * SECOND })).toMatchObject({ held: false })
    expect(await leases.holder('tick')).toMatchObject({ holder: 'b', epoch: 2 })
  })

  it('a lapsed lease goes to the next taker, and its old holder, back late, has lost it', async () => {
    const time = clock()
    const leases = file({ dir: tempDir(), now: time.now }).leases!
    await leases.take({ name: 'tick', holder: 'a', ttl: 30 * SECOND })
    time.advance(30 * SECOND)
    expect(await leases.holder('tick')).toBeNull()
    expect(await leases.take({ name: 'tick', holder: 'b', ttl: 30 * SECOND })).toMatchObject({ held: true, epoch: 2 })
    expect(await leases.renew({ name: 'tick', holder: 'a', epoch: 1, ttl: 30 * SECOND })).toMatchObject({ held: false })
    // The epoch fences, not only the name: a holder that took it back after it lapsed holds a new epoch, and the old one's renewal is refused.
    time.advance(30 * SECOND)
    expect(await leases.take({ name: 'tick', holder: 'b', ttl: 30 * SECOND })).toMatchObject({ held: true, epoch: 3 })
    expect(await leases.renew({ name: 'tick', holder: 'b', epoch: 2, ttl: 30 * SECOND })).toMatchObject({ held: false })
    expect(await leases.renew({ name: 'tick', holder: 'b', epoch: 3, ttl: 30 * SECOND })).toMatchObject({ held: true })
  })

  it('a holder late to renew still holds a lease nobody took meanwhile: a laptop that slept keeps its ticker', async () => {
    const time = clock()
    const leases = file({ dir: tempDir(), now: time.now }).leases!
    await leases.take({ name: 'tick', holder: 'a', ttl: 30 * SECOND })
    time.advance(3_600 * SECOND)
    expect(await leases.renew({ name: 'tick', holder: 'a', epoch: 1, ttl: 30 * SECOND })).toMatchObject({ held: true })
    expect(await leases.take({ name: 'tick', holder: 'b', ttl: 30 * SECOND })).toMatchObject({ held: false, holder: 'a' })
  })

  it('a board made before leases (store version 7, muster 0.2.1) gets the table when opened', async () => {
    const dir = tempDir()
    const made = file({ dir })
    await made.leases!.holder('tick')
    made.close()
    // Back to what 0.2.1 wrote: the same tables, without this one.
    const raw = new DatabaseSync(join(dir, 'main.db'))
    raw.exec('drop table leases; pragma user_version = 7')
    raw.close()
    expect(await file({ dir }).leases!.take({ name: 'tick', holder: 'a', ttl: SECOND })).toMatchObject({ held: true, epoch: 1 })
  })

  it('refuses a name, holder or length it would not keep', async () => {
    const leases = file({ memory: true }).leases!
    expect(await reason(leases.take({ name: 'Tick!', holder: 'a', ttl: SECOND }))).toBe('invalid_lease')
    expect(await reason(leases.take({ name: 'tick', holder: 'has space', ttl: SECOND }))).toBe('invalid_lease')
    expect(await reason(leases.take({ name: 'tick', holder: 'a', ttl: 0 }))).toBe('invalid_lease')
  })

  it('of 20 processes taking a lapsed lease at once, exactly one becomes its holder', async () => {
    const dir = tempDir()
    // A holder that died: its lease lapsed at epoch 1.
    const seeded = file({ dir })
    await seeded.leases!.take({ name: 'tick', holder: 'ghost', ttl: 1 })
    seeded.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startAt = String(Date.now() + 4 * SECOND)
    const runs = await Promise.all(Array.from({ length: 20 }, (_, i) => fixture(['take', dir, `p${i}`, String(60 * SECOND), startAt])))
    expect(runs.map((run) => [run.code, run.stderr])).toEqual(Array(20).fill([0, '']))
    const answers = runs.map((run, i) => ({ who: `p${i}`, ...JSON.parse(run.stdout) }) as { who: string; held: boolean; holder?: string; epoch: number })
    const won = answers.filter((answer) => answer.held)
    expect(won).toHaveLength(1)
    expect(won[0]!.epoch).toBe(2)
    // Everyone else was told who won.
    for (const lost of answers.filter((answer) => !answer.held)) expect([lost.holder, lost.epoch]).toEqual([won[0]!.who, 2])
    const after = file({ dir })
    expect(await after.leases!.holder('tick')).toMatchObject({ holder: won[0]!.who, epoch: 2 })
    after.close()
  }, 30_000)

  it('while its holder renews it the lease is held; once the holder is killed, another process takes over', async () => {
    const dir = tempDir()
    const holder = spawn(process.execPath, [...NODE_ARGS, 'hold', dir, String(5 * SECOND), '200'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] })
    const first = await new Promise<{ holder: string; epoch: number }>((resolve) => {
      let out = ''
      holder.stdout.on('data', (chunk) => {
        out += chunk
        if (out.includes('\n')) resolve(JSON.parse(out))
      })
    })
    expect(first.epoch).toBe(1)
    const leases = file({ dir }).leases!
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const stop = new AbortController().signal
    // Alive, it renews while the other waits, so the other gives up quickly rather than waiting out the lease.
    const began = Date.now()
    expect(await holdLease(leases, 'tick', { ttl: 5 * SECOND, wait: 100, sleep, stop })).toBeNull()
    expect(Date.now() - began).toBeLessThan(5 * SECOND)
    holder.kill('SIGKILL')
    await new Promise((resolve) => holder.once('exit', resolve))
    // Dead, it renews no more: its lease lapses and the waiting process takes it, with a new epoch.
    const taken = await holdLease(leases, 'tick', { ttl: 5 * SECOND, wait: 100, sleep, stop })
    expect(taken).not.toBeNull()
    expect(taken!.epoch).toBe(2)
    expect(await leases.holder('tick')).toMatchObject({ holder: taken!.holder, epoch: 2 })
    await taken!.release()
  }, 30_000)

  it('a board in memory writes no files: the daemon ticks it from a folder it leaves empty', async () => {
    const cwd = tempDir()
    const home = tempDir()
    const run = await fixture(['daemon', cwd, home], { cwd, env: { HOME: home, MUSTER_CONFIG: join(home, 'config') } })
    expect([run.code, run.stderr]).toEqual([0, ''])
    expect(JSON.parse(run.stdout)).toEqual({ ended: 'stopped', during: [[], []] })
    expect([readdirSync(cwd), readdirSync(home)]).toEqual([[], []])
  })
})
