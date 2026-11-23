import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
 * The rules that let a sandbox fetch one repository over git's smart HTTP, with `token` added on the way
 * out, to clone it. Never to push: a path can't say which branch a push writes, so pushes are made from
 * this machine. Nothing else on github.com gets the token, and nothing else on it is reached at all: not
 * another repository, not the web pages, not a path written to look like this one's (`/acme/web/../../acme/other`).
 */
export function gitRules(repo: { slug: string }, token: string): Record<string, VercelRule[]> {
  const base = `^/${escaped(repo.slug)}(?:\\.git)?`
  const auth = [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, host: 'github.com' } }]
  return {
    'github.com': [
      ODD_PATH,
      // The service is named in the query on this one, and the query isn't part of the path: the POST below is what carries it out.
      { match: { path: { regex: `${base}/info/refs$` }, method: ['GET'] }, transform: auth },
      { match: { path: { regex: `${base}/git-upload-pack$` }, method: ['POST'] }, transform: auth },
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

/** The most a sandbox's changes may weigh, as a bundle. */
export const BUNDLE_MAX = 50 * 1024 * 1024

/**
 * Run in the sandbox, under a policy that reaches nothing: commits what the agent left on top of where
 * the checkout started and prints it as a git bundle, in base64. Git runs without hooks, an fsmonitor, or
 * any system or global config, though what it prints is data either way: the push is made elsewhere.
 * Its first line says `unchanged`, `too-big`, or `bundle` with the bundle on the next.
 */
export const BUNDLE = `set -e
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name="$MU_NAME" -c user.email="$MU_EMAIL" "$@"; }
g add -A
if ! g diff --cached --quiet; then g commit -q --no-verify -m "$MU_TITLE" -m "$MU_BODY"; fi
if [ "$(g rev-parse HEAD)" = "$MU_BASE" ]; then echo unchanged; exit 0; fi
out="\${TMPDIR:-/tmp}/mu.bundle"
g bundle create "$out" "$MU_BASE..HEAD" >/dev/null 2>&1
if [ "$(wc -c < "$out")" -gt ${BUNDLE_MAX} ]; then echo too-big; exit 0; fi
echo bundle
base64 < "$out" | tr -d '\\n'
echo`

const run = promisify(execFile)

/**
 * Pushes a sandbox's bundle to `branch` from this machine, in a repository made for it that has never
 * held anything the agent wrote but the bundle: the commit it started from is fetched, the bundle is
 * checked against it and fetched, and the result pushed. The token reaches git through its environment,
 * not its arguments, so no process listing shows it.
 */
export async function pushBundle(options: { repo: { slug: string }; token: string; bundle: Buffer; base: string; branch: string; remote?: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mu-push-'))
  const remote = options.remote ?? `https://github.com/${options.repo.slug}.git`
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
  }
  const git = (...args: string[]) => run('git', ['-C', dir, ...args], { env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
  try {
    await git('init', '-q', '--bare')
    await git('fetch', '-q', '--depth=1', remote, options.base)
    await writeFile(join(dir, 'mu.bundle'), options.bundle)
    await git('bundle', 'verify', '-q', join(dir, 'mu.bundle'))
    await git('fetch', '-q', join(dir, 'mu.bundle'), 'HEAD:refs/mu/head')
    await git('push', '-q', '-f', remote, `refs/mu/head:refs/heads/${options.branch}`)
  } catch (error) {
    const said = String((error as { stderr?: string }).stderr ?? (error as Error).message).replaceAll(options.token, '[REDACTED]').trim().split('\n').slice(-2).join(' ')
    throw new Failure('push_failed', `Pushing ${options.branch} failed: ${said}`, { hint: 'The token needs Contents: write on the repository.' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
