/**
 * The values muster's two web pages share: the inspector (`app/style.ts`) and the docs site
 * (`apps/docs`, which reads this file at build time). This file is the one place they are written;
 * neither page writes them again. It imports nothing, so either build can read it.
 */

/** The colours, by what each is for. The docs site is dark only and takes `dark`. */
export const COLOURS = {
  dark: {
    /** The page. */
    bg: '#000000',
    /** What a thing says: text, a selected tab, the live dot. */
    fg: '#ededed',
    /** What supports or places it: a time, an ID, a count, a hint. */
    dim: '#8a8a8a',
    /** Hairlines between regions and around code. */
    line: '#2a2a2a',
    /** Somewhere to type: inputs and selects. */
    panel: '#0a0a0a',
    /** A row pointed at, or the one that is open. */
    hover: '#151515',
    thumb: '#2a2a2a',
    'thumb-hover': '#3a3a3a',
    /** Keyboard focus. */
    ring: '#8a8a8a',
  },
  light: {
    bg: '#ffffff',
    fg: '#111111',
    dim: '#666666',
    line: '#e3e3e3',
    panel: '#fafafa',
    hover: '#f0f0f0',
    thumb: '#d4d4d4',
    'thumb-hover': '#b8b8b8',
    ring: '#666666',
  },
} as const

/** Corners and motion. */
export const SHAPE = {
  'radius-sm': '3px',
  radius: '4px',
  'ease-out': 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** A colour change, a press. */
  'duration-fast': '120ms',
  /** Something that enters: the thread pane, the drawer. */
  duration: '180ms',
} as const

/** The tokens as CSS custom properties, `--<prefix><name>: <value>;`, for a `:root` rule. */
export const declarations = (tokens: Record<string, string>, prefix = '') =>
  Object.entries(tokens)
    .map(([name, value]) => `--${prefix}${name}: ${value};`)
    .join(' ')
