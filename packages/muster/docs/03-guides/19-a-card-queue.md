---
title: A card queue
description: Label a Linear issue for the agent, and get a spec, a pull request and a review back on it; you answer only what it asks.
---

## Who this is for

You keep work as cards, Linear issues or threads you post yourself, and want
an agent to take a card from start to finish: write a spec, make the change
as a pull request, and review it. You only want to hear about a card when the
agent needs a decision from you.

**You need:** muster on the machine that holds the board, `mu serve` reached
through a tunnel or a proxy, a Vercel project for the sandboxes, a GitHub App
installed on the repository, a model key, and for Linear cards a Linear key
and webhook. See [Agents in cloud sandboxes](./06-sandboxed-agents.md) for
the Vercel and GitHub parts.

## The parts

`templates/queue` is configuration for muster's own daemon and three small
scripts:

| File | What it does |
| --- | --- |
| `sync.json` | Linear team `ENG` to the channel `cards`, both ways |
| `watchers.json` | `card-start` runs `start.sh` for a card labelled `tag.agent=agent`; `needs-me` runs `notify.sh` when a task under `cards/` blocks |
| `workflows.json` | The `card` workflow: spec, work and review tasks, one Vercel worker, `--push` |
| `start.sh` | Marks the card `started` and asks for the `card` workflow on it, once |
| `notify.sh` | Tells you a task is blocked, with its ID only |
| `answer.sh` | Replies to a blocked task, unblocks it and starts a worker on it |

```mermaid
flowchart LR
  L[Linear issue labelled agent] -->|sync| C[thread in cards, tag.agent=agent]
  C -->|card-start| S[start.sh: started=yes, mu workflow run card]
  S --> R[cards/card-n: spec, work, review]
  R -->|started, then a summary| C
  C -->|sync| L
  R -->|task.blocked| N[needs-me: notify.sh]
  N --> Y[you: answer.sh]
  Y --> R
```

## Set it up

```bash
cp templates/queue/sync.json templates/queue/watchers.json templates/queue/workflows.json ~/.config/muster/
```

Then edit the copies:

- `watchers.json`: make `./start.sh` and `./notify.sh` the full paths of the
  scripts in `templates/queue`.
- `workflows.json`: `repo` is your repository's https address.
- `sync.json`: `ENG` is your Linear team's key.

Put the settings in the environment `mu serve` starts with. Its ticker runs
the watchers and the workflow, and the workers start with its environment:

```bash
export LINEAR_WEBHOOK_SECRET=...  LINEAR_API_KEY=lin_api_...
export MUSTER_SANDBOX_URL=https://board.example.com/api/board
export VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=...
export GITHUB_APP_ID=123456 GITHUB_APP_KEY_FILE=~/.config/muster/app.pem
export ANTHROPIC_API_KEY=sk-ant-...
mu serve --allow-host board.example.com
```

Use `MUSTER_SANDBOX_URL`, not `MUSTER_URL`. The watchers' scripts run `mu` on
the board's file here; with `MUSTER_URL` set they would go to the server
instead, with no token, and be refused. Point Linear's webhook at
`https://board.example.com/api/board/webhooks/lin`, as
[Linear](../02-sync/03-linear.md) says, and cap what the cards may cost:

```bash
mu budget cards 10
mu workflow list
```

## How a card goes

1. An issue in the team gets the label `agent`, when it is made or later. It
   arrives as a thread in `cards` with `tag.agent=agent`.
2. Within 30 seconds the watcher `card-start` runs `start.sh` with the
   thread's ID, as the profile `intake`. The script sets `started=yes` on the
   card only if it still has `tag.agent=agent` and has no `started`, in one
   write, and then asks for the `card` workflow on it. Any later wake, from a
   comment or the daemon's own reply, finds `started` set and does nothing.
3. The daemon makes three tasks in `cards/card-<n>`: `spec`, `work`, which
   needs the spec, and `review`, which needs the work. The spec task quotes
   the card's text as content, not instructions. One worker takes them in
   turn, each in its own Vercel sandbox; the work task's change is pushed to
   `mu/task-<id>` and opened as a pull request.
