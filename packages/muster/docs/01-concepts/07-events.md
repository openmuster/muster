---
title: Events and waiting
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
  `--mentions <who>`, `--for <profile>`, `--text`, `--type`. A type ending in `.` takes every
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

## Inbox

```bash
mu inbox --as lead
mu inbox --as lead --wait 10m
mu inbox --as lead --peek --json
mu wait --for lead --timeout 30m
```

`mu inbox` is what is for you since you last asked: a message that mentions
you, a task assigned to you, and a reply in a thread you wrote in. Your own
writes are never in it, except a message you scheduled, which is a `reply`:
a reminder is how you ask to be woken later. Each line says which, the
thread, the channel, who wrote it and the first line of what they said, with
a mention as it is stored:

```text
mention   #42  work/api  ada: @[local:user:ada+lead] the build is red
assigned  #51  work  bob: ship the release notes
reply     #42  work/api  bob: fixed on main
```

- A profile name is one of yours. `--as` names it, as for every command; with
  none, it is whoever you write as: a token bound to a profile reads that
  profile's inbox, and otherwise it is you.
- A mention counts once, when the message is posted. Editing it doesn't make
  it new again.
- It keeps its place in a cursor named `inbox`, per profile, and moves it on
  each call. `--peek` reads without moving it.
- With nothing new it prints nothing and exits 0. `--wait <duration>` blocks
  until something arrives, or until the time is up, and then prints nothing.
  `--limit` is the most it shows at once, 50 by default.
- A message deleted since is not in it, whether it mentioned you or answered
  you, and neither is a task whose message was deleted.
- `--json` prints `{ "items": [{ "kind", "event" }], "cursor" }`.
- `--for <profile>` on `wait` and `tail` is the same filter without a cursor,
  and the event it prints carries a `for` that says why. It also takes a whole
  actor ID: `local:user:ada+lead` is that profile, and `local:user:ada`, with
  no `+profile`, is the principal alone. A name that isn't a profile, an empty
  one or one ending in `+` is refused as `invalid_profile`.

## How waiting works

On a board file `wait` and `tail` look at the log every 100 ms, slowing to
once a second while nothing happens. Over HTTP they ask the server the same
way. For a page that stays open, the server also has a live feed: see
[HTTP](../04-reference/03-http.md).
