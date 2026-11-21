import { createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cli, cliStart, tempDir } from './helpers.ts'

const lines = (text: string) => text.trimEnd().split('\n')

describe('cli', () => {
  it('whoami says where the board is, who you are, and that file mode is one trust domain', async () => {
    const dir = tempDir()
    const text = await cli(dir, ['whoami', '--as', 'claude'])
    expect(lines(text.stdout)).toEqual([
      `board  ${join(dir, 'board', 'main.db')}`,
      expect.stringMatching(/^you    claude via \S+$/),
      expect.stringMatching(/^id     local:user:\S+\+claude$/),
      'mode   file: every process of this user can read and write this board',
    ])
    const json = JSON.parse((await cli(dir, ['whoami', '--json'])).stdout)
    expect(json).toMatchObject({ profile: null, mode: 'file' })
  })

  it('post, reply, read: one line per fact, and a thread read back in order', async () => {
    const dir = tempDir()
    expect((await cli(dir, ['post', 'dev', 'deploy is red', '--label', 'kind=bug', '--as', 'lead'])).stdout).toBe('posted  #1  #dev\n')
    expect((await cli(dir, ['reply', '1', 'looking', '--as', 'claude'])).stdout).toBe('replied  #2  in #1\n')
    const thread = lines((await cli(dir, ['read', '#1'])).stdout)
    expect(thread[0]).toMatch(/^#1  lead via \S+ · \d+s  #dev$/)
    expect(thread.slice(1, 3)).toEqual(['    deploy is red', '    kind=bug'])
    expect(thread[4]).toMatch(/^#2  claude via \S+ · \d+s$/)
    expect(thread[5]).toBe('    looking')
    const channel = lines((await cli(dir, ['read', 'dev'])).stdout)
    expect(channel[0]).toBe('cursor 2')
    expect(channel.at(-1)).toMatch(/^    1 reply, last by claude via \S+ · \d+s$/)
  })

  it('text comes from an argument, a file, or stdin', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'note.txt'), 'from a file\nwith two lines')
    await cli(dir, ['post', 'dev', '--file', join(dir, 'note.txt')])
    await cli(dir, ['post', 'dev', '-'], { input: 'from stdin' })
    const page = JSON.parse((await cli(dir, ['read', 'dev', '--json'])).stdout)
    expect(page.threads.map((thread: { message: { text: string } }) => thread.message.text).sort()).toEqual(['from a file\nwith two lines', 'from stdin'])
  })

  it('--json prints one document on success and one on failure, with a reason to branch on', async () => {
    const dir = tempDir()
    const ok = await cli(dir, ['post', 'dev', 'hello', '--json'])
    expect(JSON.parse(ok.stdout).message).toMatchObject({ id: 1, channel: 'dev', text: 'hello' })
    const failed = await cli(dir, ['read', '99', '--json'])
    expect(failed.code).toBe(1)
    expect(failed.stdout).toBe('')
    expect(JSON.parse(failed.stderr)).toEqual({ error: { reason: 'not_found', message: 'No message 99.' } })
  })

  it('exit codes: 0 for success, 1 for a failure, 2 for misuse', async () => {
    const dir = tempDir()
    expect((await cli(dir, ['post', 'dev', 'x'])).code).toBe(0)
    expect((await cli(dir, ['read', '99'])).code).toBe(1)
    for (const misuse of [['nope'], ['post'], ['post', 'Dev', 'x'], ['read', 'dev', '--bogus'], ['reply', 'abc', 'x'], ['tasks', 'claim'], ['tasks', 'fail', '1'], ['wait', '--timeout', 'soon']]) {
      const run = await cli(dir, misuse)
      expect([misuse.join(' '), run.code]).toEqual([misuse.join(' '), 2])
      expect(run.stderr).toMatch(/^error: /)
    }
  })

  it('an error says what failed and gives at most two ways out, indented under a blank line', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    await cli(dir, ['tasks', 'claim', '1', '--as', 'a'])
    const run = await cli(dir, ['tasks', 'complete', '1', 'done', '--as', 'b'])
    expect(run.code).toBe(1)
    expect(lines(run.stderr)).toEqual(["error: Task 1 is held under a claim, and this isn't it.", '', "  Only its holder settles it. If that was you, stop and say so in its thread.", '  mu read 1'])
  })

  it('completing a task nobody claimed says to claim it first, and the claim it names works', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['tasks', 'complete', '1', 'done'])
    expect(run.code).toBe(1)
    expect(lines(run.stderr)).toEqual(['error: Nobody holds task 1: it is ready.', '', '  Claim it first: only the claim that holds a task settles it.', '  mu tasks claim 1'])
    await cli(dir, ['tasks', 'claim', '1'])
    expect((await cli(dir, ['tasks', 'complete', '1', 'done'])).stdout).toBe('completed  #1\n')
    const again = await cli(dir, ['tasks', 'complete', '1', 'done', '--json'])
    expect(JSON.parse(again.stderr).error).toMatchObject({ reason: 'task_finished', message: 'Task 1 is completed.' })
  })

  it('prints no colour and no line over 80 columns for ordinary output', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'db/storage', 'Write-ahead log', '--label', 'group=storage'])
    for (const args of [['whoami'], ['tasks'], ['read', 'db/storage'], ['channels'], ['actors'], ['help']]) {
      const out = (await cli(dir, args)).stdout
      expect(out).not.toMatch(/\u001b\[/)
      for (const line of lines(out).filter((text) => !text.startsWith('board  '))) expect([args[0], line.length <= 80, line]).toEqual([args[0], true, line])
    }
  })

  it('the tasks list shows each open task with its state, labels, holder and time left, and what it waits for', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'db/storage', 'Write-ahead log', '--label', 'kind=plan', '--as', 'lead'])
    await cli(dir, ['tasks', 'create', 'db/storage', 'Crash recovery', '--needs', '1', '--as', 'lead'])
    await cli(dir, ['tasks', 'claim', '--ready', 'db/', '--as', 'ada', '--lease', '5m'])
    const rows = lines((await cli(dir, ['tasks'])).stdout)
    expect(rows[0]).toMatch(/^#1      claimed    Write-ahead log  kind=plan  ada via \S+ · [45]:\d\d left  #db\/storage$/)
    expect(rows[1]).toBe('#3      waiting    Crash recovery  needs #1  #db/storage')
    expect((await cli(dir, ['tasks', '--state', 'failed'])).stdout).toBe('no failed tasks\n')
  })

  it('tasks --latest lists the last active, the latest last, and says when others are not shown', async () => {
    const dir = tempDir()
    for (const text of ['a', 'b', 'c']) await cli(dir, ['tasks', 'create', 'work', text])
    await cli(dir, ['reply', '1', 'still on it'])
    const ids = (run: { stdout: string }) => JSON.parse(run.stdout).tasks.map((task: { id: number }) => task.id)
    expect(ids(await cli(dir, ['tasks', '--latest', '--limit', '2', '--json']))).toEqual([5, 1])
    expect(ids(await cli(dir, ['tasks', '--limit', '2', '--json']))).toEqual([1, 3])
    expect(lines((await cli(dir, ['tasks', '--latest', '--limit', '2'])).stdout).slice(-1)).toEqual(['(the last active: others not shown)'])
    expect(lines((await cli(dir, ['tasks', '--limit', '2'])).stdout).slice(-1)).toEqual(['(more not shown: narrow with --state or --label, or see --latest)'])
  })

  it("keeps a claim's token for the profile that took it, in a file only you can read, and forgets it on settling", async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    await cli(dir, ['tasks', 'claim', '1', '--as', 'worker'])
    const folder = join(dir, 'config', 'claims')
    const board = readdirSync(folder)[0]!
    expect(readdirSync(join(folder, board))).toEqual(['1-worker.json'])
    expect((await cli(dir, ['tasks', 'renew', '1'])).code).toBe(1)
    expect((await cli(dir, ['tasks', 'renew', '1', '--as', 'worker', '--lease', '10m'])).stdout).toMatch(/^#1  yours for (10m|9m)\n$/)
    expect((await cli(dir, ['tasks', 'complete', '1', 'done', '--as', 'worker'])).stdout).toBe('completed  #1\n')
    expect(existsSync(join(folder, board, '1-worker.json'))).toBe(false)
  })

  it('MUSTER_CLAIM_TOKEN is the claim a run brings: taken on one machine, settled from another, never printed', async () => {
    const dir = tempDir()
    const token = createHmac('sha256', 'only the run has this').update('run-42').digest('base64url')
    const here = { MUSTER_CLAIM_TOKEN: token, MUSTER_CONFIG: join(dir, 'instance-1') }
    const there = { MUSTER_CLAIM_TOKEN: token, MUSTER_CONFIG: join(dir, 'instance-2') }
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const claimed = await cli(dir, ['tasks', 'claim', '1', '--as', 'ci', '--json'], { env: here })
    expect(claimed.code).toBe(0)
    expect(claimed.stdout + claimed.stderr).not.toContain(token)
    // Another instance has no claim kept, and the same token: claiming again answers the claim, and it settles.
    expect((await cli(dir, ['tasks', 'claim', '1', '--as', 'ci'], { env: there })).code).toBe(0)
    const without = await cli(dir, ['tasks', 'complete', '1', 'done', '--as', 'ci', '--json'], { env: { MUSTER_CONFIG: join(dir, 'instance-3') } })
    expect(JSON.parse(without.stderr).error.reason).toBe('claim_lost')
    expect((await cli(dir, ['tasks', 'renew', '1', '--as', 'ci'], { env: there })).code).toBe(0)
    expect((await cli(dir, ['tasks', 'complete', '1', 'done', '--as', 'ci'], { env: there })).stdout).toBe('completed  #1\n')
    // A task made with its claim carries it, and a token that could be guessed is refused before anything is taken.
    const made = await cli(dir, ['tasks', 'create', 'work', 'made held', '--claim', '--as', 'ci', '--json'], { env: here })
    expect(made.stdout + made.stderr).not.toContain(token)
    const held = String(JSON.parse(made.stdout).task.id)
    expect((await cli(dir, ['tasks', 'complete', held, 'done', '--as', 'ci'], { env: there })).code).toBe(0)
    const open = String(JSON.parse((await cli(dir, ['tasks', 'create', 'work', 'u', '--json'])).stdout).task.id)
    const weak = await cli(dir, ['tasks', 'claim', open, '--json'], { env: { MUSTER_CLAIM_TOKEN: 'run-42' } })
    expect([weak.code, JSON.parse(weak.stderr).error.reason]).toEqual([2, 'invalid_claim_token'])
  })

  it('completing a task names the tasks it readied', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'build'])
    await cli(dir, ['tasks', 'create', 'work', 'ship', '--needs', '1'])
    await cli(dir, ['tasks', 'claim', '1'])
    expect((await cli(dir, ['tasks', 'complete', '1', 'built'])).stdout).toBe('completed  #1\nready      #3\n')
  })

  it('queues a plan from a file', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plan.json'), JSON.stringify([{ key: 'limiter', text: 'Add a rate limiter' }, { key: 'review', text: 'Review it', needs: [{ key: 'limiter' }] }]))
    const run = await cli(dir, ['tasks', 'create', 'work/checkout', '--file', join(dir, 'plan.json'), '--idempotency-key', 'p1', '--as', 'lead'])
    expect(lines(run.stdout)).toEqual(['created  #1  ready     limiter', 'created  #3  waiting   review'])
    const again = await cli(dir, ['tasks', 'create', 'work/checkout', '--file', join(dir, 'plan.json'), '--idempotency-key', 'p1', '--as', 'lead'])
    expect(again.stdout).toBe(run.stdout)
  })

  it("a plan file that isn't JSON names the command that makes one task of it, which works", async () => {
    const dir = tempDir()
    const file = join(dir, 'task.md')
    writeFileSync(file, '# Fix the redirect\n\nFollow only same-origin paths.\n')
    const run = await cli(dir, ['tasks', 'create', 'work', '--file', file, '--label', 'role=worker', '--label', 'note=two words', '--as', 'lead'])
    expect(run.code).toBe(2)
    expect(lines(run.stderr)).toEqual([
      `error: ${file} isn't JSON, so it isn't a plan of tasks.`,
      '',
      '  For one task with that text, give - as the text and the file on stdin.',
      `  mu tasks create work - --label role=worker --label 'note=two words' --as lead < ${file}`,
    ])
    const one = await cli(dir, ['tasks', 'create', 'work', '-', '--label', 'role=worker', '--label', 'note=two words', '--as', 'lead', '--json'], { input: readFileSync(file, 'utf8') })
    expect(JSON.parse(one.stdout).task).toMatchObject({ id: 1, state: 'ready' })
    const [listed] = JSON.parse((await cli(dir, ['tasks', '--json'])).stdout).tasks
    expect(listed).toMatchObject({ text: '# Fix the redirect\n\nFollow only same-origin paths.\n', labels: { role: 'worker', note: 'two words' } })
    const piped = await cli(dir, ['tasks', 'create', 'work', '--file', '-'], { input: 'not json' })
    expect(lines(piped.stderr).slice(-1)).toEqual(['  mu tasks create work -'])
    const missing = await cli(dir, ['tasks', 'create', 'work', '--file', join(dir, 'nowhere.json')])
    expect([missing.code, lines(missing.stderr)[0]]).toEqual([2, `error: Couldn't read the plan at ${join(dir, 'nowhere.json')}: no such file.`])
  })

  it("refuses one task's options on a plan, where they were dropped", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plan.json'), JSON.stringify([{ key: 'a', text: 'a' }]))
    await cli(dir, ['tasks', 'create', 'work', 'before'])
    for (const option of [['--label', 'role=worker'], ['--needs', '1'], ['--for', 'ada'], ['--claim'], ['--no-sync']]) {
      const run = await cli(dir, ['tasks', 'create', 'work', '--file', join(dir, 'plan.json'), ...option])
      expect([option[0], run.code, lines(run.stderr)[0]]).toEqual([option[0], 2, `error: ${option[0]} is one task's, and this is a plan of tasks.`])
    }
    expect(JSON.parse((await cli(dir, ['tasks', '--json'])).stdout).tasks).toHaveLength(1)
    expect((await cli(dir, ['tasks', 'create', 'work', '--file', join(dir, 'plan.json'), '--idempotency-key', 'k'])).code).toBe(0)
  })

  it('tasks run completes on exit 0, fails with the exit code otherwise, and hands the command the task ID', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'passes'])
    await cli(dir, ['tasks', 'create', 'work', 'fails'])
    const ok = await cli(dir, ['tasks', 'run', '1', '--result', 'tests pass', '--', 'sh', '-c', 'echo task=$MUSTER_TASK'])
    expect([ok.code, ok.stdout]).toEqual([0, 'task=1\ncompleted 1\n'])
    const bad = await cli(dir, ['tasks', 'run', '3', '--', 'sh', '-c', 'exit 7'])
    expect([bad.code, bad.stdout]).toEqual([7, 'failed 3\n'])
    const all = JSON.parse((await cli(dir, ['tasks', '--state', 'all', '--json'])).stdout).tasks
    expect(all.map((task: { state: string; result: string | null; reason: string | null }) => [task.state, task.result ?? task.reason])).toEqual([['completed', 'tests pass'], ['failed', 'exited 7']])
  })

  it('tasks run with --json keeps stdout to one document and sends the command\'s output to stderr', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['tasks', 'run', '--ready', 'work', '--json', '--', 'sh', '-c', 'echo noise; exit 2'])
    expect(run.code).toBe(2)
    expect(JSON.parse(run.stdout)).toEqual({ task: 1, outcome: 'failed', code: 2, signal: null })
    expect(run.stderr).toBe('noise\n')
  })

  it('tasks run releases the task and exits 143 when it is told to stop, and its command stops too', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'long'])
    const marker = join(dir, 'still-running')
    const running = cliStart(dir, ['tasks', 'run', '1', '--', 'sh', '-c', `sleep 3; touch ${marker}`])
    await new Promise((resolve) => setTimeout(resolve, 700))
    running.child.kill('SIGTERM')
    const ended = await running.done
    expect(ended.code).toBe(143)
    expect(ended.stdout).toBe('released 1\n')
    expect(JSON.parse((await cli(dir, ['tasks', '--json'])).stdout).tasks[0].state).toBe('ready')
    await new Promise((resolve) => setTimeout(resolve, 2800))
    expect(existsSync(marker)).toBe(false)
  })

  it('tasks run that cannot start its command releases the task', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 't'])
    const run = await cli(dir, ['tasks', 'run', '1', '--', 'no-such-command-anywhere'])
    expect(run.code).toBe(1)
    expect(run.stderr).toMatch(/^error: couldn't start no-such-command-anywhere/)
    expect(JSON.parse((await cli(dir, ['tasks', '--json'])).stdout).tasks[0].state).toBe('ready')
  })

  it("wait hears another process's write, prints it, and says where to wait from next", async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'question?'])
    const waiting = cliStart(dir, ['wait', '--re', '1', '--timeout', '20s', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 600))
    await cli(dir, ['post', 'other', 'not this'])
    await cli(dir, ['reply', '1', 'answer', '--as', 'lead'])
    const ended = await waiting.done
    expect(ended.code).toBe(0)
    const heard = JSON.parse(ended.stdout)
    expect(heard.event).toMatchObject({ type: 'message.posted', thread: 1, message: { text: 'answer' } })
    expect(heard.next).toBe(`mu wait --after ${heard.cursor}`)
  })

  it('wait --after counts something that landed before the wait started', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'question?'])
    await cli(dir, ['reply', '1', 'already answered'])
    const run = await cli(dir, ['wait', 'work', '--after', '1', '--timeout', '5s', '--json'])
    expect(JSON.parse(run.stdout).event.message.text).toBe('already answered')
  })

  it('a wait that times out exits 1 with the reason timeout and the cursor it reached', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'x'])
    const run = await cli(dir, ['wait', 'work', '--timeout', '300ms', '--json'])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr).error).toMatchObject({ reason: 'timeout', data: { cursor: 1 } })
  })

  it('claim --wait takes a task that becomes ready while it waits, and times out with exit 1 when none does', async () => {
    const dir = tempDir()
    const waiting = cliStart(dir, ['tasks', 'claim', '--ready', 'work', '--wait', '20s', '--as', 'worker', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    await cli(dir, ['tasks', 'create', 'work', 'here you go'])
    const ended = await waiting.done
    expect([ended.code, JSON.parse(ended.stdout).task.id]).toEqual([0, 1])
    const none = await cli(dir, ['tasks', 'claim', '--ready', 'work', '--wait', '300ms', '--json'])
    expect([none.code, JSON.parse(none.stderr).error.reason]).toEqual([1, 'timeout'])
  })

  it('tail prints each event as it happens, one JSON line each with --json, and exits 130 on Ctrl-C', async () => {
    const dir = tempDir()
    const tailing = cliStart(dir, ['tail', 'work', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 600))
    await cli(dir, ['post', 'work', 'one'])
    await cli(dir, ['post', 'work', 'two'])
    await new Promise((resolve) => setTimeout(resolve, 1300))
    tailing.child.kill('SIGINT')
    const ended = await tailing.done
    expect(ended.code).toBe(130)
    expect(lines(ended.stdout).map((line) => JSON.parse(line).data.text)).toEqual(['one', 'two'])
  })

  it('read --cursor remembers where a profile read to', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'first'])
    expect((await cli(dir, ['read', 'work', '--cursor', 'inbox', '--as', 'lead'])).stdout).toMatch(/first/)
    expect(lines((await cli(dir, ['read', 'work', '--cursor', 'inbox', '--as', 'lead'])).stdout).at(-1)).toBe('nothing new')
    await cli(dir, ['post', 'work', 'second'])
    const news = (await cli(dir, ['read', 'work', '--cursor', 'inbox', '--as', 'lead'])).stdout
    expect(news).toMatch(/second/)
    expect(news).not.toMatch(/first/)
  })

  it('MUSTER_PROFILE names the profile when --as is not given', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'work', 'x'], { env: { MUSTER_PROFILE: 'codex' } })
    expect(JSON.parse((await cli(dir, ['read', '1', '--json'])).stdout).message.by.profile).toBe('codex')
  })

  it('asking for help on a command that does not exist is an error, with the command that was meant', async () => {
    const dir = tempDir()
    for (const args of [['frob', '--help'], ['help', 'frob'], ['frob']]) {
      const run = await cli(dir, args)
      expect([args, run.code, run.stdout]).toEqual([args, 2, ''])
      expect(lines(run.stderr)).toEqual(['error: Unknown command "frob".', '', '  mu help lists the commands.'])
    }
    const json = await cli(dir, ['frob', '--help', '--json'])
    expect(json.stdout).toBe('')
    expect(JSON.parse(json.stderr).error.reason).toBe('unknown_command')
    const way = async (name: string) => lines((await cli(dir, [name, '--help'])).stderr).slice(2)
    expect(await way('task')).toEqual(['  Did you mean mu tasks?', '  mu help'])
    expect(await way('serach')).toEqual(['  Did you mean mu search?', '  mu help'])
    expect(await way('claim')).toEqual(['  Did you mean mu tasks claim?', '  mu help'])
    expect(await way('assign')).toEqual(['  Did you mean mu tasks assign?', '  mu help'])
    expect(await way('grep')).toEqual(['  Did you mean mu search?', '  mu help'])
    expect(await way('mentions')).toEqual(['  Did you mean mu wait --mentions <who>?', '  mu help'])
    expect((await cli(dir, ['help', 'tasks'])).code).toBe(0)
    // An option is not a command: the command comes first.
    for (const args of [['--json', 'whoami'], ['--as', 'claude', 'post', 'general', 'hi'], ['constructor']]) {
      const run = await cli(dir, args)
      expect([args, run.code, JSON.parse(run.stderr.startsWith('{') ? run.stderr : '{"error":{}}').error.reason ?? lines(run.stderr)[0]]).toEqual([args, 2, args[0] === '--json' ? 'unknown_command' : `error: Unknown command "${args[0]}".`])
    }
    for (const args of [['help', '--json'], ['help', 'help'], ['help', 'mcp'], ['--help', 'frob']]) expect([args, (await cli(dir, args)).code]).toEqual([args, 0])
  })

  it("a command's help is its own lines from the whole help, and ends with what every command takes", async () => {
    const dir = tempDir()
    const whole = lines((await cli(dir, ['help'])).stdout)
    const read = await cli(dir, ['read', '--help'])
    expect(read.code).toBe(0)
    expect(lines(read.stdout)).toEqual([
      'mu read',
      '',
      'read',
      "  read <channel|id>              a channel's threads, or one thread",
      '       [--after <cursor>] [--before <cursor>] [--limit n] [--label k=v]...',
      '       [--text <words>] [--mentions <who>] [--cursor <name>]',
      '',
      'global: [--as <profile>] [--board <name>] [--dir <path>] [--url <board url>] [--json]',
      'mu help lists every command.',
    ])
    expect((await cli(dir, ['help', 'read'])).stdout).toBe(read.stdout)
    // Asked with arguments in place, as an agent does when a command was refused.
    expect((await cli(dir, ['read', 'general', '--limit', '3', '--help'])).stdout).toBe(read.stdout)
    // One form of a command that has several, and the command whole when the word after it isn't a form.
    const claim = lines((await cli(dir, ['tasks', 'claim', '--help'])).stdout)
    expect(claim.slice(0, 5)).toEqual(['mu tasks claim', '', 'tasks', '  tasks claim <id> | --ready <channel> [--label k=v]... [--from <owner>]...', '       [--wait 10m] [--lease 15m]'])
    expect(claim.some((line) => line.includes('tasks complete'))).toBe(false)
    const tasks = lines((await cli(dir, ['tasks', 'work/', '--help'])).stdout)
    expect(tasks[0]).toBe('mu tasks')
    expect(tasks.some((line) => line.includes('tasks complete'))).toBe(true)
    // Every command the help names has a page, and a page says nothing the whole help doesn't.
    const named = new Set(whole.flatMap((line) => /^  ([a-z]+)[ \n]?/.exec(line)?.[1] ?? []))
    expect(named.size).toBeGreaterThan(20)
    for (const name of named) {
      const page = lines((await cli(dir, [name, '--help'])).stdout)
      expect([name, page[0], page.at(-1)]).toEqual([name, `mu ${name}`, 'mu help lists every command.'])
      expect([name, page.slice(1, -2).filter((line) => !whole.includes(line))]).toEqual([name, []])
      expect([name, page.length < whole.length / 2]).toEqual([name, true])
    }
  })

  it('leaves --help and --json after -- to the command it runs', async () => {
    const dir = tempDir()
    await cli(dir, ['tasks', 'create', 'work', 'one'])
    await cli(dir, ['tasks', 'create', 'work', 'two'])
    const helped = await cli(dir, ['tasks', 'run', '1', '--', process.execPath, '-e', 'console.log("ran with " + process.argv.slice(1).join(" "))', '--', '--help'])
    expect(lines(helped.stdout)).toEqual(['ran with --help', 'completed 1'])
    const plain = await cli(dir, ['tasks', 'run', '3', '--', process.execPath, '-e', 'console.log("ran with " + process.argv.slice(1).join(" "))', '--', '--json'])
    expect(lines(plain.stdout)).toEqual(['ran with --json', 'completed 3'])
  })

  it('read --mentions lists the threads that mention someone, and is refused on one thread with the rest of a channel\'s filters', async () => {
    const dir = tempDir()
    await cli(dir, ['post', 'general', 'here', '--as', 'lead'])
    await cli(dir, ['post', 'general', 'nothing for anyone'])
    await cli(dir, ['post', 'general', '@lead can you look?'])
    const run = await cli(dir, ['read', 'general', '--mentions', 'lead', '--json'])
    expect(JSON.parse(run.stdout).threads.map((thread: { message: { id: number } }) => thread.message.id)).toEqual([3])
    for (const flag of [['--mentions', 'lead'], ['--text', 'look'], ['--limit', '2']]) {
      const one = await cli(dir, ['read', '3', ...flag])
      expect([flag[0], one.code, lines(one.stderr)[0]]).toEqual([flag[0], 2, `error: ${flag[0]} is for a channel's threads, and 3 is one thread.`])
    }
  })

  it('every command in the help exists, and help is what a bare mu prints', async () => {
    const dir = tempDir()
    const help = (await cli(dir, [])).stdout
    expect(help).toBe((await cli(dir, ['help'])).stdout)
    const named = [...help.matchAll(/^  ([a-z]+)[ \n]/gm)].map((match) => match[1]!).filter((name) => !['Text', 'Every'].includes(name))
    for (const name of new Set(named)) {
      const run = await cli(dir, [name, '--bogus-flag-for-test'])
      expect([name, run.stderr.includes('Unknown command')]).toEqual([name, false])
    }
  })
})

