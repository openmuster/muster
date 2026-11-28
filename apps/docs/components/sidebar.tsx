'use client'

import { usePathname } from 'fumadocs-core/framework'
import Link from 'fumadocs-core/link'
import type * as PageTree from 'fumadocs-core/page-tree'
import { SidebarItem } from 'fumadocs-ui/components/sidebar/base'
import { TreeContextProvider, useTreeContext } from 'fumadocs-ui/contexts/tree'
import { Sidebar, type SidebarProps } from 'fumadocs-ui/layouts/docs/slots/sidebar'
import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { createContext, use, useEffect, useMemo, useRef, useState } from 'react'
import { CHANGELOG } from '@/lib/layout.shared'
import { isCurrent, type Row, sectionFor, sidebarViews } from '@/lib/sidebar'

/*
 * The docs sidebar as two views in one place: the top-level pages and sections, and the pages of one
 * section with a way back. Opening a section slides the list out to the left and the section in from the
 * right; going back reverses it.
 *
 * Fumadocs' sidebar keeps its header, search, collapse button, footer and mobile drawer. Only the page
 * tree inside it is replaced: Fumadocs renders the tree's top-level nodes one by one, with no element
 * around them to hold two views, so the sidebar is handed a tree of one empty folder, and that folder is
 * drawn as both views of the real tree. The page itself (breadcrumb, previous and next) still reads the
 * real tree from the layout.
 */

const RealTree = createContext<PageTree.Root | null>(null)

const shell: PageTree.Root = { $id: 'muster-sidebar', name: '', children: [{ type: 'folder', $id: 'muster-sidebar-views', name: '', children: [] }] }

export function DocsSidebar(props: SidebarProps) {
  const { full } = useTreeContext()
  return (
    <RealTree value={full}>
      <TreeContextProvider tree={shell}>
        <Sidebar {...props} components={{ Folder: Views }} />
      </TreeContextProvider>
    </RealTree>
  )
}

const changelog: Row = { type: 'page', name: 'Changelog', url: CHANGELOG, external: true }

// A view at rest sits in the flow, so the sidebar scrolls to its height; a view out of sight lies over it,
// 12px to the side, faded out, and can't be clicked or tabbed into.
const layer = 'flex flex-col gap-0.5 transition-[opacity,translate] duration-200 ease-(--ease-muster-out)'
const shown = 'relative translate-x-0 opacity-100'
const hidden = 'pointer-events-none absolute inset-x-0 top-0 opacity-0'

const row =
  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-start wrap-anywhere transition-colors hover:bg-fd-accent hover:text-fd-foreground data-[active=true]:bg-(--muster-current) data-[active=true]:text-fd-foreground [&_svg]:ms-auto [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fd-muted-foreground'

function Views() {
  const tree = use(RealTree)
  if (!tree) throw new Error('DocsSidebar draws the views')
  const views = useMemo(() => sidebarViews(tree), [tree])
  const pathname = usePathname()

  // Set while rendering, not in an effect, so a page loaded inside a section is served with that section open.
  const [view, setView] = useState(() => sectionFor(views, pathname))
  // The last section opened stays drawn while it fades out on the way back.
  const [opened, setOpened] = useState(view)
  const [seen, setSeen] = useState(pathname)
  if (seen !== pathname) {
    // Moving to another page shows the view it is in. Only then: going back by hand isn't undone.
    const next = sectionFor(views, pathname)
    setSeen(pathname)
    setView(next)
    if (next) setOpened(next)
  }

  const root = useRef<HTMLDivElement>(null)
  const focus = useRef<string | null>(null)
  const go = (next: string | undefined, from?: string) => {
    setView(next)
    if (next) setOpened(next)
    focus.current = next ? 'back' : (from ?? null)
    root.current?.closest('[data-radix-scroll-area-viewport]')?.scrollTo({ top: 0 })
  }
  // After a click, focus follows into the view that came in: the back button, or the section just left.
  useEffect(() => {
    const target = focus.current
    focus.current = null
    if (target) root.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus({ preventScroll: true })
  }, [view])

  const section = views.sections.find((s) => s.id === opened)

  return (
    <div ref={root} className="relative">
      <div className={`${layer} ${view ? `${hidden} -translate-x-3` : shown}`} inert={view !== undefined}>
        {[...views.main, changelog].map((node, i) =>
          node.type === 'section' ? (
            <button key={node.id} type="button" className={`${row} cursor-pointer text-(--muster-soft)`} data-focus={node.id} onClick={() => go(node.id)}>
              {node.name}
              <ChevronRight aria-hidden />
            </button>
          ) : (
            <RowItem key={i} row={node} pathname={pathname} className="text-(--muster-soft)" />
          ),
        )}
      </div>

      <div className={`${layer} ${view ? shown : `${hidden} translate-x-3`}`} inert={view === undefined}>
        {section && (
          <>
            {/* The whole row goes back, the way a row opens a section: chevron at the start, name centred. */}
            <button
              type="button"
              className="mb-1 grid cursor-pointer grid-cols-[1rem_1fr_1rem] items-center gap-2 rounded-md px-2.5 py-1.5 font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              data-focus="back"
              onClick={() => go(undefined, section.id)}
            >
              <ChevronLeft className="size-4" aria-hidden />
              <span className="truncate text-center">
                <span className="sr-only">Back from </span>
                {section.name}
              </span>
            </button>
            {section.rows.map((r, i) => (
              <RowItem key={i} row={r} pathname={pathname} className="text-fd-foreground" />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function RowItem({ row: r, pathname, className }: { row: Row; pathname: string; className: string }) {
  if (r.type === 'label') return <p className="muster-sidebar-label">{r.name}</p>
  if (r.external)
    return (
      <Link href={r.url} external className={`${row} ${className}`}>
        {r.name}
        <ArrowUpRight aria-hidden />
      </Link>
    )
  // Fumadocs' item marks the current page and scrolls it into view.
  return (
    <SidebarItem href={r.url} active={isCurrent(r.url, pathname)} className={`${row} ${className}`}>
      {r.name}
    </SidebarItem>
  )
}
