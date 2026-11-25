// `env('NAME')`: a secret named in a board module, read from the environment when the board starts,
// never when the module is imported. One shape, under one symbol, for everything a module names a secret
// for: its sync's `github()`, `linear()` and `slack()`, and its outgoing webhooks.
import { Failure, misuse } from '../failure.ts'

const ENV = Symbol.for('muster.env')

/** A secret named, not written: `env('GITHUB_WEBHOOK_SECRET')`. The board reads it when it starts. */
export type Env = { readonly [ENV]: string }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names an environment variable for a secret. Nothing is read now: the board reads it when it starts
 * (`team.start()`, `mu serve`, `mu daemon run`) or takes its first request (`team.fetch`), and refuses,
 * naming the variable, if it isn't set. It is never text: one turned into a string would be a key anyone
 * reading the module could guess, so that throws.
 */
export function env(name: string): Env {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) {
    throw misuse('invalid_env', `env(${JSON.stringify(name)}) doesn't name an environment variable.`, 'A name is letters, numbers and "_", and doesn\'t start with a number: env(\'GITHUB_WEBHOOK_SECRET\').')
  }
  const asText = () => {
    throw new Failure('invalid_env', `env('${name}') was used as text: it names a secret, and isn't one.`, { exit: 2, hint: `Give env('${name}') itself where a secret goes; the board reads ${name} when it starts.` })
  }
  return Object.freeze({ [ENV]: name, toString: asText, [Symbol.toPrimitive]: asText, toJSON: () => ({ env: name }) })
}

export const isEnv = (value: unknown): value is Env => typeof value === 'object' && value !== null && typeof (value as Record<symbol, unknown>)[ENV] === 'string'

/** The variable an `env()` names. */
export const nameOf = (value: Env) => value[ENV]

/** Text that looks like a secret named the way `sync.json` or `env()` names one, written as a string by mistake. */
export const looksNamed = (value: string) => /^env[(:]/.test(value)
