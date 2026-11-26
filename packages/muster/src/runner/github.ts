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

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BRANCH_NAME = /^(?!-)(?!HEAD$)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/**
 * Where a task's work stands on GitHub, read from this machine before its sandbox starts: the repository's
 * default branch, which a pull request is opened against, and the commit `branch` is at, or null when there
 * is no such branch yet. A task worked before carries on from that commit rather than from the default branch,
 * so a second round adds to the first instead of replacing it.
 */
export async function branchState(options: { repo: { slug: string }; token: string; branch: string; api?: string; fetch?: typeof fetch }): Promise<{ defaultBranch: string; head: string | null }> {
  const doFetch = options.fetch ?? fetch
  const api = (options.api ?? 'https://api.github.com').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'user-agent': 'muster', 'x-github-api-version': '2022-11-28' }
  const failed = (what: string) => new Failure('push_failed', `Reading ${what} of ${options.repo.slug} on GitHub failed, so the run wasn't started.`, { hint: 'The GitHub App needs Contents: read on the repository.' })
  const repo = await doFetch(`${api}/repos/${options.repo.slug}`, { headers, signal: AbortSignal.timeout(30_000) }).catch(() => null)
  if (!repo?.ok) throw failed('the default branch')
  const defaultBranch = ((await repo.json().catch(() => null)) as { default_branch?: unknown } | null)?.default_branch
  if (typeof defaultBranch !== 'string' || !BRANCH_NAME.test(defaultBranch)) throw failed('the default branch')
  const ref = await doFetch(`${api}/repos/${options.repo.slug}/git/ref/heads/${options.branch.split('/').map(encodeURIComponent).join('/')}`, { headers, signal: AbortSignal.timeout(30_000) }).catch(() => null)
  if (ref?.status === 404) return { defaultBranch, head: null }
  if (!ref?.ok) throw failed(options.branch)
  const head = (await ref.json().catch(() => null)) as { ref?: unknown; object?: { sha?: unknown } } | null
  // A ref that isn't exactly this branch, or a commit ID that isn't one, is no answer.
  if (head?.ref !== `refs/heads/${options.branch}` || typeof head.object?.sha !== 'string' || !COMMIT.test(head.object.sha)) throw failed(options.branch)
  return { defaultBranch, head: head.object.sha }
}

/** The most a sandbox's changes may weigh, as a bundle. */
export const BUNDLE_MAX = 50 * 1024 * 1024

/**
 * Run in the sandbox, under a policy that reaches nothing: commits what the agent left on top of where
 * the checkout started and writes it as a git bundle to `$MU_OUT`. Git runs without hooks, an fsmonitor,
 * or any system or global config, though what it makes is data either way: the push is made elsewhere,
 * and the bundle is read with a limit of this side's. It prints `unchanged` or `bundle`.
 */
export const BUNDLE = `set -e
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name="$MU_NAME" -c user.email="$MU_EMAIL" "$@"; }
g add -A
if ! g diff --cached --quiet; then g commit -q --no-verify -m "$MU_TITLE" -m "$MU_BODY"; fi
if [ "$(g rev-parse HEAD)" = "$MU_BASE" ]; then echo unchanged; exit 0; fi
rm -f "$MU_OUT"
g bundle create "$MU_OUT" "$MU_BASE..HEAD" >/dev/null 2>&1
echo bundle`

const run = promisify(execFile)

/**
 * Pushes a sandbox's bundle to `branch` from this machine, in a repository made for it that has never
 * held anything the agent wrote but the bundle: the commit it started from is fetched, the bundle is
 * checked against it and fetched, and the result pushed. The token reaches git through its environment,
 * not its arguments, so no process listing shows it.
 *
 * The push only moves the branch from where it was when the run started (`expect`, or no branch at all when
 * that is null) to a commit that carries on from `base`: a branch someone moved in the meantime, or a change
 * that doesn't build on where its checkout started, is refused (`push_conflict`) and nothing is overwritten.
 */
/** How much of what git and the remote said about a push that failed is passed on: its last lines, up to this many characters. */
const PUSH_SAID_LINES = 12
const PUSH_SAID_MAX = 800

export async function pushBundle(options: { repo: { slug: string }; token: string; bundle: Buffer; base: string; branch: string; expect: string | null; remote?: string }): Promise<void> {
  // Each of these reaches git as an argument: none may look like an option, and the bundle is held to its size here too.
  if (!COMMIT.test(options.base)) throw new Failure('push_failed', "The commit the checkout started from isn't a commit ID.")
  if (options.expect !== null && !COMMIT.test(options.expect)) throw new Failure('push_failed', `Where ${options.branch} was when the run started isn't a commit ID.`)
  if (!/^mu\/task-\d+$/.test(options.branch)) throw new Failure('push_failed', `${options.branch} isn't a branch mu run pushes.`)
  if (options.bundle.length > BUNDLE_MAX) throw new Failure('push_failed', `The agent's changes are over ${BUNDLE_MAX / 1024 / 1024} MB as a bundle: nothing was pushed.`)
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
    await git('fetch', '-q', '--depth=1', '--end-of-options', remote, options.base)
    await writeFile(join(dir, 'mu.bundle'), options.bundle)
    // The change builds on where the checkout started, or it would drop what was on the branch before it: a bundle
    // that needs commits other than that one doesn't verify here, and one that does must lead on from it.
    const notBuilt = () => new Failure('push_conflict', `The agent's change doesn't build on the commit its checkout started from, so ${options.branch} was left as it was.`, { hint: 'Read the task thread, then run the task again.' })
    if (!(await git('bundle', 'verify', '-q', join(dir, 'mu.bundle')).then(() => true, () => false))) throw notBuilt()
    await git('fetch', '-q', '--end-of-options', join(dir, 'mu.bundle'), 'HEAD:refs/mu/head')
    if (!(await git('merge-base', '--is-ancestor', options.base, 'refs/mu/head').then(() => true, () => false))) throw notBuilt()
    // Moved only from where it was when the run started: an empty expectation means it must not exist yet.
    await git('push', '-q', `--force-with-lease=refs/heads/${options.branch}:${options.expect ?? ''}`, '--end-of-options', remote, `refs/mu/head:refs/heads/${options.branch}`)
  } catch (error) {
    if (error instanceof Failure) throw error
    // What the remote said and what git made of it, whole: the line that says why a push was refused comes before
    // git's last ones, and can run over several. Cut only where it would be longer than a reply should carry.
    const said = String((error as { stderr?: string }).stderr ?? (error as Error).message)
      .replaceAll(options.token, '[REDACTED]')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-PUSH_SAID_LINES)
      .join(' ')
      .slice(0, PUSH_SAID_MAX)
    if (/stale info|\[rejected\]|non-fast-forward|fetch first|already exists/.test(said)) {
      throw new Failure('push_conflict', `${options.branch} moved on GitHub while the agent worked, so it was left as it was: ${said}`, { hint: 'Read the branch and the task thread, then run the task again: it starts from where the branch is now.' })
    }
    // The permission is named only when GitHub says access was refused: any other refusal says its own reason.
    const denied = /Permission to .* denied|returned error: 403|not accessible by integration|Write access to repository not granted/i.test(said)
    throw new Failure('push_failed', `Pushing ${options.branch} failed: ${said}`, denied ? { hint: 'The token needs Contents: write on the repository.' } : {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
