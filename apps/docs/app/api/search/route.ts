import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '@/lib/source'

// The search index is built from the pages themselves: nothing leaves the site to answer a query.
export const { GET } = createFromSource(source)
