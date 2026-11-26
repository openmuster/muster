// How a `mu` installed anywhere loads a person's board module: a TypeScript file whose default export (or
// `team`) is a `board()`, with its watchers beside it.
//
// One rule makes everything else work: a process holds one copy of muster. A board made by another copy
// throws that copy's `Failure`, which this copy's server doesn't recognise, so a `not_found` would leave as a 500.
//   - The module has no `muster` of its own (a bare ~/.config/muster/board.ts): `import '@openmuster/muster'` is
//     answered with this copy, by a resolve hook that only steps in when Node itself finds nothing.
//   - The module's folder has its own `muster`, another install: the process becomes that install's `mu`
//     (exec, same pid), so its module and its CLI are one copy again.
//   - Anything that still slips through (a dependency with its own nested `muster`) is refused by name.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { constants } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { begin, ended, guardPath } from '../daemon/guard.ts'
import { Failure, misuse } from '../failure.ts'
import { COPY, type Board } from '../handle.ts'
import { VERSION } from '../version.ts'
import { parse, type Flags, type Spec } from './args.ts'
import { configDir } from './claims.ts'

/**
 * What a `mu` that re-execs into another install relies on that install to do: take the same argv, and
 * know the `MUSTER_REEXEC*` and `MUSTER_LAUNCH` variables. Kept in package.json as `musterModule`, so it
 * can be read without running anything; only an install with exactly this value is exec'd into.
 */
export const MODULE_PROTOCOL = 1

/** Set by a `mu` that execs into another install, to the real path of the bin it exec'd. */
export const REEXEC = 'MUSTER_REEXEC'
/** How many times this command line has been exec'd from one install into another. At most once. */
export const REEXEC_DEPTH = 'MUSTER_REEXEC_DEPTH'
/** The bin the person ran, before any re-exec: what `mu daemon install` records, so the service never names a target that can vanish. */
export const REEXEC_FROM = 'MUSTER_REEXEC_FROM'
/** The start `mu daemon run` counted before it loaded the module, handed on through a re-exec. */
export const LAUNCH = 'MUSTER_LAUNCH'

/** What `mu serve` and `mu daemon` take. Here, so the bin can tell before the CLI loads whether a command runs a module. */
export const SERVE_SPEC = { value: ['port', 'host', 'module'], many: ['allow-host'], bool: ['no-token', 'print-token', 'allow-joins', 'no-module'] } as const satisfies Spec
export const DAEMON_SPEC = { value: ['in', 'timeout', 'module'], many: ['env'], bool: ['no-module'] } as const satisfies Spec

/** Whether a command line runs the board module: `mu serve`, and every `mu daemon` verb (bare `mu daemon` is status). */
export function loadsModule(name: string | undefined, _verb?: string): boolean {
  // `install`, `uninstall` and `reset` name the service by the board the module opens, so they load it too.
  return name === 'serve' || name === 'daemon'
}

/** Where the module came from: the flag, the environment, or the default file that happens to exist. */
export type ModuleSource = 'flag' | 'env' | 'default'
export type ModulePath = { path: string; from: ModuleSource }
/** The module a command runs with, if any; and the default one, when it is there and something else chose the board. */
export type Choice = { module: ModulePath | null; skipped?: { path: string; because: string } }

/** The default board module: `board.ts` in muster's config folder. */
export const defaultModule = () => join(configDir(), 'board.ts')

const BOARD_FLAGS = ['dir', 'board', 'url'] as const
const BOARD_ENV = ['MUSTER_DIR', 'MUSTER_BOARD', 'MUSTER_URL'] as const

const text = (flags: Flags, name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)

/**
 * The module a command runs with: `--module`, then `MUSTER_MODULE`, then `~/.config/muster/board.ts`
 * when it is there and nothing else chose a board. A board named with `--dir`, `--board` or `--url`, or
 * `MUSTER_DIR`, `MUSTER_BOARD` or `MUSTER_URL`, leaves the default module out, so a daemon installed for
 * one board keeps running that board. A module named on purpose beside a board flag is misuse.
 */
