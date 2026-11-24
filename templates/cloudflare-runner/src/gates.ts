// What each gate lets out of the container, as plain functions: no Workers runtime here, so they are tested as they run.

export type Rule = { match: { path: string; method: string[] }; transform: { headers: Record<string, string> }[] }
export type BoardProps = { host: string; rules: Rule[]; token: string }
export type ModelProps = { host: string; paths: string[]; headers: Record<string, string> }
/** One repository, read only: the routes `git clone` over HTTPS uses, and nothing else on its host. `auth` is added to those, for a private one. */
export type RepoProps = { host: string; path: string; auth?: string }

/** Dot segments, encoded slashes and backslashes: a path that could mean something other than it says. */
const AMBIGUOUS = /%2f|%5c|\\|\/\.\.?(\/|$)/i

/** The request's path as sent, before the URL parser normalises it: `/api/board/../x` must not match. */
function rawPath(url: string): string | null {
  const parsed = new URL(url)
  const at = url.indexOf(parsed.host)
  if (at < 0) return null
  return url.slice(at + parsed.host.length).split(/[?#]/)[0] ?? ''
}

/**
 * The headers to add to a request for the board, or null when it doesn't pass. The intercept matches the
 * TLS server name, but the URL comes from the Host header, which the container writes: both are checked.
 */
export function boardHeaders(request: { url: string; method: string }, props: BoardProps): Record<string, string> | null {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.host !== props.host) return null
  const path = rawPath(request.url)
  if (path === null || AMBIGUOUS.test(request.url)) return null
  const rule = props.rules.find((candidate) => candidate.match.method.includes(request.method.toUpperCase()) && new RegExp(candidate.match.path).test(path))
  return rule ? { authorization: `Bearer ${props.token}` } : null
}

/** Whether a request may go to the model's host: only the calls that ask the model, never the rest of what the key can do. */
export function modelPasses(request: { url: string; method: string }, props: ModelProps): boolean {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.host !== props.host) return false
  if (AMBIGUOUS.test(request.url)) return false
  return request.method.toUpperCase() === 'POST' && props.paths.some((path) => new RegExp(path).test(url.pathname + url.search))
}

/** Whether a request is `git clone` reading this one repository: its refs, then its pack. */
export function repoPasses(request: { url: string; method: string }, props: RepoProps): boolean {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.host !== props.host) return false
  const path = rawPath(request.url)
  if (path === null || AMBIGUOUS.test(request.url)) return false
  const base = props.path.replace(/\.git$/, '')
  const repo = `(?:${escape(base)}|${escape(`${base}.git`)})`
  const method = request.method.toUpperCase()
  if (method === 'GET') return new RegExp(`^${repo}/info/refs$`).test(path) && url.search === '?service=git-upload-pack'
  if (method === 'POST') return new RegExp(`^${repo}/git-upload-pack$`).test(path) && url.search === ''
  return false
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The repository a clone URL names, for its gate: https only, with no credential in it. */
export function repoProps(clone: string, auth?: string): RepoProps {
  const url = new URL(clone)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('repo must be an https clone URL with no credential in it')
  return { host: url.host, path: url.pathname.replace(/\/$/, ''), ...(auth ? { auth } : {}) }
}

/**
 * The hosts a dependency install reads from: npm's registry (npm, pnpm, yarn 1, and corepack fetching
 * pnpm or yarn), yarn's alias of it that yarn lockfiles name, and where corepack fetches yarn 2 and later.
 */
export const REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com']

/**
 * Whether a request may go to a registry while dependencies install: reading only, with nothing added.
 * A scoped package is asked for as `/@scope%2fname`, so an encoded slash passes here; dot segments don't.
 */
export function registryPasses(request: { url: string; method: string }, hosts: string[] = REGISTRY_HOSTS): boolean {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || !hosts.includes(url.host)) return false
  const path = rawPath(request.url)
  if (path === null || /\\|\/\.\.?(\/|$)|%2e/i.test(path)) return false
  return ['GET', 'HEAD'].includes(request.method.toUpperCase())
}
