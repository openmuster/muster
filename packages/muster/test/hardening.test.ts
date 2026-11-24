import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentEnv, board, claude, cloudflare, codex, file, generic, http, listen, mint, runLocal } from '../src/index.ts'
import { watcherEnv } from '../src/daemon/daemon.ts'
import { inspect } from '../src/inspect/server.ts'
import { ownerOnly } from '../src/store/sqlite.ts'
import { cli, cliStart, reason, tempDir } from './helpers.ts'

/** What others on the machine may do with a file: nothing, when this is 0. */
const others = (path: string) => statSync(path).mode & 0o077

const request = { task: 7, agent: claude, prompt: 'p', board: { url: 'https://board.example.com/api/board', token: 'mu1.secret' } }

describe('a credential never crosses the network in the clear', () => {
  it('mu serve prints a token only to a terminal, or when asked: output that is piped is usually a log', async () => {
    const dir = tempDir()
    const piped = cliStart(dir, ['serve', '--port', '0'])
    for (let i = 0; i < 100 && !piped.output().includes('token  '); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(piped.output()).toContain('token  none printed: this is not a terminal. Make one with mu token create, or pass --print-token')
    expect(piped.output()).not.toMatch(/mu1\./)
    piped.child.kill('SIGTERM')
    await piped.done
    expect((await cli(dir, ['token', 'list'])).stdout.trim()).toBe('no tokens')
    const asked = cliStart(dir, ['serve', '--port', '0', '--print-token'])
    for (let i = 0; i < 100 && !asked.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(asked.output()).toMatch(/export MUSTER_TOKEN=mu1\./)
    asked.child.kill('SIGTERM')
    await asked.done
  }, 30_000)

  it('the CLI sends a token to a board over https, or to this machine, and nowhere else unless told to', async () => {
    const dir = tempDir()
    const env = { MUSTER_TOKEN: 'mu1.x.y' }
    const plain = await cli(dir, ['whoami', '--url', 'http://board.example/api/board', '--json'], { env })
    expect([plain.code, JSON.parse(plain.stderr).error.reason]).toEqual([2, 'insecure_url'])
    // Asking to join carries no token, but its answer is one.
    const joining = await cli(dir, ['join', 'http://board.example/api/board', '--as', 'ada', '--json'])
    expect([joining.code, JSON.parse(joining.stderr).error.reason]).toEqual([2, 'insecure_url'])
    // A network that is private some other way (a tailnet) is the owner's to vouch for, by name.
    const vouched = await cli(dir, ['whoami', '--url', 'http://board.invalid/api/board', '--json'], { env: { ...env, MUSTER_INSECURE_HTTP: '1' } })
    expect(JSON.parse(vouched.stderr).error.reason).toBe('network_error')
  }, 30_000)

  it('the handle refuses plain http beyond this machine before it asks, and follows no redirect with a token', async () => {
    const asked: { url: string; redirect: unknown }[] = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), redirect: init?.redirect })
      return Response.json({ ok: { principal: 'p', profile: null } })
    }) as typeof fetch
    expect(await reason(board({ backend: http({ url: 'http://board.example/api/board', token: 'T', fetch: fetcher }) }).whoami())).toBe('insecure_url')
    expect(asked).toEqual([])
    await board({ backend: http({ url: 'https://board.example/api/board', token: 'T', fetch: fetcher }) }).whoami()
    await board({ backend: http({ url: 'http://127.0.0.1:4100/api/board', token: 'T', fetch: fetcher }) }).whoami()
    await board({ backend: http({ url: 'http://board.example/api/board', token: 'T', fetch: fetcher, insecure: true }) }).whoami()
    expect(asked.map((call) => call.redirect)).toEqual(['error', 'error', 'error'])
  })

  it("what mu starts is told what its owner said of the network: an agent's and a watcher's own mu commands reach the same board", async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'a'])
    await cli(dir, ['run', '1', '--cwd', dir, '--', 'sh', '-c', `cat >/dev/null; echo "insecure=$MUSTER_INSECURE_HTTP" > ${dir}/got.txt`], { env: { MUSTER_INSECURE_HTTP: '1' } })
    expect(readFileSync(join(dir, 'got.txt'), 'utf8')).toBe('insecure=1\n')
    expect(watcherEnv({}, [], { PATH: '/bin', MUSTER_URL: 'http://board.internal/api/board', MUSTER_INSECURE_HTTP: '1', GITHUB_TOKEN: 'ghp' })).toEqual({ PATH: '/bin', MUSTER_URL: 'http://board.internal/api/board', MUSTER_INSECURE_HTTP: '1' })
  }, 30_000)

  it('a board served on an address of its own still answers its MCP tool: there the server calls itself over plain http', async () => {
    const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
    // A machine with no network but itself has no such address to serve on.
    if (!address) return
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'board exists'])
    const serving = cliStart(dir, ['serve', '--port', '0', '--host', address, '--allow-host', address, '--print-token'])
    for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const url = /MUSTER_URL=(\S+)/.exec(serving.output())![1]!
    const token = /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]!
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mu', arguments: { args: ['channels'] } } }) })
    const { result } = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect([result.isError, result.content[0]!.text]).toEqual([false, expect.stringContaining('general')])
    serving.child.kill('SIGTERM')
    await serving.done
  }, 30_000)

  it("a job's token for mu token exchange never crosses plain http, whatever is set, and isn't told of a setting that wouldn't help", async () => {
    const dir = tempDir()
    const plain = await cli(dir, ['token', 'exchange', '-', '--json'], { env: { MUSTER_URL: 'http://board.example/api/board', MUSTER_INSECURE_HTTP: '1' }, input: 'a.b.c' })
    const error = JSON.parse(plain.stderr).error
    expect([plain.code, error.reason]).toEqual([2, 'insecure_url'])
    expect(JSON.stringify(error)).not.toContain('MUSTER_INSECURE_HTTP')
  }, 30_000)

  it('the Cloudflare runner hands its credentials to a Worker over https only, and to no address a redirect names', async () => {
    const asked: { redirect: unknown }[] = []
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push({ redirect: init?.redirect })
      return Response.json({ id: 'run-1' })
    }) as typeof fetch
    expect(await reason(Promise.resolve().then(() => cloudflare({ worker: 'http://runner.example', secret: 'worker-secret', fetch: fetcher }).start(request)))).toBe('insecure_url')
    expect(asked).toEqual([])
    await cloudflare({ worker: 'https://runner.example', secret: 'worker-secret', fetch: fetcher }).start(request)
    // A Worker under `wrangler dev` is on this machine.
    await cloudflare({ worker: 'http://127.0.0.1:8787', secret: 'worker-secret', fetch: fetcher }).start(request)
    expect(asked).toEqual([{ redirect: 'error' }, { redirect: 'error' }])
  })
})

