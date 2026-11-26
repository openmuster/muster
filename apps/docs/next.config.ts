import { createMDX } from 'fumadocs-mdx/next'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import type { NextConfig } from 'next'

const here = new URL('.', import.meta.url).pathname
/** A package's ESM-only entry point, read from its own exports map (Next loads this file as CommonJS). */
function esmEntry(name: string, subpath: string): string {
  const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`)
  const target = JSON.parse(readFileSync(manifest, 'utf8')).exports[subpath].import as string
  return `./${relative(here, join(dirname(manifest), target))}`
}

const config: NextConfig = {
  reactStrictMode: true,
  // Next's dev server would write its own AGENTS.md into this folder; the repository has one already.
  agentRules: false,
  // The docs' markdown lives outside this app, in the package that ships it.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // The compiled pages import fumadocs-core from where the markdown lives, in packages/muster, which
  // doesn't depend on it. They get this app's copy.
  turbopack: {
    resolveAlias: { 'fumadocs-core/server': esmEntry('fumadocs-core', './server') },
  },
  // The text files for agents are served from one route (app/llms) at the addresses agents look for.
  async rewrites() {
    return [
      { source: '/llms.txt', destination: '/llms/llms.txt' },
      { source: '/llms-full.txt', destination: '/llms/llms-full.txt' },
      { source: '/docs.md', destination: '/llms/docs.md' },
      { source: '/docs/:path*.md', destination: '/llms/docs/:path*.md' },
    ]
  },
}

export default createMDX()(config)
