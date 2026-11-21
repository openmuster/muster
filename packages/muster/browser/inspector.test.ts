import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { board, file } from '../src/index.ts'
import { inspect } from '../src/inspect/server.ts'

const BUNDLE = fileURLToPath(new URL('../dist/inspect/app.js', import.meta.url))

let browser: Browser
const closers: (() => Promise<void>)[] = []

beforeAll(async () => {
  if (!existsSync(BUNDLE)) throw new Error(`The inspector's page isn't built: run pnpm build first (${BUNDLE}).`)
  browser = await chromium.launch()
})
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})
afterAll(async () => {
  await browser?.close()
})

/** A board with a little on it, the real inspector server in front, and the built page open in a browser. */
async function open(path = '/') {
  const backend = file({ memory: true, principal: 'local:user:ada' })
  const team = board({ backend })
  const kickoff = await team.as('lead').post({ channel: 'general', text: 'kickoff: fix the login redirect' })
  const { task: ready } = await team.as('lead').taskCreate({ channel: 'work/api', text: 'Follow only same-origin paths' })
  const { task: taken } = await team.as('lead').taskCreate({ channel: 'work/api', text: 'Add a test for the redirect' })
  await team.as('claude').taskClaim({ id: taken.id })
  const serving = await inspect({ backend })
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  closers.push(async () => {
    await context.close()
    await serving.close()
  })
  // The link `mu inspect` prints, to the view asked for: the token rides after the #.
  await page.goto(`${serving.url}${path}#k=${serving.token}`)
  await page.locator('header em.live').waitFor()
  return { page, team, serving, errors, kickoff, ready, taken }
}

const rows = (page: Page) => page.locator('.rows .row .text')

