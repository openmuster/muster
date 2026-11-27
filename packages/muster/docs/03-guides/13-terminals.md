---
title: With your terminal
description: Agents in panes, with tmux, Herdr or Rex, and a safe way to wake one when it gets a reply.
---

## Who this is for

You run agents as interactive sessions, each in its own terminal pane, and
want them to work off one board. muster doesn't care which terminal you use:
it never talks to one. This page is about the one thing terminals add, waking
a session that is sitting idle.

**You need:** muster, and your panes.

## The basics, in any terminal

One pane per agent. Each gets a name, set once in that pane's shell:

```bash
export MUSTER_PROFILE=worker-1
```

Then tell the agent in that pane how to work: install the board skill
(`mu skills install --to ~/.claude/skills`, or your agent's own skills
folder), or paste `skills/board/SKILL.md` into its instructions.
From there the agent takes tasks and waits on the board itself:

```bash
mu tasks claim --ready work/ --wait 10m
mu wait --re 12 --after 31 --timeout 30m
```

An agent that is mid-turn can wait like this. One that has ended its turn is
idle, and nothing on the board can make it type. That is what the rest of this
page is for.

## Two ways to get work to an idle agent

| Way | How | Good for |
| --- | --- | --- |
| A fresh session per task | `mu run --ready work/ --loop --agent claude` in the pane | Most work. No session to wake: each task starts clean |
| Wake the pane | A watcher types a line into the pane when something matches | A long-lived lead that should keep its context |

Prefer the first. A pane running `mu run --loop` is a worker that needs no
waking and no terminal tooling.

## Waking a pane, safely

A watcher runs a command when a board event matches. To wake a pane, that
command types one line into it. Three rules keep that from going wrong:

- **Type a pointer, never the message.** The line is `mu read <id>`. Text a
  stranger wrote must not be typed into a shell or an agent's prompt by a
  script.
- **Only when the agent is idle.** Keys sent mid-turn land in the wrong place,
  and an Enter can answer a permission prompt. Use a gate that checks.
- **One watcher per pane,** with the pane named in the watcher. Don't route by
  anything read from the board.

### tmux

In your board module, `~/.config/muster/board.ts`:

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    'wake-lead': {
      tail: { channel: 'work/', types: ['task.completed', 'task.blocked', 'task.failed'] },
      as: 'lead',
      run: command(({ event }) => ['/Users/ada/bin/wake-pane.sh', 'lead', String(event.thread)], {
        gate: ['/Users/ada/bin/pane-idle.sh', 'lead'],
      }),
    },
  },
})
```

Here `lead` is the tmux session the agent runs in; `tmux list-panes -a` shows
every pane's address if you need one pane of several.

`wake-pane.sh`:

```bash
#!/bin/sh
# $1 is the tmux pane, $2 the thread. Types a pointer and presses Enter.
tmux send-keys -t "$1" -l "A task changed. Read it: mu read $2"
tmux send-keys -t "$1" Enter
```

`pane-idle.sh` decides whether now is a good time and prints its answer as its
last line: `{"wake": false}` skips the wake, and the watcher tries again on
the next event. What "idle" looks like depends on your agent; one way is to
look at the pane's last line for the agent's input prompt:

```bash
#!/bin/sh
last=$(tmux capture-pane -p -t "$1" | grep -v '^$' | tail -1)
case "$last" in
  *">"*) echo '{"wake": true}' ;;
  *) echo '{"wake": false}' ;;
esac
```

A watcher's command starts with a small, clean environment. If tmux needs a
socket path, pass it: `tmux -S /path/to/socket ...`, or name the variable
in `command()`'s `env`. Start the daemon with `mu daemon run`, then
check that the pane wakes and its agent answers: `mu daemon check <watcher>`.

### Herdr

[Herdr](https://herdr.dev) is a terminal multiplexer for coding agents. It
knows whether an agent is idle, so it does the gate's job itself: its
`agent prompt` command submits text to a named agent and can wait until the
agent has taken it.

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    'wake-lead': {
      tail: { channel: 'work/', types: ['task.completed', 'task.blocked', 'task.failed'] },
      as: 'lead',
      run: command(({ event }) => ['herdr', 'agent', 'prompt', 'lead', `A task changed. Read it: mu read ${event.thread}`]),
    },
  },
})
```

Run the daemon from inside the Herdr session, so `herdr` reaches it. Check
`herdr agent prompt --help` for the options in your version.

### Rex

Rex is a terminal with a CLI that manages its sessions, tabs and panes. The
same recipe applies: a watcher whose command asks `rex` to run a line in the
pane that holds the agent. Its commands differ by version, so read
`rex --help` for how to address a pane and send it input, and keep the three
rules above.

> [!NOTE]
> Experimental: test the tmux idle check against your agent's own prompt
> before you rely on it. The Herdr and Rex recipes follow those tools' docs
> and haven't been run end to end.

## When not to

If every agent can be a fresh session per task, skip waking altogether. It is
simpler, costs less (no long conversation re-sent each turn), and survives a
closed terminal.
