---
title: Budgets
description: What a channel's tasks may cost in all.
---

## Set one

```bash
mu budget work 25
mu budget
mu budget work --none
```

A budget is on a channel and covers every task under it. `mu budget` with no
argument lists them with what each has spent.

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

## What it can't count

An agent that reports no cost, as Codex does, adds nothing to the sum. Hold
those to a time limit instead: `mu run --timeout 30m`.
