import type * as PageTree from 'fumadocs-core/page-tree'
import { describe, expect, it } from 'vitest'
import { type Row, sectionFor, sidebarViews } from '../lib/sidebar'

// The page tree Fumadocs builds from the docs folder, after lib/source.ts has moved each overview page
// into its folder's `index`.
const p = (name: string, url: string): PageTree.Item => ({ type: 'page', name, url })
const tree: PageTree.Root = {
  name: 'Docs',
  children: [
    p('Introduction', '/docs'),
    p('Quickstart', '/docs/quickstart'),
    { type: 'folder', $id: 'concepts', name: 'Concepts', index: p('Concepts', '/docs/concepts/overview'), children: [p('Tasks', '/docs/concepts/tasks')] },
    {
      type: 'folder',
      $id: 'guides',
      name: 'Guides',
      children: [
        { type: 'separator', name: 'Agents on a board' },
        p('Coding agents', '/docs/guides/coding-agents'),
        { type: 'separator', name: 'Patterns' },
        p('Two agents', '/docs/guides/two-agents'),
      ],
    },
  ],
}

const urls = (rows: (Row | { type: 'section' })[]) => rows.flatMap((row) => (row.type === 'page' ? [row.url] : []))

describe('the sidebar views', () => {
  const views = sidebarViews(tree)

  it('lists top-level pages, then each section as a row that opens it', () => {
    expect(views.main.map((row) => [row.type, row.name])).toEqual([
      ['page', 'Introduction'],
      ['page', 'Quickstart'],
      ['section', 'Concepts'],
      ['section', 'Guides'],
    ])
  })

  it("puts a section's overview back as its first row, since the section's name no longer links to it", () => {
    const concepts = views.sections.find((s) => s.id === 'concepts')
    expect(concepts?.rows).toEqual([
      { type: 'page', name: 'Overview', url: '/docs/concepts/overview', external: false },
      { type: 'page', name: 'Tasks', url: '/docs/concepts/tasks', external: false },
    ])
  })

  it("keeps a section's group names as labels over their pages", () => {
    const guides = views.sections.find((s) => s.id === 'guides')
    expect(guides?.rows.map((row) => row.name)).toEqual(['Agents on a board', 'Coding agents', 'Patterns', 'Two agents'])
  })

  it('shows every page in exactly one view', () => {
    const all = [...urls(views.main), ...views.sections.flatMap((s) => urls(s.rows))]
    expect(all.sort()).toEqual(['/docs', '/docs/concepts/overview', '/docs/concepts/tasks', '/docs/guides/coding-agents', '/docs/guides/two-agents', '/docs/quickstart'])
  })
})

describe('the view a page opens in', () => {
  const views = sidebarViews(tree)

  it('is the top-level list for a top-level page', () => {
    expect(sectionFor(views, '/docs')).toBeUndefined()
    expect(sectionFor(views, '/docs/quickstart/')).toBeUndefined()
  })

  it("is the page's section, overview included", () => {
    expect(sectionFor(views, '/docs/concepts/overview')).toBe('concepts')
    expect(sectionFor(views, '/docs/guides/two-agents')).toBe('guides')
    expect(sectionFor(views, '/docs/guides/two-agents/')).toBe('guides')
  })

  it('is the top-level list for a path that is no page', () => {
    expect(sectionFor(views, '/docs/nowhere')).toBeUndefined()
  })
})
