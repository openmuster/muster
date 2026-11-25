// `mu serve` and `mu daemon` run a board module: a TypeScript file that exports a board() with its
// watchers, loaded with one copy of muster in the process, whether the module has a muster of its own or not.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { board } from '../src/index.ts'
import { COPY } from '../src/handle.ts'
import { cli, cliStart, tempDir, type Ran } from './helpers.ts'

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

const envOf = (dir: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...extra })

/** Starts a command with the built CLI, or with node on a file, and leaves it running. */
function start(dir: string, args: string[], extra: Record<string, string> = {}, cwd?: string) {
  const child = spawn(process.execPath, args, { env: envOf(dir, extra), stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
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

  it('a module says which board it is: --dir, --board or --url beside it is misuse, the default module too', async () => {
    const dir = folder(INTAKE)
    const named = await cli(dir, ['serve', '--port', '0', '--module', join(dir, 'config', 'board.ts'), '--dir', dir, '--json'])
    expect([named.code, JSON.parse(named.stderr).error.reason]).toEqual([2, 'module_and_board'])
    const implicit = await cli(dir, ['daemon', 'run', '--board', 'other', '--json'])
    expect([implicit.code, JSON.parse(implicit.stderr).error.reason]).toEqual([2, 'module_and_board'])
    expect(JSON.parse(implicit.stderr).error.message).toContain(`${join(dir, 'config', 'board.ts')} is there, so it is the board module`)
    const remote = await cli(dir, ['daemon', 'status', '--url', 'http://127.0.0.1:1', '--json'])
    expect([remote.code, JSON.parse(remote.stderr).error.reason]).toEqual([2, 'module_and_board'])
    // The commands that never load one take the flags as ever.
    expect((await cli(dir, ['daemon', 'uninstall', '--board', 'other'], { env: { MUSTER_LAUNCHCTL: 'false' } })).code).toBe(0)
  }, 30_000)

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
    expect(json.module).toEqual({ path: join(dir, 'config', 'board.ts'), watchers: [{ name: 'intake', tail: { channel: 'features', root: true }, as: 'intake', holder: expect.stringContaining(':'), lag: expect.any(Number) }] })
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
    expect([ended.code, ended.stderr]).toEqual([0, ''])
  }, 60_000)
})
