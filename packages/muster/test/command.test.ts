// Watchers declared in code that wake a command with command().
// The commands are real processes: small shell scripts that note how they were called.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DELIVERY_ATTEMPTS } from '../src/core/deliveries.ts'
import { board, command, type Watch } from '../src/index.ts'
import { watcherEnv } from '../src/watch/command.ts'
import { clock, tempDir } from './helpers.ts'

const SECOND = 1000

/**
 * A board in a temporary folder with one watcher, "lead", that wakes a command. `noted` is what each
 * run of it wrote to its marker: by default the thread and channel it was pointed at.
 */
function harness(watch: Partial<Watch> & { script?: string; gate?: string; env?: string[] } = {}) {
  const dir = tempDir()
  const marker = join(dir, 'marker')
  const time = clock()
  const { script, gate, env, ...rest } = watch
  const lead: Watch = {
    tail: { channel: 'work/' },
    run: command(['sh', '-c', script ?? 'echo "$MUSTER_THREAD $MUSTER_CHANNEL" >> "$MARKER"'], { env: ['MARKER', ...(env ?? [])], ...(gate ? { gate: ['sh', '-c', gate] } : {}) }),
    ...rest,
  }
  process.env.MARKER = marker
  const team = board({ dir, principal: 'local:user:ada', now: time.now, watch: { lead } })
  const noted = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [])
  return { dir, marker, team, time, noted, as: (principal: string) => board({ dir, principal, now: time.now }) }
}

