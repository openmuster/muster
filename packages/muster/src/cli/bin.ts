#!/usr/bin/env node
import { readFileSync } from 'node:fs'

// Node 22 says on stderr, on every run, that its SQLite is experimental. That is noise for a person and
// breaks `--json` for a program reading stderr, so that one warning is dropped before SQLite loads.
const emitWarning = process.emitWarning
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message
  if (text.includes('SQLite is an experimental feature')) return
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
}) as typeof process.emitWarning
const { main } = await import('./main.ts')

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort(signal))

const code = await main(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text + '\n'),
  err: (text) => void process.stderr.write(text + '\n'),
  stdin: () => readFileSync(0, 'utf8'),
  env: process.env,
  stop: stop.signal,
})
process.exitCode = code
