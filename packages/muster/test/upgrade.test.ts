import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { board, verify } from '../src/index.ts'
import { tempDir } from './helpers.ts'

// A board written by the 0.1.1 release (fixtures/make-board.mjs says how), opened by this checkout.
const fixture = fileURLToPath(new URL('./fixtures/v0.1.1', import.meta.url))
const expected = JSON.parse(readFileSync(join(fixture, 'expect.json'), 'utf8')) as { hello: number; done: number; open: number; waiting: number; blocked: number; key: string; token: string }

function opened() {
  const dir = tempDir()
  cpSync(join(fixture, 'main.db'), join(dir, 'main.db'))
  return { dir, team: board({ dir, principal: 'local:user:ada' }) }
}

describe('a board made by an older release', () => {
  it('opens with everything it held: messages, reactions, labels, and each task in its state', async () => {
    const { team } = opened()
    const thread = await team.readThread({ id: expected.hello })
    expect([thread.message.text, thread.message.labels.kind, thread.message.reactions, thread.replies.map((reply) => reply.text)]).toEqual([
      'kickoff: fix the login redirect',
      'note',
      { '+1': ['local:user:ada+worker-1'] },
      ['on it'],
    ])
    const states = Object.fromEntries((await team.taskList({ channel: 'work/', state: 'all' })).tasks.map((task) => [task.id, task.state]))
    expect(states).toEqual({ [expected.done]: 'completed', [expected.open]: 'ready', [expected.waiting]: 'waiting', [expected.blocked]: 'blocked' })
    expect((await team.task(expected.done))!.result).toBe('fixed in a1b2c3')
    expect((await team.search({ text: 'redirect' })).messages.length).toBeGreaterThan(0)
  })

  it('takes new writes, and what waited on old work moves when that work is done', async () => {
    const { dir, team } = opened()
    const worker = team.as('worker-2')
    const held = await worker.taskClaim({ id: expected.open })
    await worker.reply({ to: expected.open, text: 'test added' })
    await worker.taskComplete({ id: expected.open, token: held.token, result: 'done' })
    expect((await team.task(expected.waiting))!.state).toBe('ready')
    await team.backend.close?.()
    // Closed and opened again, the old and the new are both there.
    const again = board({ dir, principal: 'local:user:ada' })
    expect((await again.readThread({ id: expected.open })).replies.at(-1)!.text).toBe('test added')
    expect((await again.readThread({ id: expected.hello })).message.text).toBe('kickoff: fix the login redirect')
  })

  it('a token that release minted still verifies', () => {
    const claims = verify(Buffer.from(expected.key, 'base64url'), expected.token, Date.now())
    expect([claims.sub, claims.profile, claims.can]).toEqual(['local:user:ada', 'worker-1', { 'work/': ['read', 'post', 'label'] }])
  })
})
