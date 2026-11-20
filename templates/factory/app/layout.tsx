import type { ReactNode } from 'react'

export const metadata = { title: 'factory' }

const STYLE = `
:root { --bg:#000; --fg:#ededed; --dim:#8a8a8a; --line:#2a2a2a; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg:#fff; --fg:#111; --dim:#666; --line:#e3e3e3; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace, Menlo, monospace; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 16px; margin: 0 0 4px; } h2 { font-size: 13px; color: var(--dim); font-weight: normal; margin: 28px 0 8px; }
a { color: inherit; } .dim { color: var(--dim); font-size: 12px; }
.item { padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; } .item:first-of-type { border-top: 0; }
.text { white-space: pre-wrap; } code { color: var(--dim); }
textarea { width:100%; background:transparent; color:inherit; border:1px solid var(--line); border-radius:4px; padding:8px; font:inherit; }
button { margin-top:8px; background:var(--fg); color:var(--bg); border:0; border-radius:4px; padding:6px 12px; font:inherit; }
nav { display:flex; gap:16px; margin-bottom: 20px; }
`

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{STYLE}</style>
        <main>
          <nav>
            <a href="/">factory</a>
            <a href="/board">board</a>
          </nav>
          {children}
        </main>
      </body>
    </html>
  )
}
