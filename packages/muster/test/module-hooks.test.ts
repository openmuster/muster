// Outgoing webhooks declared in a board module: board({ hooks }), with each secret named by env(), sent by
// the host that start()s the module (mu daemon run, mu serve, or your own process) under one `hooks` lease.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { board, env } from '../src/index.ts'
import { BIN, cli, tempDir, type Ran } from './helpers.ts'

const KEY = 'a-secret-of-thirty-two-characters'
const PACKAGE = realpathSync(fileURLToPath(new URL('..', import.meta.url)))

// The CLI reads workflows.json from the config folder: this file's own, never the real one.
const CONFIG = tempDir()
beforeAll(() => {
  process.env.MUSTER_CONFIG = CONFIG
  delete process.env.AUDIT_SECRET
})

const open: (() => Promise<void>)[] = []
const running = new Set<ChildProcess>()
afterEach(async () => {
  for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  running.clear()
  await Promise.all(open.splice(0).map((close) => close()))
})

type Got = { delivery: string; signed: boolean; event: { seq: number; type: string; message?: { text: string } } }

/** A receiver that checks each signature as the docs say to, and answers with the next of `answers` (then 200), after `delay`. */
async function receiver(options: { delay?: number } = {}) {
  const got: Got[] = []
  const answers: number[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const delivery = String(request.headers['muster-delivery'])
      const expected = `v1=${createHmac('sha256', KEY).update(`${delivery}.${String(request.headers['muster-timestamp'])}.${raw}`).digest('hex')}`
      // The answer is taken as the request arrives, before it is recorded: an answer a test queues once it has
      // seen this request is for the next one, never this one.
      const status = answers.shift() ?? 200
      got.push({ delivery, signed: request.headers['muster-signature'] === expected, event: (JSON.parse(raw) as { event: Got['event'] }).event })
      setTimeout(() => response.writeHead(status).end(), options.delay ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  open.push(() => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))))
  return { got, answers, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/in` }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Waited for, not timed: on a busy machine a daemon takes longer to start and to deliver. */
async function until(done: () => boolean | Promise<boolean>, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return
  throw new Error('waited too long')
}

/** A folder for one test: its board, its config folder, and a module that declares one hook to `url`. */
function folder(url: string, extra = '') {
  const dir = tempDir()
  mkdirSync(join(dir, 'config'), { recursive: true })
  const module = join(dir, 'board.ts')
  writeFileSync(module, `import { board, env } from 'muster'
export default board({
  hooks: [{ name: 'audit', url: '${url}', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' }, body: 'event' }],${extra}
})
`)
  return { dir, module }
}

function daemon(dir: string, module: string, extra: Record<string, string> = { AUDIT_SECRET: KEY }) {
  const child = spawn(process.execPath, [BIN, 'daemon', 'run', '--module', module], {
    env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.add(child)
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise<Ran>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, done, output: () => stdout }
}

type Hooked = { name: string; holder: string | null; lag: number | null }
const hooksOf = async (dir: string, module: string) => (JSON.parse((await cli(dir, ['daemon', 'status', '--json', '--module', module])).stdout) as { module: { hooks: Hooked[] } }).module.hooks
const post = async (dir: string, channel: string, text: string) => (JSON.parse((await cli(dir, ['post', channel, text, '--json'])).stdout) as { message: { id: number } }).message.id

describe('board({ hooks })', () => {
  it('declares hooks, keeps only the name of the secret, and reads nothing until start()', async () => {
    const team = board({ memory: true, hooks: [{ name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' } }] })
    expect(team.hooks).toEqual([{ name: 'audit', url: 'https://hooks.example.com/in', secret: 'AUDIT_SECRET', tail: { channel: 'work/' }, body: 'pointer' }])
    expect(Object.isFrozen(team.hooks)).toBe(true)
    // Made with the variable unset: start() is what reads it, and says which one is missing.
    expect(() => team.start()).toThrow(`AUDIT_SECRET isn't set, and hook "audit" in board({ hooks }) signs with it.`)
    process.env.AUDIT_SECRET = 'short'
    expect(() => team.start()).toThrow('AUDIT_SECRET is too short to sign with')
    process.env.AUDIT_SECRET = KEY
    try {
      const host = team.start()
      host.stop()
      await host.done
    } finally {
      delete process.env.AUDIT_SECRET
      team.close()
    }
  })

  it('refuses a hook that is wrong when board() is called, naming it', () => {
    const refused = (hooks: unknown, watch?: unknown) => {
      try {
        board({ memory: true, hooks, watch } as never)
        return 'not refused'
      } catch (error) {
        return `${(error as { reason: string }).reason}: ${(error as Error).message}`
      }
    }
    const base = { name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET') }
    expect(refused([{ ...base, secret: 'AUDIT_SECRET' }])).toBe(`invalid_hook: "secret" of hook "audit" in board({ hooks }) names an environment variable with env(): secret: env('AUDIT_SECRET'). The secret itself is never in the module.`)
    expect(refused([{ ...base, secret: 'env:AUDIT_SECRET' }])).toMatch(/^invalid_hook: .*secret: env\('NAME'\)/)
    expect(refused([{ ...base, run: () => {} }])).toMatch(/^invalid_hook: Hook "audit" in board\(\{ hooks \}\) has "run", which a hook doesn't take/)
    expect(refused([{ ...base, url: 'http://hooks.example.com/in' }])).toMatch(/^invalid_hook: .*needs an https URL/)
    expect(refused([{ ...base, url: 'ftp://hooks.example.com/in' }])).toMatch(/^invalid_hook: .*needs an https URL/)
    expect(refused([{ ...base, url: 'https://ada:pw@hooks.example.com/in' }])).toMatch(/^invalid_hook: .*password in its URL/)
    expect(refused([{ ...base, url: 'http://127.0.0.1:8787/in' }, { ...base, name: 'local', url: 'http://localhost:8787/in' }])).toBe('not refused')
    expect(refused([{ ...base, url: undefined }])).toMatch(/^invalid_hook: Hook "audit" .*needs a "url"/)
    expect(refused([{ ...base, name: 'Audit!' }])).toMatch(/^invalid_hook: Hook 1 .*needs a "name"/)
    expect(refused([{ ...base, body: 'everything' }])).toMatch(/^invalid_hook: .*"pointer" or "event"/)
    expect(refused([{ ...base, tail: { kinds: '!backlog' } }])).toMatch(/^invalid_hook: Hook "audit" has "kinds"/)
    expect(refused([{ ...base, tail: { chanel: 'work/' } }])).toMatch(/^invalid_hook: Hook "audit" has "chanel" in its tail/)
    expect(refused([base, base])).toBe('invalid_hook: Two hooks in board({ hooks }) are named "audit".')
    expect(refused([base], { audit: { tail: {}, run: () => {} } })).toBe('invalid_hook: A watcher and a hook in board({ hooks }) are both named "audit".')
    expect(() => env('not a name')).toThrow(`env("not a name") doesn't name an environment variable.`)
  })
})

describe('module hooks from the command line', () => {
  it('mu daemon run sends a signed POST for each event, and a retry after a 500 keeps the order', async () => {
    const there = await receiver()
    const { dir, module } = folder(there.url)
    await post(dir, 'general', 'board exists')
    const run = daemon(dir, module)
    await until(async () => (await hooksOf(dir, module))[0]?.lag === 0)
    expect((await hooksOf(dir, module))[0]?.holder).toMatch(/:\d+:[0-9a-f]{12}$/)
    there.answers.push(500)
    const first = await post(dir, 'work/api', 'first')
    const second = await post(dir, 'work/api', 'second')
    await until(() => there.got.length >= 3)
    run.child.kill('SIGTERM')
    const ended = await run.done
    expect([ended.code, ended.stderr]).toEqual([0, ''])
    expect(ended.stdout).toMatch(/^hooks {5}1$/m)
    expect(ended.stdout).toMatch(new RegExp(`^failed {4}hook audit {2}at ${first} {2}HTTP 500$`, 'm'))
    // The first is tried again before the second goes: the order never changes.
    expect(there.got.map((each) => [each.delivery, each.signed, each.event.message?.text])).toEqual([
      [`audit.${first}`, true, 'first'],
      [`audit.${first}`, true, 'first'],
      [`audit.${second}`, true, 'second'],
    ])
    // Its lease was given back.
    expect((await hooksOf(dir, module))[0]?.holder).toBeNull()
  }, 60_000)

  it('mu serve with the module sends its hooks too', async () => {
    // Slow to answer, so the 500 below is queued while the first delivery still waits for its answer: it must go to the next.
    const there = await receiver({ delay: 150 })
    const { dir, module } = folder(there.url)
    await post(dir, 'general', 'board exists')
    const child = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--module', module], {
      env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', AUDIT_SECRET: KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    running.add(child)
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    await until(async () => (await hooksOf(dir, module))[0]?.lag === 0)
    const sent = await post(dir, 'work/api', 'over serve')
    await until(() => there.got.length >= 1)
    // What it delivered isn't news on a server's error output.
    expect([there.got.map((each) => [each.delivery, each.signed]), stderr]).toEqual([[[`audit.${sent}`, true]], ''])
    // What a receiver refused is.
    there.answers.push(500)
    const refused = await post(dir, 'work/api', 'refused once')
    await until(() => stderr.includes('failed'))
    child.kill('SIGTERM')
    await new Promise((resolve) => child.on('exit', resolve))
    expect(stderr).toBe(`failed    hook audit  at ${refused}  HTTP 500\n`)
  }, 60_000)

  it('the module loads without the secret, and mu daemon run says which variable is missing and exits 0', async () => {
    const { dir, module } = folder('https://hooks.example.com/in')
    expect((await hooksOf(dir, module)).map((hook) => [hook.name, hook.holder, hook.lag])).toEqual([['audit', null, null]])
    const ended = await daemon(dir, module, {}).done
    expect(ended.code).toBe(0)
    expect(ended.stderr).toContain(`error: AUDIT_SECRET isn't set, and hook "audit" in board({ hooks }) signs with it.`)
  }, 30_000)

  it('refuses a module hook named like a workflow in workflows.json: mu daemon run says so and exits 0, and check refuses', async () => {
    const { dir, module } = folder('https://hooks.example.com/in')
    writeFileSync(join(dir, 'config', 'workflows.json'), JSON.stringify({ workflows: [{ name: 'audit', description: 'd', who: ['ada'], channels: ['general'], steps: [{ key: 'a', text: 'A' }], workers: { count: 1, agent: 'claude', as: 'worker', cwd: '/srv/app' } }] }))
    const ended = await daemon(dir, module).done
    expect(ended.code).toBe(0)
    expect(ended.stderr).toContain(`error: A hook in ${module} and a workflow in ${join(dir, 'config', 'workflows.json')} are both named "audit".`)
    const checked = await cli(dir, ['daemon', 'check', 'audit', '--json', '--module', module], { env: { AUDIT_SECRET: KEY } })
    expect(JSON.parse(checked.stderr).error.reason).toBe('invalid_config')
  }, 30_000)

  it('mu daemon check <hook> sends a signed ping to a module hook', async () => {
    const there = await receiver()
    const { dir, module } = folder(there.url)
    const checked = await cli(dir, ['daemon', 'check', 'audit', '--module', module], { env: { AUDIT_SECRET: KEY } })
    expect([checked.code, checked.stderr]).toEqual([0, ''])
    expect(checked.stdout).toMatch(/^delivered {2}audit {2}HTTP 200 {2}in \d+ms\n$/)
    expect(there.got.map((each) => [each.signed, each.event.type])).toEqual([[true, 'ping']])
    // A receiver that answers and refuses is a check that failed, with what it answered.
    there.answers.push(401)
    const refused = await cli(dir, ['daemon', 'check', 'audit', '--json', '--module', module], { env: { AUDIT_SECRET: KEY } })
    expect([refused.code, JSON.parse(refused.stderr).error]).toEqual([1, expect.objectContaining({ reason: 'hook_failed', data: { hook: 'audit', status: 401 } })])
    const unset = await cli(dir, ['daemon', 'check', 'audit', '--json', '--module', module])
    expect(JSON.parse(unset.stderr).error).toMatchObject({ reason: 'invalid_config', message: expect.stringContaining('AUDIT_SECRET') })
  }, 30_000)

  it('two hosts on one board send each event once: the hooks lease', async () => {
    // A slow receiver: two hosts sending without the lease would both send before either moved the cursor.
    const there = await receiver({ delay: 300 })
    const { dir, module } = folder(there.url)
    await post(dir, 'general', 'board exists')
    const one = daemon(dir, module)
    await until(async () => (await hooksOf(dir, module))[0]?.lag === 0)
    const two = daemon(dir, module)
    await until(() => two.output().includes('standing by'))
    const sent = []
    for (const text of ['a', 'b', 'c', 'd']) sent.push(await post(dir, 'work/api', text))
    await until(() => there.got.length >= 4)
    await sleep(1500)
    expect(there.got.map((each) => each.delivery)).toEqual(sent.map((seq) => `audit.${seq}`))
    // The one that sent stops; the other takes the lease over and sends what comes next, once.
    one.child.kill('SIGTERM')
    expect((await one.done).code).toBe(0)
    const later = await post(dir, 'work/api', 'e')
    await until(() => there.got.length >= 5, 60_000)
    await sleep(1500)
    expect(there.got.slice(4).map((each) => each.delivery)).toEqual([`audit.${later}`])
    two.child.kill('SIGTERM')
    expect((await two.done).code).toBe(0)
  }, 120_000)
})

describe('the board module the outgoing webhooks page shows', () => {
  const page = readFileSync(join(PACKAGE, 'docs', '01-concepts', '15-outgoing-webhooks.md'), 'utf8')
  const source = /```ts lib\/board\.ts\n([\s\S]*?)```/.exec(page)?.[1]

  it('loads in mu with no secret set, with the hooks it declares', async () => {
    expect(source).toBeDefined()
    const dir = tempDir()
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'board.ts'), source!)
    const status = JSON.parse((await cli(dir, ['daemon', 'status', '--json', '--module', join(dir, 'lib', 'board.ts')])).stdout) as { module: { error?: unknown; hooks: { name: string }[] } }
    expect([status.module.error, status.module.hooks.map((hook) => hook.name)]).toEqual([undefined, ['phone']])
  }, 30_000)
})
