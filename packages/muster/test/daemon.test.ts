import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadWatchers, runDaemon, tickOnce } from '../src/daemon/daemon.ts'
import { plist } from '../src/daemon/launchd.ts'
import { takeLock } from '../src/daemon/lock.ts'
import { checkWrite } from '../src/daemon/check.ts'
import { DELIVERY_ATTEMPTS, SLOWEST, gateSaysNo, type Deps, type Watcher, type WatchState } from '../src/daemon/watchers.ts'
import { RESTART_LIMIT, RESTART_WINDOW, STEADY_AFTER, begin, ended, readGuard, reset, steady } from '../src/daemon/guard.ts'
import { board } from '../src/index.ts'
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

function harness(watcher: Partial<Watcher> & { run?: string[] }, exits: (command: string[]) => { code: number; stdout?: string } = () => ({ code: 0 })) {
  const made = memoryBoard()
  const ran: { command: string[]; env: Record<string, string> }[] = []
  const deps: Deps = {
    now: () => made.time.now().getTime(),
    spawn: async (command, env) => {
      ran.push({ command, env })
      const exit = exits(command)
      return { code: exit.code, stdout: exit.stdout ?? '' }
    },
  }
  const watchers: Watcher[] = [{ name: 'lead', tail: { channel: 'work/' }, run: ['wake', '{thread}'], every: 30, ...watcher }]
  const states = new Map<string, WatchState>()
  const tick = async () => {
    made.time.advance(31_000)
    return (await tickOnce(made.team, watchers, states, deps)).watched.lead!
  }
  return { ...made, ran, tick }
}

