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
| A label is on it, added or removed | A label per Linear label: `tag.bug=bug` |
| It is assigned, reassigned or unassigned | `assignee.<handle>=<handle>`, from the assignee's profile handle or the name they show |
| Its priority is set or cleared | `priority`: `urgent`, `high`, `medium` or `low`. No priority is no label |
| It joins, moves or leaves a project | `project`, the project's name in lowercase |

```bash
mu read eng --label tag.agent=agent
mu wait eng --label priority=urgent --timeout 1h
```

Under `tag.` and `assignee.` the thread says what Linear says now, and the
rules are the ones for [GitHub](./02-github.md#what-it-is-filed-under): the
key is the name cut to fit, the value is the name in lowercase, what you set
by hand under those two goes at the issue's next update, at most 40 are kept,
and nothing goes back. `priority` and `project` are Linear's as well: one you
set by hand on a synced thread is replaced, or taken off when the issue has
none. All of this holds for a thread started on the board too, once it has
opened its issue.

Not imported: an assignee's email. A webhook about a change to an issue the
board has never seen, one made before sync was set up, is dropped: its thread
starts when the issue is created, or when [catching up](#catching-up) reads it.

## What goes back

- A reply in a synced thread is posted as a comment on the issue.
- A thread posted in a team's channel creates an issue in that team. Its first
  line is the title. The thread then carries `kind=issue`, the issue's `ref`
  and `state`, and `source`.

What the board sent is not imported back, and neither are comments by the
user named in `bot`.

## Catching up

After downtime, and when a token is set, the ticker asks Linear for the issues in
the mapped teams updated since the last event it received, then the comments
on them. An issue created while the board was down arrives whole, with its
title, description and labels, and its comments as replies. A state change
missed meanwhile sets `state`, and what the issue is filed under now (its
labels, assignee, priority and project) is brought up to date, by `lin`: Linear's list doesn't say who
moved the issue, so the change is put down to the sync. An older issue updated while the board was down
starts a thread too. What the board already has, by webhook or because it
sent it, isn't imported again.

Edits and removals made while the board was down are not read; nor are they
for GitHub. One read takes up to 500 issues and 500 comments, oldest change
first, in pages of 50. If there are more, the next read goes on a minute
later from the newest change it read. If Linear refuses, a rate limit among
the reasons, it is asked again from the same point five minutes later. See
[After downtime](./01-overview.md#after-downtime) for the rest.

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