4. The card gets two replies, which go to Linear as comments: `started card:
   3 tasks in cards/card-<n>`, and once the tasks have ended, a summary with
   each task's result and the pull request.

The run's tasks are not sent to Linear: only `cards` is mapped, and
`cards/card-<n>` is another channel.

## A card you post yourself

A card needs no issue. Post it with the label, and with `--no-sync`, so it
doesn't open an issue in Linear: that issue would have no `agent` label, and
its next update would take `tag.agent` off the card.

```bash steps
mu post cards "Make the footer show the current year" --label tag.agent=agent --no-sync
mu read cards --label tag.agent=agent
```

This is what `start.sh` writes as its gate. Written a second time it fails
with `label_conflict`, which is how the script knows the card has started:

```bash steps
mu label 1 started=yes --if tag.agent=agent --if-unset started --as intake
```

## When it needs you

A worker that can't go on without a decision blocks its task with one line on
where things stand, then `->`, the decision it needs and what it recommends.
The watcher `needs-me` runs `notify.sh` with the task's ID: a macOS
notification, or, with `NOTIFY_CMD` in the daemon's environment, your own
command, given one line. Neither gets anything the task says.

```bash
mu read 14
./answer.sh 14 "SSO first."
```

`answer.sh` replies with your answer, unblocks the task, and starts a worker on
it with the workflow's settings, since the run's own worker stops after ten
idle minutes. If a worker of the run takes the task first, that is fine too.
Run it as yourself, with no `--as` and no `MUSTER_PROFILE`: the run's tasks
are the daemon's, and only the board's owner with no profile may unblock
them. Run it where `mu serve` runs, with the same `MUSTER_SANDBOX_URL`,
Vercel, GitHub App and model settings in your shell: it starts the worker
itself. It stays until the sandbox's run ends, as `mu run --push` does. If
the worker can't start, the task is answered and ready, and the script
prints the `mu run` line to retry with.

## When not to

- For work that needs a back-and-forth: the steps are fixed, spec, work and
  review, and the review only comments. Nothing is sent back for a second
  round.
- For a card whose text you wouldn't hand a stranger's agent. Anyone who can
  label an issue in the team can start a run.
- For a board other people's agents reach with tokens: the watchers run on
  the board's own machine, as its owner.

## What goes wrong

- **The request fails.** `start.sh` leaves `started` set, so a request that
  went through before the error doesn't start a second run, and replies on
  the card, on the board only, with the retry: `mu label <id> --unset started`.
  If the daemon refuses the request, it says why on the card itself.
- **A label taken off.** Before the watcher looked, nothing starts. After a
  run started, it goes on: cancel its tasks with `mu tasks cancel`.
- **The board was down.** With the key in `sync.json`, `mu serve` catches up
  when it starts again: an issue made meanwhile arrives with its labels, and
  an `agent` label added meanwhile to a card it has is brought in, and either
  starts the card, whatever state the issue is in, closed included: the
  budget on `cards` is the cap. Without a key there is no catch-up: an issue
  made while the board was down never arrives, and a label added meanwhile
  to a card it has arrives with the issue's next update.
- **An issue from before sync was set up.** Linear's webhook for a label
  added to it is dropped, since the board never saw the issue: see
  [Linear](../02-sync/03-linear.md). Make a new issue instead.
- **A long card.** The spec task quotes the first 2,000 characters.
- **Files on a card** don't reach the sandbox: the worker's token reaches
  the run's channel only.
- **A usage limit.** The worker stops and the task fails; the summary says so.
- **`answer.sh` says `isn't yours to change`.** It ran with a profile: unset
  `MUSTER_PROFILE`.

## Not tried live

The template is covered by tests: a Linear issue starting a run through the
real watcher, script and daemon, with workers and Linear's API as
stand-ins. It has not been run against Linear, Vercel and GitHub together.
