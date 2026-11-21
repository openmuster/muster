---
title: Running unattended
description: Leave agents working while you are away, with limits, and read what happened after.
---

## Who this is for

You have a queue of tasks and want agents to work through it overnight, on
this machine, without it costing more than you decided.

**You need:** muster, an agent CLI signed in, and a machine that stays awake.

## Queue the work

Each task is written for a reader who knows nothing: what to make, which files
are theirs, and the command that shows it is done.

Task IDs skip numbers (each task takes two places in the board's log), so the
first task on a new board is 1 and the second is 3. Use the IDs `create`
prints.

```bash steps
mu tasks create work/api "Add input validation to POST /orders. You own apps/api/orders/. Done when pnpm test apps/api/orders passes." --as ada
mu tasks create work/api "Document POST /orders in docs/api.md from the code." --needs 1 --as ada
mu tasks work/ --as ada
```

## Set a limit before you leave

```bash steps
mu budget work 20 --as ada
mu budget --as ada
```

Once the tasks under `work` have cost 20 dollars, no new one can be claimed
there. A budget counts what `mu run` records; it is a brake, not a bill. Set
a spend limit with your model provider too.

## Start workers that keep going

```bash
mu run --ready work/ --loop --wait 10m --agent claude --as night-1
```

`--loop` takes the next ready task, starts a fresh agent on it, and goes
again. `--wait 10m` keeps it waiting that long for work before it stops. Run a
second one under another name for two at a time.

## What keeps it safe while you're away

- **A task can't be taken twice.** One holder, under a lease.
- **A worker that dies loses its task.** Its claim lapses and the task goes
  back to the queue.
- **A task that keeps failing is parked.** After two attempts that ended
  without a result the board blocks it as `failing`, so it stops eating
  tokens. It waits for you.
- **A usage limit stops the worker,** it doesn't burn retries. The task it
  was on is left `failed`, with the limit as its reason: see below.
- **A question blocks its task** and the worker moves to the next one.

## After a usage limit

The worker stops, because the next task would meet the same limit. The task
it was working on is `failed`, and a failed task isn't taken again until its
owner reopens it. Starting the worker again doesn't retry it. When the limit
has lifted:

```bash
mu tasks work/ --state failed
mu tasks reopen 12
mu run --ready work/ --loop --wait 10m --agent claude --as night-1
```

Read the reason before you reopen: a task that failed for another cause is
in the same list. muster doesn't wait a limit out for you.

## Things that should happen on a clock

The daemon sends scheduled messages and runs watchers. Keep it running:

```bash
mu daemon install
```

```bash steps
mu schedule work/notes "morning check: what is blocked?" --in 8h --as ada
mu schedule list --as ada
```

See [Keep the daemon running](./09-daemon.md).

## The morning after

```bash steps
mu tasks work/ --state all --as ada
mu tasks --state blocked --as ada
mu budget --as ada
```

Read the blocked ones first: they are questions, or tasks that failed twice.
Then the completed ones' results. `mu inspect` shows the same in a browser.

## When not to

- Work whose result you can't check by a command. Unattended agents need a
  test to pass or fail, not taste.
- Anything with access you wouldn't leave a contractor alone with. Local
  agents run with your access; see
  [Agents in cloud sandboxes](./06-sandboxed-agents.md) for a boundary.
