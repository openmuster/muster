import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conformance, mint } from '../src/index.ts'
import { cli, memoryBoard, tempDir } from './helpers.ts'

describe('conformance', () => {
  it('this backend passes every check', async () => {
    const { team } = memoryBoard()
    const checks = await conformance(team)
    expect(checks.filter((check) => !check.ok)).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(18)
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
    expect(Object.keys(lines[0].networkPolicy.allow).sort()).toEqual(['board.example.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
    // The sandbox installs this CLI's own release from its tarball, never a package looked up by name.
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(lines[1]).toEqual({ cmd: 'npm', args: ['install', '-g', `https://github.com/openmuster/muster/releases/download/v${version}/muster-${version}.tgz`] })
    // In a sandbox the agent's own prompts are off: headless, one would stop it at its first command.
    // GitHub was open for the install only: the agent starts with the board as its one way out.
    expect(lines[2]).toEqual({ closedTo: ['board.example.com'] })
    expect(lines[3].args[1]).toContain("'mu' 'run' '12' '--bypass-permissions' '--agent' 'codex'")
    // The agent's clean environment is told what the sandbox set that it must still see: the certificate for its intercepted connections.
    expect(lines[0].env.MUSTER_AGENT_ENV.split(',')).toEqual(expect.arrayContaining(['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'IS_SANDBOX', 'OPENAI_API_KEY']))
    // --safe keeps them on.
    await cli(dir, ['run', '12', '--runner', 'vercel', '--agent', 'codex', '--safe', '--json'], { env: { ...board, MUSTER_VERCEL_SDK: join(dir, 'sdk', 'index.mjs') } })
    const again = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(again.at(-1).args[1]).toContain("'mu' 'run' '12' '--agent' 'codex'")
    expect(again.at(-1).args[1]).not.toContain('--bypass-permissions')
  })

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
    expect(started.args[1]).toContain("'mu' 'run' '--ready' 'work/' '--loop' '--wait' '2m' '--as' 'worker-3' '--bypass-permissions' '--agent' 'claude'")
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