describe('routing by label, with the watchers the factory guide gives', () => {
  // The guide's own watchers.json, so what it tells a reader to write is what is run here.
  const guide = readFileSync(new URL('../docs/03-guides/03-factory.md', import.meta.url), 'utf8')
  const documented = JSON.parse([...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((block) => block[1]!).find((block) => block.includes('"router"'))!) as { watchers: Watcher[] }

  /** The agents and gates the guide describes, played by the test: the router labels, a product's agent replies. */
  function routed(pick: (text: string) => string, watchers: Watcher[] = documented.watchers) {
    const made = memoryBoard()
    const { team, time } = made
    const woke: string[] = []
    const product = async (thread: string) => (await team.readThread({ id: Number(thread) })).message.labels.product
    const deps: Deps = {
      now: () => time.now().getTime(),
      spawn: async (command, env) => {
        const script = command[0]!.split('/').at(-1)!
        const thread = env.MUSTER_THREAD!
        if (script === 'unlabelled.sh') return { code: 0, stdout: (await product(thread)) === undefined ? '' : '{"wake": false}' }
        if (script === 'has-product.sh') return { code: 0, stdout: (await product(thread)) === command[1] ? '' : '{"wake": false}' }
        woke.push(`${env.MUSTER_PROFILE}:${thread}`)
        if (script === 'route.sh') {
          const root = (await team.readThread({ id: Number(thread) })).message
          await team.as(env.MUSTER_PROFILE!).label({ id: root.id, set: { product: pick(root.text) } })
        } else await team.as(env.MUSTER_PROFILE!).reply({ to: Number(thread), text: `answer from ${command[2]}` })
        return { code: 0, stdout: '' }
      },
    }
    const states = new Map<string, WatchState>()
    const tick = async () => {
      time.advance(31_000)
      await tickOnce(team, watchers, states, deps)
    }
    const replies = async (id: number) => (await team.readThread({ id })).replies.map((reply) => reply.text)
    return { ...made, woke, tick, replies }
  }
  const settle = async (tick: () => Promise<void>) => {
    for (let i = 0; i < 4; i++) await tick()
  }

  it('the router labels a question, and only that product answers, once', async () => {
    const { team, woke, tick, replies } = routed((text) => (text.includes('card') ? 'billing' : 'api'))
    await tick()
    const card = await team.as('ada').post({ channel: 'help', text: 'how do I change my card?' })
    const key = await team.as('ada').post({ channel: 'help', text: 'my key is refused' })
    await settle(tick)
    expect(await replies(card.id)).toEqual(['answer from billing'])
    expect(await replies(key.id)).toEqual(['answer from api'])
    expect(woke).toEqual([`router:${card.id}`, `router:${key.id}`, `billing-bot:${card.id}`, `api-bot:${key.id}`])
  })

  it('a follow-up wakes the product again and not the router', async () => {
    const { team, woke, tick, replies } = routed(() => 'billing')
    await tick()
    const card = await team.as('ada').post({ channel: 'help', text: 'how do I change my card?' })
    await settle(tick)
    woke.length = 0
    await team.as('ada').reply({ to: card.id, text: 'and the invoice address?' })
    await settle(tick)
    expect(woke).toEqual([`billing-bot:${card.id}`])
    expect(await replies(card.id)).toEqual(['answer from billing', 'and the invoice address?', 'answer from billing'])
  })

  it('product=none wakes nobody and the router is not asked again', async () => {
    const { team, woke, tick, replies } = routed(() => 'none')
    await tick()
    const lunch = await team.as('ada').post({ channel: 'help', text: 'lunch?' })
    await settle(tick)
    await team.as('ada').reply({ to: lunch.id, text: 'anyone?' })
    await settle(tick)
    expect(woke).toEqual([`router:${lunch.id}`])
    expect(await replies(lunch.id)).toEqual(['anyone?'])
  })

  it('a label corrected by hand wakes the new product and leaves the old one asleep', async () => {
    const { team, woke, tick } = routed(() => 'billing')
    await tick()
    const key = await team.as('ada').post({ channel: 'help', text: 'my key is refused' })
    await settle(tick)
    woke.length = 0
    await team.as('ada').label({ id: key.id, set: { product: 'api' } })
    await settle(tick)
    expect(woke).toEqual([`api-bot:${key.id}`])
  })

  it("a product's agent that writes as the router can miss the router's label, where its own profile never does", async () => {
    // Router last: the label lands after the product's watcher has read past the question, so the label is all it can hear.
    const routerLast = [...documented.watchers].reverse()
    const shared = routed(() => 'billing', routerLast.map((watcher) => ({ ...watcher, as: 'router' })))
    await shared.tick()
    const missed = await shared.team.as('ada').post({ channel: 'help', text: 'how do I change my card?' })
    await settle(shared.tick)
    expect(shared.woke).toEqual([`router:${missed.id}`])
    expect(await shared.replies(missed.id)).toEqual([])

    const own = routed(() => 'billing', routerLast)
    await own.tick()
    const heard = await own.team.as('ada').post({ channel: 'help', text: 'how do I change my card?' })
    await settle(own.tick)
    expect(await own.replies(heard.id)).toEqual(['answer from billing'])
  })
})

describe('watchers', () => {
  it('wakes once per thread with a pointer, never the content, for what happened since it last looked', async () => {
    const { team, ran, tick } = harness({})
    await tick()
    const a = await team.post({ channel: 'work/api', text: 'secret text the wake must not carry' })
    await team.reply({ to: a.id, text: 'more' })
    await team.reply({ to: a.id, text: 'and more' })
    const b = await team.post({ channel: 'work/web', text: 'other thread' })
    await team.post({ channel: 'elsewhere', text: 'not watched' })
    const did = await tick()
    expect(did.woke).toHaveLength(2)
    expect(ran.map((run) => run.command)).toEqual([['wake', String(a.id)], ['wake', String(b.id)]])
    expect(ran[0]!.env).toMatchObject({ MUSTER_THREAD: String(a.id), MUSTER_CHANNEL: 'work/api' })
    expect(JSON.stringify(ran)).not.toContain('secret text')
    expect((await tick()).woke).toEqual([])
  })

  it('starts from now: what was on the board before the watcher first ran wakes nothing', async () => {
    const { team, ran, tick } = harness({})
    await team.post({ channel: 'work/api', text: 'old news' })
    await tick()
    expect(ran).toEqual([])
  })

  it("its own profile's writes never wake it, but a message it scheduled does", async () => {
    const { team, time, ran, tick } = harness({ as: 'fixer' })
    await tick()
    const root = await team.as('fixer').post({ channel: 'work/api', text: 'I am on it' })
    expect((await tick()).woke).toEqual([])
    await team.as('fixer').scheduleCreate({ thread: root.id, text: 'check back', at: new Date(time.now().getTime() + 1000).toISOString() })
    const did = await tick()
    expect(did.woke).toHaveLength(1)
    expect(ran.at(-1)!.env.MUSTER_PROFILE).toBe('fixer')
  })

  it('a watcher for a profile wakes once for a mention of it, and never for its own post', async () => {
    const { team, as, ran, tick } = harness({ as: 'lead', tail: { for: 'lead' } })
    await tick()
    await team.as('lead').post({ channel: 'work/api', text: 'my own post, @lead included' })
    expect((await tick()).woke).toEqual([])
    await as('local:user:bob').post({ channel: 'work/api', text: 'nothing for you' })
    expect((await tick()).woke).toEqual([])
    const mention = await as('local:user:bob').post({ channel: 'work/api', text: '@lead please look' })
    const did = await tick()
    expect(did.woke).toHaveLength(1)
    expect(ran.at(-1)!.command).toEqual(['wake', String(mention.id)])
    expect((await tick()).woke).toEqual([])
  })

  it('a watcher for a profile wakes for a reminder the profile scheduled in a channel', async () => {
    const { team, time, ran, tick } = harness({ as: 'lead', tail: { for: 'lead' } })
    await tick()
    await team.as('lead').scheduleCreate({ channel: 'work/api', text: 'check back', at: new Date(time.now().getTime() + 1000).toISOString() })
    const did = await tick()
    expect(did.woke).toHaveLength(1)
    const sent = (await team.readChannel({ channel: 'work/api' })).threads[0]!.message
    expect([sent.text, ran.at(-1)!.command]).toEqual(['check back', ['wake', String(sent.id)]])
  })

  it('a wake that fails is tried again from the same place, and the events after it wait', async () => {
    let failing = true
    const { team, ran, tick } = harness({}, () => ({ code: failing ? 1 : 0 }))
    await tick()
    const a = await team.post({ channel: 'work/api', text: 'a' })
    const b = await team.post({ channel: 'work/api', text: 'b' })
    expect(await tick()).toMatchObject({ woke: [], failed: [a.id] })
    failing = false
    expect((await tick()).woke).toEqual([a.id, b.id])
    expect(ran.map((run) => run.command[1])).toEqual([String(a.id), String(a.id), String(b.id)])
  })

  it('after five failed tries it says so on the thread and moves on to the next', async () => {
    const { team, tick } = harness({}, (command) => ({ code: command[1] === '1' ? 9 : 0 }))
    await tick()
    const bad = await team.post({ channel: 'work/api', text: 'cannot be delivered' })
    const good = await team.post({ channel: 'work/api', text: 'fine' })
    expect(bad.id).toBe(1)
    for (let i = 0; i < 4; i++) expect((await tick()).woke).toEqual([])
    expect((await tick()).woke).toEqual([good.id])
    const replies = (await team.readThread({ id: bad.id })).replies
    expect(replies.map((reply) => reply.text)).toEqual(['watcher "lead" couldn\'t deliver a wake-up after 5 tries (exit 9).'])
    expect(replies[0]!.noSync).toBe(true)
  })

  it('a gate that prints wake:false keeps the command from running', async () => {
    const { team, ran, tick } = harness({ gate: ['gate', '{thread}'] }, (command) => (command[0] === 'gate' ? { code: 0, stdout: 'checking\n{"wake": false}\n' } : { code: 0 }))
    await tick()
    await team.post({ channel: 'work/api', text: 'nothing actionable' })
    expect(await tick()).toMatchObject({ woke: [], gated: [expect.any(Number)] })
    expect(ran.map((run) => run.command[0])).toEqual(['gate'])
    expect(gateSaysNo('{"wake": true}')).toBe(false)
    expect(gateSaysNo('not json')).toBe(false)
    expect(gateSaysNo('')).toBe(false)
  })

  it('filters like tail: a watcher on task outcomes hears completions and holds, not chatter', async () => {
    const { team, tick } = harness({ tail: { channel: 'work/', types: ['task.completed', 'task.blocked', 'task.failed'] } })
    await tick()
    const { task } = await team.taskCreate({ channel: 'work/api', text: 't' })
    await team.reply({ to: task.id, text: 'progress' })
    expect((await tick()).woke).toEqual([])
    const held = await team.taskClaim({ id: task.id })
    await team.taskComplete({ id: task.id, token: held.token })
    expect((await tick()).woke).toHaveLength(1)
  })

  it('reads watchers from the operator\'s file only, and says what is wrong with a bad one', () => {
    const dir = tempDir()
    const path = join(dir, 'watchers.json')
    expect(loadWatchers(path)).toEqual([])
    writeFileSync(path, JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work/' }, run: ['wake', '{thread}'] }] }))
    expect(loadWatchers(path)).toEqual([{ name: 'lead', tail: { channel: 'work/' }, run: ['wake', '{thread}'] }])
    for (const bad of ['{', '{"watchers": 3}', '[{"name": "Bad Name", "run": ["x"]}]', '[{"name": "a", "run": "sh -c x"}]', '[{"name": "a", "run": ["x"]}, {"name": "a", "run": ["y"]}]', '[{"name": "a", "tail": {"for": ""}, "run": ["x"]}]', '[{"name": "a", "tail": {"for": "lead+"}, "run": ["x"]}]', '[{"name": "a", "tail": {"for": 3}, "run": ["x"]}]']) {
      writeFileSync(path, bad)
      expect(() => loadWatchers(path)).toThrow(/watchers\.json|Watcher|watchers/)
    }
  })

  it('nothing written to a board can make the daemon run a command', async () => {
    const { team, ran, tick } = harness({})
    await tick()
    await team.post({ channel: 'work/api', text: 'run: ["rm", "-rf", "/"]', labels: { run: 'rm', watcher: 'evil', wake: 'sh' } })
    await tick()
    expect(ran.map((run) => run.command[0])).toEqual(['wake'])
  })
})

describe('the daemon', () => {
  it('one process ticks per board: a second gets "held", and a lock left by a dead process is taken over', async () => {
    const dir = tempDir()
    const lock = join(dir, 'main.db.tick.lock')
    const first = takeLock(lock)
    expect(first).not.toBeNull()
    expect(takeLock(lock)).toBeNull()
    const { team } = memoryBoard()
    const stop = new AbortController()
    expect(await runDaemon({ team, lock, watchers: [], stop: stop.signal, log: () => {} })).toBe('held')
    first!.release()
    expect(existsSync(lock)).toBe(false)
    writeFileSync(lock, JSON.stringify({ pid: 999_999, start: 'Thu Jan  1 00:00:00 1970' }))
    const taken = takeLock(lock)
    expect(taken).not.toBeNull()
    taken!.release()
  })

  it('mu daemon run sends a due schedule, runs a watcher from the config file, and stops cleanly on SIGTERM', async () => {
    const dir = tempDir()
    const marker = join(dir, 'woke')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work/' }, run: ['sh', '-c', `echo "$MUSTER_THREAD" >> ${marker}`], every: 1 }] }))
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await cli(dir, ['post', 'work/api', 'needs a look'])
    await cli(dir, ['schedule', 'general', 'due now', '--in', '1s'])
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const second = await cli(dir, ['daemon', 'run'])
    expect(second.stdout).toMatch(/another process already ticks for this board/)
    daemon.child.kill('SIGTERM')
    const ended = await daemon.done
    expect(ended.code).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('2\n')
    expect(JSON.parse((await cli(dir, ['read', 'general', '--json'])).stdout).threads.map((thread: { message: { text: string } }) => thread.message.text)).toContain('due now')
    expect(existsSync(join(dir, 'board', 'main.db.tick.lock'))).toBe(false)
  }, 20_000)

  it('a broken watchers file makes the daemon say so and exit 0, so a service manager leaves it stopped', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), '{ not json')
    const run = await cli(dir, ['daemon', 'run'])
    expect(run.code).toBe(0)
    expect(run.stderr).toMatch(/^error: .*watchers\.json isn't JSON/)
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

describe("a watcher's environment", () => {
  it('is built from nothing: the daemon\'s secrets are not passed on unless the watcher names them', async () => {
    const { watcherEnv } = await import('../src/daemon/daemon.ts')
    const from = { PATH: '/bin', HOME: '/home/ada', GITHUB_WEBHOOK_SECRET: 'whsec', GITHUB_TOKEN: 'ghs', MUSTER_TOKEN: 'mu1.x', MUSTER_DIR: '/boards', ALLOWED: 'yes' }
    expect(watcherEnv({ MUSTER_THREAD: '7' }, [], from)).toEqual({ PATH: '/bin', HOME: '/home/ada', MUSTER_DIR: '/boards', MUSTER_THREAD: '7' })
    expect(watcherEnv({}, ['ALLOWED'], from)).toEqual({ PATH: '/bin', HOME: '/home/ada', MUSTER_DIR: '/boards', ALLOWED: 'yes' })
  })

  it('end to end: a command the daemon wakes cannot see a secret the daemon was started with', async () => {
    const dir = tempDir()
    const seen = join(dir, 'env.txt')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'w', tail: { channel: 'work/' }, run: ['sh', '-c', `env > ${seen}`], every: 1, env: ['PASSED_ON'] }] }))
    const daemon = cliStart(dir, ['daemon', 'run'], { GITHUB_TOKEN: 'ghs_secret_value', PASSED_ON: 'fine' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await cli(dir, ['post', 'work/api', 'an issue a stranger wrote'])
    await new Promise((resolve) => setTimeout(resolve, 3000))
    daemon.child.kill('SIGTERM')
    await daemon.done
    const env = readFileSync(seen, 'utf8')
    expect(env).not.toContain('ghs_secret_value')
    expect(env).toMatch(/^PASSED_ON=fine$/m)
    expect(env).toMatch(/^MUSTER_THREAD=1$/m)
  }, 20_000)
})

describe('a watcher whose command keeps failing', () => {
  it('is slowed once it has failed more times in a row than one event is tried, and one success puts it back', async () => {
    let failing = true
    const made = memoryBoard()
    const runs: number[] = []
    const deps: Deps = {
      now: () => made.time.now().getTime(),
      spawn: async () => {
        runs.push(made.time.now().getTime())
        return { code: failing ? 1 : 0, stdout: '' }
      },
    }
    const watchers: Watcher[] = [{ name: 'lead', tail: { channel: 'work/' }, run: ['wake', '{thread}'], every: 1 }]
    const states = new Map<string, WatchState>()
    const at = async (ms: number) => {
      made.time.advance(ms)
      return (await tickOnce(made.team, watchers, states, deps)).watched.lead!
    }
    await at(1000)
    for (let i = 0; i < 20; i++) await made.team.post({ channel: 'work/api', text: `event ${i}` })
    // The five tries of one event come every second, as before.
    for (let i = 0; i < DELIVERY_ATTEMPTS - 1; i++) expect((await at(1000)).failed).toHaveLength(1)
    // The fifth gives up on that event, and the next event fails at once: six failures in a row.
    expect((await at(1000)).slowed).toBe(4)
    expect(runs).toHaveLength(6)
    // Past that, a tick a second runs nothing until the wait is over, and each failure doubles it.
    for (let i = 0; i < 3; i++) expect(await at(1000)).toEqual({ woke: [], failed: [], gated: [] })
    expect(runs).toHaveLength(6)
    expect((await at(1000)).slowed).toBe(8)
    expect(runs).toHaveLength(7)
    // The times of the ticks that ran it: the gaps double, up to ten minutes, and never shrink while it fails.
    const ranAt = [made.time.now().getTime()]
    for (let i = 0; i < 3600 && runs.length < 20; i++) {
      const before = runs.length
      await at(1000)
      if (runs.length > before) ranAt.push(made.time.now().getTime())
    }
    const gaps = ranAt.slice(1).map((time, i) => time - ranAt[i]!)
    expect(gaps.slice(0, 3)).toEqual([8_000, 16_000, 32_000])
    expect(gaps.at(-1)).toBe(SLOWEST)
    expect(Math.max(...gaps)).toBe(SLOWEST)
    failing = false
    made.time.advance(SLOWEST)
    expect((await at(0)).woke.length).toBeGreaterThan(0)
    expect((await at(1000)).slowed).toBeUndefined()
  })

  it("isn't woken again by its own note that it gave up", async () => {
    const { team, ran, tick } = harness({}, () => ({ code: 9 }))
    await tick()
    const bad = await team.post({ channel: 'work/api', text: 'cannot be delivered' })
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) await tick()
    expect((await team.readThread({ id: bad.id })).replies).toHaveLength(1)
    // Nothing to do is not a failure: a quiet board after a give-up logs nothing about it.
    for (let i = 0; i < 20; i++) expect((await tick()).slowed).toBeUndefined()
    expect((await team.readThread({ id: bad.id })).replies).toHaveLength(1)
    expect(ran).toHaveLength(DELIVERY_ATTEMPTS)
  })
})

