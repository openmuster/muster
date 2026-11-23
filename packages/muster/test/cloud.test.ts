import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyPolicy, board, boardPolicy, claude, cloudflare, file, http, listen, mint, vercel } from '../src/index.ts'
import { INSTALL } from '../src/runner/cloud.ts'
import { SANDBOX_CLOSED, SANDBOX_ROUTES } from '../src/runner/policy.ts'
import { ROUTES } from '../src/serve/server.ts'
import { reason } from './helpers.ts'

const URL_ = 'https://board.example.com/api/board'

describe('the sandbox network policy', () => {
  it('opens a named list of board routes to a sandbox, and every route is either on it or closed for a reason', () => {
    expect([...SANDBOX_ROUTES].sort()).toEqual([
      'actors', 'budgets', 'channels', 'createChannel', 'edit', 'events', 'fileGet', 'filePut', 'head', 'label', 'post', 'react', 'readChannel', 'readThread', 'remove', 'reply', 'schemaList', 'search',
      'task', 'taskAssign', 'taskBlock', 'taskCancel', 'taskClaim', 'taskComplete', 'taskCreate', 'taskFail', 'taskList', 'taskNeeds', 'taskPlan', 'taskRelease', 'taskRenew', 'taskReopen', 'taskUnblock',
    ])
    // A route added to the board is in neither list until someone decides, and this fails until they do.
    expect([...SANDBOX_ROUTES, ...SANDBOX_CLOSED].sort()).toEqual([...ROUTES].sort())
    const { networkPolicy } = boardPolicy({ url: URL_, token: 'T' })
    for (const closed of SANDBOX_CLOSED) expect(applyPolicy(networkPolicy, { url: `${URL_}/${closed}`, method: 'POST' })).toBeNull()
    // The routes that make and stop tokens aren't board routes at all, and a sandbox can't reach them either.
    for (const route of ['tokenCreate', 'tokenList', 'tokenRevoke']) expect(applyPolicy(networkPolicy, { url: `${URL_}/${route}`, method: 'POST' })).toBeNull()
  })

  it('gives a sandbox the board with no credential inside it: the environment holds a placeholder', () => {
    const { env, networkPolicy } = boardPolicy({ url: URL_, token: 'mu1.secret.token' })
    expect(env).toEqual({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy' })
    expect(JSON.stringify(env)).not.toContain('mu1.secret.token')
    expect(Object.keys(networkPolicy.allow)).toEqual(['board.example.com'])
  })

  it('adds the credential only to the board\'s own routes, by method, and passes nothing else', () => {
    const { networkPolicy } = boardPolicy({ url: URL_, token: 'T' })
    const pass = (url: string, method = 'POST') => applyPolicy(networkPolicy, { url, method })
    expect(pass(`${URL_}/post`)).toEqual({ authorization: 'Bearer T', host: 'board.example.com' })
    expect(pass(`${URL_}/taskClaim`)).toEqual({ authorization: 'Bearer T', host: 'board.example.com' })
    expect(pass(`${URL_}/whoami`, 'GET')).toEqual({ authorization: 'Bearer T', host: 'board.example.com' })
    for (const [url, method] of [
      [`${URL_}/post`, 'GET'],
      [`${URL_}/webhooks/gh`, 'POST'],
      [`${URL_}/scheduleCreate`, 'POST'],
      [`${URL_}/scheduleTick`, 'POST'],
      [`${URL_}/post/extra`, 'POST'],
      [`${URL_}/../admin`, 'POST'],
      [`${URL_}/post/..%2f..%2fadmin`, 'POST'],
      [`${URL_}/x/../post`, 'POST'],
      ['https://board.example.com/other', 'POST'],
      ['https://evil.example/api/board/post', 'POST'],
      ['https://board.example.com.evil.example/api/board/post', 'POST'],
    ] as const) {
      expect([url, method, pass(url, method)]).toEqual([url, method, null])
    }
  })

  it('refuses a board on this machine, and one that is not HTTPS', async () => {
    expect(await reason(Promise.resolve().then(() => boardPolicy({ url: 'http://127.0.0.1:4100/api/board', token: 'T' })))).toBe('board_not_reachable')
    expect(await reason(Promise.resolve().then(() => boardPolicy({ url: 'http://board.example.com/api/board', token: 'T' })))).toBe('board_not_reachable')
  })

  it('end to end: an agent behind the policy uses the board as its profile and cannot reach past its channels', async () => {
    const backend = file({ memory: true, principal: 'local:user:ada' })
    const key = randomBytes(32)
    const server = await listen({ backend, key })
    const token = mint(key, { sub: 'local:user:ada', profile: 'fixer', can: { 'factory/': ['read', 'post', 'label'] }, exp: Math.floor(Date.now() / 1000) + 600 })
    const { networkPolicy, env } = boardPolicy({ url: URL_, token })
    // The sandbox's proxy: checks each outgoing request against the policy, adds what it says, and forwards it.
    const proxied = (async (input: string | URL | Request, init?: RequestInit) => {
      const added = applyPolicy(networkPolicy, { url: String(input), method: init?.method ?? 'GET' })
      if (!added) return new Response('blocked by the sandbox', { status: 403 })
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(added)) headers.set(name, value)
      return fetch(String(input).replace('https://board.example.com/api/board', server.url), { ...init, headers })
    }) as typeof fetch
    const inside = board({ backend: http({ url: env.MUSTER_URL!, token: env.MUSTER_TOKEN!, fetch: proxied }) })
    const message = await inside.as('admin').post({ channel: 'factory/intake', text: 'from the sandbox' })
    expect(message.by).toEqual({ principal: 'local:user:ada', profile: 'fixer' })
    expect(await reason(inside.post({ channel: 'security', text: 'x' }))).toBe('not_found')
    expect(await reason(inside.scheduleCreate({ channel: 'factory/intake', text: 'x', every: 600 }))).toBe('bad_answer')
    await server.close()
  })
})

describe('cloud runners', () => {
  const request = { task: 7, agent: claude, prompt: "it's a prompt with 'quotes'", board: { url: URL_, token: 'mu1.secret' }, repo: 'https://github.com/acme/web.git', setup: [['npm', 'install', '-g', 'https://example.com/muster.tgz']] }

  it('vercel: creates a sandbox with the policy and a placeholder token, prepares it, and starts the agent detached with the prompt on stdin', async () => {
    const calls: any[] = []
    const Sandbox = {
      async create(options: any) {
        calls.push(['create', options])
        return { sandboxId: 'sbx_1', runCommand: async (command: any) => void calls.push(['run', command]), update: async (options: any) => void calls.push(['update', options]), stop: async () => void calls.push(['stop']) }
      },
    }
    const run = await vercel({ Sandbox, allowHosts: { 'github.com': [] } }).start(request)
    expect(run.id).toBe('sbx_1')
    const created = calls[0][1]
    expect(created.env).toEqual({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy', MUSTER_TASK: '7' })
    // It is made under the setup's policy, which holds no credential: here, what cloning the repository needs.
    expect(Object.keys(created.networkPolicy.allow).sort()).toEqual(['codeload.github.com', 'github.com'])
    // The agent's replaces it once set up. It is in the shape @vercel/sandbox 4 takes: a path is a matcher
    // object, and the last rule refuses what the others didn't claim, since allowing a host allows every request to it.
    const agentPolicy = calls.find(([kind]) => kind === 'update')[1].networkPolicy
    expect(Object.keys(agentPolicy.allow).sort()).toEqual(['board.example.com', 'github.com'])
    const rules = agentPolicy.allow['board.example.com']
    expect(rules[0].match.path).toEqual({ regex: expect.stringContaining('^/api/board/(') })
    // The Host header is the sandbox's to write, and the match is on the connection's name alone: it is set with the credential.
    expect(rules[0].transform).toEqual([{ headers: { authorization: 'Bearer mu1.secret', host: 'board.example.com' } }])
    expect(created.persistent).toBe(false)
    expect(rules.at(-1)).toEqual({ response: { statusCode: 403 } })
    expect(created.image).toBe('vercel/sandbox/universal')
    expect(created.source).toEqual({ type: 'git', url: 'https://github.com/acme/web.git' })
    expect(JSON.stringify(created.env)).not.toContain('mu1.secret')
    expect(calls[1][1]).toEqual({ cmd: 'npm', args: ['install', '-g', 'https://example.com/muster.tgz'] })
    expect(calls[2][0]).toBe('update')
    // The agent starts in the repository, where Vercel cloned it.
    expect(calls[3][1]).toMatchObject({ cmd: 'sh', detached: true, cwd: '/vercel/web' })
    expect(calls[3][1].args[1]).toBe(`printf %s 'it'\\''s a prompt with '\\''quotes'\\''' | 'claude' '--print' '--output-format' 'stream-json' '--verbose' '--strict-mcp-config' '--disable-slash-commands' '--tools' 'Bash,Read,Edit,Write,Grep,Glob'`)
    await run.stop()
    expect(calls.at(-1)).toEqual(['stop'])
  })

  it('vercel: a setup step that fails ends the sandbox and starts no agent', async () => {
    const calls: any[] = []
    const made = {
      sandboxId: 'sbx_9',
      runCommand: async (command: any) => (calls.push(['run', command]), command.detached ? {} : { exitCode: 1 }),
      update: async (options: any) => void calls.push(['update', options]),
      delete: async () => void calls.push(['delete']),
      stop: async () => void calls.push(['stop']),
    }
    const failed = await vercel({ Sandbox: { create: async () => made } }).start(request).catch((error) => error)
    expect(failed.reason).toBe('runner_setup_failed')
    expect(failed.message).toContain('npm install -g https://example.com/muster.tgz')
    expect(failed.message).toContain('exited 1')
    expect(calls.some(([kind, command]) => kind === 'run' && command.detached)).toBe(false)
    expect(calls.slice(-2)).toEqual([['update', { networkPolicy: 'deny-all' }], ['delete']])
  })

  it('vercel: a failed setup step is named without the credential or query a URL in it carries', async () => {
    const made = { sandboxId: 'sbx_12', runCommand: async (command: any) => (command.detached ? {} : { exitCode: 1 }), update: async () => {}, delete: async () => {}, stop: async () => {} }
    const failed = await vercel({ Sandbox: { create: async () => made } }).start({ ...request, setup: [['npm', 'install', '-g', 'https://ada:hunter2@pkgs.example.com/muster.tgz?sig=abc123']] }).catch((error) => error)
    expect(failed.reason).toBe('runner_setup_failed')
    expect(failed.message).toContain('https://pkgs.example.com/muster.tgz')
    expect(failed.message).not.toMatch(/hunter2|ada|abc123/)
  })

  it('vercel: a run can be waited on until mu run in the sandbox exits, and asked again after a dropped wait', async () => {
    let waits = 0
    const made = {
      sandboxId: 'sbx_10',
      runCommand: async (command: any) => (command.detached ? { wait: async () => (++waits === 1 ? Promise.reject(new Error('socket hang up')) : { exitCode: 3 }) } : { exitCode: 0 }),
      update: async () => {},
      stop: async () => {},
    }
    const run = await vercel({ Sandbox: { create: async () => made } }).start(request)
    await expect(run.wait!()).rejects.toThrow('socket hang up')
    expect(await run.wait!()).toEqual({ exitCode: 3 })
    // An SDK whose detached command can't be waited on gives a run that can't be either.
    const old = await vercel({ Sandbox: { create: async () => ({ sandboxId: 'sbx_11', runCommand: async () => undefined, update: async () => {}, stop: async () => {} }) } }).start(request)
    expect(old.wait).toBeUndefined()
  })

  it('vercel: the model\'s key is added to requests for the provider\'s host and never enters the sandbox', async () => {
    const calls: any[] = []
    const policies: any[] = []
    const Sandbox = { create: async (options: any) => (calls.push(options), { name: 'sbx-2', runCommand: async (command: any) => void calls.push(command), update: async (options: any) => void policies.push(options.networkPolicy), stop: async () => {} }) }
    const run = await vercel({ Sandbox }).start({ ...request, model: { key: 'sk-real-key' } })
    expect(run.id).toBe('sbx-2')
    // Not while it is set up: then nothing holds the key.
    expect(JSON.stringify(calls[0].networkPolicy)).not.toContain('sk-real-key')
    // The key goes only on the calls that ask the model; whatever else it could do on that host is refused.
    const model = policies[0].allow['api.anthropic.com']
    expect(model).toEqual([{ match: { path: { regex: expect.any(String) }, method: ['POST'] }, transform: [{ headers: { 'x-api-key': 'sk-real-key', host: 'api.anthropic.com' } }] }, { response: { statusCode: 403 } }])
    const asks = (path: string) => new RegExp(model[0].match.path.regex).test(path)
    expect(['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens'].map(asks)).toEqual([true, true, true])
    expect(['/v1/files', '/v1/messages/batches', '/v1/organizations/api_keys', '/v1/messagesx', '/x/v1/messages'].map(asks)).toEqual([false, false, false, false, false])
    expect(calls[0].env).toMatchObject({ ANTHROPIC_API_KEY: 'set-by-the-network-policy', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    expect(JSON.stringify([calls[0].env, ...calls.slice(1)])).not.toContain('sk-real-key')
    // Without a key the provider's host stays closed and no placeholder is set.
    const bare: any[] = []
    await vercel({ Sandbox: { create: async (options: any) => (bare.push(options), { name: 'sbx-3', runCommand: async () => {}, update: async (options: any) => void bare.push(options), stop: async () => {} }) } }).start(request)
    expect(Object.keys(bare[1].networkPolicy.allow)).toEqual(['board.example.com'])
    expect(bare[0].env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('vercel: the hosts its setup needs are closed before the agent starts', async () => {
    const calls: any[] = []
    const made = { name: 'sbx-4', runCommand: async (command: any) => void calls.push(['run', command.cmd]), update: async (options: any) => void calls.push(['update', options.networkPolicy === 'deny-all' ? 'deny-all' : Object.keys(options.networkPolicy.allow)]), stop: async () => void calls.push(['stop']) }
    const Sandbox = { create: async (options: any) => (calls.push(['create', Object.keys(options.networkPolicy.allow).sort()]), made) }
    await vercel({ Sandbox, setupHosts: ['objects.githubusercontent.com'] }).start(request)
    expect(calls).toEqual([['create', ['codeload.github.com', 'github.com', 'objects.githubusercontent.com']], ['run', 'npm'], ['update', ['board.example.com']], ['run', 'sh']])
    // A sandbox that can't be closed again is stopped before anything runs in it.
    calls.length = 0
    const { update: _, ...old } = made
    expect(await reason(vercel({ Sandbox: { create: async () => old }, setupHosts: ['github.com'] }).start(request))).toBe('runner_too_old')
    expect(calls).toEqual([['stop']])
    // With nothing to set up and no repository, it is made under the agent's policy, and nothing else is ever open.
    calls.length = 0
    const { repo: __, ...plain } = request
    await vercel({ Sandbox, setupHosts: ['github.com'] }).start({ ...plain, setup: [] })
    expect(calls).toEqual([['create', ['board.example.com']], ['run', 'sh']])
  })

  it('vercel: while it is set up, no credential is in its policy: not the board\'s, not the model\'s', async () => {
    const created: any[] = []
    const made = { name: 'sbx-6', runCommand: async () => ({ exitCode: 0 }), update: async () => {}, stop: async () => {} }
    await vercel({ Sandbox: { create: async (options: any) => (created.push(options), made) }, setupHosts: ['github.com'] }).start({ ...request, install: true, model: { key: 'sk-real-key' } })
    const during = JSON.stringify(created[0].networkPolicy)
    expect(during).not.toMatch(/transform|mu1\.secret|sk-real-key|board\.example\.com/)
  })

  it('vercel: with a repository, it installs its dependencies under the setup\'s open policy, in the checkout, and the agent starts there with the registry closed', async () => {
    const calls: any[] = []
    const answer = (stdout: string, exitCode = 0) => ({ exitCode, stdout: async () => stdout })
    let installAnswer = answer('Progress: done\ninstalled pnpm')
    const made = {
      name: 'sbx-7',
      runCommand: async (command: any) => (calls.push(['run', command]), command.args?.[1] === INSTALL ? installAnswer : answer('')),
      update: async (options: any) => void calls.push(['update', Object.keys(options.networkPolicy.allow)]),
      stop: async () => {},
    }
    const Sandbox = { create: async (options: any) => (calls.push(['create', options.networkPolicy.allow]), made) }
    const run = await vercel({ Sandbox, setupHosts: ['github.com'] }).start({ ...request, install: true })
    // Every host is open while it installs: a lockfile can name any registry. Nothing in that policy is a credential.
    expect(calls[0]).toEqual(['create', { '*': [] }])
    const install = calls.findIndex(([kind, command]) => kind === 'run' && command.args?.[1] === INSTALL)
    expect(calls[install][1]).toMatchObject({ cmd: 'sh', cwd: '/vercel/web' })
    // Install scripts never run, the dependencies' or the repository's own.
    expect(INSTALL).toContain('npm ci --ignore-scripts')
    expect(INSTALL).toContain('--frozen-lockfile --ignore-scripts')
    expect(INSTALL).toContain('YARN_ENABLE_SCRIPTS=false')
    const closed = calls.findIndex(([kind]) => kind === 'update')
    expect(closed).toBeGreaterThan(install)
    expect(calls[closed][1]).toEqual(['board.example.com'])
    expect(calls.at(-1)[1]).toMatchObject({ detached: true, cwd: '/vercel/web' })
    expect(run.installed).toBe('pnpm')
    // A failed install costs the agent its dependencies, not the run.
    calls.length = 0
    installAnswer = answer('', 1)
    const failed = await vercel({ Sandbox, setupHosts: ['github.com'] }).start({ ...request, install: true })
    expect(failed.installed).toBe('failed (exit 1)')
    expect(calls.at(-1)[1]).toMatchObject({ detached: true })
    // Without asking, nothing is installed and only what cloning needs was open.
    calls.length = 0
    const plain = await vercel({ Sandbox }).start({ ...request, setup: [] })
    expect(calls[0]).toEqual(['create', { 'github.com': [], 'codeload.github.com': [] }])
    expect(calls.some(([kind, command]) => kind === 'run' && command.args?.[1] === INSTALL)).toBe(false)
    expect(plain.installed).toBeUndefined()
  })

  it('vercel: ending a run closes its way out and removes the sandbox, so nothing of it is kept', async () => {
    const calls: unknown[] = []
    const made = { name: 'sbx-5', runCommand: async () => {}, update: async (options: any) => void calls.push(['update', options.networkPolicy === 'deny-all' ? 'deny-all' : 'policy']), delete: async () => void calls.push(['delete']), stop: async () => void calls.push(['stop']) }
    const run = await vercel({ Sandbox: { create: async () => made } }).start({ ...request, setup: [] })
    calls.length = 0
    await run.stop()
    expect(calls).toEqual([['update', 'deny-all'], ['delete']])
    // An SDK that can't remove one stops it instead.
    const { delete: _, ...old } = made
    const older = await vercel({ Sandbox: { create: async () => old } }).start({ ...request, setup: [] })
    calls.length = 0
    await older.stop()
    expect(calls).toEqual([['update', 'deny-all'], ['stop']])
  })

  it('cloudflare: asks your Worker to start the run, with the board rules for it to enforce and no token in the container\'s environment', async () => {
    const calls: { url: string; auth: string | null; body: any }[] = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return Response.json({ id: 'run-9' })
    }) as typeof fetch
    const run = await cloudflare({ worker: 'https://runner.example.workers.dev/', secret: 'worker-secret', fetch: fetcher }).start(request)
    expect(run.id).toBe('run-9')
    expect(calls[0]).toMatchObject({ url: 'https://runner.example.workers.dev/runs', auth: 'Bearer worker-secret' })
    // A container runs as root, where Claude Code skips its prompts only when told it is in a sandbox.
    expect(calls[0]!.body.env).toEqual({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy', MUSTER_TASK: '7', IS_SANDBOX: '1' })
    expect(calls[0]!.body.board).toMatchObject({ host: 'board.example.com', token: 'mu1.secret' })
    expect(calls[0]!.body.model).toBeUndefined()
    const keyed: any[] = []
    await cloudflare({ worker: 'https://w.example', secret: 's', fetch: (async (_url: any, init?: RequestInit) => (keyed.push(JSON.parse(String(init?.body))), Response.json({ id: 'r' }))) as typeof fetch }).start({ ...request, model: { key: 'sk-real-key' } })
    expect(keyed[0].model).toEqual({ host: 'api.anthropic.com', paths: [expect.stringContaining('/v1/messages')], headers: { 'x-api-key': 'sk-real-key' } })
    expect(JSON.stringify(keyed[0].env)).not.toContain('sk-real-key')
    expect(calls[0]!.body.command).toEqual(['claude', '--print', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Bash,Read,Edit,Write,Grep,Glob'])
    await run.stop()
    expect(calls[1]!.url).toBe('https://runner.example.workers.dev/runs/run-9/stop')
  })

  it('both refuse a board the sandbox could not reach before starting anything', async () => {
    const local = { ...request, board: { url: 'http://127.0.0.1:4100/api/board', token: 'T' } }
    let created = false
    const Sandbox = { create: async () => ((created = true), { sandboxId: 'x', runCommand: async () => {}, stop: async () => {} }) }
    expect(await reason(vercel({ Sandbox }).start(local))).toBe('board_not_reachable')
    expect(await reason(cloudflare({ worker: 'https://w.example', secret: 's', fetch: (async () => Response.json({ id: 'x' })) as typeof fetch }).start(local))).toBe('board_not_reachable')
    expect(created).toBe(false)
  })
})
