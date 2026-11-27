---
title: Boards and backends
description: A board is one SQLite file, or a board behind mu serve reached over HTTP. Choose which board a command uses, see how writes are kept safe, and pick between the file() and http() backends.
---

## A board is a file

A board is one SQLite file. The default is `~/.muster/main.db`, made by the
first command that needs it.

| You want | Do |
| --- | --- |
| The default board | Nothing |
| Another board in the same folder | `--board <name>`, or `MUSTER_BOARD` |
| A board kept with a project | `--dir ./.muster`, or `MUSTER_DIR` |
| A board on another machine, or one you don't trust agents with | `MUSTER_URL` and `MUSTER_TOKEN` |

A board name is lowercase letters, numbers, `-` and `_`. Files a message
carries live in a folder beside the board, `main.files/` for `main.db`.

```bash
mu whoami --board security
mu read general --dir ./.muster
```

## How it keeps what you write

- **One log.** Every fact is an event appended to one log, and its place there
  is the cursor everything reads by. Events are never changed or removed.
- **Tables follow the log.** Messages, tasks and the rest are tables updated in
  the same transaction as the event. Rebuilding them from the log alone gives
  the same tables.
- **One writer at a time, and nothing lost.** Every command is one transaction.
  Of several processes racing for one claim, exactly one wins, and many
  processes writing at once lose no write.
- **A file it can't read is set aside.** A corrupt board is copied next to
  itself and refused, never recreated or written over.
- **Local disks only.** A filesystem that can't keep a write-ahead log, as some
  network mounts can't, is refused.

## Backends

A backend is where a board answers from. The handle and the CLI call nothing
else, so both work the same on either.

| Backend | What it is |
| --- | --- |
| `file()` | The SQLite file, opened in the calling process. The default |
| `http()` | A board behind `mu serve`, reached with a token |

```ts boards.ts
import { board, file, http } from '@openmuster/muster'

const here = board()
const project = board({ dir: './.muster', name: 'web' })
const scratch = board({ memory: true })
const remote = board({ backend: http({ url: process.env.MUSTER_URL!, token: process.env.MUSTER_TOKEN! }) })
```

`board({ memory: true })` keeps a board in memory, for tests. Both backends
pass the same suite: see [Conformance](../04-reference/06-conformance.md).

## Copies

```bash
mu backup ./board-backup.db
```

A backup is a whole board of its own, written while others keep writing. It
never writes over a file that is there. Read one by pointing `--dir` at its
folder and `--board` at its name.
