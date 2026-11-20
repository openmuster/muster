import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BIN, tempDir } from './helpers.ts'

// A guide's ```bash steps blocks are what it tells a reader to type, in order, on a new board. This
// runs them exactly as written, so a guide can't describe steps that don't work.
const guides = fileURLToPath(new URL('../docs/03-guides', import.meta.url))
const steps = (text: string) => [...text.matchAll(/```bash steps\n([\s\S]*?)```/g)].map((block) => block[1]!)
const pages = readdirSync(guides)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, blocks: steps(readFileSync(join(guides, name), 'utf8')) }))
  .filter((page) => page.blocks.length > 0)

function run(dir: string, script: string): Promise<{ code: number; output: string }> {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'mu'), `#!/bin/sh\nexec ${process.execPath} ${BIN} "$@"\n`)
  chmodSync(join(bin, 'mu'), 0o755)
  return new Promise((resolve) => {
    const child = execFile('sh', ['-e', '-x', '-c', script], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', LOGNAME: 'ada' } }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}\n${stderr}` }),
    )
    child.stdin?.end()
  })
}

describe('guides', () => {
  it('several guides have steps to run', () => {
    expect(pages.length).toBeGreaterThanOrEqual(6)
  })

  it.each(pages)('$name: its steps run as written, in order, on a new board', async ({ blocks }) => {
    const done = await run(tempDir(), blocks.join('\n'))
    expect(done.code, done.output.split('\n').slice(-12).join('\n')).toBe(0)
  })
})
