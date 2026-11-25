import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { holderName, setup, tilde } from '../lib/setup.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'factory-test-'))
const factory = [{ name: 'factory', tail: { channel: 'factory/' } }]
const HOLDER = 'mini.local:4242:a1b2c3d4e5f6'

describe('setup', () => {
  it('with nothing declared or running, every step is to do and says what to run', () => {
    const steps = setup({ config: dir(), channel: 'factory', watchers: [], holders: {} })
    expect(steps.map((step) => step.done)).toEqual([false, false, false])
    expect(steps.every((step) => typeof step.fix === 'string')).toBe(true)
  })

  it('a declared watcher nobody runs is to do, and says to start the host', () => {
    const [watcher] = setup({ config: dir(), channel: 'factory', watchers: [{ name: 'other', tail: { channel: 'elsewhere/' } }, ...factory], holders: { tick: HOLDER, 'watch:factory': null } })
    expect([watcher!.done, watcher!.detail, watcher!.fix]).toEqual([false, '"factory" on #factory/ is declared, and nothing runs it', 'pnpm host   (node host.ts, in this folder)'])
  })

  it('names who holds each role: the watcher by its host, the ticker by mu serve, and the platforms', () => {
    const config = dir()
    writeFileSync(join(config, 'sync.json'), JSON.stringify({ gh: { type: 'github', secret: 'env:S' } }))
    const steps = setup({ config, channel: 'factory', watchers: factory, holders: { tick: 'box:77:ffffffffffff', 'watch:factory': HOLDER } })
    expect(steps.map((step) => [step.done, step.detail])).toEqual([
      [true, '"factory" on #factory/, run by mini.local (pid 4242)'],
      [true, 'gh (github)'],
      [true, 'tick held by box (pid 77): mu serve or a daemon sends schedules and syncs'],
    ])
  })

  it('a watcher of the same name left in watchers.json is not done, since the host refuses to run both', () => {
    const config = dir()
    writeFileSync(join(config, 'watchers.json'), JSON.stringify({ watchers: [{ name: 'factory', tail: { channel: 'factory/' }, run: ['./wake.sh', '{thread}'] }] }))
    const [watcher] = setup({ config, channel: 'factory', watchers: factory, holders: { 'watch:factory': HOLDER } })
    expect(watcher!.done).toBe(false)
    expect(watcher!.fix).toBe(`remove "factory" from ${tilde(join(config, 'watchers.json'))}`)
  })

  it('a path under the home directory is shown as people write it', () => {
    const config = join(homedir(), '.config', 'muster-not-there')
    const [, platform] = setup({ config, channel: 'factory', watchers: factory, holders: {} })
    expect(platform!.fix).toBe("optional: copy sync.json to ~/.config/muster-not-there/sync.json and point the platform's webhook at mu serve's /api/board/webhooks/<name>")
    expect([tilde(homedir()), tilde(`${homedir()}x/y`), tilde('/etc/muster')]).toEqual(['~', `${homedir()}x/y`, '/etc/muster'])
    expect(holderName('not-a-holder')).toBe('not-a-holder')
  })
})
