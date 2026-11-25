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

  it('a watchers.json, sync.json or hooks.json left in the config folder means nothing ticks: mu daemon run and mu serve refuse to start', () => {
    const config = dir()
    writeFileSync(join(config, 'sync.json'), JSON.stringify({ gh: { type: 'github', secret: 'env:S' } }))
    const holders = { tick: HOLDER, sync: HOLDER, 'watch:factory': HOLDER }
    const [watcher, platform, served] = setup({ config, channel: 'factory', watchers: factory, sync: gh, holders })
    // The module's own host runs whatever is left there.
    expect([watcher!.done, platform!.done]).toEqual([true, true])
    expect([served!.done, served!.detail, served!.fix]).toEqual([
      false,
      `${tilde(join(config, 'sync.json'))} is left from before board modules: mu daemon run and mu serve refuse to start until it is moved and deleted`,
      'move what it lists into lib/board.ts (or your own board module), and delete it',
    ])
    writeFileSync(join(config, 'watchers.json'), '{}')
    const [, , both] = setup({ config, channel: 'factory', watchers: factory, sync: gh, holders })
    expect(both!.detail).toBe(`${tilde(join(config, 'watchers.json'))}, ${tilde(join(config, 'sync.json'))} are left from before board modules: mu daemon run and mu serve refuse to start until they are moved and deleted`)
  })

  it('with no sync declared, hearing from a platform is optional, and paths and holders read as people write them', () => {
    const [, none] = setup({ config: dir(), channel: 'factory', watchers: factory, sync: [], holders: {} })
    expect([none!.done, none!.fix]).toEqual([false, "optional: declare one in lib/board.ts's sync, and point the platform's webhook at /api/board/webhooks/<key>"])
    expect([tilde(homedir()), tilde(`${homedir()}x/y`), tilde('/etc/muster')]).toEqual(['~', `${homedir()}x/y`, '/etc/muster'])
    expect(holderName('not-a-holder')).toBe('not-a-holder')
  })
})
