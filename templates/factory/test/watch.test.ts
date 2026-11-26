import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { board } from 'muster'
import { agentWords, brief, sandboxWords } from '../lib/wake.ts'

const HERE = fileURLToPath(new URL('..', import.meta.url))

/** Waited for, not timed: on a busy machine the host takes longer to start and to deliver. */
async function until(done: () => boolean | Promise<boolean>, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (await done()) return
  throw new Error('waited too long')
}

/** What `mu run --runner vercel` reads, and an agent on this machine must never hold. */
const SANDBOX_SETTINGS = {
  VERCEL_TOKEN: 'vercel-token',
  VERCEL_TEAM_ID: 'team_1',
  VERCEL_PROJECT_ID: 'prj_1',
  VERCEL_OIDC_TOKEN: 'oidc-token',
  GITHUB_APP_ID: '123456',
  GITHUB_APP_KEY_FILE: '/keys/app.pem',
  MUSTER_SANDBOX_URL: 'https://board.example.test/api/board',
}

/** The sandbox's settings found in an environment, as `env` prints it. */
const leaked = (printed: string) => printed.split('\n').filter((line) => /^(VERCEL_|GITHUB_APP_|MUSTER_SANDBOX_URL=)/.test(line))

/** A stand-in that notes the environment it started with, in `file`, and reads what it is given on stdin. */
function standIn(dir: string, name: string, file: string) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\nenv > ${join(dir, file)}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Runs lib/wake.ts as the watcher's command() would, on a board of the test's own. */
function runWake(dir: string, env: Record<string, string>) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'lib', 'wake.ts'), '7'], {
      stdio: 'ignore',
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), MUSTER_PROFILE: 'factory', MUSTER_THREAD: '7', MUSTER_EVENT: '9', ...env } as unknown as NodeJS.ProcessEnv,
    })
    child.on('exit', (code) => resolve(code))
  })
}

describe('what a wake hands on', () => {
  it('starts an agent on this machine without the sandbox settings, even when the wake was given them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-wake-'))
    const agent = standIn(dir, 'agent', 'agent-env.txt')
    expect(await runWake(dir, { ...SANDBOX_SETTINGS, FACTORY_AGENT: agent, ANTHROPIC_API_KEY: 'sk-ant-model', FACTORY_REPO: 'https://github.com/acme/web' })).toBe(0)
    const started = readFileSync(join(dir, 'agent-env.txt'), 'utf8')
    expect(leaked(started)).toEqual([])
    expect(started).not.toContain('FACTORY_REPO')
    // What it does get: the model key and the pointer.
    for (const line of ['ANTHROPIC_API_KEY=sk-ant-model', 'MUSTER_PROFILE=factory', 'MUSTER_THREAD=7', `MUSTER_DIR=${join(dir, 'board')}`]) expect(started).toContain(`${line}\n`)
  })

  it("hands the sandbox settings to mu run in a sandbox, with the agent's own token", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-wake-'))
    standIn(dir, 'mu', 'mu-env.txt')
    expect(await runWake(dir, { ...SANDBOX_SETTINGS, FACTORY_RUNNER: 'vercel' })).toBe(0)
    const started = readFileSync(join(dir, 'mu-env.txt'), 'utf8')
    expect(leaked(started).sort()).toEqual(Object.entries(SANDBOX_SETTINGS).map(([name, value]) => `${name}=${value}`).sort())
    expect(started).toMatch(/^MUSTER_AGENT_TOKEN=\S+$/m)
    // The token is one for a sandbox, so the board holds it to a sandbox's routes on any runner.
    const token = /^MUSTER_AGENT_TOKEN=(\S+)$/m.exec(started)![1]!
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))).toMatchObject({ profile: 'factory', sandbox: true })
  })

  it('passes the sandbox settings from the host only when it runs wakes in a sandbox', async () => {
    const settings = Object.keys(SANDBOX_SETTINGS)
    const pass = async (runner: string | undefined) => {
      vi.resetModules()
      vi.stubEnv('FACTORY_RUNNER', runner)
      try {
        return (await import('../lib/board.ts')).PASS
      } finally {
        vi.unstubAllEnvs()
      }
    }
    expect((await pass(undefined)).filter((name) => settings.includes(name))).toEqual([])
    expect((await pass('local')).filter((name) => settings.includes(name))).toEqual([])
    expect((await pass('vercel')).filter((name) => settings.includes(name)).sort()).toEqual([...settings].sort())
    expect(await pass('e2b')).toEqual(expect.arrayContaining(['E2B_API_KEY', 'MUSTER_E2B_TEMPLATE', 'MUSTER_SANDBOX_URL']))
    expect(await pass('local')).not.toContain('E2B_API_KEY')
  })
})