describe('the restart guard', () => {
  const path = () => join(tempDir(), 'daemon', 'main.json')

  it(`stops the daemon on the ${RESTART_LIMIT}th start within ${RESTART_WINDOW / MIN} minutes, and keeps it stopped`, () => {
    const at = path()
    let now = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 1; i < RESTART_LIMIT; i++) {
      expect(begin(at, now)).toBeNull()
      now += 30_000
    }
    const parked = begin(at, now)
    expect(parked).toMatchObject({ at: '2026-01-01T00:02:00.000Z', why: expect.stringMatching(/started 5 times in 10 minutes .* stopped restarting/) })
    expect(readGuard(at).parked).toEqual(parked)
    // Stopped is stopped: an hour on, it still won't start.
    expect(begin(at, now + 60 * MIN)).toEqual(parked)
    expect(reset(at)).toEqual(parked)
    expect(begin(at, now + 61 * MIN)).toBeNull()
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

  it('a clean exit takes off its own start only, never the running daemon\'s', () => {
    const at = path()
    expect(begin(at, 1)).toBeNull()
    expect(begin(at, 2)).toBeNull()
    ended(at, 2)
    expect(readGuard(at).starts).toEqual([1])
  })

  it('the daemon calls steady once, after a tick that worked, when it has been up long enough', async () => {
    const { team, time } = memoryBoard()
    const stop = new AbortController()
    let steadied = 0
    let ticks = 0
    const log: string[] = []
    const counted = { ...team, scheduleTick: () => ((ticks += 1), team.scheduleTick()) } as typeof team
    const done = runDaemon({
      team: counted,
      lock: join(tempDir(), 'main.db.tick.lock'),
      watchers: [],
      stop: stop.signal,
      log: (line) => log.push(line),
      interval: 1,
      deps: { now: () => time.now().getTime() },
      steady: { after: STEADY_AFTER, then: () => (steadied += 1) },
    })
    const ticked = async (more: number) => {
      const from = ticks
      for (let wait = 0; wait < 200 && ticks < from + more; wait++) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await ticked(3)
    expect(steadied).toBe(0)
    time.advance(STEADY_AFTER)
    await ticked(3)
    expect(steadied).toBe(1)
    time.advance(STEADY_AFTER)
    await ticked(3)
    stop.abort()
    await done
    expect([steadied, log]).toEqual([1, []])
    expect(ticks).toBeGreaterThan(2)
  })

  it('a tick that keeps failing is logged once and then at 2, 4, 8 in a row, not every second', async () => {
    const { team } = memoryBoard()
    const stop = new AbortController()
    const log: string[] = []
    let steadied = 0
    const broken = { ...team, scheduleTick: async () => { throw new Error('The board at x can\'t be read: file is not a database.') } } as typeof team
    const done = runDaemon({ team: broken, lock: join(tempDir(), 'main.db.tick.lock'), watchers: [], stop: stop.signal, log: (line) => log.push(line), interval: 1, deps: { now: () => Date.now() + 10 * STEADY_AFTER }, steady: { after: 0, then: () => (steadied += 1) } })
    await new Promise((resolve) => setTimeout(resolve, 600))
    stop.abort()
    await done
    expect(log[0]).toBe("error     The board at x can't be read: file is not a database.")
    expect(log.slice(1)).toEqual(log.slice(1).map((_, i) => `error     The board at x can't be read: file is not a database.  (${2 ** (i + 1)} ticks in a row)`))
    expect(log.length).toBeLessThan(12)
    // A daemon that only fails never counts as having stayed up.
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

  it('end to end: a daemon that crashes on start stops restarting, says so in status and check, and reset lets it start again', async () => {
    const { dir, calls, env } = crashing()
    for (let i = 1; i < RESTART_LIMIT; i++) expect((await cli(dir, ['daemon', 'run'], { env })).code).toBe(1)
    const status = await cli(dir, ['daemon', 'status'], { env })
    expect(status.stdout).toMatch(/^restarts {2}4 quick starts in 10 minutes; it stops at 5$/m)
    const stopped = await cli(dir, ['daemon', 'run'], { env })
    expect(stopped.code).toBe(0)
    expect(stopped.stderr).toMatch(/^error: The daemon started 5 times in 10 minutes and never stayed up 2 minutes, so it has stopped restarting\.\n.*\n {2}Fix it, then: mu daemon reset\n$/)
    // Stopped, it doesn't even try: the board is never opened again.
    expect((await cli(dir, ['daemon', 'run'], { env })).stderr).not.toMatch(/EEXIST|ENOTDIR/)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^stopped {3}since \S+: The daemon started 5 times .* Fix it, then: mu daemon reset$/m)
    expect(JSON.parse((await cli(dir, ['daemon', 'status', '--json'], { env })).stdout).parked).toMatchObject({ why: expect.stringContaining('stopped restarting') })
    // Not installed: reset clears it and says how to start it by hand.
    const cleared = await cli(dir, ['daemon', 'reset'], { env })
    expect(cleared.stdout).toMatch(/^reset {5}stopped since \S+\nnot installed: start it with mu daemon run\n$/)
    expect((await cli(dir, ['daemon', 'status'], { env })).stdout).toMatch(/^restarts {2}0 quick starts/m)
    expect((await cli(dir, ['daemon', 'run'], { env })).code).toBe(1)
    // Installed: reset starts the service again.
    writeFileSync(join(dir, 'loaded'), '')
    expect((await cli(dir, ['daemon', 'reset'], { env })).stdout).toBe('reset     it had not stopped\nstarted   dev.muster.daemon.main\n')
    expect(readFileSync(calls, 'utf8')).toMatch(/^kickstart gui\/\d+\/dev\.muster\.daemon\.main$/m)
  }, 30_000)

  it('check says the daemon stopped restarting, not only that nothing ticks', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work' }, run: ['true'], every: 1 }] }))
    await cli(dir, ['post', 'general', 'board exists'])
    let now = Date.now()
    for (let i = 0; i < RESTART_LIMIT; i++) begin(join(dir, 'config', 'daemon', 'main.json'), now++)
    const run = await cli(dir, ['daemon', 'check', 'lead', '--json'])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'daemon_stopped', next: ['mu daemon reset'] })
  })

  it('a daemon stopped and started cleanly many times is never stopped by the guard', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    for (let i = 0; i < RESTART_LIMIT + 1; i++) {
      const daemon = cliStart(dir, ['daemon', 'run'])
      // Stopped once it is up and ticking, as launchd stops it at logout.
      for (let wait = 0; wait < 100 && !/watchers/.test(daemon.output()); wait++) await new Promise((resolve) => setTimeout(resolve, 100))
      await new Promise((resolve) => setTimeout(resolve, 200))
      daemon.child.kill('SIGTERM')
      expect((await daemon.done).code).toBe(0)
    }
    expect(readGuard(join(dir, 'config', 'daemon', 'main.json'))).toEqual({ starts: [] })
  }, 30_000)

  it('installing again clears it', async () => {
    const { dir, env } = crashing()
    let now = Date.now()
    for (let i = 0; i < RESTART_LIMIT; i++) begin(join(dir, 'config', 'daemon', 'main.json'), now++)
    expect((await cli(dir, ['daemon', 'install'], { env })).code).toBe(0)
    expect(readGuard(join(dir, 'config', 'daemon', 'main.json'))).toEqual({ starts: [] })
  })
})

