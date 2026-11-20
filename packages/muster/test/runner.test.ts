import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { agentEnv, claude, codex, generic } from '../src/index.ts'
import { BIN, cli, cliStart, tempDir } from './helpers.ts'

/** A folder of fake agent CLIs, and a `mu` they can call, put first on PATH. */
function fakes(dir: string, scripts: Record<string, string>) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const all = { mu: `exec ${process.execPath} ${BIN} "$@"`, ...scripts }
  for (const [name, body] of Object.entries(all)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { PATH: `${bin}:${process.env.PATH}` }
}

const task = async (dir: string, state = '--state') => JSON.parse((await cli(dir, ['tasks', state, 'all', '--json'])).stdout).tasks[0]

describe('agent descriptors', () => {
  it('claude: headless flags, the prompt on stdin, bypass only when asked by name', () => {
    expect(claude.command({ permissionMode: 'safe', full: true })).toEqual({ bin: 'claude', args: ['--print', '--output-format', 'stream-json', '--verbose'] })
    // Lean by default: no plugins' tools, no skills, a short list of built-in tools.
    expect(claude.command({ permissionMode: 'safe' }).args).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Bash,Read,Edit,Write,Grep,Glob'])
    expect(claude.command({ permissionMode: 'bypass', resume: 'abc', model: 'opus', full: true }).args).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--resume', 'abc', '--model', 'opus', '--dangerously-skip-permissions'])
  })

  it('claude: reads the session, the cost, and usage that counts subagents', () => {
    const out = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
      'not json',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', total_cost_usd: 0.4211, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { opus: { inputTokens: 100, cacheReadInputTokens: 900, outputTokens: 50 }, haiku: { inputTokens: 20, outputTokens: 5 } } }),
    ].join('\n')
    expect(claude.parse(out)).toEqual({ terminal: true, sessionId: 's-1', costUsd: 0.4211, usage: { input: 1020, output: 55 } })
    expect(claude.parse('')).toEqual({ terminal: false })
  })

  it('claude: tells a usage limit, a sign-in error and a bad resume from a crash, by what the CLI reported', () => {
    const failed = (result: string) => ({ terminal: true, error: result })
    const kind = (parsed: ReturnType<typeof claude.parse>, stderr = '', code = 1) => claude.classify({ code, signal: null, parsed, stderr })
    expect(kind(failed('Claude usage limit reached. Your limit will reset at 3pm'))).toBe('quota')
    expect(kind({ terminal: false }, 'Invalid API key · Please run /login')).toBe('auth')
    expect(kind({ terminal: false }, 'No conversation found with session ID: abc')).toBe('bad_resume')
    expect(kind({ terminal: false }, 'segfault')).toBe('crash')
    expect(kind({ terminal: true }, '', 0)).toBe('ok')
    expect(kind({ terminal: false }, '', 0)).toBe('crash')
    expect(claude.classify({ code: null, signal: 'SIGTERM', parsed: { terminal: false }, stderr: '' })).toBe('stopped')
  })

  it('codex: exec --json with the prompt on stdin, the thread as its session, usage from the turn', () => {
    expect(codex.command({ permissionMode: 'safe' })).toEqual({ bin: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-'] })
    expect(codex.command({ permissionMode: 'safe', resume: 't-9', writable: ['/boards'] }).args).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--add-dir', '/boards', 'resume', 't-9', '-'])
    expect(codex.command({ permissionMode: 'bypass' }).args).toEqual(['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'])
    const out = [JSON.stringify({ type: 'thread.started', thread_id: 't-9' }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 70 } })].join('\n')
    expect(codex.parse(out)).toEqual({ terminal: true, sessionId: 't-9', usage: { input: 1000, output: 70 } })
    expect(codex.classify({ code: 1, signal: null, parsed: { terminal: false, error: "You've hit your usage limit" }, stderr: '' })).toBe('quota')
  })

  it("an agent's environment is built from nothing: only PATH, HOME, its own keys, and what is allowed by name", () => {
    const from = { PATH: '/bin', HOME: '/home/ada', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'secret', CLAUDECODE: '1', GITHUB_TOKEN: 'ghp', MY_FLAG: 'yes' }
    expect(agentEnv(claude, { env: { MUSTER_TASK: '7' }, envAllow: ['MY_FLAG'] }, from)).toEqual({ PATH: '/bin', HOME: '/home/ada', ANTHROPIC_API_KEY: 'k', MY_FLAG: 'yes', MUSTER_TASK: '7' })
    expect(agentEnv(generic('sh'), {}, from)).toEqual({ PATH: '/bin', HOME: '/home/ada' })
  })
})

