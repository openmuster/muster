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

// A command that runs a board module runs it with the module's own muster. When that is another install,
// this process becomes that install's `mu` before loading anything else.
await (await import('./module.ts')).prepare(process.argv.slice(2), process.env)
const { main } = await import('./main.ts')

// `mu mcp` isn't a command that runs and ends: it serves the board to an agent over this process's own pipes.
if (process.argv[2] === 'mcp' && process.argv.length === 3) {
  const { mcp } = await import('./mcp.ts')
  await mcp(process.stdin, process.stdout, process.env, main)
  process.exit(0)
}

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort(signal))

const code = await main(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text + '\n'),
  err: (text) => void process.stderr.write(text + '\n'),
  stdin: () => readFileSync(0, 'utf8'),
  env: process.env,
  tty: process.stdout.isTTY === true,
  stop: stop.signal,
})
process.exitCode = code
// Stopped by a signal, a command has already cleaned up: whatever it was still waiting on, such as a
// cloud run's open request, mustn't keep the process alive. Its output is flushed first.
if (stop.signal.aborted) process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
