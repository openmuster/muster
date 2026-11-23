import { createVerify, generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appJwt, githubApp, installationToken } from '../src/runner/github-app.ts'
import { tempDir } from './helpers.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const repo = { owner: 'acme', name: 'web', slug: 'acme/web' }

describe('a GitHub App', () => {
  it('is read from the environment, and half of one is a config error', () => {
    const file = join(tempDir(), 'app.pem')
    writeFileSync(file, pem)
    expect(githubApp({})).toBeUndefined()
    expect(githubApp({ GITHUB_APP_ID: '123', GITHUB_APP_KEY_FILE: file })!.id).toBe('123')
    // A key pasted into one line of an env file, with its newlines written as \n.
    expect(githubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') })!.id).toBe('123')
    const reason = (env: NodeJS.ProcessEnv) => {
      try {
        githubApp(env)
      } catch (error) {
        return (error as { reason: string }).reason
      }
      return 'read'
    }
    expect(reason({ GITHUB_APP_KEY_FILE: file })).toBe('runner_not_configured')
    expect(reason({ GITHUB_APP_ID: 'my-app', GITHUB_APP_KEY_FILE: file })).toBe('runner_not_configured')
    expect(reason({ GITHUB_APP_ID: '123' })).toBe('runner_not_configured')
    expect(reason({ GITHUB_APP_ID: '123', GITHUB_APP_KEY_FILE: join(tempDir(), 'missing.pem') })).toBe('runner_not_configured')
    expect(reason({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'not a key' })).toBe('runner_not_configured')
  })

  it('signs its JWT with its key: RS256, issued a minute early, gone within ten', () => {
    const app = githubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem })!
    const now = Date.parse('2026-11-23T12:00:00Z')
    const [head, body, signature] = appJwt(app, now).split('.')
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' })
    expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
  })

  it('mints a token for one repository with only the permissions asked, from the installation on it', async () => {
    const app = githubApp({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem })!
    const asked: { url: string; method: string; auth: string | null; body: any }[] = []
    let installed = true
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
      if (String(url).endsWith('/installation')) return installed ? Response.json({ id: 42 }) : new Response('{}', { status: 404 })
      return Response.json({ token: 'ghs_minted', expires_at: '2026-11-23T13:00:00Z' }, { status: 201 })
    }) as typeof fetch
    expect(await installationToken(app, repo, { contents: 'read' }, { fetch: fetcher })).toEqual({ token: 'ghs_minted', expiresAt: '2026-11-23T13:00:00Z' })
    expect(asked[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/web/installation', method: 'GET' })
    expect(asked[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(asked[1]).toMatchObject({ url: 'https://api.github.com/app/installations/42/access_tokens', method: 'POST', body: { repositories: ['web'], permissions: { contents: 'read' } } })
    installed = false
    expect(await installationToken(app, repo, { contents: 'read' }, { fetch: fetcher }).catch((error) => error.reason)).toBe('github_app_not_installed')
  })
})
