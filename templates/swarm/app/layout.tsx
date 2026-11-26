import type { ReactNode } from 'react'

export const metadata = { title: 'swarm' }

/** Every size, colour and time is named once, in `:root`; spacing is a multiple of one step. */
const s = (n: number) => `calc(var(--spacing) * ${n})`
/** Below this width, in px, the page is a phone's. A media query can't read a CSS variable. */
const PHONE = 640

const STYLE = `
:root {
  --bg: #000; --fg: #ededed; --dim: #8a8a8a; --line: #2a2a2a; --thumb: #2a2a2a; --thumb-hover: #3a3a3a;
  --spacing: 4px; --hairline: 1px; --text-xs: 12px; --text-sm: 13px; --text: 14px; --text-lg: 16px; --leading: 1.5;
  --font-mono: ui-monospace, Menlo, monospace; --radius: 4px; --radius-lg: 6px; --scrollbar: 6px; --tap: 40px;
  --page: 1100px; --field: 160px; --col: 220px;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --duration-fast: 120ms; --press: 0.97; --faded: 0.5;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root { --bg: #fff; --fg: #111; --dim: #666; --line: #e3e3e3; --thumb: #d4d4d4; --thumb-hover: #b8b8b8; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: var(--text)/var(--leading) var(--font-mono); -webkit-font-smoothing: antialiased; }
::selection { background: var(--fg); color: var(--bg); }
::placeholder { color: var(--dim); opacity: 1; }
:focus-visible { outline: var(--hairline) solid var(--dim); outline-offset: ${s(0.5)}; }
*::-webkit-scrollbar { width: var(--scrollbar); height: var(--scrollbar); }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--thumb); border-radius: var(--radius); }
*::-webkit-scrollbar-thumb:hover { background: var(--thumb-hover); }
@supports not selector(::-webkit-scrollbar) { * { scrollbar-width: thin; scrollbar-color: var(--thumb) transparent; } }
main { max-width: var(--page); margin: 0 auto; padding: ${s(6)} ${s(4)}; }
h1 { font-size: var(--text-lg); margin: 0 0 ${s(4)}; } h2 { font-size: var(--text-sm); color: var(--dim); font-weight: normal; margin: ${s(6)} 0 ${s(2)}; }
a { color: inherit; } label { display: block; margin: ${s(3)} 0 ${s(1)}; color: var(--dim); }
label.check { display: flex; gap: ${s(2)}; align-items: center; } label.check input { width: auto; accent-color: var(--fg); }
input, textarea, select { width: 100%; background: transparent; color: inherit; border: var(--hairline) solid var(--line); border-radius: var(--radius); padding: ${s(2)}; font: inherit; transition: border-color var(--duration-fast); }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: none; border-color: var(--dim); }
button { margin-top: ${s(4)}; background: var(--fg); color: var(--bg); border: 0; border-radius: var(--radius); padding: ${s(2)} ${s(3.5)}; font: inherit; transition: transform var(--duration-fast) var(--ease-out); }
button:active:not(:disabled) { transform: scale(var(--press)); }
button:disabled { opacity: var(--faded); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(var(--col), 1fr)); gap: ${s(4)}; }
.col { border: var(--hairline) solid var(--line); border-radius: var(--radius-lg); padding: ${s(2.5)}; min-width: 0; }
.task { padding: ${s(1.5)} 0; border-top: var(--hairline) solid var(--line); overflow-wrap: anywhere; } .task:first-of-type { border-top: 0; }
.runs { display: flex; gap: ${s(1.5)} ${s(4)}; flex-wrap: wrap; margin: ${s(-2)} 0 ${s(4)}; } .runs a { color: var(--dim); text-decoration: none; } .runs a.on { color: var(--fg); text-decoration: underline; }
.col.empty { opacity: var(--faded); }
.dim { color: var(--dim); font-size: var(--text-xs); overflow-wrap: anywhere; } .row { display: flex; gap: 0 ${s(3)}; flex-wrap: wrap; align-items: flex-end; }
.field { flex: 1 1 var(--field); min-width: 0; } .field.wide { flex-grow: 3; }
/* On a phone the board is one column, so a column with nothing in it is only something to scroll past. */
@media (max-width: ${PHONE - 1}px) { .col.empty { display: none; } }
@media (pointer: coarse) { input, textarea, select { font-size: var(--text-lg); } button { min-height: var(--tap); } .runs a, .task a { display: inline-flex; align-items: center; min-height: var(--tap); } }
@media (prefers-reduced-motion: reduce) { button:active:not(:disabled) { transform: none; } }
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
