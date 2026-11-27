/**
 * The page's look. Every size, colour and time is named once, in `:root` or in the constants below, and
 * the rules use the names: spacing is a multiple of one step, the way Tailwind's scale is. The rules are
 * written for a phone first; wider screens add columns. The colours, corners and motion the docs site
 * shares are in `../tokens.ts`, the one place either page writes them.
 */
import { COLOURS, declarations, SHAPE } from '../tokens.ts'

/** Where the layout changes, in px. A media query can't read a CSS variable, so these live here. */
export const BP = { sm: 640, lg: 1024 } as const
/** How narrow the list gets before a row drops its labels, then its channel and ID. */
const ROWS = { labels: 900, where: 560 } as const
/** Icon sizes, in px, for lucide's `size`. */
export const ICON = 14
export const ICON_SMALL = 12

/** `n` steps of the spacing scale. */
const s = (n: number) => `calc(var(--spacing) * ${n})`
const hover = '@media (hover: hover) and (pointer: fine)'
const sm = `@media (min-width: ${BP.sm}px)`
const lg = `@media (min-width: ${BP.lg}px)`

export const STYLE = `
:root {
  ${declarations(COLOURS.dark)} ${declarations(SHAPE)}
  --scrim: rgb(0 0 0 / 0.6); --shade: rgb(0 0 0 / 0.5);
  --spacing: 4px; --hairline: 1px;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-xs: 12px; --text-sm: 13px; --text-base: 16px; --leading: 1.5; --weight-strong: 600;
  --radius-full: 999px;
  --header-h: 48px; --sidebar-w: 240px; --drawer-w: min(280px, 85vw); --pane-w: 420px;
  --scrollbar: 6px; --tap: 40px; --col-state: 84px; --col-event: 124px; --col-id: 44px; --text-min: 180px;
  --duration-pulse: 1.6s;
  --press: 0.97; --faded: 0.5; --disabled: 0.4;
  --z-banner: 5; --z-pane: 10; --z-scrim: 20; --z-drawer: 30; --z-keys: 40; --keys-w: 360px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${declarations(COLOURS.light)} --scrim: rgb(0 0 0 / 0.3); --shade: rgb(0 0 0 / 0.1); color-scheme: light; } }
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: var(--text-sm)/var(--leading) var(--font-mono); cursor: default; -webkit-font-smoothing: antialiased; }
::selection { background: var(--fg); color: var(--bg); }
::placeholder { color: var(--dim); opacity: 1; }
a { color: inherit; text-decoration: none; }
:focus-visible { outline: var(--hairline) solid var(--ring); outline-offset: calc(var(--hairline) * -1); }

*::-webkit-scrollbar { width: var(--scrollbar); height: var(--scrollbar); }
*::-webkit-scrollbar-track, *::-webkit-scrollbar-corner { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--thumb); border-radius: var(--radius-sm); }
*::-webkit-scrollbar-thumb:hover { background: var(--thumb-hover); }
@supports not selector(::-webkit-scrollbar) { * { scrollbar-width: thin; scrollbar-color: var(--thumb) transparent; } }

.app { display: flex; height: 100%; height: 100dvh; }
aside { position: fixed; inset: 0 auto 0 0; z-index: var(--z-drawer); width: var(--drawer-w); background: var(--bg); border-right: var(--hairline) solid var(--line); display: flex; flex-direction: column; user-select: none; transform: translateX(-100%); visibility: hidden; transition: transform var(--duration) var(--ease-out), visibility 0s linear var(--duration); }
.app.menu aside { transform: none; visibility: visible; transition-delay: 0s; }
.scrim { position: fixed; inset: 0; z-index: var(--z-scrim); background: var(--scrim); opacity: 0; pointer-events: none; transition: opacity var(--duration) var(--ease-out); }
.app.menu .scrim { opacity: 1; pointer-events: auto; }
.board { padding: ${s(3.5)} ${s(4)}; border-bottom: var(--hairline) solid var(--line); display: flex; flex-direction: column; }
.board b { display: flex; align-items: center; gap: ${s(2)}; }
.board .mark { flex: none; }
.board span { color: var(--dim); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav { flex: 1; overflow: auto; padding: ${s(2)}; }
nav + nav { flex: none; overflow: visible; border-top: var(--hairline) solid var(--line); }
nav a { display: flex; align-items: center; gap: ${s(2)}; padding: ${s(1.5)} ${s(2)}; border-radius: var(--radius); white-space: nowrap; transition: background-color var(--duration-fast); }
nav a svg { flex: none; color: var(--dim); }
nav a.on { background: var(--hover); font-weight: var(--weight-strong); }
/* Asking to notify sits in the list as one more row, not as the page's one loud button. */
nav button.ask { display: flex; align-items: center; gap: ${s(2)}; width: 100%; margin: 0; padding: ${s(1.5)} ${s(2)}; border-radius: var(--radius); background: none; color: var(--dim); text-align: left; transition: background-color var(--duration-fast); }
nav button.ask svg { flex: none; }
nav a.on svg { color: var(--fg); }
nav a i { margin-left: auto; padding: 0 ${s(1.5)}; border: var(--hairline) solid var(--line); border-radius: var(--radius-full); font-style: normal; font-weight: normal; font-size: var(--text-xs); color: var(--dim); }
nav h6 { margin: ${s(3.5)} ${s(2)} ${s(1)}; font-size: var(--text-xs); font-weight: normal; color: var(--dim); }
.path { display: flex; min-width: 0; }
.path .in { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
.path .leaf { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.as { padding: ${s(2.5)} ${s(4)}; border-top: var(--hairline) solid var(--line); color: var(--dim); display: flex; gap: ${s(2)}; align-items: center; }
.as input { flex: 1; min-width: 0; }

main { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: ${s(3)}; flex: none; height: var(--header-h); padding: 0 ${s(4)}; border-bottom: var(--hairline) solid var(--line); user-select: none; }
header b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-strong); }
header span { flex: none; color: var(--dim); }
/* Wider than "● reconnecting" (14 characters) from the first paint, with room for a font a little
   wider than the ch, and the word after the dot always starts in one place: the word changing moves
   nothing. */
header em { flex: none; margin-left: auto; min-width: 16ch; font-style: normal; color: var(--dim); }
header em::before { content: "● "; }
header em.live::before { color: var(--fg); }
header em.down { animation: pulse var(--duration-pulse) ease-in-out infinite; }
@keyframes pulse { 50% { opacity: var(--faded); } }
.icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: ${s(6)}; height: ${s(6)}; margin: 0; padding: 0; border: none; border-radius: var(--radius); background: none; color: var(--dim); transition: transform var(--duration-fast) var(--ease-out), background-color var(--duration-fast); }
header a.icon { margin-left: auto; }
.tabs { display: flex; gap: ${s(5)}; padding: ${s(2.5)} ${s(4)} 0; border-bottom: var(--hairline) solid var(--line); overflow-x: auto; scrollbar-width: none; user-select: none; }
.tabs::-webkit-scrollbar { display: none; }
.tabs a { display: flex; align-items: center; padding-bottom: ${s(2)}; border-bottom: var(--hairline) solid transparent; color: var(--dim); white-space: nowrap; transition: color var(--duration-fast); }
.tabs a.on { color: var(--fg); border-bottom-color: var(--fg); }
.rows { flex: 1; overflow: auto; container-type: inline-size; }
.row { display: flex; align-items: center; gap: ${s(2.5)}; padding: ${s(2)} ${s(4)}; white-space: nowrap; overflow: hidden; }
.row, .thread { transition: background-color var(--duration-fast); }
.row.on, .thread.on, .row:focus-visible, .thread:focus-visible { background: var(--hover); }
.row code { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.row .meta { flex: none; }
.row .state { width: var(--col-state); flex: none; color: var(--dim); }
.row.claimed .state, .row.ready .state { color: var(--fg); }
.row.event .state { width: var(--col-event); overflow: hidden; text-overflow: ellipsis; }
.row .id { color: var(--dim); width: var(--col-id); flex: none; }
.row .text { overflow: hidden; text-overflow: ellipsis; flex: 0 1000 auto; min-width: var(--text-min); }
@container (max-width: ${ROWS.labels}px) { .row code { display: none; } }
@container (max-width: ${ROWS.where}px) { .row .meta.where, .row .id { display: none; } .row .text { min-width: 0; } }
.grow { flex: 1; }
.meta { color: var(--dim); font-size: var(--text-xs); }
code { border: var(--hairline) solid var(--line); border-radius: var(--radius-sm); padding: 0 ${s(1)}; font: inherit; font-size: var(--text-xs); color: var(--dim); }
.thread { padding: ${s(2.5)} ${s(4)}; }
.thread .by, article .by { color: var(--dim); font-size: var(--text-xs); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text; }
.row .text { white-space: nowrap; cursor: default; }
.pending { opacity: var(--faded); }
.empty { color: var(--dim); padding: ${s(4)}; margin: 0; }
.error { margin: 0; padding: ${s(2)} ${s(4)}; border-bottom: var(--hairline) solid var(--line); transition: opacity var(--duration) var(--ease-out), transform var(--duration) var(--ease-out); }
/* What went wrong with a read or a write lies over the top of the list, under the header, rather than
   pushing the list down: nothing moves after it is drawn. A click takes it away. */
.error.banner { position: absolute; top: var(--header-h); inset-inline: 0; z-index: var(--z-banner); background: var(--bg); }
@starting-style { .error { opacity: 0; transform: translateY(calc(var(--spacing) * -1)); } }
.composer { border-top: var(--hairline) dashed var(--line); padding: ${s(2.5)} ${s(4)}; display: flex; flex-direction: column; gap: ${s(1.5)}; }
.composer:focus-within { border-top-style: solid; }
input, textarea { background: var(--panel); color: var(--fg); border: var(--hairline) solid var(--line); border-radius: var(--radius); padding: ${s(1.5)} ${s(2)}; font: inherit; cursor: text; transition: border-color var(--duration-fast); }
input:focus-visible, select:focus-visible { outline: none; border-color: var(--ring); }
input[type="checkbox"] { accent-color: var(--fg); cursor: default; }
textarea { resize: none; border: none; background: none; padding: ${s(1)} 0; outline: none; }
.bar { display: flex; align-items: center; gap: ${s(3)}; color: var(--dim); font-size: var(--text-xs); user-select: none; }
.bar.wrap { flex-wrap: wrap; }
.bar .hint { display: none; min-width: 0; }
button.quiet { margin-left: 0; background: none; color: var(--dim); border: var(--hairline) solid var(--line); }
select { background: var(--panel); color: var(--fg); border: var(--hairline) solid var(--line); border-radius: var(--radius); padding: ${s(1.5)}; font: inherit; transition: border-color var(--duration-fast); }
button { flex: none; margin-left: auto; background: var(--fg); color: var(--bg); border: none; border-radius: var(--radius-sm); padding: ${s(1.5)} ${s(3)}; font: inherit; white-space: nowrap; cursor: default; transition: transform var(--duration-fast) var(--ease-out); }
button:active:not(:disabled), .icon:active { transform: scale(var(--press)); }
button:disabled { opacity: var(--disabled); }
.pane { position: fixed; inset: 0; z-index: var(--z-pane); background: var(--bg); display: flex; flex-direction: column; transition: opacity var(--duration) var(--ease-out), transform var(--duration) var(--ease-out); }
@starting-style { .pane { opacity: 0; transform: translateX(${s(3)}); } }
.messages { flex: 1; overflow: auto; }
/* The list of every key, from ?: over everything, the page dimmed under it. */
.veil { position: fixed; inset: 0; z-index: var(--z-keys); background: var(--scrim); }
.keys { position: fixed; z-index: var(--z-keys); top: ${s(16)}; left: 50%; translate: -50% 0; width: min(var(--keys-w), calc(100% - ${s(8)})); background: var(--bg); border: var(--hairline) solid var(--line); border-radius: var(--radius); outline: none; transition: opacity var(--duration) var(--ease-out); }
@starting-style { .keys { opacity: 0; } }
.keys header { height: auto; padding: ${s(2.5)} ${s(4)}; }
.keys header .icon { margin-left: auto; }
.keys dl { display: grid; grid-template-columns: max-content 1fr; gap: ${s(2)} ${s(4)}; margin: 0; padding: ${s(3)} ${s(4)} ${s(4)}; }
.keys dl div { display: contents; }
.keys dd { margin: 0; color: var(--dim); }
kbd { border: var(--hairline) solid var(--line); border-radius: var(--radius-sm); padding: 0 ${s(1)}; font: inherit; }
article { padding: ${s(2.5)} ${s(4)}; }
.labels { display: flex; gap: ${s(1.5)}; align-items: center; margin-top: ${s(1)}; color: var(--dim); flex-wrap: wrap; }
/* A label is one line: a long value is cut short, whole in its tooltip. */
.labels code { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

${hover} { nav a:hover, nav button.ask:hover, .row:hover, .thread:hover, .icon:hover { background: var(--hover); transition-duration: 0s; } .tabs a:hover { color: var(--fg); } }
@media (pointer: coarse) { nav a, nav button.ask, .tabs a, .row { min-height: var(--tap); } .icon { width: var(--tap); height: var(--tap); } input, textarea, select { font-size: var(--text-base); } }
${sm} {
  aside { position: static; width: var(--sidebar-w); flex: none; transform: none; visibility: visible; transition: none; }
  .scrim, .burger { display: none; }
  .bar .hint { display: inline; }
  .pane { inset: 0 0 0 auto; width: min(var(--pane-w), 100%); border-left: var(--hairline) solid var(--line); box-shadow: ${s(-4)} 0 ${s(8)} var(--shade); }
}
${lg} { .pane { position: static; flex: none; width: var(--pane-w); box-shadow: none; } }
/* Two screens side by side, with a hinge between: the board on the left one, the thread on the right. */
@media (horizontal-viewport-segments: 2) {
  .app { max-width: env(viewport-segment-right 0 0, 100%); }
  .pane { position: fixed; inset: 0 0 0 env(viewport-segment-left 1 0, auto); width: auto; box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) {
  .pane, .error { transition-property: opacity; }
  aside { transition: none; }
  header em.down { animation: none; }
  button:active:not(:disabled), .icon:active { transform: none; }
}
`
