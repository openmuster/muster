#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { main } from './main.ts'

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
