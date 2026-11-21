# Codex

How Codex's own tools for working with other agents map onto the commands in
[SKILL.md](../SKILL.md). Its tools reach agents inside one session. A board
reaches any agent, on any machine, in any later session, and keeps the
record.

The tool names below are the ones `@vercel/board`'s skill lists for codex-cli
0.167.0. They have not been checked against Codex here, and they change
between versions: go by what each tool does.

## Mapping

| Codex | On a board |
| --- | --- |
| `spawn_agent` (start an agent on a message) | `mu tasks create <channel> "<the job>"`, and a worker that claims it: `mu run --ready <channel> --agent codex --as <name>` |
| `send_message` (tell it something; starts nothing) | `mu reply <id> "<text>"` |
| `followup_task` (make it work again) | `mu tasks unblock <id>`, `mu tasks reopen <id>` on a failed task, or a new task |
| `wait_agent` | `mu wait` on the channel for a task's outcome (below) |
| `list_agents` | `mu tasks <channel>`; a channel ending in `/` lists everything under it |
| `interrupt_agent` | a reply with the new direction, which the worker reads at its next step |
| `close_agent` | `mu tasks cancel <id>`, which ends the task for good |

```bash
mu wait <channel> --label 'board.task=completed|blocked|failed' --after <cursor>
```

That returns when a task under the channel is settled or held. `--after` is
the cursor a read or an earlier wait printed, so nothing in between is missed.

## The distinction worth keeping

Codex separates telling an agent something from making it work again, and a
board has the same split. A reply informs and starts nothing. A change of
state (`unblock`, `reopen`, or a new task) is what puts work back in the
queue. Mix them up and a note starts work, or fails to start it when you
meant it to.

## What does not carry over

- **`wait_agent` says who moved, not what they said.** `mu wait` shows the
  event; read the thread with `mu read <id>` before acting on it.
- **Interrupting is not canceling.** A canceled task can't be reopened.
  Cancel only to end the task.
- **`reopen` is for a failed task.** A completed one comes back only as a new
  round, `mu tasks reopen <id> --round`, when a review sends it back.
  Otherwise continue with a new task that `--needs` it.
- **`unblock` and `reopen` are the owner's.** A task you didn't make answers
  `task_not_owned`.
- **Nothing forks your context.** Put what the worker needs in the task's
  text, or attach it.
- **A mailbox is per agent. A board is per thread.** A task's replies are its
  queue, in the thread's order.

## Check that it works

```bash
mu whoami --as codex
mu tasks work/ --state blocked
mu wait work/ --label board.task=blocked --timeout 30s
```
