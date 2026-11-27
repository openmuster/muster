# Design

muster has two web pages: the inspector (`mu inspect`, in
`packages/muster/src/inspect/app/`) and the docs site (`apps/docs`). This
page is for whoever changes either one. It says what they are going for and
the rules that keep them that way. It doesn't ship in the npm package.

## What it is going for

A terminal that you can click. The inspector is black, with text at two
strengths, hairlines between regions and no colour: what a row says reads in
the foreground ink, and what places it (a state, an ID, a time, a channel)
in the dim one. Nothing has a fill of its own but somewhere to type, the row
you are on, and the layers that float over the page (the thread pane, the
drawer). Lists sit straight on the page as rows, one line each, and a
narrower screen drops a row's labels, then its channel and ID, before it
cuts its text. A thread opens beside the list on a desktop, over it on a
tablet, and in place of it on a phone. The docs site wears the same black,
greys and hairlines, and stays dark only; the inspector also follows a
light system theme.

## Tokens

The values the two pages share are written once, in
`packages/muster/src/inspect/tokens.ts`: the colours, the corners, the curve
and the durations. The inspector's stylesheet (`app/style.ts`) interpolates
them; the docs site's root layout puts them in the page's head as
`--muster-<name>`, and `apps/docs/app/global.css` only uses the names.
`apps/docs/test/tokens.test.ts` fails if the site declares a shared token
with another value, or writes a time or a curve in a rule instead of a
token.

Each colour is for one thing:

| Token | For |
| --- | --- |
| `fg` | What a thing says: a row's text, a message, the current tab, the live dot |
| `dim` | What supports or places it: a state, an ID, a time, a count, a hint, a placeholder |
| `line` | Hairlines between regions, and the outline of a label or code |
| `panel` | Somewhere to type: an input or a select |
| `hover` | The row pointed at, the row whose thread is open, the current view in the sidebar |
| `ring` | Keyboard focus: a hairline inside what has it |
| `thumb`, `thumb-hover` | A scrollbar, the only one: thin, in the page's greys, with no track |

There is no third ink and no accent colour. Something that matters more is
in `fg` or in the strong weight, never in a colour of its own. A write not
yet confirmed is faded (`--faded`), and a control that can't be pressed is
dimmed (`--disabled`).

Sizes are steps of one spacing unit (`--spacing`, 4px), the way Tailwind's
scale is. Corners are small: `radius` (4px) on what you press or type in,
`radius-sm` (3px) on a label. Everything else the inspector names (sizes,
columns, layers) is in the `:root` of `app/style.ts`, and only there.

## Type

The docs site sets the interface and the prose in Geist Sans. Geist Mono is
for code, terminal output, commands and IDs: it says "this is machine
text", never "this is important".

The inspector is a view of machine text (states, IDs, channel paths,
labels), so it is all in the system monospace (`--font-mono`), at
`--text-sm` with `--text-xs` for what places a thing. Weight marks the one
name a region is about (the view's title, the open thread, the board) and
nothing else. On a touch screen an input is at least `--text-base` (16px),
so a phone doesn't zoom in when you type.

## Motion

Motion follows something you did, and is short:

- **`duration-fast` (120ms):** a colour change and a press. A press scales
  what you pressed to `--press`. A hover shows at once and fades out.
- **`duration` (180ms):** a layer that enters: the thread pane slides in
  from the side, the drawer from the left.
- **`ease-out`:** every curve. Nothing eases in.

Only `transform`, `opacity` and colours move, which the browser moves
without laying the page out again. Under `prefers-reduced-motion` the pane
only fades, the drawer and presses don't move, and the reconnecting pulse
stops. The docs site's demo is data that is a function of time, so it shows
each scene finished to anyone who asked for less motion.

## Keys

Keys are for working through a list, one row after another: the tasks and
Activity. Every other list and form is clicked or tabbed through. The keys
are Gmail's:

- **`j` and `k`, or `↓` and `↑`:** move to the next and previous row that
  opens. The row the keys are on has the focus, drawn as the open row is.
- **`Enter`:** opens the row's thread. The row does this itself, so a row
  reached by Tab opens the same way.
- **`Esc`:** closes what is on top: the list of keys, then the drawer, then
  the thread. Closing a thread puts the focus back on the row it was opened
  from, so the next `j` carries on from there.
- **`?`:** shows every key, over the page. While it is open the page under
  it hears nothing.

Every key is a binding in one table in `app/main.tsx`, run by the one
listener in `app/keys.ts` (`useKeys`), and `?` draws that table, so a key
that is listed always works. Never add a listener of your own. Nothing runs
while you type in an input, a text area, a select or anything editable, and
nothing runs with Cmd, Ctrl or Alt held, which the browser keeps. The
browser suite drives each key.

## Nothing moves after it is drawn

The page is drawn before the board answers, and what arrives must not push
what is already on the screen. The browser suite records every layout shift
Chromium reports, on a desktop and on a phone, while the board loads and
when an error appears, and fails on any. It counts a shift right after a
key or a click too: something that appears because you pressed must still
not push the rest.

- **Something whose width depends on data reserves it.** The header's
  `live` takes the room of `reconnecting` from the first paint, and the word
  after its dot starts in one place.
- **Something that appears over a list lies over it.** The error banner is
  laid over the top of the list, under the header, rather than inserted
  above the tabs. A click takes it away.
- **A list's rows may grow downward.** Nothing in the list's region is
  under them; the composer is pinned below it.
- **A layer slides or fades.** The thread pane, the drawer and the list of
  keys move by `transform` and `opacity`, which aren't layout shifts.

## Rules for adding to it

- A value is a token. A colour, a corner, a duration or a curve written in
  a rule is a missing token: add it to `tokens.ts` if both pages need it,
  or to the page's own `:root` if one does.
- A shared token changes in `tokens.ts` alone, and both pages follow.
- A list is rows. A row opens its thread in the pane; it never unfolds in
  place.
- Hover is only on a device with a fine pointer (`(hover: hover) and
  (pointer: fine)`), and on a touch screen whatever is pressed is at least
  `--tap` (40px) high.
- A page change runs `pnpm test:browser`, which drives the built inspector
  in Chromium at phone, tablet and desktop widths. Add to it what the change
  promises.
