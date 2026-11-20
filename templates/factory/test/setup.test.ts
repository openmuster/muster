import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setup } from '../lib/setup.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'factory-test-'))

describe('setup', () => {
  it('with nothing configured, every step is to do and says what to run', () => {
    const config = dir()
    const steps = setup({ config, board: join(config, 'main.db'), channel: 'factory' })
    expect(steps.map((step) => step.done)).toEqual([false, false, false])
    expect(steps.every((step) => typeof step.fix === 'string')).toBe(true)
  })

  it('finds the watcher on the factory channel, the platforms, and a running ticker', () => {
    const config = dir()
    const wake = join(config, 'wake.sh')
    writeFileSync(wake, '#!/bin/sh\n')
    writeFileSync(join(config, 'watchers.json'), JSON.stringify({ watchers: [{ name: 'other', tail: { channel: 'elsewhere/' }, run: ['x'] }, { name: 'factory', tail: { channel: 'factory/' }, run: [wake, '{thread}'] }] }))
    writeFileSync(join(config, 'sync.json'), JSON.stringify({ gh: { type: 'github', secret: 'env:S' } }))
    writeFileSync(join(config, 'main.db.tick.lock'), '{}')
    const steps = setup({ config, board: join(config, 'main.db'), channel: 'factory' })
    expect(steps.map((step) => [step.done, step.detail])).toEqual([[true, '"factory" on #factory/'], [true, 'gh (github)'], [true, 'a daemon or mu serve is running for this board']])
  })

  it('a watcher whose command is not there is not done, and says which', () => {
    const config = dir()
    writeFileSync(join(config, 'watchers.json'), JSON.stringify({ watchers: [{ name: 'factory', tail: { channel: 'factory/' }, run: ['/no/such/wake.sh'] }] }))
    const [watcher] = setup({ config, board: join(config, 'main.db'), channel: 'factory' })
    expect([watcher!.done, watcher!.detail]).toEqual([false, '"factory" runs /no/such/wake.sh, which isn\'t there'])
  })
})
