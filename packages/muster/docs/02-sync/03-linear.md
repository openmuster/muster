---
title: Linear
description: Issues and comments as threads, in both directions.
---

## Map teams

```ts board.ts
import { board, env, linear } from '@openmuster/muster'

export default board({
  sync: {
    lin: linear({
      secret: env('LINEAR_WEBHOOK_SECRET'),
      token: env('LINEAR_API_KEY'),
      teams: { ENG: 'eng', SEC: { channel: 'security', mirror: false } },
    }),
  },
})
```

A team, by its key, maps to a channel. Sync is two-way unless a team sets
`mirror: false`.

`token` is a personal API key (`lin_api_…`) or an OAuth access token; muster
sends each the way Linear expects.

## Who the comments are by

What the sync sends is written by whoever its credential belongs to. A
personal API key in `token` makes every comment and issue yours. To have them
written by an app of its own, name an OAuth application in place of the token:

```ts board.ts
import { board, env, linear } from '@openmuster/muster'

export default board({
  sync: {
    lin: linear({
      secret: env('LINEAR_WEBHOOK_SECRET'),
      clientId: env('LINEAR_CLIENT_ID'),
      clientSecret: env('LINEAR_CLIENT_SECRET'),
      teams: { ENG: 'eng' },
    }),
  },
})
```

- In Linear, create an OAuth application (Settings, API, OAuth applications)
  and turn on **client credentials tokens** for it. Its name and icon are how
  it shows on comments.
- The board asks Linear for the app's token when it first needs one, keeps it
  for the thirty days it lasts, and asks again before it runs out or when
  Linear ends it early. Nothing is stored: a board that starts again asks
  again.
- `scopes` is what the token may do, `['read', 'write']` unless you say.
  Changing it ends the app's earlier tokens in the workspace.
- A client credentials token replaces an installation of the same app made
  through the authorization page. Use an application of its own for the board.
- Catch-up and files use the app as well, so no `token` is needed. With both
  set, the app is used.

> [!NOTE]
> Run against a live workspace on 26 Nov 2026: a board reply arrived on the
> issue as a comment by the application, under the application's name. A token
> running out after thirty days, and one ended early, are covered by tests
> against a stand-in for Linear's API only.

## Show an issue being worked on

An application can have an agent session on an issue, which Linear shows as
working. With `agent: true`, the board uses that for an issue a workflow run
is working on, in place of the run's progress message:

```ts board.ts
import { board, env, linear } from '@openmuster/muster'

export default board({
  sync: {
    lin: linear({
      secret: env('LINEAR_WEBHOOK_SECRET'),
      clientId: env('LINEAR_CLIENT_ID'),
      clientSecret: env('LINEAR_CLIENT_SECRET'),
      agent: true,
      appSecret: env('LINEAR_APP_WEBHOOK_SECRET'),
      teams: { ENG: 'eng' },
    }),
  },
})
```

- When a run on the issue starts, the board opens a session there
  (`agentSessionCreateOnIssue`) and says where the run is as a note that the
  next one replaces. It says it again when the run says something new, and
  every 25 minutes: Linear takes a session with nothing new for 30 as stale.
- When no run on the issue is open any more, the session's response is the
  run's last words, and the session is complete. Linear writes that response
  on the issue as a comment by the application. A later round on the same
  card goes on in the same session.
- The run's `started …` reply is not posted as a comment, and neither are its
  edits. Its summary, and every other reply, is a comment as before.
- A comment by the application's own user is not brought in while sessions
  are on: the response is one, and the board has no ID to know it by.
- A call Linear refuses is tried again a minute later.

Linear allows sessions only for an application with a webhook of its own. In
the application's settings, turn on webhooks, point them at the same address
as the workspace's (`https://<host>/api/board/webhooks/lin`), tick **Agent
session events** and nothing else, and name the signing secret Linear shows
there as `appSecret`. The board checks what arrives with it and answers;
nothing in it is imported. The token needs no more than `read` and `write`.

