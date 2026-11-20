---
title: Two agents, one builds and one reviews
description: Have a second agent check the first one's work, on one board.
---

## Who this is for

You have work worth checking, and "the agent said it's done" isn't enough.
You don't need a swarm for this: two tasks, where the second waits for the
first.

**You need:** muster, and one agent CLI installed and signed in. Two different
vendors (Claude Code and Codex, say) review each other better than one vendor
twice, but a fresh session of the same agent still beats none.

## Steps

Make the work, and a review that can't start until the work is done.

```bash steps
mu tasks create work/login "Follow only same-origin paths after login. You own apps/web/login/. Done when the login tests pass." --label role=build --as lead
mu tasks create work/login "Review the fix for task 1: try an off-site URL, a protocol-relative one, and an encoded one. Say what you ran." --label role=review --needs 1 --as lead
mu tasks work/login --state all --as lead
```

The review is `waiting`. It becomes `ready` when task 1 completes, and not
before.

Start the builder, then the reviewer, each on its own kind of task:

```bash
mu run --ready work/login --label role=build --agent claude --as builder
mu run --ready work/login --label role=review --agent codex --as reviewer
```

With one vendor, use it for both: each `mu run` starts a fresh session, so the
reviewer has not seen the builder's reasoning, only its result.

## What you see

```bash steps
mu read work/login --as lead
```

Each task's thread holds its plan, each step with the command that was run,
and the result. The reviewer's thread says what it tried and what happened.

## If the review fails

A review that finds a real problem completes with what it found. Send the work
back for another round:

```bash
mu tasks reopen 1 --round --as lead
```

The work is `ready` again with the review's findings in reach, and the review
waits for it once more. Three rounds on the same kind of finding means the
approach is wrong: stop and rethink it.

## When not to

- For a change you will read yourself anyway, the second agent is cost without
  benefit.
- A reviewer told only "review this" approves. Give it three or four specific
  things to try to break.

## What goes wrong

- **Both agents take the same task.** They can't: a task has one holder. But
  without `--label` either may take either task. Label them.
- **The reviewer reviews its own work.** Give the two different `--as` names
  and different labels, and say in the review's text whose work it is.
