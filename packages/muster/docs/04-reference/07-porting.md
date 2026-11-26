---
title: Porting from the JSON files
description: What watchers.json, sync.json and hooks.json become in a board module.
---

## What changed

Watchers, sync and outgoing webhooks are declared in a board module: a
TypeScript file that exports `board({ watch, sync, hooks })`. The three JSON
files in `~/.config/muster/` that held them before are no longer read.

A `watchers.json`, `sync.json` or `hooks.json` left there makes
`mu daemon run` and `mu serve` refuse to start, with `config_retired`, so
nothing it listed stops without a word. `mu daemon run` exits 0, so a service
manager leaves it stopped. `mu daemon status` names the file. Move what it
lists into a module, then delete it.

The module is `~/.config/muster/board.ts` when nothing else names one, or
the file `--module` or `MUSTER_MODULE` names. `workflows.json` and
`oidc.json` stay where they are, and are read as before.

Secrets were named `"env:NAME"`; in a module they are `env('NAME')`, and the
board reads them when it starts. `mu daemon install --env NAME` carries them
into the service as before.

## watchers.json

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    lead: {
      tail: { channel: 'work/' },
      as: 'lead',
      run: command(({ event }) => ['/srv/wake.sh', String(event.thread)]),
    },
  },
})
```

| `watchers.json` | Board module |
| --- | --- |
| `{ "watchers": [ ... ] }`, or a bare array | `board({ watch: { ... } })`, an object by name |
| `"name": "lead"` | The key: `lead: { ... }` |
| `"tail": { ... }` | `tail: { ... }`, the same filter, checked when `board()` is called. It also takes `root: true` |
| `"run": ["/srv/wake.sh", "{thread}"]` | `run: command(({ event }) => ['/srv/wake.sh', String(event.thread)])` |
| `{channel}`, `{seq}`, `{type}` in `run` | `event.channel ?? ''`, `String(event.seq)`, `event.type` |
| `"gate": ["/srv/gate.sh"]` | `command(..., { gate: ['/srv/gate.sh'] })`, a list or a function of the event |
| `"env": ["ANTHROPIC_API_KEY"]` | `command(..., { env: ['ANTHROPIC_API_KEY'] })` |
| `"as": "lead"` | `as: 'lead'` |
| `"every": 30` | `coalesce: '30s'`, to gather a thread's events into one run. Left out, each event is its own run, within a second |
| none | `timeout: '60s'`, the most one run may take. Then it is stopped and counted as a failed try |
| none | A function: `run: async ({ event, board }) => { ... }`, your own code in the host's process |

What a woken command gets is the same: `MUSTER_THREAD`, `MUSTER_CHANNEL`,
`MUSTER_EVENT`, `MUSTER_EVENT_TYPE` and `MUSTER_PROFILE`, now with
`MUSTER_WATCHER` and `MUSTER_ATTEMPT`, in a clean environment. What differs:

- **Each thread on its own.** A failed event holds back only its thread's
  later events; other threads go on. It is tried 5 times, 10 seconds apart
  and doubling, then noted on its thread as before.
- **Each watcher in a loop of its own,** under its own lease `watch:<name>`,
  where the JSON watchers ran one after another in the daemon's tick. A slow
  one holds up no other, and any host can run it: `mu daemon run`,
  `mu serve`, or `team.start()` in your own process.
- **Its place carries over.** A watcher keeps its cursor, `watch:<name>`,
  under the same name, so a ported watcher goes on from where the JSON one
  stopped.

## sync.json

```ts board.ts
import { board, env, github } from '@openmuster/muster'

export default board({
  sync: {
    gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/web': 'web' } }),
  },
})
```

| `sync.json` | Board module |
| --- | --- |
| `"gh": { "type": "github", ... }` | `sync: { gh: github({ ... }) }`, and `linear()` or `slack()` for the others |
| `"secret": "env:NAME"` | `secret: env('NAME')` |
| `"token": "env:NAME"` | `token: env('NAME')`. Unset, it is refused; in `sync.json` it was left out |
| `"bot"`, `"repos"`, `"teams"`, `"channels"` | The same, as they are |
| `"filter": ["/path/cmd"]` | `filter: ['/path/cmd']`, or a function `(text) => string \| null` |
| `"filesPerDayMB": 100` | `filesPerDayMB: 100` |

Its webhook URL, `/api/board/webhooks/<name>`, is the same. See
[Sync](../02-sync/01-overview.md#in-a-board-module).

## hooks.json

```ts board.ts
import { board, env } from '@openmuster/muster'

export default board({
  hooks: [{ name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' } }],
})
```

| `hooks.json` | Board module |
| --- | --- |
| `{ "hooks": [ ... ] }`, or a bare array | `board({ hooks: [ ... ] })` |
| `"name": "phone"` | `name: 'phone'` |
| `"url": "https://..."` | `url: 'https://...'` |
| `"secret": "env:MUSTER_HOOK_PHONE"` | `secret: env('MUSTER_HOOK_PHONE')` |
| `"tail": { ... }` | `tail: { ... }`, checked like a watcher's |
| `"body": "event"` | `body: 'event'` |

Deliveries, signatures and tries are the same, and a hook keeps its cursor,
`hook:<name>`, so a ported hook goes on from where it was. See
[Outgoing webhooks](../01-concepts/15-outgoing-webhooks.md).
