import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'packages/muster/package.json'), 'utf8')) as { version: string }).version

/** Every place outside the changelog that names one muster release by its number. */
const PINS = [/@openmuster\/muster@(\d+\.\d+\.\d+[\w.-]*)/g, /"@openmuster\/muster": "(\d+\.\d+\.\d+[\w.-]*)"/g, /MUSTER_VERSION=(\d+\.\d+\.\d+[\w.-]*)/g]
const SKIP = new Set(['node_modules', '.git', '.next', '.open-next', 'dist', 'out', '.turbo'])

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(md|mdx|ts|tsx|json|ya?ml)$|Dockerfile$/.test(name) && name !== 'CHANGELOG.md' && name !== 'pnpm-lock.yaml') yield path
  }
}

describe('the version a release names', () => {
  it('is the package\'s own everywhere it is pinned, so a release pull request moves them all or fails', () => {
    const found: { file: string; version: string }[] = []
    for (const top of ['README.md', 'packages/muster/docs', 'templates', 'skills']) {
      const path = join(ROOT, top)
      for (const file of statSync(path).isDirectory() ? files(path) : [path]) {
        const text = readFileSync(file, 'utf8')
        for (const pin of PINS) for (const match of text.matchAll(pin)) found.push({ file: relative(ROOT, file), version: match[1]! })
      }
    }
    // The Cloudflare runner installs one release by number; a test that finds none has stopped looking.
    expect(found.map((pin) => pin.file)).toContain('templates/cloudflare-runner/Dockerfile')
    expect(found.filter((pin) => pin.version !== VERSION)).toEqual([])
  })
})
