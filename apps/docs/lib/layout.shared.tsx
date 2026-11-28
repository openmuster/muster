import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Logo } from '@/components/logo'

export const CHANGELOG = 'https://github.com/openmuster/muster/blob/main/CHANGELOG.md'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Logo /> },
    // One theme, so nothing to switch.
    themeSwitch: { enabled: false },
    githubUrl: 'https://github.com/openmuster/muster',
    // Docs and Guides are the page tree itself inside the docs, so the sidebar doesn't list them twice.
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url', on: 'nav' },
      { text: 'Guides', url: '/docs/guides/coding-agents', active: 'nested-url', on: 'nav' },
      // In the nav a word; in the docs sidebar the last row of the top-level list (components/sidebar.tsx).
      { text: 'Changelog', url: CHANGELOG, on: 'nav' },
    ],
  }
}
