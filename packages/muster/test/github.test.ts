import { describe, expect, it } from 'vitest'
import { claude, vercel } from '../src/index.ts'
import type { VercelRule } from '../src/runner/cloud.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE, gitRules, githubRepo, openPullRequest, pushBundle } from '../src/runner/github.ts'
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
    const made = { name: 'sbx-gh', runCommand: async () => ({ exitCode: 0, stdout: async () => 'abc123\nmain' }), update: async (options: any) => void policies.push(options.networkPolicy), stop: async () => {} }
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
    expect(run.checkout).toEqual({ sha: 'abc123', branch: 'main' })
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
    const out = execFileSync('sh', ['-c', BUNDLE], { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tempDir(), TMPDIR: tempDir(), MU_BASE: base, MU_TITLE: 'the fix', MU_BODY: 'Task #12', MU_NAME: 'fixer', MU_EMAIL: 'fixer@users.noreply.github.com' } })
    const [said, data] = out.split('\n')
    expect(said).toBe('bundle')
    expect(existsSync(marker)).toBe(false)
    await pushBundle({ repo, token: 'ghp_secret', bundle: Buffer.from(data!, 'base64'), base, branch: 'mu/task-12', remote })
    expect(execFileSync('git', ['-C', remote, 'show', 'refs/heads/mu/task-12:a.txt'], { encoding: 'utf8' })).toBe('two\n')
    expect(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%an %s', 'refs/heads/mu/task-12'], { encoding: 'utf8' }).trim()).toBe('fixer the fix')
    // main is as it was: the push writes the branch this machine names, and no other.
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(base)
    // Nothing changed: it says so, and makes no bundle.
    const clean = tempDir()
    execFileSync('git', ['clone', '-q', remote, clean])
    expect(execFileSync('sh', ['-c', BUNDLE], { cwd: clean, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tempDir(), MU_BASE: base, MU_TITLE: 't', MU_BODY: 'b', MU_NAME: 'n', MU_EMAIL: 'n@e' } }).trim()).toBe('unchanged')
  })
})
