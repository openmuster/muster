import { describe, expect, it } from 'vitest'
import { claude, vercel } from '../src/index.ts'
import type { VercelRule } from '../src/runner/cloud.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE, BUNDLE_MAX, gitRules, githubRepo, openPullRequest, pushBundle } from '../src/runner/github.ts'
import { tempDir } from './helpers.ts'

/** What Vercel Sandbox's proxy does with one request under these rules: the first that matches handles it. */
function proxy(rules: Record<string, VercelRule[]>, request: { url: string; method: string }): { headers: Record<string, string> } | { status: number } | 'unreachable' {
  const url = new URL(request.url)
  const list = rules[url.host] ?? rules['*']
  if (!list) return 'unreachable'
  // The path as sent, before any normalising, without its query, as the proxy matches it.
  const path = request.url.slice(request.url.indexOf(url.host) + url.host.length).split('?')[0]!
  for (const rule of list) {
    const match = 'match' in rule ? rule.match : undefined
    if (match?.method && !match.method.includes(request.method)) continue
    if (match?.path && !new RegExp(match.path.regex).test(path)) continue
    return 'transform' in rule ? { headers: Object.assign({}, ...rule.transform.map((step) => step.headers)) } : { status: rule.response.statusCode }
  }
  return { headers: {} }
}

const repo = { owner: 'acme', name: 'web', slug: 'acme/web' }
const auth = `Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`

