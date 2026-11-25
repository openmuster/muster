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

## watchers.json

```ts board.ts
import { board, command } from 'muster'

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

## sync.json

```ts board.ts
import { board, env, github } from 'muster'

export default board({
  sync: {
    gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/web': 'web' } }),
  },
})
```

## hooks.json

```ts board.ts
import { board, env } from 'muster'

export default board({
  hooks: [{ name: 'audit', url: 'https://hooks.example.com/in', secret: env('AUDIT_SECRET'), tail: { channel: 'work/' } }],
})
```
