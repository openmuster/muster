import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refusal } from '../src/cli/mcp.ts'
import { BIN, cli, tempDir } from './helpers.ts'

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
    expect(refusal(['tasks', 'run', '1', '--', 'sh'])).toMatch(/starts a command/)
    expect(refusal(['run', '1', '--agent', 'claude'])).toMatch(/isn't available/)
    expect(refusal(['serve'])).toMatch(/isn't available/)
    expect(refusal(['token', 'create'])).toMatch(/isn't available/)
    expect(refusal(['post', 'general', '--file', '/etc/passwd'])).toMatch(/Reading a file/)
    expect(refusal(['post', 'general', 'x', '--attach=/etc/passwd'])).toMatch(/Reading a file/)
    expect(refusal(['post', 'general', '-'])).toMatch(/Reading a file/)
    expect(refusal(['read', 'general', '--dir', '/elsewhere'])).toMatch(/--dir and --url/)
    expect(refusal(['schemas', 'add', 'x@1'])).toMatch(/reads a file/)
    expect(refusal(['read', 'general'])).toBeNull()
    const mcp = client(tempDir())
    const blocked = await mcp.mu('tasks', 'run', '1', '--', 'sh')
    expect([blocked.isError, blocked.content[0].text]).toEqual([true, expect.stringContaining('starts a command')])
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
