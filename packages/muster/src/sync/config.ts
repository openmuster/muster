import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import { commandFilter } from './declare.ts'
import type { Sync } from './engine.ts'
import { github, linear, slack } from './providers.ts'

export const syncPath = () => join(configDir(), 'sync.json')

/**
 * The operator's sync config. Secrets are named, never written: `"secret": "env:GITHUB_WEBHOOK_SECRET"`
 * reads the environment, so the file can be shown to anyone and nothing secret is ever in a board.
 */
export function loadSync(path = syncPath(), env: NodeJS.ProcessEnv = process.env): Sync {
  if (!existsSync(path)) return {}
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const secret = (key: string, field: string, value: unknown, required: boolean): string | undefined => {
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string' || !value.startsWith('env:')) throw new Failure('invalid_config', `"${key}.${field}" in ${path} names an environment variable: "env:NAME".`)
    const found = env[value.slice(4)]
    if (!found && required) throw new Failure('invalid_config', `${value.slice(4)} isn't set, and "${key}" in ${path} needs it.`)
    return found || undefined
  }
  const filterOf = (key: string, command: unknown) => {
    if (command === undefined) return {}
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string')) throw new Failure('invalid_config', `"${key}.filter" in ${path} is a command, as an array of strings.`)
    return { filter: commandFilter(command as string[], env) }
  }
  const perDay = (key: string, value: unknown) => {
    if (value === undefined) return {}
    if (typeof value !== 'number' || !(value > 0)) throw new Failure('invalid_config', `"${key}.filesPerDayMB" in ${path} is a number of megabytes, more than 0.`)
    return { filesPerDay: Math.floor(value * 1024 * 1024) }
  }
  const out: Sync = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) throw new Failure('invalid_config', `"${key}" in ${path} isn't a sync name: lowercase letters, numbers, "-" and "_".`)
    const shared = { secret: secret(key, 'secret', entry.secret, true)!, ...(secret(key, 'token', entry.token, false) ? { token: secret(key, 'token', entry.token, false)! } : {}), ...(entry.bot ? { bot: String(entry.bot) } : {}) }
    if (entry.type === 'github') out[key] = { ...github({ ...shared, repos: entry.repos ?? {} }), ...filterOf(key, entry.filter), ...perDay(key, entry.filesPerDayMB) }
    else if (entry.type === 'linear') out[key] = { ...linear({ ...shared, teams: entry.teams ?? {} }), ...filterOf(key, entry.filter), ...perDay(key, entry.filesPerDayMB) }
    else if (entry.type === 'slack') out[key] = { ...slack({ ...shared, channels: entry.channels ?? {} }), ...filterOf(key, entry.filter), ...perDay(key, entry.filesPerDayMB) }
    else throw new Failure('invalid_config', `"${key}.type" in ${path} is one of: github, linear, slack.`)
  }
  return out
}
