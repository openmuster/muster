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

  it('token create --as workflows is refused: that profile is the daemon\'s own', async () => {
    const dir = tempDir()
    const made = await cli(dir, ['token', 'create', '--as', 'workflows', '--json'])
    expect(made.code).not.toBe(0)
    expect(JSON.parse(made.stderr).error.reason).toBe('invalid_profile')
    expect((await cli(dir, ['token', 'create', '--as', 'lead', '--json'])).code).toBe(0)
  })

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

  it("keeps the daemon's profile to the board itself, so nobody can forge a run's marks", async () => {
    const time = clock()
    const key = randomBytes(32)
    const backend = file({ memory: true, principal: OWNER, now: time.now, key })
    const server = await listen({ backend, key, now: () => time.now().getTime() })
    try {
      const exp = Math.floor(time.now().getTime() / 1000) + 3600
      const token = (can?: Record<string, string[]>) => board({ backend: http({ url: server.url, token: mint(key, { sub: OWNER, profile: null, exp, ...(can ? { can } : {}) } as never) }) })
      const narrowed = token({ 'work/': ['read', 'post', 'label'] })
      const team = board({ backend })
      const root = await team.post({ channel: 'work/app', text: 'ship' })
      const rec = recorder()
      await runWorkflows(team, [release], rec.deps)
      const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
      const run = `work/app/release-${seq}`
      // A token held to channels that names the daemon's profile, from its request: refused on any route.
      const forger = narrowed.as('workflows')
      expect(await reason(forger.post({ channel: run, text: 'release', labels: { workflow: 'release', request: String(seq), thread: String(root.id) }, noSync: true }))).toBe('forbidden')
      expect(await reason(forger.taskPlan({ channel: run, tasks: [{ key: 'x', text: 'decoy' }], idempotencyKey: `workflow-${seq}` }))).toBe('forbidden')
      expect(await reason(forger.readChannel({ channel: 'work/app' }))).toBe('forbidden')
      // No token is made for it, by the board's owner or anyone.
      expect(await reason(team.backend.tokens.create({ profile: 'workflows', can: { 'work/': ['read', 'post'] }, ttl: 3600 }))).toBe('invalid_profile')
      expect(await reason(token().backend.tokens.create({ profile: 'workflows', can: {}, ttl: 3600 }))).toBe('invalid_profile')
      // So the daemon starts the run as it should: every worker, the real tasks.
      expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [seq], refused: [] })
      expect(rec.spawned).toHaveLength(2)
      expect((await tasksIn(team, run)).map((task) => task.text)).toEqual([expect.stringMatching(/^Plan /), 'Build {args.version}'])
      // The board itself, unnarrowed, may still write as it, over HTTP as in its own file.
      expect((await token().as('workflows').post({ channel: 'work/app', text: 'by the board' })).by).toEqual({ principal: OWNER, profile: 'workflows' })
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

  it("says so, and never \"started\", when no worker will start", async () => {
    const { team, root } = await ready()
    const rec = recorder(() => true)
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [seq], why: `release ${seq}: spawn mu ENOENT` })
    expect(rec.spawned).toEqual([])
    expect((await repliesOn(team, root.id)).map((reply) => reply.text)).toEqual(["couldn't start workers for release: spawn mu ENOENT"])
  })

  it("says how many workers started when one after the first won't, and doesn't try again", async () => {
    const { team, root } = await ready()
    const rec = recorder((call) => call === 2)
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    const run = `work/app/release-${seq}`
    expect(await runWorkflows(team, [release], rec.deps)).toEqual({ started: [], refused: [seq], why: `release ${seq}: spawn mu ENOENT` })
    expect(rec.spawned.map((worker) => worker.name)).toEqual(['worker-1'])
    expect((await repliesOn(team, root.id)).map((reply) => reply.text)).toEqual(['started 1 of 2 workers for release, then: spawn mu ENOENT'])
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
    await writer.post({ channel: `work/app/release-${both.seq}`, text: 'release', labels: { workflow: 'release', request: String(both.seq), thread: String(root.id) }, noSync: true })
    // Newer messages in the run's channel, more than a page of them, don't hide the mark.
    for (let i = 0; i < 60; i++) await team.post({ channel: `work/app/release-${both.seq}`, text: `note ${i}`, labels: { request: String(both.seq) } })
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

describe('the daemon says how a run went on the thread it was asked on', () => {
  const OWNER = 'local:user:ada'
  const PR = 'https://github.com/a/b/pull/7'
  const trio: Workflow = {
    name: 'release',
    description: 'Ship a release',
    who: [OWNER],
    channels: ['work/'],
    steps: [
      { key: 'a', text: 'Do A' },
      { key: 'b', text: 'Do B' },
      { key: 'c', text: 'Do C' },
    ],
    workers: { count: 1, agent: 'claude', as: 'worker', cwd: '/srv/app' },
  }
  const timed: Workflow = { ...trio, timeout: '1h' }
  /** A board with one run started on it, its clock the board's own. */
  const started = async (workflow: Workflow = trio) => {
    const made = memoryBoard()
    const deps = { spawn: async () => {}, now: () => made.time.now().getTime() }
    const root = await made.team.post({ channel: 'work/app', text: 'ship 1.2' })
    await runWorkflows(made.team, [workflow], deps)
    const { seq } = await made.team.workflowRequest({ name: workflow.name, on: root.id })
    expect((await runWorkflows(made.team, [workflow], deps)).started).toEqual([seq])
    const run = `work/app/${workflow.name}-${seq}`
    const tasks = (await made.team.taskList({ channel: run, state: 'all' })).tasks
    const opening = (await made.team.readChannel({ channel: run })).threads.find((each) => each.task === null)!.message
    const tick = () => runWorkflows(made.team, [workflow], deps)
    const replies = async () => (await made.team.readThread({ id: root.id })).replies.map((reply) => reply.text)
    const complete = async (id: number, result: string) => {
      const held = await made.team.taskClaim({ id })
      await made.team.taskComplete({ id, token: held.token, result })
    }
    const fail = async (id: number, reason: string) => {
      const held = await made.team.taskClaim({ id })
      await made.team.taskFail({ id, token: held.token, reason })
    }
    const cancel = (id: number) => made.team.as('workflows').taskCancel({ id })
    return { ...made, deps, root, seq, run, tasks, opening, tick, replies, complete, fail, cancel }
  }
  const reported = async (team: Board, id: number) => (await team.readThread({ id })).message.labels['workflow.reported']

  it('stays quiet while a task is open, then says once how each one ended', async () => {
    const { team, root, seq, tasks, opening, tick, replies, complete, fail, cancel } = await started()
    const [a, b, c] = tasks.map((task) => task.id) as [number, number, number]
    await team.label({ id: a, set: { pr: PR } })
    await complete(a, 'shipped it\nand more besides')
    await fail(b, 'tests broke\ntrace')
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await replies()).toEqual([`started release: 3 tasks in work/app/release-${seq}`])
    await cancel(c)
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    const text = ['release finished: 1 completed, 1 failed, 1 canceled', `#${a} completed: shipped it (pr ${PR})`, `#${b} failed: tests broke`, `#${c} canceled`].join('\n')
    expect((await replies()).slice(1)).toEqual([text])
    const summary = (await team.readThread({ id: root.id })).replies.at(-1)!
    expect(summary.by).toEqual({ principal: OWNER, profile: 'workflows' })
    // It syncs, like the reply that said the run started: whoever asked may be on a platform.
    const posted = (await team.events({ after: 0, filter: { types: ['message.posted'] } })).events
    expect(posted.find((event) => event.seq === summary.id)!.data).toMatchObject({ noSync: false })
    expect(await reported(team, opening.id)).toBe(String(seq))
    // Said once: a second tick, and a daemon that starts again on the same board, say nothing more.
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await runWorkflows(board({ backend: team.backend }), [trio], { spawn: async () => {}, now: () => Date.now() })).toEqual({ started: [], refused: [] })
    expect(await replies()).toHaveLength(2)
  })

  it('reports at the timeout with what is still open, counted from when the run started', async () => {
    const { team, time, seq, tasks, opening, tick, replies, complete } = await started(timed)
    const [a, b, c] = tasks.map((task) => task.id) as [number, number, number]
    await complete(a, 'done')
    await team.as('workflows').taskBlock({ id: b, reason: 'needs a key' })
    time.advance(60 * 60 * 1000 - 1)
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await replies()).toHaveLength(1)
    time.advance(1)
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).slice(1)).toEqual([
      ['release finished: 1 completed, 0 failed, 0 canceled, 2 still open', `#${a} completed: done`, `#${b} still open (blocked)`, `#${c} still open (ready)`].join('\n'),
    ])
    expect(await reported(team, opening.id)).toBe(String(seq))
    time.advance(60 * 60 * 1000)
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await replies()).toHaveLength(2)
  })

  it('says it once when the daemon stopped between the summary and the label, whatever changed since', async () => {
    const { team, time, root, seq, tasks, opening, tick, replies, complete } = await started(timed)
    const [a, b, c] = tasks.map((task) => task.id) as [number, number, number]
    await complete(a, 'done')
    time.advance(60 * 60 * 1000)
    // As the daemon would have written it before it stopped: the summary, keyed, and no label yet.
    const before = ['release finished: 1 completed, 0 failed, 0 canceled, 2 still open', `#${a} completed: done`, `#${b} still open (ready)`, `#${c} still open (ready)`].join('\n')
    await team.as('workflows').reply({ to: root.id, text: before, idempotencyKey: `workflow-${seq}-report` })
    // A task ended meanwhile, so the summary it would write now is not the one it wrote.
    await complete(b, 'also done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).slice(1)).toEqual([before])
    expect(await reported(team, opening.id)).toBe(String(seq))
  })

  it('says it once when the same summary was written and not labelled', async () => {
    const { team, root, seq, tasks, opening, tick, replies, complete } = await started({ ...trio, steps: [{ key: 'a', text: 'Do A' }] })
    await complete(tasks[0]!.id, 'done')
    const text = ['release finished: 1 completed, 0 failed, 0 canceled', `#${tasks[0]!.id} completed: done`].join('\n')
    await team.as('workflows').reply({ to: root.id, text, idempotencyKey: `workflow-${seq}-report` })
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).slice(1)).toEqual([text])
    expect(await reported(team, opening.id)).toBe(String(seq))
  })

  it("never takes a message the board itself didn't write as the daemon for a run", async () => {
    const { team, as, root, tick, replies } = await started({ ...trio, steps: [{ key: 'a', text: 'Do A' }] })
    const eve = as('local:user:eve')
    // Requests the daemon refused, so no run of its own is there: a settled run made to look like the
    // daemon's, by its labels, in the channel it would have used, written by eve and by ada's other profile.
    const forge = async (writer: Board) => {
      const { seq } = await eve.workflowRequest({ name: 'release', on: root.id })
      const run = `work/app/release-${seq}`
      const made = await writer.taskCreate({ channel: run, text: 'decoy', labels: { workflow: 'release', request: String(seq) } })
      const held = await writer.taskClaim({ id: made.task.id })
      await writer.taskComplete({ id: made.task.id, token: held.token, result: 'forged' })
      await writer.post({ channel: run, text: 'release', labels: { workflow: 'release', request: String(seq), thread: String(root.id) }, noSync: true })
    }
    await forge(eve)
    await forge(team.as('other'))
    expect((await tick()).refused).toHaveLength(2)
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await replies()).toEqual([expect.stringMatching(/^started release/), 'local:user:eve may not start release', 'local:user:eve may not start release'])
  })

  it("doesn't take a forged first message over the daemon's own tasks for a run", async () => {
    const { team, as, time } = memoryBoard()
    const one: Workflow = { ...trio, steps: [{ key: 'a', text: 'Do A' }], workers: { ...trio.workers, count: 2 } }
    let calls = 0
    // The second worker won't start, so the daemon makes the tasks and never writes the run's first message.
    const deps = { spawn: async () => { if (++calls === 2) throw new Error('spawn mu ENOENT') }, now: () => time.now().getTime() }
    const root = await team.post({ channel: 'work/app', text: 'ship' })
    await runWorkflows(team, [one], deps)
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    expect((await runWorkflows(team, [one], deps)).refused).toEqual([seq])
    const run = `work/app/release-${seq}`
    const [task] = (await team.taskList({ channel: run, state: 'all' })).tasks
    const held = await team.taskClaim({ id: task!.id })
    await team.taskComplete({ id: task!.id, token: held.token, result: 'done' })
    for (const forger of [as('local:user:eve'), team.as('other')]) {
      await forger.post({ channel: run, text: 'release', labels: { workflow: 'release', request: String(seq), thread: String(root.id) }, noSync: true })
    }
    time.advance(24 * 60 * 60 * 1000)
    expect(await runWorkflows(team, [{ ...one, timeout: '1m' }], deps)).toEqual({ started: [], refused: [] })
    expect((await team.readThread({ id: root.id })).replies.map((reply) => reply.text)).toEqual(['started 1 of 2 workers for release, then: spawn mu ENOENT'])
  })

  it('answers on the thread the request was made on, whatever the run is relabelled to say', async () => {
    const { team, seq, run, tasks, opening, tick, replies, complete } = await started({ ...trio, steps: [{ key: 'a', text: 'Do A' }] })
    const elsewhere = await team.post({ channel: 'work/app', text: 'elsewhere' })
    await team.label({ id: opening.id, set: { thread: String(elsewhere.id) } })
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect(await replies()).toEqual([`started release: 1 tasks in ${run}`, ['release finished: 1 completed, 0 failed, 0 canceled', `#${tasks[0]!.id} completed: done`].join('\n')])
    expect((await team.readThread({ id: elsewhere.id })).replies).toEqual([])
  })

  it("leaves out a task in the run's channel that the daemon didn't make", async () => {
    const { as, seq, run, tasks, tick, replies, complete } = await started({ ...trio, steps: [{ key: 'a', text: 'Do A' }] })
    // Someone else's open task with the run's labels doesn't hold the run open, and isn't in the summary.
    await as('local:user:eve').taskCreate({ channel: run, text: 'stray', labels: { workflow: 'release', request: String(seq) } })
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).at(-1)).toBe(['release finished: 1 completed, 0 failed, 0 canceled', `#${tasks[0]!.id} completed: done`].join('\n'))
  })

  it("says it once even when the run's message can't take the label, which is only a hint", async () => {
    const one: Workflow = { ...trio, steps: [{ key: 'a', text: 'Do A' }] }
    const { team, seq, tasks, opening, tick, replies, complete } = await started(one)
    // The run's message already carries as many labels as a message may, so it can take no more.
    const more = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, 'v']))
    await team.label({ id: opening.id, set: more })
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect((await replies()).filter((text) => text.startsWith('release finished'))).toHaveLength(1)
  })

  it('labels the run even when the thread it was asked on has gone, and tries no more', async () => {
    const { team, root, seq, tasks, opening, tick, complete } = await started({ ...trio, steps: [{ key: 'a', text: 'Do A' }] })
    await complete(tasks[0]!.id, 'done')
    await team.remove({ id: root.id })
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect(await reported(team, opening.id)).toBe(String(seq))
    expect(await tick()).toEqual({ started: [], refused: [] })
  })

  const one: Workflow = { ...trio, steps: [{ key: 'a', text: 'Do A' }] }

  it('walks only the open window: passes what needs nothing more and holds at a run still open', async () => {
    const { team, root, seq, tasks, tick, complete } = await started(one)
    const refused = await team.workflowRequest({ name: 'nope', on: root.id })
    const later = await team.workflowRequest({ name: 'release', on: root.id })
    expect(await tick()).toEqual({ started: [later.seq], refused: [refused.seq] })
    const [laterTask] = (await team.taskList({ channel: `work/app/release-${later.seq}`, state: 'all' })).tasks
    // The first run is open, so the cursor stays before it; a later run is still looked at, and reported.
    await complete(laterTask!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [later.seq] })
    expect(await team.cursorGet('workflow:reports')).toBeLessThan(seq)
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    // Everything up to the requests read needs nothing more, so the cursor is where they were read to.
    expect(await team.cursorGet('workflow:reports')).toBe(await team.cursorGet('workflow:requests'))
    expect(await tick()).toEqual({ started: [], refused: [] })
  })

  it('starts an idle tick from where requests were read to, not from the last request', async () => {
    const { team, seq, tasks, tick, complete } = await started(one)
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    // Other things happen on the board; no request comes.
    for (let i = 0; i < 5; i++) await team.post({ channel: 'random', text: `chat ${i}` })
    expect(await tick()).toEqual({ started: [], refused: [] })
    const requests = await team.cursorGet('workflow:requests')
    expect(requests).toBe(await team.head())
    expect(await team.cursorGet('workflow:reports')).toBe(requests)
  })

  it('never looks at a run before its cursor', async () => {
    const { team, seq, tasks, tick, replies, complete } = await started(one)
    await complete(tasks[0]!.id, 'done')
    await team.cursorSet('workflow:reports', seq)
    expect(await tick()).toEqual({ started: [], refused: [] })
    expect(await replies()).toHaveLength(1)
  })

  it("doesn't pass a request the daemon hasn't read yet", async () => {
    const { team, time } = memoryBoard()
    const deps = { spawn: async () => {}, now: () => time.now().getTime() }
    const root = await team.post({ channel: 'work/app', text: 'ship' })
    await runWorkflows(team, [one], deps)
    // More refusals than one tick reads, then a run: the first tick doesn't reach it.
    for (let i = 0; i < 20; i++) await team.workflowRequest({ name: 'nope', on: root.id })
    const { seq } = await team.workflowRequest({ name: 'release', on: root.id })
    expect((await runWorkflows(team, [one], deps)).refused).toHaveLength(20)
    expect(await team.cursorGet('workflow:reports')).toBeLessThan(seq)
    expect((await runWorkflows(team, [one], deps)).started).toEqual([seq])
    const [task] = (await team.taskList({ channel: `work/app/release-${seq}`, state: 'all' })).tasks
    const held = await team.taskClaim({ id: task!.id })
    await team.taskComplete({ id: task!.id, token: held.token, result: 'done' })
    expect((await runWorkflows(team, [one], deps)).reported).toEqual([seq])
  })

  it('reports a run whose workflow has since gone from the config, or moved, when it settles, with no timeout', async () => {
    const { time, seq, tasks, tick, replies, complete, deps, team } = await started({ ...one, timeout: '1m' })
    time.advance(60 * 60 * 1000)
    // Its timeout is the config's, so a workflow gone or moved elsewhere has none.
    expect(await runWorkflows(team, [], deps)).toEqual({ started: [], refused: [] })
    expect(await runWorkflows(team, [{ ...one, timeout: '1m', channels: ['other/'] }], deps)).toEqual({ started: [], refused: [] })
    await complete(tasks[0]!.id, 'done')
    expect(await runWorkflows(team, [], deps)).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).at(-1)).toBe(['release finished: 1 completed, 0 failed, 0 canceled', `#${tasks[0]!.id} completed: done`].join('\n'))
    expect(await tick()).toEqual({ started: [], refused: [] })
  })

  it("isn't silenced by someone setting the reported label first", async () => {
    const { as, seq, tasks, opening, tick, replies, complete } = await started(one)
    await as('local:user:eve').label({ id: opening.id, set: { 'workflow.reported': String(seq) } })
    await complete(tasks[0]!.id, 'done')
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).at(-1)).toMatch(/^release finished: 1 completed/)
  })

  it("finds the daemon's tasks however many others share the run's channel and labels", async () => {
    const { as, seq, run, tasks, tick, replies, complete } = await started(one)
    await complete(tasks[0]!.id, 'done')
    const eve = as('local:user:eve')
    // More than a page of someone else's tasks, all newer than the daemon's, with the run's labels.
    for (let i = 0; i < 501; i++) await eve.taskCreate({ channel: run, text: `decoy ${i}`, labels: { workflow: 'release', request: String(seq) } })
    expect(await tick()).toEqual({ started: [], refused: [], reported: [seq] })
    expect((await replies()).at(-1)).toBe(['release finished: 1 completed, 0 failed, 0 canceled', `#${tasks[0]!.id} completed: done`].join('\n'))
  }, 60_000)

  it('quotes what agents wrote so it mentions nobody, shows only GitHub PR links, and on open tasks too', async () => {
    const two: Workflow = { ...trio, steps: [{ key: 'a', text: 'Do A' }, { key: 'b', text: 'Do B' }], timeout: '1h' }
    const { team, time, root, tasks, tick, complete } = await started(two)
    // So that "@lead" names one actor, and would be a mention if it were left as written.
    await team.as('lead').post({ channel: 'work/app', text: 'here' })
    const [a, b] = tasks.map((task) => task.id) as [number, number]
    await team.label({ id: a, set: { pr: 'https://evil.example/x' } })
    await team.label({ id: b, set: { pr: PR } })
    await complete(a, 'ask @lead and @[local:user:ada+lead] now')
    await team.as('workflows').taskBlock({ id: b, reason: 'waiting' })
    time.advance(60 * 60 * 1000)
    await tick()
    const summary = (await team.readThread({ id: root.id })).replies.at(-1)!
    expect(summary.text).toBe([
      'release finished: 1 completed, 0 failed, 0 canceled, 1 still open',
      `#${a} completed: ask \uFF20lead and \uFF20[local:user:ada+lead] now`,
      `#${b} still open (blocked) (pr ${PR})`,
    ].join('\n'))
    const posted = (await team.events({ after: 0, filter: { types: ['message.posted'] } })).events.find((event) => event.seq === summary.id)!
    expect((posted.data as { mentions: string[] }).mentions).toEqual([])
  })

  it('quotes nothing a platform acts on: no Slack pings or links, no markdown links or images', async () => {
    const { tasks, tick, replies, complete } = await started(one)
    await complete(tasks[0]!.id, '<!channel> <@U123> [x](https://e.x) ![p](https://e.x/p.png)')
    await tick()
    const line = (await replies()).at(-1)!.split('\n')[1]!
    expect(line).toBe(`#${tasks[0]!.id} completed: \uFF1C!channel\uFF1E \uFF1C\uFF20U123\uFF1E [x] (https://e.x) \uFF01[p] (https://e.x/p.png)`)
    expect(line).not.toMatch(/<|\]\(|!\[/)
  })

  it('cuts a long result without splitting a character', async () => {
    const { tasks, tick, replies, complete } = await started(one)
    await complete(tasks[0]!.id, `${'a'.repeat(198)}\u{1F600}${'b'.repeat(10)}`)
    await tick()
    const line = (await replies()).at(-1)!.split('\n')[1]!
    expect(line).toBe(`#${tasks[0]!.id} completed: ${'a'.repeat(198)}\u{1F600}\u2026`)
  })
})
