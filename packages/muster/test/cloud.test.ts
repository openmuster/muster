import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyPolicy, board, boardPolicy, claude, cloudflare, file, http, listen, mint, vercel } from '../src/index.ts'
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
        return { sandboxId: 'sbx_1', runCommand: async (command: any) => void calls.push(['run', command]), stop: async () => void calls.push(['stop']) }
      },
    }
    const run = await vercel({ Sandbox, allowHosts: { 'github.com': [] } }).start(request)
    expect(run.id).toBe('sbx_1')
    const created = calls[0][1]
    expect(created.env).toEqual({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy', MUSTER_TASK: '7' })
    expect(Object.keys(created.networkPolicy.allow).sort()).toEqual(['board.example.com', 'github.com'])
    // The policy is in the shape @vercel/sandbox 4 takes: a path is a matcher object, and the last rule
    // refuses what the others didn't claim, since allowing a host otherwise allows every request to it.
    const rules = created.networkPolicy.allow['board.example.com']
    expect(rules[0].match.path).toEqual({ regex: expect.stringContaining('^/api/board/(') })
    // The Host header is the sandbox's to write, and the match is on the connection's name alone: it is set with the credential.
    expect(rules[0].transform).toEqual([{ headers: { authorization: 'Bearer mu1.secret', host: 'board.example.com' } }])
    expect(created.persistent).toBe(false)
    expect(rules.at(-1)).toEqual({ response: { statusCode: 403 } })
    expect(created.image).toBe('vercel/sandbox/universal')
    expect(created.source).toEqual({ type: 'git', url: 'https://github.com/acme/web.git' })
    expect(JSON.stringify(created.env)).not.toContain('mu1.secret')
    expect(calls[1][1]).toEqual({ cmd: 'npm', args: ['install', '-g', 'https://example.com/muster.tgz'] })
    expect(calls[2][1]).toMatchObject({ cmd: 'sh', detached: true })
    expect(calls[2][1].args[1]).toBe(`printf %s 'it'\\''s a prompt with '\\''quotes'\\''' | 'claude' '--print' '--output-format' 'stream-json' '--verbose' '--strict-mcp-config' '--disable-slash-commands' '--tools' 'Bash,Read,Edit,Write,Grep,Glob'`)
    await run.stop()
    expect(calls.at(-1)).toEqual(['stop'])
  })

  it('vercel: the model\'s key is added to requests for the provider\'s host and never enters the sandbox', async () => {
    const calls: any[] = []
    const Sandbox = { create: async (options: any) => (calls.push(options), { name: 'sbx-2', runCommand: async (command: any) => void calls.push(command), stop: async () => {} }) }
    const run = await vercel({ Sandbox }).start({ ...request, model: { key: 'sk-real-key' } })
    expect(run.id).toBe('sbx-2')
    // The key goes only on the calls that ask the model; whatever else it could do on that host is refused.
    const model = calls[0].networkPolicy.allow['api.anthropic.com']
    expect(model).toEqual([{ match: { path: { regex: expect.any(String) }, method: ['POST'] }, transform: [{ headers: { 'x-api-key': 'sk-real-key', host: 'api.anthropic.com' } }] }, { response: { statusCode: 403 } }])
    const asks = (path: string) => new RegExp(model[0].match.path.regex).test(path)
    expect(['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens'].map(asks)).toEqual([true, true, true])
    expect(['/v1/files', '/v1/messages/batches', '/v1/organizations/api_keys', '/v1/messagesx', '/x/v1/messages'].map(asks)).toEqual([false, false, false, false, false])
    expect(calls[0].env).toMatchObject({ ANTHROPIC_API_KEY: 'set-by-the-network-policy', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    expect(JSON.stringify([calls[0].env, ...calls.slice(1)])).not.toContain('sk-real-key')
    // Without a key the provider's host stays closed and no placeholder is set.
    const bare: any[] = []
    await vercel({ Sandbox: { create: async (options: any) => (bare.push(options), { name: 'sbx-3', runCommand: async () => {}, stop: async () => {} }) } }).start(request)
    expect(Object.keys(bare[0].networkPolicy.allow)).toEqual(['board.example.com'])
    expect(bare[0].env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('vercel: the hosts its setup needs are closed before the agent starts', async () => {
    const calls: any[] = []
    const made = { name: 'sbx-4', runCommand: async (command: any) => void calls.push(['run', command.cmd]), update: async (options: any) => void calls.push(['update', options.networkPolicy === 'deny-all' ? 'deny-all' : Object.keys(options.networkPolicy.allow)]), stop: async () => void calls.push(['stop']) }
    const Sandbox = { create: async (options: any) => (calls.push(['create', Object.keys(options.networkPolicy.allow).sort()]), made) }
    await vercel({ Sandbox, setupHosts: ['github.com'] }).start(request)
    expect(calls).toEqual([['create', ['board.example.com', 'github.com']], ['run', 'npm'], ['update', ['board.example.com']], ['run', 'sh']])
    // A sandbox that can't be closed again is stopped, and the agent never starts in it.
    calls.length = 0
    const { update: _, ...old } = made
    expect(await reason(vercel({ Sandbox: { create: async () => old }, setupHosts: ['github.com'] }).start(request))).toBe('runner_too_old')
    expect(calls).toEqual([['run', 'npm'], ['stop']])
    // With nothing to set up, the setup's hosts are never opened at all.
    calls.length = 0
    await vercel({ Sandbox, setupHosts: ['github.com'] }).start({ ...request, setup: [] })
    expect(calls).toEqual([['create', ['board.example.com']], ['run', 'sh']])
  })

  it('vercel: ending a run closes its way out and removes the sandbox, so nothing of it is kept', async () => {
    const calls: unknown[] = []
    const made = { name: 'sbx-5', runCommand: async () => {}, update: async (options: any) => void calls.push(['update', options.networkPolicy === 'deny-all' ? 'deny-all' : 'policy']), delete: async () => void calls.push(['delete']), stop: async () => void calls.push(['stop']) }
    const run = await vercel({ Sandbox: { create: async () => made } }).start({ ...request, setup: [] })
    await run.stop()
    expect(calls).toEqual([['update', 'deny-all'], ['delete']])
    // An SDK that can't remove one stops it instead.
    calls.length = 0
    const { delete: _, ...old } = made
    await (await vercel({ Sandbox: { create: async () => old } }).start({ ...request, setup: [] })).stop()
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
    expect(calls[0]!.body.env).toEqual({ MUSTER_URL: URL_, MUSTER_TOKEN: 'set-by-the-network-policy', MUSTER_TASK: '7' })
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