describe('what is kept on disk is the owner\'s alone to read', () => {
  it("an agent's log is kept in a folder and files only its owner can open", async () => {
    const dir = tempDir()
    const logDir = join(dir, 'runs', '7-1700000000007')
    const ran = await runLocal({ agent: generic('sh', ['-c', 'echo out; echo err >&2']), prompt: '', cwd: dir, logDir }).done
    expect(ran.kind).toBe('ok')
    expect([others(logDir), others(ran.stdoutPath), others(ran.stderrPath)]).toEqual([0, 0, 0])
  })

  it('the board, its files and a backup are private whatever folder they are in', async () => {
    const dir = tempDir()
    // A folder someone made by hand, open to others: the board in it still isn't.
    mkdirSync(join(dir, 'board'), { mode: 0o755 })
    chmodSync(join(dir, 'board'), 0o755)
    writeFileSync(join(dir, 'note.txt'), 'attached')
    expect((await cli(dir, ['post', 'general', 'hello', '--attach', join(dir, 'note.txt')])).code).toBe(0)
    expect(others(join(dir, 'board', 'main.db'))).toBe(0)
    mkdirSync(join(dir, 'shared'), { mode: 0o755 })
    chmodSync(join(dir, 'shared'), 0o755)
    expect((await cli(dir, ['backup', join(dir, 'shared', 'copy.db')])).code).toBe(0)
    expect(others(join(dir, 'shared', 'copy.db'))).toBe(0)
    expect(others(join(dir, 'shared', 'copy.files'))).toBe(0)
    for (const name of readdirSync(join(dir, 'shared', 'copy.files'))) expect(others(join(dir, 'shared', 'copy.files', name))).toBe(0)
  }, 30_000)

  it("the files SQLite keeps beside a board are made private with it: a board from before this was is mended when opened", () => {
    const dir = tempDir()
    const path = join(dir, 'main.db')
    for (const name of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(name, '')
      chmodSync(name, 0o644)
    }
    ownerOnly(path)
    expect([others(path), others(`${path}-wal`), others(`${path}-shm`)]).toEqual([0, 0, 0])
  })

  it("old run logs go when a new run starts: a transcript isn't kept for ever", async () => {
    const dir = tempDir()
    const runs = join(dir, 'runs')
    const old = join(runs, '3-1700000000001')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'stdout.log'), 'a transcript')
    const now = Date.now()
    // Only when asked to, as mu run does: someone calling runLocal names a folder of their own, and what is beside it is theirs.
    await runLocal({ agent: generic('true'), prompt: '', cwd: dir, logDir: join(runs, '3-1700000000009'), now: () => now + 10 * 365 * 86_400_000 }).done
    expect(existsSync(old)).toBe(true)
    await runLocal({ agent: generic('true'), prompt: '', cwd: dir, logDir: join(runs, '4-1700000000002'), keepLogsMs: 60_000, now: () => now + 61_000 }).done
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(runs, '4-1700000000002', 'stdout.log'))).toBe(true)
    // Anything else in the folder is somebody's, and stays.
    mkdirSync(join(runs, 'notes'))
    await runLocal({ agent: generic('true'), prompt: '', cwd: dir, logDir: join(runs, '5-1700000000003'), keepLogsMs: 60_000, now: () => now + 500_000 }).done
    expect(existsSync(join(runs, 'notes'))).toBe(true)
    expect(existsSync(join(runs, '4-1700000000002'))).toBe(false)
  })
})

