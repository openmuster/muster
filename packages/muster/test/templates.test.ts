import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { authorized } from '../../../templates/cloudflare-runner/src/auth.ts'
import { REGISTRY_HOSTS, boardHeaders, modelPasses, registryPasses, repoPasses, repoProps } from '../../../templates/cloudflare-runner/src/gates.ts'
import { KEEP_MS, capStream, decide, ended, execRequest, exitCode, INSTALL_MIN_MS, INSTALL_MS, START_BUDGET_MS, agentExited, installBudget, installSteps, installed, readCapped, readWithin, stillGoing, timeLeft, within } from '../../../templates/cloudflare-runner/src/lifecycle.ts'
import { boardPolicy } from '../src/runner/policy.ts'
import { claude } from '../src/runner/agents.ts'

const factory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/factory')

describe('the cloudflare runner template', () => {
  it('starts nothing for a request without its secret, least of all when no secret was ever set', async () => {
    const secret = 'a-long-random-secret-0123456789'
    expect(await authorized(`Bearer ${secret}`, secret)).toBe(true)
    expect(await authorized(`Bearer ${secret}x`, secret)).toBe(false)
    expect(await authorized(`bearer ${secret}`, secret)).toBe(false)
    expect(await authorized(secret, secret)).toBe(false)
    expect(await authorized(null, secret)).toBe(false)
    // A Worker deployed before `wrangler secret put`: the text an unset secret would have made is no key.
    expect(await authorized('Bearer undefined', undefined)).toBe(false)
    expect(await authorized('Bearer ', '')).toBe(false)
    expect(await authorized('Bearer null', null)).toBe(false)
    expect(await authorized('Bearer short', 'short')).toBe(false)
  })
})

describe('the cloudflare runner gates', () => {
  // What cloudflare() sends the Worker, from the same policy the Vercel runner uses.
  const url = 'https://board.example.com/api/board'
  const { networkPolicy } = boardPolicy({ url, token: 'tok-123' })
  const board = { host: 'board.example.com', rules: networkPolicy.allow['board.example.com']!, token: 'tok-123' }

  it("adds the token to the board's own routes, and to nothing else", () => {
    expect(boardHeaders({ url: `${url}/post`, method: 'POST' }, board)).toEqual({ authorization: 'Bearer tok-123' })
    expect(boardHeaders({ url: `${url}/whoami`, method: 'GET' }, board)).toEqual({ authorization: 'Bearer tok-123' })
    expect(boardHeaders({ url: `${url}/post`, method: 'GET' }, board)).toBeNull()
    // Closed to a sandbox: it starts work beyond it.
    expect(boardHeaders({ url: `${url}/workflowRequest`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: `${url}/../admin/post`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: `${url}/x%2fpost`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: 'http://board.example.com/api/board/post', method: 'POST' }, board)).toBeNull()
    // The Host header is the container's to write: another host gets nothing, whatever the TLS name was.
    expect(boardHeaders({ url: 'https://evil.example.com/api/board/post', method: 'POST' }, board)).toBeNull()
  })

  it("lets the model's calls through and none of the key's other uses", () => {
    const anthropic = claude.model!
    const model = { host: anthropic.host, paths: anthropic.paths, headers: anthropic.headers('k') }
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' }, model)).toBe(true)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST' }, model)).toBe(true)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/files', method: 'POST' }, model)).toBe(false)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages', method: 'GET' }, model)).toBe(false)
    expect(modelPasses({ url: 'https://example.com/v1/messages', method: 'POST' }, model)).toBe(false)
  })

  it('lets git clone read the one repository, and nothing else on its host', () => {
    const repo = repoProps('https://github.com/acme/web.git')
    expect(repoPasses({ url: 'https://github.com/acme/web.git/info/refs?service=git-upload-pack', method: 'GET' }, repo)).toBe(true)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/git-upload-pack', method: 'POST' }, repo)).toBe(true)
    expect(repoPasses({ url: 'https://github.com/acme/web/info/refs?service=git-upload-pack', method: 'GET' }, repo)).toBe(true)
    // Pushing, another repository, a page of the site.
    expect(repoPasses({ url: 'https://github.com/acme/web.git/info/refs?service=git-receive-pack', method: 'GET' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/git-receive-pack', method: 'POST' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/other.git/git-upload-pack', method: 'POST' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web', method: 'GET' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/../other.git/git-upload-pack', method: 'POST' }, repo)).toBe(false)
    expect(() => repoProps('https://x:tok@github.com/acme/web.git')).toThrow()
    expect(() => repoProps('http://github.com/acme/web.git')).toThrow()
  })

  it('lets a dependency install read the package registries, and do nothing else there', () => {
    const get = (url: string, method = 'GET') => registryPasses({ url, method })
    expect(get('https://registry.npmjs.org/react')).toBe(true)
    expect(get('https://registry.npmjs.org/react/-/react-19.0.0.tgz')).toBe(true)
    // A scoped package is asked for with its slash encoded.
    expect(get('https://registry.npmjs.org/@types%2fnode')).toBe(true)
    expect(get('https://registry.npmjs.org/@types/node/-/node-24.0.0.tgz')).toBe(true)
    expect(get('https://registry.npmjs.org/pnpm', 'HEAD')).toBe(true)
    expect(get('https://registry.yarnpkg.com/react')).toBe(true)
    expect(get('https://repo.yarnpkg.com/4.5.0/packages/yarnpkg-cli/bin/yarn.js')).toBe(true)
    // Publishing, logging in, auditing: nothing that writes or sends.
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) expect(get('https://registry.npmjs.org/react', method)).toBe(false)
    expect(get('http://registry.npmjs.org/react')).toBe(false)
    expect(get('https://registry.npmjs.org/a/../-/user/org.couchdb.user:x')).toBe(false)
    expect(get('https://registry.npmjs.org/a/%2e%2e/b')).toBe(false)
    // The Host header is the container's to write.
    expect(get('https://evil.example.com/react')).toBe(false)
    expect(REGISTRY_HOSTS).toEqual(['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'])
  })
})