describe('checking a watcher', () => {
  const watcher = (tail: Watcher['tail'], extra: Partial<Watcher> = {}): Watcher => ({ name: 'lead', tail, run: ['true'], ...extra })

  it('writes what the filter matches: its channel, its labels, a mention, its words', () => {
    expect(checkWrite(watcher({ channel: 'work', labels: ['kind=bug|feature', 'urgent'], mentions: 'local:user:ada+lead', text: 'ping' }))).toEqual({
      kind: 'post',
      channel: 'work',
      text: 'Watcher check for "lead". If a watcher woke you for this, reply in this thread with anything. @lead ping',
      labels: { kind: 'bug', urgent: 'check' },
    })
    expect(checkWrite(watcher({ re: 12, by: 'ci' }))).toMatchObject({ kind: 'reply', to: 12, as: 'ci' })
    expect(checkWrite(watcher({ channel: 'work/', types: ['message.'] }), { in: 'work/checks' })).toMatchObject({ kind: 'post', channel: 'work/checks' })
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

  const setUp = (run: string[]) => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work' }, run, as: 'lead', every: 1 }] }))
    return dir
  }

  it('says nothing runs the watchers when no daemon holds the board, before writing anything', async () => {
    const dir = setUp(['true'])
    await cli(dir, ['post', 'general', 'board exists'])
    const run = await cli(dir, ['daemon', 'check', 'lead', '--json'])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error.reason).toBe('no_ticker')
    expect(JSON.parse((await cli(dir, ['read', 'work', '--json'])).stdout).threads).toEqual([])
  })

  it('reports who answered when the command wakes something that replies', async () => {
    const dir = setUp([process.execPath, BIN, 'reply', '{thread}', 'here'])
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '15s'])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect([run.code, run.stderr]).toEqual([0, ''])
    expect(run.stdout).toMatch(/^answered {2}#2 {2}by .*lead.* {2}in \d+s?/)
  }, 30_000)

  it('checks a watcher for a profile end to end, on a board where that profile never wrote', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work', for: 'lead' }, run: [process.execPath, BIN, 'reply', '{thread}', 'here'], as: 'lead', every: 1 }] }))
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '15s'])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect([run.code, run.stderr]).toEqual([0, ''])
    expect(run.stdout).toMatch(/^answered {2}#2 {2}by .*lead.* {2}in \d+s?/)
  }, 30_000)

  it('says the wake failed when the command keeps failing, rather than taking the notice for an answer', async () => {
    const dir = setUp(['false'])
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '20s', '--json'])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'wake_failed', data: { thread: 2 } })
  }, 40_000)

  it('times out with the thread to read when the command wakes nothing that answers', async () => {
    const dir = setUp(['true'])
    await cli(dir, ['post', 'general', 'board exists'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const run = await cli(dir, ['daemon', 'check', 'lead', '--timeout', '3s', '--json'])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'timeout', data: { thread: 2 } })
  }, 30_000)
})
