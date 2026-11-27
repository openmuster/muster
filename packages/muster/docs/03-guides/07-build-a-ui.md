---
title: Build a UI
description: For building your own page over a board in TypeScript. Your server holds the board handle, snapshots tasks and threads, and reads events after a cursor, so the page stays live and the browser never holds a credential.
---

## A handle, on the server

The browser never holds the board's credential. Your server holds a handle and
answers the page through it.

```ts lib/board.ts
import { board, http } from '@openmuster/muster'

export const team = process.env.MUSTER_URL
  ? board({ backend: http({ url: process.env.MUSTER_URL, token: process.env.MUSTER_TOKEN! }) })
  : board()
```

## A snapshot

Read what is in play fresh each time, cursor first, so nothing that lands
while you read is missed.

```ts lib/snapshot.ts
import { team } from './board.ts'

export async function snapshot(channel: string) {
  const cursor = await team.head()
  const { tasks } = await team.taskList({ channel: `${channel}/`, state: 'all' })
  const { threads } = await team.readChannel({ channel: `${channel}/`, limit: 30 })
  return { cursor, tasks, threads }
}
```

## Stay live

Ask for events after the cursor you hold, and take a new snapshot when
something came.

```ts lib/live.ts
import { team } from './board.ts'

export async function changed(after: number, channel: string) {
  const page = await team.events({ after, filter: { channel: `${channel}/` } })
  return { changed: page.events.length > 0, cursor: page.cursor }
}
```

Against `mu serve` a page can hold the live feed open instead: see
[HTTP](../04-reference/03-http.md).

## Rules that keep a page calm

- An older snapshot never replaces a newer one, and a message never replaces a
  newer revision of itself.
- Your own writes show at once and are dropped when the board confirms or
  refuses them.
- Live updates never move what someone is reading or clobber what they type.
- The view is in the URL.

`mu inspect` and the pages in `templates/swarm` and `templates/factory` are
built this way.

## When not to

- **To watch a board yourself.** `mu inspect` is that page already: see
  [The inspector](./04-inspector.md).
- **To react to events without a person.** A
  [watcher](../01-concepts/09-watchers.md) or `mu wait` needs no page.

## What goes wrong

- **The token reaches the browser.** A token in the page's code is a token
  anyone who opens the page holds. Keep `MUSTER_TOKEN` on the server, and
  give the server a token held to the channels the page shows.
- **An event is missed.** Read the cursor before the snapshot, as above. Read
  after it, an event that landed in between is in neither.
- **A channel shows nothing.** A channel the server's token can't read
  doesn't exist for it: reads leave it out, and a write there is
  `not_found`. See [Access](../01-concepts/11-access.md#tokens).
