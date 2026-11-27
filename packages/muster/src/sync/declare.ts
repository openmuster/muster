// How a board module declares its sync: `github()`, `linear()` and `slack()` with their secrets named by
// `env('NAME')`, read from the environment when the board starts, never when the module is imported. A
// module can be imported anywhere (a test, `mu daemon status`, a build) without the secrets being there.
import { spawnSync } from 'node:child_process'
import { isEnv, looksNamed, nameOf, type Env } from '../config/env.ts'
import { Failure, misuse } from '../failure.ts'
import type { Provider } from './types.ts'

/** A secret as a module gives it: named with `env()`, or written out (which puts it in the module's file). */
export type Secret = string | Env

export { isEnv, type Env }

/** What every platform's sync takes. */
export type SyncOptions = {
  /** The webhook signing secret: `env('NAME')`. */
  secret: Secret
  /** An API token, where the sync sends to the platform or reads from it: `env('NAME')`. */
  token?: Secret
  /**
   * Runs on text as it comes in, and returns what to keep, or null to drop the event. A command (an array
   * of words: text in on stdin, what to keep on stdout, a non-zero exit drops it), or a function.
   */
  filter?: readonly string[] | ((text: string) => string | null)
  /** Megabytes of files this sync may bring in a day. */
  filesPerDayMB?: number
}

/** A platform's options with its secrets read: what the provider itself is made from. */
export type Resolved<O> = { [K in keyof Omit<O, 'secret' | 'token' | 'filter' | 'filesPerDayMB'>]: Exclude<O[K], Env> } & { secret: string; token?: string }

/** The operator's own command as a filter: text in on stdin, text to keep on stdout, a non-zero exit drops it. */
export function commandFilter(command: readonly string[], from: NodeJS.ProcessEnv = process.env): (text: string) => string | null {
  return (text) => {
    const ran = spawnSync(command[0]!, command.slice(1), { input: text, encoding: 'utf8', env: { PATH: from.PATH ?? '', HOME: from.HOME ?? '' }, timeout: 10_000 })
    return ran.status === 0 ? ran.stdout : null
  }
}

const PENDING = Symbol.for('muster.sync.pending')
type Pending = { names: readonly string[]; resolve(key: string, from: NodeJS.ProcessEnv): Provider; base: Provider }

/**
 * A platform's provider, from options a module wrote. With every secret written out, it is the provider. With
 * one named by `env()`, it is a stand-in that does nothing until the board reads the environment
 * (`resolveSync`), and says which variables it waits for. `more` names a platform's own secrets beside
 * `secret` and `token` (an app's ID and key), read and checked the same way, each of them optional.
 */
