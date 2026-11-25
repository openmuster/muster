// Run as its own process by test/watch.test.ts: one host running a board's watcher until SIGTERM.
//   <dir> <marker> <ttl> <every>   starts watcher "w" on work/, which appends "<pid> <seq>" to <marker>
//                                  for each event it is woken for, and prints "started"
import { appendFileSync } from 'node:fs'
import { board } from '../../src/handle.ts'

const [dir, marker, ttl, every] = process.argv.slice(2) as [string, string, string, string]

const team = board({
  dir,
  principal: 'local:user:ada',
  watch: {
    w: {
      tail: { channel: 'work/' },
      run: ({ event }) => appendFileSync(marker, `${process.pid} ${event.seq}\n`),
    },
  },
})
const host = team.start({ lease: { ttl: Number(ttl), every: Number(every), wait: 100 }, log: () => {} })
process.stdout.write('started\n')
process.once('SIGTERM', () => {
  host.stop()
  void host.done.then(() => process.exit(0))
})
