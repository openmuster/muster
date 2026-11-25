// `mu serve` and `mu daemon` run a board module: a TypeScript file that exports a board() with its
// watchers, loaded with one copy of muster in the process, whether the module has a muster of its own or not.
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { board, file } from '../src/index.ts'
import { COPY } from '../src/handle.ts'
import { RESTART_LIMIT, begin, guardPath } from '../src/daemon/guard.ts'
import { BIN, cli as anyCli, cliStart as anyStart, tempDir, type Ran } from './helpers.ts'

const PACKAGE = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const VERSION = (JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { version: string }).version
const BUILT = join(PACKAGE, 'dist', 'cli.js')

// A board whose thread reads always fail with `not_found`, thrown with the Failure the module imported.
const NOT_FOUND = `import { board, file, Failure } from 'muster'
import type { Board } from 'muster'
const backend = file()
const team: Board = board({ backend: { ...backend, readThread: async () => { throw new Failure('not_found', 'No thread here.') } } })
export default team
`

// A watcher that answers each new thread in "features", as the profile "intake".
const INTAKE = `import { board } from 'muster'
export const team = board({
  watch: {
    intake: {
      tail: { channel: 'features', root: true },
      as: 'intake',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted') await board.reply({ to: event.message.id, text: 'Started' })
      },
    },
  },
})
`

// The default module runs only for the board nothing named, so these commands name none: no MUSTER_DIR,
// and the board is the one under the test's HOME, ~/.muster/main.db.
const UNNAMED = { MUSTER_DIR: undefined } as unknown as Record<string, string>
/** Everything a test starts, stopped after it whatever happened, so a test that times out leaves nothing running. */
const running = new Set<ChildProcess>()
afterEach(() => {
  for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  running.clear()
})
const cli = (dir: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) => anyCli(dir, args, { ...options, env: { ...UNNAMED, ...options.env } })
function cliStart(dir: string, args: string[], extra: Record<string, string> = {}) {
  const started = anyStart(dir, args, { ...UNNAMED, ...extra })
  running.add(started.child)
  return started
}
const boardDir = (dir: string) => join(dir, '.muster')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Waited for, not timed: on a busy machine a daemon takes longer to start and to deliver. */
async function until(done: () => boolean | Promise<boolean>, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return
  throw new Error('waited too long')
}

/** A folder for one test, with the default module in its config folder when given one. */
function folder(defaultModule?: string) {
  const dir = tempDir()
  mkdirSync(join(dir, 'config'), { recursive: true })
  if (defaultModule !== undefined) writeFileSync(join(dir, 'config', 'board.ts'), defaultModule)
  return dir
}

/** Another install of this muster (the built one), in a project's node_modules. */
function install(project: string, edit: (json: Record<string, unknown>) => void = () => {}) {
  if (!existsSync(BUILT)) throw new Error('build first: pnpm build')
  const root = join(project, 'node_modules', 'muster')
  mkdirSync(root, { recursive: true })
  cpSync(join(PACKAGE, 'dist'), join(root, 'dist'), { recursive: true })
  const json = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>
  edit(json)
  writeFileSync(join(root, 'package.json'), JSON.stringify(json))
  return realpathSync(root)
}

const envOf = (dir: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: dir, MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...extra })

/** Starts a command with the built CLI, or with node on a file, and leaves it running. */
function start(dir: string, args: string[], extra: Record<string, string> = {}, cwd?: string) {
  const child = spawn(process.execPath, args, { env: envOf(dir, extra), stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
  running.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise<Ran>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, done, output: () => stdout, errors: () => stderr }
}

/** Serves the module, asks for a thread with a raw request, and says what the server answered. */
async function serve(dir: string, args: string[] = [], options: { built?: boolean } = {}) {
  const serving = options.built ? start(dir, [BUILT, 'serve', '--port', '0', '--print-token', ...args]) : cliStart(dir, ['serve', '--port', '0', '--print-token', ...args])
  await until(() => serving.output().includes('MUSTER_TOKEN=') || serving.child.exitCode !== null).catch(() => {})
  const url = /MUSTER_URL=(\S+)/.exec(serving.output())?.[1]
  const token = /MUSTER_TOKEN=(\S+)/.exec(serving.output())?.[1]
  if (!url || !token) {
    serving.child.kill('SIGTERM')
    const ran = await serving.done
    throw new Error(`mu serve didn't start: ${ran.stdout}${ran.stderr}`)
  }
  const res = await fetch(`${url}/readThread`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [{ id: 999 }] }) })
  const body = (await res.json()) as { error: { reason: string; message: string } }
  serving.child.kill('SIGTERM')
  const ran = await serving.done
  // The module's own words when its Failure was recognised; the server's generic 500 text when it wasn't.
  return { status: res.status, reason: body.error.reason, said: body.error.message, stdout: ran.stdout, stderr: ran.stderr, code: ran.code }
}

type Status = { module: { path: string; error?: { reason: string }; watchers: { name: string; tail: unknown; as: string | null; holder: string | null; lag: number | null }[] } | null }
const status = async (dir: string, args: string[] = []) => JSON.parse((await cli(dir, ['daemon', 'status', '--json', ...args])).stdout) as Status

