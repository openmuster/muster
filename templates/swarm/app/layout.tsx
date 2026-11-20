import type { ReactNode } from 'react'

export const metadata = { title: 'swarm' }

const STYLE = `
:root { --bg:#000; --fg:#ededed; --dim:#8a8a8a; --line:#2a2a2a; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg:#fff; --fg:#111; --dim:#666; --line:#e3e3e3; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace, Menlo, monospace; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 16px; margin: 0 0 16px; } h2 { font-size: 13px; color: var(--dim); font-weight: normal; margin: 24px 0 8px; }
a { color: inherit; } label { display:block; margin: 12px 0 4px; color: var(--dim); }
input, textarea, select { width:100%; background:transparent; color:inherit; border:1px solid var(--line); border-radius:4px; padding:8px; font:inherit; }
button { margin-top:16px; background:var(--fg); color:var(--bg); border:0; border-radius:4px; padding:8px 14px; font:inherit; }
.cols { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.col { border:1px solid var(--line); border-radius:6px; padding:10px; min-width:0; }
.task { padding:6px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; } .task:first-of-type { border-top:0; }
.dim { color: var(--dim); font-size: 12px; } .row { display:flex; gap:12px; flex-wrap:wrap; }
`

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{STYLE}</style>
        <main>{children}</main>
      </body>
    </html>
  )
}
