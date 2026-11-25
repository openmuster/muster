import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { board, type Board } from '../src/index.ts'

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url))

let browser: Browser
const servers: ChildProcess[] = []
// `next dev` rewrites a template's tsconfig.json as it starts. A test run leaves the template as it found it.
const restore: (() => void)[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  // Each dev server is its own process group, so the processes Next starts go with it.
  for (const server of servers) {
    try {
      process.kill(-server.pid!, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  for (const put of restore) put()
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

/**
 * A template as its README says to run it: `next dev`, on a board of the test's own. The test holds
 * the same board through the library, as a second process would, so it can write what an agent would.
 */
async function start(template: 'swarm' | 'factory', env: Record<string, string> = {}): Promise<{ url: string; team: Board; dir: string; page: Page; errors: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'muster-browser-'))
  const port = await freePort()
  const tsconfig = join(TEMPLATES, template, 'tsconfig.json')
  const before = readFileSync(tsconfig, 'utf8')
  restore.push(() => writeFileSync(tsconfig, before))
  let output = ''
  const server = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: join(TEMPLATES, template),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), NEXT_TELEMETRY_DISABLED: '1', ...env },
  })
  servers.push(server)
  server.stdout!.on('data', (chunk) => (output += chunk))
  server.stderr!.on('data', (chunk) => (output += chunk))
  const url = `http://127.0.0.1:${port}`
  const team = board({ dir: join(dir, 'board') })
  await team.post({ channel: 'general', text: 'board exists' })
  for (let tries = 0; ; tries++) {
    if (server.exitCode !== null || tries > 240) throw new Error(`next dev for ${template} didn't come up:\n${output}`)
    if (await fetch(url).then((response) => response.ok, () => false)) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { url, team, dir, page, errors }
}

const column = (page: Page, state: string) => page.locator('.col', { has: page.locator('.dim', { hasText: new RegExp(`^${state} \\d+$`) }) })

describe('the swarm template, in a browser', () => {
  it('launches a run from the form, starts its workers, and the live view follows the board', async () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'muster-browser-bin-'))
    const stub = join(stubDir, 'mu')
    const spawned = join(stubDir, 'spawned')
    // What the page starts instead of a real agent: it only notes how it was called.
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${spawned}\n`)
    chmodSync(stub, 0o755)
    const { url, team, page, errors } = await start('swarm', { MUSTER_BIN: stub })
    // The page has no sign-in, so it answers only for this machine: a request that came for another name is refused.
    expect([await statusAs(url, '/api/live', 'evil.example'), await statusAs(url, '/', 'evil.example'), await statusAs(url, '/api/live', new URL(url).host)]).toEqual([403, 403, 200])

    await page.goto(url)
    expect(await page.locator('h1').textContent()).toBe('swarm')
    await page.locator('p.dim', { hasText: 'none yet' }).waitFor()
    await page.locator('#goal').fill('Rate-limit the checkout endpoint')
    await page.locator('#slug').fill('checkout-limiter')
    await page.locator('#agents').fill('2')
    await page.locator('#cwd').fill(stubDir)
    await page.locator('button', { hasText: 'launch' }).click()
    await page.waitForURL(/\/live\?run=checkout-limiter$/)

    // The board has the run and its planning task, and each worker was started on that run's queue.
    const runs = await team.readChannel({ channel: 'swarm/runs' })
    expect(runs.threads.map((thread) => [thread.message.text, thread.message.labels.run])).toEqual([['run checkout-limiter: Rate-limit the checkout endpoint', 'checkout-limiter']])
    const [plan] = (await team.taskList({ channel: 'swarm/checkout-limiter' })).tasks
    expect(plan).toMatchObject({ state: 'ready', labels: { role: 'plan' } })
    await expect.poll(() => (existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n').sort() : [])).toEqual([
      `run --ready swarm/checkout-limiter --loop --wait 10m --cwd ${stubDir} --agent claude --as agent-1`,
      `run --ready swarm/checkout-limiter --loop --wait 10m --cwd ${stubDir} --agent claude --as agent-2`,
    ])

    // The live view shows it ready, then follows a claim and a result with no reload.
    await expect.poll(() => column(page, 'ready').locator('.task').count(), { timeout: 15_000 }).toBe(1)
    expect(await column(page, 'ready').locator('.task').textContent()).toContain(`#${plan!.id} Plan the work for this goal: Rate-limit the checkout endpoint`)
    const claim = await team.as('agent-1').taskClaim({ id: plan!.id })
    await expect.poll(() => column(page, 'claimed').locator('.task .dim').allTextContents(), { timeout: 10_000 }).toEqual([expect.stringMatching(/^agent-1 · \d+:\d\d left$/)])
    expect(await page.locator('h1 .dim').textContent()).toBe('· 1 working')
    await team.as('agent-1').taskComplete({ id: plan!.id, token: claim.token, result: 'queued 4 tasks' })
    await expect.poll(() => column(page, 'completed').locator('.task .dim').allTextContents(), { timeout: 10_000 }).toEqual(['queued 4 tasks'])
    expect(await column(page, 'claimed').locator('.task').count()).toBe(0)

    // Back on the launcher, the run is listed and links to its live view.
    await page.goto(url)
    expect(await page.locator('.task a').getAttribute('href')).toBe('/live?run=checkout-limiter')
    expect(errors).toEqual([])
    await page.close()
  }, 180_000)
})