/** The replies in a thread, by text. */
const replies = async (dir: string, id: number) => (JSON.parse((await cli(dir, ['read', String(id), '--json'])).stdout) as { replies: { text: string }[] }).replies.map((reply) => reply.text)
const post = async (dir: string, channel: string, text: string) => (JSON.parse((await cli(dir, ['post', channel, text, '--json'])).stdout) as { message: { id: number } }).message.id

describe('a board module', () => {
  it('a handle lists the watchers it declares, and carries the copy of muster that made it', () => {
    const run = async () => {}
    const team = board({ memory: true, watch: { lead: { tail: { channel: 'work/' }, as: 'lead', run }, intake: { tail: { channel: 'features', root: true }, run } } })
    expect(team.watchers).toEqual([
      { name: 'lead', tail: { channel: 'work/' }, as: 'lead' },
      { name: 'intake', tail: { channel: 'features', root: true }, as: null },
    ])
    expect(Object.isFrozen(team.watchers)).toBe(true)
    expect((team as unknown as Record<symbol, unknown>)[Symbol.for('muster.copy')]).toBe(COPY)
    expect((team.as('lead') as unknown as Record<symbol, unknown>)[Symbol.for('muster.copy')]).toBe(COPY)
    expect(board({ memory: true }).watchers).toEqual([])
    team.close()
  })

  it('a bare ~/.config/muster/board.ts, with no package.json or node_modules, is what a plain mu serve serves, and its not_found is a 404', async () => {
    const dir = folder(NOT_FOUND)
    const served = await serve(dir)
    expect(served.stdout).toContain(`module ${join(dir, 'config', 'board.ts')}  muster ${VERSION} ${PACKAGE}\n`)
    expect([served.status, served.reason, served.said, served.code]).toEqual([404, 'not_found', 'No thread here.', 0])
  }, 30_000)

  it('the built mu answers a bare module with its own copy too: its not_found is a 404, not a 500', async () => {
    const dir = folder(NOT_FOUND)
    const served = await serve(dir, [], { built: true })
    expect([served.status, served.reason, served.said, served.code]).toEqual([404, 'not_found', 'No thread here.', 0])
  }, 30_000)

  it('a module whose project has its own muster runs on that install: the same pid becomes its mu, and not_found is still a 404', async () => {
    const dir = folder()
    const project = join(dir, 'project')
    const theirs = install(project)
    writeFileSync(join(project, 'board.ts'), NOT_FOUND)
    const served = await serve(dir, ['--module', join(project, 'board.ts')])
    // Loaded into this copy instead, its Failure is not this server's, and the answer is a 500.
    expect([served.status, served.reason, served.said, served.code]).toEqual([404, 'not_found', 'No thread here.', 0])
    expect(served.stdout).toContain(`muster ${VERSION} ${theirs}\n`)
  }, 30_000)

  it('a project whose muster cannot run a module is refused, naming both versions', async () => {
    const dir = folder()
    const project = join(dir, 'project')
    install(project, (json) => {
      delete json.musterModule
      json.version = '0.1.0'
    })
    writeFileSync(join(project, 'board.ts'), NOT_FOUND)
    const ran = await cli(dir, ['daemon', 'check', 'x', '--module', join(project, 'board.ts'), '--json'])
    const error = JSON.parse(ran.stderr).error as { reason: string; message: string }
    expect([ran.code, error.reason]).toEqual([1, 'module_version_skew'])
    expect(error.message).toContain('muster 0.1.0')
    expect(error.message).toContain(`This mu is ${VERSION}`)
  }, 30_000)

  it('a board made by a second copy of muster is refused, not served with a Failure class the server does not know', async () => {
    const dir = folder()
    const vendored = install(join(dir, 'vendor'))
    writeFileSync(join(dir, 'board.ts'), `import { board } from '${join(vendored, 'dist', 'index.js')}'\nexport default board()\n`)
    const ran = await cli(dir, ['daemon', 'check', 'x', '--module', join(dir, 'board.ts'), '--json'])
    expect([ran.code, JSON.parse(ran.stderr).error.reason]).toEqual([1, 'module_two_copies'])
  }, 30_000)

  it.each([
    ['an enum', `import { board } from 'muster'\nenum Kind { A }\nexport default board()\n`, /no enums, namespaces or parameter properties/],
    ['a type imported without import type', `import { board, Board } from 'muster'\nconst team: Board = board()\nexport default team\n`, /import type/],
    ['a file of its own imported without .ts', `import { board } from 'muster'\nimport { x } from './lib'\nexport default board()\n`, /with \.ts/],
    ['no board', `export default 1\n`, /export default board/],
    ['a watcher that is wrong', `import { board } from 'muster'\nexport default board({ watch: { lead: { tail: { chanel: 'x' }, run: () => {} } } })\n`, /Watcher "lead" has "chanel" in its tail/],
  ])('a module with %s fails to load, and says what to change', async (_, source, said) => {
    const dir = folder()
    writeFileSync(join(dir, 'lib.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'board.ts'), source)
    const ran = await cli(dir, ['daemon', 'check', 'x', '--module', join(dir, 'board.ts')])
    expect(ran.code).toBe(1)
    expect(ran.stderr).toMatch(said)
  }, 30_000)

  it('a module named on purpose says which board it is: --dir, --board or --url beside it is misuse', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'intake.ts'), INTAKE)
    const flagged = await cli(dir, ['serve', '--port', '0', '--module', join(dir, 'intake.ts'), '--dir', dir, '--json'])
    expect([flagged.code, JSON.parse(flagged.stderr).error.reason]).toEqual([2, 'module_and_board'])
    const set = await cli(dir, ['daemon', 'status', '--url', 'http://127.0.0.1:1', '--json'], { env: { MUSTER_MODULE: join(dir, 'intake.ts') } })
    expect([set.code, JSON.parse(set.stderr).error.reason]).toEqual([2, 'module_and_board'])
    // MUSTER_DIR and MUSTER_BOARD beside a module named on purpose are the module's to read.
    expect((await status(dir, ['--module', join(dir, 'intake.ts')])).module?.watchers.map((watcher) => watcher.name)).toEqual(['intake'])
  }, 30_000)

  it('the default module is only for the board nothing named: a board named by flag or environment runs as before', async () => {
    const dir = folder(INTAKE)
    for (const [args, env] of [[['--board', 'work'], {}], [['--dir', join(dir, 'elsewhere')], {}], [[], { MUSTER_BOARD: 'work' }], [[], { MUSTER_DIR: join(dir, 'elsewhere') }]] as const) {
      const shown = await cli(dir, ['daemon', 'status', '--json', ...args], { env })
      expect([shown.code, JSON.parse(shown.stdout).module]).toEqual([0, null])
    }
    // An installed daemon's plist names its board: it keeps ticking that board, and says why the module isn't run.
    const daemon = cliStart(dir, ['daemon', 'run'], { MUSTER_BOARD: 'work' })
    await until(() => /^watchers {2}0$/m.test(daemon.output()))
    daemon.child.kill('SIGTERM')
    const ended = await daemon.done
    expect(ended.stdout).toContain(`board     ${join(boardDir(dir), 'work.db')}\n`)
    expect(ended.stdout).not.toContain('module ')
    expect(ended.stderr).toBe(`info: ${join(dir, 'config', 'board.ts')} isn't run: MUSTER_BOARD chose the board. Pass --module to run it.\n`)
  }, 30_000)

  it('--no-module runs none; with --module it is misuse', async () => {
    const dir = folder(INTAKE)
    expect((await status(dir, ['--no-module'])).module).toBeNull()
    expect((await status(dir)).module?.path).toBe(join(dir, 'config', 'board.ts'))
    const both = await cli(dir, ['daemon', 'status', '--no-module', '--module', join(dir, 'config', 'board.ts'), '--json'])
    expect([both.code, JSON.parse(both.stderr).error.reason]).toEqual([2, 'module_and_no_module'])
  }, 30_000)

  it('--as or MUSTER_PROFILE beside a module is refused, not ignored', async () => {
    const dir = folder(INTAKE)
    const flagged = await cli(dir, ['daemon', 'status', '--as', 'lead', '--json'])
    expect([flagged.code, JSON.parse(flagged.stderr).error.reason]).toEqual([2, 'module_and_profile'])
    const set = await cli(dir, ['daemon', 'run', '--json'], { env: { MUSTER_PROFILE: 'lead' } })
    expect([set.code, JSON.parse(set.stderr).error.reason]).toEqual([2, 'module_and_profile'])
  }, 30_000)

  it('a relative MUSTER_MODULE is refused: it would be another file in every folder', async () => {
    const dir = folder()
    const ran = await cli(dir, ['daemon', 'status', '--json'], { env: { MUSTER_MODULE: 'board.ts' } })
    expect([ran.code, JSON.parse(ran.stderr).error.reason]).toEqual([2, 'module_not_absolute'])
  })

  it('mu daemon run on a module that fails to load says so loudly and exits 0, so a service manager leaves it stopped', async () => {
    const dir = folder(`import { board } from 'muster'\nenum Kind { A }\nexport default board()\n`)
    const ran = await cli(dir, ['daemon', 'run'])
    expect(ran.code).toBe(0)
    expect(ran.stderr).toMatch(/^error: board module not loaded: .*board\.ts failed to load: .*\n {2}A board module runs with Node's type stripping/)
    expect(ran.stderr).toContain('The daemon has stopped.')
    // So is a module that names nothing, or a project that can't run one: a restart fixes none of them.
    const missing = await cli(dir, ['daemon', 'run'], { env: { MUSTER_MODULE: join(dir, 'gone.ts') } })
    expect([missing.code, missing.stderr]).toEqual([0, expect.stringMatching(/^error: board module not loaded: There is no board module at .*gone\.ts\./)])
  }, 30_000)

  it('mu serve on a module that fails to load serves the board anyway, with a loud error', async () => {
    const dir = folder(`import { board } from 'muster'\nthrow new Error('the module blew up')\nexport default board()\n`)
    const served = await serve(dir)
    expect(served.stderr).toMatch(/^error: board module not loaded: .*board\.ts failed to load: the module blew up\n/m)
    expect(served.stderr).toContain("none of its watchers run until it is fixed and the server restarted")
    // The board itself answers: a thread that isn't there is the board's own 404.
    expect([served.status, served.reason, served.code]).toEqual([404, 'not_found', 0])
    expect(served.stdout).not.toContain('module ')
  }, 30_000)

  it("mu daemon run runs the module's watchers beside the ones in watchers.json, and status shows each one's tail, holder and lag", async () => {
    const dir = folder(INTAKE)
    const marker = join(dir, 'woke')
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'lead', tail: { channel: 'work/' }, run: ['sh', '-c', `echo "$MUSTER_THREAD" >> ${marker}`], every: 1 }] }))
    await post(dir, 'general', 'board exists')
    // Declared, and nothing runs it yet.
    const idle = await cli(dir, ['daemon', 'status'])
    expect(idle.stdout).toContain(`module    ${join(dir, 'config', 'board.ts')}\n`)
    expect(idle.stdout).toContain('watch     intake  channel=features root=true  as intake  not running  not started\n')
    expect(idle.stdout).toContain('warning   declared but not started: intake.')
    const daemon = cliStart(dir, ['daemon', 'run'])
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    expect(daemon.output()).toContain(`module    ${join(dir, 'config', 'board.ts')}  muster ${VERSION} ${PACKAGE}\nwatchers  1\nwatching  intake\n`)
    const feature = await post(dir, 'features', 'dark mode')
    const work = await post(dir, 'work/api', 'needs a look')
    await until(async () => (await replies(dir, feature)).includes('Started'))
    await until(() => existsSync(marker))
    const running = await cli(dir, ['daemon', 'status'])
    expect(running.stdout).toMatch(/^watch {5}intake {2}channel=features root=true {2}as intake {2}held by \S+:\d+:[0-9a-f]+ {2}lag \d+$/m)
    expect(running.stdout).not.toContain('declared but not started')
    const json = await status(dir)
    expect(json.module).toEqual({ path: join(dir, 'config', 'board.ts'), watchers: [{ name: 'intake', tail: { channel: 'features', root: true }, as: 'intake', holder: expect.stringContaining(':'), lag: expect.any(Number) }], sync: [] })
    daemon.child.kill('SIGTERM')
    expect((await daemon.done).code).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe(`${work}\n`)
    expect(await replies(dir, feature)).toEqual(['Started'])
    // Stopped cleanly, it let go of the watcher's lease.
    expect((await status(dir)).module!.watchers[0]!.holder).toBeNull()
  }, 60_000)

  it("mu serve runs the module's watchers too", async () => {
    const dir = folder(INTAKE)
    await post(dir, 'general', 'board exists')
    const serving = cliStart(dir, ['serve', '--port', '0'])
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    const feature = await post(dir, 'features', 'dark mode')
    await until(async () => (await replies(dir, feature)).includes('Started'))
    serving.child.kill('SIGTERM')
    expect((await serving.done).code).toBe(0)
  }, 60_000)

  it('mu daemon check works on a module watcher, and says when it is declared but not started', async () => {
    const dir = folder(INTAKE)
    await post(dir, 'general', 'board exists')
    const idle = await cli(dir, ['daemon', 'check', 'intake', '--json'])
    expect([idle.code, JSON.parse(idle.stderr).error.reason]).toEqual([1, 'watcher_not_running'])
    const daemon = cliStart(dir, ['daemon', 'run'])
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    const checked = await cli(dir, ['daemon', 'check', 'intake', '--timeout', '30s'])
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect([checked.code, checked.stdout]).toEqual([0, expect.stringMatching(/^answered {2}#\d+ {2}by .*intake.* {2}in /)])
  }, 60_000)

  it("mu daemon check on a module watcher says a daemon the restart guard stopped is why nothing runs it", async () => {
    const dir = folder(INTAKE)
    await post(dir, 'general', 'board exists')
    const record = join(dir, 'config', 'daemon', basename(guardPath('main', join(boardDir(dir), 'main.db'))))
    for (let i = 0; i < RESTART_LIMIT; i++) begin(record, Date.now() + i)
    const checked = await cli(dir, ['daemon', 'check', 'intake', '--json'])
    expect([checked.code, JSON.parse(checked.stderr).error.reason, JSON.parse(checked.stderr).error.next]).toEqual([1, 'daemon_stopped', ['mu daemon reset']])
  }, 30_000)

  it('mu daemon status on a module that fails to load still says how the daemon is, and what is wrong with the module', async () => {
    const dir = folder(`export default 1\n`)
    const shown = await cli(dir, ['daemon', 'status'])
    expect(shown.code).toBe(0)
    expect(shown.stdout).toMatch(/^service {3}not installed$/m)
    expect(shown.stdout).toContain(`module    ${join(dir, 'config', 'board.ts')}  not loaded: ${join(dir, 'config', 'board.ts')} exports no board.\n`)
    const json = await cli(dir, ['daemon', 'status', '--json'])
    expect(JSON.parse(json.stdout).module).toMatchObject({ path: join(dir, 'config', 'board.ts'), error: { reason: 'module_not_a_board' }, watchers: [] })
  }, 30_000)

  it('--module wins over MUSTER_MODULE, which wins over the default file', async () => {
    const dir = folder(`export default 1\n`)
    writeFileSync(join(dir, 'intake.ts'), INTAKE)
    const flagged = JSON.parse((await cli(dir, ['daemon', 'status', '--json', '--module', join(dir, 'intake.ts')], { env: { MUSTER_MODULE: join(dir, 'gone.ts') } })).stdout) as Status
    expect([flagged.module?.path, flagged.module?.error]).toEqual([join(dir, 'intake.ts'), undefined])
    const set = JSON.parse((await cli(dir, ['daemon', 'status', '--json'], { env: { MUSTER_MODULE: join(dir, 'intake.ts') } })).stdout) as Status
    expect([set.module?.path, set.module?.error]).toEqual([join(dir, 'intake.ts'), undefined])
  }, 30_000)

  it("with a module, sync.json isn't read, and mu says so", async () => {
    const dir = folder(INTAKE)
    writeFileSync(join(dir, 'config', 'sync.json'), '{}')
    const shown = await cli(dir, ['daemon', 'status'])
    expect(shown.stderr).toBe(`warning: ${join(dir, 'config', 'sync.json')} isn't read with a board module: nothing it lists is synced. Give the module's board() its sync instead.\n`)
  }, 30_000)

  it("mu serve on a module whose watcher clashes with watchers.json serves the board, and doesn't run the module's watchers", async () => {
    const dir = folder(INTAKE)
    writeFileSync(join(dir, 'config', 'watchers.json'), JSON.stringify({ watchers: [{ name: 'intake', tail: {}, run: ['true'] }] }))
    const served = await serve(dir)
    expect(served.stderr).toContain(`error: A watcher in ${join(dir, 'config', 'board.ts')} and a watcher in ${join(dir, 'config', 'watchers.json')} are both named "intake".\n  The module's watchers don't run`)
    expect([served.status, served.code]).toEqual([404, 0])
  }, 30_000)

  it("mu daemon run stays up for the module's watchers when another process ticks", async () => {
    const dir = folder(INTAKE)
    await post(dir, 'general', 'board exists')
    const other = file({ dir: boardDir(dir) })
    await other.leases!.take({ name: 'tick', holder: 'other-host', ttl: 600_000 })
    const daemon = cliStart(dir, ['daemon', 'run'])
    // A holder that doesn't renew is waited out for as long as a lease lasts, before it counts as alive.
    await until(() => daemon.output().includes('another process already ticks for this board'), 60_000)
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    const feature = await post(dir, 'features', 'dark mode')
    await until(async () => (await replies(dir, feature)).includes('Started'))
    expect(daemon.child.exitCode).toBeNull()
    daemon.child.kill('SIGTERM')
    expect((await daemon.done).code).toBe(0)
    other.close()
  }, 120_000)

  it.each([
    ['watcher', 'watchers.json', { watchers: [{ name: 'intake', tail: {}, run: ['true'] }] }],
    ['hook', 'hooks.json', { hooks: [{ name: 'intake', url: 'https://example.com/hook', secret: 'env:HOOK_SECRET', tail: {} }] }],
    ['workflow', 'workflows.json', { workflows: [{ name: 'intake', description: 'd', who: ['ada'], channels: ['general'], steps: [{ key: 'a', text: 'A' }], workers: { count: 1, agent: 'claude', as: 'worker', cwd: '/srv/app' } }] }],
  ])("a module watcher named like a %s in the config files is refused when the module is loaded", async (kind, name, config) => {
    const dir = folder(INTAKE)
    writeFileSync(join(dir, 'config', name), JSON.stringify(config))
    const said = `A watcher in ${join(dir, 'config', 'board.ts')} and a ${kind} in ${join(dir, 'config', name)} are both named "intake".`
    const run = await cli(dir, ['daemon', 'run'])
    expect([run.code, run.stderr]).toEqual([0, expect.stringContaining(`error: ${said}`)])
    const shown = await cli(dir, ['daemon', 'status', '--json'])
    expect([shown.code, JSON.parse(shown.stderr).error.message]).toEqual([1, said])
  }, 30_000)

  it('mu daemon install records the module by its absolute path, the default one too, and the folder it was installed from', async () => {
    const dir = folder(INTAKE)
    const fake = join(dir, 'launchctl')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const installed = await cli(dir, ['daemon', 'install', '--json'], { env: { MUSTER_LAUNCHCTL: fake } })
    expect(installed.code).toBe(0)
    const plist = readFileSync(join(dir, 'Library', 'LaunchAgents', 'dev.muster.daemon.main.plist'), 'utf8')
    expect(plist).toMatch(new RegExp(`<string>run</string>\\s*<string>--module</string>\\s*<string>${join(dir, 'config', 'board.ts')}</string>`))
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${process.cwd()}</string>`)
    expect(JSON.parse(installed.stdout)).toMatchObject({ module: join(dir, 'config', 'board.ts'), cwd: process.cwd() })
  }, 30_000)
})

/** A launchctl that does nothing, for install. */
function fakeLaunchctl(dir: string) {
  const fake = join(dir, 'launchctl')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { MUSTER_LAUNCHCTL: fake }
}

/** A project with its own muster (the built one) and a module in it. */
function project(dir: string, source = INTAKE, edit?: (json: Record<string, unknown>) => void) {
  const root = join(dir, 'project')
  const muster = install(root, edit)
  writeFileSync(join(root, 'board.ts'), source)
  return { module: join(root, 'board.ts'), muster }
}

/** The pid in a lease holder's ID: machine, pid, random. */
const pidOf = (holder: string | null | undefined) => Number(/:(\d+):[0-9a-f]+$/.exec(holder ?? '')?.[1])

describe('a daemon on a board module, as a service', () => {
  it('install names the service for the board the module opens, so two modules for two boards never share one', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'a.ts'), `import { board } from 'muster'\nexport default board({ name: 'work' })\n`)
    writeFileSync(join(dir, 'b.ts'), `import { board } from 'muster'\nexport default board({ dir: '${join(dir, 'elsewhere')}', name: 'work' })\n`)
    const env = fakeLaunchctl(dir)
    const a = JSON.parse((await cli(dir, ['daemon', 'install', '--module', join(dir, 'a.ts'), '--json'], { env })).stdout) as { installed: string; log: string }
    const b = JSON.parse((await cli(dir, ['daemon', 'install', '--module', join(dir, 'b.ts'), '--json'], { env })).stdout) as { installed: string; log: string }
    expect(basename(a.installed)).toBe('dev.muster.daemon.work.plist')
    expect(basename(b.installed)).toMatch(/^dev\.muster\.daemon\.work-[0-9a-f]{8}\.plist$/)
    expect(basename(a.log)).toBe('daemon-work.log')
    // Its restart guard is the board's too.
    const daemon = cliStart(dir, ['daemon', 'run', '--module', join(dir, 'a.ts')])
    await until(() => /^watchers {2}0$/m.test(daemon.output()))
    daemon.child.kill('SIGTERM')
    await daemon.done
    expect(existsSync(join(dir, 'config', 'daemon', basename(guardPath('work', join(boardDir(dir), 'work.db')))))).toBe(true)
  }, 30_000)

  it('a project whose muster crashes is a start that counts: after five, it stops restarting instead of looping under launchd', async () => {
    const dir = folder()
    const { module } = project(dir)
    writeFileSync(join(dir, 'project', 'node_modules', 'muster', 'dist', 'cli.js'), 'process.exit(1)\n')
    for (let i = 1; i < RESTART_LIMIT; i++) expect((await cli(dir, ['daemon', 'run', '--module', module])).code).toBe(1)
    const parked = start(dir, [BIN, 'daemon', 'run', '--module', module])
    await until(() => parked.errors().includes('stopped restarting'))
    await sleep(500)
    expect(parked.child.exitCode).toBeNull()
    parked.child.kill('SIGTERM')
    expect((await parked.done).code).toBe(0)
    // reset never execs into the broken install, and clears the count.
    const reset = await cli(dir, ['daemon', 'reset', '--module', module], { env: fakeLaunchctl(dir) })
    expect(reset.stdout).toMatch(/^reset {5}stopped since /)
    expect((await cli(dir, ['daemon', 'run', '--module', module])).code).toBe(1)
  }, 60_000)

  it("a project whose muster has no mu, or one outside its package, is refused: daemon run says so and exits 0", async () => {
    const dir = folder()
    const { module, muster } = project(dir)
    rmSync(join(muster, 'dist', 'cli.js'))
    const ran = await cli(dir, ['daemon', 'run', '--module', module])
    expect([ran.code, ran.stderr]).toEqual([0, expect.stringMatching(/^error: board module not loaded: .*board\.ts has muster \S+ at .*, and its mu isn't there\.\n/)])
    const outside = folder()
    writeFileSync(join(outside, 'elsewhere.js'), 'process.exit(1)\n')
    const other = project(outside, INTAKE, (json) => {
      json.bin = { mu: '../../../elsewhere.js' }
    })
    expect((await status(outside, ['--module', other.module])).module?.error).toMatchObject({ reason: 'module_broken_install' })
  }, 30_000)

  it("install records the mu that was run, not the project's it re-exec'd into, so the service survives that install going", async () => {
    const dir = folder()
    const { module, muster } = project(dir)
    const installed = await cli(dir, ['daemon', 'install', '--module', module, '--json'], { env: fakeLaunchctl(dir) })
    const plist = readFileSync((JSON.parse(installed.stdout) as { installed: string }).installed, 'utf8')
    expect(plist).toContain(`<string>${realpathSync(BIN)}</string>`)
    expect(plist).not.toContain(muster)
    // The project's muster goes; the service runs the same line, and stops cleanly saying why.
    rmSync(join(muster, 'dist'), { recursive: true })
    const ran = await cli(dir, ['daemon', 'run', '--module', module])
    expect([ran.code, ran.stderr]).toEqual([0, expect.stringContaining("its mu isn't there")])
  }, 30_000)

  it('a mu exec\'d once never execs again: a second hop is refused as two copies', async () => {
    const dir = folder()
    const { module } = project(dir)
    for (const env of [{ MUSTER_REEXEC_DEPTH: '1' }, { MUSTER_REEXEC: '/somewhere/cli.js' }] as Record<string, string>[]) {
      expect((await status(dir, ['--module', module]).catch(() => null))?.module).toMatchObject({ path: module })
      const shown = JSON.parse((await cli(dir, ['daemon', 'status', '--json', '--module', module], { env })).stdout) as Status
      expect(shown.module?.error).toMatchObject({ reason: 'module_two_copies' })
    }
  }, 30_000)

  it("what a re-exec'd daemon starts doesn't inherit the re-exec: its watchers see no MUSTER_REEXEC*, and it keeps its pid", async () => {
    const dir = folder()
    const marker = join(dir, 'env.json')
    const { module } = project(dir, `import { board } from 'muster'
import { writeFileSync } from 'node:fs'
export default board({ watch: { seen: { tail: { channel: 'features' }, as: 'seen', run: () => writeFileSync('${marker}', JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith('MUSTER_REEXEC') || key === 'MUSTER_LAUNCH'))) } } })
`)
    await post(dir, 'general', 'board exists')
    const daemon = start(dir, [BIN, 'daemon', 'run', '--module', module])
    await until(async () => (await status(dir, ['--module', module])).module?.watchers[0]?.lag === 0)
    expect(pidOf((await status(dir, ['--module', module])).module?.watchers[0]?.holder)).toBe(daemon.child.pid)
    await post(dir, 'features', 'dark mode')
    await until(() => existsSync(marker))
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual([])
  }, 60_000)

  it('without exec, a child stands in: signals go to it, and its death by a signal is 128 and the number', async () => {
    const dir = folder()
    const { module } = project(dir)
    await post(dir, 'general', 'board exists')
    const daemon = start(dir, [BIN, 'daemon', 'run', '--module', module], { MUSTER_NO_EXECVE: '1' })
    await until(async () => (await status(dir, ['--module', module])).module?.watchers[0]?.lag === 0)
    const child = pidOf((await status(dir, ['--module', module])).module?.watchers[0]?.holder)
    expect(child).not.toBe(daemon.child.pid)
    process.kill(child, 'SIGKILL')
    expect((await daemon.done).code).toBe(137)
  }, 60_000)

  it('a daemon standing by for its watchers takes the tick over once the process that had it dies', async () => {
    const dir = folder(INTAKE)
    await post(dir, 'general', 'board exists')
    const first = start(dir, [BIN, 'daemon', 'run', '--no-module'])
    const leases = file({ dir: boardDir(dir) })
    try {
      await until(async () => pidOf((await leases.leases!.holder('tick'))?.holder) === first.child.pid)
      const second = start(dir, [BIN, 'daemon', 'run'])
      await until(() => second.output().includes('standing by'), 60_000)
      first.child.kill('SIGKILL')
      await cli(dir, ['schedule', 'general', 'due now', '--in', '1s'])
      // Within a lease (30 seconds) of the other going quiet.
      await until(async () => pidOf((await leases.leases!.holder('tick'))?.holder) === second.child.pid, 60_000)
      await until(() => second.output().includes('sent      schedule'))
    } finally {
      leases.close()
    }
  }, 150_000)

  it('daemon status reads a watcher where its host does, whatever profile the module exported, and counts only what it matches', async () => {
    const dir = folder(`import { board } from 'muster'
export default board({ watch: { failing: { tail: { channel: 'features' }, run: () => { throw new Error('not today') } } } }).as('someone')
`)
    await post(dir, 'general', 'board exists')
    const daemon = cliStart(dir, ['daemon', 'run'])
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    await post(dir, 'features', 'dark mode')
    for (const text of ['one', 'two', 'three']) await post(dir, 'general', text)
    await until(() => daemon.output().includes('failed    failing'))
    expect((await status(dir)).module?.watchers[0]?.lag).toBe(1)
  }, 60_000)

  it('daemon run stops its watchers, and lets a run in flight finish, before it closes the board', async () => {
    const dir = folder()
    const marker = join(dir, 'started')
    writeFileSync(join(dir, 'config', 'board.ts'), `import { board } from 'muster'
import { writeFileSync } from 'node:fs'
export default board({ watch: { slow: { tail: { channel: 'features' }, as: 'slow', run: async () => { writeFileSync('${marker}', ''); await new Promise((resolve) => setTimeout(resolve, 1500)) } } } })
`)
    await post(dir, 'general', 'board exists')
    const daemon = cliStart(dir, ['daemon', 'run'])
    await until(async () => (await status(dir)).module?.watchers[0]?.lag === 0)
    await post(dir, 'features', 'dark mode')
    await until(() => existsSync(marker))
    daemon.child.kill('SIGTERM')
    const ended = await daemon.done
    expect([ended.code, ended.stderr]).toEqual([0, ''])
    // Its lease was given back with the board still open: nothing holds it now.
    expect((await status(dir)).module?.watchers[0]?.holder).toBeNull()
  }, 60_000)

  it("install and check say sync.json isn't read with a module, and install says to move it into the module", async () => {
    const dir = folder(INTAKE)
    writeFileSync(join(dir, 'config', 'sync.json'), '{}')
    const said = `warning: ${join(dir, 'config', 'sync.json')} isn't read with a board module`
    const installed = await cli(dir, ['daemon', 'install'], { env: fakeLaunchctl(dir) })
    expect([installed.stderr, installed.stdout]).toEqual([expect.stringContaining(said), expect.stringContaining(`sync       ${join(dir, 'config', 'sync.json')} is not read with a board module: move its sync into the module's board()`)])
    expect((await cli(dir, ['daemon', 'check', 'intake'])).stderr).toContain(said)
  }, 30_000)

  it('the muster found for a module is the nearest node_modules above it: not NODE_PATH, and not until the module is there', async () => {
    const dir = folder()
    // A stray muster with no marker, where NODE_PATH points: never looked at.
    const stray = join(dir, 'stray')
    install(stray, (json) => {
      delete json.musterModule
    })
    writeFileSync(join(dir, 'intake.ts'), INTAKE)
    const shown = JSON.parse((await cli(dir, ['daemon', 'status', '--json', '--module', join(dir, 'intake.ts')], { env: { NODE_PATH: join(stray, 'node_modules') } })).stdout) as Status
    expect([shown.module?.error, shown.module?.watchers.map((watcher) => watcher.name)]).toEqual([undefined, ['intake']])
    // A module that isn't there is said to be missing, whatever is installed above where it would be.
    const missing = JSON.parse((await cli(stray, ['daemon', 'status', '--json', '--module', join(stray, 'gone.ts')])).stdout) as Status
    expect(missing.module?.error).toMatchObject({ reason: 'module_not_found' })
    // One above the module without the marker, or with another, is named in the refusal.
    for (const marker of [undefined, 2]) {
      const there = folder()
      const { module, muster } = project(there, INTAKE, (json) => {
        if (marker === undefined) delete json.musterModule
        else json.musterModule = marker
      })
      const error = (JSON.parse((await cli(there, ['daemon', 'status', '--json', '--module', module])).stdout) as { module: { error: { reason: string; message: string; hint: string } } }).module.error
      expect([error.reason, error.message, error.hint]).toEqual(['module_version_skew', expect.stringContaining(`at ${muster}, the first node_modules/muster above it`), expect.stringContaining(`remove ${muster}`)])
    }
  }, 60_000)
})

