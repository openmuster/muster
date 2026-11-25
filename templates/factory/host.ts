// The factory's watcher and sync, in a process of its own: `pnpm host` (node host.ts), beside the page.
// It holds the leases `watch:factory` and `sync`, so of any number of hosts on one board, one wakes the agent
// and one catches up with GitHub and sends to it, at a time.
// Stopped with SIGTERM or SIGINT, it lets the wake in flight finish recording, then exits.
import { team } from './lib/board.ts'

let host: ReturnType<typeof team.start>
try {
  host = team.start({ log: (line) => process.stderr.write(`factory: ${line}\n`) })
} catch (error) {
  // A secret the sync names isn't set: said once, by name.
  process.stderr.write(`factory: ${(error as Error).message}\n`)
  process.exit(1)
}
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
