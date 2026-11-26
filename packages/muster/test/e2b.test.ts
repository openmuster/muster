import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { claude, e2b, mint } from '../src/index.ts'
import { memoryBases } from '../src/runner/cloud.ts'
import { E2B_SECRET_KEEP_MS, PROCESSES, REAP } from '../src/runner/e2b.ts'
import { reason } from './helpers.ts'

const URL_ = 'https://board.example.com/api/board'
const NOW = Date.parse('2026-01-01T00:00:00Z')
const token = (claims: object = { sandbox: true }) => mint(randomBytes(32), { sub: 'local:user:ada', profile: 'fixer', can: { 'work/': ['read', 'post'] }, exp: 4_102_444_800, ...claims } as Parameters<typeof mint>[1])

/**
 * A stand-in for the `e2b` package: it keeps the secrets it is given, logs every call with the secrets
 * stored at that moment, and answers commands as told. A command that exits with a code is thrown, as the
 * real one does.
 */
function standIn(opts: { refuses?: string; snapshots?: boolean; gone?: string[]; unready?: boolean; left?: number; exit?: (cmd: string) => number | undefined; out?: (cmd: string) => string; agentExit?: number; full?: boolean; files?: Record<string, Buffer>; home?: string; drops?: number } = {}) {
  const log: any[] = []
  const secrets = new Map<string, { value: string; createdAt: Date; metadata?: Record<string, string> }>()
  const held = () => [...secrets.keys()]
  const exited = (exitCode: number) => Object.assign(new Error(`exit status ${exitCode}`), { name: 'CommandExitError', exitCode, stdout: '' })
  let drops = opts.drops ?? 0
  const handle = (pid: number) => ({
    pid,
    wait: async () => {
      if (drops-- > 0) throw new Error('stream closed')
      if (opts.agentExit) throw exited(opts.agentExit)
      return { exitCode: 0, stdout: '' }
    },
  })
  let snaps = 0
  const deleted: string[] = []
  const box = (from: string) => ({ ...made, sandboxId: from.startsWith('snap_') ? `sbx_from_${from}` : 'sbx_e2b_1', commands: { ...made.commands, run: (cmd: string, options: any = {}) => (cmd.startsWith('test -f') && (opts.unready || !from.startsWith('snap_')) ? (log.push({ run: cmd, options, held: held() }), Promise.reject(exited(1))) : made.commands.run(cmd, options)) }, ...(opts.snapshots ? { createSnapshot: async () => (log.push({ snapshot: `snap_${++snaps}`, held: held() }), { snapshotId: `snap_${snaps}` }) } : {}) })
  const made = {
    sandboxId: 'sbx_e2b_1',
    commands: {
      connect: async (pid: number, options: any) => (log.push({ connect: pid, options }), handle(pid)),
      async run(cmd: string, options: any = {}) {
        log.push({ run: cmd, options, held: held() })
        if (options.background) {
          // The first handle's connection is the one that drops: only one found again by its process answers.
          const first = handle(41)
          return { ...first, wait: async () => (opts.drops ? Promise.reject(new Error('stream closed')) : first.wait()) }
        }
        const code = opts.exit?.(cmd) ?? 0
        if (code !== 0) throw exited(code)
        const out = opts.out?.(cmd) ?? (cmd === PROCESSES ? '1 10\n77 4242' : cmd === REAP ? `left ${opts.left ?? 0}` : cmd.includes('$HOME') ? (opts.home ?? '/home/user') : cmd.includes('git rev-parse HEAD') ? `${'a'.repeat(40)}\nmain` : cmd.includes('installed') ? 'lots of output\ninstalled pnpm' : '')
        return { exitCode: 0, stdout: out }
      },
    },
    files: {
      async read(path: string) {
        log.push({ read: path })
        const data = opts.files?.[path]
        if (!data) throw Object.assign(new Error('no such file'), { name: 'FileNotFoundError' })
        return (async function* () {
          for (let at = 0; at < data.length; at += 4) yield new Uint8Array(data.subarray(at, at + 4))
        })()
      },
    },
    updateNetwork: async (network: any) => void log.push({ network, held: held() }),
    kill: async () => void log.push({ killed: true, held: held() }),
  }
  const sdk = {
    Sandbox: {
      async create(template: string, options: any) {
        log.push({ create: options, template, held: held() })
        if (opts.gone?.includes(template)) throw new Error('snapshot not found')
        if (opts.refuses) throw new Error(opts.refuses)
        return box(template)
      },
      deleteSnapshot: async (id: string) => void deleted.push(id),
    },
    Secret: {
      async create(name: string, value: string, options: any) {
        if (opts.full) throw Object.assign(new Error('secret limit reached'), { status: 409 })
        secrets.set(name, { value, createdAt: new Date(NOW), metadata: options.metadata })
      },
      destroy: async (name: string) => secrets.delete(name),
      list: () => ({ hasNext: false, nextItems: async () => [...secrets].map(([name, secret]) => ({ name, createdAt: secret.createdAt, metadata: secret.metadata })) }),
      fill: (name: string) => `\${e2b.secrets.${name}}`,
    },
  }
  const runner = (more: object = {}) => e2b({ sdk, apiKey: 'e2b_account_key', template: 'muster-agents', setupHosts: ['github.com', 'objects.githubusercontent.com'], now: () => NOW, ...more })
  return { log, secrets, runner, deleted, networks: () => log.filter((entry) => entry.network), values: () => [...secrets.values()].map((secret) => secret.value) }
}