describe('the cloudflare runner lifecycle', () => {
  const now = 1_000_000
  const run = { now, running: true, deadline: now + 60 * 60_000, attach: false }

  it('keeps a container while its agent works, and ends it once the agent exits unless the CLI will read it', () => {
    expect(decide(run)).toBe('wait')
    expect(decide({ ...run, exitedAt: now - 1 })).toBe('end')
    expect(decide({ ...run, attach: true, exitedAt: now - 1 })).toBe('wait')
    // Kept to be read for a while, not for ever: a CLI that died leaves it for KEEP_MS at most.
    expect(decide({ ...run, attach: true, exitedAt: now - KEEP_MS })).toBe('end')
  })

  it('never cuts off a call in progress, but the deadline and a stopped container still end the run', () => {
    expect(decide({ ...run, attach: true, exitedAt: now - KEEP_MS, busyUntil: now + 1 })).toBe('wait')
    expect(decide({ ...run, exitedAt: now - 1, busyUntil: now })).toBe('end')
    expect(decide({ ...run, busyUntil: now + 1, deadline: now })).toBe('end')
    expect(decide({ ...run, attach: true, exitedAt: now, deadline: now - 1 })).toBe('end')
    expect(decide({ ...run, running: false })).toBe('end')
  })

  const stream = (...chunks: number[][]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close() } })

  it('reads no more of a stream than its limit, and stops what prints past it once', async () => {
    let stopped = 0
    const stop = () => void stopped++
    expect([...(await readCapped(stream([1, 2], [3]), 3, stop))]).toEqual([1, 2, 3])
    expect(stopped).toBe(0)
    // One byte over, across a chunk: what is read is max + 1, so the caller can tell, and the command is stopped.
    expect([...(await readCapped(stream([1, 2], [3, 4, 5]), 3, stop))]).toEqual([1, 2, 3, 4])
    expect(stopped).toBe(1)
    expect([...(await readCapped(null, 3, stop))]).toEqual([])
  })

  it("lets go of a command's output at its deadline, even when something keeps the pipe open for ever", async () => {
    let stopped = 0
    // A daemon the install left behind, outside timeout's reach: the stream never ends.
    const open = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([7])) } })
    const began = Date.now()
    const held = await readWithin(open, 10, 30, () => void stopped++)
    expect(held.timedOut).toBe(true)
    expect([...held.bytes]).toEqual([7])
    expect(stopped).toBe(1)
    expect(Date.now() - began).toBeLessThan(1000)
    // One that ends in time is read whole, and nothing is stopped.
    const done = await readWithin(stream([1], [2]), 10, 1000, () => void stopped++)
    expect(done).toEqual({ bytes: new Uint8Array([1, 2]), timedOut: false })
    expect(stopped).toBe(1)
    // An exit code that never comes isn't waited on.
    expect(await within(new Promise<number>(() => {}), 20, null)).toBeNull()
    expect(await within(Promise.resolve(3), 1000, null)).toBe(3)
  })

  it('passes a file on as a stream, and errors it once it grows past its limit', async () => {
    const read = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer())
    expect([...(await read(capStream(stream([1], [2, 3]), 3)))]).toEqual([1, 2, 3])
    await expect(read(capStream(stream([1], [2, 3, 4]), 3))).rejects.toThrow()
  })

  it('runs only a command given as strings', () => {
    expect(execRequest({ cmd: 'sh', args: ['-c', 'x'], env: { A: 'b' } })).toEqual({ cmd: 'sh', args: ['-c', 'x'], env: { A: 'b' } })
    expect(execRequest({ cmd: 'sh', args: [] })).toEqual({ cmd: 'sh', args: [], env: {} })
    for (const bad of [null, 'sh', {}, { cmd: '', args: [] }, { cmd: 'sh', args: [1] }, { cmd: 'sh', args: 'x' }, { cmd: 'sh', args: [], env: { A: 1 } }, { cmd: 'sh', args: [], env: ['x'] }]) expect(execRequest(bad)).toBeNull()
  })

  it("installs with the board and the model closed, and gives them back only once nothing of the install is left", () => {
    const line = (step: ReturnType<typeof installSteps>[number]) => (step.do === 'open' ? `open ${step.host} ${step.gate}` : step.do === 'close' ? `close ${step.host}` : step.do)
    expect(installSteps({ board: 'b.example', model: 'm.example', registries: ['r1', 'r2'] }).map(line)).toEqual([
      'close b.example',
      'close m.example',
      'open r1 registry',
      'open r2 registry',
      'install',
      'close r1',
      'close r2',
      'kill',
      'check',
      'open b.example board',
      'open m.example model',
    ])
    expect(installSteps({ board: 'b.example', registries: ['r1'] }).map(line)).toEqual(['close b.example', 'open r1 registry', 'install', 'close r1', 'kill', 'check', 'open b.example board'])
  })

  it("gives the install what is left of start's time, and none when too little is", () => {
    const t = 1_000_000
    expect(installBudget(t, t)).toBe(INSTALL_MS)
    // Setup and the clone took most of it: the install gets the rest, so start answers before the CLI gives up.
    expect(installBudget(t, t + START_BUDGET_MS - 60_000)).toBe(60_000)
    expect(installBudget(t, t + START_BUDGET_MS - INSTALL_MIN_MS)).toBe(INSTALL_MIN_MS)
    expect(installBudget(t, t + START_BUDGET_MS - INSTALL_MIN_MS + 1)).toBeNull()
    expect(installBudget(t, t + START_BUDGET_MS + 1)).toBeNull()
    expect(timeLeft(t, t + 1000)).toBe(START_BUDGET_MS - 1000)
    expect(timeLeft(t, t + START_BUDGET_MS * 2)).toBe(0)
    // Node's fetch waits 5 minutes for an answer: the whole budget, and the install's kill grace, fit inside it.
    expect(START_BUDGET_MS + 5_000).toBeLessThan(300_000)
  })

  it("reads the exit file only once the agent has started: before, the repository's install could have written it", () => {
    expect(agentExited(false, '0\n')).toBe(false)
    expect(agentExited(true, '0\n')).toBe(true)
    expect(agentExited(true, '')).toBe(false)
    // A run started by a Worker from before the flag: its agent had started.
    expect(agentExited(undefined, '1')).toBe(true)
  })

  it('gives the agent its gates only in a run still going', () => {
    const going = { started: true, running: true, closed: false }
    expect(stillGoing(going)).toBe(true)
    expect(stillGoing({ ...going, started: false })).toBe(false)
    expect(stillGoing({ ...going, running: false })).toBe(false)
    expect(stillGoing({ ...going, closed: true })).toBe(false)
    expect(stillGoing({ ...going, exitedAt: 5 })).toBe(false)
  })

  it("says how dependencies installed from the install's exit code and last line, and nothing else it printed", () => {
    expect(installed(0, 'installed pnpm\n')).toBe('pnpm')
    expect(installed(0, 'installed none')).toBe('none')
    expect(installed(0, 'something else')).toBe('none')
    expect(installed(0, 'installed pnpm; echo x')).toBe('none')
    // Stopped at its time limit, timeout exits 124.
    expect(installed(124, '')).toBe('failed (exit 124)')
    expect(installed(1, 'installed npm')).toBe('failed (exit 1)')
    expect(installed(null, '')).toBe('failed (no exit code)')
  })

  it('reads an exit code only as a number: what else the agent wrote in that file means nothing', () => {
    expect(exitCode('0\n')).toBe(0)
    expect(exitCode('137')).toBe(137)
    expect(exitCode('abc')).toBeNull()
    expect(exitCode('1\n2')).toBeNull()
    expect(exitCode('99999')).toBeNull()
  })
})

