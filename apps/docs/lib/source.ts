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
        folder(node) {
          // Without a title of its own a folder is named after its directory, number and all: "01 concepts".
          const name = typeof node.name === 'string' ? node.name : ''
          return /^\d+[ -]/.test(name) ? { ...node, name: folderTitle(name.replace(' ', '-')) } : node
        },
      },
    ],
  },
})
