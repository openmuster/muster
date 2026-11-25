// A board module declares its sync in board({ sync }), with secrets named by env(): read when the board
// starts or takes its first request, never when the module is imported.
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { board, env, Failure, github, linear, slack, type Board } from '../src/index.ts'
import { tickOnce } from '../src/daemon/daemon.ts'
import { cli, cliStart, tempDir } from './helpers.ts'

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const GH = 'MUSTER_TEST_GH_SECRET'
const LIN = 'MUSTER_TEST_LIN_SECRET'

const closers: (() => unknown)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  delete process.env[GH]
  delete process.env[LIN]
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(done: () => boolean | Promise<boolean>, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await done()) return
  throw new Error('waited too long')
}

/** A signed GitHub webhook and a signed Linear one, as each platform sends them. */
const githubHook = (secret: string, number: number, title: string) => {
  const body = JSON.stringify({ action: 'opened', issue: { number, title, body: '' }, repository: { full_name: 'acme/web' }, sender: { login: 'nico' } })
  return { headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': `d-${number}`, 'x-hub-signature-256': `sha256=${sign(secret, body)}` }, body }
}
const linearHook = (secret: string, id: string, title: string) => {
  const body = JSON.stringify({ type: 'Issue', action: 'create', data: { id, identifier: 'ENG-1', title, description: '', team: { key: 'ENG' }, creatorId: 'u-nico', state: { name: 'Todo' } } })
  return { headers: { 'content-type': 'application/json', 'linear-delivery': `l-${id}`, 'linear-signature': sign(secret, body) }, body }
}

const declared = (dir: string, extra: Record<string, unknown> = {}) =>
  board({
    dir,
    key: randomBytes(32),
    sync: {
      gh: github({ secret: env(GH), repos: { 'acme/web': 'web' } }),
      lin: linear({ secret: env(LIN), teams: { ENG: 'eng' } }),
    },
    ...extra,
  })

const texts = async (team: Board, channel: string) => (await team.readChannel({ channel })).threads.map((thread) => thread.message.text)

describe('sync in a board module', () => {
  it('env() reads nothing when declared: the handle lists its sync and the variables it will read', () => {
    const team = declared(tempDir())
    closers.push(() => team.close())
    expect(team.sync).toEqual([
      { key: 'gh', type: 'github', env: [GH] },
      { key: 'lin', type: 'linear', env: [LIN] },
    ])
    expect(String(env(GH))).toBe(`env('${GH}')`)
    expect(() => env('not a name')).toThrow(/doesn't name an environment variable/)
  })

  it('start() refuses, naming the variable and the sync that needs it, and starts nothing', () => {
    process.env[LIN] = 'lin-secret'
    const team = declared(tempDir())
    closers.push(() => team.close())
    let thrown: unknown
    try {
      team.start()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Failure)
    expect((thrown as Failure).message).toBe(`${GH} isn't set, and sync "gh" needs it.`)
  })

  it('team.fetch takes a signed GitHub webhook and a Linear one, with the secrets read on its first request', async () => {
    const dir = tempDir()
    const logged: string[] = []
    const team = declared(dir, { serve: { log: (line: string) => logged.push(line) } })
    closers.push(() => team.close())
    const post = (key: string, hook: { headers: Record<string, string>; body: string }) => team.fetch(new Request(`http://127.0.0.1/api/board/webhooks/${key}`, { method: 'POST', headers: { ...hook.headers, host: '127.0.0.1' }, body: hook.body }))
    // Unset: every request is the owner's 500, and the log says what is missing.
    const early = await post('gh', githubHook('gh-secret', 1, 'too early'))
    expect(early.status).toBe(500)
    expect(logged.join('\n')).toContain(`${GH} isn't set, and sync "gh" needs it.`)
    process.env[GH] = 'gh-secret'
    process.env[LIN] = 'lin-secret'
    expect((await post('gh', githubHook('wrong-secret', 2, 'forged'))).status).toBe(401)
    expect((await post('gh', githubHook('gh-secret', 3, 'through team.fetch'))).status).toBe(200)
    expect((await post('lin', linearHook('lin-secret', 'iss-1', 'from Linear'))).status).toBe(200)
    expect(await texts(team, 'web')).toEqual(['through team.fetch'])
    expect(await texts(team, 'eng')).toEqual(['from Linear'])
  })

  it('start() runs the catch-up: what the platform changed while nothing listened arrives', async () => {
    process.env[GH] = 'gh-secret'
    process.env[LIN] = 'lin-secret'
    const dir = tempDir()
    const asked: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input)
      asked.push(url)
      if (url.includes('/repos/acme/web/issues?state=all')) return Response.json([{ number: 8, title: 'Opened while down', body: '', state: 'open', user: { login: 'maya' }, updated_at: new Date().toISOString() }])
      return Response.json([])
    }) as typeof fetch
    const sync = () => ({ gh: github({ secret: env(GH), token: env(GH), repos: { 'acme/web': 'web' } }) })
    // Something received once, then the board went down: catching up starts from there.
    const before = board({ dir, sync: sync() })
    await before.backend.syncReceive('gh', githubHook('gh-secret', 7, 'seen before'))
    before.close()
    const team = board({ dir, sync: sync(), fetch: fetcher })
    closers.push(() => team.close())
    const host = team.start({ log: () => {} })
    closers.push(async () => {
      host.stop()
      await host.done
    })
    await until(async () => (await texts(team, 'web')).includes('Opened while down'))
    expect(asked.some((url) => url.startsWith('https://api.github.com/repos/acme/web/issues'))).toBe(true)
    expect((await team.backend.leases!.holder('sync'))?.holder).toBeTruthy()
  })

  it("the daemon's tick leaves a module's sync to the host that holds its lease: nothing goes out twice", async () => {
    process.env[GH] = 'gh-secret'
    const sent: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      sent.push(String(input))
      return Response.json({ id: 1, number: 1 }, { status: 201 })
    }) as typeof fetch
    const team = board({ memory: true, fetch: fetcher, sync: { gh: github({ secret: env(GH), token: env(GH), repos: { 'acme/web': { issues: 'web', mirror: true } } }) } })
    closers.push(() => team.close())
    // What goes out is what is posted after the sync first looked: as a board that already syncs.
    await team.backend.syncTick()
    await team.post({ channel: 'web', text: 'from the board' })
    const did = await tickOnce(team, [], new Map(), { now: () => Date.now(), spawn: async () => ({ code: 0, stdout: '' }) })
    expect(did.synced).toEqual({ imported: 0, delivered: 0, failed: 0 })
    expect(sent).toEqual([])
    // The same board, its sync declared on the backend instead (as sync.json's is): the tick runs it.
    expect(await team.backend.syncTick()).toMatchObject({ delivered: 1 })
  })

  it('the shapes port from sync.json: a filter command, filesPerDayMB, and literal secrets', () => {
    const made = slack({ secret: 'literal', channels: { C1: 'general' }, filter: ['tr', 'a-z', 'A-Z'], filesPerDayMB: 1 })
    expect(made.filter!('shout')).toBe('SHOUT')
    expect(made.filesPerDay).toBe(1024 * 1024)
    expect(() => slack({ secret: 'literal', channels: {}, filesPerDayMB: 0 })).toThrow(/filesPerDayMB/)
    expect(() => github({ secret: '', repos: {} })).toThrow(/needs a "secret"/)
    expect(() => board({ memory: true, sync: { 'Not A Key': github({ secret: 's', repos: {} }) } })).toThrow(/isn't a sync name/)
  })

  it('what a module adds to a provider itself is kept once its secrets are read', async () => {
    process.env[GH] = 'gh-secret'
    const team = board({ memory: true, sync: { gh: { ...github({ secret: env(GH), repos: { 'acme/web': 'web' } }), filter: (text) => (text.includes('drop') ? null : text) } } })
    closers.push(() => team.close())
    await team.backend.syncReceive('gh', githubHook('gh-secret', 1, 'please drop this'))
    await team.backend.syncReceive('gh', githubHook('gh-secret', 2, 'keep this'))
    expect(await texts(team, 'web')).toEqual(['keep this'])
  })
})

