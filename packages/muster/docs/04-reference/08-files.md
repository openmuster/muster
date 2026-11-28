---
title: Files muster keeps
description: Every file and folder muster writes on your machine, what each holds, whether it is secret, and whether mu backup copies it. Read it before you back up, move or wipe a board.
---

muster keeps two folders. Both are readable only by your OS user.

- **The board folder** is `~/.muster`, or the folder `--dir` or `MUSTER_DIR`
  names. It holds the boards.
- **The config folder** is `~/.config/muster`, or `$XDG_CONFIG_HOME/muster`,
  or the folder `MUSTER_CONFIG` names. It holds everything else.

## The board folder

| Path | What it holds | Secret | `mu backup` copies it |
| --- | --- | --- | --- |
| `<name>.db` | The board: its log and the tables made from it, the tokens it made (as records, never the tokens), and sync bookkeeping | Yes: everything anyone wrote | Yes |
| `<name>.files/` | The files messages carry, each stored once by what it holds | Yes | Yes |
| `<name>.db-wal`, `<name>.db-shm` | SQLite's write-ahead log, part of the board while it is open | Yes | Yes, as part of the board |

## The config folder

| Path | What it holds | Secret | `mu backup` copies it |
| --- | --- | --- | --- |
| `keys/` | Each board's signing key for tokens, and keys retired by `mu token rotate-key` | Yes: anyone with a key can make tokens the board accepts | No |
| `claims/` | The token for each task you hold, one file per board | Yes | No |
| `board.ts` | The default board module: watchers, sync and outgoing webhooks | No, if its secrets are named with `env()` | No |
| `workflows.json` | The workflows the daemon starts | No | No |
| `oidc.json` | The workloads a served board trusts, and what each gets | No | No |
| `daemon/` | The daemon's restart guard, per board | No | No |
| `logs/` | The daemon's logs, one per board | Can hold what commands printed | No |
| `runs/` | An agent run's log, kept 30 days | Can hold what the agent printed | No |
| `e2b-bases.json`, `vercel-bases.json` | The sandbox snapshots this machine made | No | No |
| `update-check.json` | When `MUSTER_UPDATE_CHECK=1` last asked for the latest version, and the answer | No | No |

`mu daemon install` also writes a service file outside both folders: on macOS
`~/Library/LaunchAgents/<label>.plist`.

## Back up and move a board

`mu backup ./board.db` copies a board and its files while it runs. To move a
board to another machine with everything it needs, copy these too:

- `keys/`, or the tokens you gave out stop working there.
- `board.ts`, `workflows.json` and `oidc.json`, if you use them.

A restored board refuses tokens it made after the backup was taken, and a
reader whose place in the log is past the restored board's last event gets
`cursor_ahead`: see [errors](./05-errors.md).
