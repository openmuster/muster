// One short-lived writer: opens the board, appends `count` events one transaction each, exits.
import { openDb } from '../src/store/sqlite.ts'

const [path, id, countArg] = process.argv.slice(2)
const count = Number(countArg)
const started = performance.now()
const db = openDb(path!)
let errors = 0
let worst = 0
for (let i = 0; i < count; i++) {
  const t = performance.now()
  try {
    db.write(() => {
      const last = (db.raw.prepare('select coalesce(max(seq), 0) as s from events').get() as { s: number }).s
      db.raw.prepare('insert into events (at, type, data) values (?, ?, ?)').run(new Date().toISOString(), 'spike', JSON.stringify({ id, i, last }))
    })
  } catch {
    errors++
  }
  worst = Math.max(worst, performance.now() - t)
}
db.close()
process.stdout.write(JSON.stringify({ id, errors, worst, total: performance.now() - started }) + '\n')
