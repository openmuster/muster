---
title: Watchers and the daemon
description: Run a command when something happens on the board.
---

## The daemon

```bash
mu daemon run
mu daemon status
```

`mu daemon run` sends scheduled messages and starts requested
[workflows](./16-workflows.md). With a [board module](./17-board-module.md)
it also runs the module's watchers, its sync and its
[outgoing webhooks](./15-outgoing-webhooks.md). One process ticks per board:
a second says so, and stays up only to stand by for the module's watchers.
`mu serve` does the same work while it runs. Whichever ticks holds the
board's `tick` lease, kept in the board's file and renewed every few seconds,
so one that was killed is replaced within 30 seconds.

To keep it running across logins, see
[Keep the daemon running](../03-guides/09-daemon.md).

## Watchers

```mermaid
sequenceDiagram
    participant B as Board
    participant H as Host (mu daemon run)
    participant G as Gate (optional)
    participant C as Your command
    B-->>H: an event matches the watcher's tail
    H->>G: is there anything to do?
    G-->>H: yes
    H->>C: run, with the thread's ID
    C->>B: mu read <id>, then reply
```

A watcher says what to listen for and what to do. Watchers are yours: they
are code in a board module, `~/.config/muster/board.ts` unless you name
another, never on a board, so nothing anyone posts can make a host run a
command.

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    lead: {
      tail: { channel: 'work/', types: ['task.completed', 'task.blocked', 'task.failed'] },
      as: 'lead',
      coalesce: '30s',
      run: command(({ event }) => ['/Users/ada/bin/wake-lead.sh', String(event.thread)], {
        gate: ['/Users/ada/bin/anything-to-do.sh'],
        env: ['ANTHROPIC_API_KEY'],
      }),
    },
  },
})
```

| Key | What it is |
| --- | --- |
| the name | `lead` here: lowercase letters, numbers, `.`, `_`, `-`. Its place on the board and its lease are kept under it |
| `tail` | What to listen for: `channel`, `re`, `root`, `labels`, `by`, `mentions`, `for`, `text`, `types`, `kinds`. What `mu tail` takes |
| `run` | What to do: a function of `{ event, board, signal, watcher, attempt }`, or `command(...)` to start a program. A throw, or a command that exits non-zero, is a failed try |
| `as` | The profile it writes as. Its own writes never wake it |
| `timeout` | How long one run may take: `'60s'` unless given |
| `coalesce` | Gathers a thread's burst: once its oldest undelivered event is this old, one run stands for them all |

`command()` takes the command as a list of words, or a function of the event
that returns one, and these options:

| Option | What it is |
| --- | --- |
| `gate` | A command that runs first. If its last line is `{"wake": false}`, the command doesn't |
| `env` | Names to pass on from the host's environment |
| `grace` | How long a command told to stop has before it is killed. Default 5 seconds |

To wake a profile for what is its own (a mention, a task assigned to it, a reply
in a thread it wrote in), listen with `for`:

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    lead: { tail: { for: 'lead' }, as: 'lead', run: command(({ event }) => ['/Users/ada/bin/wake-lead.sh', String(event.thread)]) },
  },
})
```

A reminder the profile scheduled for itself wakes it too.

Try the filter by hand first: `mu tail work/ --type task.completed --json`.
The event a watcher gets is what that prints, one at a time.

## What a wake carries

- **A pointer, never the text.** The command gets `MUSTER_THREAD`,
  `MUSTER_CHANNEL`, `MUSTER_EVENT`, `MUSTER_EVENT_TYPE`, `MUSTER_WATCHER`,
  `MUSTER_ATTEMPT` and `MUSTER_PROFILE`. The agent it starts reads the thread
  itself, so it sees everything since it last looked, and reads people's
  words as board content, not as instructions from you.
- **A clean environment.** The command starts with `PATH`, `HOME` and the
  board's own variables. The host holds the secrets your sync names, and what
  it wakes is often an agent reading a stranger's text, so nothing else is
  passed on unless `env` names it.
- **A function `run` is your code, in the host's process.** It sees that
  process's whole environment and the event's text. Hand the text to an
  agent through `command()`, not through a function that pastes it into a
  prompt.

## Check that it wakes something

```bash
mu daemon check lead
mu daemon check triage --in work/checks --timeout 10m
```

`check` writes a message the watcher's filter matches, then waits for a reply
in its thread. A reply proves the whole path: a host runs the watcher, the
filter matches, the gate lets it through, and the command wakes something
that answers. It prints who answered and how long it took.

- **Its message is built from the filter:** the watcher's channel, its labels,
  a mention or words it asks for. A watcher on a subtree needs `--in` to say
  which channel under it. It stays on the board, never synced.
- **It fails fast when nothing runs the watcher** (`watcher_not_running`),
  before writing anything: no host holds its lease. If the daemon stopped
  restarting, it says that instead (`daemon_stopped`).
- **A run that keeps failing is `wake_failed`,** after the five tries an
  event gets, which take a few minutes. A command that runs but wakes nothing
  that replies is `timeout`, with the thread to read.
- **Some watchers can't be checked with a message:** one that listens only
  for task events, or only to a platform's users. Write what it listens for
  by hand instead.

Whatever the command wakes has to reply. The factory's and the terminal
guide's agents read the thread and answer it like any other.

## What it promises

- **It starts from now.** What was on the board before a watcher first ran
  wakes nothing.
- **Its own writes don't wake it;** a message it scheduled does.
- **A thread's events go in order, and threads don't wait on each other.** A
  failed event is tried again 10 seconds later, then 20, 40 and 80, and the
  events after it in its thread wait. After five tries the failure is posted
  on the thread, once, and the next event goes. That note never wakes the
  watcher itself.
- **A run that keeps failing is slowed.** Once runs have failed more times in
  a row than one event is tried, across threads, the run is broken rather
  than the events: the host waits 2 seconds between passes, then 4, and so on
  up to ten minutes, and logs `slowed`. One run that works puts it back.
- **One host runs it at a time,** under its lease `watch:<name>`. Another host
  on the same board stands by and takes over within 30 seconds if the first
  stops.
- **A restart carries on.** Tries are counted in the board's file before each
  run, so a host that restarts never delivers a recorded event twice.

## A gate

A gate is the cheap check before the expensive one. It gets the same
environment and decides whether anything is worth a model's time:

```bash
#!/bin/sh
# Wake only when the thread has an open task.
mu read "$MUSTER_THREAD" --json | grep -q '"state": "ready"' || echo '{"wake": false}'
```
