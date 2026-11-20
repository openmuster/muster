import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { processStart } from '../process.ts'

/**
 * The lock that makes one process a board's ticker. The file names the process that holds it, by pid
 * and start time, so a lock left by a process that died (or whose pid was reused) is taken over.
 */
export function takeLock(path: string, pid = process.pid): { release(): void } | null {
  // A board nobody has written to yet has no folder: the ticker may be the first thing to need one.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const mine = JSON.stringify({ pid, start: processStart(pid) })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, mine)
      closeSync(fd)
      return {
        release() {
          try {
            if (readFileSync(path, 'utf8') === mine) rmSync(path, { force: true })
          } catch {
            // Already gone.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: { pid?: number; start?: string | null } = {}
      try {
        holder = JSON.parse(readFileSync(path, 'utf8')) as typeof holder
      } catch {
        // Unreadable: treat as stale.
      }
      if (typeof holder.pid === 'number' && holder.start && processStart(holder.pid) === holder.start) return null
      rmSync(path, { force: true })
    }
  }
  return null
}
