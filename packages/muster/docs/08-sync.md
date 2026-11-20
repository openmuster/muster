---
title: Sync
description: GitHub, Linear and Slack threads on the board, by webhook.
---

## How it works

A platform posts a webhook to `mu serve`. The board checks the platform's
signature, stores the event, and only then answers; a stored event is imported
at once, and again by the ticker if that fails. Importing twice does nothing.

What comes in is written by its platform author (`gh:user:nico`), in the
channel you mapped. A board reply in a synced thread goes back to the platform
where the mapping mirrors, once, and the copy that comes back is not imported.

## Configure it

Sync is yours: `~/.config/muster/sync.json`. Secrets are named, never written.

```json
{
  "gh": {
    "type": "github",
    "secret": "env:GITHUB_WEBHOOK_SECRET",
    "token": "env:GITHUB_TOKEN",
    "bot": "your-app[bot]",
    "repos": { "acme/web": { "issues": "web/issues", "pulls": "web/prs", "mirror": false } }
  },
  "lin": { "type": "linear", "secret": "env:LINEAR_WEBHOOK_SECRET", "token": "env:LINEAR_API_KEY", "teams": { "ENG": "eng" } },
  "chat": { "type": "slack", "secret": "env:SLACK_SIGNING_SECRET", "token": "env:SLACK_BOT_TOKEN", "channels": { "C0123ABC": "general" } }
}
```

Point each platform's webhook at `https://<host>/api/board/webhooks/<name>`
(`gh`, `lin`, `chat` above). `mu serve` listens on 127.0.0.1, so it needs a
tunnel or a proxy with a public HTTPS name, passed with `--allow-host`.

| Platform | Comes in | Goes back |
| --- | --- | --- |
| GitHub | Issues and pull requests as threads, comments and review text as replies; state, review and CI results as labels (`state`, `review`, `ci.<workflow>`) | Board replies as comments, only where a repo sets `mirror` |
| Linear | Issues as threads, comments as replies, state as a label | Board replies as comments, unless a team sets `mirror: false` |
| Slack | A channel message as a thread, a threaded message as a reply | Board replies into the Slack thread, unless `mirror: false` |

- `--no-sync` on a reply keeps it on the board.
- Labels and reactions never leave the board.
- A delivery that fails is tried five times, then recorded on the thread as a
  `sync.failed` event, and the next message goes.
- A sync makes threads, not tasks: `mu tasks create <id>` makes one a task.

## Threads started on the board

A thread posted in a mapped channel goes out too, where the mapping mirrors:
it opens a GitHub or Linear issue (its first line is the title) or posts to the
Slack channel, and its replies follow it there.

## Not yet

Files, edits and deletes don't sync. Events missed while `mu serve` was down are not
fetched on start: the platform's own redelivery is what brings them.
