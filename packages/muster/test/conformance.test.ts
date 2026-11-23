import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conformance, mint } from '../src/index.ts'
import { cli, cliStart, memoryBoard, tempDir } from './helpers.ts'

describe('conformance', () => {
  it('this backend passes every check', async () => {
    const { team } = memoryBoard()
    const checks = await conformance(team)
    expect(checks.filter((check) => !check.ok)).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(19)
  })

  it('a backend that breaks a rule fails the check for that rule, and only that one', async () => {
    const { team } = memoryBoard()
    const broken = new Proxy(team, {
      get(target, key, receiver) {
        const as = Reflect.get(target, 'as', receiver) as typeof team.as
        if (key === 'as') return (profile: string | null) => new Proxy(as(profile), { get: (inner, name, self) => (name === 'label' ? async (request: { id: number }) => (await inner.readThread({ id: request.id })).message : Reflect.get(inner, name, self)) })
        return Reflect.get(target, key, receiver)
      },
    })
    const failed = (await conformance(broken)).filter((check) => !check.ok).map((check) => check.name)
    expect(failed).toEqual(['a conditional label has one winner', 'the board keeps its own labels'])
  })

  it('mu conformance prints a line per check and exits 0 when all pass', async () => {
    const dir = tempDir()
    const run = await cli(dir, ['conformance'])
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/^pass  a post is a thread root written by its caller$/m)
    expect(run.stdout).toMatch(/\n\d+ of \d+ passed\n$/)
    expect(run.stdout).not.toContain('FAIL')
  })
})

