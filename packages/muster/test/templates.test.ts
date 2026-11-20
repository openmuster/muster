import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadWatchers } from '../src/daemon/daemon.ts'
import { loadSync } from '../src/index.ts'
import { tempDir } from './helpers.ts'

const factory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/factory')

describe('the factory template', () => {
  it('its watcher and sync files are ones the daemon loads, with the secret named and not written', () => {
    expect(loadWatchers(join(factory, 'watchers.json'))).toEqual([{ name: 'factory', tail: { channel: 'factory/', types: ['message.posted'] }, run: ['./wake.sh', '{thread}'], as: 'factory', every: 30 }])
    expect(Object.keys(loadSync(join(factory, 'sync.json'), { GITHUB_WEBHOOK_SECRET: 's' }))).toEqual(['gh'])
    expect(readFileSync(join(factory, 'sync.json'), 'utf8')).toContain('"env:GITHUB_WEBHOOK_SECRET"')
  })

  it('wake.sh hands the agent its instructions and a pointer to the thread on stdin, and nothing from the thread', () => {
    const dir = tempDir()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'agent'), `#!/bin/sh\ncat > ${dir}/prompt.txt\n`)
    chmodSync(join(bin, 'agent'), 0o755)
    execFileSync(join(factory, 'wake.sh'), ['812'], { env: { PATH: `${bin}:${process.env.PATH}`, FACTORY_AGENT: 'agent' } })
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8')
    expect(prompt).toContain('you write under the\nname `factory`')
    expect(prompt).toContain('Thread 812 changed. Open it with: mu read 812')
  })
})
