---
title: Running unattended
description: For anyone leaving agents to work through a queue overnight on one machine. You end with tasks a command can check, a budget, looping workers, and a morning read of what finished, what failed and what waits for you.
---

## Who this is for

You have a queue of tasks and want agents to work through it overnight, on
this machine, without it costing more than you decided.

**You need:** muster, an agent CLI signed in, and a machine that stays awake.

## Queue the work

Write each task for a reader who knows nothing: what to make, which files are
theirs, and the command that shows it is done.

Task IDs skip numbers (each task takes two places in the board's log), so the
first task on a new board is 1 and the second is 3. Use the IDs `create`
prints:

```bash steps
mu tasks create work/api "Add input validation to POST /orders. You own apps/api/orders/. Done when pnpm test apps/api/orders passes." --as ada
mu tasks create work/api "Document POST /orders in docs/api.md from the code." --needs 1 --as ada
mu tasks work/ --as ada
```

## Set a limit before you leave

Set a [budget](../01-concepts/13-budgets.md) on `work`, then check it:

```bash steps
mu budget work 20 --as ada
mu budget --as ada
```

Once the tasks under `work` have cost $20, the board refuses new claims
there. A budget counts only what `mu run` records: it stops new claims, and it
isn't your bill. Set a spend limit with your model provider too.

## Start workers that keep going

Start a worker that takes ready tasks one after another:

```bash
mu run --ready work/ --loop --wait 10m --agent claude --as night-1
```

`--loop` takes the next ready task, starts a fresh agent on it, then takes
the next one. `--wait 10m` keeps the worker waiting up to 10 minutes for work
before it stops. For 2 workers at a time, run a second one under another
name.

## What keeps it safe while you're away

While you are away, these hold:

- **A task can't be taken twice.** One agent holds it at a time, under a
  [lease](../01-concepts/08-tasks.md#claims).
- **A worker that dies loses its task.** Its claim lapses and the task goes
  back to the queue.
- **A task that keeps failing is blocked.** After two attempts that ended
  without a result the board blocks it as `failing`, so no agent spends more
  tokens on it. It waits for you.
- **A usage limit stops the worker.** It doesn't spend retries on the limit.
  The task it was on is left `failed`, with the limit as its reason: see
  [Restart after a usage limit](#restart-after-a-usage-limit).
- **A question blocks its task.** The worker moves to the next one.

## Restart after a usage limit

The worker stops, because the next task would fail on the same limit. The task
it was working on is `failed`, and a failed task isn't taken again until its
owner reopens it. Starting the worker again doesn't retry it. When the limit
has lifted, list the failed tasks, reopen each by the ID the list shows (12
here), and start the worker again:

```bash
mu tasks work/ --state failed
mu tasks reopen 12
mu run --ready work/ --loop --wait 10m --agent claude --as night-1
```

Read the reason before you reopen: a task that failed for another cause is
in the same list. muster doesn't wait a limit out for you.

## Schedule a morning check

The [daemon](../01-concepts/09-watchers.md#the-daemon) sends scheduled
messages and runs watchers. Keep it running:

```bash
mu daemon install
```

Then schedule a message for the morning, and check it is queued:

```bash steps
mu schedule work/notes "morning check: what is blocked?" --in 8h --as ada
mu schedule list --as ada
```

See [Keep the daemon running](./09-daemon.md).

## Review the results in the morning

List every task, then the blocked ones, then what was spent:

```bash steps
mu tasks work/ --state all --as ada
mu tasks --state blocked --as ada
mu budget --as ada
```

Read the blocked ones first: they are questions, or tasks that failed twice.
A task held as `backlog` is work set aside for later, not a question. Then
read the results of the completed ones. `mu inspect` shows the same in a
browser.

## When not to run unattended

Don't leave these to agents overnight:

- Work whose result you can't check by a command. Unattended agents need a
  test to pass or fail, not taste.
- Anything with access you wouldn't leave a contractor alone with. Local
  agents run with your access; see
  [Agents in cloud sandboxes](./06-sandboxed-agents.md) for agents that run
  apart from your machine.
