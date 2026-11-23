import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDaemonConfig } from '../src/daemon/daemon.ts'
import { loadWorkflows } from '../src/daemon/workflows.ts'
import { tempDir } from './helpers.ts'

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
