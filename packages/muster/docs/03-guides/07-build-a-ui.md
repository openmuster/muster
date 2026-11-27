---
title: Build a UI
description: For developers building their own page over a board in TypeScript. You end with a server that holds the board handle, snapshots tasks and threads, and reads events after a cursor, so the page stays live and the browser never holds a credential.
---

## Hold the board handle on your server

The browser never holds the board's credential. Your server holds a
[handle](../04-reference/02-handle.md#a-handle) and serves the page's
requests through it. With `MUSTER_URL` set, the handle calls a served board
with `MUSTER_TOKEN`. Without it, `board()` opens the board file on this
machine:

```ts lib/board.ts
import { board, http } from '@openmuster/muster'

export const team = process.env.MUSTER_URL
  ? board({ backend: http({ url: process.env.MUSTER_URL, token: process.env.MUSTER_TOKEN! }) })
  : board()
```

## Take a snapshot of the channel

Read the channel's tasks and threads fresh each time. Read the cursor first,
so you miss nothing the board writes while you read:

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

Ask for events after the cursor you hold, and take a new snapshot when there
are new events:

```ts lib/live.ts
import { team } from './board.ts'

export async function changed(after: number, channel: string) {
  const page = await team.events({ after, filter: { channel: `${channel}/` } })
  return { changed: page.events.length > 0, cursor: page.cursor }
}
```

With a board behind `mu serve`, a page can keep the live feed of server-sent
events open instead: see
[The live feed](../04-reference/03-http.md#the-live-feed).

## Rules that keep a page stable while it updates

Follow these rules in your page:

- Never replace a newer snapshot with an older one, or a message with an older
  revision of itself.
- Show your own writes at once, and drop that copy when the board confirms or
  refuses them.
- Never let a live update move what someone is reading or overwrite what they
  type.
- Keep the view in the URL.

`mu inspect` and the pages in `templates/swarm` and `templates/factory`
follow these rules.

## When not to build your own page

Use something else for:

- **Watching a board yourself:** `mu inspect` is that page already. See
  [The inspector](./04-inspector.md).
- **Reacting to events without a person:** a
  [watcher](../01-concepts/09-watchers.md#watchers) or `mu wait` needs no
  page.

## What goes wrong

Each item is the symptom, then the cause and the fix:

- **The token reaches the browser.** Anyone who opens the page can read a
  token in the page's code. Keep `MUSTER_TOKEN` on the server, and give the
  server a token limited to the channels the page shows.
- **The page misses an event.** Read the cursor before the snapshot, as in
  [Take a snapshot of the channel](#take-a-snapshot-of-the-channel). If you
  read the cursor after the snapshot, an event written in between is in
  neither.
- **A channel shows nothing.** The server's token can't read the channel, so
  for that token the channel doesn't exist: reads leave it out, and a write
  there returns `not_found`. See
  [Access](../01-concepts/11-access.md#tokens).
