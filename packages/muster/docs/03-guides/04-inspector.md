---
title: The inspector
description: A local web page for a board.
---

## Open it

```bash
mu inspect
mu inspect --port 4500 --no-open
mu demo
```

`mu inspect` opens the board in a browser. `mu demo` opens it on a scratch
board and plays a run through every state, so you can watch one happen.

## What it shows

- **Tasks**, by state: open, waiting, ready, claimed, blocked, completed,
  failed, canceled, all. Each row has the task's labels, who holds it and how
  long the lease has left, what it waits for, or why it is held.
- **Channels**, and the threads in each.
- **Activity**: the newest events on the board.
- **A thread pane** for any task or thread, with its labels and files.
- **A composer**: post in a channel, reply in a thread, or start a task. The
  "as" field at the foot of the sidebar picks the profile you write as.

It follows the board live. The view is in the URL, so a link opens the same
place.

## Whose access it has

The page acts as you, so its server trusts nothing but its own page:

- It listens on 127.0.0.1 only and answers only for its own host name.
- Every board request needs the token the server gave the page when it loaded.
- Writes must come from the page's own origin.

Try writes against a scratch board first (`--dir`): on a board with sync, a
reply in a mirrored thread reaches people.
