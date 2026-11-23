import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDaemonConfig, tickOnce } from '../src/daemon/daemon.ts'
import { runWorkflows, type Spawner } from '../src/daemon/runs.ts'
import { loadWorkflows, type Workflow } from '../src/daemon/workflows.ts'
import { randomBytes } from 'node:crypto'
import { applyPolicy, board, boardPolicy, file, http, listen, mint } from '../src/index.ts'
import { cli, cliStart, clock, memoryBoard, reason, tempDir, type Board } from './helpers.ts'

const good = {
  name: 'release',
  description: 'Ship a release',
  who: ['ada'],
  channels: ['general'],
  steps: [
    { key: 'plan', text: 'Plan it' },
    { key: 'build', text: 'Build it', needs: ['plan'] },
  ],
  workers: { count: 2, agent: 'claude', as: 'worker', cwd: '/srv/app' },
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

  it('needs a folder for workers that run on this machine', () => {
    const { cwd: _, ...noCwd } = good.workers
    expect(bad({ workers: noCwd })).toMatch(/Workflow "release".*"workers.cwd"/)
    expect(bad({ workers: { ...noCwd, runner: 'local' } })).toMatch(/Workflow "release".*"workers.cwd"/)
    expect(bad({ workers: { ...noCwd, cwd: '' } })).toMatch(/Workflow "release".*"workers.cwd"/)
    expect(bad({ workers: { ...noCwd, runner: 'vercel' } })).toBe('loaded')
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
    expect((await team.events({ after: 0, filter: { types: ['workflow.requested'] } })).events[1]!.data).toEqual({ name: 'release', on: root.id, args: {}, profileHeld: false })
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

  it('a sandbox may not POST workflowRequest: it would start work beyond the sandbox', () => {
    const { networkPolicy } = boardPolicy({ url: 'https://board.example.com/api/board', token: 'T' })
    expect(applyPolicy(networkPolicy, { url: 'https://board.example.com/api/board/workflowRequest', method: 'POST' })).toBeNull()
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
    expect(events.map((event) => event.data)).toEqual([{ name: 'release', on: expect.any(Number), args: { version: '2' }, profileHeld: false }])
  }, 20_000)
})

describe('the daemon starts a requested workflow', () => {
  const OWNER = 'local:user:ada'
  const release: Workflow = {
    name: 'release',
    description: 'Ship a release',
    who: [OWNER, 'releaser'],
    channels: ['work/'],
    steps: [
      { key: 'plan', text: 'Plan {args.version} for #{thread} in {channel}, work in {run}. {args.nope} {nope} {args.constructor}', labels: { role: 'plan', workflow: 'forged' } },
      { key: 'build', text: 'Build {args.version}', needs: ['plan'], for: 'builder' },
    ],
    workers: { count: 2, agent: 'claude', as: 'worker', cwd: '/srv/app' },
  }
  /** A spawner that takes notes. `fail` says, by call number from 1, which start throws. */
  const recorder = (fail?: (call: number) => boolean) => {
    const spawned: Parameters<Spawner>[0][] = []
    let calls = 0
    const spawn: Spawner = async (worker) => {
      calls += 1
      if (fail?.(calls)) throw new Error('spawn mu ENOENT')
      spawned.push(worker)
    }
    return { spawned, deps: { spawn, now: () => Date.now() } }
  }
  const argvFor = (workflow: Workflow, run: string, seq: number, i: number) => {
    const workers = workflow.workers
    return [
      'run', '--ready', run, '--loop', '--wait', '10m',
      ...(workers.runner === 'vercel' ? ['--runner', 'vercel'] : ['--cwd', workers.cwd!]),
      '--agent', workers.agent, '--as', `${workers.as}-${i}`,
      ...(workers.repo ? ['--repo', workers.repo] : []), ...(workers.push ? ['--push'] : []), ...(workers.timeout ? ['--timeout', workers.timeout] : []),
      '--label', `workflow=${workflow.name}`, '--label', `request=${seq}`,
    ]
  }
  const tasksIn = async (team: Board, channel: string) => (await team.taskList({ channel, state: 'all' })).tasks
  const allTasks = async (team: Board) => (await team.taskList({ state: 'all' })).tasks
  const repliesOn = async (team: Board, thread: number) => (await team.readThread({ id: thread })).replies
  /** The messages in a run's channel that aren't tasks. */
  const openings = async (team: Board, run: string) => (await team.readChannel({ channel: run })).threads.filter((each) => each.task === null).map((each) => each.message)
  const channelNames = async (team: Board) => (await team.channels()).channels.map((each) => each.path)
  /** A board whose daemon has already ticked once, so its cursor is set and what comes next is new. */
  const ready = async (workflows: Workflow[] = [release]) => {
    const made = memoryBoard()
    const root = await made.team.post({ channel: 'work/app', text: 'ship 1.2' })
    const rec = recorder()
    expect(await runWorkflows(made.team, workflows, rec.deps)).toEqual({ started: [], refused: [] })
    return { ...made, root, rec }
  }

  it('creates the steps as tasks, starts the workers, labels the run and says so on the thread', async () => {
    const { team, root, rec } = await ready()
    const on = await team.reply({ to: root.id, text: 'go' })
    const { seq } = await team.workflowRequest({ name: 'release', on: on.id, args: { version: '1.2.0' } })
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [seq], refused: [] })
    const run = `work/app/release-${seq}`
    const tasks = await tasksIn(team, run)
    expect(tasks.map((task) => task.text)).toEqual([`Plan 1.2.0 for #${root.id} in work/app, work in ${run}. {args.nope} {nope} {args.constructor}`, 'Build 1.2.0'])
    expect(tasks[1]!.needs).toEqual([tasks[0]!.id])
    expect(tasks[1]!.for).toBe('builder')
    expect(tasks[0]!.labels).toMatchObject({ role: 'plan', workflow: 'release', request: String(seq) })
    expect(tasks[1]!.labels).toMatchObject({ workflow: 'release', request: String(seq) })
    // The run's first message, not a task, says where it came from; it is written once the workers have started.
    const opening = await openings(team, run)
    expect(opening.map((message) => message.text)).toEqual([`release, asked for by ${OWNER} on #${root.id}`])
    expect(opening[0]!.labels).toMatchObject({ workflow: 'release', request: String(seq), thread: String(root.id) })
    expect(rec.spawned).toEqual([1, 2].map((i) => ({ name: `worker-${i}`, argv: argvFor(release, run, seq, i), cwd: '/srv/app' })))
    const replies = await repliesOn(team, root.id)
    expect(replies.at(-1)!.text).toBe(`started release: 2 tasks in ${run}`)
    expect(replies.at(-1)!.by).toEqual({ principal: OWNER, profile: 'workflows' })
    // The answer on the asking thread syncs, as the asker may be on a platform; the run's own message doesn't.
    const posted = (await team.events({ after: 0, filter: { types: ['message.posted'] } })).events
    expect(posted.find((event) => event.seq === replies.at(-1)!.id)!.data).toMatchObject({ noSync: false })
    expect(posted.find((event) => event.seq === opening[0]!.id)!.data).toMatchObject({ noSync: true })
  })

  it('builds the same argv whatever the args say, and puts them only in task text', async () => {
    const vercel: Workflow = { ...release, workers: { count: 1, agent: 'codex', as: 'w', runner: 'vercel', repo: 'https://github.com/a/b', push: true, timeout: '20m' } }
    const { team, root, rec } = await ready([vercel])
    const plain = await team.workflowRequest({ name: 'release', on: root.id, args: { version: '1' } })
    const hostile = await team.workflowRequest({ name: 'release', on: root.id, args: { version: '--push ; rm -rf /', nope: '$(id) `id` {run}' } })
    expect((await runWorkflows(team, [vercel], rec.deps)).started).toEqual([plain.seq, hostile.seq])
    const runs = [plain.seq, hostile.seq].map((seq) => `work/app/release-${seq}`)
    expect(rec.spawned.map((worker) => worker.argv)).toEqual([argvFor(vercel, runs[0]!, plain.seq, 1), argvFor(vercel, runs[1]!, hostile.seq, 1)])
    expect(rec.spawned[0]!.argv).toEqual([
      'run', '--ready', runs[0], '--loop', '--wait', '10m', '--runner', 'vercel', '--agent', 'codex', '--as', 'w-1', '--repo', 'https://github.com/a/b', '--push', '--timeout', '20m',
      '--label', 'workflow=release', '--label', `request=${plain.seq}`,
    ])
    // A Vercel worker has no folder of its own here.
    expect(rec.spawned[0]!.cwd).toBeUndefined()
    const same = (argv: string[], seq: number, run: string) => argv.map((part) => part.replace(run, 'RUN').replace(`request=${seq}`, 'request=SEQ'))
    expect(same(rec.spawned[1]!.argv, hostile.seq, runs[1]!)).toEqual(same(rec.spawned[0]!.argv, plain.seq, runs[0]!))
    // Filled once, as text: an argument that looks like a placeholder stays as written.
    expect((await tasksIn(team, runs[1]!))[0]!.text).toBe(`Plan --push ; rm -rf / for #${root.id} in work/app, work in ${runs[1]}. $(id) \`id\` {run} {nope} {args.constructor}`)
  })

  it('refuses a name it has not got, someone not in who, and a channel it does not run in, and creates nothing', async () => {
    const { team, as, root, rec } = await ready()
    const elsewhere = await team.post({ channel: 'random', text: 'ship' })
    const unknown = await team.workflowRequest({ name: 'deploy', on: root.id })
    const stranger = await as('local:user:eve').workflowRequest({ name: 'release', on: root.id })
    // A profile with an allowed name, under someone else's principal, is someone else.
    const borrowed = await as('local:user:eve').as('releaser').workflowRequest({ name: 'release', on: root.id })
    const wrongPlace = await team.workflowRequest({ name: 'release', on: elsewhere.id })
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [unknown.seq, stranger.seq, borrowed.seq, wrongPlace.seq] })
    expect(rec.spawned).toEqual([])
    expect(await allTasks(team)).toEqual([])
    expect((await repliesOn(team, root.id)).map((reply) => reply.text)).toEqual([
      "deploy isn't registered here",
      'local:user:eve may not start release',
      'local:user:eve+releaser may not start release',
    ])
    expect((await repliesOn(team, elsewhere.id)).map((reply) => reply.text)).toEqual(["release doesn't run in random"])
  })

  it("lets a bare profile name in who stand for that profile under the daemon owner's principal only", async () => {
    const only = { ...release, who: ['releaser'] }
    const { team, root, rec } = await ready([only])
    const owner = await team.workflowRequest({ name: 'release', on: root.id })
    const profile = await team.as('releaser').workflowRequest({ name: 'release', on: root.id })
    const other = await team.as('worker').workflowRequest({ name: 'release', on: root.id })
    expect(await runWorkflows(team, [only], rec.deps)).toEqual({ started: [profile.seq], refused: [owner.seq, other.seq] })
  })

  it('believes a profile only when a token holds it: a narrowed token that names one per request is refused', async () => {
    const time = clock()
    const key = randomBytes(32)
    const backend = file({ memory: true, principal: OWNER, now: time.now })
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    try {
      const exp = Math.floor(time.now().getTime() / 1000) + 3600
      const can = { 'work/': ['read', 'post'] }
      const token = (profile: string | null) => board({ backend: http({ url: server.url, token: mint(key, { sub: OWNER, profile, exp, can } as never) }) })
      const team = board({ backend })
      const lead = { ...release, who: ['lead', `${OWNER}+chief`] }
      const root = await team.post({ channel: 'work/app', text: 'ship' })
      const rec = recorder()
      await runWorkflows(team, [lead], rec.deps)
      // An unbound CI token that says it is lead, or chief by full ID: its word only.
      const claimed = await token(null).as('lead').workflowRequest({ name: 'release', on: root.id })
      const claimedId = await token(null).as('chief').workflowRequest({ name: 'release', on: root.id })
      // A token held to lead, and the owner's own board as lead.
      const held = await token('lead').workflowRequest({ name: 'release', on: root.id })
      const owner = await team.as('lead').workflowRequest({ name: 'release', on: root.id })
      expect(await runWorkflows(team, [lead], rec.deps)).toEqual({ started: [held.seq, owner.seq], refused: [claimed.seq, claimedId.seq] })
      expect((await repliesOn(team, root.id)).map((reply) => reply.text).slice(0, 2)).toEqual([`${OWNER}+lead may not start release`, `${OWNER}+chief may not start release`])
    } finally {
      await server.close()
    }
  })

  it('matches a channel exactly, or under a prefix that ends in "/"', async () => {
    const exact = { ...release, channels: ['work'] }
    const { team, root, rec } = await ready([exact])
    const top = await team.post({ channel: 'work', text: 'ship' })
    const below = await team.workflowRequest({ name: 'release', on: root.id })
    const at = await team.workflowRequest({ name: 'release', on: top.id })
    expect(await runWorkflows(team, [exact], rec.deps)).toEqual({ started: [at.seq], refused: [below.seq] })
  })

  it("says so, and never \"started\", when a worker won't start; and doesn't try again", async () => {
    const { team, root } = await ready()
    const rec = recorder((call) => call === 2)
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    const run = `work/app/release-${seq}`
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [seq], why: `release ${seq}: spawn mu ENOENT` })
    expect(rec.spawned.map((worker) => worker.name)).toEqual(['worker-1'])
    expect((await repliesOn(team, root.id)).map((reply) => reply.text)).toEqual(['couldn\'t start workers for release: spawn mu ENOENT'])
    // The tasks are there for whoever starts workers by hand; the run isn't marked as started.
    expect(await tasksIn(team, run)).toHaveLength(2)
    expect(await openings(team, run)).toEqual([])
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [] })
    expect(rec.spawned).toHaveLength(1)
    expect(await repliesOn(team, root.id)).toHaveLength(1)
  })

  it('starts a request once: a daemon that stopped after the plan starts the workers; one that stopped after them does not', async () => {
    const simple: Workflow = { ...release, steps: [{ key: 'a', text: 'Do A' }], workers: { ...release.workers, count: 1 } }
    const { team, root, rec } = await ready([simple])
    const writer = team.as('workflows')
    // As the daemon would have written them before it stopped.
    const plan = async (seq: number) => writer.taskPlan({ channel: `work/app/release-${seq}`, tasks: [{ key: 'a', text: 'Do A', labels: { workflow: 'release', request: String(seq) } }], idempotencyKey: `workflow-${seq}` })
    const planned = await team.workflowRequest({ name: 'release', on: root.id })
    await plan(planned.seq)
    const both = await team.workflowRequest({ name: 'release', on: root.id })
    await plan(both.seq)
    await writer.post({ channel: `work/app/release-${both.seq}`, text: 'release', labels: { workflow: 'release', request: String(both.seq) }, noSync: true })
    expect(await runWorkflows(team, [simple], rec.deps)).toEqual({ started: [planned.seq, both.seq], refused: [] })
    expect(rec.spawned.map((worker) => worker.argv[2])).toEqual([`work/app/release-${planned.seq}`])
    expect(await allTasks(team)).toHaveLength(2)
    // And a second tick makes nothing.
    expect(await runWorkflows(team, [simple], rec.deps)).toEqual({ started: [], refused: [] })
    expect(await allTasks(team)).toHaveLength(2)
    expect(rec.spawned).toHaveLength(1)
  })

  it("answers a plan the board won't take, and leaves nothing behind", async () => {
    const long: Workflow = { ...release, steps: [{ key: 'a', text: `${'x'.repeat(9_800)} {args.more}` }] }
    const { team, root, rec } = await ready([long])
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id, args: { more: 'y'.repeat(500) } })
    expect(await runWorkflows(team, [long], rec.deps)).toEqual({ started: [], refused: [seq] })
    expect((await repliesOn(team, root.id)).map((reply) => reply.text)).toEqual([expect.stringMatching(/^couldn't start release: A message holds up to 10,000 characters/)])
    expect(rec.spawned).toEqual([])
    expect(await allTasks(team)).toEqual([])
    expect(await channelNames(team)).not.toContain(`work/app/release-${seq}`)
  })

  it('a daemon new to a board starts from now, not from requests made before it', async () => {
    const { team } = memoryBoard()
    const root = await team.post({ channel: 'work/app', text: 'ship' })
    await team.workflowRequest({ name: 'release', on: root.id })
    const rec = recorder()
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [] })
    expect(await allTasks(team)).toEqual([])
  })

  it("keeps its cursor to itself: a narrowed token can't move workflow:requests", async () => {
    const time = clock()
    const key = randomBytes(32)
    const backend = file({ memory: true, principal: OWNER, now: time.now })
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    try {
      const exp = Math.floor(time.now().getTime() / 1000) + 3600
      const narrowed = board({ backend: http({ url: server.url, token: mint(key, { sub: OWNER, profile: null, exp, can: { 'work/': ['read', 'post'] } } as never) }) })
      expect(await reason(narrowed.cursorSet('workflow:requests', 1_000_000))).toBe('forbidden')
      expect(await board({ backend }).cursorGet('workflow:requests')).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('runs in the daemon tick', async () => {
    const { team, root, rec } = await ready()
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    const watcherDeps = { now: () => Date.now(), spawn: async () => ({ code: 0, stdout: '' }) }
    const did = await tickOnce(team, [], new Map(), watcherDeps, undefined, { list: [release], deps: rec.deps })
    expect(did.workflows).toEqual({ started: [seq], refused: [] })
    expect(rec.spawned).toHaveLength(2)
  })

  it('under mu serve, a workflows file that is wrong holds requests until it is fixed, and says so', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    const config = (body: unknown) => writeFileSync(join(dir, 'config', 'workflows.json'), typeof body === 'string' ? body : JSON.stringify(body))
    // Nobody may start it, so a fixed file answers with a refusal and starts nothing on this machine.
    const fixed = { workflows: [{ ...release, who: ['local:user:nobody'], channels: ['work'] }] }
    // The board as the server runs it: whoever this process is.
    const owner = board({ dir: join(dir, 'board') })
    const me = (await owner.whoami()).principal
    const serve = async (until: (err: string) => boolean | Promise<boolean>) => {
      const serving = cliStart(dir, ['serve', '--port', '0'])
      let err = ''
      serving.child.stderr!.on('data', (chunk) => (err += chunk))
      let done = false
      for (let i = 0; i < 300 && !done; i++) {
        done = await until(err)
        if (!done) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      serving.child.kill('SIGTERM')
      await serving.done
      expect(done).toBe(true)
      return err
    }
    config(fixed)
    const root = await owner.post({ channel: 'work', text: 'ship' })
    // A first serve with a good file sets the place it reads from.
    await serve(async () => (await owner.cursorGet('workflow:requests')) !== null)
    config('{ not json')
    const { seq } = await owner.workflowRequest({ name: 'release', on: root.id })
    const before = await owner.cursorGet('workflow:requests')
    // Long enough for the ticker to have ticked more than once.
    let seen = 0
    const err = await serve((err) => (err.includes('No workflow requests are read') && (seen ||= Date.now()) > 0 && Date.now() - seen > 2500))
    expect(err).toMatch(/workflows\.json isn't JSON/)
    expect(await owner.cursorGet('workflow:requests')).toBe(before)
    expect((await owner.readThread({ id: root.id })).replies).toEqual([])
    config(fixed)
    await serve(async () => (await owner.readThread({ id: root.id })).replies.length > 0)
    expect((await owner.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual([`${me} may not start release`])
    expect(await owner.cursorGet('workflow:requests')).toBeGreaterThanOrEqual(seq)
  }, 60_000)
})
