---
title: A software factory
description: Issues and chat come in, a watcher wakes an agent, the agent reads the thread and decides.
---

## The parts

| Part | What does it |
| --- | --- |
| Threads come in from GitHub, Linear, Slack | [Sync](../02-sync/01-overview.md) |
| An agent is woken when a thread has news | A [watcher](../01-concepts/09-watchers.md) |
| The agent is held to its channels | A [token](../01-concepts/11-access.md) |
| Someone sees what is set up | The factory page |

Wire up the plumbing and leave the decisions to the agent: who is woken, as whom, with which
access. What a thread needs is for the agent to judge from the thread.

## Set it up

`templates/factory` has the pieces: a board module (`lib/board.ts`) with
the GitHub sync and the watcher, a host that runs them (`host.ts`), a wake
script (`lib/wake.ts`), the agent's instructions, and a page that also takes
the webhooks. Put your repository in place of `acme/web` in `lib/board.ts`,
then start the page and the host, each in its own terminal, from
`templates/factory`, with the webhook's secret in both:

```bash
export GITHUB_WEBHOOK_SECRET=...
pnpm dev
```

```bash
export GITHUB_WEBHOOK_SECRET=...
pnpm host
```

The module names the secret with `env()`, so it is never written in the
file: the page reads it on its first request, and `host.ts` when it starts,
refusing to start while it is unset. Point GitHub's webhook at
`https://board.example.com/api/board/webhooks/gh`, and list
`board.example.com` in `ALLOW_HOSTS`. The page listens on 127.0.0.1: the
webhook reaches it through a proxy or a tunnel with a public HTTPS name. The
webhook brings a thread in; `host.ts` runs the watcher, and the sync's
catch-up and sending.

Schedules are sent by a daemon that holds `tick`. Run it without a module:
`host.ts` runs this one.

```bash
mu daemon run --no-module
```

With all three running, check from `templates/factory` that the watcher
wakes the agent and that the agent answers:

```bash
mu daemon check factory --module "$PWD/lib/board.ts" --in factory/issues
```

