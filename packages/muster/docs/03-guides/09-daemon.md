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
  into the service file, which only you can read. Without it, a sync or an
  outgoing webhook that names the secret can't start.
- **A config it can't read parks it.** A broken `watchers.json`, `hooks.json`
  or `sync.json` makes the daemon say so in its log and exit cleanly, and launchd leaves it
  stopped instead of restarting it forever. Fix the file and install again.
- **A daemon that keeps crashing stops itself.** See below.

Its log is in `~/.config/muster/logs/`.

## When it keeps crashing

launchd restarts a crashed daemon after 30 seconds, for ever. muster adds a
guard of its own. Each start is noted in `~/.config/muster/daemon/`, in a
file named for the board and where it is, before the board is opened. A
start that ends cleanly is taken off again, and a run that stays up two
minutes and ticks clears the list.

If the daemon starts five times in ten minutes and none of those runs stayed
up, the fifth start doesn't open the board. It writes the reason to its log
and stays up doing nothing, so launchd has nothing to restart. An hour after
it stopped it tries again, as a first start, so a fault that went away on
its own costs an hour at most. To try now:

```bash
mu daemon status
mu daemon reset
```

```text
stopped   since 2026-11-25T09:12:41.012Z: The daemon started 5 times in 10 minutes and never stayed up 2 minutes, so it has stopped restarting. It tries again at 2026-11-25T10:12:41.012Z, or now with mu daemon reset.
```

`status` shows how many quick starts it has had, or that it has stopped and
when it tries again. `mu daemon check` says `daemon_stopped` rather than
`no_ticker`. Read the log for what failed, fix it, and run `mu daemon reset`:
it clears the list, a stopped daemon starts within a few seconds, and an
installed service that isn't running is started. `mu daemon install` clears
it too. `--board`, `--dir` and `--url` pick the board for each of these, as
they do for `mu daemon run`.

The same applies under systemd or any supervisor that restarts on failure,
since the guard is in `mu daemon run` itself.

Some failures aren't crashes, and never count:

- **A board at a URL that can't be reached yet,** such as at login before the
  network is up, or while its server restarts. The daemon logs it once, then
  at 2, 4, 8 tries in a row, and waits up to 30 seconds between tries.
- **A board that opens but can't tick,** such as one whose file can't be read.
  The daemon logs the error the same way and waits up to 30 seconds between
  ticks. It never counts as having stayed up.

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
