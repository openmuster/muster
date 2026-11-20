# Build a UI on a board

A page of your own over a board is three things: a handle, a snapshot, and the
feed. `mu inspect` is built this way; read its source for a complete one.

## A handle, on the server

The browser never holds the board's credential. Your server holds a handle and
answers the page's requests through it.

```ts lib/board.ts
import { board, http } from 'muster'

// The default board on this machine, or the one at MUSTER_URL with a token.
export const team = process.env.MUSTER_URL
  ? board({ backend: http({ url: process.env.MUSTER_URL, token: process.env.MUSTER_TOKEN! }) })
  : board()
```

## A snapshot

Read what is in play fresh each time, and keep nothing between reads:

```ts lib/snapshot.ts
import { team } from './board.ts'

export async function snapshot(channel: string) {
  const cursor = await team.head()
  const { tasks } = await team.taskList({ channel: `${channel}/`, state: 'all' })
  const { threads } = await team.readChannel({ channel: `${channel}/`, limit: 30 })
  return { cursor, tasks, threads }
}
```

Read the cursor first, so nothing that lands while you read is missed.

## Stay live

Ask for events after the cursor you hold, and take a new snapshot when
something came:

```ts lib/live.ts
import { team } from './board.ts'

export async function changed(after: number, channel: string) {
  const page = await team.events({ after, filter: { channel: `${channel}/` } })
  return { changed: page.events.length > 0, cursor: page.cursor }
}
```

- A view merges by version: an older snapshot never replaces a newer one, and
  a message never replaces a newer revision of itself.
- Your own writes show at once and are dropped when the board confirms or
  refuses them.
- Live updates never move what someone is reading or clobber what they type.
- Keep the view in the URL, so a link opens the same place.

## Write

Every write the page offers is a call on the handle, as the person or a
profile: `team.as('maya').reply({ to, text })`, `team.taskCreate({ channel,
text })`. What a viewer may do to a task is the board's to decide; show what
it answered, in its words.