The template's sync brings threads in and sends nothing back. To have the
agent's replies posted as comments, give the repository `mirror: true` and
the sync a `token: env('GITHUB_TOKEN')`: see [GitHub](../02-sync/02-github.md)
and [Sync](../02-sync/01-overview.md#in-a-board-module).

The page lists what is set up and what isn't, with the command for each, who
holds each role (`tick` for the daemon, `sync` and `watch:factory` for the
host), and the recent threads. `/board` shows every thread, where you read
and reply from a browser.

## How a thread goes

1. Someone opens an issue. It becomes a thread in the mapped channel.
2. The watcher wakes the agent with the thread's ID. The agent reads it.
3. The agent answers, asks, or starts work, in the thread. With `mirror` on,
   its replies are comments on the issue.
4. To come back later it schedules a message to itself:
   `mu schedule 12 "check the PR" --in 2h`.
5. When the pull request merges, sync sets `state=merged` on its thread.

Sync makes threads, not tasks. Nothing puts an issue in the queue on its own:
the agent that is woken, or you, makes the thread a task with
`mu tasks create <id>` when the work should be claimed, tracked and settled
like any other.

## Route by label

One agent that reads the thread and decides is the default, and it is enough
for most boards. Split it in two only when the answers need different
instructions, different access or different owners: a help channel for several
products, say. Then one watcher sorts and one watcher per product answers.

```mermaid
flowchart LR
  S[Slack #help] -->|sync| T[thread in help]
  T -->|router wakes| R[router agent]
  R -->|product=billing| B[billing agent]
  R -->|product=api| A[api agent]
  R -->|product=none| N[nobody]
  B -->|reply| S
  A -->|reply| S
```

In the board module:

```ts board.ts
import { board, command, type Watch } from '@openmuster/muster'

/** A product's watcher: woken when its label lands, and for what comes after in its threads. */
const product = (name: string): Watch => ({
  tail: { channel: 'help', labels: [`product=${name}`], types: ['labels.changed', 'message.posted'] },
  as: `${name}-bot`,
  // The question and its label arrive together: one wake for both.
  coalesce: '30s',
  run: command(({ event }) => ['/srv/help/answer.sh', String(event.thread), name], { gate: ['/srv/help/has-product.sh', name] }),
})

export default board({
  watch: {
    router: {
      tail: { channel: 'help', types: ['message.posted'] },
      as: 'router',
      run: command(({ event }) => ['/srv/help/route.sh', String(event.thread)], { gate: ['/srv/help/unlabelled.sh'] }),
    },
    billing: product('billing'),
    api: product('api'),
  },
})
```

The router's agent reads the thread and writes one label on it, and nothing
else. Its instructions name the products and what each covers, and end with
the command:

```bash
mu label <thread> product=billing --if-unset product
```

`--if-unset` makes the first answer stand: a second try exits 1 with
`label_conflict`, so have `route.sh` treat that as done. Use `product=none`
for what isn't a product question. It is a label like the others: it stops
the router from being asked again, and no watcher listens for it.

The two gates keep a model from being started for nothing:

```bash
#!/bin/sh
# unlabelled.sh: wake the router only for a thread nobody has sorted yet.
mu read "$MUSTER_THREAD" --json | grep -q '"product":' && echo '{"wake": false}'
```

```bash
#!/bin/sh
# has-product.sh <product>: wake a product's agent only while the thread is still its own.
mu read "$MUSTER_THREAD" --json | grep -q "\"product\": \"$1\"" || echo '{"wake": false}'
```

`route.sh` and `answer.sh` do what the factory's `lib/wake.ts` does, with
other instructions: they pass a pointer, and the agent reads the thread
itself.

Try the plumbing by hand, with you as the router:

```bash steps
mu post help "How do I change the card on my account?" --as ada
mu label 1 product=billing --if-unset product --as router
mu read help --label product=billing --as ada
```

What to know before you rely on it:

- **Give each watcher its own `as`.** A watcher never hears its own profile's
  writes. A product's agent that writes as `router` can't hear the router's
  label.
- **It costs two agent sessions a question.** Each watcher runs in a loop of
  its own: the router's agent labels the thread, and the product's watcher
  hears the label within a second or two. `coalesce` gathers the question and
  its label into one wake, once the oldest is 30 seconds old.
- **A product's watcher hears more than the label arriving:** later messages
  in the thread, the label being taken away, and any other label changing on
  it. The gate handles the label leaving. Tell the agent to reply only when
  the last message isn't its own. To answer the first question only, drop
  `message.posted` from its `types`.
- **A gate that fails wakes the agent.** Only `{"wake": false}` on its last
  line says no; its exit code isn't read. `unlabelled.sh` wakes the router
  when `mu read` fails, and `has-product.sh` doesn't wake its agent.
- **An agent that exits 0 without writing a label isn't tried again.** The
  thread stays unsorted until someone posts in it or labels it by hand.
- **Fix a wrong label by hand:** `mu label <thread> product=api`. The api
  agent is woken, and the gate keeps billing's asleep.
- **`mu daemon check router` times out,** because the router labels and never
  replies. Check a product's watcher instead, which builds its message with
  the label: `mu daemon check billing`.
- **"Label only" is an instruction, not a limit.** The router reads text
  strangers wrote. On a served board give it a
  [token](../01-concepts/11-access.md) held to that channel.
- **Messages sent while the board is down come in late.** When the board
  starts again it reads what [Slack](../02-sync/04-slack.md) has since, with
  limits that page gives.

## Keep people in the loop

Nothing on a board proves that a particular person approved something. For a merge, a deploy
or a publish, have the agent ask where identity is verified: a review on the
pull request.

## Keep it safe

- The wake command gets a pointer and a clean environment. It never gets the
  secrets the sync names.
- A `filter` on the sync can drop or rewrite text on its way in.
- What arrives from a platform informs the agent; it never authorizes it.
- A task whose brief is edited from outside is held for its owner.
