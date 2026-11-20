import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GLOBAL } from '../src/cli/args.ts'
import { HELP } from '../src/cli/help.ts'
import { SPECS } from '../src/cli/main.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []))
const pages = [...walk(join(root, 'packages/muster/docs')), ...walk(join(root, 'skills')), ...['swarm/README.md', 'swarm/JOIN.md', 'factory/README.md', 'factory/AGENT.md', 'cloudflare-runner/README.md'].map((page) => join(root, 'templates', page))]

/** Every `mu ...` command line in a page's code: fenced blocks and inline code. */
function commandLines(text: string): string[] {
  const out: string[] = []
  for (const block of text.matchAll(/```(?:bash|text)?[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split('\n')) {
      const at = line.search(/(^|[\s=])mu [a-z]/)
      if (at !== -1 && !line.trim().startsWith('#')) out.push(line.slice(line.indexOf('mu ', at)).replace(/\s+#.*$/, ''))
    }
  }
  for (const inline of text.matchAll(/`(mu [a-z][^`]*)`/g)) out.push(inline[1]!)
  return out
}

describe('docs and skills', () => {
  it('there are pages to check', () => {
    expect(pages.length).toBeGreaterThanOrEqual(10)
  })

  it('every command and flag they show exists in the CLI', () => {
    const wrong: string[] = []
    for (const page of pages) {
      for (const line of commandLines(readFileSync(page, 'utf8'))) {
        const words = line.split(/\s+/)
        const name = words[1]!
        if (name === 'help') continue
        const spec = SPECS[name]
        if (!spec) {
          wrong.push(`${page}: unknown command in "${line}"`)
          continue
        }
        const known = new Set([...GLOBAL.value, ...GLOBAL.bool, ...(spec.value ?? []), ...(spec.many ?? []), ...(spec.bool ?? [])])
        for (const word of words.slice(2)) {
          if (word === '--') break
          const flag = /^--([a-z][a-z-]*)/.exec(word)?.[1]
          if (flag && !known.has(flag)) wrong.push(`${page}: unknown flag --${flag} in "${line}"`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('every relative link points at a file that exists', () => {
    const broken: string[] = []
    for (const page of pages) {
      for (const link of readFileSync(page, 'utf8').matchAll(/\]\((\.{1,2}\/[^)#]+)(?:#[^)]*)?\)/g)) {
        if (!existsSync(resolve(dirname(page), link[1]!))) broken.push(`${page}: ${link[1]}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('the CLI reference page is what mu help prints', () => {
    expect(readFileSync(join(root, 'packages/muster/docs/07-cli.md'), 'utf8')).toContain(HELP)
  })

  it('every command the CLI has is in the help', () => {
    for (const name of Object.keys(SPECS)) expect([name, new RegExp(`^  ${name}[ \\n]`, 'm').test(HELP)]).toEqual([name, true])
  })
})
