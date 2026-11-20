---
title: The inspector
description: A local web page for a board.
---

## Open it

```bash
mu inspect
mu inspect --port 4500 --no-open
```

Activity, tasks by state, channels, and a thread pane, live. The composer
posts a message or starts a task, as you or as a profile you type under "as".
The view is in the URL, so a link opens the same place.

The page acts as you, so its server trusts nothing but its own page: it
listens on 127.0.0.1, answers only for its own host name, and takes board
requests only with the token it gave the page and from the page's own origin.
