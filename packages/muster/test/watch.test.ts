import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { board, type Watch } from '../src/index.ts'
import { clock, tempDir } from './helpers.ts'

const HOST = fileURLToPath(new URL('./fixtures/host.ts', import.meta.url))

/** A board in memory with watchers, on a clock the test holds. */
function watched(watch: Record<string, Watch>) {
  const time = clock()
  const team = board({ memory: true, principal: 'local:user:ada', now: time.now, watch })
  return { team, time }
}

/** A watcher that notes what woke it. */
function noting(extra: Partial<Watch> = {}) {
  const seen: number[] = []
  const watch: Watch = { tail: { channel: 'work/' }, run: ({ event }) => void seen.push(event.seq), ...extra }
  return { seen, watch }
}

describe('watchers in code', () => {
  it('declaring them opens nothing and starts nothing: the board file is made only when used', async () => {
    const dir = tempDir()
    const team = board({ dir, watch: { lead: noting().watch } })
    expect(readdirSync(dir)).toEqual([])
    await team.deliver()
    expect(readdirSync(dir)).toEqual(['main.db', 'main.db-shm', 'main.db-wal'])
    team.close()
  })

  it('a bad watcher is refused by board(), by name, before anything runs', () => {
    const bad: [unknown, RegExp][] = [
      [{ 'Bad Name': noting().watch }, /isn't a watcher name/],
      [{ lead: { tail: { channel: 'work/' } } }, /Watcher "lead" needs "run"/],
      [{ lead: { tail: { channel: 'Work!' }, run: () => {} } }, /Watcher "lead" has a channel/],
      [{ lead: { tail: { chanel: 'work/' }, run: () => {} } }, /Watcher "lead" has "chanel" in its tail/],
      [{ lead: { tail: {}, run: () => {}, every: 30 } }, /Watcher "lead" has "every"/],
      [{ lead: { tail: { for: 'lead+' }, run: () => {} } }, /Watcher "lead" has a "for"/],
      [{ lead: { tail: {}, run: () => {}, as: 'Not A Profile' } }, /Watcher "lead" has an "as"/],
      [{ lead: { run: () => {} } }, /Watcher "lead" needs a "tail"/],
    ]
    for (const [watch, message] of bad) {
      let thrown: unknown
      try {
        board({ memory: true, watch: watch as Record<string, Watch> })
      } catch (error) {
        thrown = error
      }
      expect([(thrown as { reason?: string })?.reason, (thrown as Error)?.message]).toEqual(['invalid_watch', expect.stringMatching(message)])
    }
  })

  it('starts from now: what was on the board before a watcher first ran wakes nothing', async () => {
    const { seen, watch } = noting()
    const { team } = watched({ lead: watch })
    await team.post({ channel: 'work/api', text: 'old news' })
    expect(await team.deliver()).toEqual({ delivered: 0, failed: 0, held: [] })
    const fresh = await team.post({ channel: 'work/api', text: 'new' })
    expect(await team.deliver()).toEqual({ delivered: 1, failed: 0, held: [] })
    expect(seen).toEqual([fresh.id])
  })

  it('fires once for each event it matches, and only for those', async () => {
    const { seen, watch } = noting()
    const { team } = watched({ lead: watch })
    await team.deliver()
    const a = await team.post({ channel: 'work/api', text: 'a' })
    await team.post({ channel: 'elsewhere', text: 'not watched' })
    const b = await team.reply({ to: a.id, text: 'b' })
    await team.deliver()
    await team.deliver()
    expect(seen).toEqual([a.id, b.id])
  })

  it("its own profile's writes never wake it, but a message it scheduled does", async () => {
    const replied: number[] = []
    const { team, time } = watched({
      fixer: {
        tail: { channel: 'work/' },
        as: 'fixer',
        run: async ({ event, board: me }) => {
          replied.push(event.seq)
          if (event.type === 'message.posted' && event.message?.re === null) await me.reply({ to: event.seq, text: 'on it' })
        },
      },
    })
    await team.deliver()
    const root = await team.post({ channel: 'work/api', text: 'broken' })
    await team.deliver()
    await team.deliver()
    expect(replied).toEqual([root.id])
    expect((await team.readThread({ id: root.id })).replies.map((reply) => [reply.text, reply.by.profile])).toEqual([['on it', 'fixer']])
    await team.as('fixer').scheduleCreate({ thread: root.id, text: 'check back', at: new Date(time.now().getTime() + 1000).toISOString() })
    time.advance(1000)
    await team.scheduleTick()
    await team.deliver()
    expect(replied).toHaveLength(2)
  })

  it('start() runs the watchers until stopped, returns at once, and a second start() in the process is the same host', async () => {
    const dir = tempDir()
    const { seen, watch } = noting()
    const team = board({ dir, principal: 'local:user:ada', watch: { lead: watch } })
    await team.deliver()
    const host = team.start({ log: () => {} })
    // Another copy of the module, as Next.js loads for its routes: the same board, the same host.
    expect(board({ dir, principal: 'local:user:ada', watch: { lead: watch } }).start()).toBe(host)
    const posted = await team.post({ channel: 'work/api', text: 'wake' })
    await vi.waitFor(() => expect(seen).toEqual([posted.id]), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen).toEqual([posted.id])
    host.stop()
    await host.done
    // Stopped, it let go of its lease, and a new start() is a new host.
    expect(await team.backend.leases!.holder('watch:lead')).toBeNull()
    const again = team.start({ log: () => {} })
    expect(again).not.toBe(host)
    again.stop()
    await again.done
    team.close()
  })

  it('two boards in memory are two hosts: they share a path and nothing else', async () => {
    const a = watched({ lead: noting().watch }).team.start({ log: () => {} })
    const b = watched({ lead: noting().watch }).team.start({ log: () => {} })
    expect(a).not.toBe(b)
    a.stop()
    b.stop()
    await Promise.all([a.done, b.done])
  })

  it('stop() cuts the wait between looks short', async () => {
    const { team } = watched({ lead: noting().watch })
    const host = team.start({ log: () => {} })
    // Long enough for a quiet loop to be in its longest wait.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const began = Date.now()
    host.stop()
    await host.done
    expect(Date.now() - began).toBeLessThan(200)
  })

  it('two hosts on one board never both run a watcher: one delivers, the other takes over when it dies', async () => {
    const dir = tempDir()
    const marker = join(dir, 'woke')
    const team = board({ dir, principal: 'local:user:ada' })
    await team.post({ channel: 'general', text: 'board exists' })
    const hosts = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST, dir, marker, '1000', '200'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] })
      const exited = new Promise((resolve) => child.once('exit', resolve))
      return { child, exited }
    })
    onTestFinished(() => {
      for (const host of hosts) host.child.kill('SIGKILL')
    })
    const lines = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map((line) => line.split(' ').map(Number) as [number, number]) : [])
    // One of them holds the watcher and has put its place at the head.
    await vi.waitFor(async () => expect(await team.cursorGet('watch:w')).not.toBeNull(), { timeout: 10_000 })
    const first: number[] = []
    for (let i = 0; i < 10; i++) first.push((await team.post({ channel: 'work/api', text: `event ${i}` })).id)
    await vi.waitFor(() => expect(lines()).toHaveLength(10), { timeout: 10_000 })
    const holder = lines()[0]![0]
    expect(lines()).toEqual(first.map((seq) => [holder, seq]))
    const killed = hosts.find((host) => host.child.pid === holder)!
    const other = hosts.find((host) => host.child.pid !== holder)!
    killed.child.kill('SIGKILL')
    await killed.exited
    const second: number[] = []
    for (let i = 0; i < 5; i++) second.push((await team.post({ channel: 'work/api', text: `later ${i}` })).id)
    await vi.waitFor(() => expect(lines()).toHaveLength(15), { timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    // Each event once, in order: the first ten by the host that held it, the rest by the one that took over.
    expect(lines()).toEqual([...first.map((seq) => [holder, seq]), ...second.map((seq) => [other.child.pid, seq])])
    other.child.kill('SIGTERM')
    expect(await other.exited).toBe(0)
    team.close()
  }, 40_000)
})
