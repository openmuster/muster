import { Failure } from '../failure.ts'
import type { VercelRule } from './cloud.ts'

/** A repository on github.com, as `owner/name`, from its HTTPS clone address. Null when it isn't one. */
export function githubRepo(url: string): { owner: string; name: string; slug: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const owner = parts[0]!
  const name = parts[1]!.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null
  return { owner, name, slug: `${owner}/${name}` }
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A path a server could read as another, which no route of git's is: a dot segment, an encoded slash or dot, a backslash. */
const ODD_PATH: VercelRule = { match: { path: { regex: '(?:^|/)\\.\\.?(?:/|$)|%2[eEfF]|%5[cC]|\\\\' } }, response: { statusCode: 403 } } as VercelRule

/**
 * The rules that let a sandbox reach one repository over git's smart HTTP, with `token` added on the way
 * out: fetching, and with `push` pushing too. Nothing else on github.com gets the token, and nothing
 * else on it is reached at all: not another repository, not the web pages, not a path written to look
 * like this repository's (`/acme/web/../../acme/other`).
 */
export function gitRules(repo: { slug: string }, token: string, options: { push: boolean }): Record<string, VercelRule[]> {
  const base = `^/${escaped(repo.slug)}(?:\\.git)?`
  const auth = [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, host: 'github.com' } }]
  const services = options.push ? 'git-upload-pack|git-receive-pack' : 'git-upload-pack'
  return {
    'github.com': [
      ODD_PATH,
      // The service is named in the query on this one, and the query isn't part of the path: the POST below is what carries it out.
      { match: { path: { regex: `${base}/info/refs$` }, method: ['GET'] }, transform: auth },
      { match: { path: { regex: `${base}/(?:${services})$` }, method: ['POST'] }, transform: auth },
      { response: { statusCode: 403 } },
    ],
  }
}

/**
 * Opens a pull request from `head` into `base`, from this machine with the token as it is: the sandbox
 * never reaches GitHub's API. One already open for the branch is answered with its own address.
 */
export async function openPullRequest(options: {
  repo: { slug: string; owner: string }
  token: string
  head: string
  base: string
  title: string
  body: string
  api?: string
  fetch?: typeof fetch
}): Promise<string> {
  const doFetch = options.fetch ?? fetch
  const api = (options.api ?? 'https://api.github.com').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'muster', 'x-github-api-version': '2022-11-28' }
  const made = await doFetch(`${api}/repos/${options.repo.slug}/pulls`, { method: 'POST', headers, body: JSON.stringify({ title: options.title, body: options.body, head: options.head, base: options.base }), signal: AbortSignal.timeout(30_000) })
  if (made.ok) return ((await made.json()) as { html_url: string }).html_url
  if (made.status === 422) {
    const open = await doFetch(`${api}/repos/${options.repo.slug}/pulls?state=open&head=${encodeURIComponent(`${options.repo.owner}:${options.head}`)}`, { headers, signal: AbortSignal.timeout(30_000) })
    const [found] = open.ok ? ((await open.json()) as { html_url: string }[]) : []
    if (found) return found.html_url
  }
  throw new Failure('pull_request_failed', `GitHub didn't open a pull request for ${options.head}: HTTP ${made.status}.`, { hint: 'The branch is pushed: open one by hand. A 403 or 404 usually means the token may not write pull requests on this repository.' })
}
