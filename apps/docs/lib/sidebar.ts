import type * as PageTree from 'fumadocs-core/page-tree'

/** A row in one of the sidebar's views: a page, a link out of the docs, or a group's name. */
export type Row = { type: 'page'; name: PageTree.Node['name']; url: string; external: boolean } | { type: 'label'; name: PageTree.Node['name'] }

/** A top-level folder, shown as its own view: its overview first, then its pages. */
export type Section = { id: string; name: PageTree.Node['name']; rows: Row[] }

/** What the sidebar shows: the top-level rows, where a section is a row that opens it, and each section's view. */
export type Views = {
  main: (Row | { type: 'section'; id: string; name: PageTree.Node['name'] })[]
  sections: Section[]
}

const page = (node: PageTree.Item, name: PageTree.Node['name'] = node.name): Row => ({ type: 'page', name, url: node.url, external: node.external ?? false })

// A folder inside a section is not opened again: its name heads its pages, the way a separator does.
const flatten = (nodes: PageTree.Node[]): Row[] =>
  nodes.flatMap((node): Row[] => {
    if (node.type === 'page') return [page(node)]
    if (node.type === 'separator') return node.name ? [{ type: 'label', name: node.name }] : []
    return [{ type: 'label', name: node.name }, ...(node.index ? [page(node.index, 'Overview')] : []), ...flatten(node.children)]
  })

export function sidebarViews(tree: PageTree.Root): Views {
  const sections: Section[] = []
  const main: Views['main'] = tree.children.flatMap((node, i): Views['main'] => {
    if (node.type === 'page') return [page(node)]
    if (node.type === 'separator') return node.name ? [{ type: 'label', name: node.name }] : []
    const id = node.$id ?? `section-${i}`
    // Fumadocs moves a folder's overview page out of its children and into `index`, so the folder's name
    // could link to it. Here the name opens the folder instead, so the overview goes back in as its first row.
    sections.push({ id, name: node.name, rows: [...(node.index ? [page(node.index, 'Overview')] : []), ...flatten(node.children)] })
    return [{ type: 'section', id, name: node.name }]
  })
  return { main, sections }
}

const trim = (url: string) => (url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url)

/** True when a row's URL is the page at `pathname`. */
export const isCurrent = (url: string, pathname: string) => trim(url) === trim(pathname)

/** The section a page belongs to, so that loading or moving to it shows its view; undefined for a top-level page. */
export function sectionFor(views: Views, pathname: string): string | undefined {
  return views.sections.find((section) => section.rows.some((row) => row.type === 'page' && !row.external && isCurrent(row.url, pathname)))?.id
}
