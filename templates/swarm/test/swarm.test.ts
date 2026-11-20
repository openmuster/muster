import { board } from 'muster'
import { describe, expect, it } from 'vitest'
import { launch, workerArgv } from '../lib/run.ts'
import { snapshot } from '../lib/swarm.ts'

const fresh = () => board({ memory: true, principal: 'local:user:ada', as: 'launcher' })
const request = { goal: 'Add a rate limiter to checkout', slug: 'limiter', agents: 3, agent: 'claude', cwd: '/repo' }

describe('launch', () => {
  it('records the run, queues one planning task, and starts a named worker per agent on the run\'s queue', async () => {
    const team = fresh()
    const started: { name: string; argv: string[]; cwd: string }[] = []
    const made = await launch(team, 'swarm', request, (worker) => started.push(worker))
    expect(made.workers).toEqual(['agent-1', 'agent-2', 'agent-3'])
    expect(started.map((worker) => worker.argv.join(' '))).toEqual(['1', '2', '3'].map((n) => `run --ready swarm/limiter --loop --wait 10m --cwd /repo --agent claude --as agent-${n}`))
    const plan = await team.task(made.plan)
    expect(plan).toMatchObject({ state: 'ready', channel: 'swarm/limiter' })
    const runs = await team.readChannel({ channel: 'swarm/runs' })
    expect(runs.threads.map((thread) => [thread.message.text, thread.message.labels.run])).toEqual([['run limiter: Add a rate limiter to checkout', 'limiter']])
  })

  it('launching the same run twice makes its thread and its plan once', async () => {
    const team = fresh()
    await launch(team, 'swarm', request, () => {})
    await launch(team, 'swarm', request, () => {})
    expect((await team.readChannel({ channel: 'swarm/runs' })).threads).toHaveLength(1)
    expect((await team.taskList({ channel: 'swarm/', state: 'all' })).tasks).toHaveLength(1)
  })

  it('refuses a bad name, an empty goal, and too many agents, before anything is started', async () => {
    const team = fresh()
    let started = 0
    const spawn = () => void started++
    await expect(launch(team, 'swarm', { ...request, slug: 'Bad Name' }, spawn)).rejects.toThrow(/run name/)
    await expect(launch(team, 'swarm', { ...request, goal: '  ' }, spawn)).rejects.toThrow(/what the swarm is for/)
    await expect(launch(team, 'swarm', { ...request, agents: 99 }, spawn)).rejects.toThrow(/1 to 16/)
    expect(started).toBe(0)
    expect((await team.channels()).channels).toEqual([])
  })

  it('in a cloud sandbox each agent is a worker that takes tasks itself, and the board must be at a URL', async () => {
    expect(workerArgv({ ...request, runner: 'vercel', repo: 'https://github.com/acme/web.git' }, 'swarm')).toEqual(['run', '--ready', 'swarm/limiter', '--runner', 'vercel', '--agent', 'claude', '--repo', 'https://github.com/acme/web.git'])
    const before = process.env.MUSTER_URL
    delete process.env.MUSTER_URL
    await expect(launch(fresh(), 'swarm', { ...request, runner: 'cloudflare' }, () => {})).rejects.toThrow(/reaches the board by URL/)
    await expect(launch(fresh(), 'swarm', { ...request, runner: 'vercel', agent: './mine' }, () => {})).rejects.toThrow(/claude or codex/)
    // With the board at a URL, a launch still needs a token made for the agents: the app's own is never handed on.
    const agentToken = process.env.MUSTER_AGENT_TOKEN
    delete process.env.MUSTER_AGENT_TOKEN
    process.env.MUSTER_URL = 'https://board.example.com/api/board'
    await expect(launch(fresh(), 'swarm', { ...request, runner: 'vercel' }, () => {})).rejects.toThrow(/token made for its agents/)
    if (agentToken !== undefined) process.env.MUSTER_AGENT_TOKEN = agentToken
    if (before !== undefined) process.env.MUSTER_URL = before
    else delete process.env.MUSTER_URL
  })

  it('a worker can be any command', () => {
    expect(workerArgv({ ...request, agent: './my-agent --fast' }, 'swarm')).toEqual(['run', '--ready', 'swarm/limiter', '--loop', '--wait', '10m', '--cwd', '/repo', '--', './my-agent', '--fast'])
  })
})

describe('snapshot', () => {
  it('holds the swarm\'s tasks by state, who is working on what, and its newest messages', async () => {
    const team = fresh()
    const a = (await team.taskCreate({ channel: 'swarm/limiter', text: 'build' })).task
    const b = (await team.taskCreate({ channel: 'swarm/limiter', text: 'review', needs: [a.id] })).task
    await team.taskCreate({ channel: 'elsewhere', text: 'not the swarm' })
    const held = await team.as('agent-1').taskClaim({ id: a.id })
    await team.as('agent-1').reply({ to: a.id, text: 'plan: token bucket' })
    let snap = await snapshot(team, 'swarm')
    expect(snap.tasks.claimed.map((task) => task.id)).toEqual([a.id])
    expect(snap.tasks.waiting.map((task) => task.id)).toEqual([b.id])
    expect(snap.agents).toEqual([{ name: 'agent-1', task: a.id, until: held.task.claim!.until }])
    expect(snap.messages[0]!.text).toBe('plan: token bucket')
    await team.as('agent-1').taskComplete({ id: a.id, token: held.token, result: 'done' })
    snap = await snapshot(team, 'swarm')
    expect(snap.tasks.completed.map((task) => task.id)).toEqual([a.id])
    expect(snap.tasks.ready.map((task) => task.id)).toEqual([b.id])
    expect(snap.agents).toEqual([])
  })

  it('lists each run newest first, with how many of its tasks are still open', async () => {
    const team = fresh()
    const old = (await team.taskCreate({ channel: 'swarm/limiter', text: 'build' })).task
    const held = await team.as('agent-1').taskClaim({ id: old.id })
    await team.as('agent-1').taskComplete({ id: old.id, token: held.token, result: 'done' })
    await team.taskCreate({ channel: 'swarm/checkout', text: 'one' })
    await team.taskCreate({ channel: 'swarm/checkout', text: 'two' })
    await team.taskCreate({ channel: 'elsewhere', text: 'not the swarm' })
    expect((await snapshot(team, 'swarm')).runs).toEqual([{ name: 'checkout', open: 2, total: 2 }, { name: 'limiter', open: 0, total: 1 }])
    expect((await snapshot(team, 'swarm/limiter')).runs).toEqual([{ name: 'limiter', open: 0, total: 1 }])
  })

  it('two agents racing for the next ready task each get a different one or nothing', async () => {
    const team = fresh()
    await team.taskCreate({ channel: 'swarm/limiter', text: 'only one' })
    const results = await Promise.allSettled([team.as('agent-1').taskClaim({ ready: 'swarm/' }), team.as('agent-2').taskClaim({ ready: 'swarm/' })])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })
})
