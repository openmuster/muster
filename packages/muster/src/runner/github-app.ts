import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Failure } from '../failure.ts'

/** A GitHub App, as this machine holds it: its ID and its private key. Neither ever goes into a sandbox. */
export type GithubApp = { id: string; key: KeyObject }

/** What an installation token may do on the one repository it is made for. */
export type Permissions = Partial<Record<'contents' | 'pull_requests' | 'metadata', 'read' | 'write'>>

/**
 * The App from the environment: `GITHUB_APP_ID`, and its private key in `GITHUB_APP_KEY_FILE` (a path)
 * or `GITHUB_APP_PRIVATE_KEY` (the PEM itself). Undefined when none of them is set; half of them is a
 * config error, said before anything starts.
 */
export function githubApp(env: NodeJS.ProcessEnv): GithubApp | undefined {
  const id = env.GITHUB_APP_ID
  const file = env.GITHUB_APP_KEY_FILE
  const pem = env.GITHUB_APP_PRIVATE_KEY
  if (!id && !file && !pem) return undefined
  if (!id || !/^\d+$/.test(id)) throw new Failure('runner_not_configured', 'GITHUB_APP_ID is the GitHub App\'s numeric ID, and it isn\'t set.', { hint: "It's on the App's settings page, as App ID." })
  if (!file && !pem) throw new Failure('runner_not_configured', 'The GitHub App needs its private key: GITHUB_APP_KEY_FILE (a path to the .pem) or GITHUB_APP_PRIVATE_KEY.')
  let text: string
  try {
    text = pem ?? readFileSync(file!, 'utf8')
  } catch (error) {
    throw new Failure('runner_not_configured', `GITHUB_APP_KEY_FILE can't be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`)
  }
  try {
    return { id, key: createPrivateKey(text.replace(/\\n/g, '\n')) }
  } catch {
    throw new Failure('runner_not_configured', "The GitHub App's private key isn't a PEM key.", { hint: 'Generate one on the App\'s settings page, under Private keys.' })
  }
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

/** The App's own JWT, for asking GitHub about its installations: ten minutes at most, a minute early for clock drift. */
export function appJwt(app: GithubApp, now: number = Date.now()): string {
  const at = Math.floor(now / 1000)
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ iat: at - 60, exp: at + 9 * 60, iss: app.id }))
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(app.key)
  return `${head}.${body}.${base64url(signature)}`
}

/**
 * A token for one repository, from the App's installation on it: no other repository, only `permissions`,
 * gone within the hour. GitHub refuses one the installation can't give, so the App needs at least these.
 */
export async function installationToken(app: GithubApp, repo: { owner: string; name: string; slug: string }, permissions: Permissions, options: { api?: string; fetch?: typeof fetch; now?: number } = {}): Promise<{ token: string; expiresAt: string }> {
  const doFetch = options.fetch ?? fetch
  const api = (options.api ?? 'https://api.github.com').replace(/\/$/, '')
  const headers = { authorization: `Bearer ${appJwt(app, options.now)}`, accept: 'application/vnd.github+json', 'user-agent': 'muster', 'x-github-api-version': '2022-11-28' }
  const found = await doFetch(`${api}/repos/${repo.slug}/installation`, { headers, signal: AbortSignal.timeout(30_000) })
  if (found.status === 404) throw new Failure('github_app_not_installed', `The GitHub App ${app.id} isn't installed on ${repo.slug}.`, { hint: `Install it on that repository from the App's page, with ${Object.entries(permissions).map(([name, level]) => `${name}: ${level}`).join(', ')}.` })
  if (!found.ok) throw new Failure('github_app_failed', `GitHub didn't say where the App is installed on ${repo.slug}: HTTP ${found.status}.`, { hint: found.status === 401 ? 'GITHUB_APP_ID and the private key may not belong together, or this clock is off.' : undefined })
  const { id } = (await found.json()) as { id: number }
  const made = await doFetch(`${api}/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [repo.name], permissions }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!made.ok) throw new Failure('github_app_failed', `GitHub didn't make a token for ${repo.slug}: HTTP ${made.status}.`, { hint: made.status === 422 || made.status === 403 ? `The App needs ${Object.entries(permissions).map(([name, level]) => `${name}: ${level}`).join(', ')} on that repository.` : undefined })
  const { token, expires_at: expiresAt } = (await made.json()) as { token: string; expires_at: string }
  return { token, expiresAt }
}
