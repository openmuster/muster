import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BIN, cli, tempDir } from './helpers.ts'

function fakes(dir: string, scripts: Record<string, string>) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries({ mu: `exec ${process.execPath} ${BIN} "$@"`, ...scripts })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { PATH: `${bin}:${process.env.PATH}` }
}

describe('housekeeping', () => {
  it('backup writes a copy that is a whole board of its own, and never over a file that is there', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'in the backup'])
    const to = join(dir, 'copies', 'main.db')
    mkdirSync(join(dir, 'copies'))
    expect((await cli(dir, ['backup', to])).stdout).toBe(`backed up  ${to}\n`)
    await cli(dir, ['post', 'work', 'after the backup'])
    const copy = JSON.parse((await cli(dir, ['read', 'work', '--json', '--dir', join(dir, 'copies')])).stdout)
    expect(copy.threads.map((thread: { message: { text: string } }) => thread.message.text)).toEqual(['in the backup'])
    const again = await cli(dir, ['backup', to, '--json'])
    expect([again.code, JSON.parse(again.stderr).error.reason]).toEqual([1, 'exists'])
  })

  it('skills install copies the skills that ship with muster to where an agent keeps its own', async () => {
    const dir = tempDir()
    const to = join(dir, 'agent', 'skills')
    const run = await cli(dir, ['skills', 'install', '--to', to])
    expect(run.stdout).toContain(`installed  ${join(to, 'board')}`)
    expect(readFileSync(join(to, 'board', 'SKILL.md'), 'utf8')).toContain('name: board')
    expect(existsSync(join(to, 'board', 'references', 'swarm.md'))).toBe(true)
    expect((await cli(dir, ['skills', 'install'])).code).toBe(2)
  })

  it('daemon install carries the secrets you name into the service file, and refuses one that is not set', async () => {
    const dir = tempDir()
    const fake = join(dir, 'launchctl')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    chmodSync(fake, 0o755)
    const env = { MUSTER_LAUNCHCTL: fake, GITHUB_WEBHOOK_SECRET: 'whsec_value' }
    expect((await cli(dir, ['daemon', 'install', '--env', 'NOT_SET'], { env })).code).toBe(2)
    const run = await cli(dir, ['daemon', 'install', '--env', 'GITHUB_WEBHOOK_SECRET'], { env })
    expect(run.stdout).toContain('carries    GITHUB_WEBHOOK_SECRET')
    const plist = readFileSync(join(dir, 'Library', 'LaunchAgents', 'dev.muster.daemon.main.plist'), 'utf8')
    expect(plist).toMatch(/<key>GITHUB_WEBHOOK_SECRET<\/key>\s*<string>whsec_value<\/string>/)
    expect(plist).toMatch(/<key>PATH<\/key>/)
  })

  it('a looping worker stops at its budget, and stops at once on a usage limit', async () => {
    const dir = tempDir()
    const env = fakes(dir, {
      claude: `cat >/dev/null; mu tasks complete $MUSTER_TASK ok >/dev/null; echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.60}'`,
    })
    for (let i = 0; i < 5; i++) await cli(dir, ['tasks', 'create', 'work', `t${i}`])
    const run = await cli(dir, ['run', '--ready', 'work', '--loop', '--agent', 'claude', '--cwd', dir, '--budget', '1'], { env })
    expect(run.stdout).toContain('stopped: spent $1.20 of a $1.00 budget after 2 tasks')
    const states = JSON.parse((await cli(dir, ['tasks', '--state', 'all', '--json'])).stdout).tasks.map((task: { state: string }) => task.state)
    expect(states).toEqual(['completed', 'completed', 'ready', 'ready', 'ready'])
    const limited = fakes(join(dir, 'b'), { claude: `cat >/dev/null; echo '{"type":"result","subtype":"error","is_error":true,"result":"usage limit reached"}'; exit 1` })
    const stopped = await cli(dir, ['run', '--ready', 'work', '--loop', '--agent', 'claude', '--cwd', dir], { env: limited })
    expect(stopped.code).toBe(1)
    expect(stopped.stdout).toContain('stopped: the agent hit a usage limit after 1 task')
  }, 30_000)
})

