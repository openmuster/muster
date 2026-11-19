// The P0 spike: N short-lived processes writing one board at once, and one reader polling for the last event.
import { spawn } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/store/sqlite.ts'

const procs = Number(process.argv[2] ?? 30)
const each = Number(process.argv[3] ?? 100)
const dir = mkdtempSync(join(tmpdir(), 'muster-spike-'))
const path = join(dir, 'main.db')
const db = openDb(path)
db.raw.exec('create table events (seq integer primary key autoincrement, at text not null, type text not null, data text not null)')

const writer = fileURLToPath(new URL('./writer.ts', import.meta.url))
const started = performance.now()
const results = await Promise.all(
  Array.from({ length: procs }, (_, id) =>
    new Promise<{ errors: number; worst: number; total: number }>((resolve, reject) => {
      const child = spawn(process.execPath, [writer, path, String(id), String(each)], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${id} exited ${code}`))))
    }),
  ),
)
const elapsed = performance.now() - started
const rows = (db.raw.prepare('select count(*) as n, max(seq) as m, count(distinct seq) as d from events').get() as { n: number; m: number; d: number })
const wal = (() => {
  try {
    return statSync(path + '-wal').size
  } catch {
    return 0
  }
})()

// wait latency: how long a poller at 100 ms takes to see one new append from another connection.
const reader = openDb(path, { readonly: true })
const seen = () => (reader.raw.prepare('select coalesce(max(seq), 0) as s from events').get() as { s: number }).s
const lat: number[] = []
for (let i = 0; i < 20; i++) {
  const before = seen()
  const wrote = performance.now()
  setTimeout(() => db.write(() => db.raw.prepare('insert into events (at, type, data) values (?, ?, ?)').run('t', 'ping', '{}')), Math.random() * 100)
  while (seen() === before) await new Promise((r) => setTimeout(r, 100))
  lat.push(performance.now() - wrote)
}
lat.sort((a, b) => a - b)

const expected = procs * each
console.log(JSON.stringify({
  procs, each, expected,
  rows: rows.n, distinctSeq: rows.d, maxSeq: rows.m,
  lost: expected - rows.n,
  busyErrors: results.reduce((sum, r) => sum + r.errors, 0),
  worstWriteMs: Math.round(Math.max(...results.map((r) => r.worst))),
  elapsedMs: Math.round(elapsed),
  writesPerSec: Math.round(expected / (elapsed / 1000)),
  walBytesAfter: wal,
  waitMedianMs: Math.round(lat[10]!),
  waitMaxMs: Math.round(lat[19]!),
}, null, 2))
