import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDaemonConfig } from '../src/daemon/daemon.ts'
import { loadWorkflows } from '../src/daemon/workflows.ts'
import { randomBytes } from 'node:crypto'
import { applyPolicy, board, boardPolicy, file, http, listen, mint } from '../src/index.ts'
import { cli, cliStart, clock, memoryBoard, reason, tempDir } from './helpers.ts'

const good = {
  name: 'release',
  description: 'Ship a release',
  who: ['ada'],
  channels: ['general'],
  steps: [
    { key: 'plan', text: 'Plan it' },
    { key: 'build', text: 'Build it', needs: ['plan'] },
  ],
  workers: { count: 2, agent: 'claude', as: 'worker' },
}

describe('the workflows file', () => {
  const write = (workflows: unknown) => {
    const dir = tempDir()
    writeFileSync(join(dir, 'workflows.json'), typeof workflows === 'string' ? workflows : JSON.stringify(workflows))
    return join(dir, 'workflows.json')
  }
  const refuses = (path: string) => {
    try {
      loadWorkflows(path)
    } catch (error) {
      expect((error as { reason?: string }).reason).toBe('invalid_config')
      return (error as Error).message
    }
    return 'loaded'
  }
  const bad = (patch: Record<string, unknown>) => refuses(write({ workflows: [{ ...good, ...patch }] }))

  it('a missing file means no workflows, and a valid one loads as written', () => {
    expect(loadWorkflows(join(tempDir(), 'workflows.json'))).toEqual([])
    expect(loadWorkflows(write({ workflows: [good] }))).toEqual([good])
    expect(loadWorkflows(write([good]))).toEqual([good])
  })

  it('keeps optional fields and checks durations', () => {
    const full = { ...good, timeout: '30m', workers: { ...good.workers, runner: 'vercel', repo: 'https://github.com/openmuster/muster', push: true, cwd: 'packages', timeout: '10m' } }
    expect(loadWorkflows(write({ workflows: [full] }))).toEqual([full])
    expect(bad({ timeout: 'soon' })).toMatch(/"release".*timeout/)
    expect(bad({ workers: { ...good.workers, timeout: 'soon' } })).toMatch(/"release".*timeout/)
  })

  it('refuses bad JSON, a missing array and a bad or repeated name', () => {
    expect(refuses(write('{nope'))).toMatch(/isn't JSON/)
    expect(refuses(write({}))).toMatch(/needs a "workflows" array/)
    expect(bad({ name: 'Release Now' })).toMatch(/needs a "name"/)
    expect(refuses(write({ workflows: [good, good] }))).toMatch(/Two workflows .* are named "release"/)
  })

  it('refuses steps that are too few, too many, repeated or that need what comes later', () => {
    expect(bad({ steps: [] })).toMatch(/Workflow "release".*steps/)
    expect(bad({ steps: Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, text: 'x' })) })).toMatch(/Workflow "release".*steps/)
    expect(bad({ steps: Array.from({ length: 20 }, (_, i) => ({ key: `s${i}`, text: 'x' })) })).toBe('loaded')
    expect(bad({ steps: [{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }] })).toMatch(/Workflow "release".*"a"/)
    expect(bad({ steps: [{ key: 'a', text: 'x', needs: ['b'] }, { key: 'b', text: 'y' }] })).toMatch(/Workflow "release".*"a" that needs "b"/)
    expect(bad({ steps: [{ key: 'a', text: '' }] })).toMatch(/Workflow "release".*"a"/)
  })

  it('refuses an empty who or channels, and a worker count outside 1 to 16', () => {
    expect(bad({ who: [] })).toMatch(/Workflow "release".*"who"/)
    expect(bad({ who: undefined })).toMatch(/Workflow "release".*"who"/)
    expect(bad({ channels: [] })).toMatch(/Workflow "release".*"channels"/)
    expect(bad({ workers: { ...good.workers, count: 0 } })).toMatch(/Workflow "release".*count/)
    expect(bad({ workers: { ...good.workers, count: 17 } })).toMatch(/Workflow "release".*count/)
    expect(bad({ workers: { ...good.workers, count: 16 } })).toBe('loaded')
    expect(bad({ workers: { ...good.workers, agent: 'gpt' } })).toMatch(/Workflow "release".*agent/)
  })

  it('says a bad runner needs to be local or vercel', () => {
    expect(bad({ workers: { ...good.workers, runner: 'docker' } })).toMatch(/needs a "workers.runner" of "local" or "vercel"/)
  })

  it('refuses push without a github.com repo and the vercel runner', () => {
    const push = { ...good.workers, push: true }
    expect(bad({ workers: push })).toMatch(/Workflow "release".*push/)
    expect(bad({ workers: { ...push, runner: 'vercel' } })).toMatch(/Workflow "release".*push/)
    expect(bad({ workers: { ...push, runner: 'vercel', repo: 'https://example.com/a/b' } })).toMatch(/Workflow "release".*push/)
    expect(bad({ workers: { ...push, runner: 'local', repo: 'https://github.com/a/b' } })).toMatch(/Workflow "release".*push/)
    expect(bad({ workers: { ...push, runner: 'vercel', repo: 'https://github.com/a/b' } })).toBe('loaded')
  })
})