> [!NOTE]
> The calls were run against a live workspace on 26 Nov 2026: a session
> opened on an issue nobody had mentioned the application in, notes, a
> response that completed it, and a note that made a completed session active
> again. The board doing it by itself is covered by tests against a stand-in
> for Linear's API. A person writing in the session's thread is not handled:
> it reaches the application's webhook, which the board answers and drops.

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

Not imported: an assignee's email.

### An issue from before sync

An issue made before sync was set up has no thread until something happens
to it in a mapped team:

- **A change to it** (a label, its state, an assignee, a priority) starts
  its thread from the update, which carries the whole issue: the title and
  description, by whoever opened it, with `kind`, `ref`, `state` and what it
  is filed under, as a new issue's thread would be and as
  [catching up](#catching-up) would start it. Then the change is applied.
  Two updates for it give one thread. An upload linked from its description
  stays a link in the text; it isn't fetched.
- **A comment on it** starts its thread from what the comment's webhook
  carries: the issue's title and `ref`, not its description or who opened
  it. That thread is put down to `lin`, its text is the title alone, and the
  description doesn't arrive later. The comment is its first reply.

An issue in a team that isn't mapped starts nothing.

### In the order Linear made them

Linear resends a webhook the board didn't answer, such as one sent while it
was restarting, and a webhook can be held up on the way. So a change can
arrive after a newer one: a label taken off, then put back, can come in as
put back, then taken off. The board goes by when Linear says the issue
changed (its `updatedAt`), not by when the webhook came:

- For each issue, it keeps when the newest change it applied was made, in
  the board's file, so a restart doesn't forget it.
- A change made no later than that is skipped, and the log says so:
  `skipped sync lin issue:<id>: a change made at … came after one made at …`.
  A webhook sent again, with the same `updatedAt`, is one of these.
- [Catching up](#catching-up) reads each issue with its `updatedAt` and
  follows the same rule: what it read doesn't undo a newer webhook, and a
  webhook older than what it read doesn't undo it.
- A comment's edits go the same way, by the comment's own `updatedAt`. A
  comment removed is removed, whenever that arrives.
- A newer change that doesn't say everything, such as one with no list of
  labels, still changes only what it carries.

A change from a webhook with no `updatedAt` is applied as it arrives.

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
  in the text. A link to anywhere else is only text, and so is an upload of
  another workspace: the key asks Linear which workspace it is for.
- **Who can bring what in:** Linear lists no uploads for a comment, so the
  board goes by the link, which whoever wrote the comment chose. Someone
  who can comment in a mapped team can link an upload from elsewhere in the
  workspace, one they can't open themselves, and the key will fetch it onto
  the board. If the board is read by people who shouldn't see every upload
  in the workspace, use a key whose user sees only the mapped teams.
- **Out:** each file on a board message is uploaded to Linear's storage, and
  a link to it is added to the comment or the new issue's description. An
  image shows inline. The bytes go only to `storage.googleapis.com`, where
  Linear's upload URLs point today, with only the storage's own headers from
  Linear's answer; an upload URL anywhere else is refused and the file named.

A personal API key with read and write access fetches and uploads files.
What an OAuth app's scopes need for files has not been checked.

Linear's docs don't say whether `uploads.linear.app` answers with the file
or redirects to a storage host. The board follows no redirect, so if Linear
sends one, the file is named in the text instead of attached. This has not
been tried against Linear. See [Files](./01-overview.md#files) for the limits.

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
A file linked from an issue or comment read this way is fetched as one from a
webhook would be, with the same limits.

## Set it up

1. Create a key: Settings, Security & access, Personal API keys, with read
   and write access. Or an OAuth app with permission to create issues and
   comments.
2. Settings, API, Webhooks: add one pointing at
   `https://<host>/api/board/webhooks/lin`, for **Issues** and **Comments**.
   Limit it to the teams you map: one for all public teams also sends what
   happens in the others, which the board then drops.
3. Put the key and the webhook's signing secret in the server's environment,
   and name them in the board module with `env()`, as above.
4. Restart `mu serve`: it reads the module and the secrets only when it starts.

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