describe('the board modules the docs show', () => {
  const handle = readFileSync(join(PACKAGE, 'docs', '04-reference', '02-handle.md'), 'utf8')
  const blocks = (file: string) => [...handle.matchAll(/```ts ([^\n]+)\n([\s\S]*?)```/g)].filter((block) => block[1] === file).map((block) => block[2]!)

  it('there are modules to run', () => {
    expect(blocks('lib/board.ts').length).toBeGreaterThanOrEqual(2)
    expect(blocks('host.ts')).toHaveLength(1)
  })

  it('each lib/board.ts loads in mu, with the watchers it declares', async () => {
    for (const source of blocks('lib/board.ts')) {
      const dir = folder()
      mkdirSync(join(dir, 'lib'))
      writeFileSync(join(dir, 'lib', 'board.ts'), source)
      const shown = await status(dir, ['--module', join(dir, 'lib', 'board.ts')])
      const declared = [...source.matchAll(/^ {4}([a-z]+): \{$/gm)].map((match) => match[1])
      expect([shown.module?.error, shown.module?.watchers.map((watcher) => watcher.name)]).toEqual([undefined, declared])
    }
  }, 30_000)

  it('the intake watcher, run by mu daemon run, answers a new feature', async () => {
    const dir = folder()
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'board.ts'), blocks('lib/board.ts')[0]!)
    await post(dir, 'general', 'board exists')
    const daemon = cliStart(dir, ['daemon', 'run', '--module', join(dir, 'lib', 'board.ts')])
    await until(async () => (await status(dir, ['--module', join(dir, 'lib', 'board.ts')])).module?.watchers[0]?.lag === 0)
    const feature = await post(dir, 'features', 'dark mode')
    await until(async () => (await replies(dir, feature)).includes('Started'))
    daemon.child.kill('SIGTERM')
    expect((await daemon.done).code).toBe(0)
  }, 60_000)

  it("host.ts, run with node in a project that has muster installed, starts the watchers and stops on SIGTERM", async () => {
    if (!existsSync(BUILT)) throw new Error('build first: pnpm build')
    const dir = folder()
    const project = join(dir, 'project')
    mkdirSync(join(project, 'lib'), { recursive: true })
    mkdirSync(join(project, 'node_modules'))
    symlinkSync(PACKAGE, join(project, 'node_modules', 'muster'))
    writeFileSync(join(project, 'lib', 'board.ts'), blocks('lib/board.ts')[0]!)
    writeFileSync(join(project, 'host.ts'), blocks('host.ts')[0]!)
    await post(dir, 'general', 'board exists')
    // mu from source and the project's built muster are two copies: status reads the same watchers from a twin of the module.
    mkdirSync(join(dir, 'twin'))
    writeFileSync(join(dir, 'twin', 'board.ts'), blocks('lib/board.ts')[0]!)
    const host = start(dir, [join(project, 'host.ts')], {}, project)
    await until(async () => (await status(dir, ['--module', join(dir, 'twin', 'board.ts')])).module?.watchers[0]?.lag === 0)
    const feature = await post(dir, 'features', 'dark mode')
    await until(async () => (await replies(dir, feature)).includes('Started'))
    host.child.kill('SIGTERM')
    const ended = await host.done
    // Node 22 says, under plain node, that its SQLite is experimental: that is Node's line, not the host's.
    const said = ended.stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature.*\n(\(Use `node --trace-warnings \.\.\.` .*\n)?/m, '')
    expect([ended.code, said]).toEqual([0, ''])
  }, 60_000)
})
