import { describe, expect, it } from 'vitest'
import { claude, vercel } from '../src/index.ts'
import type { VercelRule } from '../src/runner/cloud.ts'
import { gitRules, githubRepo, openPullRequest } from '../src/runner/github.ts'

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

  it('the token goes on this repository\'s git routes alone: fetching, and pushing only when asked', () => {
    const read = gitRules(repo, 'ghp_secret', { push: false })
    const write = gitRules(repo, 'ghp_secret', { push: true })
    const at = (path: string) => `https://github.com${path}`
    for (const rules of [read, write]) {
      expect(proxy(rules, { url: at('/acme/web.git/info/refs?service=git-upload-pack'), method: 'GET' })).toEqual({ headers: { authorization: auth, host: 'github.com' } })
      expect(proxy(rules, { url: at('/acme/web.git/git-upload-pack'), method: 'POST' })).toEqual({ headers: { authorization: auth, host: 'github.com' } })
      expect(proxy(rules, { url: at('/acme/web/git-upload-pack'), method: 'POST' })).toMatchObject({ headers: { authorization: auth } })
    }
    expect(proxy(read, { url: at('/acme/web.git/git-receive-pack'), method: 'POST' })).toEqual({ status: 403 })
    expect(proxy(write, { url: at('/acme/web.git/git-receive-pack'), method: 'POST' })).toMatchObject({ headers: { authorization: auth } })
    // Never another repository, a page, or a path written to look like this one's.
    for (const path of ['/acme/other.git/git-receive-pack', '/acme/web.git.evil/git-receive-pack', '/acme/web/../../acme/other.git/git-receive-pack', '/acme/web.git/%2e%2e/x/git-receive-pack', '/acme/web/settings', '/acme/web.git/git-receive-pack/x', '/login']) {
      expect(proxy(write, { url: at(path), method: 'POST' })).toEqual({ status: 403 })
    }
    // Nor GitHub's API, or any other host.
    expect(proxy(write, { url: 'https://api.github.com/repos/acme/web/pulls', method: 'POST' })).toBe('unreachable')
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
    expect(proxy(policies[0].allow, { url: 'https://github.com/acme/web.git/git-receive-pack', method: 'POST' })).toEqual({ status: 403 })
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
})