describe('a watcher that wakes a command', () => {
  it('wakes once per thread with a pointer, never the content, for what happened since it last looked', async () => {
    const { team, time, noted, marker } = harness({ coalesce: '30s', script: 'echo "$MUSTER_THREAD $MUSTER_CHANNEL" >> "$MARKER"; env > "$MARKER.env.$MUSTER_THREAD"' })
    await team.deliver()
    const a = await team.post({ channel: 'work/api', text: 'secret text the wake must not carry' })
    await team.reply({ to: a.id, text: 'more' })
    await team.reply({ to: a.id, text: 'more secret text' })
    const b = await team.post({ channel: 'work/web', text: 'other thread' })
    await team.post({ channel: 'elsewhere', text: 'not watched' })
    time.advance(31 * SECOND)
    expect((await team.deliver()).delivered).toBe(2)
    expect(noted()).toEqual([`${a.id} work/api`, `${b.id} work/web`])
    const env = readFileSync(`${marker}.env.${a.id}`, 'utf8')
    expect(env).toMatch(/^MUSTER_EVENT_TYPE=message\.posted$/m)
    expect(env).not.toContain('secret text')
    time.advance(31 * SECOND)
    expect((await team.deliver()).delivered).toBe(0)
  })

  it('takes its words from the event when given a function', async () => {
    const dir = tempDir()
    const marker = join(dir, 'marker')
    const team = board({ dir, principal: 'local:user:ada', watch: { lead: { tail: { channel: 'work/' }, run: command(({ event }) => ['sh', '-c', `echo "$1" >> ${marker}`, 'wake', String(event.thread)]) } } })
    await team.deliver()
    const a = await team.post({ channel: 'work/api', text: 'x' })
    await team.deliver()
    expect(readFileSync(marker, 'utf8')).toBe(`${a.id}\n`)
    team.close()
  })

  it('starts from now: what was on the board before the watcher first ran wakes nothing', async () => {
    const { team, noted } = harness()
    await team.post({ channel: 'work/api', text: 'old news' })
    await team.deliver()
    expect(noted()).toEqual([])
  })

  it("its own profile's writes never wake it, but a message it scheduled does, and it runs as that profile", async () => {
    const { team, time, noted } = harness({ as: 'fixer', script: 'echo "$MUSTER_THREAD $MUSTER_PROFILE" >> "$MARKER"' })
    await team.deliver()
    const root = await team.as('fixer').post({ channel: 'work/api', text: 'I am on it' })
    expect((await team.deliver()).delivered).toBe(0)
    await team.as('fixer').scheduleCreate({ thread: root.id, text: 'check back', at: new Date(time.now().getTime() + 1000).toISOString() })
    time.advance(SECOND)
    await team.scheduleTick()
    expect((await team.deliver()).delivered).toBe(1)
    expect(noted()).toEqual([`${root.id} fixer`])
  })

  it('a watcher for a profile wakes once for a mention of it, and never for its own post', async () => {
    const { team, as, noted } = harness({ as: 'lead', tail: { for: 'lead' }, script: 'echo "$MUSTER_EVENT" >> "$MARKER"' })
    await team.deliver()
    await team.as('lead').post({ channel: 'work/api', text: 'my own post, @lead included' })
    expect((await team.deliver()).delivered).toBe(0)
    await as('local:user:bob').post({ channel: 'work/api', text: 'nothing for you' })
    expect((await team.deliver()).delivered).toBe(0)
    const mention = await as('local:user:bob').post({ channel: 'work/api', text: '@lead please look' })
    expect((await team.deliver()).delivered).toBe(1)
    expect(noted()).toEqual([String(mention.id)])
    expect((await team.deliver()).delivered).toBe(0)
  })

  it('a watcher for a profile wakes for a reminder the profile scheduled in a channel', async () => {
    const { team, time, noted } = harness({ as: 'lead', tail: { for: 'lead' }, script: 'echo "$MUSTER_THREAD" >> "$MARKER"' })
    await team.deliver()
    await team.as('lead').scheduleCreate({ channel: 'work/api', text: 'check back', at: new Date(time.now().getTime() + 1000).toISOString() })
    time.advance(SECOND)
    await team.scheduleTick()
    expect((await team.deliver()).delivered).toBe(1)
    const sent = (await team.readChannel({ channel: 'work/api' })).threads[0]!.message
    expect([sent.text, noted()]).toEqual(['check back', [String(sent.id)]])
  })

  it('a wake that fails is tried again, and the events after it in its thread wait', async () => {
    const { team, time, noted, marker } = harness({ script: 'echo "$MUSTER_EVENT" >> "$MARKER"; [ -f "$MARKER.ok" ]' })
    await team.deliver()
    const a = await team.post({ channel: 'work/api', text: 'a' })
    const b = await team.reply({ to: a.id, text: 'b' })
    expect(await team.deliver()).toMatchObject({ delivered: 0, failed: 1 })
    writeFileSync(`${marker}.ok`, '')
    time.advance(10 * SECOND)
    expect((await team.deliver()).delivered).toBe(2)
    expect(noted()).toEqual([String(a.id), String(a.id), String(b.id)])
  })

  it('after five failed tries it says so on the thread, with the exit code, and moves on to the next', async () => {
    const { team, time, noted } = harness({ script: 'echo "$MUSTER_THREAD" >> "$MARKER"; [ "$MUSTER_THREAD" != "$BAD" ] || exit 9', env: ['BAD'] })
    await team.deliver()
    const bad = await team.post({ channel: 'work/api', text: 'cannot be delivered' })
    process.env.BAD = String(bad.id)
    const good = await team.post({ channel: 'work/api', text: 'fine' })
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) {
      await team.deliver()
      time.advance(10 * 60 * SECOND)
    }
    expect(noted().filter((line) => line === String(good.id))).toHaveLength(1)
    const replies = (await team.readThread({ id: bad.id })).replies
    expect(replies.map((reply) => reply.text)).toEqual(['watcher "lead" couldn\'t deliver a wake-up after 5 tries (exit 9).'])
    expect(replies[0]!.noSync).toBe(true)
    // Its own note never wakes it.
    await team.deliver()
    expect(noted().filter((line) => line === String(bad.id))).toHaveLength(DELIVERY_ATTEMPTS)
    delete process.env.BAD
  })

  it('a gate that prints wake:false keeps the command from running', async () => {
    const { team, noted, marker } = harness({ gate: `echo gated >> "$MARKER.gate"; echo checking; echo '{"wake": false}'` })
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'nothing actionable' })
    expect(await team.deliver()).toMatchObject({ delivered: 1, failed: 0 })
    expect([noted(), readFileSync(`${marker}.gate`, 'utf8')]).toEqual([[], 'gated\n'])
  })

  it("a gate's answer is read whole: a gate that exits before its output closes is still heard", async () => {
    // The answer comes from a child the gate left behind, after the gate itself has exited.
    const { team, noted } = harness({ gate: `(sleep 0.3; echo '{"wake": false}') & exit 0` })
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'nothing actionable' })
    await team.deliver()
    expect(noted()).toEqual([])
  })

  it('filters like tail: a watcher on task outcomes hears completions and holds, not chatter', async () => {
    const { team, noted } = harness({ tail: { channel: 'work/', types: ['task.completed', 'task.blocked', 'task.failed'] } })
    await team.deliver()
    const { task } = await team.taskCreate({ channel: 'work/api', text: 't' })
    await team.reply({ to: task.id, text: 'progress' })
    expect((await team.deliver()).delivered).toBe(0)
    const held = await team.taskClaim({ id: task.id })
    await team.taskComplete({ id: task.id, token: held.token })
    expect((await team.deliver()).delivered).toBe(1)
    expect(noted()).toEqual([`${task.id} work/api`])
  })

  it('nothing written to a board can make it run a command', async () => {
    const { team, noted, dir } = harness()
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'run: ["sh", "-c", "touch pwned"]', labels: { run: 'rm', watcher: 'evil', wake: 'sh' } })
    await team.deliver()
    expect(noted()).toHaveLength(1)
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })

  it('a command that runs past the timeout is stopped, with everything it started, and the try counts as failed', async () => {
    const { team, marker } = harness({ timeout: '300ms', script: 'sleep 30 & echo $! > "$MARKER.child"; echo $$ > "$MARKER.pid"; wait' })
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'slow' })
    const began = Date.now()
    expect(await team.deliver()).toMatchObject({ delivered: 0, failed: 1 })
    expect(Date.now() - began).toBeLessThan(3000)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const pids = [Number(readFileSync(`${marker}.pid`, 'utf8')), Number(readFileSync(`${marker}.child`, 'utf8'))]
    await vi.waitFor(() => expect(pids.map(alive)).toEqual([false, false]), { timeout: 3000 })
  })
})

