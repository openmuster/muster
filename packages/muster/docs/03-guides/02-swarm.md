---
title: A swarm
description: For splitting one goal across several agents at once. You end with a lead that breaks the goal into tasks that own separate files, workers that each take one ready task in a fresh session, and a review task that checks the results.
---

## Who does what in a swarm

A lead plans and decides, workers each do one task, and a person owns the
goal. They never talk to each other directly: the plan is the board's tasks,
and every question, answer and result is in a task's thread.

The board's part is the queue:

- one holder per task (see [Claims](../01-concepts/08-tasks.md#claims))
- tasks that wait for what they need
- a hold for a person's answer (see
  [States](../01-concepts/08-tasks.md#states))
- a lease that returns a dropped task to `ready` when it runs out

The lead's part is judgment: splitting the goal, answering questions,
checking results.

## When a swarm fits, and when it doesn't

| It fits when | It doesn't when |
| --- | --- |
| The work splits into pieces that don't touch the same files | Pieces depend on each other's unfinished work |
| Each piece can be described to a reader who knows nothing | The goal is still being worked out |
| A command can show each piece is done | "Done" is a matter of taste |
| Someone, or another agent, checks results | Nobody will read what comes back |

If in doubt, start with [two agents](./10-two-agents.md). A swarm multiplies
cost as well as speed: every worker starts its own session.

## Split by file ownership

Two tasks that change the same files at the same time collide. Give each task
the paths it owns, and chain the ones that can't be separated:

```bash
mu tasks create work/checkout "Rate-limit the API. You own apps/api/checkout/." --as lead
mu tasks create work/checkout "Show the limit in the UI. You own apps/web/checkout/." --needs 1 --as lead
```

## Run a swarm from the command line

Create the tasks from a plan file (see
[A plan in one write](../01-concepts/08-tasks.md#a-plan-in-one-write)), start
the workers, and have the lead wait for results:

```bash
mu tasks create work/checkout --file plan.json --as lead
mu run --ready work/checkout --loop --agent claude --as worker-1
mu run --ready work/checkout --loop --agent codex --as worker-2
mu wait work/checkout --type task.completed --type task.blocked --type task.failed --as lead
```

Each `mu run --loop` is a worker: it takes the next ready task, starts a fresh
agent on it, and does that again until nothing is ready. The lead's guide is
the board skill's `references/swarm.md`.

## Run a swarm from the template page

`templates/swarm` is a page that does the same from a form:

```bash
cd templates/swarm
pnpm install
pnpm dev        # on 127.0.0.1 only: the page has no sign-in
```

On the page:

- The form takes a goal, a run name, how many agents, which agent, and where
  they run.
- Launching posts the run's thread, queues one planning task, and starts the
  workers. The planning task's agent splits the goal into tasks.
- `/live` shows the queue by state, who holds what, and the newest messages.

Agents run as local processes with the access of whoever started the page.
Launch a run only on code you would run yourself.

## Check and limit what workers do

Put these checks in place:

- **"Completed" is what the worker says, not evidence.** Make a review task
  that needs the work, and give it to a different agent.
- **A review that fails sends the work back.** Reopen the work with
  `mu tasks reopen <id> --round`.
- **A budget:** `mu budget work/checkout 20` stops new claims once the tasks
  there have cost $20.
- **A lead keeps a short session.** It keeps its state in a thread on the
  board, so it can start over when a piece of work closes.

## What it costs to start an agent

Each task gets a fresh session. A Claude Code worker that `mu run` started
has been measured at about 13,000 tokens before it reads its task, and a
small task at about $0.18.
