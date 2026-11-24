import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from '../cli/claims.ts'

/** Starts that may end without the daemon staying up, within the window, before it stops restarting. */
export const RESTART_LIMIT = 5
/** How far back a start counts. launchd waits 30 seconds between restarts, so five crashes take over two minutes. */
export const RESTART_WINDOW = 10 * 60_000
/** How long a run must stay up, with a tick that worked, for its start not to count. */
export const STEADY_AFTER = 2 * 60_000
/** How long a stopped daemon waits before it tries again on its own, as a first start. */
export const STOPPED_FOR = 60 * 60_000

export type Parked = { at: string; why: string }
/** What the guard keeps for a board: when each recent start was, and whether it has stopped restarting. */
export type GuardRecord = { starts: number[]; parked?: Parked }

/**
 * Where the guard keeps its record: beside the daemon's config, named for the board and where it is (its
 * file, or its URL), so two boards of one name in different folders never share one. It is worked out
 * without opening the board, since opening the board is one of the things that fails.
 */
export const guardPath = (name: string, where: string) => join(configDir(), 'daemon', `${name}-${createHash('sha256').update(where).digest('hex').slice(0, 16)}.json`)

/** When a stopped daemon tries again on its own. */
export const retryAt = (parked: Parked) => new Date(Date.parse(parked.at) + STOPPED_FOR).toISOString()

export function readGuard(path: string): GuardRecord {
  try {
    const kept = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardRecord>
    return { starts: Array.isArray(kept.starts) ? kept.starts.filter((at) => typeof at === 'number') : [], ...(kept.parked ? { parked: kept.parked } : {}) }
  } catch {
    return { starts: [] }
  }
}

/** Written whole or not at all: a crash halfway through never leaves a record that can't be read. */
function writeGuard(path: string, record: GuardRecord) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`

/**
 * Notes a start. Returns why the daemon must not run when it has stopped restarting, now or before:
 * the starts in the window, this one included, reached the limit and none of them stayed up. A stop
 * lasts `STOPPED_FOR`; after that the start is let through and counts as the first. Nothing is timed:
 * the record is read and compared with the clock.
 */
export function begin(path: string, now: number): Parked | null {
  const record = readGuard(path)
  if (record.parked && now - Date.parse(record.parked.at) < STOPPED_FOR) return record.parked
  const starts = [...(record.parked ? [] : record.starts.filter((at) => now - at < RESTART_WINDOW && at <= now)), now]
  if (starts.length < RESTART_LIMIT) {
    writeGuard(path, { starts })
    return null
  }
  const parked = {
    at: new Date(now).toISOString(),
    why: `The daemon started ${starts.length} times in ${minutes(RESTART_WINDOW)} and never stayed up ${minutes(STEADY_AFTER)}, so it has stopped restarting.`,
  }
  writeGuard(path, { starts, parked })
  return parked
}

/** A start that ended cleanly: a stop, another process already ticking, a config error. It wasn't a crash, so it doesn't count. */
export function ended(path: string, at: number) {
  const record = readGuard(path)
  if (record.parked || !record.starts.includes(at)) return
  writeGuard(path, { starts: record.starts.filter((each) => each !== at) })
}

/** The daemon has stayed up and done its work: the starts before it were not a storm. */
export function steady(path: string) {
  const record = readGuard(path)
  if (record.parked || record.starts.length === 0) return
  writeGuard(path, { starts: [] })
}

/** Forgets the record, so the next start is the first. Says whether the daemon had stopped restarting. */
export function reset(path: string): Parked | null {
  const { parked } = readGuard(path)
  rmSync(path, { force: true })
  return parked ?? null
}
