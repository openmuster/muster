import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadWatchers } from '../src/daemon/daemon.ts'
import { loadSync } from '../src/index.ts'
import { tempDir } from './helpers.ts'

import { authorized } from '../../../templates/cloudflare-runner/src/auth.ts'
import { boardHeaders, modelPasses, repoPasses, repoProps } from '../../../templates/cloudflare-runner/src/gates.ts'
import { boardPolicy } from '../src/runner/policy.ts'
import { claude } from '../src/runner/agents.ts'

const factory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/factory')

describe('the cloudflare runner template', () => {
  it('starts nothing for a request without its secret, least of all when no secret was ever set', async () => {
    const secret = 'a-long-random-secret-0123456789'
    expect(await authorized(`Bearer ${secret}`, secret)).toBe(true)
    expect(await authorized(`Bearer ${secret}x`, secret)).toBe(false)
    expect(await authorized(`bearer ${secret}`, secret)).toBe(false)
    expect(await authorized(secret, secret)).toBe(false)
    expect(await authorized(null, secret)).toBe(false)
    // A Worker deployed before `wrangler secret put`: the text an unset secret would have made is no key.
    expect(await authorized('Bearer undefined', undefined)).toBe(false)
    expect(await authorized('Bearer ', '')).toBe(false)
    expect(await authorized('Bearer null', null)).toBe(false)
    expect(await authorized('Bearer short', 'short')).toBe(false)
  })
})

describe('the cloudflare runner gates', () => {
  // What cloudflare() sends the Worker, from the same policy the Vercel runner uses.
  const url = 'https://board.example.com/api/board'
  const { networkPolicy } = boardPolicy({ url, token: 'tok-123' })
  const board = { host: 'board.example.com', rules: networkPolicy.allow['board.example.com']!, token: 'tok-123' }

  it("adds the token to the board's own routes, and to nothing else", () => {
    expect(boardHeaders({ url: `${url}/post`, method: 'POST' }, board)).toEqual({ authorization: 'Bearer tok-123' })
    expect(boardHeaders({ url: `${url}/whoami`, method: 'GET' }, board)).toEqual({ authorization: 'Bearer tok-123' })
    expect(boardHeaders({ url: `${url}/post`, method: 'GET' }, board)).toBeNull()
    // Closed to a sandbox: it starts work beyond it.
    expect(boardHeaders({ url: `${url}/workflowRequest`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: `${url}/../admin/post`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: `${url}/x%2fpost`, method: 'POST' }, board)).toBeNull()
    expect(boardHeaders({ url: 'http://board.example.com/api/board/post', method: 'POST' }, board)).toBeNull()
    // The Host header is the container's to write: another host gets nothing, whatever the TLS name was.
    expect(boardHeaders({ url: 'https://evil.example.com/api/board/post', method: 'POST' }, board)).toBeNull()
  })

  it("lets the model's calls through and none of the key's other uses", () => {
    const anthropic = claude.model!
    const model = { host: anthropic.host, paths: anthropic.paths, headers: anthropic.headers('k') }
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' }, model)).toBe(true)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST' }, model)).toBe(true)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/files', method: 'POST' }, model)).toBe(false)
    expect(modelPasses({ url: 'https://api.anthropic.com/v1/messages', method: 'GET' }, model)).toBe(false)
    expect(modelPasses({ url: 'https://example.com/v1/messages', method: 'POST' }, model)).toBe(false)
  })

  it('lets git clone read the one repository, and nothing else on its host', () => {
    const repo = repoProps('https://github.com/acme/web.git')
    expect(repoPasses({ url: 'https://github.com/acme/web.git/info/refs?service=git-upload-pack', method: 'GET' }, repo)).toBe(true)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/git-upload-pack', method: 'POST' }, repo)).toBe(true)
    expect(repoPasses({ url: 'https://github.com/acme/web/info/refs?service=git-upload-pack', method: 'GET' }, repo)).toBe(true)
    // Pushing, another repository, a page of the site.
    expect(repoPasses({ url: 'https://github.com/acme/web.git/info/refs?service=git-receive-pack', method: 'GET' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/git-receive-pack', method: 'POST' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/other.git/git-upload-pack', method: 'POST' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web', method: 'GET' }, repo)).toBe(false)
    expect(repoPasses({ url: 'https://github.com/acme/web.git/../other.git/git-upload-pack', method: 'POST' }, repo)).toBe(false)
    expect(() => repoProps('https://x:tok@github.com/acme/web.git')).toThrow()
    expect(() => repoProps('http://github.com/acme/web.git')).toThrow()
  })
})

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
