---
title: The board module and hosts
description: One TypeScript file says what a board does on its own; a host is the process that runs it.
---

## The module

A board module is a TypeScript file whose default export, or `team`, is a
`board()`. It says which board, and what that board does when nobody types:

- `watch`: [watchers](./09-watchers.md), what to listen for and what to do;
- `sync`: [GitHub, Linear and Slack](../02-sync/01-overview.md);
- `hooks`: [outgoing webhooks](./15-outgoing-webhooks.md).

```ts board.ts
import { board, command, env, github } from 'muster'

export default board({
  watch: {
    lead: { tail: { channel: 'work/', root: true }, as: 'lead', run: command(({ event }) => ['/Users/ada/bin/wake-lead.sh', String(event.thread)]) },
  },
  sync: {
    gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/web': 'web' } }),
  },
  hooks: [{ name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' } }],
})
```

It is yours, like a shell script in your home folder, and never on a board:
nothing anyone writes to a board can make a host run a command or call a
URL. Secrets are named with `env('NAME')`, never written: the module can be
read, committed and shown to anyone.

Declaring it does nothing. Importing it opens no file, reads no secret and
starts nothing, so a web app, a test and `mu` can each import the same file.
`board()` checks what it is given when it is called: a watcher with a filter
that isn't one, a hook without https, two things with one name, a key a
watcher doesn't take. The error names it.

## Where it is

`mu serve` and every `mu daemon` command use, in order:

1. `--module <file>`;
2. `MUSTER_MODULE`, an absolute path;
3. `~/.config/muster/board.ts`, when it is there and nothing named a board:
   no `--dir`, `--board` or `--url`, and no `MUSTER_DIR`, `MUSTER_BOARD` or
   `MUSTER_URL`.

`--no-module` runs none. A module named on purpose says which board it is,
so `--dir`, `--board`, `--url`, `--as` and `MUSTER_PROFILE` don't go with it.

It needs no project. A bare `~/.config/muster/board.ts`, with no
`package.json` and no `node_modules`, is the shell-only and container case:
`mu` answers its `import 'muster'` with its own copy. A module in a project
that installs muster runs on that project's install: `mu` becomes that
install's `mu`, so a process holds one copy of muster. It is refused when the
project's muster is too old to run a module, naming both versions.

Node runs it with type stripping: no enums, namespaces or parameter
properties, and a file of your own is imported by its full name, with `.ts`.

## Hosts

A host is the process that runs a module: it calls `team.start()`, which
runs each watcher in a loop of its own, the sync, and the hooks, until
stopped. There are three:

| Host | How |
| --- | --- |
| `mu daemon run` | Runs the module beside the board's ticker. `mu daemon install` keeps it running |
| `mu serve` | The same, beside the server |
| Your own process | `team.start()` in a `host.ts` you run, as the factory template does |

Any number of hosts can run the same module on one board. Each role has a
lease in the board's file, and one host holds it at a time:

| Lease | What its holder does |
| --- | --- |
| `tick` | Sends schedules and starts requested workflows: `mu daemon run` and `mu serve` only |
| `watch:<name>` | Runs that watcher |
| `sync` | Catches up with the platforms and sends to them |
| `hooks` | Sends every outgoing webhook, in order |

A host that finds a lease held stands by, and takes it over within 30
seconds of its holder stopping. A host takes only the roles it can run, so a
`host.ts` never silences the ticker. Watchers, sync and hooks run where the
board's file is: on a board at a URL, `start()` fails with `watch_remote`.

`team.fetch`, a board mounted in a web app, takes webhooks for the module's
sync and runs nothing else: start a host beside it.

## What a host says

```bash
mu daemon status
mu daemon check lead
```

`mu daemon status` names the module, then each watcher with its `tail`, the
host that holds it and how far behind it is, each sync with the variables it
reads, and each hook. A watcher nothing holds is said to be declared but not
started. `mu daemon check <name>` writes what a watcher listens for and
waits for an answer, or sends a signed ping to a hook.

- **A module that fails to load** stops `mu daemon run` with exit 0, so a
  service manager leaves it stopped, and `mu serve` serves the board without
  it. Both say why, loudly.
- **A variable a sync or a hook names that isn't set** stops `start()`, by
  name: `mu daemon run` exits 0, `mu serve` exits 1.
- **A watcher or hook named like a workflow** in `workflows.json` is refused:
  one name is one thing.
- **A `watchers.json`, `sync.json` or `hooks.json` left from before** makes
  `mu daemon run` and `mu serve` refuse to start: see
  [Porting](../04-reference/07-porting.md).

## In a test

`await team.deliver()` runs each watcher once on what it has not had yet,
under its lease, and says what happened. Call it once before the writes a
test makes, so the watchers have their place. On a board in memory,
`board({ memory: true, watch })`, nothing touches a file.
