import { apply, toEvent } from './log.ts'
import { DERIVED_TABLES, ensureSchema } from './schema.ts'
import { openDb, type Db } from './sqlite.ts'

/** Every row of the tables a fold rebuilds, in a stable order, for comparing two files. */
export function tables(db: Db): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const table of DERIVED_TABLES) out[table] = db.raw.prepare(`select * from ${table} order by 1, 2`).all()
  out.fts = db.raw.prepare("select rowid from messages_fts where messages_fts match 'a* OR b* OR c* OR d* OR e* OR f* OR g* OR h* OR i* OR j* OR k* OR l* OR m* OR n* OR o* OR p* OR q* OR r* OR s* OR t* OR u* OR v* OR w* OR x* OR y* OR z*' order by rowid").all()
  return out
}

/** Rebuilds a board's tables from nothing but its log, into another file. What the log says is all there is. */
export function fold(source: Db, targetPath: string): Db {
  const target = openDb(targetPath)
  ensureSchema(target)
  const rows = source.raw.prepare('select * from events order by seq').all() as Parameters<typeof toEvent>[0][]
  target.write(() => {
    for (const row of rows) {
      target.raw
        .prepare('insert into events (seq, at, type, principal, profile, channel, thread, data) values (?, ?, ?, ?, ?, ?, ?, ?)')
        .get(row.seq, row.at, row.type, row.principal, row.profile, row.channel, row.thread, row.data)
      apply(target, toEvent(row))
    }
  })
  return target
}