describe('workflow names in the daemon config', () => {
  const saved = process.env.MUSTER_CONFIG
  afterEach(() => {
    if (saved === undefined) delete process.env.MUSTER_CONFIG
    else process.env.MUSTER_CONFIG = saved
  })
  const setup = (files: Record<string, unknown>) => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(body))
    process.env.MUSTER_CONFIG = dir
  }
  const watcher = (name: string) => ({ name, run: ['true'] })
  const hook = (name: string) => ({ name, url: 'https://hooks.example.com/in', secret: 'env:HOOK_SECRET' })

  it('loads workflows alongside watchers and hooks', () => {
    setup({ 'workflows.json': { workflows: [good] }, 'watchers.json': { watchers: [watcher('w')] }, 'hooks.json': { hooks: [hook('h')] } })
    const config = loadDaemonConfig({})
    expect(config.workflows.map((w) => w.name)).toEqual(['release'])
    expect(config.watchers.map((w) => w.name)).toEqual(['w'])
    expect(config.hooks.map((h) => h.name)).toEqual(['h'])
  })

  it('refuses a workflow named like a watcher or a hook', () => {
    setup({ 'workflows.json': { workflows: [good] }, 'watchers.json': { watchers: [watcher('release')] } })
    expect(() => loadDaemonConfig({})).toThrow(/workflows.json and a watcher .* both named "release"/)
    setup({ 'workflows.json': { workflows: [good] }, 'hooks.json': { hooks: [hook('release')] } })
    expect(() => loadDaemonConfig({})).toThrow(/workflows.json and a hook .* both named "release"/)
  })
})