export function chooseModule(flags: Flags, env: NodeJS.ProcessEnv): Choice {
  const flag = text(flags, 'module')
  if (flags['no-module'] === true) {
    if (flag !== undefined) throw misuse('module_and_no_module', '--module and --no-module say opposite things.', 'Pass one of them.')
    return { module: null }
  }
  let module: ModulePath | null = null
  if (flag !== undefined) module = { path: isAbsolute(flag) ? flag : resolve(flag), from: 'flag' }
  else if (env.MUSTER_MODULE) {
    if (!isAbsolute(env.MUSTER_MODULE)) throw misuse('module_not_absolute', `MUSTER_MODULE is ${env.MUSTER_MODULE}, which isn't an absolute path: it would mean a different file in every folder.`, 'Set it to the whole path, from /.')
    module = { path: env.MUSTER_MODULE, from: 'env' }
  }
  const named = BOARD_FLAGS.filter((name) => text(flags, name) !== undefined)
  if (module) {
    if (named.length) {
      throw misuse('module_and_board', `${module.path} is the board module, and a module says which board it is: ${named.map((name) => `--${name}`).join(', ')} goes with no module.`, 'Set the board in the module (board({ dir, name }), or MUSTER_DIR and MUSTER_BOARD), or pass --no-module.')
    }
  } else {
    const fallback = defaultModule()
    if (!existsSync(fallback)) return { module: null }
    const chose = [...named.map((name) => `--${name}`), ...BOARD_ENV.filter((name) => env[name])]
    if (chose.length) return { module: null, skipped: { path: fallback, because: chose.join(', ') } }
    module = { path: fallback, from: 'default' }
  }
  const as = text(flags, 'as') !== undefined ? '--as' : env.MUSTER_PROFILE ? 'MUSTER_PROFILE' : null
  if (as) throw misuse('module_and_profile', `${module.path} is the board module, and it says who its board writes as: ${as} goes with no module.`, 'Give its board() an as, or its watchers theirs; or pass --no-module.')
  return { module }
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** This copy: the package's root on disk, and the URL its library answers `import '@openmuster/muster'` with. */
export function self(): { root: string; entry: string } {
  const here = import.meta.url
  // From source (the tests run the CLI from src): src/cli/module.ts, beside src/index.ts.
  if (here.endsWith('.ts')) return { root: real(fileURLToPath(new URL('../../', here))), entry: new URL('../index.ts', here).href }
  // Built: a chunk in dist/, beside dist/index.js, which shares its chunks with the CLI.
  return { root: real(fileURLToPath(new URL('../', here))), entry: new URL('./index.js', here).href }
}

/** What a module imports muster as: its name on npm, and the bare name from before it was published there. */
const NAMES = ['@openmuster/muster', 'muster']

type Install = { root: string; json: string; version: string; protocol: unknown; bin: string | null }

/**
 * The `muster` in the nearest `node_modules` at or above the module's folder: where a project installs
 * it. Nothing else is looked at (no NODE_PATH, no global folders), so what is found is the project's.
 */
export function musterFor(path: string): Install | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    // The name it is published under, then the one a release tarball installed before it was on npm.
    const json = NAMES.map((name) => join(dir, 'node_modules', ...name.split('/'), 'package.json')).find((file) => existsSync(file))
    if (json) {
      const root = real(dirname(json))
      let read: { version?: string; musterModule?: unknown; bin?: Record<string, string> } = {}
      try {
        read = JSON.parse(readFileSync(json, 'utf8')) as typeof read
      } catch {
        // Unreadable: no marker, refused below.
      }
      // The bin, by its real path, only when it is a file inside the package: never something it points out to.
      const named = typeof read.bin?.mu === 'string' ? join(root, read.bin.mu) : null
      const bin = named && existsSync(named) ? real(named) : null
      return { root, json, version: read.version ?? '?', protocol: read.musterModule, bin: bin && bin.startsWith(root + sep) ? bin : null }
    }
    if (dirname(dir) === dir) return null
  }
}

export type Plan = { kind: 'here' } | { kind: 'reexec'; install: Install & { bin: string }; depth: number }

