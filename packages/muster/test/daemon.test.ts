import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FAILING_PAUSE, runDaemon } from '../src/daemon/daemon.ts'
import { plist } from '../src/daemon/launchd.ts'
import { checkWrite, type Checkable } from '../src/daemon/check.ts'
import { EXAMPLES, PORTING_URL, RETIRED } from '../src/config/retired.ts'
import { DELIVERY_ATTEMPTS } from '../src/core/deliveries.ts'
import { RESTART_LIMIT, RESTART_WINDOW, STEADY_AFTER, STOPPED_FOR, begin, ended, guardPath, readGuard, reset, retryAt, steady } from '../src/daemon/guard.ts'
import { board, file, listen, mint } from '../src/index.ts'
import { BIN, cli, cliStart, clock, memoryBoard, reason, tempDir } from './helpers.ts'

const MIN = 60_000
const texts = async (team: ReturnType<typeof memoryBoard>['team'], channel: string) => (await team.readChannel({ channel, limit: 500 })).threads.map((thread) => thread.message.text)

describe('schedules', () => {
  it('a one-off sends once, as its creator, when it is due and not before', async () => {
    const { team, time } = memoryBoard()
    const schedule = await team.as('lead').scheduleCreate({ channel: 'work', text: 'check the PR', at: '2026-01-01T00:30:00.000Z' })
    expect(schedule).toMatchObject({ times: 1, next: '2026-01-01T00:30:00.000Z' })
    time.advance(29 * MIN)
    expect((await team.scheduleTick()).sent).toEqual([])
    time.advance(MIN)
    expect((await team.scheduleTick()).sent).toEqual([schedule.id])
    expect((await team.scheduleTick()).sent).toEqual([])
    const page = await team.readChannel({ channel: 'work' })
    expect(page.threads.map((thread) => [thread.message.text, thread.message.by.profile])).toEqual([['check the PR', 'lead']])
    expect((await team.scheduleList()).schedules).toEqual([])
  })

  it('a repeating schedule sends each period and stops after --times', async () => {
    const { team, time } = memoryBoard()
    const root = await team.post({ channel: 'work', text: 'PR #12' })
    await team.scheduleCreate({ thread: root.id, text: 'still open?', every: 600, times: 3 })
    for (let i = 0; i < 6; i++) {
      time.advance(10 * MIN)
      await team.scheduleTick()
    }
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['still open?', 'still open?', 'still open?'])
  })

  it('stops at --until', async () => {
    const { team, time } = memoryBoard()
    await team.scheduleCreate({ channel: 'work', text: 'tick', every: 600, until: '2026-01-01T00:25:00.000Z' })
    for (let i = 0; i < 6; i++) {
      time.advance(10 * MIN)
      await team.scheduleTick()
    }
    expect(await texts(team, 'work')).toEqual(['tick', 'tick'])
  })

  it('after downtime, one message stands for every slot missed, and the schedule carries on in step', async () => {
    const { team, time } = memoryBoard()
    await team.scheduleCreate({ channel: 'work', text: 'tick', every: 600 })
    time.advance(53 * MIN)
    expect((await team.scheduleTick()).sent).toHaveLength(1)
    expect(await texts(team, 'work')).toEqual(['tick'])
    expect((await team.scheduleList()).schedules[0]!.next).toBe('2026-01-01T01:00:00.000Z')
    time.advance(13 * MIN)
    expect(await team.scheduleTick()).toMatchObject({ sent: [], skipped: [expect.any(Number)] })
    expect((await team.scheduleList()).schedules[0]!.next).toBe('2026-01-01T01:10:00.000Z')
  })

  it('a slot later than its grace is skipped, not sent late', async () => {
    const { team, time } = memoryBoard()
    await team.scheduleCreate({ channel: 'work', text: 'standup now', at: '2026-01-01T00:10:00.000Z' })
    time.advance(3 * 60 * MIN)
    expect(await team.scheduleTick()).toMatchObject({ sent: [], skipped: [expect.any(Number)] })
    expect(await texts(team, 'work')).toEqual([])
    expect((await team.scheduleTick()).skipped).toEqual([])
  })

  it('at most five schedules catch up in one tick', async () => {
    const { team, time } = memoryBoard()
    for (let i = 0; i < 8; i++) await team.scheduleCreate({ channel: 'work', text: `job ${i}`, every: 600 })
    time.advance(10 * MIN)
    expect((await team.scheduleTick()).sent).toHaveLength(5)
    expect((await team.scheduleTick()).sent).toHaveLength(3)
  })

  it('a canceled schedule sends nothing, and only its owner cancels it', async () => {
    const ada = memoryBoard()
    const schedule = await ada.team.scheduleCreate({ channel: 'work', text: 'x', every: 600 })
    expect(await reason(ada.as('local:user:eve').scheduleCancel({ id: schedule.id }))).toBe('not_yours')
    await ada.team.scheduleCancel({ id: schedule.id })
    ada.time.advance(20 * MIN)
    expect((await ada.team.scheduleTick()).sent).toEqual([])
  })

  it('refuses a period under a minute, a time that is not one, and no target', async () => {
    const { team } = memoryBoard()
    expect(await reason(team.scheduleCreate({ channel: 'work', text: 'x', every: 59 }))).toBe('invalid_schedule')
    expect(await reason(team.scheduleCreate({ channel: 'work', text: 'x', at: 'tomorrowish' }))).toBe('invalid_schedule')
    expect(await reason(team.scheduleCreate({ text: 'x', every: 600 }))).toBe('invalid_schedule')
  })

  it('two tickers on one board file send each slot once', async () => {
    const dir = tempDir()
    const time = clock()
    const a = board({ dir, now: time.now, principal: 'local:user:ada' })
    const b = board({ dir, now: time.now, principal: 'local:user:ada' })
    await a.scheduleCreate({ channel: 'work', text: 'once', every: 600, times: 4 })
    for (let i = 0; i < 4; i++) {
      time.advance(10 * MIN)
      await Promise.all([a.scheduleTick(), b.scheduleTick(), a.scheduleTick()])
    }
    expect((await a.readChannel({ channel: 'work' })).threads).toHaveLength(4)
    a.close()
    b.close()
  })
})

