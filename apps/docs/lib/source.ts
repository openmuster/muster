import { loader } from 'fumadocs-core/source'
import { docs } from '@/.source/server'
import { folderTitle, slugsFor } from './markdown'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  // Files are ordered by a number in their name; URLs and the sidebar don't show it.
  slugs: (file) => slugsFor(file.path),
  pageTree: {
    transformers: [
      {
        // The docs' front page is titled after the project, which reads oddly as the first item of
        // its own sidebar.
        file(node) {
          return node.url === '/docs' ? { ...node, name: 'Introduction' } : node
        },
        folder(node) {
          // Without a title of its own a folder is named after its directory, number and all: "01 concepts".
          const name = typeof node.name === 'string' ? node.name : ''
          const named = /^\d+[ -]/.test(name) ? { ...node, name: folderTitle(name.replace(' ', '-')) } : node
          // A folder that opens with an overview page links to it from its own name, rather than listing
          // "Concepts" again as the first page under "Concepts".
          const [first, ...rest] = named.children
          if (!named.index && first?.type === 'page' && first.url.endsWith('/overview')) return { ...named, index: first, children: rest }
          return named
        },
      },
    ],
  },
})