/** Whether this process can load the module itself, or has to become the module's own `mu`. */
export function plan(path: string, env: NodeJS.ProcessEnv): Plan {
  const me = self()
  const found = musterFor(path)
  if (!found || found.root === me.root) return { kind: 'here' }
  const depth = Number(env[REEXEC_DEPTH] ?? 0) || 0
  // Exec'd once already, and the module still wants another install: that is a loop, refused.
  if (depth >= 1 || env[REEXEC] !== undefined) {
    throw new Failure('module_two_copies', `${path} resolves muster to ${found.root}, but this mu, exec'd from another, is ${me.root}.`, { hint: "Something between them links one install to another: run the project's own mu." })
  }
  if (found.protocol !== MODULE_PROTOCOL) {
    throw new Failure('module_version_skew', `${path} has muster ${found.version} at ${found.root}, the first muster in a node_modules above it, and that one can't run a board module. This mu is ${VERSION}.`, {
      hint: `Update muster in that project to a release that loads board modules, or remove ${found.root} so this mu loads the module itself.`,
      data: { module: path, theirs: { version: found.version, root: found.root }, ours: { version: VERSION, root: me.root } },
    })
  }
  if (!found.bin) {
    throw new Failure('module_broken_install', `${path} has muster ${found.version} at ${found.root}, and its mu isn't there.`, { hint: `Install muster again in that project (npm i), or remove ${found.root} so this mu loads the module itself.` })
  }
  return { kind: 'reexec', install: { ...found, bin: found.bin }, depth }
}

/** Signals a child that stands in for this process can die of, as a shell reports them: 128 and the number. */
const signalCode = (signal: NodeJS.Signals) => 128 + (constants.signals[signal] ?? 0)

/**
 * Becomes the module's own `mu`: the same process (pid, signals, stdio, exit code) running the other
 * install's CLI with the same arguments. Where exec isn't there (Windows, or MUSTER_NO_EXECVE=1), a
 * child stands in: signals are passed to it, and its exit code, or 128 and its signal, is this one's.
 */
async function reexec(next: Extract<Plan, { kind: 'reexec' }>, argv: readonly string[], extra: Record<string, string>): Promise<never> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  Object.assign(env, extra, { [REEXEC]: next.install.bin, [REEXEC_DEPTH]: String(next.depth + 1) })
  env[REEXEC_FROM] ??= real(process.argv[1] ?? '')
  const args = [...process.execArgv, next.install.bin, ...argv]
  if (typeof process.execve === 'function' && process.env.MUSTER_NO_EXECVE !== '1') process.execve(process.execPath, [process.execPath, ...args], env)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, args, { stdio: 'inherit', env })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
  return new Promise<never>(() => child.on('exit', (code, signal) => process.exit(signal ? signalCode(signal) : (code ?? 1))))
}

/** Where `mu daemon run` counts a start before it loads a module, keyed by the module: whatever board it opens, if it ever gets that far. */
export const launchGuard = (path: string) => guardPath('module', real(path))

let launch: { path: string; at: number } | null = null

/** The start counted before the module loaded, taken back once the daemon has counted its own, or ended cleanly. */
export function endLaunch() {
  if (launch) ended(launch.path, launch.at)
  launch = null
}

/** How often a daemon that stopped restarting reads its record again. */
const POLL = 2000

/**
 * Counts a start of `mu daemon run` on a module before anything can fail: before a re-exec into an
 * install that may be broken, before the import. One that stopped restarting stays up doing nothing,
 * as any stopped daemon does, until its record lets it go (an hour on, or `mu daemon reset`).
 */
async function count(path: string) {
  let at = Date.now()
  let parked = begin(path, at)
  if (parked) {
    process.stderr.write(`error: ${parked.why}\n  What made it fail is earlier in this log. Fix it, then, to try now: mu daemon reset\n`)
    const stopped = new Promise<'stop'>((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve('stop'))
    })
    while (parked) {
      if ((await Promise.race([stopped, new Promise<'poll'>((resolve) => setTimeout(() => resolve('poll'), POLL))])) === 'stop') process.exit(0)
      at = Date.now()
      parked = begin(path, at)
    }
    process.stderr.write('trying again\n')
  }
  launch = { path, at }
}

let refused: Failure | null = null
let from: string | null = null

/** The bin the person ran, when this process was exec'd from it: what a service should run. */
export const invokedAs = () => from

/**
 * Run by the bin before the CLI loads: execs into the module's own install when it has one, or keeps the
 * refusal for the command to report the way every failure is reported. A command line that doesn't
 * parse, or names a module in a way the CLI refuses, is left to the CLI to say so.
 */