describe('the inspector, in a browser', () => {
  it('acts as you only when opened by the link mu inspect printed; the token then leaves the address bar, and a link to a view opens in a new tab', async () => {
    const { page, serving, ready } = await open()
    // The token came after the #, and is gone from the address once the page has it.
    expect(page.url()).toBe(`${serving.url}/`)
    await rows(page).first().waitFor()
    const tab = await page.context().newPage()
    await tab.goto(`${serving.url}/c/${encodeURIComponent('work/api')}?thread=${ready.id}`)
    await tab.locator('header em.live').waitFor()
    // Someone else's browser, handed only the address: the page loads, and shows nothing of the board.
    const other = await browser.newContext()
    closers.push(() => other.close())
    const stranger = await other.newPage()
    await stranger.goto(`${serving.url}/`)
    await stranger.getByText('This page needs the link mu inspect printed').waitFor()
    expect(await rows(stranger).count()).toBe(0)
    expect(await stranger.content()).not.toContain(serving.token)
  })

  it('shows the tasks that are open, and each tab shows its state', async () => {
    const { page, errors } = await open()
    await expect.poll(() => rows(page).allTextContents()).toEqual(['Follow only same-origin paths', 'Add a test for the redirect'])
    expect(await page.locator('nav a', { hasText: 'tasks' }).locator('i').textContent()).toBe('2')
    await page.locator('.tabs a', { hasText: /^claimed$/ }).click()
    await expect.poll(() => rows(page).allTextContents()).toEqual(['Add a test for the redirect'])
    expect(await page.locator('.rows .row .meta').first().textContent()).toMatch(/^claude · /)
    expect(new URL(page.url()).search).toBe('?state=claimed')
    await page.locator('.tabs a', { hasText: /^completed$/ }).click()
    expect(await page.locator('.rows .empty').textContent()).toBe('no completed tasks')
    expect(errors).toEqual([])
  })

  it('starts a task from the page, and the board has it', async () => {
    const { page, team, errors } = await open()
    await page.locator('.composer input').fill('#work/web')
    await page.locator('.composer textarea').fill('Show the redirect target on the login page')
    await page.locator('.composer textarea').press('Enter')
    await expect.poll(() => rows(page).allTextContents()).toContain('Show the redirect target on the login page')
    const made = (await team.taskList({ state: 'all' })).tasks.find((task) => task.text === 'Show the redirect target on the login page')
    expect(made).toMatchObject({ channel: 'work/web', state: 'ready' })
    await expect.poll(() => page.locator('nav a', { hasText: 'work/web' }).count()).toBe(1)
    expect(errors).toEqual([])
  })

  it('opens a thread, and a reply is written as the profile in the "as" box', async () => {
    const { page, team, ready, errors } = await open()
    await page.locator('.rows .row', { hasText: 'Follow only same-origin paths' }).click()
    await page.locator('.pane').waitFor()
    expect(await page.locator('.pane article .text').allTextContents()).toEqual(['Follow only same-origin paths'])
    expect(new URL(page.url()).searchParams.get('thread')).toBe(String(ready.id))
    await page.locator('label.as input').fill('reviewer')
    await page.locator('.pane textarea').fill('check the origin before redirecting')
    await page.locator('.pane button', { hasText: 'reply' }).click()
    await expect.poll(() => page.locator('.pane article:not(.pending) .text').allTextContents()).toEqual(['Follow only same-origin paths', 'check the origin before redirecting'])
    const thread = await team.readThread({ id: ready.id })
    expect(thread.replies.map((reply) => [reply.text, reply.by.profile])).toEqual([['check the origin before redirecting', 'reviewer']])
    expect(errors).toEqual([])
  })

  it('shows what someone else writes without a reload', async () => {
    const { page, team, kickoff, errors } = await open('/c/general')
    await expect.poll(() => page.locator('.rows .thread .text').allTextContents()).toEqual(['kickoff: fix the login redirect'])
    await team.as('codex').post({ channel: 'general', text: 'written from a terminal' })
    await team.as('codex').reply({ to: kickoff.id, text: 'on it' })
    await expect.poll(() => page.locator('.rows .thread .text').allTextContents(), { timeout: 5000 }).toEqual(['kickoff: fix the login redirect', 'written from a terminal'])
    await expect.poll(() => page.locator('.rows .thread .meta').allTextContents(), { timeout: 5000 }).toEqual(['1 reply'])
    expect(errors).toEqual([])
  })

  it('a link opens the view it names: a channel with a thread open', async () => {
    const { page, ready, errors } = await open()
    await page.goto(`${new URL(page.url()).origin}/c/${encodeURIComponent('work/api')}?thread=${ready.id}`)
    await page.locator('.pane').waitFor()
    expect(await page.locator('main header b').textContent()).toBe('#work/api')
    expect(await page.locator('.pane header b').textContent()).toBe(`#${ready.id}`)
    await page.goBack()
    await expect.poll(() => page.locator('main header b').textContent()).toBe('tasks')
    expect(errors).toEqual([])
  })

  it('shows a message as the text it is: markup in it is never run', async () => {
    const { page, team, errors } = await open('/c/general')
    const text = '<img src=x onerror="window.__ran = 1"><script>window.__ran = 1</script>'
    const posted = await team.as('mallory').post({ channel: 'general', text })
    await expect.poll(() => page.locator('.rows .thread .text').allTextContents(), { timeout: 5000 }).toContain(text)
    await page.locator('.rows .thread', { hasText: '<img' }).click()
    await page.locator('.pane').waitFor()
    expect(new URL(page.url()).searchParams.get('thread')).toBe(String(posted.id))
    expect(await page.evaluate(() => (window as { __ran?: number }).__ran)).toBeUndefined()
    expect(await page.locator('.rows img, .pane img').count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('the activity view lists events newest last, and requests to join says how one is made', async () => {
    const { page, errors } = await open('/activity')
    await expect.poll(() => page.locator('.rows .row .state').allTextContents()).toEqual(expect.arrayContaining(['message.posted', 'task.created', 'task.claimed']))
    await page.locator('nav a', { hasText: 'requests to join' }).click()
    await expect.poll(() => page.locator('.empty').textContent()).toMatch(/^no requests\. An agent asks with mu join/)
    expect(errors).toEqual([])
  })

  it('says it is reconnecting when the inspector stops', async () => {
    const { page, serving } = await open()
    await serving.close()
    await expect.poll(() => page.locator('header em').textContent(), { timeout: 8000 }).toBe('reconnecting')
  })
})
