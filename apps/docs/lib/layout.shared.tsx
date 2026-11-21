import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Logo } from '@/components/logo'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Logo /> },
    // One theme, so nothing to switch.
    themeSwitch: { enabled: false },
    githubUrl: 'https://github.com/openmuster/muster',
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Guides', url: '/docs/guides/coding-agents', active: 'nested-url' },
      { text: 'Changelog', url: 'https://github.com/openmuster/muster/blob/main/CHANGELOG.md' },
    ],
  }
}