describe('the E2B runner', () => {
  const board = { url: URL_, token: token() }
  const plain = { task: 7, agent: claude, prompt: "it's a prompt with 'quotes'", board, setup: [['npm', 'install', '-g', 'https://example.com/muster.tgz']] }
  const full = { ...plain, repo: 'https://github.com/acme/web.git', install: true, github: { token: 'ghs_clone' }, model: { key: 'sk-real-key' }, timeoutMs: 40 * 60_000 }

  it('opens the sandbox one step at a time, stores each credential only for the step that needs it, and puts none inside', async () => {
    const e = standIn({ agentExit: 3 })
    const run = await e.runner({ keyAnyPath: true }).start(full)
    expect(run.id).toBe('sbx_e2b_1')
    const created = e.log.find((entry) => entry.create)
    expect(created.template).toBe('muster-agents')
    // Made with only where mu is installed from open, no rule on it, and nothing stored yet.
    expect(created.create.network).toEqual({ denyOut: ['0.0.0.0/0'], allowOut: ['github.com', 'objects.githubusercontent.com'] })
    expect(created.held).toEqual([])
    expect(created.create.timeoutMs).toBe(40 * 60_000)
    // The environment holds placeholders, where the certificate for read connections is, and no credential: not E2B's own either.
    expect(created.create.envs).toMatchObject({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy', ANTHROPIC_API_KEY: 'set-by-the-network-policy', MUSTER_TASK: '7', NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt', GIT_SSL_CAINFO: '/etc/ssl/certs/ca-certificates.crt' })
    const inside = JSON.stringify([created.create.envs, e.log.filter((entry) => entry.run), e.networks()])
    for (const secret of [board.token, 'sk-real-key', 'ghs_clone', Buffer.from('x-access-token:ghs_clone').toString('base64'), 'e2b_account_key']) expect(inside).not.toContain(secret)

    const [clone, afterClone, install, afterInstall, agent, ...rest] = e.networks()
    expect(rest).toEqual([])
    // Cloning: GitHub alone, with the one credential stored being the clone's.
    expect(clone.network.allowOut).toEqual(['github.com', 'codeload.github.com'])
    expect(Object.keys(clone.network.rules)).toEqual(['github.com'])
    expect(clone.held).toHaveLength(1)
    expect(clone.network.rules['github.com'][0].transform.headers).toEqual({ authorization: `\${e2b.secrets.${clone.held[0]}}`, host: 'github.com' })
    // Closed while the clone's credential is still stored, and it is gone before anything else is open.
    expect(afterClone).toEqual({ network: { denyOut: ['0.0.0.0/0'] }, held: clone.held })
    // Installing: every host, no rule, and nothing stored at all.
    expect(install).toEqual({ network: { denyOut: ['0.0.0.0/0'], allowOut: ['*'] }, held: [] })
    expect(afterInstall).toEqual({ network: { denyOut: ['0.0.0.0/0'] }, held: [] })
    // The agent: the board and the model, each with its credential as a stored secret's name.
    expect(agent.network.allowOut).toEqual(['board.example.com', 'api.anthropic.com'])
    expect(agent.held).toHaveLength(2)
    expect(agent.held).not.toContain(clone.held[0])
    expect(agent.network.rules['board.example.com'][0].transform.headers).toEqual({ authorization: expect.stringMatching(/^\$\{e2b\.secrets\.muster-[0-9a-f]{24}\}$/), host: 'board.example.com' })
    expect(agent.network.rules['api.anthropic.com'][0].transform.headers).toEqual({ 'x-api-key': expect.stringMatching(/^\$\{e2b\.secrets\.muster-/), host: 'api.anthropic.com' })
    expect(e.values().sort()).toEqual([`Bearer ${board.token}`, 'sk-real-key'].sort())

    const runs = e.log.filter((entry) => entry.run)
    // Every command has a time it may take: E2B's own default would end the agent after a minute.
    for (const each of runs) expect(each.options.timeoutMs, each.run).toBeGreaterThanOrEqual(60_000)
    expect(runs[0]).toMatchObject({ run: "'npm' 'install' '-g' 'https://example.com/muster.tgz'", options: { user: 'root' }, held: [] })
    expect(runs.find((each) => each.run.includes("'git' 'clone'"))!.run).toBe("'git' 'clone' '--quiet' '--' 'https://github.com/acme/web.git' '/home/user/web'")
    // The agent is asked who it is on the board before it starts, with the credentials in place.
    const who = runs.findIndex((each) => each.run === 'mu whoami --json')
    const started = runs.findIndex((each) => each.options.background)
    expect(who).toBeGreaterThan(-1)
    expect(started).toBe(who + 1)
    expect(runs[started]).toMatchObject({ run: expect.stringContaining(`printf %s 'it'\\''s a prompt with '\\''quotes'\\''' | 'claude'`), options: { background: true, cwd: '/home/user/web', timeoutMs: 40 * 60_000 } })
    // What was running before the repository was there is noted, as root. Once the install is over and every host is
    // closed again, whatever else is running is ended, before any credential of the agent's is stored: a closed way
    // out still serves the connections that were open.
    const noted = runs.findIndex((each) => each.run === PROCESSES)
    const reaped = runs.findIndex((each) => each.run === REAP)
    expect(runs[noted]).toMatchObject({ options: { user: 'root' } })
    expect(noted).toBeLessThan(runs.findIndex((each) => each.run.includes("'git' 'clone'")))
    expect(runs[reaped]).toMatchObject({ options: { user: 'root', envs: { MU_KEEP: '1 10\n77 4242' } }, held: [] })
    expect(reaped).toBeGreaterThan(runs.findIndex((each) => each.run.includes('frozen-lockfile')))
    expect(e.log.indexOf(runs[reaped])).toBeGreaterThan(e.log.indexOf(afterInstall))
    expect(e.log.indexOf(runs[reaped])).toBeLessThan(e.log.indexOf(agent))
    expect(run.checkout).toEqual({ sha: 'a'.repeat(40), branch: 'main' })
    expect(run.installed).toBe('pnpm')
    // How the agent ended is its exit code, which the SDK throws.
    expect(await run.wait!()).toEqual({ exitCode: 3 })

    await run.stop()
    const end = e.log.slice(-2)
    expect(end[0]).toMatchObject({ network: { denyOut: ['0.0.0.0/0'] } })
    expect(end[1]).toMatchObject({ killed: true })
    expect(e.secrets.size).toBe(0)
  })

  it('a connection lost while the agent works is not how the agent ended: the agent is found again and waited on', async () => {
    const e = standIn({ drops: 1, agentExit: 5 })
    const run = await e.runner().start(plain)
    // The first ask fails as the connection did, and says nothing of the agent.
    await expect(run.wait!()).rejects.toThrow('stream closed')
    expect(e.log.at(-1)).toMatchObject({ connect: 41 })
    // Asked again, it is the agent that answers: once more through a drop, then with how it ended.
    await expect(run.wait!()).rejects.toThrow('stream closed')
    expect(await run.wait!()).toEqual({ exitCode: 5 })
    await run.stop()
  })

  it('starts nothing and stores nothing for a token the board would not hold to a sandbox, a model key nobody accepted the reach of, or a board it could not reach', async () => {
    const e = standIn()
    expect(await reason(e.runner({ keyAnyPath: true }).start({ ...full, board: { url: URL_, token: token({}) } }))).toBe('agent_token_unmarked')
    expect(await reason(e.runner({ keyAnyPath: true }).start({ ...full, board: { url: URL_, token: 'mu1.nonsense' } }))).toBe('agent_token_unmarked')
    expect(await reason(e.runner().start(full))).toBe('model_key_unscoped')
    expect(await reason(e.runner({ modelSecret: 'my-key' }).start(plain))).toBe('model_key_unscoped')
    expect(await reason(e.runner().start({ ...plain, board: { url: 'http://127.0.0.1:4100/api/board', token: token() } }))).toBe('board_not_reachable')
    expect(await reason(e.runner({ allowHosts: Array.from({ length: 10 }, (_, n) => `h${n}.example.com`) }).start(plain))).toBe('runner_too_many_hosts')
    expect(e.log).toEqual([])
    expect(e.secrets.size).toBe(0)
    // Without a model key there is nothing to accept: the board alone is open.
    const run = await e.runner().start(plain)
    expect(e.networks().at(-1).network.allowOut).toEqual(['board.example.com'])
    await run.stop()
  })

  it('a run whose agent could not reach the board, or that could not be set up, is removed with everything stored for it', async () => {
    for (const [failing, said] of [['mu whoami', /couldn't reach the board/], ["'npm' 'install'", /exited 9/], ["'git' 'clone'", /Cloning https:\/\/github.com\/acme\/web.git .* failed \(exit 9\)/]] as const) {
      const e = standIn({ exit: (cmd) => (cmd.startsWith(failing) ? 9 : undefined) })
      const failed = await e.runner({ keyAnyPath: true }).start(full).catch((error) => error)
      expect([failing, failed.reason]).toEqual([failing, 'runner_setup_failed'])
      expect(failed.message).toMatch(said)
      expect(e.log.at(-1), failing).toMatchObject({ killed: true })
      expect(e.log.some((entry) => entry.options?.background), failing).toBe(false)
      expect(e.secrets.size, failing).toBe(0)
    }
    // A setup command's address is said without the credential it may carry.
    const e = standIn({ exit: (cmd) => (cmd.includes('pkgs.example.com') ? 1 : undefined) })
    const failed = await e.runner().start({ ...plain, setup: [['npm', 'install', '-g', 'https://ada:hunter2@pkgs.example.com/muster.tgz?sig=abc']] }).catch((error) => error)
    expect(failed.message).toContain('https://pkgs.example.com/muster.tgz')
    expect(failed.message).not.toMatch(/hunter2|sig=abc/)
  })

  it("a failed install is said and the agent starts; a checkout that isn't where it was asked to be stops the run", async () => {
    const e = standIn({ exit: (cmd) => (cmd.includes('frozen-lockfile') ? 1 : undefined) })
    const run = await e.runner().start({ ...plain, repo: 'https://github.com/acme/web.git', install: true })
    expect(run.installed).toBe('failed (exit 1)')
    expect(e.log.some((entry) => entry.options?.background)).toBe(true)
    await run.stop()
    // What the sandbox says of its checkout is read as anything from it is: an odd branch name is not one.
    const odd = standIn({ out: (cmd) => (cmd.includes('git rev-parse HEAD') ? `${'a'.repeat(40)}\n--upload-pack=x` : cmd.includes('$HOME') ? '/home/user' : '') })
    expect((await odd.runner().start({ ...plain, repo: 'https://github.com/acme/web.git' })).checkout).toBeUndefined()
    const moved = standIn()
    const round = { ...plain, repo: 'https://github.com/acme/web.git', ref: { branch: 'mu/task-7', sha: 'b'.repeat(40) } }
    expect(await reason(moved.runner().start(round))).toBe('runner_setup_failed')
    expect(moved.log.find((entry) => entry.run?.includes("'git' 'clone'")).run).toContain("'--branch' 'mu/task-7'")
    expect(moved.log.at(-1)).toMatchObject({ killed: true })
  })

  it('the scripts that note and end processes read when each started, which a reused process ID does not share', async () => {
    const { execFileSync } = await import('node:child_process')
    // Twenty words in, as the rest of /proc/<pid>/stat is after its name: the twentieth is the start time.
    for (const script of [PROCESSES, REAP]) {
      expect(script).toContain('${20}')
      expect(script.replaceAll('${20}', '')).not.toMatch(/\$20/)
    }
    expect(execFileSync('sh', ['-c', 'set -- a b c d e f g h i j k l m n o p q r s t u; echo "${20}"'], { encoding: 'utf8' })).toBe('t\n')
  })

  it("a process the install left running that can't be ended stops the run before any credential is stored", async () => {
    const e = standIn({ left: 1 })
    const failed = await e.runner({ keyAnyPath: true }).start(full).catch((error) => error)
    expect(failed.reason).toBe('runner_setup_failed')
    expect(failed.message).toContain("couldn't be ended")
    expect(e.values()).toEqual([])
    expect(e.log.some((entry) => entry.options?.background)).toBe(false)
    expect(e.log.at(-1)).toMatchObject({ killed: true })
    // Without an install nothing of the repository's ran, and nothing is ended.
    const none = standIn({ left: 1 })
    await none.runner().start({ ...plain, repo: 'https://github.com/acme/web.git' })
    expect(none.log.some((entry) => entry.run === REAP)).toBe(false)
  })

  it("a model secret of yours is used by name: no key is stored for the run, and yours is never removed", async () => {
    const e = standIn()
    e.secrets.set('my-anthropic-key', { value: 'sk-mine', createdAt: new Date(NOW - 90 * 86_400_000) })
    const run = await e.runner({ keyAnyPath: true, modelSecret: 'my-anthropic-key' }).start(plain)
    const agent = e.networks().at(-1)
    expect(agent.network.rules['api.anthropic.com'][0].transform.headers).toEqual({ 'x-api-key': '${e2b.secrets.my-anthropic-key}', host: 'api.anthropic.com' })
    expect(e.values().sort()).toEqual([`Bearer ${board.token}`, 'sk-mine'].sort())
    await run.stop()
    expect([...e.secrets.keys()]).toEqual(['my-anthropic-key'])
  })

  it('removes what a run that never ended left stored, and nothing else', async () => {
    const e = standIn()
    const old = new Date(NOW - E2B_SECRET_KEEP_MS - 1000)
    e.secrets.set('muster-left-by-a-dead-run', { value: 'x', createdAt: old, metadata: { muster: 'run' } })
    e.secrets.set('muster-of-a-run-still-going', { value: 'x', createdAt: new Date(NOW - 3_600_000), metadata: { muster: 'run' } })
    e.secrets.set('muster-named-by-a-person', { value: 'x', createdAt: old })
    e.secrets.set('stripe-key', { value: 'x', createdAt: old, metadata: { muster: 'run' } })
    const run = await e.runner().start(plain)
    await run.stop()
    expect([...e.secrets.keys()].sort()).toEqual(['muster-named-by-a-person', 'muster-of-a-run-still-going', 'stripe-key'])
  })

  it("says what E2B said when it starts no sandbox, with the settings to check, and stores nothing", async () => {
    const e = standIn({ refuses: "401: Invalid API key\nmore that isn't for a terminal" })
    const failed = await e.runner({ domain: 'e2b.example.com' }).start(plain).catch((error) => error)
    expect(failed.reason).toBe('runner_start_failed')
    expect(failed.message).toBe('E2B didn\'t start a sandbox from "muster-agents": 401: Invalid API key')
    expect(failed.hint).toBe('Check E2B_API_KEY and MUSTER_E2B_TEMPLATE, and E2B_DOMAIN, which names the E2B this was asked of.')
    expect(JSON.stringify([failed.message, failed.hint])).not.toContain('e2b_account_key')
    expect(e.secrets.size).toBe(0)
    // Without a domain of your own, none is named.
    expect((await standIn({ refuses: 'fetch failed' }).runner().start(plain).catch((error) => error)).hint).toBe('Check E2B_API_KEY and MUSTER_E2B_TEMPLATE.')
  })

  it('says so when the project can store no more secrets, and leaves no sandbox', async () => {
    const e = standIn({ full: true })
    const failed = await e.runner().start(plain).catch((error) => error)
    expect(failed.reason).toBe('runner_secrets_full')
    expect(failed.hint).toContain('MUSTER_E2B_MODEL_SECRET')
    expect(e.log.at(-1)).toMatchObject({ killed: true })
  })

  it('reads a file out no further than asked, runs a command in the checkout, and closes its way out', async () => {
    const e = standIn({ files: { '/tmp/small': Buffer.from('ten bytes!'), '/tmp/big': Buffer.alloc(64) }, exit: (cmd) => (cmd.startsWith("'false'") ? 4 : undefined) })
    const run = await e.runner().start({ ...plain, repo: 'https://github.com/acme/web.git' })
    expect((await run.readFile!('/tmp/small', 10))?.toString()).toBe('ten bytes!')
    expect(await run.readFile!('/tmp/big', 63)).toBeNull()
    expect(await run.readFile!('/tmp/none', 10)).toBeNull()
    expect(await run.exec!({ cmd: 'false', args: [] })).toMatchObject({ exitCode: 4 })
    await run.exec!({ cmd: 'sh', args: ['-c', 'git bundle create "$MU_OUT"'], env: { MU_OUT: '/tmp/out' } })
    expect(e.log.at(-1)).toMatchObject({ run: `'sh' '-c' 'git bundle create "$MU_OUT"'`, options: { cwd: '/home/user/web', envs: { MU_OUT: '/tmp/out' } } })
    await run.close!()
    // Closed, and then whatever the agent left running is ended: it could hold a connection that was open.
    expect(e.log.at(-2)).toMatchObject({ network: { denyOut: ['0.0.0.0/0'] } })
    expect(e.log.at(-1)).toMatchObject({ run: REAP, options: { user: 'root' } })
    await run.stop()
  })

  it('with a base, the setup runs once and is kept with no credential in it; each run starts from that, closed', async () => {
    const e = standIn({ snapshots: true })
    const bases = memoryBases()
    const runner = e.runner({ base: true, bases, keyAnyPath: true })
    const first = await runner.start(full)
    const creates = () => e.log.filter((entry) => entry.create)
    // The base: the template, an empty environment, only the setup's hosts, and nothing stored anywhere.
    expect(creates()[0]).toMatchObject({ template: 'muster-agents', create: { envs: {}, network: { allowOut: ['github.com', 'objects.githubusercontent.com'] }, metadata: { muster: 'base' } }, held: [] })
    expect(creates()[0].create.envs).toEqual({})
    const kept = e.log.findIndex((entry) => entry.snapshot)
    expect(e.log.slice(0, kept).filter((entry) => entry.run).map((entry) => [entry.run, entry.options.user])).toEqual([["'npm' 'install' '-g' 'https://example.com/muster.tgz'", 'root'], ['touch /opt/.muster-base-ready', 'root']])
    // Closed before it is kept, kept with nothing stored, and then removed.
    expect(e.log[kept - 1]).toEqual({ network: { denyOut: ['0.0.0.0/0'] }, held: [] })
    expect(e.log[kept]).toEqual({ snapshot: 'snap_1', held: [] })
    expect(e.log[kept + 1]).toMatchObject({ killed: true })
    // The run: from the snapshot, with its own environment, every host closed, and no setup of its own.
    expect(creates()[1]).toMatchObject({ template: 'snap_1', create: { network: { denyOut: ['0.0.0.0/0'] }, envs: { MUSTER_TASK: '7', MUSTER_TOKEN: 'set-by-the-network-policy' }, metadata: { muster: 'run' } } })
    expect(creates()[1].create.network.allowOut).toBeUndefined()
    expect(e.log.slice(kept).some((entry) => entry.run?.includes("'npm' 'install'"))).toBe(false)
    expect(first.id).toBe('sbx_from_snap_1')
    await first.stop()
    // A second run makes no base: it starts from the one written down.
    await (await runner.start(plain)).stop()
    expect(creates().map((entry) => entry.template)).toEqual(['muster-agents', 'snap_1', 'snap_1'])
    // Another version of the setup is another base, and the older one this machine made is removed.
    await (await runner.start({ ...plain, setup: [['npm', 'install', '-g', 'https://example.com/muster-2.tgz']] })).stop()
    expect(creates().map((entry) => entry.template)).toEqual(['muster-agents', 'snap_1', 'snap_1', 'muster-agents', 'snap_2'])
    expect(e.deleted).toEqual(['snap_1'])
    expect(bases.entries().map(([, id]) => id)).toEqual(['snap_2'])
  })

  it('two workers that make a base at once end with one: the second removes its own and starts from the first', async () => {
    const e = standIn({ snapshots: true })
    const kept = memoryBases()
    // What the record says is asked twice by the one making a base: nothing before it starts, and the other worker's once it is done.
    let asked = 0
    const bases = { ...kept, get: (key: string) => (++asked === 1 ? undefined : 'snap_theirs') }
    const run = await e.runner({ base: true, bases }).start(plain)
    expect(e.deleted).toEqual(['snap_1'])
    expect(e.log.filter((entry) => entry.create).map((entry) => entry.template)).toEqual(['muster-agents', 'snap_theirs'])
    expect(kept.entries()).toEqual([])
    await run.stop()
  })

  it('a base that is gone, or whose making was cut short, is forgotten and the run is set up the long way', async () => {
    for (const broken of [{ gone: ['snap_old'] }, { unready: true }]) {
      const e = standIn({ snapshots: true, ...broken })
      const bases = memoryBases()
      // What a run before this one wrote down.
      const probe = standIn({ snapshots: true })
      const seeded = memoryBases()
      await (await probe.runner({ base: true, bases: seeded }).start(plain)).stop()
      bases.set(seeded.entries()[0]![0], 'snap_old')
      const run = await e.runner({ base: true, bases }).start(plain)
      expect(run.id, JSON.stringify(broken)).toBe('sbx_e2b_1')
      expect(e.log.filter((entry) => entry.create).map((entry) => entry.template)).toEqual(['snap_old', 'muster-agents'])
      expect(e.log.some((entry) => entry.run?.includes("'npm' 'install'"))).toBe(true)
      expect(bases.entries()).toEqual([])
      expect(e.deleted).toEqual(['snap_old'])
      await run.stop()
    }
    // An SDK that can't keep a sandbox: no base, and the run is set up as without one.
    const old = standIn()
    const run = await old.runner({ base: true }).start(plain)
    expect(old.log.filter((entry) => entry.create).map((entry) => entry.create.metadata.muster)).toEqual(['base', 'run'])
    expect(run.id).toBe('sbx_e2b_1')
  })

  it("a repository goes in the home of the template's user, and nowhere a sandbox's answer could send it", async () => {
    const e = standIn({ home: '/root' })
    await e.runner().start({ ...plain, repo: 'https://github.com/acme/web.git' })
    expect(e.log.find((entry) => entry.run?.includes("'git' 'clone'")).run).toContain("'/root/web'")
    const odd = standIn({ home: '/tmp/$(curl evil)' })
    await odd.runner().start({ ...plain, repo: 'https://github.com/acme/web.git' })
    expect(odd.log.find((entry) => entry.run?.includes("'git' 'clone'")).run).toContain("'/home/user/web'")
  })
})
