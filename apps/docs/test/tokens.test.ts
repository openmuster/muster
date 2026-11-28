import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COLOURS, SHAPE } from '../../../packages/muster/src/inspect/tokens'
import { TOKENS_CSS } from '../lib/tokens'

const CSS = readFileSync(new URL('../app/global.css', import.meta.url), 'utf8')
const SHARED: Record<string, string> = { ...COLOURS.dark, ...SHAPE }
/** The site's names for a shared token, where they aren't `--muster-<name>`. */
const ALIASES: Record<string, string> = { 'muster-raise': 'panel', 'ease-muster-out': 'ease-out' }

/** Every custom property a stylesheet declares, comments left out. */
const declared = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)].map(([, name, value]) => [name!, value!.trim()] as const)
const shared = (name: string) => ALIASES[name] ?? (name.startsWith('muster-') && name.slice(7) in SHARED ? name.slice(7) : null)
/** `#000` is `#000000`, and spaces in a curve don't matter. */
const normal = (value: string) => value.toLowerCase().replace(/\s+/g, '').replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, '#$1$1$2$2$3$3')

describe("the docs site's tokens", () => {
  it("are the inspector's: a shared token the site declares has the inspector's value", () => {
    const drift = [...declared(CSS), ...declared(TOKENS_CSS)].flatMap(([name, value]) => {
      const token = shared(name)
      // A name the site gives a shared token may point at it: `var(--muster-ease-out)`.
      const points = /^var\(--([\w-]+)\)$/.exec(value)?.[1]
      if (token && points && shared(points) === token) return []
      return token && normal(value) !== normal(SHARED[token]!) ? [`--${name}: ${value} (the inspector's ${token} is ${SHARED[token]})`] : []
    })
    expect(drift).toEqual([])
  })

  it('declares every shared token, from the shared file', () => {
    const names = declared(TOKENS_CSS).map(([name]) => shared(name))
    expect(names.sort()).toEqual(Object.keys(SHARED).sort())
  })

  it('writes a time or a curve only as a token, never in a rule', () => {
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[\w-]+\s*:[^;}]+/g, '')
    expect(rules.match(/\b\d+m?s\b|cubic-bezier\([^)]*\)/g) ?? []).toEqual([])
  })
})
