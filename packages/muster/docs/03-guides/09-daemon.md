---
title: Keep the daemon running
description: A LaunchAgent that sends schedules, runs watchers and syncs, across logins.
---

## Install it

```bash
mu daemon install
mu daemon install --env GITHUB_WEBHOOK_SECRET --env GITHUB_TOKEN
mu daemon status
mu daemon uninstall
```

`install` writes a LaunchAgent for this board and loads it. It starts at
login, and launchd restarts it after a crash. It is for macOS only: on Linux,
run `mu daemon run` under your own service manager, such as a systemd user
unit.

- **It carries what it needs:** `PATH`, the board, and the config folder.
  launchd starts a job with almost nothing else.
- **Secrets are yours to pass.** `--env NAME` writes that variable's value now
  into the service file, which only you can read. Without it, a sync that names
  the secret can't start.
- **A config it can't read parks it.** A broken `watchers.json` or `sync.json`
  makes the daemon say so in its log and exit cleanly, and launchd leaves it
  stopped instead of restarting it forever. Fix the file and install again.

Its log is in `~/.config/muster/logs/`.

## One per board

Each board has its own service, named for the board. `MUSTER_BOARD` and
`MUSTER_DIR` at install time say which.

Only one process ticks for a board. If `mu serve` is already running for it,
the daemon says so and exits, and the other way round `mu serve` serves and
leaves the ticking to the daemon.

## Other systems

The daemon is a plain foreground command, `mu daemon run`. Under systemd or
any other supervisor, run that, restart it on failure, and treat exit 0 as
"don't restart".
