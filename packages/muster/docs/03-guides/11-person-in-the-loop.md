---
title: A person in the loop
description: Let an agent ask you something, wait for the answer, and carry on.
---

## Who this is for

You want an agent to stop and ask when a decision is yours, not guess. And you
want to find those questions without watching a terminal.

**You need:** muster. For a ping on your phone, the daemon and anything that
can send you a notification from a command.

## How a question works

An agent that hits a decision it shouldn't make writes the question in its
task's thread, with what it would choose, and blocks the task. Here you make
the task as yourself, and the agent writes as `claude`.

```bash steps
mu tasks create work/billing "Set the retry limit for failed payments and document it."
mu tasks claim --ready work/billing --as claude
mu reply 1 "Question: retry 3 times or 5? I would pick 3: the provider's docs say more is rate-limited." --as claude
mu tasks block 1 "retry 3 times or 5?" --kind needs_input --as claude
```

The task is now `blocked`, and the agent is done with it. Nobody is waiting on
a process: the question lives on the board.

## Find what is waiting for you

```bash steps
mu tasks --state blocked
mu read 1
```

## Answer

Reply in the thread, then unblock. Only a task's owner (whoever made it) may
unblock it: blocking ended the agent's claim, so nobody holds the task.
Whichever agent is free next takes it
and reads the thread from the top, your answer included.

```bash steps
mu reply 1 "3. Revisit if the provider raises the limit."
mu tasks unblock 1
mu tasks --state ready
```

## An agent that stays and waits

For a quick question the agent can wait inside its turn instead of blocking:

```bash
mu wait --re 1 --after 3 --timeout 30m --as claude
```

It returns when a reply lands, or exits 1 after the timeout. A timeout is
silence, not an answer: the agent should block the task then, not decide for
you.

## A ping when something needs you

A watcher runs your command when a task blocks. Put it in your board module,
`~/.config/muster/board.ts`, and run `mu daemon run`:

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    'needs-me': {
      tail: { channel: 'work/', types: ['task.blocked'], kinds: ['!backlog'] },
      run: command(({ event }) => ['/Users/ada/bin/notify.sh', String(event.thread)]),
    },
  },
})
```

`notify.sh` is yours: a desktop notification, a message to your phone, an
email. It gets the thread's ID, never the question's text, so nothing a
stranger wrote ends up in a shell command. See
[Watchers](../01-concepts/09-watchers.md).

`kinds: ['!backlog']` leaves out tasks parked for later (below): they are
blocked too, but nobody is asking you anything. Try a filter by hand first:
`mu tail work/ --type task.blocked --kind '!backlog'`.

## Work that isn't for now

Not every blocked task is a question. To write down work no agent should take
yet, make it held:

```bash steps
mu tasks create work/payments "Move retries to the new provider." --hold backlog --reason "after the migration"
mu tasks claim --ready work/payments --as claude || echo "nothing to take"
```

The claim finds nothing: a `--ready` claim never takes a blocked task. The
task is made and held in one write, so no agent can claim it in between. When
its time comes, unblock it like any other:

```bash steps
mu tasks unblock 8
mu tasks --state ready
```

`backlog` is a convention, not a rule: any kind works, and the board treats
them all alike. Pick one and filter on it.

## Approvals

A message on a board does not prove who wrote it: an agent writes with its
person's access. For anything that can't be undone (a merge, a deploy, a
publish), have the agent ask for the approval somewhere identity is checked,
such as a review on the pull request, and treat the board as where the
question was asked.

## When not to

Don't route every small choice to a person. Tell the agent which decisions are
yours (spending, scope, anything irreversible) and let it make the rest and
say why in a line.
