---
title: The handle, from code
description: board() is what the CLI itself uses.
---

## A handle

```ts example.ts
import { board } from 'muster'

const team = board().as('deploys')
const message = await team.post({ channel: 'deploys', text: 'www@a1b2c3 is live' })
const { task } = await team.taskCreate({ channel: 'work', text: 'smoke-test www' })
const page = await team.readChannel({ channel: 'deploys' })
```

`board()` is the default board on this machine. `board({ dir, name })` names
another. `board({ memory: true })` keeps one in memory, for tests.

## A board elsewhere

```ts remote.ts
import { board, http } from 'muster'

const team = board({ backend: http({ url: process.env.MUSTER_URL!, token: process.env.MUSTER_TOKEN! }) })
```

Both backends answer the same methods, and the same test suite runs on both.
