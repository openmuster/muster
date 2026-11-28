import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// AGENTS.md, "No favourite agent": the core reads no agent-specific environment variables. The one place
// that may name them is the adapter that says what each agent CLI needs passed through to it.
const SRC = join(import.meta.dirname, '..', 'src')
const ADAPTERS = new Set(['runner/agents.ts'])
const AGENT_VARIABLE = /\b(?:(?:CLAUDE|ANTHROPIC|CODEX|OPENAI|GEMINI|CURSOR|AIDER|COPILOT)_[A-Z0-9_]+|CLAUDECODE)\b/g

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

describe('no favourite agent', () => {
  it('names no agent-specific environment variable outside the agent adapters', () => {
    const found: string[] = []
    for (const path of sources(SRC)) {
      const name = relative(SRC, path).split('\\').join('/')
      if (ADAPTERS.has(name)) continue
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(AGENT_VARIABLE)) found.push(`src/${name}:${index + 1}: ${match[0]}`)
        })
    }
    expect(found).toEqual([])
  })

  it('finds the variables the adapters name, so the pattern is not checking nothing', () => {
    const adapter = readFileSync(join(SRC, 'runner/agents.ts'), 'utf8')
    expect(adapter.match(AGENT_VARIABLE)).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENAI_API_KEY']))
  })
})
