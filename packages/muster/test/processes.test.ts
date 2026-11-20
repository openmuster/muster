import { describe, expect, it } from 'vitest'
import { cli, tempDir } from './helpers.ts'

/** Many CLI processes at once on one board file: what a swarm of agents is. */
describe('many processes on one board', () => {
  it('of N processes claiming one task, exactly one gets it', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'only one of you'])
    const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => cli(dir, ['tasks', 'claim', '1', '--as', `agent-${i}`, '--json'])))
    const won = runs.filter((run) => run.code === 0)
    expect(won).toHaveLength(1)
    for (const lost of runs.filter((run) => run.code !== 0)) expect(JSON.parse(lost.stderr).error.reason).toBe('task_claimed')
    const holder = JSON.parse(won[0]!.stdout).task.claim.by.profile
    const listed = JSON.parse((await cli(dir, ['tasks', '--state', 'claimed', '--json'])).stdout)
    expect(listed.tasks.map((task: { claim: { by: { profile: string } } }) => task.claim.by.profile)).toEqual([holder])
  })

  it('N processes asking for the next ready task each get a different one', async () => {
    const dir = tempDir()
    for (let i = 0; i < 6; i++) await cli(dir, ['tasks', 'create', 'work', `task ${i}`])
    const runs = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(dir, ['tasks', 'claim', '--ready', 'work', '--as', `agent-${i}`, '--json'])))
    const taken = runs.filter((run) => run.code === 0).map((run) => JSON.parse(run.stdout).task.id as number)
    expect(taken).toHaveLength(6)
    expect(new Set(taken).size).toBe(6)
    for (const none of runs.filter((run) => run.code !== 0)) expect(JSON.parse(none.stderr).error.reason).toBe('nothing_ready')
  })

  it('of N processes setting a label only if unset, one wins and the rest are told who did', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'who takes this?'])
    const runs = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(dir, ['label', '1', `owner=agent-${i}`, '--if-unset', 'owner', '--as', `agent-${i}`, '--json'])))
    const won = runs.filter((run) => run.code === 0)
    expect(won).toHaveLength(1)
    const owner = JSON.parse(won[0]!.stdout).message.labels.owner
    for (const lost of runs.filter((run) => run.code !== 0)) {
      const error = JSON.parse(lost.stderr).error
      expect(error.reason).toBe('label_conflict')
      expect(error.data.labels.owner).toBe(owner)
    }
  })

  it('a retried post with one idempotency key lands once, however many processes send it', async () => {
    const dir = tempDir()
    const runs = await Promise.all(Array.from({ length: 8 }, () => cli(dir, ['post', 'deploys', 'www@a1b2c3 is live', '--idempotency-key', 'deploy-a1b2c3', '--json'])))
    expect(runs.every((run) => run.code === 0)).toBe(true)
    expect(new Set(runs.map((run) => JSON.parse(run.stdout).message.id)).size).toBe(1)
    expect(JSON.parse((await cli(dir, ['read', 'deploys', '--json'])).stdout).threads).toHaveLength(1)
  })

  it('thirty processes posting at once lose nothing', async () => {
    const dir = tempDir()
    const runs = await Promise.all(Array.from({ length: 30 }, (_, i) => cli(dir, ['post', 'log', `entry ${i}`, '--as', `agent-${i % 5}`])))
    expect(runs.map((run) => run.code)).toEqual(Array(30).fill(0))
    const page = JSON.parse((await cli(dir, ['read', 'log', '--limit', '100', '--json'])).stdout)
    expect(page.threads.map((thread: { message: { text: string } }) => thread.message.text).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `entry ${i}`).sort())
  })
})