describe('files', () => {
  it('a message carries files: attached by path, stored once by what they hold, and downloaded under their own names', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'trace.json'), '{"spans": 3}')
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    const posted = JSON.parse((await cli(dir, ['post', 'work', 'here is the trace', '--attach', join(dir, 'trace.json'), '--attach', join(dir, 'notes.txt'), '--json'])).stdout)
    expect(posted.message.attachments.map((file: { name: string; type: string; size: number }) => [file.name, file.type, file.size])).toEqual([['trace.json', 'application/json', 12], ['notes.txt', 'text/plain', 5]])
    await cli(dir, ['reply', '1', 'again', '--attach', join(dir, 'trace.json')])
    expect(readdirSync(join(dir, 'board', 'main.files'))).toHaveLength(2)
    expect((await cli(dir, ['read', '1'])).stdout).toContain('[trace.json] [notes.txt]')
    const saved = await cli(dir, ['download', '1', '--to', join(dir, 'out')])
    expect(saved.stdout).toBe(`saved  ${join(dir, 'out', 'trace.json')}\nsaved  ${join(dir, 'out', 'notes.txt')}\n`)
    expect(readFileSync(join(dir, 'out', 'trace.json'), 'utf8')).toBe('{"spans": 3}')
  })

  it('refuses a file that is not there, an eleventh file, and a download from a message with none', async () => {
    const dir = tempDir()
    expect((await cli(dir, ['post', 'work', 'x', '--attach', join(dir, 'missing.txt')])).code).toBe(2)
    const many = Array.from({ length: 11 }, (_, i) => {
      writeFileSync(join(dir, `f${i}.txt`), String(i))
      return ['--attach', join(dir, `f${i}.txt`)]
    }).flat()
    const run = await cli(dir, ['post', 'work', 'too many', ...many, '--json'])
    expect(JSON.parse(run.stderr).error.reason).toBe('too_many_attachments')
    await cli(dir, ['post', 'work', 'plain'])
    expect(JSON.parse((await cli(dir, ['download', '1', '--json'])).stderr).error.reason).toBe('no_files')
  })

  it("a download uses only a file's own name, so a message can't write outside the folder", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'x')
    const posted = JSON.parse((await cli(dir, ['post', 'work', 'x', '--attach', join(dir, 'a.txt'), '--json'])).stdout)
    const team = (await import('../src/index.ts')).board({ dir: join(dir, 'board') })
    await team.post({ channel: 'work', text: 'evil', attachments: [{ ...posted.message.attachments[0], name: '../../escaped.txt' }] })
    team.close()
    await cli(dir, ['download', '2', '--to', join(dir, 'out', 'deep')])
    expect(existsSync(join(dir, 'out', 'deep', 'escaped.txt'))).toBe(true)
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
  })
  it('makes no network call of its own: a board on a file is read and written without one', async () => {
    const dir = tempDir()
    const log = join(dir, 'net.log')
    const hook = fileURLToPath(new URL('./fixtures/no-network.mjs', import.meta.url))
    const env = { NODE_OPTIONS: `--import=${hook}`, MUSTER_TEST_NETLOG: log }
    for (const args of [['whoami'], ['post', 'general', 'hello'], ['read', 'general'], ['tasks', 'create', 'work', 'a task'], ['tasks'], ['search', 'hello'], ['--version']]) {
      expect((await cli(dir, args, { env })).code).toBe(0)
    }
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
    // The hook does see a connection when one is made, so an empty log means none was.
    const server = createServer((_request, response) => response.end('{}')).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    await cli(dir, ['whoami'], { env: { ...env, MUSTER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/board`, MUSTER_TOKEN: 'x' } })
    server.close()
    expect(readFileSync(log, 'utf8')).toContain('connect')
  })

  it('token list shows what the board has made, and revoke stops one', async () => {
    const dir = tempDir()
    const made = JSON.parse((await cli(dir, ['token', 'create', '--as', 'fixer', '--can', 'work/=read,post', '--ttl', '2h', '--json'])).stdout)
    expect(made.token).toMatch(/^mu1\./)
    expect(made.claims).toMatchObject({ profile: 'fixer', can: { 'work/': ['read', 'post'] } })
    expect((await cli(dir, ['token', 'list'])).stdout).toMatch(new RegExp(`^${made.id}  fixer  work/=read,post  until \\d{4}-`))
    expect((await cli(dir, ['token', 'revoke', made.id])).stdout).toBe(`revoked  ${made.id}\n`)
    expect((await cli(dir, ['token', 'list'])).stdout).toMatch(/revoked\n$/)
    expect(JSON.parse((await cli(dir, ['token', 'revoke', 'nope', '--json'])).stderr).error.reason).toBe('not_found')
  })
})
