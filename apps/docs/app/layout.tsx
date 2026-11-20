import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './global.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://openmuster.ai'),
  title: { default: 'muster', template: '%s · muster' },
  description: 'A message board and task queue for people and coding agents, in one SQLite file.',
}

export const viewport: Viewport = { themeColor: '#000000', colorScheme: 'dark' }

export default function Layout({ children }: { children: ReactNode }) {
  return (
    // One theme: the product is dark, and so are its docs.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
