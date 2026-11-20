import { Failure } from '../failure.ts'
import { MOUNT, ROUTES } from '../serve/server.ts'

/** One rule of a sandbox's network policy: which requests to a host pass, and what is added to them on the way out. */
export type Rule = { match: { path: string; method: string[] }; transform: { headers: Record<string, string> }[] }
export type NetworkPolicy = { allow: Record<string, Rule[]> }

/** What a sandbox's agent may call. Reading and writing the board, never running it: no tokens, no webhooks. */
export const SANDBOX_ROUTES = ROUTES.filter((route) => !route.startsWith('schedule') && route !== 'schemaAdd' && route !== 'budgetSet')

export const PLACEHOLDER = 'set-by-the-network-policy'

/**
 * The network policy that hands a sandbox one board. The sandbox reaches the board's host, and on it
 * only the board's own routes; the credential is added to each request after it leaves the sandbox,
 * so nothing running inside can read it or send it anywhere else.
 */
export function boardPolicy(options: { url: string; token: string }): { networkPolicy: NetworkPolicy; env: Record<string, string> } {
  const url = new URL(options.url)
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
    throw new Failure('board_not_reachable', "A sandbox can't reach a board on this machine.", { hint: 'Serve the board at a URL the sandbox can reach: a tunnel, a tailnet name, or a deployed mu serve.' })
  }
  if (url.protocol !== 'https:') throw new Failure('board_not_reachable', 'A sandbox reaches a board over HTTPS only: a credential added to plain HTTP crosses the network in the clear.')
  const base = url.pathname.replace(/\/$/, '') || MOUNT
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headers = { authorization: `Bearer ${options.token}` }
  return {
    networkPolicy: {
      allow: {
        [url.host]: [
          // Exact routes only: no dot segments, no encoded slashes, nothing under or beside them.
          { match: { path: `^${escaped}/(${SANDBOX_ROUTES.join('|')})$`, method: ['POST'] }, transform: [{ headers }] },
          { match: { path: `^${escaped}/whoami$`, method: ['GET'] }, transform: [{ headers }] },
        ],
      },
    },
    env: { MUSTER_URL: `${url.origin}${base}`, MUSTER_TOKEN: PLACEHOLDER },
  }
}

/**
 * What a sandbox's proxy does with one request, for tests and for runners that enforce the policy
 * themselves: the headers to add, or null when the request doesn't pass.
 */
export function applyPolicy(policy: NetworkPolicy, request: { url: string; method: string }): Record<string, string> | null {
  const url = new URL(request.url)
  const rules = policy.allow[url.host]
  if (!rules) return null
  // The path as sent, before any normalising: `/api/board/../x` must not match.
  const raw = request.url.slice(request.url.indexOf(url.host) + url.host.length).split('?')[0] ?? ''
  if (/%2f|%5c|\\|\/\.\.?(\/|$)/i.test(raw)) return null
  for (const rule of rules) {
    if (rule.match.method.includes(request.method.toUpperCase()) && new RegExp(rule.match.path).test(raw)) return Object.assign({}, ...rule.transform.map((step) => step.headers)) as Record<string, string>
  }
  return null
}
