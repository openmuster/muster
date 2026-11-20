import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Next's dev server would write its own AGENTS.md into this folder; the repository has one already.
  agentRules: false,
  // The docs' markdown lives outside this app, in the package that ships it.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
}

export default createMDX()(config)
