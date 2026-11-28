import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { SidebarProvider, SidebarTrigger, useSidebar } from 'fumadocs-ui/layouts/docs/slots/sidebar'
import type { ReactNode } from 'react'
import { DocsSidebar } from '@/components/sidebar'
import { baseOptions } from '@/lib/layout.shared'
import { source } from '@/lib/source'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.pageTree} {...baseOptions()} slots={{ sidebar: { provider: SidebarProvider, root: DocsSidebar, trigger: SidebarTrigger, useSidebar } }}>
      {children}
    </DocsLayout>
  )
}
