import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GLOBAL } from '../src/cli/args.ts'
import { HELP } from '../src/cli/help.ts'
import { SPECS } from '../src/cli/main.ts'
import { FILE_MAX } from '../src/core/files.ts'
import { LEASE_DEFAULT_S, LEASE_MAX_S, LEASE_MIN_S, NEEDS_MAX, PLAN_MAX, RESULT_MAX } from '../src/core/tasks.ts'
import { LIMITS } from '../src/model.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []))
const pages = [...walk(join(root, 'packages/muster/docs')), ...walk(join(root, 'skills')), ...['swarm/README.md', 'swarm/JOIN.md', 'factory/README.md', 'factory/AGENT.md', 'queue/README.md', 'cloudflare-runner/README.md'].map((page) => join(root, 'templates', page))]

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

  it('frontmatter is YAML a strict parser reads: a value with ": " or " #" in it is quoted', () => {
    const wrong: string[] = []
    for (const page of pages) {
      const lines = readFileSync(page, 'utf8').split('\n')
      if (lines[0] !== '---') continue
      for (const line of lines.slice(1, lines.indexOf('---', 1))) {
        const value = line.replace(/^[A-Za-z_-]+: /, '')
        if (!/^["']/.test(value) && /: | #|^[[{>|*&!%@`]/.test(value)) wrong.push(`${page}: ${line.slice(0, 60)}`)
      }
    }
    expect(wrong).toEqual([])
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
    expect(readFileSync(join(root, 'packages/muster/docs/04-reference/01-cli.md'), 'utf8')).toContain(HELP)
  })

  it('every reason the code refuses with is on the errors page', () => {
    const page = readFileSync(join(root, 'packages/muster/docs/04-reference/05-errors.md'), 'utf8')
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []))
    const reasons = new Set<string>()
    for (const file of sources(join(root, 'packages/muster/src'))) for (const match of readFileSync(file, 'utf8').matchAll(/(?:new Failure|misuse)\('([a-z_]+)'/g)) reasons.add(match[1]!)
    expect(reasons.size).toBeGreaterThan(60)
    expect([...reasons].filter((reason) => !page.includes('`' + reason + '`')).sort()).toEqual([])
  })

  it('every kind of event the board writes is on the events page', () => {
    const page = readFileSync(join(root, 'packages/muster/docs/04-reference/04-events.md'), 'utf8')
    const log = readFileSync(join(root, 'packages/muster/src/store/log.ts'), 'utf8')
    const types = [...log.matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]!)
    expect(types.length).toBeGreaterThan(25)
    expect(types.filter((type) => !page.includes('`' + type + '`'))).toEqual([])
  })

  it('every page the index links to exists, and every page is linked from the index', () => {
    const index = readFileSync(join(root, 'packages/muster/docs/index.md'), 'utf8')
    const linked = new Set([...index.matchAll(/\]\(\.\/([^)#]+)\)/g)].map((match) => match[1]!))
    const all = walk(join(root, 'packages/muster/docs')).map((page) => page.slice(join(root, 'packages/muster/docs').length + 1)).filter((page) => page !== 'index.md')
    expect(all.filter((page) => !linked.has(page))).toEqual([])
  })

  it('every flag a command takes is in the help, but for the ones kept out on purpose', () => {
    // --once ends `mu demo` when its script does, for tests; --no-count is how `mu run` fails a task without using up an attempt.
    const hidden = ['once', 'no-count']
    const missing = Object.entries(SPECS).flatMap(([name, spec]) =>
      [...(spec.value ?? []), ...(spec.many ?? []), ...(spec.bool ?? [])].filter((flag) => !hidden.includes(flag) && !HELP.includes(`--${flag}`)).map((flag) => `${name} --${flag}`),
    )
    expect(missing).toEqual([])
  })

  it('every command the CLI has is in the help', () => {
    for (const name of Object.keys(SPECS)) expect([name, new RegExp(`^  ${name}[ \\n]`, 'm').test(HELP)]).toEqual([name, true])
  })

  it("the skill's limits are the ones the code enforces", () => {
    const skill = readFileSync(join(root, 'skills/board/SKILL.md'), 'utf8')
    const table = skill.slice(skill.indexOf('## Limits'), skill.indexOf('## Coming back later'))
    const n = (value: number) => value.toLocaleString('en-US')
    const span = (seconds: number) => (seconds % 3600 === 0 ? `${seconds / 3600} hour` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`)
    const said = [
      `text is at most ${n(LIMITS.text)} characters`,
      `at most ${LIMITS.attachments} files, each up to ${FILE_MAX / 1024 / 1024} MB`,
      `is at most ${n(RESULT_MAX)} characters`,
      `label key is up to ${LIMITS.labelKey} lowercase`,
      `label value is up to ${LIMITS.labelValue} characters; a message holds up to ${LIMITS.labels} labels`,
      `lease is ${span(LEASE_MIN_S)} to ${span(LEASE_MAX_S)}, ${span(LEASE_DEFAULT_S)} unless`,
      `waits for at most ${NEEDS_MAX} others; a plan holds at most ${PLAN_MAX} tasks`,
      `lists ${LIMITS.read} threads, up to ${LIMITS.readMax} with`,
    ]
    expect(said.filter((line) => !table.includes(line))).toEqual([])
    // Each row is one limit: a number the table states and no check covers would go stale unseen.
    expect(table.split('\n').filter((line) => /^\| A /.test(line))).toHaveLength(said.length + 1)
  })
})