describe('the factory template', () => {
  // Its watcher and its sync are in its board module, lib/board.ts, and tested with the template (templates/factory/test).
  it('keeps none of its old configuration files: watchers.json, wake.sh and sync.json are in the module now', () => {
    expect(['watchers.json', 'wake.sh', 'sync.json'].filter((name) => existsSync(join(factory, name)))).toEqual([])
    expect(readFileSync(join(factory, 'lib', 'board.ts'), 'utf8')).toContain("secret: env('GITHUB_WEBHOOK_SECRET')")
  })
})

describe('what the runner Worker logs when a run ends', () => {
  it('says why it ended and how the agent exited, and what the run printed only when the owner asked for it', () => {
    const printed = 'cloning https://github.com/acme/private.git ... the customer list is in /workspace/repo/customers.csv'
    expect(ended('done', 0, printed, undefined)).toEqual({ event: 'run.ended', why: 'done', exitCode: 0 })
    expect(ended('setup failed', null, printed, '0')).toEqual({ event: 'run.ended', why: 'setup failed', exitCode: null })
    expect(JSON.stringify(ended('timed out', null, printed, ''))).not.toContain('customer')
    // LOG_TAIL=1 on the Worker: the end of what the run printed is kept in Cloudflare's logs with it.
    expect(ended('done', 1, printed, '1')).toEqual({ event: 'run.ended', why: 'done', exitCode: 1, tail: printed })
  })
})
