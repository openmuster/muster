// Run as its own process by test/leases.test.ts: what one of many processes on a board does with a lease.
//   take <dir> <holder> <ttl> <startAt>   waits for the shared start, takes the lease once, prints the answer
//   hold <dir> <ttl> <every>              takes the lease, prints it, and renews it until killed
//   daemon <folder>...                    runs the daemon on a board in memory for two ticks, and prints
//                                         what was in each folder while it ran
import { readdirSync } from 'node:fs'
import { file } from '../../src/backend/file.ts'
import { runDaemon } from '../../src/daemon/daemon.ts'
import { holdLease } from '../../src/daemon/lease.ts'
import { board } from '../../src/handle.ts'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'take') {
  const [dir, holder, ttl, startAt] = args as [string, string, string, string]
  const backend = file({ dir })
  // Open the board before the start, so the race is the take and not who opened the file first.
  await backend.leases!.holder('tick')
  // Every process waits for the same instant: started one by one, they would never meet.
  while (Date.now() < Number(startAt)) await new Promise((resolve) => setTimeout(resolve, 1))
  const taken = await backend.leases!.take({ name: 'tick', holder, ttl: Number(ttl) })
  process.stdout.write(JSON.stringify(taken))
  backend.close()
} else if (mode === 'hold') {
  const [dir, ttl, every] = args as [string, string, string]
  const backend = file({ dir })
  const held = await holdLease(backend.leases!, 'tick', { ttl: Number(ttl), every: Number(every), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), stop: new AbortController().signal })
  process.stdout.write(`${JSON.stringify(held ? { holder: held.holder, epoch: held.epoch } : null)}\n`)
  // Kept alive by a timer of its own: the heartbeat's timer doesn't hold the process open.
  setInterval(() => {}, 60_000)
} else if (mode === 'daemon') {
  const stop = new AbortController()
  let ticks = 0
  let during: string[][] = []
  const ended = await runDaemon({
    team: board({ memory: true, principal: 'local:user:ada' }),
    watchers: [],
    stop: stop.signal,
    log: () => {},
    sleep: async () => {
      // Looked at while it holds the ticker: a lock file would be there now, and gone once it stops.
      during = args.map((folder) => readdirSync(folder))
      if (++ticks >= 2) stop.abort()
    },
  })
  process.stdout.write(JSON.stringify({ ended, during }))
} else {
  throw new Error(`unknown mode ${mode}`)
}
