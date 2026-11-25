// Run as its own process by test/watch.test.ts: a host for a board's watcher "w" on work/, which appends
// "<pid> <seq>" to <marker> for each event it is woken for.
//   start <dir> <marker> <ttl> <every>   runs it until SIGTERM, and prints "started"
//   deliver <dir> <marker> <offset>      runs it once, on a clock <offset> ms ahead; a message whose text
//                                        says "crash" makes the process exit mid-run, as a host that dies
import { appendFileSync } from 'node:fs'
import { board } from '../../src/handle.ts'

const [mode, dir, marker, ...rest] = process.argv.slice(2) as [string, string, string, ...string[]]
const offset = mode === 'deliver' ? Number(rest[0]) : 0

const team = board({
  dir,
  principal: 'local:user:ada',
  now: () => new Date(Date.now() + offset),
  watch: {
    w: {
      tail: { channel: 'work/' },
      run: ({ event }) => {
        appendFileSync(marker, `${process.pid} ${event.seq}\n`)
        if (event.message?.text.includes('crash')) process.exit(1)
      },
    },
  },
})

if (mode === 'start') {
  const [ttl, every] = rest as [string, string]
  const host = team.start({ lease: { ttl: Number(ttl), every: Number(every), wait: 100 }, log: () => {} })
  process.stdout.write('started\n')
  process.once('SIGTERM', () => {
    host.stop()
    void host.done.then(() => process.exit(0))
  })
} else if (mode === 'deliver') {
  process.stdout.write(JSON.stringify(await team.deliver()))
} else {
  throw new Error(`unknown mode ${mode}`)
}
