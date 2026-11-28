import { COLOURS, SHAPE, declarations } from '../../../packages/muster/src/inspect/tokens'

/** The site's dark colours: the inspector's, read from the file both pages share. */
export const DARK = COLOURS.dark

/**
 * The tokens the site shares with the inspector, as `--muster-<name>`. The root layout puts this rule
 * in the page's head; `app/global.css` only uses the names, so the two pages can't drift apart.
 */
export const TOKENS_CSS = `:root, .dark { ${declarations({ ...COLOURS.dark, ...SHAPE }, 'muster-')} }`