describe('what an agent is started with', () => {
  it("keeps the opt-outs its user set: muster starts an agent with a clean environment, and that mustn't turn its reporting back on", () => {
    const from = { PATH: '/bin', DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', AWS_SECRET_ACCESS_KEY: 'secret' }
    expect(agentEnv(claude, {}, from)).toEqual({ PATH: '/bin', DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    // The one every tool is asked to honour goes to any agent; an agent's own go to that agent.
    expect(agentEnv(generic('sh'), {}, from)).toEqual({ PATH: '/bin', DO_NOT_TRACK: '1' })
    expect(agentEnv(codex, {}, from)).toEqual({ PATH: '/bin', DO_NOT_TRACK: '1' })
  })
})

describe("an error that isn't the board's own answer", () => {
  const broken = () => {
    const backend = file({ memory: true, principal: 'local:user:ada' })
    return { ...backend, head: async () => Promise.reject(new Error('unable to open database file /Users/ada/.muster/main.db')) }
  }

  it('is not told to whoever called the served board: the owner reads it in the board\'s output', async () => {
    const key = randomBytes(32)
    const logged: string[] = []
    const server = await listen({ backend: broken(), key, log: (line) => void logged.push(line) })
    const token = mint(key, { sub: 'local:user:ada', profile: null, exp: Math.floor(Date.now() / 1000) + 600 })
    const response = await fetch(`${server.url}/head`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toEqual({ error: { reason: 'internal', message: 'The board failed to answer. Whoever runs it can see why in its output.' }, exit: 1 })
    expect(body).not.toContain('/Users/ada')
    expect(logged.join('\n')).toContain('unable to open database file /Users/ada/.muster/main.db')
    await server.close()
  })

  it('is not sent to the inspector page either', async () => {
    const serving = await inspect({ backend: broken(), bundle: new URL('./helpers.ts', import.meta.url).pathname })
    const response = await fetch(`${serving.url}/board/head`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-muster-inspect': serving.token, origin: serving.url }, body: '{"args":[]}' })
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(body).not.toContain('/Users/ada')
    await serving.close()
  })
})
