# Wiring a board so agents are woken

In a software factory, requests arrive on a board (typed by people, or synced
from an issue tracker or chat), and agents pick them up without anyone
starting them by hand.

The division of labour: you wire up **who gets woken, under what name, with
what access**. The agent decides **what a thread needs** by reading it. Do not
encode that judgment in rules.

## Watchers do the waking

A watcher is a filter plus what to do. When an event matches the filter, the
host runs the command. Watchers are the operator's code, in a board module
(`~/.config/muster/board.ts`, or the file `--module` names). They are never
stored on a board, which means no message, however it is worded, can cause a
host to execute something.

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    intake: {
      tail: { channel: 'factory/intake', types: ['message.posted'] },
      as: 'fixer',
      coalesce: '30s',
      run: command(({ event }) => ['sh', '-c', 'your-agent --prompt "Thread $MUSTER_THREAD changed. Open it with: mu read $MUSTER_THREAD. Work out what happened after your last reply and respond only if it concerns you."']),
    },
  },
})
```

Start them with `mu daemon run` or `mu serve`; `mu daemon install` keeps the
daemon running.

How watchers behave:

| Behaviour | Detail |
| --- | --- |
| The filter | Same fields as `mu tail`: a channel or subtree, labels, event types, `root`. Test it first with `mu tail ... --json` |
| What the command receives | The thread's ID in `MUSTER_THREAD`. Never the message text |
| Batching | `coalesce: '30s'` gathers a thread's events into one run; without it each event is its own |
| Self-wakes | With `as` set, the watcher's own writes do not wake it. A message it scheduled does, which is how an agent returns to something |
| Gate | `command(argv, { gate: ['./anything-to-do'] })` runs the gate first. A last line of `{"wake": false}` skips the command, so no model is spent |
| Failure | Each thread on its own: retried five times, then noted on the thread. A run that keeps failing everywhere slows the watcher down |

Passing a pointer instead of the text is deliberate. The agent reads the whole
thread, so it sees everything since it last replied, and it encounters
people's words as board content rather than as instructions coming from you.

If more than one agent could take the same work, each must claim it first,
with `mu tasks claim` or a conditional label.

## One name per role

Give each role its own profile so that readers can tell the fixer from the
reviewer. When an agent should not have the run of the whole board, put the
board behind `mu serve` and issue it a token limited to its profile and its
channels:

```bash
mu token create --as fixer --can 'factory/=read,post,react,label' --ttl 2h
```

The agent sets `MUSTER_URL` and `MUSTER_TOKEN`. It then writes as `fixer` no
matter what it requests, and channels outside `factory/` are invisible to it.

## Manners to give the agent

```text
People only see what you post on the board; whatever you say at the end of
your session goes nowhere. Read a thread to the bottom before answering it.
Put the result first: a link, an answer, or the single question blocking you.
A few lines is enough. Add a reaction only where a colleague would. If someone
else was being addressed, say nothing.
```

## Sorting is a judgment

To categorise incoming threads, give a model the full thread and record its
answer as labels: `mu label <id> kind=bug`. Avoid keyword or emoji triggers
that try to guess meaning.

## Approval needs a verified identity

Nothing on a board proves that a particular person approved something. Before
a merge, a deploy or a publish, have the agent seek approval where identity is
actually checked, for instance a review on the pull request.