describe('workflow requests', () => {
  it('records a request on a thread: by is the caller, data is { name, on, args }, and it lands on the thread', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'work', text: 'ship 1.2' })
    const reply = await team.reply({ to: root.id, text: 'go' })
    const sent = await team.workflowRequest({ name: 'release', on: reply.id, args: { version: '1.2.0' } })
    const found = (await team.events({ after: 0, filter: { types: ['workflow.requested'] } })).events
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ seq: sent.seq, type: 'workflow.requested', by: { principal: 'local:user:ada' }, channel: 'work', thread: root.id, data: { name: 'release', on: reply.id, args: { version: '1.2.0' } } })
    expect((await team.workflowRequest({ name: 'release', on: root.id })).seq).toBeGreaterThan(sent.seq)
    expect((await team.events({ after: 0, filter: { types: ['workflow.requested'] } })).events[1]!.data).toEqual({ name: 'release', on: root.id, args: {} })
  })

  it('refuses a bad name, and bad args: a key, a value, too many keys, a value that is not text', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'work', text: 'ship' })
    const ask = (name: string, args?: Record<string, unknown>) => reason(team.workflowRequest({ name, on: root.id, args: args as Record<string, string> }))
    expect(await ask('Not A Name')).toBe('invalid_workflow')
    expect(await ask('release', { '--push': 'x' })).toBe('invalid_args')
    expect(await ask('release', { Version: 'x' })).toBe('invalid_args')
    expect(await ask('release', { version: 'x'.repeat(501) })).toBe('invalid_args')
    expect(await ask('release', { version: 3 })).toBe('invalid_args')
    expect(await ask('release', Object.fromEntries(Array.from({ length: 11 }, (_, at) => [`k${at}`, 'v'])))).toBe('invalid_args')
    expect(await ask('release', { version: 'x'.repeat(500), k_2: '; echo hi --push' })).toBe('did not fail')
    expect((await team.events({ after: 0, filter: { types: ['workflow.requested'] } })).events).toHaveLength(1)
  })

  it("needs post on the thread's channel, and a channel the caller cannot read does not exist", async () => {
    const time = clock()
    const key = randomBytes(32)
    const backend = file({ memory: true, principal: 'local:user:ada', now: time.now })
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    try {
      const exp = Math.floor(time.now().getTime() / 1000) + 3600
      const as = (can: Record<string, string[]>) => board({ backend: http({ url: server.url, token: mint(key, { sub: 'local:user:ada', profile: 'agent', exp, can } as never) }) })
      const owner = board({ backend })
      const open = await owner.post({ channel: 'work', text: 'ship' })
      const secret = await owner.post({ channel: 'security', text: 'cve' })
      const readOnly = as({ work: ['read'] })
      expect(await reason(readOnly.workflowRequest({ name: 'release', on: open.id }))).toBe('forbidden')
      expect(await reason(readOnly.workflowRequest({ name: 'release', on: secret.id }))).toBe('not_found')
      expect(await reason(owner.workflowRequest({ name: 'release', on: 9999 }))).toBe('not_found')
      expect((await owner.events({ after: 0, filter: { types: ['workflow.requested'] } })).events).toEqual([])
      expect((await as({ work: ['read', 'post'] }).workflowRequest({ name: 'release', on: open.id })).seq).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('a sandbox may POST workflowRequest', () => {
    const { networkPolicy } = boardPolicy({ url: 'https://board.example.com/api/board', token: 'T' })
    expect(applyPolicy(networkPolicy, { url: 'https://board.example.com/api/board/workflowRequest', method: 'POST' })).not.toBeNull()
  })
})

describe('mu workflow', () => {
  const config = (dir: string) => {
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'workflows.json'), JSON.stringify({ workflows: [good] }))
  }

  it("list shows this machine's workflows.json; run requests one on a thread and prints it", async () => {
    const dir = tempDir()
    config(dir)
    const listed = await cli(dir, ['workflow', 'list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toMatch(/release\s+Ship a release\s+who: ada\s+channels: general/)
    expect(JSON.parse((await cli(dir, ['workflow', 'list', '--json'])).stdout).workflows[0].name).toBe('release')
    const root = JSON.parse((await cli(dir, ['post', 'work', 'ship 1.2', '--json'])).stdout).message
    const ran = await cli(dir, ['workflow', 'run', 'release', '--on', String(root.id), '--arg', 'version=1.2.0'])
    expect(ran.code).toBe(0)
    expect(ran.stdout.trim()).toMatch(new RegExp(`^requested  release  on #${root.id}  \\(seq \\d+\\)$`))
    const json = JSON.parse((await cli(dir, ['workflow', 'run', 'release', '--on', String(root.id), '--json'])).stdout)
    expect(json).toEqual({ seq: expect.any(Number) })
    const bad = await cli(dir, ['workflow', 'run', 'release', '--on', String(root.id), '--arg', 'Bad=1', '--json'])
    expect(bad.code).not.toBe(0)
    expect(bad.stdout + bad.stderr).toContain('invalid_args')
  })

  it('run works over HTTP, against mu serve', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'ship'])
    const serving = cliStart(dir, ['serve', '--port', '0'])
    try {
      for (let i = 0; i < 100 && !serving.output().includes('MUSTER_TOKEN='); i++) await new Promise((resolve) => setTimeout(resolve, 50))
      const env = { MUSTER_URL: /MUSTER_URL=(\S+)/.exec(serving.output())![1]!, MUSTER_TOKEN: /MUSTER_TOKEN=(\S+)/.exec(serving.output())![1]! }
      const root = JSON.parse((await cli(dir, ['post', 'work', 'ship again', '--json'], { env })).stdout).message
      const ran = await cli(dir, ['workflow', 'run', 'release', '--on', String(root.id), '--arg', 'version=2'], { env })
      expect(ran.stderr).toBe('')
      expect(ran.stdout.trim()).toMatch(/^requested  release  on #\d+  \(seq \d+\)$/)
    } finally {
      serving.child.kill('SIGTERM')
      await serving.done
    }
    // The server wrote it into the board's file, as the token's principal.
    const events = (await board({ dir: join(dir, 'board'), principal: 'local:user:ada' }).events({ after: 0, filter: { types: ['workflow.requested'] } })).events
    expect(events.map((event) => event.data)).toEqual([{ name: 'release', on: expect.any(Number), args: { version: '2' } }])
  }, 20_000)
})
