---
title: Keep the daemon running
description: For keeping schedules, watchers and sync running on a Mac across logins and crashes. mu daemon install adds a LaunchAgent per board, and on Linux you run mu daemon run under systemd or another supervisor. mu daemon check proves a watcher or an outgoing webhook answers.
---

## Install the daemon on macOS

These commands install the daemon for this board, install it with secrets
passed in, show its status, and remove it:

```bash
mu daemon install
mu daemon install --env GITHUB_WEBHOOK_SECRET --env GITHUB_TOKEN
mu daemon status
mu daemon uninstall
```

`install` writes a LaunchAgent, a per-user macOS service, for this board and
loads it. The service starts at login, and launchd, the macOS service
manager, restarts it after a crash. `install` is for macOS only: on Linux,
run `mu daemon run` under your own service manager, such as a systemd user
unit.

The service works like this:

- **The service file holds what it needs.** It sets `PATH`, the board, the
  config folder, and the [board module](../01-concepts/17-board-module.md) by
  its absolute path, run from the folder you installed it from. launchd
  starts a job with almost nothing else.
- **Secrets are yours to pass.** `--env NAME` writes that variable's value now
  into the service file, which only you can read. Without it, a sync or an
  outgoing webhook that names the secret can't start.
- **A fault a restart can't fix stops it.** A module that fails to load, a
  secret it names that isn't set, or a leftover `watchers.json`, `sync.json`
  or `hooks.json` makes the daemon log the reason and exit cleanly. launchd
  then leaves it stopped instead of restarting it indefinitely. Fix the cause
  and install again. muster no longer reads those three files: move what
  they list into the module, as [Porting](../04-reference/07-porting.md)
  shows.
- **A daemon that keeps crashing stops itself.** See
  [When the daemon keeps crashing](#when-the-daemon-keeps-crashing).

The daemon's log is in `~/.config/muster/logs/`.

## Check that a watcher wakes something

Name the [watcher](../01-concepts/09-watchers.md#watchers) to check, and, for
one on a subtree, the channel under it:

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

Whatever the command wakes has to reply. The agents in
[A software factory](./03-factory.md) and
[With your terminal](./13-terminals.md) read the thread and answer
it like any other.

## Check that an outgoing webhook arrives

Name the [outgoing webhook](../01-concepts/15-outgoing-webhooks.md) to
check, then see whether a host sends it:

```bash
mu daemon check phone
mu daemon status
```

`check` sends a signed ping to the hook's URL from this terminal and prints
what the receiver answered. Its event has the type `ping` and is not on the
board. The secret has to be set where you run it.

- **`hook_failed`** when nothing answered, or the receiver refused it. A
  `401` or `403` usually means the two sides hold different secrets.
- **It proves the URL and the secret, not the host.** Whether a host sends the
  hooks is `mu daemon status`, and its log says what each hook sent.

## When the daemon keeps crashing

launchd restarts a crashed daemon after 30 seconds, indefinitely. muster adds
a restart guard of its own. Before it opens the board, the daemon records
each start in `~/.config/muster/daemon/`, in a file named for the board and
its location. A start that ends cleanly removes its record, and a run that
stays up 2 minutes and [ticks](../01-concepts/09-watchers.md#the-daemon)
clears the list.

If the daemon starts 5 times in 10 minutes and none of those runs stayed up,
the daemon doesn't open the board on the fifth start. It writes the reason to
its log and stays up doing nothing, so launchd has nothing to restart. An
hour after it stopped, it tries again as a first start, so a fault that went
away on its own costs an hour at most. To try now, check the status and
reset the guard:

```bash
mu daemon status
mu daemon reset
```

```text
stopped   since 2026-11-25T09:12:41.012Z: The daemon started 5 times in 10 minutes and never stayed up 2 minutes, so it has stopped restarting. It tries again at 2026-11-25T10:12:41.012Z, or now with mu daemon reset.
```

`status` shows how many quick starts the daemon has had, or that it has
stopped and when it tries again. `mu daemon check` says `daemon_stopped`
rather than `watcher_not_running`. `--board`, `--dir` and `--url` pick the
board for each of these, as they do for `mu daemon run`.

Read the log for what failed, fix it, and run `mu daemon reset`. It clears
the list, and a stopped daemon starts within a few seconds. If the service is
installed but not running, `mu daemon reset` starts it. `mu daemon install`
clears the list too.

The same applies under systemd or any supervisor that restarts on failure,
since the guard is in `mu daemon run` itself.

Some failures aren't crashes, and never count:

- **A board at a URL that can't be reached yet:** at login before the network
  is up, for example, or while its server restarts. The daemon logs the error
  on the first failed try, then on the 2nd, 4th, 8th and so on in a row. It
  waits up to 30 seconds between tries.
- **A board that opens but can't tick:** one whose file can't be read, for
  example. The daemon logs the error the same way and waits up to 30 seconds
  between ticks. It never counts as having stayed up.

## Run one daemon per board

Each board has its own service, named for the board. `MUSTER_BOARD` and
`MUSTER_DIR` at install time set which board it is.

Only one process ticks for a board. If `mu serve` is already running for it,
the daemon says so and exits. If the daemon is already running, `mu serve`
serves the board and leaves the ticking to the daemon.

Whichever process ticks holds the board's `tick`
[lease](../01-concepts/09-watchers.md#the-daemon), a row in the board's own
file that it renews every 5 seconds.

A second process that finds the lease held watches it for a few seconds. If
the holder renews, the second process says so and exits. If it doesn't,
because the daemon was killed and launchd has just restarted it, the lease
lapses within 30 seconds and the new process takes over. A crash costs at
most 30 seconds of ticking, and leaves no lock file to clear.

For a board at a URL, the server it is on does the ticking: `mu daemon run`
against one says so and exits 0. Run the daemon, or `mu serve`, on that
machine.

## Run the daemon under systemd or another supervisor

The daemon is a plain foreground command, `mu daemon run`. Under systemd or
any other supervisor, run that, restart it on failure, and treat exit 0 as
"don't restart".