describe('budgets from the command line', () => {
  it('mu budget sets, lists and lifts a channel\'s limit, and a looping worker stops when the board says the money is spent', async () => {
    const dir = tempDir()
    const env = fakes(dir, { claude: `cat >/dev/null; mu tasks complete $MUSTER_TASK ok >/dev/null; echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.75}'` })
    for (let i = 0; i < 4; i++) await cli(dir, ['tasks', 'create', 'work', `t${i}`])
    expect((await cli(dir, ['budget', 'work', '1'])).stdout).toBe('budget  #work  $0.00 of $1.00\n')
    const run = await cli(dir, ['run', '--ready', 'work', '--loop', '--agent', 'claude', '--cwd', dir], { env })
    expect(run.stdout).toContain('stopped: #work has spent $1.50 of its $1.00 budget.')
    expect((await cli(dir, ['budget'])).stdout).toMatch(/^#work +\$1\.50 of \$1\.00\n$/)
    expect((await cli(dir, ['budget', 'work', '--none'])).stdout).toBe('no budget  #work\n')
    expect((await cli(dir, ['budget'])).stdout).toBe('no budgets\n')
  }, 30_000)
})

describe('mu demo', () => {
  it('plays the six steps on a scratch board of its own and ends with the ship task ready', async () => {
    const dir = tempDir()
    const run = await cli(dir, ['demo', '--once', '--no-open', '--pace', '0'])
    expect(run.code).toBe(0)
    const lines = run.stdout.trim().split('\n')
    expect(lines.slice(2).map((line) => line.slice(0, 16).trim())).toEqual(['1 request', '2 planning', '3 work claimed', '4 approval', '5 test fails', '6 ready to ship', 'ship task'])
    expect(lines.at(-1)).toMatch(/^ship task +#\d+ is ready$/)
    expect(existsSync(join(dir, 'board', 'main.db'))).toBe(false)
  })
})

describe('a whole run, start to ship', () => {
  it('request, planning, work claimed, approval, a test that fails, and ready to ship: each is a state the board keeps', async () => {
    const dir = tempDir()
    const state = async (id: number) => (JSON.parse((await cli(dir, ['tasks', '--state', 'all', '--json'])).stdout).tasks as { id: number; state: string; hold: { kind: string } | null; reason: string | null }[]).find((task) => task.id === id)!
    // 1. Request: a person posts what they need.
    await cli(dir, ['post', 'db/general', 'We need a storage engine with a write-ahead log.', '--as', 'maya'])
    // 2. Planning: the lead queues the plan, each task after what it needs.
    writeFileSync(join(dir, 'plan.json'), JSON.stringify([
      { key: 'wal', text: 'Write-ahead log', labels: { part: 'wal' } },
      { key: 'recovery', text: 'Crash recovery', needs: [{ key: 'wal' }] },
      { key: 'ship', text: 'Ship the storage engine', needs: [{ key: 'wal' }, { key: 'recovery' }] },
    ]))
    const plan = await cli(dir, ['tasks', 'create', 'db/storage', '--file', join(dir, 'plan.json'), '--as', 'lead', '--json'])
    const [wal, recovery, ship] = (JSON.parse(plan.stdout).tasks as { id: number }[]).map((task) => task.id) as [number, number, number]
    expect([(await state(wal)).state, (await state(recovery)).state, (await state(ship)).state]).toEqual(['ready', 'waiting', 'waiting'])
    // 3. Work claimed: an agent takes what is ready, under a lease, and logs its work as replies.
    expect((await cli(dir, ['tasks', 'claim', '--ready', 'db/', '--as', 'ada', '--json'])).code).toBe(0)
    await cli(dir, ['reply', String(wal), 'plan: append-only segments', '--as', 'ada'])
    expect((await state(wal)).state).toBe('claimed')
    // 4. Approval: it holds the task for a person, who answers in the thread and unblocks it.
    await cli(dir, ['tasks', 'block', String(wal), 'fsync per batch or per write?', '--kind', 'awaiting_approval', '--as', 'ada'])
    expect(await state(wal)).toMatchObject({ state: 'blocked', hold: { kind: 'awaiting_approval' } })
    await cli(dir, ['reply', String(wal), 'per batch', '--as', 'maya'])
    await cli(dir, ['tasks', 'unblock', String(wal), '--as', 'lead'])
    // 5. Test fails: the work is its tests, and a failing run fails the task. Its owner reopens it; the fix passes.
    expect((await cli(dir, ['tasks', 'run', String(wal), '--as', 'ada', '--', 'sh', '-c', 'echo "1 failed"; exit 1'])).code).toBe(1)
    expect(await state(wal)).toMatchObject({ state: 'failed', reason: 'exited 1' })
    await cli(dir, ['tasks', 'reopen', String(wal), '--as', 'lead'])
    expect((await cli(dir, ['tasks', 'run', String(wal), '--result', 'tests pass', '--as', 'ada', '--', 'true'])).code).toBe(0)
    expect((await state(recovery)).state).toBe('ready')
    expect((await state(ship)).state).toBe('waiting')
    // 6. Ready to ship: the last thing it needed completes, and the ship task is ready.
    expect((await cli(dir, ['tasks', 'run', String(recovery), '--as', 'cy', '--', 'true'])).code).toBe(0)
    expect((await state(ship)).state).toBe('ready')
    const thread = JSON.parse((await cli(dir, ['read', String(wal), '--json'])).stdout)
    expect(thread.replies.map((reply: { text: string; by: { profile: string } }) => `${reply.by.profile}: ${reply.text}`)).toEqual(['ada: plan: append-only segments', 'maya: per batch'])
  }, 30_000)
})
