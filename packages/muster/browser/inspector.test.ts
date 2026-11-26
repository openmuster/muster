import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright'
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
async function open(path = '/', options: { context?: BrowserContextOptions; channels?: string[] } = {}) {
  const backend = file({ memory: true, principal: 'local:user:ada' })
  const team = board({ backend })
  const kickoff = await team.as('lead').post({ channel: 'general', text: 'kickoff: fix the login redirect' })
  const { task: ready } = await team.as('lead').taskCreate({ channel: 'work/api', text: 'Follow only same-origin paths' })
  const { task: taken } = await team.as('lead').taskCreate({ channel: 'work/api', text: 'Add a test for the redirect' })
  await team.as('claude').taskClaim({ id: taken.id })
  for (const channel of options.channels ?? []) await team.as('lead').post({ channel, text: `first in ${channel}` })
  const serving = await inspect({ backend })
  const context = await browser.newContext(options.context)
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
/** Enough channels that the sidebar's list is longer than any screen here. */
const MANY = Array.from({ length: 40 }, (_, n) => `team/room-${String(n).padStart(2, '0')}`)
const LONG = 'cards/app/planning-1179-with-a-name-far-longer-than-the-sidebar'
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!
const PHONE = { viewport: { width: 390, height: 844 } }
const TABLET = { viewport: { width: 768, height: 1024 } }

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

  it('scrolls with a thin bar in the page\'s own greys, wherever it scrolls', async () => {
    const { page, errors } = await open('/', { channels: MANY })
    const nav = page.locator('nav').first()
    await expect.poll(() => page.locator('nav a').count()).toBeGreaterThan(MANY.length)
    expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    expect(await nav.evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar').width)).toBe('6px')
    expect(await nav.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBeLessThanOrEqual(6)
    // The row of tabs moves sideways without showing a bar under it.
    expect(await page.locator('.tabs').evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar').display)).toBe('none')
    expect(errors).toEqual([])
  })

  it('keeps a long channel name on one line, whole in its tooltip, and requests to join in sight below a long list', async () => {
    const { page, errors } = await open('/', { channels: [LONG, ...MANY] })
    const long = page.locator('nav a', { hasText: 'planning-1179' })
    await long.waitFor()
    const short = page.locator('nav a', { hasText: 'general' })
    expect((await long.boundingBox())!.height).toBe((await short.boundingBox())!.height)
    expect((await long.textContent())!.trim()).toBe(LONG)
    expect(await long.getAttribute('title')).toBe(LONG)
    // Nothing in the list is wider than the list: it scrolls down, never sideways.
    expect(await page.locator('nav').first().evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const joins = page.locator('nav a', { hasText: 'requests to join' })
    const at = (await joins.boundingBox())!
    expect(at.y + at.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    expect(await page.locator('nav').nth(1).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    expect(errors).toEqual([])
  })

  it('is used from the keyboard: a view is a link with an address, and Enter opens a link or a row', async () => {
    const { page, ready, errors } = await open()
    const link = page.locator('nav a', { hasText: 'work/api' })
    await link.waitFor()
    expect(await link.getAttribute('href')).toBe(`/c/${encodeURIComponent('work/api')}`)
    await page.evaluate(() => ((window as { __same?: boolean }).__same = true))
    await link.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('main header b').textContent()).toBe('#work/api')
    expect(await link.getAttribute('aria-current')).toBe('page')
    // The same page, not a new load of it.
    expect(await page.evaluate(() => (window as { __same?: boolean }).__same)).toBe(true)
    const row = page.locator('.rows .thread', { hasText: 'Follow only same-origin paths' })
    await row.focus()
    await page.keyboard.press('Enter')
    await page.locator('.pane').waitFor()
    expect(new URL(page.url()).searchParams.get('thread')).toBe(String(ready.id))
    await page.locator('.pane header a[aria-label="close"]').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.pane').count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('marks the row whose thread is open, and says so when a channel has nothing in it', async () => {
    const { page, team, errors } = await open()
    await page.locator('.rows .row', { hasText: 'Add a test for the redirect' }).click()
    await page.locator('.pane').waitFor()
    expect(await page.locator('.rows .on .text').allTextContents()).toEqual(['Add a test for the redirect'])
    await team.createChannel({ path: 'quiet' })
    await page.goto(`${new URL(page.url()).origin}/c/quiet`)
    await expect.poll(() => page.locator('.rows .empty').textContent()).toBe('no messages in #quiet yet')
    expect(errors).toEqual([])
  })

  it('slides a thread in, and only fades it for someone who asked for less motion', async () => {
    const moving = await open()
    await moving.page.locator('.rows .row').first().click()
    await moving.page.locator('.pane').waitFor()
    expect(await moving.page.locator('.pane').evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('transform')
    await expect.poll(() => moving.page.locator('.pane').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    const still = await open('/', { context: { reducedMotion: 'reduce' } })
    await still.page.locator('.rows .row').first().click()
    await still.page.locator('.pane').waitFor()
    expect(await still.page.locator('.pane').evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('opacity')
    expect([...moving.errors, ...still.errors]).toEqual([])
  })

  it('on a phone, keeps the sidebar in a drawer and gives a thread the whole screen', async () => {
    const { page, errors } = await open('/', { context: PHONE, channels: [LONG] })
    await rows(page).first().waitFor()
    const { width, height } = page.viewportSize()!
    const hidden = await box(page, 'aside')
    expect(hidden.x + hidden.width).toBeLessThanOrEqual(0)
    expect(await page.locator('aside').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden')
    await page.locator('button[aria-label="menu"]').click()
    await expect.poll(async () => (await box(page, 'aside')).x).toBe(0)
    expect(await page.locator('button[aria-label="menu"]').getAttribute('aria-expanded')).toBe('true')
    // Every channel is there by name, not as a column of the same icon.
    expect((await box(page, 'nav a[title="work/api"] .leaf')).width).toBeGreaterThan(0)
    await page.locator('nav a', { hasText: 'work/api' }).click()
    await expect.poll(() => page.locator('main header b').textContent()).toBe('#work/api')
    await expect.poll(async () => { const at = await box(page, 'aside'); return at.x + at.width }).toBeLessThanOrEqual(0)
    await page.locator('button[aria-label="menu"]').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('button[aria-label="menu"]').getAttribute('aria-expanded')).toBe('false')
    await page.locator('.rows .thread').first().click()
    await expect.poll(() => box(page, '.pane')).toEqual({ x: 0, y: 0, width, height })
    // Nothing is wider than the screen, and typing doesn't make the page zoom.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(errors).toEqual([])
  })

  it('on a touch screen, gives a finger room and keeps text at a size a phone won\'t zoom in on', async () => {
    const { page, errors } = await open('/', { context: { ...PHONE, hasTouch: true, isMobile: true } })
    await rows(page).first().waitFor()
    for (const selector of ['.rows .row', '.tabs a', 'button[aria-label="menu"]']) expect((await box(page, selector)).height, selector).toBeGreaterThanOrEqual(40)
    for (const selector of ['.composer input', '.composer textarea']) expect(await page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), selector).toBeGreaterThanOrEqual(16)
    await page.locator('button[aria-label="menu"]').tap()
    await expect.poll(async () => (await box(page, 'aside')).x).toBe(0)
    expect((await box(page, 'nav a')).height).toBeGreaterThanOrEqual(40)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(errors).toEqual([])
  })

  it('on two screens with a hinge between, keeps the board on the left one and a thread on the right', async () => {
    const { page, errors } = await open('/')
    const hinge = { left: 540, width: 34 }
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setDeviceMetricsOverride', { width: 1114, height: 720, deviceScaleFactor: 1, mobile: false, displayFeature: { orientation: 'vertical', offset: hinge.left, maskLength: hinge.width } })
    await expect.poll(() => page.evaluate(() => matchMedia('(horizontal-viewport-segments: 2)').matches)).toBe(true)
    await rows(page).first().waitFor()
    const app = await box(page, '.app')
    expect(app.x + app.width).toBeLessThanOrEqual(hinge.left)
    await page.locator('.rows .row').first().click()
    await page.locator('.pane').waitFor()
    await expect.poll(async () => (await box(page, '.pane')).x).toBe(hinge.left + hinge.width)
    expect((await box(page, '.pane')).width).toBe(1114 - hinge.left - hinge.width)
    expect(errors).toEqual([])
  })

  it('on a tablet, shows the sidebar and lays a thread over the list; on a desktop, beside it', async () => {
    const tablet = await open('/', { context: TABLET })
    await rows(tablet.page).first().waitFor()
    expect((await box(tablet.page, 'aside')).x).toBe(0)
    expect(await tablet.page.locator('button[aria-label="menu"]').isVisible()).toBe(false)
    expect((await box(tablet.page, 'nav a[title="work/api"] .leaf')).width).toBeGreaterThan(0)
    const before = (await box(tablet.page, 'main')).width
    await tablet.page.locator('.rows .row').first().click()
    await tablet.page.locator('.pane').waitFor()
    expect((await box(tablet.page, 'main')).width).toBe(before)
    expect(await tablet.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    const desktop = await open('/', { context: { viewport: { width: 1280, height: 800 } } })
    await rows(desktop.page).first().waitFor()
    const wide = (await box(desktop.page, 'main')).width
    await desktop.page.locator('.rows .row').first().click()
    await desktop.page.locator('.pane').waitFor()
    expect((await box(desktop.page, 'main')).width).toBeLessThan(wide)
    expect([...tablet.errors, ...desktop.errors]).toEqual([])
  })
})
