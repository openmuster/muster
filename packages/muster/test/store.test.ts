import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { board } from '../src/index.ts'
import { fold, tables } from '../src/store/fold.ts'
import { ensureSchema } from '../src/store/schema.ts'
import { atLeastFloor, openDb } from '../src/store/sqlite.ts'
import { clock, reason, tempDir } from './helpers.ts'

/** A small deterministic generator, so a failing history can be run again from its seed. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

async function history(dir: string, seed: number, steps: number) {
  const time = clock()
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const team = board({ dir, now: time.now, alive: () => false, principal: 'local:user:ada' })
  const who = [team, team.as('lead'), team.as('worker'), team.as('reviewer')]
  const channels = ['dev', 'db/storage', 'db/consensus']
  const words = ['alpha', 'beta', 'gamma', 'delta', 'kappa']
  const messages: number[] = []
  const taskIds: number[] = []
  const schedules: number[] = []
  const tokens = new Map<number, { token: string; as: number }>()
  for (let step = 0; step < steps; step++) {
    time.advance(Math.floor(next() * 200_000))
    const actor = Math.floor(next() * who.length)
    const me = who[actor]!
    const text = `${pick(words)} ${pick(words)} ${step}`
    const some = () => pick(messages)
    try {
      switch (Math.floor(next() * 17)) {
        case 0: messages.push((await me.post({ channel: pick(channels), text, labels: next() < 0.5 ? { kind: pick(words) } : {} })).id); break
        case 1: if (messages.length) messages.push((await me.reply({ to: some(), text })).id); break
        case 2: if (messages.length) await me.edit({ id: some(), text }); break
        case 3: if (messages.length) await me.remove({ id: some() }); break
        case 4: if (messages.length) await me.label({ id: some(), set: { [pick(['step', 'owner'])]: pick(words) } }); break
        case 5: if (messages.length) await me.label({ id: some(), unset: ['step'] }); break
        case 6: if (messages.length) await me.react({ id: some(), emoji: pick(['eyes', 'rocket']), remove: next() < 0.3 }); break
        case 7: { const made = await me.taskCreate({ channel: pick(channels), text, needs: taskIds.length && next() < 0.5 ? [pick(taskIds)] : [], idempotencyKey: next() < 0.3 ? `k${step % 7}` : undefined } as never); taskIds.push(made.task.id); messages.push(made.task.id); break }
        case 8: { const held = await me.taskClaim(next() < 0.5 && taskIds.length ? { id: pick(taskIds), lease: 60 } : { ready: 'db/', lease: 120 }); tokens.set(held.task.id, { token: held.token, as: actor }); break }
        case 9: if (tokens.size) { const [id, held] = pick([...tokens]); await who[held.as]!.taskComplete({ id, token: held.token, result: text }); tokens.delete(id) } break
        case 10: if (tokens.size) { const [id, held] = pick([...tokens]); await who[held.as]!.taskFail({ id, token: held.token, reason: text }); tokens.delete(id) } break
        case 11: if (tokens.size) { const [id, held] = pick([...tokens]); await who[held.as]!.taskBlock({ id, token: held.token, reason: text, kind: 'needs_input' }); tokens.delete(id) } break
        case 12: if (taskIds.length) await pick([() => me.taskUnblock({ id: pick(taskIds) }), () => me.taskReopen({ id: pick(taskIds), round: next() < 0.5 }), () => me.taskCancel({ id: pick(taskIds) }), () => me.taskAssign({ id: pick(taskIds), for: next() < 0.5 ? 'worker' : null })])(); break
        case 13: if (taskIds.length > 1) await me.taskNeeds({ id: pick(taskIds), needs: next() < 0.5 ? [] : [pick(taskIds)] }); break
        case 14: schedules.push((await me.scheduleCreate(messages.length && next() < 0.5 ? { thread: some(), text, every: 600, times: 3 } : { channel: pick(channels), text, at: new Date(time.now().getTime() + 60_000).toISOString() })).id); break
        case 15: await team.scheduleTick(); break
        case 16: if (schedules.length) await me.scheduleCancel({ id: pick(schedules) }); break
      }
    } catch (error) {
      // Refusals are part of a history. Anything that isn't a board's refusal is a bug.
      if (typeof (error as { reason?: unknown }).reason !== 'string') throw error
    }
  }
  team.close()
}

describe('store', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('a fold of the log alone rebuilds every table (random history, seed %i)', async (seed) => {
    const dir = tempDir()
    await history(dir, seed, 400)
    const live = openDb(join(dir, 'main.db'))
    const count = (live.raw.prepare('select count(*) as n from events').get() as { n: number }).n
    expect(count).toBeGreaterThan(150)
    const rebuilt = fold(live, join(dir, 'fold.db'))
    expect(tables(rebuilt)).toEqual(tables(live))
    live.close()
    rebuilt.close()
  })

  it('a board made before schedules, links and the inbox existed gets those tables when it is next opened', async () => {
    const dir = tempDir()
    const old = openDb(join(dir, 'main.db'))
    old.raw.exec('create table events (seq integer primary key autoincrement, at text not null, type text not null, principal text not null, profile text, channel text, thread integer, data text not null)')
    old.raw.exec('pragma user_version = 1')
    old.close()
    const team = board({ dir, principal: 'local:user:ada' })
    expect((await team.scheduleCreate({ channel: 'work', text: 'x', every: 600 })).next).not.toBeNull()
    team.close()
    const after = openDb(join(dir, 'main.db'))
    expect((after.raw.prepare('pragma user_version').get() as { user_version: number }).user_version).toBe(4)
    after.close()
  })

  it('the log is append-only: an event can be neither changed nor removed', () => {
    const db = openDb(join(tempDir(), 'main.db'))
    ensureSchema(db)
    db.raw.prepare("insert into events (at, type, principal, data) values ('t', 'x', 'p', '{}')").run()
    expect(() => db.raw.exec("update events set type = 'y'")).toThrow(/append-only/)
    expect(() => db.raw.exec('delete from events')).toThrow(/append-only/)
    db.close()
  })

  it('opens with the settings the spec lists', () => {
    const db = openDb(join(tempDir(), 'main.db'))
    const pragma = (name: string) => Object.values(db.raw.prepare(`pragma ${name}`).get() as Record<string, unknown>)[0]
    expect(pragma('journal_mode')).toBe('wal')
    expect(pragma('synchronous')).toBe(2)
    expect(pragma('busy_timeout')).toBe(5000)
    expect(pragma('wal_autocheckpoint')).toBe(100)
    expect(pragma('journal_size_limit')).toBe(8_388_608)
    expect(pragma('foreign_keys')).toBe(1)
    db.close()
  })

  it('knows which embedded SQLite versions are too old', () => {
    expect(atLeastFloor('3.51.3')).toBe(true)
    expect(atLeastFloor('3.54.0')).toBe(true)
    expect(atLeastFloor('4.0.0')).toBe(true)
    expect(atLeastFloor('3.51.2')).toBe(false)
    expect(atLeastFloor('3.50.9')).toBe(false)
  })

  it('a board survives its process: messages, tasks, and a held lease are all there on reopening', async () => {
    const dir = tempDir()
    const time = clock()
    const first = board({ dir, now: time.now, principal: 'local:user:ada' })
    const { task } = await first.taskCreate({ channel: 'work', text: 'survives' })
    const held = await first.as('w').taskClaim({ id: task.id, lease: 600 })
    first.close()
    const second = board({ dir, now: time.now, principal: 'local:user:ada' })
    expect(await second.task(task.id)).toMatchObject({ state: 'claimed', claim: { by: { profile: 'w' } } })
    time.advance(601_000)
    expect((await second.task(task.id))?.state).toBe('ready')
    expect(await reason(second.as('other').taskClaim({ ready: 'work' }))).toBe('did not fail')
    expect(await reason(second.as('w').taskComplete({ id: task.id, token: held.token }))).toBe('claim_lost')
    second.close()
  })

  it('boards are separate files by name, and a bad name is refused', async () => {
    const dir = tempDir()
    const main = board({ dir, principal: 'local:user:ada' })
    const security = board({ dir, name: 'security', principal: 'local:user:ada' })
    await main.post({ channel: 'dev', text: 'public' })
    await security.post({ channel: 'dev', text: 'private' })
    expect((await main.readChannel({ channel: 'dev' })).threads.map((thread) => thread.message.text)).toEqual(['public'])
    expect(existsSync(join(dir, 'security.db'))).toBe(true)
    expect(await reason(board({ dir, name: '../etc' }).head())).toBe('invalid_board')
    main.close()
    security.close()
  })

  it('refuses a file a newer muster made, and one that is not a database', async () => {
    const dir = tempDir()
    const db = openDb(join(dir, 'main.db'))
    ensureSchema(db)
    db.raw.exec('pragma user_version = 99')
    db.close()
    expect(await reason(board({ dir }).head())).toBe('store_too_new')
    writeFileSync(join(dir, 'junk.db'), 'this is not sqlite, it is a text file that is long enough to look like a page')
    expect(await reason(board({ dir, name: 'junk' }).head())).toBe('store_corrupt')
    // The unreadable file is copied aside and left as it was: never recreated, never written over.
    expect(readdirSync(dir).filter((name) => name.startsWith('junk.db.corrupt-'))).toHaveLength(1)
    expect(readFileSync(join(dir, 'junk.db'), 'utf8')).toMatch(/^this is not sqlite/)
  })

  it('a folder that cannot be made is an error as data, not a crash', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'file'), 'x')
    expect(await reason(board({ dir: join(dir, 'file', 'under') }).head())).toMatch(/no_store|threw/)
  })
})