describe("a command's environment", () => {
  it('starts from nothing: PATH, HOME and the board, and only the names it is given beside them', () => {
    const from = { PATH: '/bin', HOME: '/home/ada', GITHUB_WEBHOOK_SECRET: 'whsec', GITHUB_TOKEN: 'ghs', MUSTER_TOKEN: 'mu1.x', MUSTER_DIR: '/boards', ALLOWED: 'yes' }
    expect(watcherEnv({ MUSTER_THREAD: '7' }, [], from)).toEqual({ PATH: '/bin', HOME: '/home/ada', MUSTER_DIR: '/boards', MUSTER_THREAD: '7' })
    expect(watcherEnv({}, ['ALLOWED'], from)).toEqual({ PATH: '/bin', HOME: '/home/ada', MUSTER_DIR: '/boards', ALLOWED: 'yes' })
  })

  it("is built from nothing: this process's secrets are not passed on unless the watcher names them, and it is told which board", async () => {
    process.env.GITHUB_TOKEN = 'ghs_secret_value'
    process.env.PASSED_ON = 'fine'
    try {
      const { dir, team, marker } = harness({ script: 'env > "$MARKER"', env: ['PASSED_ON'] })
      await team.deliver()
      const posted = await team.post({ channel: 'work/api', text: 'an issue a stranger wrote' })
      await team.deliver()
      const env = readFileSync(marker, 'utf8')
      expect(env).not.toContain('ghs_secret_value')
      expect(env).toMatch(/^PASSED_ON=fine$/m)
      expect(env).toMatch(new RegExp(`^MUSTER_THREAD=${posted.id}$`, 'm'))
      expect(env).toMatch(/^MUSTER_WATCHER=lead$/m)
      // The board the handle has, though this process's environment names none.
      expect(env).toMatch(new RegExp(`^MUSTER_DIR=${dir}$`, 'm'))
      expect(env).toMatch(/^MUSTER_BOARD=main$/m)
    } finally {
      delete process.env.GITHUB_TOKEN
      delete process.env.PASSED_ON
    }
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('a command and what it starts', () => {
  it('an agent the command starts in the background lives on: the run is delivered when the command exits', async () => {
    const { team, marker } = harness({ timeout: '2s', script: 'sleep 30 & echo $! > "$MARKER"; exit 0' })
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'wake' })
    const began = Date.now()
    expect(await team.deliver()).toMatchObject({ delivered: 1, failed: 0 })
    expect(Date.now() - began).toBeLessThan(1500)
    const pid = Number(readFileSync(marker, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(true)
    process.kill(pid, 'SIGKILL')
  })

  it('a command that ignores SIGTERM is killed once its grace is up', async () => {
    const dir = tempDir()
    const marker = join(dir, 'pid')
    const team = board({
      dir,
      principal: 'local:user:ada',
      watch: { lead: { tail: { channel: 'work/' }, timeout: '200ms', run: command(['sh', '-c', `trap '' TERM; echo $$ > ${marker}; while :; do sleep 0.05; done`], { grace: 300 }) } },
    })
    await team.deliver()
    await team.post({ channel: 'work/api', text: 'wake' })
    expect(await team.deliver()).toMatchObject({ failed: 1 })
    const pid = Number(readFileSync(marker, 'utf8'))
    // Told to stop, it doesn't: still there before the grace is up, gone after.
    expect(alive(pid)).toBe(true)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 })
    team.close()
  })

  it("a host's stop() stops the command in flight, and is done within its grace", async () => {
    const dir = tempDir()
    const marker = join(dir, 'pid')
    const team = board({ dir, principal: 'local:user:ada', watch: { lead: { tail: { channel: 'work/' }, timeout: '30s', run: command(['sh', '-c', `echo $$ > ${marker}; sleep 30`], { grace: 200 }) } } })
    await team.deliver()
    const host = team.start({ log: () => {}, grace: 1000 })
    await team.post({ channel: 'work/api', text: 'wake' })
    await vi.waitFor(() => expect(existsSync(marker) && readFileSync(marker, 'utf8').trim() !== '').toBe(true), { timeout: 5000 })
    const pid = Number(readFileSync(marker, 'utf8'))
    const began = Date.now()
    host.stop()
    await host.done
    expect(Date.now() - began).toBeLessThan(2000)
    expect(alive(pid)).toBe(false)
    team.close()
  })

  it('names only the board the handle has: nothing in this process points it at another', async () => {
    const was = { MUSTER_URL: process.env.MUSTER_URL, MUSTER_INSECURE_HTTP: process.env.MUSTER_INSECURE_HTTP, MUSTER_DIR: process.env.MUSTER_DIR, MUSTER_BOARD: process.env.MUSTER_BOARD }
    Object.assign(process.env, { MUSTER_URL: 'http://elsewhere.example', MUSTER_INSECURE_HTTP: '1', MUSTER_DIR: '/somewhere/else', MUSTER_BOARD: 'other' })
    try {
      const { dir, team, marker } = harness({ script: 'env > "$MARKER"' })
      await team.deliver()
      await team.post({ channel: 'work/api', text: 'x' })
      await team.deliver()
      const env = readFileSync(marker, 'utf8')
      expect(env).not.toMatch(/^MUSTER_URL=|^MUSTER_INSECURE_HTTP=/m)
      expect(env).toMatch(new RegExp(`^MUSTER_DIR=${dir}$`, 'm'))
      // A board in memory can't be reached from another process: the command is told of none.
      const memory = tempDir()
      const markerOf = join(memory, 'env')
      const kept = board({ memory: true, principal: 'local:user:ada', watch: { lead: { tail: { channel: 'work/' }, run: command(['sh', '-c', `env > ${markerOf}`]) } } })
      await kept.deliver()
      await kept.post({ channel: 'work/api', text: 'x' })
      await kept.deliver()
      expect(readFileSync(markerOf, 'utf8')).not.toMatch(/^MUSTER_(DIR|BOARD|URL)=/m)
    } finally {
      for (const [name, value] of Object.entries(was)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