describe('mu run in a cloud sandbox', () => {
  // A token as the board's owner would make one for an agent: one profile, its own channels.
  const agent = (claims: object = { profile: 'fixer', can: { 'work/': ['read', 'post', 'react', 'label'] } }) => mint(Buffer.alloc(32, 1), { sub: 'local:user:ada', exp: 4_102_444_800, profile: null, ...claims } as Parameters<typeof mint>[1])
  const board = { MUSTER_URL: 'https://board.example.com/api/board', MUSTER_TOKEN: 'mu1.mine', MUSTER_AGENT_TOKEN: agent() }

  it('cloudflare: asks your Worker to start the run with the agent\'s own token, and says what it started', async () => {
    const got: any[] = []
    const worker = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'cf-run-1' }))
      })
    })
    await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
    const dir = tempDir()
    const env = { ...board, MUSTER_CF_WORKER: `http://127.0.0.1:${(worker.address() as { port: number }).port}`, MUSTER_CF_SECRET: 'worker-secret' }
    // The board itself is not reachable here, so only what was sent to the Worker is checked.
    const run = await cli(dir, ['run', '12', '--runner', 'cloudflare', '--agent', 'claude', '--repo', 'https://github.com/acme/web.git', '--as', 'fixer', '--json'], { env })
    worker.close()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ url: '/runs', auth: 'Bearer worker-secret', body: { task: 12, repo: 'https://github.com/acme/web.git', board: { host: 'board.example.com', token: board.MUSTER_AGENT_TOKEN }, env: { MUSTER_TOKEN: 'set-by-the-network-policy' } } })
    // What runs in the container is mu run itself: it claims the task, keeps the claim alive, and settles it.
    expect(got[0].body.command).toEqual(['mu', 'run', '12', '--as', 'fixer', '--bypass-permissions', '--agent', 'claude'])
    expect(got[0].body.env).toMatchObject({ IS_SANDBOX: '1', MUSTER_AGENT_ENV: expect.stringContaining('NODE_EXTRA_CA_CERTS') })
    // A container has no internet, so nothing is installed at run time: mu is in the image.
    expect(got[0].body.setup).toEqual([])
    expect(JSON.stringify(got[0].body.env)).not.toContain('mu1.')
    expect(run.stderr + run.stdout).toMatch(/network_error|cf-run-1/)
  })

  it('vercel: creates the sandbox through the SDK with the policy, and never puts the token in its environment', async () => {
    const dir = tempDir()
    const log = join(dir, 'sdk.log')
    mkdirSync(join(dir, 'sdk'))
    writeFileSync(join(dir, 'sdk', 'index.mjs'), `import { appendFileSync } from 'node:fs'\nexport const Sandbox = { async create(options) { appendFileSync(${JSON.stringify(log)}, JSON.stringify(options) + '\\n'); return { sandboxId: 'sbx_42', runCommand: async (c) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n'), update: async (o) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ closedTo: Object.keys(o.networkPolicy.allow) }) + '\\n'), stop: async () => {} } } }\n`)
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'codex', '--json'], { env: { ...board, MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') } })
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines[0].env).toMatchObject({ MUSTER_URL: board.MUSTER_URL, MUSTER_TOKEN: 'set-by-the-network-policy', MUSTER_TASK: '12' })
    // Made under the setup's policy: GitHub's release hosts, to install muster, and no credential, not even the board's host.
    expect(Object.keys(lines[0].networkPolicy.allow).sort()).toEqual(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
    expect(JSON.stringify(lines[0].networkPolicy)).not.toContain('transform')
    // The sandbox installs this CLI's own release from its tarball, never a package looked up by name.
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(lines[1]).toEqual({ cmd: 'npm', args: ['install', '-g', `https://github.com/openmuster/muster/releases/download/v${version}/muster-${version}.tgz`] })
    // In a sandbox the agent's own prompts are off: headless, one would stop it at its first command.
    // GitHub was open for the install only: the agent starts with the board as its one way out.
    expect(lines[2]).toEqual({ closedTo: ['board.example.com'] })
    expect(lines[3].args[1]).toContain("'mu' 'run' '12' '--bypass-permissions' '--timeout' '30m' '--agent' 'codex'")
    // The agent's clean environment is told what the sandbox set that it must still see: the certificate for its intercepted connections.
    expect(lines[0].env.MUSTER_AGENT_ENV.split(',')).toEqual(expect.arrayContaining(['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'IS_SANDBOX', 'OPENAI_API_KEY']))
    // --safe keeps them on.
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'codex', '--safe', '--json'], { env: { ...board, MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') } })
    const again = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(again.at(-1).args[1]).toContain("'mu' 'run' '12' '--timeout' '30m' '--agent' 'codex'")
    expect(again.at(-1).args[1]).not.toContain('--bypass-permissions')
  })

  it('vercel: signs in with VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, which the SDK only takes when they are passed, and never puts them in the sandbox', async () => {
    const dir = tempDir()
    const log = join(dir, 'sdk.log')
    mkdirSync(join(dir, 'sdk'))
    writeFileSync(join(dir, 'sdk', 'index.mjs'), `import { appendFileSync } from 'node:fs'\nexport const Sandbox = { async create(options) { appendFileSync(${JSON.stringify(log)}, JSON.stringify(options) + '\\n'); return { sandboxId: 'sbx_43', runCommand: async () => {}, update: async () => {}, stop: async () => {} } } }\n`)
    const sdk = { MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') }
    const vercelToken = 'vcp_not_a_real_token_0123456789'
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'codex', '--json'], { env: { ...board, ...sdk, VERCEL_TOKEN: vercelToken, VERCEL_TEAM_ID: 'team_abc', VERCEL_PROJECT_ID: 'prj_def' } })
    const { readFileSync } = await import('node:fs')
    const [created] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(created).toMatchObject({ token: vercelToken, teamId: 'team_abc', projectId: 'prj_def' })
    expect(JSON.stringify(created.env)).not.toContain(vercelToken)

    // Only some of the three is a config error, said before a sandbox is made, not the SDK's OIDC message.
    const partial = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'codex', '--json'], { env: { ...board, ...sdk, VERCEL_TOKEN: vercelToken } })
    expect(JSON.parse(partial.stderr).error).toMatchObject({ reason: 'runner_not_configured' })
    expect(JSON.parse(partial.stderr).error.message).toMatch(/VERCEL_TEAM_ID.*VERCEL_PROJECT_ID/)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  /** A stand-in for @vercel/sandbox that logs every call, and whose agent command exits with `exit` after `after` ms. */
  const fakeSdk = (dir: string, opts: { exit?: number; after?: number; checkout?: string; bundled?: string; file?: string } = {}) => {
    const log = join(dir, 'sdk.log')
    mkdirSync(join(dir, 'sdk'), { recursive: true })
    writeFileSync(join(dir, 'sdk', 'index.mjs'), `import { appendFileSync } from 'node:fs'
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n')
export const Sandbox = { async create(options) {
  log({ create: options })
  return {
    sandboxId: 'sbx_44',
    async runCommand(c) {
      log({ run: c })
      if (!c.detached) {
        const script = c.args?.[1] ?? ''
        const out = script.includes('git rev-parse HEAD &&') ? ${JSON.stringify(opts.checkout ?? 'abc123\nmain')} : script.includes('bundle create') ? ${JSON.stringify(opts.bundled ?? 'unchanged')} : ''
        return { exitCode: 0, stdout: async () => out }
      }
      return { wait: () => new Promise((resolve) => setTimeout(() => (log({ exited: ${opts.exit ?? 0} }), resolve({ exitCode: ${opts.exit ?? 0} })), ${opts.after ?? 50})) }
    },
    readFile: async ({ path }) => (log({ read: path }), ${JSON.stringify(opts.file ?? null)} === null ? null : (await import('node:stream')).Readable.from([Buffer.from(${JSON.stringify(opts.file ?? '')}, 'base64')])),
    update: async (o) => log({ update: o.networkPolicy === 'deny-all' ? 'deny-all' : Object.keys(o.networkPolicy.allow), policy: o.networkPolicy }),
    delete: async () => log({ deleted: true }),
    stop: async () => log({ stopped: true }),
  }
} }\n`)
    return { env: { MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') }, read: async () => (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }
  }

  it('vercel: attached by default, it waits for mu run in the sandbox, then closes the sandbox\'s way out and deletes it', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir, { exit: 0, after: 300 })
    const run = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--json'], { env: { ...board, ...sdk.env } })
    const lines = await sdk.read()
    const at = (match: (entry: any) => boolean) => lines.findIndex(match)
    // Ended only after the run in it exited: its way out closed first, then removed.
    expect(at((e) => e.exited !== undefined)).toBeLessThan(at((e) => e.update === 'deny-all'))
    expect(at((e) => e.update === 'deny-all')).toBeLessThan(at((e) => e.deleted))
    expect(JSON.parse(run.stdout)).toMatchObject({ task: 12, runner: 'vercel', run: 'sbx_44', exit: 0 })
    expect(run.code).toBe(0)
  })

  it('vercel: one length of time sets the agent\'s timeout, the sandbox\'s, which outlives it, and the token\'s', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    // Without --timeout: 30 minutes for the agent, ten more for the sandbox to set up and settle the task.
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--as', 'fixer', '--json'], { env: { ...board, ...sdk.env } })
    let lines = await sdk.read()
    expect(lines[0].create.timeout).toBe(40 * 60_000)
    expect(lines.find((e) => e.run?.detached).run.args[1]).toContain("'--timeout' '30m'")
    // With one: the same rule.
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--as', 'fixer', '--timeout', '1h', '--json'], { env: { ...board, ...sdk.env } })
    lines = await sdk.read()
    expect(lines.filter((e) => e.create).at(-1).create.timeout).toBe(70 * 60_000)
    expect(lines.filter((e) => e.run?.detached).at(-1).run.args[1]).toContain("'--timeout' '1h'")
  })

  it('vercel: a --ready worker lives two hours unless --timeout says otherwise', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    await cli(dir, ['run', '--ready', 'work/', '--runner', 'vercel', '--agent', 'claude', '--as', 'fixer', '--json'], { env: { ...board, ...sdk.env } })
    expect((await sdk.read()).filter((e) => e.create).at(-1).create.timeout).toBe(2 * 60 * 60_000)
    await cli(dir, ['run', '--ready', 'work/', '--runner', 'vercel', '--agent', 'claude', '--as', 'fixer', '--timeout', '10m', '--json'], { env: { ...board, ...sdk.env } })
    expect((await sdk.read()).filter((e) => e.create).at(-1).create.timeout).toBe(20 * 60_000)
  })

  it('vercel: a run that exits badly is a failure here too, and the sandbox is still removed', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir, { exit: 2 })
    const run = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--json'], { env: { ...board, ...sdk.env } })
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout)).toMatchObject({ exit: 2 })
    expect((await sdk.read()).some((e) => e.deleted)).toBe(true)
  })

  it('vercel: with --repo it installs the repository\'s dependencies in the checkout before the agent starts there, unless --no-install', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--repo', 'https://github.com/acme/web.git', '--json'], { env: { ...board, ...sdk.env } })
    let lines = await sdk.read()
    expect(lines[0].create.networkPolicy.allow).toEqual({ '*': [] })
    expect(lines[0].create.source).toEqual({ type: 'git', url: 'https://github.com/acme/web.git' })
    const install = lines.findIndex((e) => e.run?.args?.[1]?.includes('--ignore-scripts'))
    expect(lines[install].run.cwd).toBe('/vercel/web')
    expect(lines.findIndex((e) => Array.isArray(e.update))).toBeGreaterThan(install)
    expect(lines.find((e) => e.run?.detached).run.cwd).toBe('/vercel/web')
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--repo', 'https://github.com/acme/web.git', '--no-install', '--json'], { env: { ...board, ...sdk.env } })
    lines = (await sdk.read()).slice(lines.length)
    expect(Object.keys(lines[0].create.networkPolicy.allow).sort()).toEqual(['codeload.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
    expect(lines.some((e) => e.run?.args?.[1]?.includes('--ignore-scripts'))).toBe(false)
  })

  /** A GitHub App as `mu run` reads it from the environment: an ID, and a key in a file. */
  const appEnv = () => {
    const file = join(tempDir(), 'app.pem')
    writeFileSync(file, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    return { GITHUB_APP_ID: '123', GITHUB_APP_KEY_FILE: file }
  }

  it('vercel: --push is refused where it can\'t work, before anything starts', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    const repo = ['--repo', 'https://github.com/acme/web.git']
    const reasonOf = async (args: string[], env: Record<string, string> = appEnv()) => JSON.parse((await cli(dir, ['run', '12', '--agent', 'claude', '--push', '--json', ...args], { env: { ...board, ...sdk.env, ...env, MUSTER_CF_WORKER: 'https://w.example', MUSTER_CF_SECRET: 's' } })).stderr).error.reason
    expect(await reasonOf(['--runner', 'cloudflare', ...repo])).toBe('push_unsupported')
    expect(await reasonOf(['--runner', 'vercel'])).toBe('invalid_repo')
    expect(await reasonOf(['--runner', 'vercel', '--repo', 'https://gitlab.com/acme/web.git'])).toBe('invalid_repo')
    expect(await reasonOf(['--runner', 'vercel', ...repo, '--detach'])).toBe('push_unsupported')
    expect(await reasonOf(['--runner', 'vercel', ...repo], {})).toBe('runner_not_configured')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'sdk.log'))).toBe(false)
  })

  it('vercel: --push reads the agent\'s changes out of a sandbox closed to every host, pushes them from here to mu/task-<id>, and opens the pull request', async () => {
    const { execFileSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' }).trim()
    // GitHub, standing in: a bare repository with one commit on main.
    const work = tempDir()
    const remote = join(tempDir(), 'web.git')
    git(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'README.md'), 'hello\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'base')
    const base = git(work, 'rev-parse', 'HEAD')
    execFileSync('git', ['clone', '-q', '--bare', work, remote])
    // What the agent left in the sandbox, as the sandbox hands it back: a bundle on top of base.
    writeFileSync(join(work, 'README.md'), 'hello, fixed\n')
    git(work, 'commit', '-q', '-am', 'the fix')
    execFileSync('git', ['-C', work, 'bundle', 'create', join(work, 'mu.bundle'), `${base}..HEAD`], { stdio: 'ignore' })
    const bundle = readFileSync(join(work, 'mu.bundle')).toString('base64')

    // GitHub's API, standing in: the App is installed on acme/web, and each token is named for what it may do.
    const got: any[] = []
    const api = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null
        got.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed })
        const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.url === '/repos/acme/web/installation') return json(200, { id: 9 })
        if (req.url === '/app/installations/9/access_tokens') return json(201, { token: parsed.permissions.contents === 'write' ? 'ghs_write' : 'ghs_read', expires_at: '2030-01-01T00:00:00Z' })
        json(201, { html_url: 'https://github.com/acme/web/pull/7' })
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const dir = tempDir()
    const sdk = fakeSdk(dir, { checkout: `${base}\nmain`, bundled: 'bundle', file: bundle })
    const env = { ...board, ...sdk.env, ...appEnv(), MUSTER_GITHUB_API: `http://127.0.0.1:${(api.address() as { port: number }).port}`, MUSTER_GITHUB_REMOTE: remote }
    const run = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--as', 'fixer', '--repo', 'https://github.com/acme/web.git', '--no-install', '--push', '--json'], { env })
    expect(JSON.parse(run.stdout)).toMatchObject({ task: 12, exit: 0, pr: 'https://github.com/acme/web/pull/7' })
    // The branch is on GitHub, with the agent's change, under the name this machine chose.
    expect(execFileSync('git', ['-C', remote, 'show', 'refs/heads/mu/task-12:README.md'], { encoding: 'utf8' })).toBe('hello, fixed\n')
    // A read token to clone, a write token made only for the push, and the pull request opened with it.
    const tokens = got.filter((each) => each.url.endsWith('/access_tokens'))
    expect(tokens.map((each) => each.body)).toEqual([{ repositories: ['web'], permissions: { contents: 'read' } }, { repositories: ['web'], permissions: { contents: 'write', pull_requests: 'write' } }])
    expect(got.at(-1)).toEqual({ url: '/repos/acme/web/pulls', method: 'POST', auth: 'Bearer ghs_write', body: expect.objectContaining({ head: 'mu/task-12', base: 'main' }) })
    const lines = await sdk.read()
    const exited = lines.findIndex((e) => e.exited !== undefined)
    // After the agent the sandbox reaches nothing, and no policy of the sandbox's ever holds the token after it was cloned.
    expect(lines[exited + 1]).toEqual({ update: 'deny-all', policy: 'deny-all' })
    const bundled = lines.findIndex((e) => e.run?.args?.[1]?.includes('bundle create'))
    expect(bundled).toBeGreaterThan(exited + 1)
    expect(lines[bundled].run.env).toMatchObject({ MU_BASE: base, MU_NAME: 'fixer' })
    // The read token is in the policy it was made with, to clone; nothing after it holds a token, and the write token never reaches the sandbox.
    expect(JSON.stringify(lines[0])).toContain(Buffer.from('x-access-token:ghs_read').toString('base64'))
    expect(lines.slice(1).filter((e) => e.update).some((e) => JSON.stringify(e).includes('x-access-token') || JSON.stringify(e).includes(Buffer.from('x-access-token:ghs_read').toString('base64')))).toBe(false)
    expect((await import('node:fs')).readFileSync(join(dir, 'sdk.log'), 'utf8')).not.toContain(Buffer.from('x-access-token:ghs_write').toString('base64'))
    expect(lines.findIndex((e) => e.deleted)).toBeGreaterThan(bundled)

    // Nothing changed: no push, no pull request.
    const quiet = fakeSdk(tempDir(), { checkout: `${base}\nmain`, bundled: 'unchanged' })
    const none = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--repo', 'https://github.com/acme/web.git', '--no-install', '--push', '--json'], { env: { ...env, ...quiet.env } })
    api.close()
    expect(JSON.parse(none.stdout)).toMatchObject({ exit: 0, pr: null })
  })

  it('vercel: a --ready --loop worker stays here and gives each task a sandbox of its own, under a claim made for it', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    // This machine has the board; sandboxes reach it at another address.
    const local = { MUSTER_SANDBOX_URL: 'https://board.example.com/api/board', ...sdk.env }
    const ids: number[] = []
    for (const text of ['first', 'second']) ids.push(JSON.parse((await cli(dir, ['tasks', 'create', 'swarm/web', text, '--json'])).stdout).task.id)
    const run = await cli(dir, ['run', '--ready', 'swarm/web', '--loop', '--wait', '1s', '--runner', 'vercel', '--agent', 'claude', '--as', 'agent-1'], { env: local })
    expect(run.code).toBe(0)
    const lines = await sdk.read()
    const created = lines.filter((e) => e.create)
    expect(created).toHaveLength(2)
    // Each sandbox runs one task, by ID, with the token of the claim made for it here: no two alike.
    const started = lines.filter((e) => e.run?.detached)
    expect(started.map((e) => /'run' '(\d+)'/.exec(e.run.args[1])?.[1]).map(Number)).toEqual(ids)
    const tokens = created.map((e) => e.create.env.MUSTER_CLAIM_TOKEN)
    expect(tokens.every((token: string) => /^[\w-]{43}$/.test(token))).toBe(true)
    expect(new Set(tokens).size).toBe(2)
    expect(lines.filter((e) => e.deleted)).toHaveLength(2)
    // The claims are the agent's, so mu run in each sandbox, as that agent, holds them.
    for (const id of ids) expect(JSON.parse((await cli(dir, ['read', String(id), '--json'])).stdout).task.claim.by.profile).toBe('agent-1')
    // --push with --ready needs the worker: a sandbox per task.
    const refused = await cli(dir, ['run', '--ready', 'swarm/web', '--runner', 'vercel', '--agent', 'claude', '--as', 'agent-1', '--repo', 'https://github.com/acme/web.git', '--push', '--json'], { env: local })
    expect(JSON.parse(refused.stderr).error.reason).toBe('push_unsupported')
  })

  it('vercel: a --ready --loop worker with --label takes only the ready tasks that carry it', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir)
    const local = { MUSTER_SANDBOX_URL: 'https://board.example.com/api/board', ...sdk.env }
    const other = JSON.parse((await cli(dir, ['tasks', 'create', 'swarm/web', 'not mine', '--json'])).stdout).task.id
    const mine = JSON.parse((await cli(dir, ['tasks', 'create', 'swarm/web', 'mine', '--label', 'workflow=review', '--label', 'request=7', '--json'])).stdout).task.id
    const run = await cli(dir, ['run', '--ready', 'swarm/web', '--loop', '--wait', '1s', '--runner', 'vercel', '--agent', 'claude', '--as', 'agent-1', '--label', 'workflow=review', '--label', 'request=7'], { env: local })
    expect(run.code).toBe(0)
    const started = (await sdk.read()).filter((e) => e.run?.detached)
    expect(started.map((e) => Number(/'run' '(\d+)'/.exec(e.run.args[1])?.[1]))).toEqual([mine])
    expect(JSON.parse((await cli(dir, ['read', String(other), '--json'])).stdout).task.state).toBe('ready')
  })

  it('vercel: --detach starts it and returns, leaving the sandbox to its timeout', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir, { after: 5000 })
    const started = Date.now()
    const run = await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude', '--detach', '--json'], { env: { ...board, ...sdk.env } })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(JSON.parse(run.stdout)).toEqual({ task: 12, runner: 'vercel', run: 'sbx_44' })
    expect((await sdk.read()).some((e) => e.deleted || e.update === 'deny-all')).toBe(false)
  })

  it('vercel: stopping mu run here ends the sandbox too', async () => {
    const dir = tempDir()
    const sdk = fakeSdk(dir, { after: 60_000 })
    const run = cliStart(dir, ['run', '12', '--runner', 'vercel', '--agent', 'claude'], { ...board, ...sdk.env })
    for (let i = 0; i < 100 && !run.output().includes('started'); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    run.child.kill('SIGINT')
    const ended = await run.done
    expect(ended.code).toBe(130)
    const lines = await sdk.read()
    expect(lines.some((e) => e.update === 'deny-all')).toBe(true)
    expect(lines.some((e) => e.deleted)).toBe(true)
  }, 15_000)

  it('with --ready the sandbox is a worker that takes tasks itself until none is ready', async () => {
    const dir = tempDir()
    const log = join(dir, 'sdk.log')
    mkdirSync(join(dir, 'sdk'))
    writeFileSync(join(dir, 'sdk', 'index.mjs'), `import { appendFileSync } from 'node:fs'\nexport const Sandbox = { async create() { return { sandboxId: 'sbx_7', runCommand: async (c) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n'), update: async (o) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ closedTo: Object.keys(o.networkPolicy.allow) }) + '\\n'), stop: async () => {} } } }\n`)
    const run = await cli(dir, ['run', '--ready', 'work/', '--runner', 'vercel', '--agent', 'claude', '--as', 'worker-3', '--json'], { env: { ...board, MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') } })
    expect(JSON.parse(run.stdout)).toEqual({ ready: 'work/', runner: 'vercel', run: 'sbx_7' })
    const { readFileSync } = await import('node:fs')
    const started = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).at(-1)
    // A worker: the next ready task, a fresh agent on it, and again until none is ready.
    expect(started.args[1]).toContain("'mu' 'run' '--ready' 'work/' '--loop' '--wait' '2m' '--as' 'worker-3' '--bypass-permissions' '--timeout' '30m' '--agent' 'claude'")
  })

  it('starts nothing with a token that would hand the sandbox more than one agent\'s reach, or with none', async () => {
    const dir = tempDir()
    const refused = async (token: string | undefined, args: string[] = []) => {
      const { MUSTER_AGENT_TOKEN: _, ...rest } = board
      const run = await cli(dir, ['run', '1', '--runner', 'vercel', '--agent', 'claude', ...args, '--json'], { env: { ...rest, ...(token ? { MUSTER_AGENT_TOKEN: token } : {}), MUSTER_VERCEL_SDK: '/no/such/module.mjs' } })
      return JSON.parse(run.stderr).error.reason
    }
    // Your own token is never passed on in its place.
    expect(await refused(undefined)).toBe('agent_token_missing')
    // With a name for the agent, a token is made for it by the board, which here can't be reached.
    expect(await refused(undefined, ['--as', 'fixer'])).toMatch(/runner_not_installed|network_error/)
    expect(await refused(agent({ profile: 'fixer' }))).toBe('agent_token_too_wide')
    expect(await refused(agent({ profile: 'fixer', can: {} }))).toBe('agent_token_too_wide')
    expect(await refused(agent({ profile: null, can: { 'work/': ['read', 'post'] } }))).toBe('agent_token_too_wide')
    expect(await refused(agent({ profile: 'fixer', can: { '*': ['read', 'post'] } }))).toBe('agent_token_too_wide')
    expect(await refused(agent({ profile: 'fixer', can: { 'work/': ['manage'] } }))).toBe('agent_token_too_wide')
    expect(await refused('not-a-token')).toBe('agent_token_too_wide')
    // One that is narrow gets as far as loading the runner.
    expect(await refused(agent())).toMatch(/runner_not_installed|network_error/)
    // A repository address with a credential in it, or not over HTTPS, would put that in the sandbox.
    expect(await refused(agent(), ['--repo', 'https://x-access-token:ghp_x@github.com/acme/web.git'])).toBe('invalid_repo')
    expect(await refused(agent(), ['--repo', 'git@github.com:acme/web.git'])).toBe('invalid_repo')
    expect(await refused(agent(), ['--repo', 'http://github.com/acme/web.git'])).toBe('invalid_repo')
  })

  it('says what is missing: no board URL, no Worker, no SDK, or a runner it does not know', async () => {
    const dir = tempDir()
    const reason = async (args: string[], env: Record<string, string>) => JSON.parse((await cli(dir, [...args, '--json'], { env })).stderr).error.reason
    await cli(dir, ['tasks', 'create', 'work', 't'])
    expect(await reason(['run', '1', '--runner', 'cloudflare', '--agent', 'claude'], {})).toBe('board_not_reachable')
    expect(await reason(['run', '1', '--runner', 'cloudflare', '--agent', 'claude'], board)).toMatch(/runner_not_configured|network_error/)
    expect(await reason(['run', '1', '--runner', 'vercel', '--agent', 'claude'], { ...board, MUSTER_VERCEL_SDK: '/no/such/module.mjs' })).toMatch(/runner_not_installed|network_error/)
    expect(await reason(['run', '1', '--runner', 'mars', '--agent', 'claude'], board)).toMatch(/unknown_runner|network_error/)
  })
})
