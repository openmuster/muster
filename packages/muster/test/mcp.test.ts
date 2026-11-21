import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refusal } from '../src/cli/mcp.ts'
import { BIN, cli, cliStart, tempDir } from './helpers.ts'
import { boardKey, mint } from '../src/serve/token.ts'

/** Starts `mu mcp` and speaks to it as an agent's MCP client would: one JSON message per line, answers matched by id. */
function client(dir: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (message: any) => void>()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      waiting.get(message.id)?.(message)
    }
  })
  let next = 0
  const ask = (method: string, params?: object) =>
    new Promise<any>((resolve) => {
      const id = ++next
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const mu = async (...args: string[]) => (await ask('tools/call', { name: 'mu', arguments: { args } })).result
  return { ask, mu, raw: (line: string) => child.stdin.write(`${line}\n`), waiting, close: () => child.kill() }
}

describe('mu mcp', () => {
  it('introduces itself and offers one tool, with the arguments mu takes', async () => {
    const mcp = client(tempDir())
    const hello = await mcp.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(hello.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'muster' } })
    mcp.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    const tools = (await mcp.ask('tools/list')).result.tools
    expect(tools.map((tool: any) => [tool.name, tool.inputSchema.required])).toEqual([['mu', ['args']]])
    mcp.close()
  })

  it('an agent with no shell posts, reads, takes a task and settles it, on the same board the CLI uses', async () => {
    const dir = tempDir()
    const mcp = client(dir, { MUSTER_PROFILE: 'ide-agent' })
    expect((await mcp.mu('post', 'general', 'hello from an agent with no shell')).content[0].text).toBe('posted  #1  #general')
    await cli(dir, ['tasks', 'create', 'work', 'summarise the design'])
    const claimed = await mcp.mu('tasks', 'claim', '--ready', 'work')
    expect([claimed.isError, claimed.content[0].text]).toEqual([false, expect.stringMatching(/^#2  yours for 15m/)])
    expect((await mcp.mu('tasks', 'complete', '2', 'summary posted')).isError).toBe(false)
    // The CLI sees what the tool wrote, and who wrote it.
    expect((await cli(dir, ['read', 'general'])).stdout).toMatch(/ide-agent via \S+/)
    expect(JSON.parse((await cli(dir, ['tasks', '--state', 'all', '--json'])).stdout).tasks[0]).toMatchObject({ state: 'completed', result: 'summary posted' })
    // A failure comes back as the CLI words it, marked as one, and --json gives a document.
    const missing = await mcp.mu('read', '999', '--json')
    expect([missing.isError, JSON.parse(missing.content[0].text).error.reason]).toEqual([true, 'not_found'])
    mcp.close()
  })

  it('a wait with no limit is given one, so a tool call always returns', async () => {
    const mcp = client(tempDir())
    await mcp.mu('post', 'general', 'x')
    const waited = await mcp.mu('wait', 'general', '--timeout', '1s')
    expect([waited.isError, waited.content[0].text]).toEqual([true, expect.stringContaining('Nothing matched')])
    mcp.close()
  })

  it('gives no shell and no way to the machine\'s files, and answers a bad request without dying', async () => {
    expect(refusal(['tasks', 'run', '1', '--', 'sh'])).toMatch(/after "--"|starts a command/)
    expect(refusal(['tasks', 'run', '1'])).toMatch(/starts a command/)
    // The verb is found wherever it sits: a flag put before it doesn't hide it.
    expect(refusal(['tasks', '--json', 'run', '1'])).toMatch(/starts a command/)
    expect(refusal(['tasks', '--label', 'a=b', 'run', '--ready', 'work'])).toMatch(/starts a command/)
    expect(refusal(['tasks', '--json', 'run', '--', 'sh', '-c', 'id'])).toMatch(/after "--"/)
    expect(refusal(['schemas', '--json', 'add', 'x@1'])).toMatch(/reads a file/)
    // Which board and which name were set by whoever started the server.
    expect(refusal(['read', 'general', '--board', 'other'])).toMatch(/--board is not available/)
    expect(refusal(['read', 'general', '--board=other'])).toMatch(/--board is not available|Unknown/)
    expect(refusal(['post', 'general', 'x', '--as', 'someone-else'])).toMatch(/--as is not available/)
    expect(refusal(['read', 'general', '--url', 'https://elsewhere.example/api/board'])).toMatch(/--url is not available/)
    expect(refusal(['run', '1', '--agent', 'claude'])).toMatch(/isn't available/)
    expect(refusal(['serve'])).toMatch(/isn't available/)
    expect(refusal(['token', 'create'])).toMatch(/isn't available/)
    expect(refusal(['post', 'general', '--file', '/etc/passwd'])).toMatch(/Reading a file/)
    expect(refusal(['post', 'general', 'x', '--attach=/etc/passwd'])).toMatch(/Reading a file/)
    expect(refusal(['post', 'general', '-'])).toMatch(/Reading a file/)
    expect(refusal(['read', 'general', '--dir', '/elsewhere'])).toMatch(/--dir is not available/)
    expect(refusal(['schemas', 'add', 'x@1'])).toMatch(/reads a file/)
    expect(refusal(['read', 'general'])).toBeNull()
    const mcp = client(tempDir())
    const blocked = await mcp.mu('tasks', 'run', '1', '--', 'sh')
    expect([blocked.isError, blocked.content[0].text]).toEqual([true, expect.stringMatching(/after "--"|starts a command/)])
    // And the real thing: with the verb hidden behind a flag, nothing runs on this machine.
    const hidden = await mcp.mu('tasks', '--json', 'run', '--ready', 'work')
    expect([hidden.isError, hidden.content[0].text]).toEqual([true, expect.stringContaining('starts a command')])
    expect((await mcp.ask('tools/call', { name: 'mu', arguments: { args: 'read general' } })).error.code).toBe(-32602)
    expect((await mcp.ask('tools/call', { name: 'other', arguments: {} })).error.code).toBe(-32602)
    expect((await mcp.ask('no/such')).error.code).toBe(-32601)
    // A line that isn't JSON is answered as an error, and the next request still works.
    const bad = new Promise<any>((resolve) => mcp.waiting.set(null as never, resolve))
    mcp.raw('not json')
    expect((await bad).error.code).toBe(-32700)
    expect((await mcp.ask('ping')).result).toEqual({})
    mcp.close()
  })
})

describe('mcp over http, on mu serve', () => {
  async function serve() {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    const serving = cliStart(dir, ['serve', '--port', '0'])
    for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const url = /MUSTER_URL=(\S+)/.exec(serving.output())![1]!
    const owner = /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]!
    let next = 0
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
    const ask = async (token: string, method: string, params?: object, headers: Record<string, string> = {}) =>
      (await post({ jsonrpc: '2.0', id: ++next, method, params }, { authorization: `Bearer ${token}`, ...headers })).json() as Promise<any>
    const mu = async (token: string, args: string[], headers: Record<string, string> = {}) => (await ask(token, 'tools/call', { name: 'mu', arguments: { args } }, headers)).result
    return { dir, url, owner, serving, post, ask, mu, stop: async () => (serving.child.kill('SIGTERM'), await serving.done) }
  }

  it('prints its address, and speaks MCP one message per POST', async () => {
    const board = await serve()
    expect(board.serving.output()).toContain(`mcp    ${board.url}/mcp`)
    const hello = await board.ask(board.owner, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(hello.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'muster' } })
    const note = await board.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${board.owner}` })
    expect([note.status, await note.text()]).toEqual([202, ''])
    const stream = await fetch(`${board.url}/mcp`, { headers: { authorization: `Bearer ${board.owner}` } })
    expect([stream.status, stream.headers.get('allow')]).toEqual([405, 'POST'])
    expect((await board.ask(board.owner, 'tools/list')).result.tools.map((tool: any) => tool.name)).toEqual(['mu'])
    await board.stop()
  }, 20_000)

  it('writes as the profile the request names, through the same checks as any client', async () => {
    const board = await serve()
    const posted = await board.mu(board.owner, ['post', 'general', 'from far away', '--json'], { 'x-muster-profile': 'remote' })
    expect(posted.isError).toBe(false)
    expect(JSON.parse(posted.content[0].text).message.by.profile).toBe('remote')
    const read = await cli(board.dir, ['read', 'general', '--json'])
    expect(JSON.parse(read.stdout).threads.map((thread: any) => thread.message.text)).toContain('from far away')
    await board.stop()
  }, 20_000)

  it('a token held to a profile and channels holds the tool to them too', async () => {
    const board = await serve()
    const fixer = (await cli(board.dir, ['token', 'create', '--as', 'fixer', '--can', 'factory/=read,post,label'])).stdout.trim()
    const elsewhere = await board.mu(fixer, ['post', 'general', 'not here'])
    expect([elsewhere.isError, elsewhere.content[0].text]).toEqual([true, expect.stringMatching(/^error: /)])
    const allowed = await board.mu(fixer, ['post', 'factory/intake', 'here', '--json'], { 'x-muster-profile': 'lead' })
    expect(JSON.parse(allowed.content[0].text).message.by.profile).toBe('fixer')
    const task = JSON.parse((await cli(board.dir, ['tasks', 'create', 'factory/work', 'fix the redirect', '--json'])).stdout).task.id
    const claimed = await board.mu(fixer, ['tasks', 'claim', String(task)])
    expect([claimed.isError, claimed.content[0].text]).toEqual([false, expect.stringMatching(new RegExp(`^#${task} {2}yours for`))])
    const settled = await board.mu(fixer, ['tasks', 'complete', String(task), 'fixed'])
    expect([settled.isError, settled.content[0].text]).toEqual([false, `completed  #${task}`])
    const minting = await board.mu(fixer, ['token', 'create', '--as', 'fixer'])
    expect([minting.isError, minting.content[0].text]).toEqual([true, expect.stringMatching(/isn't available/)])
    await board.stop()
  }, 20_000)

  it("one caller's claim is never used for another who writes under the same profile name", async () => {
    const board = await serve()
    const task = JSON.parse((await cli(board.dir, ['tasks', 'create', 'work', 'fix the redirect', '--json'])).stdout).task.id
    const claimed = await board.mu(board.owner, ['tasks', 'claim', String(task)], { 'x-muster-profile': 'fixer' })
    expect(claimed.isError).toBe(false)
    const where = JSON.parse((await cli(board.dir, ['whoami', '--json'])).stdout).where
    const eve = mint(boardKey(where, join(board.dir, 'config')), { sub: 'local:user:eve', profile: 'fixer', exp: Math.floor(Date.now() / 1000) + 3600 })
    const taken = await board.mu(eve, ['tasks', 'complete', String(task), 'not mine to finish'])
    expect(taken.isError).toBe(true)
    const mine = await board.mu(board.owner, ['tasks', 'complete', String(task), 'fixed'], { 'x-muster-profile': 'fixer' })
    expect([mine.isError, mine.content[0].text]).toEqual([false, `completed  #${task}`])
    await board.stop()
  }, 20_000)

  it('refuses a request with no token, a revoked token, or one sent from another site', async () => {
    const board = await serve()
    expect((await board.post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
    const made = JSON.parse((await cli(board.dir, ['token', 'create', '--as', 'gone', '--can', 'general=read', '--json'])).stdout)
    expect((await board.ask(made.token, 'ping')).result).toEqual({})
    await cli(board.dir, ['token', 'revoke', made.id])
    expect((await board.post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { authorization: `Bearer ${made.token}` })).status).toBe(401)
    expect((await board.post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { authorization: `Bearer ${board.owner}`, origin: 'https://evil.example' })).status).toBe(403)
    await board.stop()
  }, 20_000)
})
