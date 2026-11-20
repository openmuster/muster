// Makes the board that upgrade.test.ts opens. Run it with a RELEASED muster, never the checkout:
//   node test/fixtures/make-board.mjs <path to that release's dist/index.js> <out dir>
// It is not run by the tests. The files it wrote for 0.1.1 are committed in fixtures/v0.1.1.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [lib, out] = process.argv.slice(2)
const { board, mint } = await import(pathToFileURL(resolve(lib)).href)
const dir = resolve(out)
mkdirSync(dir, { recursive: true })
for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true })

const team = board({ dir, principal: 'local:user:ada' })
const lead = team.as('lead')
const worker = team.as('worker-1')
const hello = await lead.post({ channel: 'work/general', text: 'kickoff: fix the login redirect', labels: { kind: 'note' } })
await worker.reply({ to: hello.id, text: 'on it' })
await worker.react({ id: hello.id, emoji: '+1' })
const done = (await lead.taskCreate({ channel: 'work/login', text: 'Follow only same-origin paths', labels: { role: 'worker' } })).task
const held = await worker.taskClaim({ id: done.id })
await worker.reply({ to: done.id, text: 'plan: check the origin before redirecting' })
await worker.taskComplete({ id: done.id, token: held.token, result: 'fixed in a1b2c3' })
const open = (await lead.taskCreate({ channel: 'work/login', text: 'Add a test for off-site URLs' })).task
const waiting = (await lead.taskCreate({ channel: 'work/login', text: 'Review the fix', needs: [open.id] })).task
const blocked = (await lead.taskCreate({ channel: 'work/login', text: 'Pick the redirect allow-list' })).task
const claim = await worker.taskClaim({ id: blocked.id })
await worker.taskBlock({ id: blocked.id, token: claim.token, reason: 'which hosts?', kind: 'needs_input' })
await team.backend.close?.()

// A token as that release made it, and the key it was signed with: a test key, good for nothing else.
const key = Buffer.alloc(32, 7)
const token = mint(key, { sub: 'local:user:ada', profile: 'worker-1', can: { 'work/': ['read', 'post', 'label'] }, exp: 4102444800 })
writeFileSync(join(dir, 'expect.json'), JSON.stringify({ hello: hello.id, done: done.id, open: open.id, waiting: waiting.id, blocked: blocked.id, key: key.toString('base64url'), token }, null, 2) + '\n')
console.log(readdirSync(dir).join(' '))
