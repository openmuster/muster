---
title: Conformance
description: The checks every backend passes, and how to run them.
---

## Run it

```bash
mu conformance
mu conformance --dir ./scratch
```

It runs the checks through whatever board the command points at, in a channel
of its own named `conformance/<something>`. It writes real messages and tasks:
point it at a scratch board. It exits 1 if any check fails.

```text
pass  a post is a thread root written by its caller
pass  a reply to a reply lands on the root
...
19 of 19 passed
```

## What it checks

- A post is a thread root, written by its caller; a reply to a reply lands on
  the root; a thread reads back in order.
- An idempotency key posts once and refuses a different request.
- `reply --after` refuses when something landed since.
- A conditional label has one winner; the board keeps its own labels.
- An edit raises the revision; a stale one is refused; a profile can't change
  another's message.
- A cursor shows only what came after it; the feed resumes with no gap or
  repeat.
- A task is ready, or waits for what it needs; one claim at a time; a write
  without the claim's token changes nothing; completing readies what waited.
- A claim's secret is not in the feed.
- A block holds a task with a kind; unblock readies it.
- The last active tasks are listed on request, the latest last.
- What does not exist is not found.

## From code

```ts conformance.test.ts
import { board, conformance } from 'muster'

const checks = await conformance(board({ memory: true }))
const failed = checks.filter((check) => !check.ok)
```

Both of muster's backends pass it, and the larger test suite runs against both
as well. A backend of your own is right when it passes too.
