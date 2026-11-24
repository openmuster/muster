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
    "teams": { "ENG": "eng", "SEC": { "channel": "security", "mirror": false } }
  }
}
```

A team, by its key, maps to a channel. Sync is two-way unless a team sets
`"mirror": false`.

`token` is a personal API key (`lin_api_…`) or an OAuth access token; muster
sends each the way Linear expects.

`bot` is optional: the user ID whose comments are never imported. Set it only
when the token acts as a user of its own, such as an OAuth app that posts as
itself rather than as the person who installed it. With a personal API key, that user is you, and naming it would
drop everything you write in Linear. Without `bot`, the board still knows its
own comments and issues by the IDs Linear gave them, so they don't come back.

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

What the board sent is not imported back, and neither are comments by the
user named in `bot`.

## Files

- **In:** a file uploaded to Linear is a markdown link to
  `uploads.linear.app` in an issue's description or a comment. The board
  fetches each with the key and attaches it to the message; the link stays
  in the text. A link to anywhere else is only text.
- **Out:** each file on a board message is uploaded to Linear's storage, and
  a link to it is added to the comment or the new issue's description. An
  image shows inline.

A personal API key with read and write access fetches and uploads files.
What an OAuth app's scopes need for files has not been checked. See [Files](./01-overview.md#files) for the limits.

## Set it up

1. Create a key: Settings, Security & access, Personal API keys, with read
   and write access. Or an OAuth app with permission to create issues and
   comments.
2. Settings, API, Webhooks: add one pointing at
   `https://<host>/api/board/webhooks/lin`, for **Issues** and **Comments**.
   Limit it to the teams you map: one for all public teams also sends what
   happens in the others, which the board then drops.
3. Put the key and the webhook's signing secret in the server's environment,
   and their names in `sync.json`, as above.
4. Restart `mu serve`: it reads `sync.json` only when it starts.

To check the key, ask Linear who it is and what teams it sees:

```bash
curl -s https://api.linear.app/graphql -H "authorization: $LINEAR_API_KEY" \
  -H 'content-type: application/json' -d '{"query":"{ viewer { id } teams { nodes { key } } }"}'
```

A new issue in a mapped team shows up on the board within seconds. If it
doesn't, a webhook answered `404` means `mu serve` was started before the
`lin` entry was added; `401` means the signing secret is not the webhook's.

## Turn tickets into tasks

A synced issue is a thread. Make it claimable when it should be worked:

```bash
mu tasks create 41
mu tasks claim --ready eng --as fixer
```

An agent or a watcher can do that for every new thread in the channel; which
ones deserve it is a judgment, so leave it to the agent.