export async function prepare(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  // Only the process it was meant for reads these: what this one starts (an agent, a watcher's `mu`) decides for itself.
  const exec = { [REEXEC]: env[REEXEC], [REEXEC_DEPTH]: env[REEXEC_DEPTH] }
  from = env[REEXEC_FROM] ?? null
  if (env[LAUNCH]) {
    try {
      launch = JSON.parse(env[LAUNCH]) as { path: string; at: number }
    } catch {
      // Not ours.
    }
  }
  for (const name of [REEXEC, REEXEC_DEPTH, REEXEC_FROM, LAUNCH]) delete env[name]
  try {
    const name = argv[0]
    const spec = name === 'serve' ? SERVE_SPEC : name === 'daemon' ? DAEMON_SPEC : null
    if (!spec || !loadsModule(name)) return
    let parsed
    let chosen: ModulePath | null
    try {
      parsed = parse(argv.slice(1), spec)
      chosen = chooseModule(parsed.flags, env).module
    } catch {
      return
    }
    // A module that isn't there is the CLI's to report, before anything is resolved for it.
    if (!chosen || !existsSync(chosen.path)) return
    const verb = name === 'daemon' ? (parsed.positionals[0] ?? 'status') : null
    // reset and uninstall are how a broken install is got out of: they never exec into it.
    if (verb === 'reset' || verb === 'uninstall') return
    if (verb === 'run' && !launch) await count(launchGuard(chosen.path))
    const next = plan(chosen.path, { ...env, ...exec })
    if (next.kind === 'reexec') await reexec(next, argv, launch ? { [LAUNCH]: JSON.stringify(launch) } : {})
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    refused = error
  }
}

/** Why the bin refused to run the module, if it did. */
export const refusal = () => refused

let hooked = false

/** `import '@openmuster/muster'` from a module that has none of its own is answered with this copy, under its name on npm or the bare `muster` of before. */
function hook() {
  if (hooked) return
  hooked = true
  const { entry } = self()
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (NAMES.includes(specifier) && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return { url: entry, shortCircuit: true }
        throw error
      }
    },
  })
}

/** What Node says when it can't run a module, said as what to change in it. */
function explain(error: unknown, path: string): Failure {
  const code = (error as NodeJS.ErrnoException).code
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split('\n')[0]!
  const hint =
    code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
      ? "A board module runs with Node's type stripping: no enums, namespaces or parameter properties. Use a union of strings or a plain object."
      : /does not provide an export named/.test(text)
        ? 'A name that is only a type is imported with import type { ... }.'
        : code === 'ERR_MODULE_NOT_FOUND' && /Cannot find module '\//.test(text)
          ? 'Import a file of your own by its full name, with .ts: tsconfig paths and missing extensions are not read.'
          : code === 'ERR_MODULE_NOT_FOUND'
            ? 'Install that package beside the module (npm i in its folder), or import a file by a relative path.'
            : /Cannot use import statement outside a module/.test(text)
              ? 'A package.json above the module says it is CommonJS: name the file board.mts, or add "type": "module".'
              : code === 'ERR_INVALID_TYPESCRIPT_SYNTAX'
                ? 'Node reads .ts and .mts only, without JSX.'
                : undefined
  return new Failure('module_failed', `${path} failed to load: ${first}`, hint ? { hint } : {})
}

/** Imports the module and returns the board it exports, made by this copy of muster. */
export async function loadBoard(found: ModulePath): Promise<Board> {
  const { path } = found
  if (!existsSync(path)) {
    throw new Failure('module_not_found', `There is no board module at ${path}.`, { hint: found.from === 'env' ? 'MUSTER_MODULE names a file that is not there: fix it, or unset it.' : 'Pass --module with the path to a .ts file.' })
  }
  hook()
  let exported: Record<string, unknown>
  try {
    exported = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  } catch (error) {
    throw explain(error, path)
  }
  const team = (exported.default ?? exported.team) as (Board & Record<symbol, unknown>) | undefined
  const copy = (team !== null && typeof team === 'object' ? team[Symbol.for('muster.copy')] : undefined) as { version: string; url: string } | undefined
  if (!copy) throw new Failure('module_not_a_board', `${path} exports no board.`, { hint: "export default board({ ... }), or export const team = board({ ... }), with board from '@openmuster/muster'." })
  if (copy !== COPY) {
    throw new Failure('module_two_copies', `${path} made its board with another copy of muster (${copy.version}, ${copy.url}). This mu is ${VERSION}.`, {
      hint: "Something the module imports brings its own muster: give the project one muster, and run that install's mu.",
    })
  }
  return team!
}
