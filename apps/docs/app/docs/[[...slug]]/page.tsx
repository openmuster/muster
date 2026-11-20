import type { TableOfContents } from 'fumadocs-core/toc'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page'
import type { MDXProps } from 'mdx/types'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { FC } from 'react'
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
      <DocsDescription>{data.description}</DocsDescription>
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
