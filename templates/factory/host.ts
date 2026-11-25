// The factory's watcher, in a process of its own: `pnpm host` (node host.ts), beside the page and `mu serve`.
// It holds the lease `watch:factory`, so of any number of hosts on one board, one wakes the agent at a time.
// Stopped with SIGTERM or SIGINT, it lets the wake in flight finish recording, then exits.
import { team } from './lib/board.ts'

const host = team.start({ log: (line) => process.stderr.write(`factory: ${line}\n`) })
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  process.once(signal, () => {
    host.stop()
    void host.done.finally(() => {
      team.close()
      process.exit(code)
    })
  })
}
process.stderr.write(`factory: watching #${team.watchers.map((watcher) => watcher.tail.channel).join(', #')} on ${(await team.whoami()).where}\n`)
await host.done
