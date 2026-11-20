import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { remarkMuster } from './lib/markdown'

// The pages are muster's own docs, read where they live: the package ships them, the site renders them.
export const docs = defineDocs({ dir: '../../packages/muster/docs' })

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkMuster, { docsDir: 'packages/muster/docs' }], remarkMdxMermaid],
  },
})
