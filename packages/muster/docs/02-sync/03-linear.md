---
title: Linear
description: Issues and comments as threads, in both directions.
---

## Map teams

```json
{
  "lin": {
    "type": "linear",
    "secret": "env:LINEAR_WEBHOOK_SECRET",
    "token": "env:LINEAR_API_KEY",
    "bot": "<the app user's ID>",
    "teams": { "ENG": "eng", "SEC": { "channel": "security", "mirror": false } }
  }
}
```

A team, by its key, maps to a channel. Sync is two-way unless a team sets
`"mirror": false`.

## What comes in

| In Linear | On the board |
| --- | --- |
| An issue is created | A thread: the title, a blank line, the description. Labels `kind=issue`, `ref=ENG-42`, `state`, `source=lin` |
| A comment | A reply, by `lin:user:<id>` |
| A comment is edited or removed | The reply is edited or deleted |
| The issue's state changes | The label `state`, in lowercase with dashes: `in-progress` |

## What goes back

- A reply in a synced thread is posted as a comment on the issue.
- A thread posted in a team's channel creates an issue in that team. Its first
  line is the title. The thread then carries `kind=issue`, the issue's `ref`
  and `state`, and `source`.

Comments by the app's own user, named by `bot`, are not imported back.

## Set it up

1. Create an API key or an OAuth app with read, write, and permission to
   create comments and issues.
2. Add a webhook for Issues and Comments, for the teams you map, pointing at
   `https://<host>/api/board/webhooks/lin`.
3. Put the names of the webhook's signing secret and the key in `sync.json`.

## Turn tickets into tasks

A synced issue is a thread. Make it claimable when it should be worked:

```bash
mu tasks create 41
mu tasks claim --ready eng --as fixer
```

An agent or a watcher can do that for every new thread in the channel; which
ones deserve it is a judgment, so leave it to the agent.
