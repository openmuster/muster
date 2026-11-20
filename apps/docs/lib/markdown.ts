// How muster's plain markdown becomes site pages. The docs stay readable on GitHub and in
// node_modules; these functions bridge their conventions to the site at build time.
import { posix } from 'node:path'

/** `01-concepts` is ordered by its prefix on disk and is `concepts` in a URL. */
export const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

/** A folder's name in the sidebar. */
export function folderTitle(segment: string): string {
  const name = stripOrder(segment)
  return name === 'sync' ? 'Sync' : name.charAt(0).toUpperCase() + name.slice(1)
}

/** The URL path segments for a docs file: `01-concepts/08-tasks.md` is `concepts/tasks`, `index.md` is the root. */
export function slugsFor(path: string): string[] {
  const parts = path.replace(/\.mdx?$/, '').split('/').map(stripOrder)
  if (parts.at(-1) === 'index') parts.pop()
  return parts
}

export const REPO = 'https://github.com/openmuster/muster/blob/main'

/**
 * Where a link in a docs page goes on the site. A relative link to another docs page becomes its
 * route; one that leaves the docs folder (the README, a template) goes to the repository; anything
 * absolute, or an anchor on the same page, is left alone.
 * `from` is the linking file's path inside the docs folder, such as `03-guides/02-swarm.md`.
 */
export function routeFor(from: string, href: string, docsRoot = 'packages/muster/docs'): string {
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href
  const [file = '', hash] = href.split('#')
  const target = posix.normalize(posix.join(posix.dirname(from), file))
  const anchor = hash ? `#${hash}` : ''
  if (target.startsWith('..')) return `${REPO}/${posix.normalize(posix.join(docsRoot, target))}${anchor}`
  if (!/\.mdx?$/.test(target)) return `${REPO}/${docsRoot}/${target}${anchor}`
  const slugs = slugsFor(target)
  return `/docs${slugs.length ? `/${slugs.join('/')}` : ''}${anchor}`
}

/** GitHub's `> [!NOTE]` kinds, as the site's callout types. */
export const CALLOUTS: Record<string, string> = { NOTE: 'info', TIP: 'info', IMPORTANT: 'info', WARNING: 'warn', CAUTION: 'error' }

/**
 * A code fence's info string. The docs write a filename after the language (```ts boards.ts) and
 * mark a guide's tested steps (```bash steps); the site shows the first as a title and drops the second.
 */
export function fenceMeta(meta: string | null | undefined): string | null {
  const text = (meta ?? '').trim()
  if (!text || text === 'steps') return null
  if (/=/.test(text)) return text
  return `title="${text.replaceAll('"', '')}"`
}

type Node = { type: string; url?: string; value?: string; meta?: string | null; lang?: string | null; children?: Node[]; name?: string; attributes?: unknown[] }

/** The remark plugin that applies the three rules above to a page. */
export function remarkMuster(options: { docsDir: string }) {
  return (tree: Node, file: { path?: string }) => {
    const absolute = (file.path ?? '').replaceAll('\\', '/')
    const marker = `${options.docsDir.replace(/\/$/, '')}/`
    const at = absolute.lastIndexOf(marker)
    const from = at === -1 ? 'index.md' : absolute.slice(at + marker.length)
    const visit = (node: Node) => {
      if (node.type === 'link' && typeof node.url === 'string') node.url = routeFor(from, node.url)
      if (node.type === 'code' && node.lang !== 'mermaid') node.meta = fenceMeta(node.meta)
      if (node.type === 'blockquote') {
        const first = node.children?.[0]
        const text = first?.type === 'paragraph' ? first.children?.[0] : undefined
        const kind = text?.type === 'text' ? /^\[!(\w+)\]\s*/.exec(text.value ?? '') : null
        if (kind && text && CALLOUTS[kind[1]!]) {
          text.value = (text.value ?? '').slice(kind[0].length)
          node.type = 'mdxJsxFlowElement'
          node.name = 'Callout'
          node.attributes = [{ type: 'mdxJsxAttribute', name: 'type', value: CALLOUTS[kind[1]!] }]
        }
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}
