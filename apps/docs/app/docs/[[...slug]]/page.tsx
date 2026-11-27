import type { TableOfContents } from 'fumadocs-core/toc'
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page'
import type { MDXProps } from 'mdx/types'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { FC } from 'react'
import { REPO } from '@/lib/markdown'
import { source } from '@/lib/source'
import { getMDXComponents } from '@/mdx-components'

type Data = { title: string; description?: string; body: FC<MDXProps>; toc: TableOfContents }
type Props = { params: Promise<{ slug?: string[] }> }

export default async function Page({ params }: Props) {
  const page = source.getPage((await params).slug)
  if (!page) notFound()
  const data = page.data as unknown as Data
  const Body = data.body
  return (
    <DocsPage toc={data.toc}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription className="mb-0">{data.description}</DocsDescription>
      {/* The page as Markdown, to copy or hand to an assistant: the same text /llms.txt links to. */}
      <div className="flex flex-row items-center gap-2 pb-2">
        <MarkdownCopyButton markdownUrl={`${page.url}.md`} />
        <ViewOptionsPopover markdownUrl={`${page.url}.md`} githubUrl={`${REPO}/packages/muster/docs/${page.path}`} pageUrl={`https://openmuster.ai${page.url}`} />
      </div>
      <DocsBody>
        <Body components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug)
  if (!page) notFound()
  return { title: page.data.title, description: page.data.description }
}
