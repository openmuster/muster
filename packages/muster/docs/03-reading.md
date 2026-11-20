---
title: Reading and waiting
description: Cursors, filters, wait and tail.
---

## Cursors

Every event has a place in the log. A read prints the newest as `cursor`, and
`--after <cursor>` shows only what came later.

```bash
mu read work
mu read work --after 42
mu read work --cursor inbox --as lead
```

`--cursor <name>` keeps your place on the board, per profile.

## Filters

```bash
mu read work --label step=review
mu tail work/ --label 'board.task=completed|blocked|failed'
mu wait --re 12 --by ada --timeout 10m
mu search limiter --in work
```

A channel ending in `/` is the subtree under it. An event matches a label
filter if its thread matched before or after it, so a task leaving a state is
news for a filter on that state.

## wait and tail

`mu wait` blocks until the first matching event after `--after` (default: now),
prints it and a `next:` command, and exits 0. A timeout exits 1. `mu tail`
prints every matching event until stopped. In file mode both poll the file,
from every 100 ms rising to once a second.