/** A board module on disk that declares GitHub and Linear sync with env(). */
const MODULE = `import { board, env, github, linear } from 'muster'

export default board({
  sync: {
    gh: github({ secret: env('${GH}'), repos: { 'acme/web': 'web' } }),
    lin: linear({ secret: env('${LIN}'), teams: { ENG: 'eng' } }),
  },
})
`

function moduleFolder(source = MODULE) {
  const dir = tempDir()
  mkdirSync(join(dir, 'config'), { recursive: true })
  const path = join(dir, 'board.ts')
  writeFileSync(path, source)
  return { dir, path }
}

describe('mu with a module that declares sync', () => {
  it('mu serve takes a signed GitHub webhook and a Linear one for the module\'s sync', async () => {
    const { dir, path } = moduleFolder()
    const serving = cliStart(dir, ['serve', '--module', path, '--port', '0', '--print-token'], { [GH]: 'gh-secret', [LIN]: 'lin-secret' })
    closers.push(async () => {
      serving.child.kill('SIGTERM')
      await serving.done
    })
    await until(() => serving.output().includes('MUSTER_TOKEN=') || serving.child.exitCode !== null)
    const url = /MUSTER_URL=(\S+)/.exec(serving.output())![1]!
    const token = /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]!
    const post = (key: string, hook: { headers: Record<string, string>; body: string }) => fetch(`${url}/webhooks/${key}`, { method: 'POST', headers: hook.headers, body: hook.body })
    expect((await post('gh', githubHook('wrong', 1, 'forged'))).status).toBe(401)
    expect((await post('gh', githubHook('gh-secret', 2, 'through mu serve'))).status).toBe(200)
    expect((await post('lin', linearHook('lin-secret', 'iss-2', 'Linear through mu serve'))).status).toBe(200)
    const read = async (channel: string) => {
      const res = await fetch(`${url}/readChannel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [{ channel }] }) })
      return ((await res.json()) as { ok: { threads: { message: { text: string } }[] } }).ok.threads.map((thread) => thread.message.text)
    }
    expect(await read('web')).toEqual(['through mu serve'])
    expect(await read('eng')).toEqual(['Linear through mu serve'])
  })

  it('a module sync beside a sync.json is refused: mu serve exits 2, mu daemon run says so and exits 0', async () => {
    const { dir, path } = moduleFolder()
    writeFileSync(join(dir, 'config', 'sync.json'), '{}')
    const vars = { [GH]: 'gh-secret', [LIN]: 'lin-secret' }
    const served = await cli(dir, ['serve', '--module', path, '--port', '0'], { env: vars })
    expect(served.code).toBe(2)
    expect(served.stderr).toContain(`${path} declares sync (gh, lin), and ${join(dir, 'config', 'sync.json')} is there too.`)
    const ran = await cli(dir, ['daemon', 'run', '--module', path], { env: vars })
    expect(ran.code).toBe(0)
    expect(ran.stderr).toContain('declares sync (gh, lin)')
    expect(ran.stdout).not.toContain('board ')
  })

  it('mu daemon run with a variable unset says which, and exits 0 so the service stays stopped', async () => {
    const { dir, path } = moduleFolder()
    const ran = await cli(dir, ['daemon', 'run', '--module', path], { env: { [LIN]: 'lin-secret' } })
    expect(ran.code).toBe(0)
    expect(ran.stderr).toContain(`error: ${GH} isn't set, and sync "gh" needs it.`)
  })

  it('mu daemon status lists the sync keys, with the variables unset: the module loads without them', async () => {
    const { dir, path } = moduleFolder()
    const shown = await cli(dir, ['daemon', 'status', '--module', path, '--json'])
    expect(shown.code).toBe(0)
    const status = JSON.parse(shown.stdout) as { module: { sync: unknown[] } }
    expect(status.module.sync).toEqual([
      { key: 'gh', type: 'github', env: [GH], holder: null },
      { key: 'lin', type: 'linear', env: [LIN], holder: null },
    ])
    expect((await cli(dir, ['daemon', 'status', '--module', path])).stdout).toContain(`sync      gh  github  reads ${GH}  not running`)
  })

  it("the docs' module loads as written, with none of its variables set", async () => {
    const page = readFileSync(new URL('../docs/02-sync/01-overview.md', import.meta.url), 'utf8')
    const example = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((block) => block[1]!).find((block) => block.includes('env('))!
    expect(example).toBeDefined()
    const { dir, path } = moduleFolder(example)
    const shown = await cli(dir, ['daemon', 'status', '--module', path, '--json'])
    expect(shown.stderr).toBe('')
    expect((JSON.parse(shown.stdout) as { module: { sync: { key: string }[] } }).module.sync.map((each) => each.key)).toEqual(['gh', 'lin', 'chat'])
  })
})