describe('host.ts', () => {
  it("wakes the agent once for a new thread, with a pointer and nothing of the host's secrets, and stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-host-'))
    mkdirSync(join(dir, 'config'))
    // The agent: a stand-in that notes what it was told, on stdin, and the environment it started with.
    const agent = join(dir, 'agent')
    writeFileSync(agent, `#!/bin/sh\ncat >> ${dir}/told.txt\nenv >> ${dir}/env.txt\necho woken >> ${dir}/woken.txt\n`)
    chmodSync(agent, 0o755)
    const env = { MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), HOME: dir }
    const team = board({ dir: env.MUSTER_DIR })
    const host = spawn(process.execPath, ['host.ts'], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ...env, ...SANDBOX_SETTINGS, GITHUB_WEBHOOK_SECRET: 'gh-webhook-secret', FACTORY_AGENT: agent, FACTORY_COALESCE: '0s', HOST_ONLY_SECRET: 'sk-not-for-the-agent' } as unknown as NodeJS.ProcessEnv,
    })
    let output = ''
    host.stderr!.on('data', (chunk) => (output += chunk))
    const ended = new Promise<number | null>((resolve) => host.on('exit', (code) => resolve(code)))
    try {
      // The watcher starts from now: it has a place on the board once it has run.
      await until(async () => (await team.as('factory').cursorGet('watch:factory')) !== null)
      // It runs the watcher and the module's sync: catch-up and what goes back to GitHub.
      for (const role of ['watch:factory', 'sync']) await until(async () => ((await team.backend.leases!.holder(role))?.holder ?? '').includes(`:${host.pid}:`))
      const issue = await team.as('triage').post({ channel: 'factory/intake', text: 'The login redirect goes to the wrong host' })
      await until(() => existsSync(join(dir, 'woken.txt')))
      // The agent's own reply wakes nothing.
      await team.as('factory').reply({ to: issue.id, text: 'reproduced' })
      const replied = await team.head()
      await until(async () => ((await team.as('factory').cursorGet('watch:factory')) ?? 0) >= replied)
      expect(readFileSync(join(dir, 'woken.txt'), 'utf8')).toBe('woken\n')
      expect(readFileSync(join(dir, 'told.txt'), 'utf8')).toBe(brief(String(issue.id)))
      const started = readFileSync(join(dir, 'env.txt'), 'utf8')
      expect(started).toContain(`MUSTER_THREAD=${issue.id}\n`)
      expect(started).toContain('MUSTER_PROFILE=factory\n')
      expect(started).not.toContain('HOST_ONLY_SECRET')
      // The sandbox's settings are the host's, and this wake runs on this machine: the agent gets none of them.
      expect(leaked(started)).toEqual([])
    } finally {
      host.kill('SIGTERM')
    }
    expect([await ended, output]).toEqual([143, expect.stringContaining('factory: watching #factory/')])
    // Its leases go with it, so another host takes over at once.
    expect([await team.backend.leases!.holder('watch:factory'), await team.backend.leases!.holder('sync')]).toEqual([null, null])
    team.close()
  }, 60_000)
})

describe('host.ts without the sync secret', () => {
  it('refuses to start, naming the variable, and holds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-host-'))
    const host = spawn(process.execPath, ['host.ts'], { cwd: HERE, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config') } as unknown as NodeJS.ProcessEnv })
    let output = ''
    host.stderr!.on('data', (chunk) => (output += chunk))
    const code = await new Promise<number | null>((resolve) => host.on('exit', (exit) => resolve(exit)))
    expect([code, output]).toEqual([1, `factory: GITHUB_WEBHOOK_SECRET isn't set, and sync "gh" needs it.\n`])
    const team = board({ dir: join(dir, 'board') })
    expect(await team.backend.leases!.holder('watch:factory')).toBeNull()
    team.close()
  }, 30_000)
})

describe('wake.ts', () => {
  it("tells the agent its instructions and which thread changed, and nothing from the thread", () => {
    const told = brief('812')
    expect(told).toContain('you write under the\nname `factory`')
    expect(told).toContain('Thread 812 changed. Open it with: mu read 812')
  })

  it('runs Claude Code headless unless told another agent, and a sandbox run as wake.sh did', () => {
    expect([agentWords({}), agentWords({ FACTORY_AGENT: 'codex exec' })]).toEqual([['claude', '--print'], ['codex', 'exec']])
    expect(sandboxWords(7, {})).toEqual(['run', '7', '--runner', 'vercel', '--agent', 'claude', '--as', 'factory'])
    expect(sandboxWords(7, { FACTORY_RUNNER: 'e2b' })).toEqual(['run', '7', '--runner', 'e2b', '--agent', 'claude', '--as', 'factory'])
    expect(sandboxWords(7, { FACTORY_REPO: 'https://github.com/acme/web', FACTORY_PUSH: '1' })).toEqual(['run', '7', '--runner', 'vercel', '--agent', 'claude', '--as', 'factory', '--repo', 'https://github.com/acme/web', '--push'])
  })
})
