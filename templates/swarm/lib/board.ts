import { homedir } from 'node:os'
import { board, http, type Board } from 'muster'

export const SWARM = process.env.SWARM_CHANNEL ?? 'swarm'

let handle: Board | null = null

/** The swarm's board: the one at MUSTER_URL when set, else the default board on this machine. */
export function team(): Board {
  if (handle) return handle
  const url = process.env.MUSTER_URL
  handle = url ? board({ backend: http({ url, token: process.env.MUSTER_TOKEN ?? '' }), as: 'launcher' }) : board({ as: 'launcher' })
  return handle
}

/** A path as people write it: the home directory is `~`. */
export const tilde = (path: string): string => {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