describe('the daemon', () => {
  it('one process ticks per board: a second gets "held" while the holder renews, and takes over once it stops', async () => {
    const { team, time } = memoryBoard()
    const leases = team.backend.leases!
    const other = await leases.take({ name: 'tick', holder: 'other', ttl: 30_000 })
    // The other holder renews while this one waits: it is alive, and this one gives up at once.
    let looks = 0
    const renewing = async () => {
      looks += 1
      time.advance(1000)
      await leases.renew({ name: 'tick', holder: 'other', epoch: other.epoch, ttl: 30_000 })
    }
    expect(await runDaemon({ team, stop: new AbortController().signal, log: () => {}, sleep: renewing })).toBe('held')
    expect(looks).toBe(1)
    // Now it has stopped renewing (killed, say): the daemon waits out its lease, then ticks.
    const stop = new AbortController()
    let during: Awaited<ReturnType<typeof leases.holder>> = null
    const waiting = async (ms: number) => {
      time.advance(ms)
      during = await leases.holder('tick')
      if (during && during.holder !== 'other') stop.abort()
    }
    expect(await runDaemon({ team, stop: stop.signal, log: () => {}, sleep: waiting })).toBe('stopped')
    expect(during).toMatchObject({ epoch: other.epoch + 1, holder: expect.not.stringMatching(/^other$/) })
    // Stopped, it lets go, so the next one needn't wait.
    expect(await leases.holder('tick')).toBeNull()
  })

  it('a daemon that finds its lease taken over while it ran stops ticking and says so', async () => {
    const { team, time } = memoryBoard()
    const leases = team.backend.leases!
    const stop = new AbortController()
    const log: string[] = []
    let ticks = 0
    const sleep = async () => {
      ticks += 1
      if (ticks === 1) {
        // Asleep past its lease, and someone took it meanwhile: the next renewal finds it gone.
        time.advance(31_000)
        expect(await leases.take({ name: 'tick', holder: 'usurper', ttl: 30_000 })).toMatchObject({ held: true })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (ticks > 3) stop.abort()
    }
    expect(await runDaemon({ team, stop: stop.signal, log: (line) => log.push(line), sleep, lease: { every: 5 } })).toBe('held')
    expect([ticks, log]).toEqual([1, ['lost      the tick lease: another process ticks for this board now']])
    // What it lost stays the other's.
    expect(await leases.holder('tick')).toMatchObject({ holder: 'usurper' })
  })

  it('tells a live ticker from a dead one without ps: a second daemon on a machine with no ps finds the first ticking', async () => {
    const dir = tempDir()
    // A PATH with nothing on it: no ps, as in a slim container image. Node is started by its full path.
    const bare = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'], { PATH: bare })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const second = await cli(dir, ['daemon', 'run'], { env: { PATH: bare } })
    daemon.child.kill('SIGTERM')
    expect((await daemon.done).code).toBe(0)
    expect([second.code, second.stdout]).toEqual([0, expect.stringMatching(/another process already ticks for this board/)])
  }, 40_000)

  it('stopped while it waits for the lease, it stops: it never says another process ticks', async () => {
    const { team } = memoryBoard()
    await team.backend.leases!.take({ name: 'tick', holder: 'other', ttl: 30_000 })
    const stop = new AbortController()
    const sleep = async () => stop.abort()
    expect(await runDaemon({ team, stop: stop.signal, log: () => {}, sleep })).toBe('stopped')
  })

  it('mu daemon run on a board at a URL says the server ticks it and exits 0, so a service manager leaves it stopped', async () => {
    const dir = tempDir()
    const key = Buffer.alloc(32, 7)
    const server = await listen({ backend: file({ dir: join(dir, 'served') }), key })
    try {
      const token = mint(key, { sub: 'local:user:ada', profile: null, exp: Math.floor(Date.now() / 1000) + 3600 })
      const run = await cli(dir, ['daemon', 'run'], { env: { MUSTER_URL: server.url, MUSTER_TOKEN: token } })
      expect(run.code).toBe(0)
      expect(run.stderr).toMatch(/^error: The board at .* is ticked by the server it is on\.\n/)
    } finally {
      await server.close()
    }
  })

  it('mu daemon run sends a due schedule with no board module, and stops cleanly on SIGTERM', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    for (let i = 0; i < 100 && !daemon.output().includes('board '); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    await cli(dir, ['schedule', 'general', 'due now', '--in', '1s'])
    const sent = async () => (JSON.parse((await cli(dir, ['read', 'general', '--json'])).stdout).threads as { message: { text: string } }[]).map((thread) => thread.message.text)
    for (let i = 0; i < 100 && !(await sent()).includes('due now'); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const second = await cli(dir, ['daemon', 'run'])
    expect(second.stdout).toMatch(/another process already ticks for this board/)
    daemon.child.kill('SIGTERM')
    const ended = await daemon.done
    expect([ended.code, ended.stdout]).toEqual([0, expect.not.stringContaining('watching')])
    expect(await sent()).toContain('due now')
    // Stopped cleanly, it let go of the ticker: the next daemon needn't wait out its lease.
    const after = file({ dir: join(dir, 'board') })
    expect(await after.leases!.holder('tick')).toBeNull()
    after.close()
  }, 40_000)

  it.each(RETIRED)('a %s left from before board modules makes mu daemon run and mu serve refuse, with the module that does what it did', async (name) => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    const left = join(dir, 'config', name)
    writeFileSync(left, '{}')
    const said = `error: ${left} is no longer read: watchers, sync and outgoing webhooks are declared in a board module now.`
    // The daemon says so and exits 0, so a service manager leaves it stopped rather than restarting it into the same answer.
    const run = await cli(dir, ['daemon', 'run'])
    expect([run.code, run.stdout]).toEqual([0, ''])
    expect(run.stderr).toContain(said)
    expect(run.stderr).toContain(`  For ${name}, a board module like this:`)
    expect(run.stderr).toContain(PORTING_URL)
    expect(run.stderr).toContain('The daemon has stopped.')
    // Every line of the example is there, indented, to copy.
    for (const line of EXAMPLES[name].trimEnd().split('\n').filter(Boolean)) expect(run.stderr).toContain(`      ${line}\n`)
    // The server refuses before it listens, with a module or without one.
    const served = await cli(dir, ['serve', '--port', '0', '--json'])
    expect([served.code, served.stdout]).toEqual([1, ''])
    expect(JSON.parse(served.stderr).error).toMatchObject({ reason: 'config_retired', data: { files: [left], porting: PORTING_URL } })
    writeFileSync(join(dir, 'board.ts'), "import { board } from '@openmuster/muster'\nexport default board()\n")
    expect((await cli(dir, ['serve', '--port', '0', '--module', join(dir, 'board.ts')])).stderr).toContain(said)
    // Status still answers, and says what is wrong.
    const status = await cli(dir, ['daemon', 'status', '--json'])
    expect([status.code, JSON.parse(status.stdout).retired]).toEqual([0, [left]])
    expect((await cli(dir, ['daemon', 'status'])).stdout).toContain(`warning   ${left} is no longer read: mu daemon run and mu serve refuse to start`)
    // The example loads as printed.
    const ported = tempDir()
    writeFileSync(join(ported, 'board.ts'), EXAMPLES[name])
    const loaded = JSON.parse((await cli(ported, ['daemon', 'status', '--json', '--module', join(ported, 'board.ts')])).stdout) as { module: { error?: unknown; watchers: unknown[]; sync: unknown[]; hooks?: unknown[] } }
    expect(loaded.module.error).toBeUndefined()
    expect([loaded.module.watchers.length, loaded.module.sync.length, loaded.module.hooks?.length ?? 0]).toEqual([name === 'watchers.json' ? 1 : 0, name === 'sync.json' ? 1 : 0, name === 'hooks.json' ? 1 : 0])
  }, 30_000)

  it('the porting page shows the same modules the refusal prints, under each file', () => {
    const page = readFileSync(new URL('../docs/04-reference/07-porting.md', import.meta.url), 'utf8')
    for (const name of RETIRED) {
      const section = page.split(`## ${name}\n`)[1]?.split('\n## ')[0] ?? ''
      expect(/```ts board\.ts\n([\s\S]*?)```/.exec(section)?.[1]).toBe(EXAMPLES[name])
    }
    expect(PORTING_URL).toBe('https://openmuster.ai/docs/reference/porting')
  })

  it('names every retired file left, in one refusal', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    for (const name of RETIRED) writeFileSync(join(dir, 'config', name), '{}')
    const run = await cli(dir, ['daemon', 'run'])
    expect(run.code).toBe(0)
    expect(run.stderr).toContain(`error: ${RETIRED.map((name) => join(dir, 'config', name)).join(', ')} are no longer read`)
    for (const name of RETIRED) expect(run.stderr).toContain(`For ${name}, a board module like this:`)
  })

  it('the LaunchAgent restarts after a crash but not after a clean exit, and throttles restarts', () => {
    const text = plist({ board: 'main', program: ['/usr/local/bin/node', '/opt/muster/cli.js', 'daemon', 'run'], dir: '/Users/ada/.muster', log: '/Users/ada/.config/muster/logs/daemon-main.log' })
    expect(text).toContain('<string>dev.muster.daemon.main</string>')
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
    expect(text).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/)
    expect(text).toMatch(/<key>MUSTER_DIR<\/key>\s*<string>\/Users\/ada\/.muster<\/string>/)
    expect(text).toMatch(/<string>daemon<\/string>\s*<string>run<\/string>/)
    expect(plist({ board: 'a', program: ['x&y<z>'], log: 'l' })).toContain('<string>x&amp;y&lt;z&gt;</string>')
  })

  it('install writes the plist and loads it; uninstall unloads and removes it (launchctl faked)', async () => {
    const dir = tempDir()
    const calls = join(dir, 'launchctl.calls')
    const fake = join(dir, 'launchctl')
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${calls}\ncase "$1" in bootout) [ -f ${dir}/loaded ] || exit 3; rm -f ${dir}/loaded;; bootstrap) touch ${dir}/loaded;; esac\n`)
    chmodSync(fake, 0o755)
    const env = { MUSTER_LAUNCHCTL: fake }
    const installed = await cli(dir, ['daemon', 'install'], { env })
    expect(installed.code).toBe(0)
    const path = join(dir, 'Library', 'LaunchAgents', 'dev.muster.daemon.main.plist')
    expect(installed.stdout).toContain(`installed  ${path}`)
    expect(readFileSync(path, 'utf8')).toContain('<string>run</string>')
    expect((await cli(dir, ['daemon', 'uninstall'], { env })).stdout).toBe(`removed  ${path}\n`)
    expect(existsSync(path)).toBe(false)
    expect((await cli(dir, ['daemon', 'uninstall'], { env })).stdout).toBe('not installed\n')
    const seen = readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.split(' ')[0])
    expect(seen).toEqual(['bootout', 'bootstrap', 'bootout', 'bootout'])
  })
})

describe('the restart guard', () => {
  const path = () => join(tempDir(), 'daemon', 'main.json')
  /** Where `mu daemon` keeps the record for the test's own board. */
  const recordOf = (dir: string, name = 'main') => join(dir, 'config', 'daemon', basename(guardPath(name, join(dir, 'board', `${name}.db`))))

  it(`stops the daemon on the ${RESTART_LIMIT}th start within ${RESTART_WINDOW / MIN} minutes, until an hour has passed or it is reset`, () => {
    const at = path()
    let now = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 1; i < RESTART_LIMIT; i++) {
      expect(begin(at, now)).toBeNull()
      now += 30_000
    }
    const parked = begin(at, now)
    expect(parked).toMatchObject({ at: '2026-01-01T00:02:00.000Z', why: expect.stringMatching(/started 5 times in 10 minutes .* stopped restarting/) })
    expect(retryAt(parked!)).toBe('2026-01-01T01:02:00.000Z')
    expect(readGuard(at).parked).toEqual(parked)
    // Stopped is stopped for an hour...
    expect(begin(at, now + STOPPED_FOR - 1)).toEqual(parked)
    // ...and then a start is let through, and counts as the first.
    expect(begin(at, now + STOPPED_FOR)).toBeNull()
    expect(readGuard(at)).toEqual({ starts: [now + STOPPED_FOR] })
    for (let i = 1; i < RESTART_LIMIT - 1; i++) expect(begin(at, now + STOPPED_FOR + i)).toBeNull()
    expect(begin(at, now + STOPPED_FOR + RESTART_LIMIT)).not.toBeNull()
    expect(reset(at)).not.toBeNull()
    expect(begin(at, now + STOPPED_FOR + RESTART_LIMIT + 1)).toBeNull()
  })

  it('counts only the starts within the window', () => {
    const at = path()
    let now = 0
    for (let i = 0; i < 20; i++) {
      expect(begin(at, now)).toBeNull()
      now += RESTART_WINDOW / (RESTART_LIMIT - 1)
    }
  })

  it("doesn't count a start that ended cleanly, nor one that stayed up", () => {
    const at = path()
    let now = 0
    for (let i = 0; i < 10; i++) {
      expect(begin(at, now)).toBeNull()
      ended(at, now)
      now += 1000
    }
    expect(readGuard(at).starts).toEqual([])
    for (let i = 1; i < RESTART_LIMIT; i++) expect(begin(at, now++)).toBeNull()
    steady(at)
    for (let i = 1; i < RESTART_LIMIT; i++) expect(begin(at, now++)).toBeNull()
    expect(begin(at, now++)).not.toBeNull()
  })

  it("a clean exit takes off its own start only, never the running daemon's", () => {
    const at = path()
    expect(begin(at, 1)).toBeNull()
    expect(begin(at, 2)).toBeNull()
    ended(at, 2)
    expect(readGuard(at).starts).toEqual([1])
  })

  it('is kept per board: by name and by where it is, and written whole, leaving nothing beside it', () => {
    expect(guardPath('main', '/a/main.db')).not.toBe(guardPath('main', '/b/main.db'))
    expect(guardPath('main', '/a/main.db')).not.toBe(guardPath('work', '/a/main.db'))
    expect(basename(guardPath('main', 'https://board.example'))).toMatch(/^main-[0-9a-f]{16}\.json$/)
    const at = path()
    for (let i = 0; i < 3; i++) begin(at, i)
    expect(readdirSync(dirname(at))).toEqual([basename(at)])
    // A record that can't be read is no record: it never stops a daemon from starting.
    writeFileSync(at, '{"starts": [1, 2')
    expect(begin(at, 3)).toBeNull()
  })

  /** A daemon whose sleep is the test's: each pause is noted and returns at once, and it stops after `ticks`. */
  function driven(ticks: number, extra: Partial<Parameters<typeof runDaemon>[0]> = {}) {
    const stop = new AbortController()
    const pauses: number[] = []
    const log: string[] = []
    const run = (team: ReturnType<typeof memoryBoard>['team'], now: () => number) =>
      runDaemon({
        team,
        stop: stop.signal,
        log: (line) => log.push(line),
        deps: { now },
        sleep: async (ms) => {
          pauses.push(ms)
          if (pauses.length >= ticks) stop.abort()
        },
        ...extra,
      })
    return { run, pauses, log }
  }

  it('the daemon calls steady once, after a tick that worked, when it has been up long enough', async () => {
    const { team, time } = memoryBoard()
    let steadied = 0
    const { run, pauses, log } = driven(6, {
      steady: { after: STEADY_AFTER, then: () => (steadied += 1) },
    })
    // A minute a tick: the third tick is the first two minutes in.
    const ticking = { ...team, scheduleTick: () => (time.advance(MIN), team.scheduleTick()) } as typeof team
    await run(ticking, () => time.now().getTime())
    expect([steadied, log, pauses]).toEqual([1, [], [1000, 1000, 1000, 1000, 1000, 1000]])
  })

  it("doesn't call steady before it has been up long enough", async () => {
    const { team, time } = memoryBoard()
    let steadied = 0
    const { run } = driven(10, { steady: { after: STEADY_AFTER, then: () => (steadied += 1) } })
    await run(team, () => time.now().getTime())
    expect(steadied).toBe(0)
  })

  it('a tick that keeps failing is logged once and then at 2, 4, 8 in a row, with a longer pause, and never counts as steady', async () => {
    const { team } = memoryBoard()
    let steadied = 0
    const broken = { ...team, scheduleTick: async () => { throw new Error("The board at x can't be read: file is not a database.") } } as typeof team
    const { run, pauses, log } = driven(10, { steady: { after: 0, then: () => (steadied += 1) } })
    await run(broken, () => 0)
    const said = "error     The board at x can't be read: file is not a database."
    expect(log).toEqual([said, `${said}  (2 ticks in a row)`, `${said}  (4 ticks in a row)`, `${said}  (8 ticks in a row)`])
    expect(pauses).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000])
    expect(Math.max(...pauses)).toBe(FAILING_PAUSE)
    expect(steadied).toBe(0)
  })

  /** A board folder that is a file: the daemon can't open it, and exits 1 before it ticks, every time. */
  const crashing = () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'board'), 'not a folder')
    const calls = join(dir, 'launchctl.calls')
    const fake = join(dir, 'launchctl')
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${calls}\n[ "$1" = print ] && [ ! -f ${dir}/loaded ] && exit 113\nexit 0\n`)
    chmodSync(fake, 0o755)
    return { dir, calls, env: { MUSTER_LAUNCHCTL: fake } }
  }
  /** Seeds the record as if the daemon had just crashed its way to a stop, `ago` milliseconds back. */
  const stoppedAgo = (record: string, ago: number) => {
    const now = Date.now() - ago
    for (let i = 0; i < RESTART_LIMIT; i++) begin(record, now + i)
  }
  const until = async (seen: () => boolean) => {
    for (let wait = 0; wait < 300 && !seen(); wait++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen()).toBe(true)
  }

  it('end to end: a daemon that crashes on start stops restarting, says so in status, and reset clears it', async () => {
    const { dir, calls, env } = crashing()
    const record = recordOf(dir)
    expect((await cli(dir, ['daemon', 'run'], { env })).code).toBe(1)
    expect((await cli(dir, ['daemon', 'run'], { env })).code).toBe(1)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^restarts {2}2 quick starts in 10 minutes; it stops at 5$/m)
    stoppedAgo(record, 0)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^stopped {3}since \S+: The daemon started 5 times .* It tries again at \S+, or now with mu daemon reset\.$/m)
    expect(JSON.parse((await cli(dir, ['daemon', 'status', '--json'], { env })).stdout).parked).toMatchObject({ why: expect.stringContaining('stopped restarting'), retry: expect.any(String) })
    // Not installed: reset clears it and says how to start it by hand.
    expect((await cli(dir, ['daemon', 'reset'], { env })).stdout).toMatch(/^reset {5}stopped since \S+\nnot installed: start it with mu daemon run\n$/)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^restarts {2}0 quick starts/m)
    // Installed: reset starts the service again.
    writeFileSync(join(dir, 'loaded'), '')
    expect((await cli(dir, ['daemon', 'reset'], { env })).stdout).toBe('reset     it had not stopped\nstarted   dev.muster.daemon.main\n')
    expect(readFileSync(calls, 'utf8')).toMatch(/^kickstart gui\/\d+\/dev\.muster\.daemon\.main$/m)
  }, 60_000)

  it('stopped, it stays up doing nothing, without opening the board, and starts once it is reset', async () => {
    const { dir, env } = crashing()
    stoppedAgo(recordOf(dir), 0)
    const daemon = cliStart(dir, ['daemon', 'run'], env)
    let stderr = ''
    daemon.child.stderr!.on('data', (chunk) => (stderr += chunk))
    await until(() => /It tries again at \S+\. Fix it, then, to try now: mu daemon reset/.test(stderr))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect([daemon.child.exitCode, stderr]).toEqual([null, expect.not.stringMatching(/EEXIST|ENOTDIR|trying again/)])
    await cli(dir, ['daemon', 'reset'], { env })
    // Reset, it tries: this board still can't be opened, so this start crashes, and counts.
    const ended = await daemon.done
    expect(ended.code).toBe(1)
    expect(stderr).toMatch(/trying again\n/)
    expect(readGuard(recordOf(dir)).starts).toHaveLength(1)
  }, 60_000)

  it('an hour after it stopped, a start is let through and counts as the first', async () => {
    const { dir, env } = crashing()
    stoppedAgo(recordOf(dir), STOPPED_FOR + MIN)
    expect((await cli(dir, ['daemon', 'run'], { env })).code).toBe(1)
    expect(readGuard(recordOf(dir))).toEqual({ starts: [expect.any(Number)] })
  }, 60_000)

  it('a board at a URL that is out of reach is waited for, not counted as a crash', async () => {
    const dir = tempDir()
    // A port nothing listens on: a server taken and closed again.
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        server.close(() => resolve(port))
      })
    })
    const url = `http://127.0.0.1:${port}`
    const daemon = cliStart(dir, ['daemon', 'run'], { MUSTER_URL: url, MUSTER_TOKEN: 'mu1.x' })
    let stderr = ''
    daemon.child.stderr!.on('data', (chunk) => (stderr += chunk))
    await until(() => /\(2 tries in a row\)/.test(stderr))
    expect(stderr).toMatch(/^error {5}Couldn't reach the board at .* Trying again\.\n/)
    expect(daemon.child.exitCode).toBeNull()
    daemon.child.kill('SIGTERM')
    expect((await daemon.done).code).toBe(0)
    expect(readGuard(join(dir, 'config', 'daemon', basename(guardPath('main', url))))).toEqual({ starts: [] })
  }, 60_000)

  it('is kept for the board --board names, in run, status, check and reset alike', async () => {
    const { dir, env } = crashing()
    expect((await cli(dir, ['daemon', 'run', '--board', 'other'], { env })).code).toBe(1)
    expect(readGuard(recordOf(dir, 'other')).starts).toHaveLength(1)
    expect(existsSync(recordOf(dir))).toBe(false)
    expect((await cli(dir, ['daemon', 'status', '--board', 'other'], { env })).stdout).toMatch(/^restarts {2}1 quick starts/m)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^restarts {2}0 quick starts/m)
    stoppedAgo(recordOf(dir, 'other'), 0)
    expect((await cli(dir, ['daemon', 'reset', '--board', 'other'], { env })).stdout).toMatch(/^reset {5}stopped since/)
  }, 60_000)

  it('check says the daemon stopped restarting, not only that nothing ticks', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'board.ts'), "import { board } from '@openmuster/muster'\nexport default board({ watch: { lead: { tail: { channel: 'work' }, run: () => {} } } })\n")
    await cli(dir, ['post', 'general', 'board exists'])
    stoppedAgo(recordOf(dir), 0)
    const run = await cli(dir, ['daemon', 'check', 'lead', '--json', '--module', join(dir, 'board.ts')])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'daemon_stopped', next: ['mu daemon reset'] })
  }, 60_000)

  it('a daemon stopped and started cleanly is never counted', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    for (let i = 0; i < 2; i++) {
      const daemon = cliStart(dir, ['daemon', 'run'])
      // Stopped once it is up and ticking, as launchd stops it at logout.
      await until(() => /^board /m.test(daemon.output()))
      daemon.child.kill('SIGTERM')
      expect((await daemon.done).code).toBe(0)
    }
    expect(readGuard(recordOf(dir))).toEqual({ starts: [] })
  }, 60_000)

  it('installing again clears it', async () => {
    const { dir, env } = crashing()
    stoppedAgo(recordOf(dir), 0)
    expect((await cli(dir, ['daemon', 'install'], { env })).code).toBe(0)
    expect(existsSync(recordOf(dir))).toBe(false)
  }, 60_000)
})

