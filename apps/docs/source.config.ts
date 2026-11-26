import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { remarkMuster } from './lib/markdown'

// The pages are muster's own docs, read where they live: the package ships them, the site renders them.
// Each page also keeps its Markdown after our remark rules have run (links already pointing at site
// routes), so an agent can read it as text: see lib/llms.ts.
export const docs = defineDocs({
  dir: '../../packages/muster/docs',
  docs: { postprocess: { includeProcessedMarkdown: true } },
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkMuster, { docsDir: 'packages/muster/docs' }], remarkMdxMermaid],
  },
})
