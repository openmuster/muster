---
title: Build a UI
description: "A page of your own over a board: a handle, a snapshot, and the feed."
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
