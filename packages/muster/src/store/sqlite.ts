import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Failure } from '../failure.ts'

/** The oldest embedded SQLite muster runs on: the first with the WAL-reset fix. */
export const SQLITE_FLOOR = [3, 51, 3] as const

const BUSY_TRIES = 8
/** Opening a new file takes locks no busy timeout covers, so thirty processes making one board at once wait their turn here. */
const OPEN_TRIES = 60

/** Whether `version` ("3.54.0") is at least the floor. */
export function atLeastFloor(version: string, floor: readonly number[] = SQLITE_FLOOR): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0
    const need = floor[i] ?? 0
    if (have !== need) return have > need
  }
  return true
}

const isBusy = (error: unknown) => {
  const code = (error as { errcode?: number; code?: string } | null)?.errcode
  const message = String((error as { message?: string } | null)?.message ?? '')
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), with their extended codes.
  return (code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6)) || /database is locked|database table is locked/.test(message)
}

/** Sleeps in this thread: a CLI process has nothing else to do while it waits for the writer. */
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Runs `fn`, again after a jittered pause while the file is busy. For steps that can't be half done. */
export function whileBusy<T>(fn: () => T, tries = OPEN_TRIES): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      if (!isBusy(error)) throw error
      if (attempt >= tries) throw new Failure('busy', 'The board is busy: other writers held it too long.', { hint: 'Run the command again.' })
      pause(20 + Math.floor(Math.random() * 130))
    }
  }
}

/** An open board file. */
export type Db = {
  readonly raw: DatabaseSync
  readonly path: string
  /** Runs `fn` in one write transaction. Only BEGIN and COMMIT are retried when busy: `fn` runs once. */
  write<T>(fn: () => T): T
  close(): void
}

/**
 * Opens a board's file with the settings SPEC.md section 3 lists, and refuses a filesystem that can't
 * do WAL: a board on one silently loses its guarantees.
 */
/**
 * Makes a board's file its owner's alone to read, before SQLite opens it: the files SQLite keeps beside
 * it take its mode. The folder muster makes is private already; one somebody else made may not be.
 */
export function ownerOnly(path: string) {
  try {
    if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
    // What a board from before this kept beside it, at whatever mode it was made with.
    for (const beside of [`${path}-wal`, `${path}-shm`]) if (existsSync(beside)) chmodSync(beside, 0o600)
  } catch {
    // Not ours to change (another user's file, a filesystem without modes): opening it says what is wrong, if anything.
  }
}

export function openDb(path: string, options: { readonly?: boolean } = {}): Db {
  if (path !== ':memory:' && !options.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (path !== ':memory:' && !options.readonly) ownerOnly(path)
  let raw: DatabaseSync
  try {
    raw = new DatabaseSync(path, { readOnly: options.readonly === true })
  } catch (error) {
    throw new Failure('no_store', `Couldn't open the board at ${path}.`, { hint: String((error as Error).message) })
  }
  raw.exec('pragma busy_timeout = 5000')
  if (path !== ':memory:') {
    // A file that isn't a database, or one SQLite can no longer read, is set aside and never written over.
    try {
      whileBusy(() => raw.prepare('select count(*) from sqlite_master').get())
    } catch (error) {
      raw.close()
      const message = String((error as Error).message)
      if (!/not a database|malformed|corrupt/i.test(message)) throw error
      const aside = `${path}.corrupt-${Date.now()}`
      if (existsSync(path)) copyFileSync(path, aside)
      throw new Failure('store_corrupt', `The board at ${path} can't be read: ${message}.`, { hint: `A copy is at ${aside}. Restore a backup; muster won't write over this file.` })
    }
  }
  const version = (raw.prepare('select sqlite_version() as v').get() as { v: string }).v
  if (!atLeastFloor(version)) {
    raw.close()
    throw new Failure('sqlite_too_old', `This Node embeds SQLite ${version}; muster needs ${SQLITE_FLOOR.join('.')} or later.`, {
      hint: 'Use Node 22.22.3 or later on the 22 line, or 24.15 or later.',
    })
  }
  if (!options.readonly) {
    const mode = whileBusy(() => (raw.prepare('pragma journal_mode = wal').get() as { journal_mode: string }).journal_mode)
    if (path !== ':memory:' && mode !== 'wal') {
      raw.close()
      throw new Failure('no_wal', `The filesystem under ${path} can't keep a write-ahead log.`, {
        hint: 'Keep the board on a local disk: pass --dir or set MUSTER_DIR.',
      })
    }
    whileBusy(() => {
      raw.exec('pragma synchronous = full')
      raw.exec('pragma checkpoint_fullfsync = 1')
      raw.exec('pragma wal_autocheckpoint = 100')
      raw.exec('pragma journal_size_limit = 8388608')
    })
  }
  raw.exec('pragma foreign_keys = on')

  const boundary = (sql: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        raw.exec(sql)
        return
      } catch (error) {
        if (!isBusy(error)) throw error
        if (attempt >= BUSY_TRIES) throw new Failure('busy', 'The board is busy: other writers held it too long.', { hint: 'Run the command again.' })
        pause(20 + Math.floor(Math.random() * 130))
      }
    }
  }

  return {
    raw,
    path,
    write(fn) {
      boundary('begin immediate')
      let result: ReturnType<typeof fn>
      try {
        result = fn()
      } catch (error) {
        raw.exec('rollback')
        throw error
      }
      try {
        boundary('commit')
      } catch (error) {
        try {
          raw.exec('rollback')
        } catch {
          // The transaction is already gone.
        }
        throw error
      }
      return result
    },
    close() {
      raw.close()
    },
  }
}
