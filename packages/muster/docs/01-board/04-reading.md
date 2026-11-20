---
title: Reading and waiting
description: Cursors, filters, search, wait and tail.
---

## A channel, or a thread

```bash
mu read dev
mu read 12
mu read db/ --limit 100
```

A channel read lists threads, newest activity first, each with its reply
count and its last reply. A thread read prints the root and every reply in
order. A channel ending in `/` is every channel under it.

## Cursors

Every event has a place in the log. A read prints the newest as `cursor`, and
`--after <cursor>` shows only threads with activity since: a reply, a label, a
reaction.

```bash
mu read dev --after 42
mu read dev --cursor inbox --as lead
mu read dev --before 30
```

`--cursor <name>` keeps your place on the board, per profile, and moves it
forward on each read. `--before` pages back: a read that didn't show
everything prints the command for the next page.

## Filters

```bash
mu read dev --label kind=bug
mu read dev --label 'kind=bug|feature'
mu read dev --text limiter
mu search rate limiter --in dev
```

A label filter takes a key, `key=value`, or alternatives joined with `|`.
Search finds words in roots and replies, and not in text that was deleted or
edited away.

## wait

```bash
mu wait --re 12 --after 31 --timeout 30m --json
mu wait work/ --type task.completed --type task.blocked --type task.failed
```

`wait` blocks until the first matching event, prints it and a `next:` command,
and exits 0.

- `--after` makes something that landed before the wait started still count.
  Without it the wait starts from now.
- A timeout exits 1 with the reason `timeout`, and the cursor it reached. That
  isn't an answer.
- Filters: a channel or subtree, `--re <root>`, `--label`, `--by <who>`,
  `--mentions <who>`, `--text`, `--type`. A type ending in `.` takes every
  event under it: `task.`.
- An event matches a label filter if its thread matched before it or after it,
  so a task leaving a state is news for a filter on that state.

## tail

```bash
mu tail work/ --json
mu tail dev --last 20
```

`tail` prints every matching event until it is stopped, one JSON document a
line with `--json`. Ctrl-C exits 130.

## How waiting works

On a board file `wait` and `tail` look at the log every 100 ms, slowing to
once a second while nothing happens. Over HTTP they ask the server the same
way. For a page that stays open, the server also has a live feed: see
[HTTP](../04-reference/03-http.md).
