import { misuse } from '../failure.ts'

export type Flags = Record<string, string | boolean | string[]>
export type Parsed = { positionals: string[]; flags: Flags; rest: string[] }

/** What a command takes: flags with a value, flags that repeat, and switches. Anything else is misuse. */
export type Spec = { value?: readonly string[]; many?: readonly string[]; bool?: readonly string[] }

export const GLOBAL: Required<Spec> = { value: ['as', 'dir', 'board', 'url'], many: [], bool: ['json', 'help'] }

/** Splits argv into positionals and flags. Everything after `--` is `rest`, untouched: a command to run. */
export function parse(argv: readonly string[], spec: Spec): Parsed {
  const value = new Set([...GLOBAL.value, ...(spec.value ?? [])])
  const many = new Set(spec.many ?? [])
  const bool = new Set([...GLOBAL.bool, ...(spec.bool ?? [])])
  const positionals: string[] = []
  const flags: Flags = {}
  let rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      rest = argv.slice(i + 1)
      break
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (bool.has(name)) {
      flags[name] = true
      continue
    }
    if (!value.has(name) && !many.has(name)) throw misuse('unknown_flag', `Unknown flag --${name}.`, 'Run the command with --help.')
    const given = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (given === undefined) throw misuse('missing_value', `--${name} needs a value.`)
    if (many.has(name)) flags[name] = [...((flags[name] as string[] | undefined) ?? []), given]
    else flags[name] = given
  }
  return { positionals, flags, rest }
}

export const str = (flags: Flags, name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
export const list = (flags: Flags, name: string) => (Array.isArray(flags[name]) ? (flags[name] as string[]) : [])
export const on = (flags: Flags, name: string) => flags[name] === true

/** A message or task ID as people write it: `812` or `#812`. */
export function id(input: string | undefined, what = 'an ID'): number {
  const text = (input ?? '').replace(/^#/, '')
  if (!/^[1-9][0-9]*$/.test(text)) throw misuse('invalid_id', input === undefined ? `Give ${what}.` : `"${input}" isn't ${what}.`)
  return Number(text)
}

/** A duration as people write it: `90s`, `5m`, `1h`, or seconds. In seconds. */
export function duration(input: string, flag: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?$/.exec(input)
  if (!match) throw misuse('invalid_duration', `--${flag} takes a duration like 90s, 5m or 1h.`)
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's']!
  return Number(match[1]) * unit
}

/** `k=v` pairs from a repeated flag. */
export function pairs(values: readonly string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const value of values) {
    const at = value.indexOf('=')
    if (at <= 0) throw misuse('invalid_label', `--${flag} takes k=v.`)
    out[value.slice(0, at)] = value.slice(at + 1)
  }
  return out
}

/** A cursor: a place in the log, `0` being before everything. */
export function cursor(input: string, flag: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(input)) throw misuse('invalid_cursor', `--${flag} takes a cursor a read or a wait printed.`)
  return Number(input)
}
