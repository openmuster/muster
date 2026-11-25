// How a `mu` installed anywhere loads a person's board module: a TypeScript file whose default export (or
// `team`) is a `board()`, with its watchers beside it.
//
// One rule makes everything else work: a process holds one copy of muster. A board made by another copy
// throws that copy's `Failure`, which this copy's server doesn't recognise, so a `not_found` would leave as a 500.
//   - The module has no `muster` of its own (a bare ~/.config/muster/board.ts): `import 'muster'` is
//     answered with this copy, by a resolve hook that only steps in when Node itself finds nothing.
//   - The module's folder has its own `muster`, another install: the process becomes that install's `mu`
//     (exec, same pid), so its module and its CLI are one copy again.
//   - Anything that still slips through (a dependency with its own nested `muster`) is refused by name.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Failure, misuse } from '../failure.ts'
import { COPY, type Board } from '../handle.ts'
import { VERSION } from '../version.ts'
import { parse, type Spec } from './args.ts'
import { configDir } from './claims.ts'

/**
 * What a `mu` that re-execs into another install relies on that install to do: take the same argv, and
 * know `MUSTER_REEXEC`. Kept in package.json as `musterModule`, so it can be read without running anything.
 */
export const MODULE_PROTOCOL = 1

/** Set by a `mu` that execs into another install, to that install's root: "you are the one meant to run it". */
export const REEXEC = 'MUSTER_REEXEC'

/** What `mu serve` and `mu daemon` take. Here, so the bin can tell before the CLI loads whether a command runs a module. */
export const SERVE_SPEC = { value: ['port', 'host', 'module'], many: ['allow-host'], bool: ['no-token', 'print-token', 'allow-joins'] } as const satisfies Spec
export const DAEMON_SPEC = { value: ['in', 'timeout', 'module'], many: ['env'] } as const satisfies Spec

/** The `mu daemon` verbs that run or read a module's watchers. `reset` and `uninstall` never load it. */
const DAEMON_VERBS = new Set(['run', 'status', 'check', 'install'])

/** Whether a command line runs the board module: `mu serve`, and `mu daemon run|status|check|install` (bare `mu daemon` is status). */
export function loadsModule(name: string | undefined, verb: string | undefined): boolean {
  return name === 'serve' || (name === 'daemon' && DAEMON_VERBS.has(verb ?? 'status'))
}

/** Where the module came from: the flag, the environment, or the default file that happens to exist. */
export type ModuleSource = 'flag' | 'env' | 'default'
export type ModulePath = { path: string; from: ModuleSource }

/** The default board module: `board.ts` in muster's config folder. */
export const defaultModule = () => join(configDir(), 'board.ts')

/** The module a command runs with: --module, then MUSTER_MODULE, then ~/.config/muster/board.ts when it exists. */
export function modulePath(flag: string | undefined, env: NodeJS.ProcessEnv): ModulePath | null {
  if (flag !== undefined) return { path: isAbsolute(flag) ? flag : resolve(flag), from: 'flag' }
  const set = env.MUSTER_MODULE
  if (set) return { path: isAbsolute(set) ? set : resolve(set), from: 'env' }
  const fallback = defaultModule()
  return existsSync(fallback) ? { path: fallback, from: 'default' } : null
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** This copy: the package's root on disk, and the URL its library answers `import 'muster'` with. */
export function self(): { root: string; entry: string } {
  const here = import.meta.url
  // From source (the tests run the CLI from src): src/cli/module.ts, beside src/index.ts.
  if (here.endsWith('.ts')) return { root: real(fileURLToPath(new URL('../../', here))), entry: new URL('../index.ts', here).href }
  // Built: a chunk in dist/, beside dist/index.js, which shares its chunks with the CLI.
  return { root: real(fileURLToPath(new URL('../', here))), entry: new URL('./index.js', here).href }
}

type Install = { root: string; version: string; protocol: number | null; bin: string }

/** The `muster` Node would give the module, if its folder (or one above) has one installed. */
export function musterFor(path: string): Install | null {
  let pkg: string
  try {
    pkg = createRequire(path).resolve('muster/package.json')
  } catch {
    return null
  }
  const json = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string; musterModule?: number; bin?: Record<string, string> }
  const root = real(join(pkg, '..'))
  return { root, version: json.version ?? '?', protocol: typeof json.musterModule === 'number' ? json.musterModule : null, bin: join(root, json.bin?.mu ?? 'dist/cli.js') }
}

