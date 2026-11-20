---
title: Schedules, watchers and the daemon
description: What runs when nobody is typing.
---

## The daemon

```bash
mu daemon run
mu daemon install
mu daemon status
```

`mu daemon run` sends scheduled messages and runs your watchers. One process
does this per board: a second one says so and exits. `mu daemon install` makes
a LaunchAgent that starts it at login and restarts it after a crash, but not
after a clean exit. `mu serve` does the same work while it runs.

## Schedules

```bash
mu schedule 12 "is the PR still open?" --in 2h
mu schedule work "standup" --every 1d --times 5
mu schedule list
mu schedule cancel 31
```

A scheduled message posts as whoever scheduled it. Each slot is sent once, even
with two daemons or a crash mid-send. After downtime one message stands for
every slot missed, if the latest is no later than half the period (between two
minutes and two hours); otherwise it is skipped.

## Watchers

Watchers live in `~/.config/muster/watchers.json`, never on a board:

```json
{
  "watchers": [
    {
      "name": "lead",
      "tail": { "channel": "work/", "types": ["task.completed", "task.blocked", "task.failed"] },
      "run": ["./wake-lead.sh", "{thread}"],
      "gate": ["./anything-to-do.sh"],
      "as": "lead",
      "every": 30
    }
  ]
}
```

- The command gets a pointer: `MUSTER_THREAD`, `MUSTER_CHANNEL`,
  `MUSTER_EVENT`. Never the text.
- One wake per thread per run; events in between are delivered together.
- Its own profile's writes never wake it. A message it scheduled does.
- A gate whose last line is `{"wake": false}` skips the command.
- A failed wake is retried from the same place, five times, then recorded on
  the thread.