describe('GitHub in a sandbox', () => {
  it('reads a github.com repository from its clone address, and nothing else as one', () => {
    expect(githubRepo('https://github.com/acme/web.git')).toEqual(repo)
    expect(githubRepo('https://github.com/acme/web')).toEqual(repo)
    for (const other of ['https://gitlab.com/acme/web.git', 'http://github.com/acme/web.git', 'https://github.com/acme', 'https://github.com/acme/web/tree/main', 'https://github.com/acme/..', 'not a url']) expect(githubRepo(other)).toBeNull()
  })

  it('the token goes on this repository\'s git fetch routes alone, and never on a push', () => {
    const rules = gitRules(repo, 'ghp_secret')
    const at = (path: string) => `https://github.com${path}`
    expect(proxy(rules, { url: at('/acme/web.git/info/refs?service=git-upload-pack'), method: 'GET' })).toEqual({ headers: { authorization: auth, host: 'github.com' } })
    expect(proxy(rules, { url: at('/acme/web.git/git-upload-pack'), method: 'POST' })).toEqual({ headers: { authorization: auth, host: 'github.com' } })
    expect(proxy(rules, { url: at('/acme/web/git-upload-pack'), method: 'POST' })).toMatchObject({ headers: { authorization: auth } })
    // A path can't say which branch a push writes, so no push is ever let through: pushes are made from this machine.
    expect(proxy(rules, { url: at('/acme/web.git/git-receive-pack'), method: 'POST' })).toEqual({ status: 403 })
    // Never another repository, a page, or a path written to look like this one's.
    for (const path of ['/acme/other.git/git-upload-pack', '/acme/web.git.evil/git-upload-pack', '/acme/web/../../acme/other.git/git-upload-pack', '/acme/web.git/%2e%2e/x/git-upload-pack', '/acme/web/settings', '/acme/web.git/git-upload-pack/x', '/login']) {
      expect(proxy(rules, { url: at(path), method: 'POST' })).toEqual({ status: 403 })
    }
    // Nor GitHub's API, or any other host.
    expect(proxy(rules, { url: 'https://api.github.com/repos/acme/web/pulls', method: 'POST' })).toBe('unreachable')
  })

  it('vercel: the token is in the policy only while the repository is cloned, and never in the agent\'s', async () => {
    const policies: any[] = []
    const sha = 'a'.repeat(40)
    const made = { name: 'sbx-gh', runCommand: async () => ({ exitCode: 0, stdout: async () => `${sha}\nmain` }), update: async (options: any) => void policies.push(options.networkPolicy), stop: async () => {} }
    const run = await vercel({ Sandbox: { create: async (options: any) => (policies.push(options.networkPolicy), made) }, setupHosts: ['objects.githubusercontent.com'] }).start({
      task: 7,
      agent: claude,
      prompt: '',
      board: { url: 'https://board.example.com/api/board', token: 'mu1.secret' },
      repo: 'https://github.com/acme/web.git',
      install: true,
      github: { token: 'ghp_secret' },
      setup: [['npm', 'install', '-g', 'https://example.com/muster.tgz']],
    })
    // Made with the token, to read this repository; then the install's open policy, without it; then the agent's, without it.
    expect(JSON.stringify(policies[0])).toContain(auth)
    expect(policies[0].allow['*']).toBeUndefined()
    expect(policies[1]).toEqual({ allow: { '*': [] } })
    expect(JSON.stringify(policies.slice(1))).not.toContain(auth)
    expect(Object.keys(policies.at(-1).allow)).toEqual(['board.example.com'])
    expect(run.checkout).toEqual({ sha, branch: 'main' })
  })

  it('opens the pull request from here, or answers with the one already open for the branch', async () => {
    const asked: { url: string; method: string; auth: string | null; body: any }[] = []
    let answer = 201
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
      if (init?.method === 'POST') return answer === 201 ? Response.json({ html_url: 'https://github.com/acme/web/pull/5' }, { status: 201 }) : new Response('{}', { status: answer })
      return Response.json([{ html_url: 'https://github.com/acme/web/pull/4' }])
    }) as typeof fetch
    const options = { repo, token: 'ghp_secret', head: 'mu/task-12', base: 'main', title: 'Fix the login redirect', body: 'Task #12', fetch: fetcher }
    expect(await openPullRequest(options)).toBe('https://github.com/acme/web/pull/5')
    expect(asked[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/web/pulls', method: 'POST', auth: 'Bearer ghp_secret', body: { head: 'mu/task-12', base: 'main', title: 'Fix the login redirect' } })
    answer = 422
    expect(await openPullRequest(options)).toBe('https://github.com/acme/web/pull/4')
    expect(asked.at(-1)!.url).toBe('https://api.github.com/repos/acme/web/pulls?state=open&head=acme%3Amu%2Ftask-12')
    answer = 403
    expect(await openPullRequest(options).catch((error) => error.reason)).toBe('pull_request_failed')
  })

  it('reads the agent\'s changes out as a bundle without running the hooks or config it left, and the bundle pushes from here', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' }).trim()
    const origin = tempDir()
    git(origin, 'init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'a.txt'), 'one\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', 'base')
    const base = git(origin, 'rev-parse', 'HEAD')
    const remote = join(tempDir(), 'web.git')
    execFileSync('git', ['clone', '-q', '--bare', origin, remote])
    // The sandbox's checkout, after an agent: a change, and a hook and an fsmonitor of its own.
    const checkout = tempDir()
    execFileSync('git', ['clone', '-q', remote, checkout])
    writeFileSync(join(checkout, 'a.txt'), 'two\n')
    const marker = join(tempDir(), 'ran')
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
      writeFileSync(join(checkout, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`)
      chmodSync(join(checkout, '.git', 'hooks', hook), 0o755)
    }
    writeFileSync(join(checkout, 'monitor.sh'), `#!/bin/sh\necho fsmonitor >> ${marker}\n`)
    chmodSync(join(checkout, 'monitor.sh'), 0o755)
    git(checkout, 'config', 'core.fsmonitor', join(checkout, 'monitor.sh'))
    const file = join(tempDir(), 'mu.bundle')
    const out = execFileSync('sh', ['-c', BUNDLE], { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tempDir(), MU_OUT: file, MU_BASE: base, MU_TITLE: 'the fix', MU_BODY: 'Task #12', MU_NAME: 'fixer', MU_EMAIL: 'fixer@users.noreply.github.com' } })
    expect(out.trim()).toBe('bundle')
    expect(existsSync(marker)).toBe(false)
    const bundle = readFileSync(file)
    // What reaches git here as an argument can't be an option, and the bundle is held to its size here too.
    expect(await pushBundle({ repo, token: 'ghp_secret', bundle, base: '--upload-pack=touch /tmp/x', branch: 'mu/task-12', expect: null, remote }).catch((error) => error.reason)).toBe('push_failed')
    expect(await pushBundle({ repo, token: 'ghp_secret', bundle, base, branch: 'main', expect: null, remote }).catch((error) => error.reason)).toBe('push_failed')
    expect(await pushBundle({ repo, token: 'ghp_secret', bundle: Buffer.alloc(BUNDLE_MAX + 1), base, branch: 'mu/task-12', expect: null, remote }).catch((error) => error.reason)).toBe('push_failed')
    await pushBundle({ repo, token: 'ghp_secret', bundle, base, branch: 'mu/task-12', expect: null, remote })
    expect(execFileSync('git', ['-C', remote, 'show', 'refs/heads/mu/task-12:a.txt'], { encoding: 'utf8' })).toBe('two\n')
    expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%an %s', 'refs/heads/mu/task-12'], { encoding: 'utf8' }).trim()).toBe('fixer the fix')
    // main is as it was: the push writes the branch this machine names, and no other.
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(base)
    // Nothing changed: it says so, and makes no bundle.
    const clean = tempDir()
    execFileSync('git', ['clone', '-q', remote, clean])
    expect(execFileSync('sh', ['-c', BUNDLE], { cwd: clean, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tempDir(), MU_OUT: join(tempDir(), 'x.bundle'), MU_BASE: base, MU_TITLE: 't', MU_BODY: 'b', MU_NAME: 'n', MU_EMAIL: 'n@e' } }).trim()).toBe('unchanged')
  })

  it('a second round adds to the branch the first one pushed, and a branch that moved meanwhile is left as it is', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' }).trim()
    const origin = tempDir()
    git(origin, 'init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'a.txt'), 'one\n')
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', 'base')
    const remote = join(tempDir(), 'web.git')
    execFileSync('git', ['clone', '-q', '--bare', origin, remote])
    /** A sandbox's round: a checkout of `ref`, one file written, read out as a bundle. */
    const round = (ref: string, file: string) => {
      const checkout = tempDir()
      execFileSync('git', ['clone', '-q', '--branch', ref, remote, checkout])
      const start = git(checkout, 'rev-parse', 'HEAD')
      writeFileSync(join(checkout, file), `${file}\n`)
      const out = join(tempDir(), 'mu.bundle')
      execFileSync('sh', ['-c', BUNDLE], { cwd: checkout, env: { PATH: process.env.PATH, HOME: tempDir(), MU_OUT: out, MU_BASE: start, MU_TITLE: file, MU_BODY: 'Task #12', MU_NAME: 'fixer', MU_EMAIL: 'f@e' } })
      return { start, bundle: readFileSync(out) }
    }
    const push = (made: { start: string; bundle: Buffer }, expected: string | null) => pushBundle({ repo, token: 'ghp_secret', bundle: made.bundle, base: made.start, branch: 'mu/task-12', expect: expected, remote })
    // Round one starts from main and makes the branch.
    const first = round('main', 'one.txt')
    await push(first, null)
    const afterFirst = git(remote, 'rev-parse', 'refs/heads/mu/task-12')
    // Round two starts from the branch and adds to it: the first round's file is still there.
    const second = round('mu/task-12', 'two.txt')
    expect(second.start).toBe(afterFirst)
    await push(second, afterFirst)
    const files = git(remote, 'ls-tree', '--name-only', 'refs/heads/mu/task-12').split('\n')
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'one.txt', 'two.txt']))
    expect(git(remote, 'rev-list', '--count', 'main..refs/heads/mu/task-12')).toBe('2')
    // Someone pushes to the branch while round three works: round three's push is refused, and theirs stays.
    const third = round('mu/task-12', 'three.txt')
    const theirs = round('mu/task-12', 'theirs.txt')
    await push(theirs, third.start)
    const moved = git(remote, 'rev-parse', 'refs/heads/mu/task-12')
    expect(await push(third, third.start).catch((error) => error.reason)).toBe('push_conflict')
    expect(git(remote, 'rev-parse', 'refs/heads/mu/task-12')).toBe(moved)
    // A run that started from main while the branch already exists doesn't replace it either.
    const stale = round('main', 'stale.txt')
    expect(await push(stale, null).catch((error) => error.reason)).toBe('push_conflict')
    expect(git(remote, 'rev-parse', 'refs/heads/mu/task-12')).toBe(moved)
  })

  it('vercel: what a sandbox prints or hands back is read no further than this side\'s limits, and a checkout it describes oddly is not taken', async () => {
    const { Readable } = await import('node:stream')
    const sha = 'b'.repeat(40)
    let head = `${sha}\nmain`
    const made = {
      name: 'sbx-big',
      runCommand: async () => ({ exitCode: 0, logs: () => Readable.from([{ stream: 'stdout', data: head }, { stream: 'stdout', data: 'x'.repeat(200_000) }]) as any }),
      readFile: async () => Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
      update: async () => {},
      stop: async () => {},
    }
    const request = { task: 7, agent: claude, prompt: '', board: { url: 'https://board.example.com/api/board', token: 'mu1.secret' }, repo: 'https://github.com/acme/web.git' }
    const run = await vercel({ Sandbox: { create: async () => made } }).start(request)
    expect((await run.exec!({ cmd: 'sh', args: [] })).stdout.length).toBe(64 * 1024)
    expect(await run.readFile!('/tmp/x', 12)).toHaveLength(12)
    expect(await run.readFile!('/tmp/x', 11)).toBeNull()
    // A commit or branch that git could read as an option is no checkout at all.
    for (const odd of ['--upload-pack=x\nmain', `${sha}\n--force`, `${sha.slice(1)}\nmain`, `${sha}\na..b`]) {
      head = odd
      expect((await vercel({ Sandbox: { create: async () => made } }).start(request)).checkout).toBeUndefined()
    }
  })
})