export type Plan = { kind: 'here' } | { kind: 'reexec'; install: Install }

/** Whether this process can load the module itself, or has to become the module's own `mu`. */
export function plan(path: string, env: NodeJS.ProcessEnv): Plan {
  const me = self()
  const found = musterFor(path)
  if (!found || found.root === me.root) return { kind: 'here' }
  // Already exec'd into the install that was meant to run it, and it still isn't this one: a loop, refused.
  if (env[REEXEC] === me.root) {
    throw new Failure('module_two_copies', `${path} resolves muster to ${found.root}, but this is ${me.root}.`, { hint: "Something between them links one install to another: run the project's own mu." })
  }
  if (found.protocol === null) {
    throw new Failure('module_version_skew', `${path} uses muster ${found.version} (${found.root}), which can't run a board module. This mu is ${VERSION}.`, {
      hint: 'Update muster in that project to a release that loads board modules, or remove it there so this mu loads the module itself.',
      data: { module: path, theirs: { version: found.version, root: found.root }, ours: { version: VERSION, root: me.root } },
    })
  }
  return { kind: 'reexec', install: found }
}

/**
 * Becomes the module's own `mu`: the same process (pid, signals, stdio, exit code) running the other
 * install's CLI with the same arguments. Where exec isn't there (Windows), a child stands in and its
 * exit code and signal are passed on.
 */
async function reexec(install: Install, argv: readonly string[]): Promise<never> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env[REEXEC] = install.root
  const args = [...process.execArgv, install.bin, ...argv]
  if (typeof process.execve === 'function') process.execve(process.execPath, [process.execPath, ...args], env)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, args, { stdio: 'inherit', env })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  return new Promise<never>(() =>
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      process.exit(code ?? 1)
    }),
  )
}

let refused: Failure | null = null

/**
 * Run by the bin before the CLI loads: execs into the module's own install when it has one, or keeps the
 * refusal for the command to report the way every failure is reported. A command line that doesn't
 * parse, or doesn't run a module, is left to the CLI.
 */
export async function prepare(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const name = argv[0]
    const spec = name === 'serve' ? SERVE_SPEC : name === 'daemon' ? DAEMON_SPEC : null
    if (!spec) return
    let flag: string | undefined
    let verb: string | undefined
    try {
      const parsed = parse(argv.slice(1), spec)
      flag = typeof parsed.flags.module === 'string' ? parsed.flags.module : undefined
      verb = parsed.positionals[0]
    } catch {
      return
    }
    if (!loadsModule(name, verb)) return
    const found = modulePath(flag, env)
    const next = found ? plan(found.path, env) : null
    if (next?.kind === 'reexec') await reexec(next.install, argv)
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    refused = error
  } finally {
    // Only the process it was meant for reads it: what this one starts (an agent, a watcher's `mu`) decides for itself.
    delete env[REEXEC]
  }
}

/** Why the bin refused to run the module, if it did. */
export const refusal = () => refused

let hooked = false

/** `import 'muster'` from a module that has none of its own is answered with this copy. */
function hook() {
  if (hooked) return
  hooked = true
  const { entry } = self()
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (specifier === 'muster' && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return { url: entry, shortCircuit: true }
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
  if (!copy) throw new Failure('module_not_a_board', `${path} exports no board.`, { hint: "export default board({ ... }), or export const team = board({ ... }), with board from 'muster'." })
  if (copy !== COPY) {
    throw new Failure('module_two_copies', `${path} made its board with another copy of muster (${copy.version}, ${copy.url}). This mu is ${VERSION}.`, {
      hint: "Something the module imports brings its own muster: give the project one muster, and run that install's mu.",
    })
  }
  return team!
}

/** The board flags a module can't go with: it names its own board. */
export function boardFlagsBeside(found: ModulePath, given: string[]): Failure | null {
  if (given.length === 0) return null
  const why = found.from === 'default' ? `${found.path} is there, so it is the board module` : `${found.path} is the board module`
  return misuse('module_and_board', `${why}, and a module says which board it is: ${given.map((flag) => `--${flag}`).join(', ')} goes with no module.`, `Set the board in the module (board({ dir, name }), or MUSTER_DIR and MUSTER_BOARD), or pass --module with another file.`)
}
