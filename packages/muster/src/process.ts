import { execFileSync } from 'node:child_process'

/**
 * When a process started, as the OS reports it, or null when there is no such process. A pid alone
 * can be recycled; a pid with its start time names one process.
 */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Whether the process that recorded `start` is still the one running under `pid`. */
export const sameProcess = (pid: number, start: string) => processStart(pid) === start
