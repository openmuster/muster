import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fenceMeta, folderTitle, forAgents, remarkMuster, routeFor, slugsFor } from '../lib/markdown'

const docs = fileURLToPath(new URL('../../../packages/muster/docs', import.meta.url))
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []))
const pages = walk(docs).map((file) => relative(docs, file))

describe('from a docs file to a site route', () => {
  it('drops the numbers that order files on disk, and the root index is the docs home', () => {
    expect(slugsFor('01-concepts/08-tasks.md')).toEqual(['concepts', 'tasks'])
    expect(slugsFor('01-quickstart.md')).toEqual(['quickstart'])
    expect(slugsFor('index.md')).toEqual([])
    expect(folderTitle('01-concepts')).toBe('Concepts')
    expect(folderTitle('02-sync')).toBe('Sync')
  })

  it('no two pages land on the same route', () => {
    const routes = pages.map((page) => slugsFor(page).join('/'))
    expect(new Set(routes).size).toBe(routes.length)
    expect(routes.length).toBeGreaterThan(30)
  })
})

describe('links in a docs page', () => {
  it('a relative link to another page becomes its route, anchor kept', () => {
    expect(routeFor('03-guides/02-swarm.md', './10-two-agents.md')).toBe('/docs/guides/two-agents')
    expect(routeFor('03-guides/02-swarm.md', '../01-concepts/08-tasks.md#claims')).toBe('/docs/concepts/tasks#claims')
    expect(routeFor('index.md', './01-quickstart.md')).toBe('/docs/quickstart')
    expect(routeFor('01-quickstart.md', './index.md')).toBe('/docs')
  })

  it('a link out of the docs folder goes to the repository, and absolute ones are left alone', () => {
    expect(routeFor('03-guides/02-swarm.md', '../../../../templates/swarm/README.md')).toBe('https://github.com/openmuster/muster/blob/main/templates/swarm/README.md')
    expect(routeFor('index.md', 'https://example.com/x.md')).toBe('https://example.com/x.md')
    expect(routeFor('index.md', '#here')).toBe('#here')
    expect(routeFor('index.md', '/docs/quickstart')).toBe('/docs/quickstart')
  })

  it('every relative link in the real docs resolves to a page that exists', () => {
    const routes = new Set(pages.map((page) => `/docs${slugsFor(page).length ? `/${slugsFor(page).join('/')}` : ''}`))
    const broken: string[] = []
    for (const page of pages) {
      for (const link of readFileSync(join(docs, page), 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        const route = routeFor(page, link[1]!)
        if (route.startsWith('/docs') && !routes.has(route.split('#')[0]!)) broken.push(`${page}: ${link[1]} -> ${route}`)
      }
    }
    expect(broken).toEqual([])
  })
})

describe('what the site does with the docs\' own markup', () => {
  it('a filename after a fence\'s language is its title, and the mark for tested steps is dropped', () => {
    expect(fenceMeta('boards.ts')).toBe('title="boards.ts"')
    expect(fenceMeta('steps')).toBeNull()
    expect(fenceMeta('')).toBeNull()
    expect(fenceMeta('title="x"')).toBe('title="x"')
  })

  it('a GitHub note becomes a callout, a plain quote stays a quote, and a diagram is left for its own plugin', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!WARNING]\nCareful.' }] }] },
        { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Just a quote.' }] }] },
        { type: 'code', lang: 'mermaid', meta: null, value: 'flowchart LR' },
        { type: 'paragraph', children: [{ type: 'link', url: './01-quickstart.md', children: [] }] },
      ],
    }
    remarkMuster({ docsDir: 'packages/muster/docs' })(tree as never, { path: '/repo/packages/muster/docs/index.md' })
    const [note, quote, diagram, para] = tree.children as any[]
    expect([note.type, note.name, note.attributes[0].value, note.children[0].children[0].value]).toEqual(['mdxJsxFlowElement', 'Callout', 'warn', 'Careful.'])
    expect(quote.type).toBe('blockquote')
    expect(diagram.meta).toBeNull()
    expect(para.children[0].url).toBe('/docs/quickstart')
  })
})

describe('a page as text for agents', () => {
  it('points links at the other pages\' Markdown, keeping anchors, and leaves links out of the docs as they are', () => {
    const page = 'See [Access](./01-concepts/11-access.md#tokens), [the README](../../../README.md) and [Node](https://nodejs.org).'
    expect(forAgents(page, '01-quickstart.md')).toBe(
      'See [Access](/docs/concepts/access.md#tokens), [the README](https://github.com/openmuster/muster/blob/main/README.md) and [Node](https://nodejs.org).',
    )
    expect(forAgents('[Home](../index.md)', '03-guides/02-swarm.md')).toBe('[Home](/docs.md)')
  })

  it('drops the anchor Fumadocs puts after a heading, and touches nothing inside a code block', () => {
    const page = ['## Install [#install]', '', '```md', '## Kept [#kept]', '[x](./a.md)', '```', '### After [#after]'].join('\n')
    expect(forAgents(page, 'index.md')).toBe(['## Install', '', '```md', '## Kept [#kept]', '[x](./a.md)', '```', '### After'].join('\n'))
  })
})
