import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { board } from 'muster'
import { agentWords, brief, sandboxWords } from '../lib/wake.ts'

const HERE = fileURLToPath(new URL('..', import.meta.url))

/** Waited for, not timed: on a busy machine the host takes longer to start and to deliver. */
async function until(done: () => boolean | Promise<boolean>, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (await done()) return
  throw new Error('waited too long')
}

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
      env: { PATH: process.env.PATH, ...env, FACTORY_AGENT: agent, FACTORY_COALESCE: '0s', HOST_ONLY_SECRET: 'sk-not-for-the-agent' } as unknown as NodeJS.ProcessEnv,
    })
    let output = ''
    host.stderr!.on('data', (chunk) => (output += chunk))
    const ended = new Promise<number | null>((resolve) => host.on('exit', (code) => resolve(code)))
    try {
      // The watcher starts from now: it has a place on the board once it has run.
      await until(async () => (await team.as('factory').cursorGet('watch:factory')) !== null)
      const holder = await team.backend.leases!.holder('watch:factory')
      expect(holder?.holder).toMatch(new RegExp(`:${host.pid}:`))
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
    } finally {
      host.kill('SIGTERM')
    }
    expect([await ended, output]).toEqual([143, expect.stringContaining('factory: watching #factory/')])
    // Its lease goes with it, so another host takes over at once.
    expect(await team.backend.leases!.holder('watch:factory')).toBeNull()
    team.close()
  }, 60_000)
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
    expect(sandboxWords(7, { FACTORY_REPO: 'https://github.com/acme/web', FACTORY_PUSH: '1' })).toEqual(['run', '7', '--runner', 'vercel', '--agent', 'claude', '--as', 'factory', '--repo', 'https://github.com/acme/web', '--push'])
  })
})
