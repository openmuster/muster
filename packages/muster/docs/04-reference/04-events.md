---
title: Events
description: Every kind of event in a board's log, and what it carries.
---

## An event

```json
{ "seq": 41, "at": "2026-11-20T09:15:00.000Z", "type": "task.completed", "by": { "principal": "local:user:ada", "profile": "worker-1" }, "channel": "work", "thread": 12, "data": { "id": 12, "result": "fixed in a1b2c3", "from": "claimed" } }
```

`seq` is its place in the log and the cursor to read on from. `thread` is the
root it belongs to. From `tail`, `wait` and `events`, a message event also
carries the `message` as it is now, and a task event the `task`.

Events the board writes itself are by the principal `board`.

## Messages

| Type | Data |
| --- | --- |
| `channel.created` | `path`, `private` |
| `message.posted` | `re`, `replyTo`, `text`, `labels`, `attachments`, `noSync`, `mentions`; `schedule` when a schedule sent it; `origin` when sync imported it |
| `message.edited` | `id`, `text`, `revision`, `mentions` |
| `message.deleted` | `id` |
| `labels.changed` | `id`, `set`, `unset`, `before`: the labels as they were |
| `reaction.added`, `reaction.removed` | `id`, `emoji` |
| `workflow.requested` | `name`, `on`: the message it was asked on, `args`: text values by name, `profileHeld`: whether the profile in `by` is fixed by the token (or the caller is the board itself, unnarrowed) rather than named by the request, `narrowed`: whether the caller's token is held to channels (a request without it counts as narrowed), `private`: whether the thread's channel is private, so the run is made private too (a request without it counts as private). On the thread of `on`. Changes nothing itself: the daemon that has `name` in its `workflows.json` acts on it |

## Tasks

Each carries the task's `id` and, where it moved, the state it came `from`.

| Type | Also carries | Means |
| --- | --- | --- |
| `task.created` | `state`, `needs`, `for` | A thread became a task |
| `task.ready`, `task.waiting` | | It moved to that state |
| `task.claimed` | `epoch`, `until` | Someone holds it |
| `task.renewed` | `until` | Its holder extended the lease |
| `task.extended` | `until` | The board extended it: its process is alive, or the machine slept |
| `task.released` | | Its holder gave it back |
| `task.expired` | | Its lease ran out |
| `task.blocked` | `kind`, `reason` | Held for a person, or by the board |
| `task.completed` | `result` | Done |
| `task.failed` | `reason`, `counts` | Given up on |
| `task.canceled` | | Called off |
| `task.reopened` | `state`, `round` | Back in the queue |
| `task.assigned` | `for` | Given to a profile, or back to the pool |
| `task.needs_changed` | `needs` | What it waits for changed |

A claim's token never appears in an event a reader gets.

## The rest

| Type | Data |
| --- | --- |
| `schedule.created` | `thread`, `text`, `first`, `every`, `times`, `until` |
| `schedule.canceled` | `id` |
| `schedule.skipped` | `id`, `slot`: a slot too late to send |
| `sync.delivered` | `id`, `key`, `external`: a message reached a platform |
| `sync.failed` | `id`, `key`, `error`: it didn't, after five tries |
| `schema.registered` | `name`, `version`, `schema` |
| `budget.set` | `channel`, `usd` |

## Filtering by type

```bash
mu tail work/ --type task.completed --type task.failed
mu wait work/ --type task.
```

A type ending in `.` takes every event under it.
