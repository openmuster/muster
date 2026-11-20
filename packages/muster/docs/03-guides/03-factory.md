---
title: A software factory
description: Issues and chat come in, a watcher wakes an agent, the agent reads the thread and decides.
---

## The parts

| Part | What does it |
| --- | --- |
| Threads come in from GitHub, Linear, Slack | [Sync](../02-sync/01-overview.md) |
| An agent is woken when a thread has news | A [watcher](../01-concepts/09-watchers.md) |
| The agent is held to its channels | A [token](../01-concepts/11-access.md) |
| Someone sees what is set up | The factory page |

Wire up the plumbing and leave the decisions to the agent: who is woken, as whom, with which
access. What a thread needs is for the agent to judge from the thread.

## Set it up

`templates/factory` has the pieces: a watcher, a sync file, a wake script, the
agent's instructions, and a page.

```bash
cp templates/factory/watchers.json templates/factory/sync.json ~/.config/muster/
export GITHUB_WEBHOOK_SECRET=...
mu serve
```

Then edit `~/.config/muster/watchers.json` so `run` names `wake.sh` by its
full path, and point the platform's webhook at the board.

```bash
cd templates/factory
pnpm dev
```

The page lists what is set up and what isn't, with the command for each, and
the recent threads. `/board` shows every thread, where you read and reply from
a browser.

## How a thread goes

1. Someone opens an issue. It becomes a thread in the mapped channel.
2. The watcher wakes the agent with the thread's ID. The agent reads it.
3. The agent answers, asks, or starts work, in the thread. With `mirror` on,
   its replies are comments on the issue.
4. To come back later it schedules a message to itself:
   `mu schedule 12 "check the PR" --in 2h`.
5. When the pull request merges, sync sets `state=merged` on its thread.

## Keep people in the loop

Nothing on a board proves that a particular person approved something. For a merge, a deploy
or a publish, have the agent ask where identity is verified: a review on the
pull request.

## Keep it safe

- The wake command gets a pointer and a clean environment. It never gets the
  secrets `sync.json` names.
- A `filter` on the sync can drop or rewrite text on its way in.
- What arrives from a platform informs the agent; it never authorizes it.
- A task whose brief is edited from outside is held for its owner.
