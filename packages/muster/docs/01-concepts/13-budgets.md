---
title: Budgets
description: A budget caps what the tasks under a channel may cost in dollars. Once it is spent, the board refuses new claims there with over_budget. Agents that report no cost, such as Codex, need a time limit instead. mu report shows how work went and what it cost, by agent and workflow.
---

## A budget is on a channel

```bash
mu budget work 25
mu budget
mu budget work --none
```

A budget is on a channel and covers every task under it. `mu budget` with no
argument lists them with what each has spent, and `--none` lifts one. To
set one before agents work through a queue overnight, see
[Running unattended](../03-guides/12-unattended.md#set-a-limit-before-you-leave).

## What it counts, and what it stops

A task's cost is its `cost` label, in dollars. `mu run` writes it from what
the agent reported, along with `tokens`. Anything else that runs agents can
write the same label.

Once the tasks under a channel have cost as much as its budget, the board
gives no new claim there: `claim` and `run` fail with `over_budget`. Work
already claimed carries on, so a run can go over by what its agents spend on
the tasks they hold.

A looping worker (`mu run --ready work/ --loop`) stops when the board says the
money is spent. `--budget <usd>` on the worker is a limit of its own, on what
that one worker has spent.

## Know the cost before a worker starts

```bash
mu run --ready work --estimate --agent claude
```

A looping worker (`mu run --ready work --loop`) prints one line before it
takes its first task, and `--estimate` prints only that line and starts
nothing:

```text
3 ready, about $0.90 at $0.30 a task
```

The count is the ready tasks this worker may take, read as `--ready` reads
the channel (`work` is that channel, `work/` every channel under it): its
owners, `--from`, `--by`, `--label`, and tasks assigned to it or to nobody.
The price is what a task in that channel or under it cost that agent on
average over the last 30 days, from the `cost` labels below. With no cost
on record, as for Codex, it says `no cost history` and gives no figure.
An estimate changes nothing about a budget: the board still refuses claims
once the money is spent.

## See how work went

```bash
mu report work
mu report --since 7d --json
```

`mu report` reads the tasks under a channel (every channel when you name
none) that changed in the last 30 days, or in `--since`. It groups them by
the `agent` label `mu run` writes, and again by the `workflow` label a
[workflow](./16-workflows.md)'s tasks have. It changes nothing.

```text
since 2026-10-29 in #work
agent       tasks  1st round  rounds  failed  failing  input  cost      per task
claude          2      1 50%    1.00       0        0      1  $0.60     $0.30
codex           1       0 0%    1.00       1        0      0  -         -
```

| Column | Meaning |
| --- | --- |
| `tasks` | Tasks in the group |
| `1st round` | Completed and never sent back with `tasks reopen --round`, and their share |
| `rounds` | Rounds on average: 1, and 1 more for each `--round` |
| `failed` | Tasks in the state `failed` now |
| `failing` | Tasks the board held as `failing` at least once |
| `input` | Times a task was held with kind `needs_input` |
| `cost`, `per task` | The sum of `cost` labels, and that sum over the tasks that have one |

What it can't say:

- **No model.** `mu run` records the agent, not the model it ran, so the
  report has no model column.
- **The last run's cost.** Each run of a task writes its `cost` label
  again, so a task sent back shows what its latest round cost.
- **No agent, no row of its own.** `mu run` writes `agent` only when it
  read a session from the agent. Tasks without it are `(none)`.

## What it can't count

An agent that reports no cost, as Codex does, adds nothing to the sum. Hold
those to a time limit instead: `mu run --timeout 30m`.
