// The operator's JSON files from before board modules: `watchers.json`, `sync.json` and `hooks.json`.
// None is read any more. One left in the config folder would be a watcher that never wakes, a platform
// that stops syncing, a receiver that stops hearing, all without a word, so `mu daemon run` and
// `mu serve` refuse to start while one is there, and say what to write instead.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'

export const RETIRED = ['watchers.json', 'sync.json', 'hooks.json'] as const
export type Retired = (typeof RETIRED)[number]

/** The page that ports each field of the three files: in the package, and on the site. */
export const PORTING = 'docs/04-reference/07-porting.md'
export const PORTING_URL = 'https://openmuster.ai/docs/reference/porting'

/** A board module that does what each file did, at its smallest. Each one loads as written. */
export const EXAMPLES: Record<Retired, string> = {
  'watchers.json': `import { board, command } from 'muster'

export default board({
  watch: {
    lead: {
      tail: { channel: 'work/' },
      as: 'lead',
      run: command(({ event }) => ['/srv/wake.sh', String(event.thread)]),
    },
  },
})
`,
  'sync.json': `import { board, env, github } from 'muster'

export default board({
  sync: {
    gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/web': 'web' } }),
  },
})
`,
  'hooks.json': `import { board, env } from 'muster'

export default board({
  hooks: [{ name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' } }],
})
`,
}

/** The retired files in the config folder, by their full paths, in the order above. */
export function leftover(dir: string = configDir()): { name: Retired; path: string }[] {
  return RETIRED.map((name) => ({ name, path: join(dir, name) })).filter((file) => existsSync(file.path))
}

/**
 * Why a command that would have read them refuses: which files, the module that does what each did,
 * and where each field's equivalent is. The hint is several lines, each indented, to be printed whole.
 */
export function refuseRetired(files: { name: Retired; path: string }[]): Failure {
  const paths = files.map((file) => file.path)
  const message = `${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} no longer read: watchers, sync and outgoing webhooks are declared in a board module now.`
  const examples = files.flatMap((file) => ['', `For ${file.name}, a board module like this:`, '', ...EXAMPLES[file.name].trimEnd().split('\n').map((line) => `    ${line}`)])
  const hint = [
    `Move what ${paths.length === 1 ? 'it lists' : 'they list'} into your board module (${join(configDir(), 'board.ts')} if you have none), then delete ${paths.length === 1 ? 'it' : 'them'}.`,
    ...examples,
    '',
    `Each field, and what it is in a module: ${PORTING_URL} (${PORTING} in the muster package).`,
  ].join('\n  ')
  return new Failure('config_retired', message, { hint, data: { files: paths, porting: PORTING_URL } })
}
