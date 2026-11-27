import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Says when a newer muster is out, for whoever asked to be told: off unless `MUSTER_UPDATE_CHECK=1`.
 * muster makes no request of its own otherwise. Asked for, it asks npm's registry (or the one
 * `npm_config_registry` names) for the version tagged latest, at most once a day, from a process of
 * its own that no command waits for, and sends nothing but that request. What it learned is kept in
 * the config folder, and the next command in a terminal says so in one line on stderr.
 */

export const PACKAGE = '@openmuster/muster'
/** A release number and nothing else: what the registry or the kept file says is printed only if it is one. */
const RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z]{1,20}(\.[0-9A-Za-z]{1,20}){0,3})?$/
const DAY = 24 * 60 * 60 * 1000

export type Checked = { checked: number; latest: string | null }

/** Release numbers in order: 0.3.1-alpha.2 < 0.3.1-alpha.10 < 0.3.1-beta.1 < 0.3.1. Negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core, pre] = version.split(/-(.*)/s, 2) as [string, string | undefined]
    return { core: core.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0)
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q)
    return numeric ? Number(p) - Number(q) : p < q ? -1 : 1
  }
  return 0
}

export const checkPath = (env: NodeJS.ProcessEnv) => join(env.MUSTER_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muster'), 'update-check.json')
export const registryOf = (env: NodeJS.ProcessEnv) => (env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '')

/** Whether to say anything, and whether to ask again: only for someone who opted in, at a terminal. */
export function updateNotice(input: { version: string; env: NodeJS.ProcessEnv; tty: boolean; json: boolean; now: number; checked: Checked | null }): { notice: string | null; ask: boolean } {
  const { version, env, tty, json, now, checked } = input
  if (env.MUSTER_UPDATE_CHECK !== '1' || !tty || json || env.CI || version === '0.0.0') return { notice: null, ask: false }
  const newer = typeof checked?.latest === 'string' && RELEASE.test(checked.latest) && compareVersions(checked.latest, version) > 0 ? checked.latest : null
  return {
    notice: newer ? `muster ${newer} is out; this is ${version}. npm install -g ${PACKAGE}` : null,
    ask: checked === null || !(now - checked.checked < DAY),
  }
}

export function readChecked(path: string): Checked | null {
  try {
    const found = JSON.parse(readFileSync(path, 'utf8')) as Checked
    return typeof found.checked === 'number' ? found : null
  } catch {
    return null
  }
}

// Run with `node -e` in a process of its own: it asks for the latest version and keeps the answer. A failed
// request is kept as a check too, so a registry out of reach is asked again tomorrow, not on every command.
const ASK = `
const [path, url, before] = process.argv.slice(1)
const fs = require('node:fs')
const write = (latest) => { try { fs.mkdirSync(require('node:path').dirname(path), { recursive: true }); fs.writeFileSync(path, JSON.stringify({ checked: Date.now(), latest })) } catch {} }
fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
  .then((response) => (response.ok ? response.json() : null))
  .then((tags) => write(tags && typeof tags.latest === 'string' ? tags.latest : before || null), () => write(before || null))
`

/** Starts the check and leaves it: the command that started it ends when it would have. */
export function ask(env: NodeJS.ProcessEnv, checked: Checked | null): void {
  const url = `${registryOf(env)}/-/package/${PACKAGE.replace('/', '%2f')}/dist-tags`
  try {
    spawn(process.execPath, ['-e', ASK, checkPath(env), url, checked?.latest ?? ''], { detached: true, stdio: 'ignore', env }).unref()
  } catch {
    // A notice is a convenience: a machine that can't start the check just isn't told.
  }
}
