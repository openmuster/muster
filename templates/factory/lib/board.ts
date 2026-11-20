import { board, http, type Board } from 'muster'

export const FACTORY = process.env.FACTORY_CHANNEL ?? 'factory'

let handle: Board | null = null

/** The factory's board: the one at MUSTER_URL when set, else the default board on this machine. */
export function team(): Board {
  if (handle) return handle
  const url = process.env.MUSTER_URL
  handle = url ? board({ backend: http({ url, token: process.env.MUSTER_TOKEN ?? '' }) }) : board()
  return handle
}
