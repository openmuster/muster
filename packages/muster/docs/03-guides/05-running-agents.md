---
title: Running agents
description: For handing a task, or a whole queue, to Claude Code, Codex or any command. mu run claims it, starts the agent in a clean environment, keeps the claim alive, and records how it ended and what it cost.
---

## One task

```bash
mu run 12 --agent claude --cwd ~/code/web --as worker-1
mu run 12 --agent codex --cwd ~/code/web --as worker-2
mu run 12 --cwd ~/code/web -- ./my-agent --fast
```

`mu run` claims the task, starts the agent in its own process group, renews
the claim while it works, and records what the agent reported on the task:
`cost`, `tokens`, `session`, `agent`.

## A worker

```bash
mu run --ready work/ --loop --agent claude --as worker-1
mu run --ready work/ --loop --agent claude --budget 5 --wait 10m
```

`--loop` takes one ready task after another, a fresh agent for each, until
nothing is ready for as long as `--wait` says. It stops at once on a usage
limit or a sign-in error, when its own `--budget` is spent, and when the
board's [budget](../01-concepts/13-budgets.md) for the channel is.

## What the agent is told

A pointer: which task it holds, how to read it, how to log its work, and how
to settle it. Never the task's text. It reads the thread itself with `mu read`.

## What the agent starts with

- **A clean environment:** `PATH`, `HOME`, what that agent's own sign-in
  needs, the board's variables, and what you pass with `--env K=V`. Secrets in
  your shell don't reach it by accident.
- **Permissions on.** `--bypass-permissions` turns on the agent's own
  skip-permissions flag, and is always asked for by name. In a cloud sandbox it
  is the other way round: see [Sandboxed agents](./06-sandboxed-agents.md).
- **Claude Code starts lean:** a shell and file tools, without your plugins,
  skills and connected tools. `--full` loads everything.
- **Codex gets a writable sandbox** over its working folder and the board's.
- **A worktree of its own,** if you ask: `--worktree <repo> --branch <name>`
  makes `--cwd` a git worktree on a new branch.

## How it ends

| The agent | The task |
| --- | --- |
| Settles it (complete, fail, block) | Is as the agent left it |
| Ends without settling it | Fails: "the agent ended without settling the task" |
| Hits a usage limit or a sign-in error | Fails, without counting against it. `mu tasks reopen` readies it again |
| Runs out of `--timeout` | Fails: "the agent ran out of time". Everything it started is stopped |
| Can't be started | Is released |
| Is stopped (Ctrl-C, SIGTERM) | Is released |

## Picking up where it left off

An agent that worked a task before resumes its own session, from the `session`
label. `--fresh` starts clean, and so does a different agent. A session the
agent no longer has, such as one left in a cloud sandbox that is gone, is
forgotten and the agent starts again fresh at once, under the same claim: the
task counts no failed attempt. A session you name with `--resume` that the
agent doesn't have fails the run instead, and is not remembered.

## Any agent

Anything that reads a prompt on stdin works after `--`. It gets the task's ID
in `MUSTER_TASK` and its profile in `MUSTER_PROFILE`. With no usage to read,
muster records how it exited and nothing else.
