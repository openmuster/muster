export const STYLE = `
:root { --bg: #000; --fg: #ededed; --dim: #8a8a8a; --line: #2a2a2a; --panel: #0a0a0a; --hover: #151515; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg: #fff; --fg: #111; --dim: #666; --line: #e3e3e3; --panel: #fafafa; --hover: #f0f0f0; color-scheme: light; } }
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; cursor: default; }
.app { display: flex; height: 100%; }
aside { width: 220px; flex: none; border-right: 1px solid var(--line); display: flex; flex-direction: column; }
.board { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; }
.board span { color: var(--dim); font-size: 12px; }
nav { flex: 1; overflow: auto; padding: 8px; }
nav a { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; color: var(--fg); }
nav a:hover, nav a.on { background: var(--hover); }
nav a i { margin-left: auto; font-style: normal; color: var(--dim); }
nav h6 { margin: 14px 8px 4px; font-size: 12px; font-weight: normal; color: var(--dim); }
.as { padding: 10px 16px; border-top: 1px solid var(--line); color: var(--dim); display: flex; gap: 8px; align-items: center; }
.as input { flex: 1; min-width: 0; }
main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
header { display: flex; align-items: baseline; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
header span { color: var(--dim); }
header em { margin-left: auto; font-style: normal; color: var(--dim); }
header em.live::before { content: "● "; color: var(--fg); }
header a { margin-left: auto; color: var(--dim); }
.tabs { display: flex; gap: 20px; padding: 10px 16px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tabs a { padding-bottom: 8px; color: var(--dim); white-space: nowrap; }
.tabs a.on { color: var(--fg); border-bottom: 1px solid var(--fg); }
.rows { flex: 1; overflow: auto; container-type: inline-size; }
@container (max-width: 900px) { .row code { display: none; } }
@container (max-width: 560px) { .row .meta.where { display: none; } }
.row { display: flex; align-items: center; gap: 10px; padding: 7px 16px; white-space: nowrap; overflow: hidden; }
.row code { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.row .meta { flex: none; }
.row:hover, .thread:hover { background: var(--hover); }
.row .state { width: 84px; flex: none; color: var(--dim); }
.row.claimed .state, .row.ready .state { color: var(--fg); }
.row .id { color: var(--dim); width: 44px; flex: none; }
.row .text { overflow: hidden; text-overflow: ellipsis; flex: 0 1000 auto; min-width: 180px; }
.grow { flex: 1; }
.meta { color: var(--dim); font-size: 12px; }
code { border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; font: inherit; font-size: 12px; color: var(--dim); }
.thread { padding: 10px 16px; }
.thread .by, article .by { color: var(--dim); font-size: 12px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; cursor: text; }
.row .text { white-space: nowrap; cursor: default; }
.pending { opacity: 0.5; }
.empty { color: var(--dim); padding: 16px; }
.error { margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.composer { border-top: 1px dashed var(--line); padding: 10px 16px; display: flex; flex-direction: column; gap: 6px; }
input, textarea { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; font: inherit; cursor: text; }
textarea { resize: none; border: none; background: none; padding: 4px 0; outline: none; }
.bar { display: flex; align-items: center; gap: 12px; color: var(--dim); font-size: 12px; }
button { margin-left: auto; background: var(--fg); color: var(--bg); border: none; border-radius: 3px; padding: 6px 12px; font: inherit; cursor: default; }
.pane { width: 420px; flex: none; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
.messages { flex: 1; overflow: auto; }
article { padding: 10px 16px; }
.labels { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--dim); flex-wrap: wrap; }
@media (max-width: 800px) { aside { width: 56px; } aside span, nav h6, .as, nav a { font-size: 0; } .pane { position: fixed; inset: 0; width: auto; background: var(--bg); } .row .meta:last-child, .row code { display: none; } }
`