export function declared<O extends SyncOptions>(type: string, options: O, make: (resolved: Resolved<O>) => Provider, more: readonly (keyof O & string)[] = []): Provider {
  const what = `A ${type} sync`
  const secretOk = (value: unknown, required: boolean) => (value === undefined && !required) || (typeof value === 'string' && value.length > 0) || isEnv(value)
  if (!secretOk(options.secret, true)) throw misuse('invalid_sync', `${what} needs a "secret": env('NAME'), the variable that holds its webhook signing secret.`)
  if (!secretOk(options.token, false)) throw misuse('invalid_sync', `${what} has a "token" that is neither env('NAME') nor a string.`)
  // "env:NAME" or env('NAME') written as text is a key anyone reading the module could sign with.
  const named = ['secret', 'token', ...more] as (keyof O & string)[]
  for (const field of more) if (!secretOk(options[field], false)) throw misuse('invalid_sync', `${what} has a "${field}" that is neither env('NAME') nor a string.`)
  for (const field of named) {
    const value = options[field]
    if (typeof value === 'string' && looksNamed(value)) throw misuse('invalid_sync', `${what} has a "${field}" written as the text "${value}": that would be the key itself.`, "Name the variable with env('NAME'), not as a string.")
  }
  const { filter, filesPerDayMB } = options
  let filtered: { filter?: (text: string) => string | null } = {}
  if (typeof filter === 'function') filtered = { filter }
  else if (filter !== undefined) {
    if (!Array.isArray(filter) || filter.length === 0 || !filter.every((part) => typeof part === 'string')) throw misuse('invalid_sync', `${what} has a "filter" that is neither a command, as an array of strings, nor a function.`)
    filtered = { filter: commandFilter(filter) }
  }
  if (filesPerDayMB !== undefined && (typeof filesPerDayMB !== 'number' || !(filesPerDayMB > 0))) throw misuse('invalid_sync', `${what} has a "filesPerDayMB" that isn't a number of megabytes, more than 0.`)
  const extras = { ...filtered, ...(filesPerDayMB !== undefined ? { filesPerDay: Math.floor(filesPerDayMB * 1024 * 1024) } : {}) }
  const { filter: _filter, filesPerDayMB: _mb, ...rest } = options
  const fields = named.filter((field) => isEnv(options[field]))
  if (fields.length === 0) return { ...make(rest as unknown as Resolved<O>), ...extras }
  const names = [...new Set(fields.map((field) => nameOf(options[field] as Env)))]
  const notYet = () => {
    throw new Failure('sync_not_started', `${what} names ${names.join(' and ')} with env(), and nothing has read them yet.`, { hint: 'Give it to board({ sync }): the board reads them when it starts, or takes its first request.' })
  }
  const base: Provider = { type, verify: notYet, parse: notYet, channelFor: notYet, placeFor: notYet, mirrors: notYet, deliver: async () => notYet(), ...extras }
  const resolve = (key: string, from: NodeJS.ProcessEnv): Provider => {
    const read: Record<string, string> = {}
    for (const field of fields) {
      const name = nameOf(options[field] as Env)
      const value = from[name]
      // Empty is refused like unset: a webhook signed with an empty key is one anybody can sign.
      if (!value) throw new Failure('invalid_config', `${name} ${value === undefined ? "isn't set" : 'is empty'}, and sync "${key}" needs it.`, { hint: `Set ${name} where the board runs. A service installed with mu daemon install gets it with --env ${name}.` })
      read[field] = value
    }
    return { ...make({ ...rest, ...read } as unknown as Resolved<O>), ...extras }
  }
  return Object.assign({ ...base }, { [PENDING]: { names, resolve, base } satisfies Pending })
}

const pendingOf = (provider: Provider) => (provider as Provider & { [PENDING]?: Pending })[PENDING]

/** The environment variables a sync waits for, by name, without reading them. */
export const envNames = (provider: Provider): readonly string[] => pendingOf(provider)?.names ?? []

/**
 * A board's sync with every `env()` read now. A variable that isn't set is refused by name, with the sync
 * that needs it. What a module added to a provider itself (`{ ...github({...}), filter }`) is kept.
 */
export function resolveSync<S extends Record<string, Provider>>(sync: S, from: NodeJS.ProcessEnv = process.env): S {
  const out: Record<string, Provider> = {}
  for (const [key, provider] of Object.entries(sync)) {
    const pending = pendingOf(provider)
    if (!pending) {
      out[key] = provider
      continue
    }
    const made = pending.resolve(key, from)
    const added: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(provider)) if (value !== (pending.base as Record<string, unknown>)[name]) added[name] = value
    out[key] = { ...made, ...added } as Provider
  }
  return out as S
}

const SYNC_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** A board's sync as declared, checked when the module is read: each key a sync name, each value a platform. */
export function checkSync(sync: unknown): Record<string, Provider> {
  if (sync === undefined) return {}
  if (typeof sync !== 'object' || sync === null || Array.isArray(sync)) throw misuse('invalid_sync', 'sync is an object of platforms by name: { gh: github({ ... }) }.')
  for (const [key, provider] of Object.entries(sync)) {
    if (!SYNC_KEY.test(key)) throw misuse('invalid_sync', `"${key}" isn't a sync name: lowercase letters, numbers, "-" and "_", up to 32.`, 'The name is the webhook\'s path: /api/board/webhooks/<name>.')
    const given = provider as Partial<Provider> | null
    if (typeof given !== 'object' || given === null || typeof given.type !== 'string' || typeof given.verify !== 'function') {
      throw misuse('invalid_sync', `sync "${key}" isn't a platform: give it github({ ... }), linear({ ... }), slack({ ... }) or notion({ ... }).`)
    }
  }
  return sync as Record<string, Provider>
}