describe('checking a watcher', () => {
  const watcher = (tail: Checkable['tail'], extra: Partial<Checkable> = {}): Checkable => ({ name: 'lead', tail, ...extra })

  it('writes what the filter matches: its channel, its labels, a mention, its words', () => {
    expect(checkWrite(watcher({ channel: 'work', labels: ['kind=bug|feature', 'urgent'], mentions: 'local:user:ada+lead', text: 'ping' }))).toEqual({
      kind: 'post',
      channel: 'work',
      text: 'Watcher check for "lead". If a watcher woke you for this, reply in this thread with anything. @lead ping',
      labels: { kind: 'bug', urgent: 'check' },
    })
    expect(checkWrite(watcher({ re: 12, by: 'ci' }))).toMatchObject({ kind: 'reply', to: 12, as: 'ci' })
    expect(checkWrite(watcher({ channel: 'work/', types: ['message.'] }), { in: 'work/checks' })).toMatchObject({ kind: 'post', channel: 'work/checks' })
    // Leaving a kind out still lets a message through; keeping only a kind lets nothing but blocks through.
    expect(checkWrite(watcher({ channel: 'work', kinds: ['!backlog'] }))).toMatchObject({ kind: 'post', channel: 'work' })
    expect(() => checkWrite(watcher({ channel: 'work', kinds: ['needs_input'] }))).toThrow(/held as needs_input/)
  })

  it('writes a message a watcher for a profile matches, on a board where that profile never wrote', async () => {
    const { team } = memoryBoard()
    const forLead = watcher({ channel: 'work', for: 'lead' }, { as: 'lead' })
    const write = checkWrite(forLead, { principal: 'local:user:ada' })
    expect(write).toMatchObject({ kind: 'post', channel: 'work', text: expect.stringContaining('@[local:user:ada+lead]') })
    // A whole actor ID is mentioned as it is.
    expect(checkWrite(watcher({ channel: 'work', for: 'local:user:bob+lead' }), { principal: 'local:user:ada' }).text).toContain('@[local:user:bob+lead]')
    if (write.kind !== 'post') throw new Error('expected a post')
    const head = await team.head()
    await team.post({ channel: write.channel, text: write.text, labels: write.labels })
    const got = await team.as('lead').events({ after: head, filter: forLead.tail })
    expect(got.events.map((event) => event.for)).toEqual(['mention'])
  })

  it("refuses what a message can't trigger, and asks where to write for a subtree", async () => {
    expect(await reason(Promise.resolve().then(() => checkWrite(watcher({ channel: 'work', types: ['task.completed'] }))))).toBe('watcher_not_checkable')
    expect(await reason(Promise.resolve().then(() => checkWrite(watcher({ channel: 'work', by: 'lead' }, { as: 'lead' }))))).toBe('watcher_not_checkable')
    expect(await reason(Promise.resolve().then(() => checkWrite(watcher({ channel: 'work', by: 'gh:user:octo' }))))).toBe('watcher_not_checkable')
    expect(await reason(Promise.resolve().then(() => checkWrite(watcher({ channel: 'work/' }), { in: 'ops' })))).toBe('watcher_not_checkable')
    expect(await reason(Promise.resolve().then(() => checkWrite(watcher({ channel: 'work/' }))))).toBe('missing_channel')
  })

  /** A folder with a board module that declares one watcher, `lead`, as `lead`, which runs `run` with each thread's ID. */
  const setUp = (run: string, tail: Checkable['tail'] = { channel: 'work' }) => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    const module = join(dir, 'board.ts')
    writeFileSync(module, `import { board, command } from '@openmuster/muster'
export default board({
  watch: {
    lead: { tail: ${JSON.stringify(tail)}, as: 'lead', run: command(({ event }) => ${run}) },
  },
})
`)
    return { dir, module }
  }
  const REPLY = `[${JSON.stringify(process.execPath)}, ${JSON.stringify(BIN)}, 'reply', String(event.thread), 'here']`
  /** Starts the module's daemon and waits until it runs the watcher. */
  const running = async (dir: string, module: string) => {
    const daemon = cliStart(dir, ['daemon', 'run', '--module', module])
    const holder = async () => {
      const board = file({ dir: join(dir, 'board') })
      try {
        return await board.leases!.holder('watch:lead')
      } finally {
        board.close()
      }
    }
    for (let i = 0; i < 200 && !(await holder()); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    return daemon
  }

  it('says nothing runs the watcher when no host holds it, before writing anything, and takes nothing to look', async () => {
    const { dir, module } = setUp("['true']")
    await cli(dir, ['post', 'general', 'board exists'])
    const run = await cli(dir, ['daemon', 'check', 'lead', '--json', '--module', module])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error.reason).toBe('watcher_not_running')
    expect(JSON.parse((await cli(dir, ['read', 'work', '--json'])).stdout).threads).toEqual([])
    // It looked, and took nothing: the first host to come gets the lease's first epoch.
    expect(await file({ dir: join(dir, 'board') }).leases!.take({ name: 'watch:lead', holder: 'next', ttl: 1000 })).toMatchObject({ held: true, epoch: 1 })
  })

  it('says which names there are to check: a module declares none by that name, or there is no module', async () => {
    const { dir, module } = setUp("['true']")
    const unknown = await cli(dir, ['daemon', 'check', 'nobody', '--json', '--module', module])
    expect([unknown.code, JSON.parse(unknown.stderr).error.reason, JSON.parse(unknown.stderr).error.message]).toEqual([2, 'unknown_watcher', `${module} declares no watcher or outgoing webhook named "nobody".`])
    const none = await cli(dir, ['daemon', 'check', 'lead', '--json'])
    expect([none.code, JSON.parse(none.stderr).error.reason]).toEqual([2, 'unknown_watcher'])
  })

  it('checks a watcher for a profile end to end, on a board where that profile never wrote', async () => {
    const { dir, module } = setUp(REPLY, { channel: 'work', for: 'lead' })
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = await running(dir, module)
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '15s', '--module', module])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect([run.code, run.stderr]).toEqual([0, ''])
    expect(run.stdout).toMatch(/^answered {2}#2 {2}by .*lead.* {2}in \d+s?/)
  }, 30_000)

  it('says the wake failed when the run keeps failing, rather than taking the note for an answer', async () => {
    const { dir, module } = setUp("['false']")
    await cli(dir, ['post', 'general', 'board exists'])
    // The host is this process, on a clock it moves: five tries are minutes apart, and this one takes them at once.
    const time = clock(new Date().toISOString())
    const tried: number[] = []
    const host = board({ dir: join(dir, 'board'), principal: 'local:user:ada', now: time.now, watch: { lead: { tail: { channel: 'work' }, as: 'lead', run: ({ event }) => {
      tried.push(event.seq)
      throw new Error('exit 1')
    } } } })
    await host.deliver()
    // Held, so the check sees a host running the watcher; let go once it has written, so the passes below take it.
    const held = await host.backend.leases!.take({ name: 'watch:lead', holder: 'test-host', ttl: 600_000 })
    const checking = cliStart(dir, ['daemon', 'check', 'lead', '--timeout', '30s', '--json', '--module', module])
    let thread: number | undefined
    for (let i = 0; i < 200 && thread === undefined; i++) {
      thread = (await host.readChannel({ channel: 'work' })).threads[0]?.message.id
      if (thread === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await host.backend.leases!.release({ name: 'watch:lead', holder: 'test-host', epoch: held.held ? held.epoch : 0 })
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) {
      await host.deliver()
      time.advance(10 * 60_000)
    }
    const run = await checking.done
    host.close()
    expect(tried).toEqual(Array(DELIVERY_ATTEMPTS).fill(thread))
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'wake_failed', data: { thread } })
  }, 40_000)

  it('times out with the thread to read when the run wakes nothing that answers', async () => {
    const { dir, module } = setUp("['true']")
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = await running(dir, module)
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '3s', '--json', '--module', module])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'timeout', data: { thread: 2 } })
  }, 30_000)
})
