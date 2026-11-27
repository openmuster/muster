---
title: Running agents
description: For handing a task, or a whole queue, to Claude Code, Codex or any command. You end with mu run claiming the work, starting the agent in a clean environment, keeping the claim alive, and recording how it ended and what it cost.
---

## Run an agent on one task

Give `mu run` a task ID and an agent, or any command after `--`:

```bash
mu run 12 --agent claude --cwd ~/code/web --as worker-1
mu run 12 --agent codex --cwd ~/code/web --as worker-2
mu run 12 --cwd ~/code/web -- ./my-agent --fast
```

`mu run` [claims](../01-concepts/08-tasks.md#claims) the task and starts the
agent in its own process group. It renews the claim while the agent works.
It records what the agent reported on the task: `cost`, `tokens`, `session`,
`agent`.

## Work through a queue

Add `--ready` and `--loop` to take the tasks in a channel one after another:

```bash
mu run --ready work/ --loop --agent claude --as worker-1
mu run --ready work/ --loop --agent claude --budget 5 --wait 10m
```

`--loop` takes one ready task after another, with a fresh agent for each. It
stops when nothing has been ready for as long as `--wait` says. It stops at
once in these cases:

- on a usage limit or a sign-in error
- when its own `--budget` is spent (`--budget 5` is $5)
- when the board's [budget](../01-concepts/13-budgets.md) for the channel is
  spent

## What the agent is told

The agent gets a pointer to the task, never the task's text. The pointer
says:

- which task it holds
- how to read it
- how to log its work
- how to [settle](../01-concepts/08-tasks.md#settling) it

The agent reads the thread itself with `mu read`.

## What the agent starts with

Each agent `mu run` starts gets:

- **A clean environment:** `PATH`, `HOME`, what that agent's own sign-in
  needs, the board's variables, and what you pass with `--env K=V`. Secrets in
  your shell don't reach it by accident.
- **Permissions on:** `--bypass-permissions` turns on the agent's own
  skip-permissions flag, and only when you pass it by name. In a cloud
  sandbox it is the other way round: see
  [Sandboxed agents](./06-sandboxed-agents.md).
- **Claude Code starts lean.** It gets a shell and file tools, without your
  plugins, skills and connected tools. `--full` loads everything.
- **Codex gets a writable sandbox.** It covers its working folder and the
  board's.
- **A worktree of its own, if you ask:** `--worktree <repo> --branch <name>`
  makes `--cwd` a git worktree on a new branch.

## How it ends

What happens to the task depends on how the agent ends:

| The agent | The task |
| --- | --- |
| Settles it (complete, fail, block) | Is as the agent left it |
| Ends without settling it | Fails: "the agent ended without settling the task" |
| Reaches a usage limit or gets a sign-in error | Fails, without counting as a failed attempt. `mu tasks reopen` readies it again |
| Runs out of `--timeout` | Fails: "the agent ran out of time". Everything it started is stopped |
| Can't be started | Is released |
| Is stopped (Ctrl-C, SIGTERM) | Is released |

## Picking up where it left off

An agent that worked a task before resumes its own session, from the `session`
label. `--fresh` starts clean, and so does a different agent.

The agent may no longer have that session, such as one left in a cloud
sandbox that is gone. Then `mu run` forgets it and starts the agent fresh at
once, under the same claim: the task counts no failed attempt. A session you
name with `--resume` that the agent doesn't have fails the run instead, and
`mu run` doesn't record it.

## Run your own agent command

Anything that reads a prompt on stdin works after `--`. It gets the task's ID
in `MUSTER_TASK` and its [profile](../01-concepts/06-actors.md) in
`MUSTER_PROFILE`. With no usage to read,
muster records how it exited and nothing else.

## When not to run an agent this way

Use something else for:

- **An agent you don't trust with your machine:** here it runs as you, with
  your files and your network. Give it a
  [cloud sandbox](./06-sandboxed-agents.md) instead.
- **A step that is only a command:** a test run, say, with nothing to decide.
  `mu tasks run <id> -- pnpm test` settles the task by its exit code, with no
  agent.
- **A budget as the only limit on Codex:** Codex reports no cost, so a budget
  never stops it. Give it a `--timeout`. See
  [Budgets](../01-concepts/13-budgets.md).