describe('mu run', () => {
  it('starts the agent with a pointer to its task; the agent reads, logs and completes it itself', async () => {
    const dir = tempDir()
    const env = fakes(dir, {
      claude: [
        'prompt=$(cat)',
        `echo "$prompt" > ${dir}/prompt.txt`,
        'echo "$@" > ' + dir + '/args.txt',
        'mu reply $MUSTER_TASK "plan: do it" >/dev/null',
        'mu tasks complete $MUSTER_TASK "done, tests pass" >/dev/null',
        `echo '{"type":"system","subtype":"init","session_id":"sess-42"}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-42","total_cost_usd":0.1234,"usage":{"input_tokens":900,"output_tokens":100}}'`,
      ].join('\n'),
    })
    await cli(dir, ['tasks', 'create', 'work', 'the secret brief text'])
    const run = await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir, '--as', 'worker', '--json'], { env })
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ task: 1, outcome: 'completed', kind: 'ok', session: 'sess-42', cost: 0.1234, tokens: { input: 900, output: 100 } })
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
    expect(prompt).toContain('You hold task #1 on a muster board, writing as worker.')
    expect(prompt).toContain('mu read 1')
    expect(prompt).not.toContain('secret brief text')
    expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim()).toBe('--print --output-format stream-json --verbose --strict-mcp-config --disable-slash-commands --tools Bash,Read,Edit,Write,Grep,Glob')
    const after = await task(dir)
    expect(after).toMatchObject({ state: 'completed', result: 'done, tests pass', labels: { cost: '0.1234', tokens: '1000', session: 'sess-42' } })
    const thread = JSON.parse((await cli(dir, ['read', '1', '--json'])).stdout)
    expect(thread.replies.map((reply: { text: string; by: { profile: string } }) => [reply.text, reply.by.profile])).toEqual([['plan: do it', 'worker']])
  })

  it('an agent that ends without settling its task has it failed for it, and that counts', async () => {
    const dir = tempDir()
    const env = fakes(dir, { claude: `cat >/dev/null; echo '{"type":"result","subtype":"success","is_error":false}'` })
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir, '--json'], { env })
    expect([run.code, JSON.parse(run.stdout).outcome]).toEqual([1, 'failed'])
    expect(await task(dir)).toMatchObject({ state: 'failed', reason: 'the agent ended without settling the task', attempts: 1 })
  })

  it('a usage limit fails the task without counting against it', async () => {
    const dir = tempDir()
    const env = fakes(dir, { claude: `cat >/dev/null; echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached"}'; exit 1` })
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir, '--json'], { env })
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: 'failed', kind: 'quota' })
    expect(await task(dir)).toMatchObject({ state: 'failed', attempts: 0, reason: expect.stringContaining('usage limit') })
  })

  it('any command can be the agent: the prompt arrives on stdin and a crash fails the task', async () => {
    const dir = tempDir()
    const env = fakes(dir, {})
    await cli(dir, ['tasks', 'create', 'work', 'a'])
    await cli(dir, ['tasks', 'create', 'work', 'b'])
    const ok = await cli(dir, ['run', '--ready', 'work', '--cwd', dir, '--', 'sh', '-c', `cat > ${dir}/got.txt; mu tasks complete $MUSTER_TASK ok >/dev/null`], { env })
    expect(ok.stdout).toMatch(/^completed  #1  sh ok\n/)
    expect(readFileSync(join(dir, 'got.txt'), 'utf8')).toContain('You hold task #1')
    const bad = await cli(dir, ['run', '--ready', 'work', '--cwd', dir, '--json', '--', 'sh', '-c', 'cat >/dev/null; exit 9'], { env })
    expect(JSON.parse(bad.stdout)).toMatchObject({ task: 3, outcome: 'failed', kind: 'crash', code: 9 })
  })

  it('the agent does not inherit secrets from the environment mu run was started in', async () => {
    const dir = tempDir()
    const env = { ...fakes(dir, {}), GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret', ALLOWED: 'yes' }
    await cli(dir, ['tasks', 'create', 'work', 't'])
    await cli(dir, ['run', '1', '--cwd', dir, '--env', 'EXTRA=1', '--', 'sh', '-c', `cat >/dev/null; env > ${dir}/env.txt; mu tasks complete $MUSTER_TASK ok >/dev/null`], { env })
    const seen = readFileSync(join(dir, 'env.txt'), 'utf8')
    expect(seen).not.toMatch(/ghp_secret|aws_secret|ALLOWED/)
    expect(seen).toMatch(/^EXTRA=1$/m)
    expect(seen).toMatch(/^MUSTER_TASK=1$/m)
  })

  it('a timeout stops the agent and everything it started, and fails the task', async () => {
    const dir = tempDir()
    const env = fakes(dir, {})
    const marker = join(dir, 'still-running')
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['run', '1', '--cwd', dir, '--timeout', '1s', '--json', '--', 'sh', '-c', `cat >/dev/null; (sleep 3; touch ${marker}) & sleep 30`], { env })
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: 'failed', kind: 'timeout' })
    expect((await task(dir)).reason).toBe('the agent ran out of time')
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(existsSync(marker)).toBe(false)
  }, 20_000)

  it('told to stop, it stops the agent, releases the task, and exits 143', async () => {
    const dir = tempDir()
    const env = fakes(dir, {})
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const running = cliStart(dir, ['run', '1', '--cwd', dir, '--', 'sh', '-c', 'cat >/dev/null; sleep 30'], env)
    await new Promise((resolve) => setTimeout(resolve, 800))
    running.child.kill('SIGTERM')
    const ended = await running.done
    expect(ended.code).toBe(143)
    expect((await task(dir)).state).toBe('ready')
  }, 20_000)

  it('can give the agent a git worktree of its own on a new branch', async () => {
    const dir = tempDir()
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'hi')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const env = fakes(dir, {})
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const tree = join(dir, 'wt-task-1')
    await cli(dir, ['run', '1', '--cwd', tree, '--worktree', repo, '--branch', 'task-1', '--', 'sh', '-c', `cat >/dev/null; git branch --show-current > ${dir}/branch.txt; pwd -P > ${dir}/pwd.txt; mu tasks complete $MUSTER_TASK ok >/dev/null`], { env })
    expect(readFileSync(join(dir, 'branch.txt'), 'utf8').trim()).toBe('task-1')
    expect(existsSync(join(tree, 'README.md'))).toBe(true)
  })

  it('refuses an agent it does not know, and bypass is never the default', async () => {
    const dir = tempDir()
    const env = fakes(dir, { claude: `cat >/dev/null; echo "$@" > ${dir}/args.txt` })
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const unknown = await cli(dir, ['run', '1', '--agent', 'hal9000'], { env })
    expect([unknown.code, unknown.stderr.split('\n')[0]]).toEqual([2, 'error: No agent "hal9000".'])
    await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir, '--bypass-permissions'], { env })
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toContain('--dangerously-skip-permissions')
  })

  it('with --loop a worker takes one task after another until nothing is ready, so two workers drain a queue of five', async () => {
    const dir = tempDir()
    const env = fakes(dir, {})
    for (let i = 0; i < 5; i++) await cli(dir, ['tasks', 'create', 'work', `task ${i}`])
    const agent = ['--', 'sh', '-c', 'cat >/dev/null; mu tasks complete $MUSTER_TASK "by $MUSTER_PROFILE" >/dev/null']
    const workers = await Promise.all(['w1', 'w2'].map((name) => cli(dir, ['run', '--ready', 'work', '--loop', '--cwd', dir, '--as', name, ...agent], { env })))
    expect(workers.map((worker) => worker.code)).toEqual([0, 0])
    const all = JSON.parse((await cli(dir, ['tasks', '--state', 'all', '--json'])).stdout).tasks
    expect(all.map((item: { state: string }) => item.state)).toEqual(Array(5).fill('completed'))
    const worked = workers.map((worker) => Number(/worked (\d+) task/.exec(worker.stdout)![1]))
    expect(worked[0]! + worked[1]!).toBe(5)
  }, 30_000)

  it('--loop needs a queue to take from', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    expect((await cli(dir, ['run', '1', '--loop', '--', 'true'])).code).toBe(2)
  })

  it('an agent that cannot be started did no work: its task goes back and nothing counts against it', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['run', '1', '--cwd', dir, '--json', '--', 'no-such-agent-anywhere'])
    expect([run.code, JSON.parse(run.stdout).outcome]).toEqual([1, 'released'])
    expect(await task(dir)).toMatchObject({ state: 'ready', attempts: 0 })
  })

  it('an agent that worked a task before resumes its own session; another agent, or --fresh, starts clean', async () => {
    const dir = tempDir()
    const record = (name: string) => `cat >/dev/null; echo "$@" >> ${dir}/${name}.args; echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1"}'`
    const env = fakes(dir, { claude: record('claude'), codex: `cat >/dev/null; echo "$@" >> ${dir}/codex.args; echo '{"type":"thread.started","thread_id":"th-1"}'; echo '{"type":"turn.completed","usage":{}}'` })
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const again = async (...extra: string[]) => {
      await cli(dir, ['run', '1', '--cwd', dir, ...extra], { env })
      await cli(dir, ['tasks', 'reopen', '1'])
    }
    await again('--agent', 'claude')
    await again('--agent', 'claude')
    await again('--agent', 'claude', '--fresh')
    await again('--agent', 'codex')
    const claudeRuns = readFileSync(join(dir, 'claude.args'), 'utf8').trim().split('\n')
    expect(claudeRuns.map((args) => args.includes('--resume sess-1'))).toEqual([false, true, false])
    expect(readFileSync(join(dir, 'codex.args'), 'utf8')).not.toContain('resume')
  }, 30_000)

  it('a session the agent no longer has is forgotten, so the next run starts fresh', async () => {
    const dir = tempDir()
    const env = fakes(dir, { claude: `cat >/dev/null; echo "$@" >> ${dir}/args; case "$*" in *--resume*) echo "No conversation found with session ID: gone" >&2; exit 1;; esac; echo '{"type":"result","subtype":"success","is_error":false,"session_id":"new-1"}'` })
    await cli(dir, ['tasks', 'create', 'work', 't'])
    await cli(dir, ['label', '1', 'session=gone', 'agent=claude'])
    const first = JSON.parse((await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir, '--json'], { env })).stdout)
    expect(first.kind).toBe('bad_resume')
    await cli(dir, ['tasks', 'reopen', '1'])
    await cli(dir, ['run', '1', '--agent', 'claude', '--cwd', dir], { env })
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n').map((args) => args.includes('--resume'))).toEqual([true, false])
  }, 30_000)
})
