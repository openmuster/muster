import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { holderName, setup, tilde } from '../lib/setup.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'factory-test-'))
const factory = [{ name: 'factory', tail: { channel: 'factory/' } }]
const gh = [{ key: 'gh', type: 'github' }]
const HOLDER = 'mini.local:4242:a1b2c3d4e5f6'

describe('setup', () => {
  it('with nothing declared or running, every step is to do and says what to run', () => {
    const steps = setup({ config: dir(), channel: 'factory', watchers: [], sync: [], holders: {} })
    expect(steps.map((step) => step.done)).toEqual([false, false, false])
    expect(steps.every((step) => typeof step.fix === 'string')).toBe(true)
  })

  it('a declared watcher nobody runs is to do, and says to start the host', () => {
    const [watcher] = setup({ config: dir(), channel: 'factory', watchers: [{ name: 'other', tail: { channel: 'elsewhere/' } }, ...factory], sync: gh, holders: { tick: HOLDER, 'watch:factory': null } })
    expect([watcher!.done, watcher!.detail, watcher!.fix]).toEqual([false, '"factory" on #factory/ is declared, and nothing runs it', 'pnpm host   (node host.ts, in this folder)'])
  })

  it('names who holds each role: the watcher and the sync by the host, the ticker by a daemon', () => {
    const steps = setup({ config: dir(), channel: 'factory', watchers: factory, sync: gh, holders: { tick: 'box:77:ffffffffffff', sync: HOLDER, 'watch:factory': HOLDER } })
    expect(steps.map((step) => [step.done, step.detail])).toEqual([
      [true, '"factory" on #factory/, run by mini.local (pid 4242)'],
      [true, 'gh (github), synced by mini.local (pid 4242)'],
      [true, 'tick held by box (pid 77): a daemon or mu serve sends schedules'],
    ])
  })

  it("a sync the module declares and nobody runs is to do, and says to start the host", () => {
    const [, platform] = setup({ config: dir(), channel: 'factory', watchers: factory, sync: gh, holders: { 'watch:factory': HOLDER } })
    expect([platform!.done, platform!.detail, platform!.fix]).toEqual([false, 'gh (github) is declared, and nothing syncs it: no catch-up, nothing sent', "pnpm host   (node host.ts, in this folder, with the sync's secrets set)"])
  })

  it('a sync.json left in the config folder is not done: a daemon without a module would sync that instead', () => {
    const config = dir()
    writeFileSync(join(config, 'sync.json'), JSON.stringify({ gh: { type: 'github', secret: 'env:S' } }))
    const [, platform] = setup({ config, channel: 'factory', watchers: factory, sync: gh, holders: { sync: HOLDER } })
    expect(platform!.done).toBe(false)
    expect(platform!.fix).toBe(`move what ${tilde(join(config, 'sync.json'))} lists into lib/board.ts, and delete it`)
  })

  it('a watcher of the same name left in watchers.json is not done, since the host refuses to run both', () => {
    const config = dir()
    writeFileSync(join(config, 'watchers.json'), JSON.stringify({ watchers: [{ name: 'factory', tail: { channel: 'factory/' }, run: ['./wake.sh', '{thread}'] }] }))
    const [watcher] = setup({ config, channel: 'factory', watchers: factory, sync: gh, holders: { 'watch:factory': HOLDER } })
    expect(watcher!.done).toBe(false)
    expect(watcher!.fix).toBe(`remove "factory" from ${tilde(join(config, 'watchers.json'))}`)
  })

  it('with no sync declared, hearing from a platform is optional, and paths and holders read as people write them', () => {
    const [, none] = setup({ config: dir(), channel: 'factory', watchers: factory, sync: [], holders: {} })
    expect([none!.done, none!.fix]).toEqual([false, "optional: declare one in lib/board.ts's sync, and point the platform's webhook at /api/board/webhooks/<key>"])
    expect([tilde(homedir()), tilde(`${homedir()}x/y`), tilde('/etc/muster')]).toEqual(['~', `${homedir()}x/y`, '/etc/muster'])
    expect(holderName('not-a-holder')).toBe('not-a-holder')
  })
})
