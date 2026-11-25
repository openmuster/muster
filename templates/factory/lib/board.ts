import { board, http, type Board } from 'muster'

export const FACTORY = process.env.FACTORY_CHANNEL ?? 'factory'

let handle: Board | null = null

/** The factory's board: the one at MUSTER_URL when set, else the default board on this machine. */
export function team(): Board {
  if (handle) return handle
  const url = process.env.MUSTER_URL
  // `/api/board` answers for the names the page does (ALLOW_HOSTS, as `proxy.ts` reads it), and for no other.
  // Where ALLOW_HOSTS isn't set, it takes `mu serve`'s MUSTER_ALLOW_HOSTS.
  const allowed = process.env.ALLOW_HOSTS
  const serve = allowed === undefined ? {} : { hosts: allowed.split(',').map((name) => name.trim()).filter(Boolean) }
  handle = url ? board({ backend: http({ url, token: process.env.MUSTER_TOKEN ?? '' }) }) : board({ serve })
  return handle
}
