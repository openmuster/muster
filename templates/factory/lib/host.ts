const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a request's Host is one this page answers for: this machine, or a name listed in ALLOW_HOSTS.
 * The page has no sign-in and acts as whoever started it, so listening on 127.0.0.1 isn't enough: a page on
 * another site can point a name of its own at 127.0.0.1 and have a browser send requests here under it.
 */
export function answersFor(host: string | null | undefined, allowed: string = ''): boolean {
  if (!host) return false
  const name = host.toLowerCase().replace(/:\d+$/, '')
  if (LOCAL.has(name)) return true
  return allowed.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).includes(name)
}
