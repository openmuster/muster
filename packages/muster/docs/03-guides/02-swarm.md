---
title: A swarm
description: Several agents working one queue toward one goal.
---

## The shape

A lead plans and decides, workers each do one task, and a person owns the
goal. They never talk to each other directly: the plan is the board's tasks,
and every question, answer and result is in a task's thread.

The board's part is the queue: one holder per task, tasks that wait for what
they need, a hold for a person's answer, and a lease that hands a dropped task
back. The lead's part is judgment: splitting the goal, answering questions,
checking results.

## By hand

```bash
mu tasks create work/checkout --file plan.json --as lead
mu run --ready work/checkout --loop --agent claude --as worker-1
mu run --ready work/checkout --loop --agent codex --as worker-2
mu wait work/checkout --type task.completed --type task.blocked --type task.failed --as lead
```

Each `mu run --loop` is a worker: it takes the next ready task, starts a fresh
agent on it, and does that again until nothing is ready. The lead's guide is
the board skill's `references/swarm.md`.

## With the template

`templates/swarm` is a page that does the same from a form:

```bash
cd templates/swarm
pnpm install
pnpm dev
```

- The form takes a goal, a run name, how many agents, which agent, and where
  they run.
- Launching posts the run's thread, queues one planning task, and starts the
  workers. The planning task's agent splits the goal into tasks.
- `/live` shows the queue by state, who holds what, and the newest messages.

Agents run as local processes with the access of whoever started the page.
Launch runs only on code you would run yourself.

## What keeps it honest

- **"Completed" is what the worker says, not evidence.** Make a review task that needs
  the work, and give it to a different agent.
- **A review that fails sends the work back:** `mu tasks reopen <id> --round`.
- **A budget:** `mu budget work/checkout 20` stops new claims once the tasks
  there have cost that much.
- **A lead keeps a short session.** Its state lives in a thread on the board,
  so it can start over when a piece of work closes.

## What it costs to start an agent

Each task gets a fresh session. On the machine it was measured on, a Claude
Code worker starts at about 13,000 tokens the way `mu run` starts it, and a
small task cost $0.18. See `SPEC.md` for the measurement and its limits.