/** A request under a Host of the caller's choosing, which fetch won't send: what a rebinding page's requests look like here. */
const statusAs = (url: string, path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    httpRequest(`${url}${path}`, { headers: { host } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

describe('the factory template, in a browser', () => {
  it('shows what is set up and what is not, lists threads, and a reply from the page is on the board as you', async () => {
    const { url, team, dir, page, errors } = await start('factory')
    expect([await statusAs(url, '/', 'evil.example'), await statusAs(url, '/', new URL(url).host)]).toEqual([403, 200])
    const issue = await team.as('triage').post({ channel: 'factory/intake', text: 'The login redirect goes to the wrong host\nSeen on staging.' })
    await team.taskCreate({ thread: issue.id })

    await page.goto(url)
    expect(await page.locator('h1').textContent()).toBe('factory')
    const watcher = page.locator('.item', { hasText: 'a watcher wakes the agent' }).first()
    expect(await watcher.textContent()).toBe('to do · a watcher wakes the agent"factory" on #factory/ is declared, and nothing runs itpnpm host   (node host.ts, in this folder)')
    const platform = page.locator('.item', { hasText: 'a platform to hear from' }).first()
    expect(await platform.textContent()).toMatch(/^to do · a platform to hear fromgh \(github\) is declared, and nothing syncs it/)
    // The template's host, on the same board: it takes the watcher's lease and the sync's, and the page names it.
    const host = spawn(process.execPath, ['host.ts'], { cwd: join(TEMPLATES, 'factory'), detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), FACTORY_AGENT: 'true', GITHUB_WEBHOOK_SECRET: 'gh-webhook-secret' } })
    servers.push(host)
    for (const role of ['watch:factory', 'sync']) await expect.poll(async () => (await team.backend.leases!.holder(role))?.holder ?? '', { timeout: 20_000 }).toContain(`:${host.pid}:`)
    await page.reload()
    expect(await watcher.textContent()).toMatch(new RegExp(`^done · a watcher wakes the agent"factory" on #factory/, run by .+ \\(pid ${host.pid}\\)$`))
    expect(await platform.textContent()).toMatch(new RegExp(`^done · a platform to hear fromgh \\(github\\), synced by .+ \\(pid ${host.pid}\\)$`))
    expect(await page.locator('h2', { hasText: 'recent threads' }).textContent()).toBe('recent threads: 1 · open tasks: 1')
    const link = page.locator('.item a', { hasText: 'The login redirect goes to the wrong host' })
    expect(await link.textContent()).toBe(`#${issue.id} The login redirect goes to the wrong host`)
    await link.click()
    await page.waitForURL(new RegExp(`/board\\?thread=${issue.id}$`))
    expect(await page.locator('.item .text').allTextContents()).toEqual(['The login redirect goes to the wrong host\nSeen on staging.'])

    await page.locator('textarea[name="text"]').fill('reproduced: the host comes from the Referer header')
    await page.locator('button', { hasText: 'reply' }).click()
    await expect.poll(() => page.locator('.item .text').allTextContents(), { timeout: 15_000 }).toEqual(['The login redirect goes to the wrong host\nSeen on staging.', 'reproduced: the host comes from the Referer header'])
    const thread = await team.readThread({ id: issue.id })
    expect(thread.replies.map((reply) => [reply.text, reply.by.profile])).toEqual([['reproduced: the host comes from the Referer header', null]])
    expect(errors).toEqual([])
    await page.close()
  }, 180_000)
})
