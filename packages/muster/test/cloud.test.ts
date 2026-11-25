import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyPolicy, board, boardPolicy, claude, cloudflare, file, http, listen, mint, vercel } from '../src/index.ts'
import { INSTALL, memoryBases } from '../src/runner/cloud.ts'
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
    // A workflow request starts workers outside the sandbox, so it is closed.
    expect(SANDBOX_CLOSED).toContain('workflowRequest')
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
    // Where the checkout started is read, then the agent's policy replaces the setup's.
    expect(calls[2][1]).toMatchObject({ cmd: 'sh', cwd: '/vercel/web', args: ['-c', expect.stringContaining('git rev-parse HEAD')] })
    expect(calls[3][0]).toBe('update')
    // The agent starts in the repository, where Vercel cloned it.
    expect(calls[4][1]).toMatchObject({ cmd: 'sh', detached: true, cwd: '/vercel/web' })
    expect(calls[4][1].args[1]).toBe(`printf %s 'it'\\''s a prompt with '\\''quotes'\\''' | 'claude' '--print' '--output-format' 'stream-json' '--verbose' '--strict-mcp-config' '--disable-slash-commands' '--tools' 'Bash,Read,Edit,Write,Grep,Glob'`)
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
    expect(calls).toEqual([['create', ['codeload.github.com', 'github.com', 'objects.githubusercontent.com']], ['run', 'npm'], ['run', 'sh'], ['update', ['board.example.com']], ['run', 'sh']])
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
    // pnpm installs with the image's own pnpm, which fetches and keeps the pinned version while setup is
    // online, so the agent's \`pnpm test\` works offline; npx would leave nothing behind for it.
    expect(INSTALL).toContain('pnpm --version >/dev/null; pm=pnpm')
    expect(INSTALL).not.toMatch(/pm="npx -y \$v"/)
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

  /** A stand-in for the SDK with kept sandboxes: create, fork, get, list, and what each one holds. */
  const keeping = () => {
    const calls: any[] = []
    const kept = new Map<string, { status: string; files: Set<string>; env: Record<string, string> }>()
    const made = (name: string | undefined, files: Set<string>, env: Record<string, string>) => ({
      name: name ?? `sbx-${calls.length}`,
      runCommand: async (command: any) => {
        calls.push(['run', name ?? 'fork', [command.cmd, ...command.args].join(' ')])
        if (command.cmd === 'touch') files.add(command.args[0])
        if (command.cmd === 'test') return { exitCode: files.has(command.args[1]) ? 0 : 1 }
        return command.detached ? {} : { exitCode: 0, stdout: async () => '' }
      },
      update: async (options: any) => void calls.push(['update', name ?? 'fork', options.networkPolicy === 'deny-all' ? 'deny-all' : Object.keys(options.networkPolicy.allow)]),
      stop: async () => {
        calls.push(['stop', name ?? 'fork'])
        if (name && kept.has(name)) kept.get(name)!.status = 'stopped'
      },
      delete: async () => {
        calls.push(['delete', name ?? 'fork'])
        if (name) kept.delete(name)
      },
    })
    const Sandbox = {
      create: async (options: any) => {
        calls.push(['create', options.name ?? null, options.persistent, Object.keys(options.networkPolicy.allow), Object.keys(options.env)])
        if (options.name) {
          if (kept.has(options.name)) throw new Error('name taken')
          kept.set(options.name, { status: 'running', files: new Set(), env: options.env })
          return made(options.name, kept.get(options.name)!.files, options.env)
        }
        return made(undefined, new Set(), options.env)
      },
      fork: async (options: any) => {
        calls.push(['fork', options.sourceSandbox, options.persistent, Object.keys(options.networkPolicy.allow)])
        return made(undefined, new Set(kept.get(options.sourceSandbox)!.files), options.env)
      },
      get: async ({ name }: any) => {
        const one = kept.get(name)
        if (!one) throw new Error('404')
        return { status: one.status, delete: async () => (calls.push(['delete', name]), kept.delete(name)) }
      },
    }
    return { calls, kept, Sandbox }
  }

  it('vercel: with a base, setup runs once in a kept sandbox that holds no credential, and each run is forked from it and clones the repository itself', async () => {
    const { calls, kept, Sandbox } = keeping()
    const runner = vercel({ Sandbox, setupHosts: ['github.com'], base: true })
    await runner.start(request)
    const [base] = [...kept.keys()]
    // Named so nobody can guess it, and forked only because this runner wrote it down.
    expect(base).toMatch(/^muster-base-[0-9a-f]{12}-[0-9a-f]{12}$/)
    // The base: kept, made under the setup's hosts alone and an empty environment, set up, marked, and stopped to save it.
    expect(calls[0]).toEqual(['create', base, true, ['github.com'], []])
    expect(calls.slice(1, 4)).toEqual([['run', base, 'npm install -g https://example.com/muster.tgz'], ['run', base, `touch /vercel/.muster-base-ready`], ['stop', base]])
    // The run: forked, not kept, checked, the repository cloned, and the agent's policy before the agent.
    expect(calls[4]).toEqual(['fork', base, false, ['github.com', 'codeload.github.com']])
    expect(calls.slice(5, 7).map((call) => call[2])).toEqual(['test -f /vercel/.muster-base-ready', 'git clone --quiet -- https://github.com/acme/web.git /vercel/web'])
    expect(calls.some((call) => call[0] === 'run' && call[1] === 'fork' && String(call[2]).startsWith('npm install'))).toBe(false)
    // The next run forks the same base and sets nothing up again.
    calls.length = 0
    await runner.start(request)
    expect(calls.filter((call) => call[0] === 'create')).toEqual([])
    expect(calls[0]).toEqual(['fork', base, false, ['github.com', 'codeload.github.com']])
    // Another version of muster makes another base, and the old one goes.
    calls.length = 0
    await runner.start({ ...request, setup: [['npm', 'install', '-g', 'https://example.com/muster-2.tgz']] })
    expect([...kept.keys()]).toHaveLength(1)
    expect([...kept.keys()][0]).not.toBe(base)
    expect(calls).toContainEqual(['delete', base])
    // A task's earlier round is cloned by its branch; a checkout that isn't at the commit asked for starts no agent.
    calls.length = 0
    const ref = { branch: 'mu/task-7', sha: 'c'.repeat(40) }
    expect(await runner.start({ ...request, setup: [['npm', 'install', '-g', 'https://example.com/muster-2.tgz']], ref }).catch((error) => error.reason)).toBe('runner_setup_failed')
    expect(calls.map((call) => call[2])).toContain('git clone --quiet --branch mu/task-7 -- https://github.com/acme/web.git /vercel/web')
    expect(calls.some((call) => call[0] === 'run' && String(call[2]).includes('claude'))).toBe(false)
  })

  it('vercel: a kept sandbox this machine didn\'t make, or one that didn\'t stop cleanly, is never forked', async () => {
    const { calls, kept, Sandbox } = keeping()
    // Someone else's, named like a base and holding the mark.
    kept.set('muster-base-000000000000-planted', { status: 'stopped', files: new Set(['/vercel/.muster-base-ready']), env: {} })
    const bases = memoryBases()
    const runner = vercel({ Sandbox, setupHosts: ['github.com'], base: true, bases })
    await runner.start(request)
    expect(calls.filter((call) => call[0] === 'fork').map((call) => call[1])).not.toContain('muster-base-000000000000-planted')
    expect(kept.has('muster-base-000000000000-planted')).toBe(true)
    const mine = bases.entries()[0]![1]
    // One of ours that failed is not taken either: it is made again.
    kept.get(mine!)!.status = 'failed'
    calls.length = 0
    await runner.start(request)
    expect(calls.find((call) => call[0] === 'create')?.[2]).toBe(true)
    expect(bases.entries()).toHaveLength(1)
    expect(bases.entries()[0]![1]).not.toBe(mine)
  })

  it('vercel: a base whose making was cut short is removed, and the run is set up the long way', async () => {
    const { calls, kept, Sandbox } = keeping()
    const runner = vercel({ Sandbox, setupHosts: ['github.com'], base: true })
    await runner.start(request)
    const [base] = [...kept.keys()]
    kept.get(base!)!.files.clear()
    calls.length = 0
    await runner.start(request)
    expect(calls).toContainEqual(['delete', base])
    // Made fresh, with Vercel's own clone, and set up in it.
    const fresh = calls.find((call) => call[0] === 'create' && call[1] === null)
    expect(fresh).toBeDefined()
    expect(calls).toContainEqual(['run', 'fork', 'npm install -g https://example.com/muster.tgz'])
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

  it("cloudflare: a private repository's clone token goes to the Worker for its clone routes, never into the container's environment", async () => {
    const sent: any[] = []
    const fetcher = (async (_url: any, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body))), Response.json({ id: 'r' }))) as typeof fetch
    await cloudflare({ worker: 'https://w.example', secret: 's', fetch: fetcher }).start({ ...request, repo: 'https://github.com/acme/web.git', github: { token: 'ghs_clone' } })
    expect(sent[0].repo).toBe('https://github.com/acme/web.git')
    expect(sent[0].repoAuth).toBe(`Basic ${Buffer.from('x-access-token:ghs_clone').toString('base64')}`)
    expect(JSON.stringify(sent[0].env)).not.toContain('ghs_clone')
    // A public repository is cloned with nothing added.
    await cloudflare({ worker: 'https://w.example', secret: 's', fetch: fetcher }).start({ ...request, repo: 'https://github.com/acme/web.git' })
    expect(sent[1].repoAuth).toBeUndefined()
  })

  it("cloudflare: sends Vercel's install script when asked, and passes on only what an install can say it did", async () => {
    const sent: any[] = []
    let answer: unknown = { id: 'r', installed: 'pnpm' }
    const fetcher = (async (_url: any, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body))), Response.json(answer))) as typeof fetch
    const runner = cloudflare({ worker: 'https://w.example', secret: 's', fetch: fetcher })
    const repo = 'https://github.com/acme/web.git'
    const run = await runner.start({ ...request, repo, install: true })
    expect(sent[0].install).toBe(INSTALL)
    expect(run.installed).toBe('pnpm')
    // Started to be read, it is said the same way.
    answer = { id: 'r', installed: 'failed (exit 124)' }
    expect((await runner.start({ ...request, repo, install: true, attach: true })).installed).toBe('failed (exit 124)')
    answer = { id: 'r', installed: 'failed (timeout)' }
    expect((await runner.start({ ...request, repo, install: true })).installed).toBe('failed (timeout)')
    // The Worker's word comes out of a container: what isn't one of the answers is dropped.
    answer = { id: 'r', installed: 'pnpm\nmalicious' }
    expect((await runner.start({ ...request, repo, install: true })).installed).toBeUndefined()
    // Not asked, or nothing to install into: no script goes.
    answer = { id: 'r' }
    await runner.start({ ...request, repo })
    const { repo: _, ...noRepo } = request
    await runner.start({ ...noRepo, install: true })
    expect(sent.slice(-2).map((body) => body.install)).toEqual([undefined, undefined])
  })

  it("cloudflare: a run started to be read is waited on until its agent exits, and gives back only what it should", async () => {
    const asked: string[] = []
    let polls = 0
    const worker = (answers: { start?: unknown; file?: Uint8Array; gone?: boolean } = {}) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname + new URL(String(url)).search
        asked.push(`${init?.method} ${path}`)
        if (path === '/runs') return Response.json(answers.start ?? { id: 'r1', checkout: { sha: 'a'.repeat(40), branch: 'main' } })
        if (init?.method === 'GET' && path === '/runs/r1') return answers.gone ? new Response('', { status: 404 }) : Response.json(polls++ < 2 ? { state: 'running', exitCode: null } : { state: 'exited', exitCode: 3 })
        if (path.startsWith('/runs/r1/file')) return new Response(Buffer.from(answers.file ?? new Uint8Array([1, 2, 3])))
        return Response.json({ exitCode: 0, stdout: 'ok' })
      }) as typeof fetch
    const run = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker(), pollMs: 1 }).start({ ...request, repo: 'https://github.com/acme/web.git', attach: true })
    expect(run.checkout).toEqual({ sha: 'a'.repeat(40), branch: 'main' })
    expect(await run.wait!()).toEqual({ exitCode: 3 })
    expect(polls).toBe(3)
    // Only closing is something the Worker does to a run's network.
    await run.setPolicy!('deny-all')
    expect(asked).toContain('POST /runs/r1/close')
    expect(await reason(run.setPolicy!({ 'example.com': [] }))).toBe('push_unsupported')
    expect(await run.readFile!('/tmp/x', 3)).toEqual(Buffer.from([1, 2, 3]))
    // What the Worker sends is held to the limit here too.
    const big = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker({ file: new Uint8Array(10) }) }).start({ ...request, attach: true })
    expect(await big.readFile!('/tmp/x', 9)).toBeNull()
    // A run that is gone has no exit code; a checkout that can't be a pull request's base isn't one.
    const gone = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker({ gone: true, start: { id: 'r1', checkout: { sha: 'a'.repeat(40), branch: 'HEAD' } } }) }).start({ ...request, attach: true })
    expect(await gone.wait!()).toEqual({ exitCode: null })
    expect(gone.checkout).toBeUndefined()
    const odd = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker({ start: { id: 'r1', checkout: { sha: '--upload-pack=x', branch: 'main' } } }) }).start({ ...request, attach: true })
    expect(odd.checkout).toBeUndefined()
    // A Worker error or a dropped connection on the way is asked again, not taken as the end of the run.
    let answers = 0
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/runs') return Response.json({ id: 'r2' })
      answers++
      if (answers === 1) throw new TypeError('fetch failed')
      if (answers === 2) return new Response('', { status: 503 })
      return Response.json({ state: 'exited', exitCode: 0 })
    }) as typeof fetch
    expect(await (await cloudflare({ worker: 'https://w.example', secret: 's', fetch: flaky, pollMs: 1 }).start({ ...request, attach: true })).wait!()).toEqual({ exitCode: 0 })
    expect(answers).toBe(3)
    // A run not started to be read returns at once, as before: nothing to wait on or read.
    const detached = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker() }).start(request)
    expect(Object.keys(detached).sort()).toEqual(['id', 'stop'])
  })

  it("cloudflare: a task's earlier round is cloned by its branch, and a Worker that started anywhere else has its run stopped", async () => {
    const round1 = 'c'.repeat(40)
    const asked: { path: string; body: any }[] = []
    const worker = (sha: string) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        asked.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (path === '/runs') return Response.json({ id: 'r1', checkout: { sha, branch: sha === round1 ? 'mu/task-7' : 'main' } })
        return Response.json({})
      }) as typeof fetch
    const ref = { branch: 'mu/task-7', sha: round1 }
    const run = await cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker(round1) }).start({ ...request, repo: 'https://github.com/acme/web.git', ref, attach: true })
    expect(asked[0]!.body.ref).toBe('mu/task-7')
    expect(run.checkout).toEqual({ sha: round1, branch: 'mu/task-7' })
    // A Worker deployed before it knew `ref` clones main: its run is stopped, so nothing replaces round one.
    asked.length = 0
    expect(await reason(cloudflare({ worker: 'https://w.example', secret: 's', fetch: worker('a'.repeat(40)) }).start({ ...request, repo: 'https://github.com/acme/web.git', ref, attach: true }))).toBe('runner_too_old')
    expect(asked.map((each) => each.path)).toContain('/runs/r1/stop')
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
