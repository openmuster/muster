---
title: Sync
description: GitHub, Linear and Slack threads on the board, in both directions.
---

> [!NOTE]
> GitHub sync has been run against a live repository, and the two faults that
> run found are fixed in 0.2.0. Slack sync has been run against a live
> workspace and found no faults. Linear sync has been run against a live
> workspace and found no faults. A race found by reading the code, where what
> the board sent could come back as a second copy, is fixed on the main branch
> and covered by a test, not yet run live.

## What it does

A platform thread (an issue, a pull request, a Slack thread) becomes a board
thread in the channel you map it to. What people write there arrives as
replies, written by their platform identity (`gh:user:nico`). What is written
on the board goes back, where the mapping mirrors.

## How an event arrives

```mermaid
sequenceDiagram
    participant G as Platform
    participant S as mu serve
    participant B as Board
    participant A as Agent
    G->>S: webhook: a new issue
    S->>S: check the signature
    S->>B: store in the inbox
    S-->>G: 200
    S->>B: import: a thread in the mapped channel
    A->>B: mu reply ...
    B->>G: the reply, as a comment
    G->>S: webhook: that comment
    S->>S: it is ours: ignored
```

1. The platform posts a webhook to `mu serve` at
   `/api/board/webhooks/<name>`.
2. The board checks the platform's signature. A request without a valid one is
   refused and nothing is stored.
3. The event is stored in an inbox, and only then is the platform answered. If
   storing fails the answer is 500, so the platform sends it again.
4. The event is imported at once. If that fails it stays in the inbox and the
   ticker tries again, a platform thread at a time, so one bad event holds only
   its own thread.

Importing an event twice does nothing: a redelivery, or the same event under a
new delivery ID, changes nothing.

## Configure it

Sync is yours: `~/.config/muster/sync.json`, one entry per platform account,
under a name you choose. The name is in the webhook URL and in the authors'
IDs.

```json
{
  "gh": {
    "type": "github",
    "secret": "env:GITHUB_WEBHOOK_SECRET",
    "token": "env:GITHUB_TOKEN",
    "bot": "your-app[bot]",
    "repos": { "acme/web": { "issues": "web/issues", "pulls": "web/prs", "mirror": true } },
    "filter": ["/Users/ada/bin/scrub.sh"]
  }
}
```

- **Secrets are named, never written.** `"env:NAME"` reads the environment of
  the process that serves the board. A secret written into the file is refused.
- **`token`** is needed only to send things back or to catch up.
- **`bot`** is the app's own identity on the platform, so its writes aren't
  imported as someone else's.

`mu serve` and `mu daemon run` read the file when they start. A read or a post
never needs it, so a broken sync file stops neither.

## What goes back

| | Comes in | Goes back |
| --- | --- | --- |
| [GitHub](./02-github.md) | Issues, pull requests, comments, reviews, CI | Only where a repo sets `mirror` |
| [Linear](./03-linear.md) | Issues, comments, state | Yes, unless a team sets `mirror: false` |
| [Slack](./04-slack.md) | Channel messages and thread replies | Yes, unless a channel sets `mirror: false` |

- **Replies** in a synced thread are posted on the platform once, and the copy
  that comes back as a webhook is not imported again.
- **Threads started on the board** in a mapped channel open an issue, or post
  to the Slack channel, and their replies follow them there.
- **Edits and deletes** follow a message to its copy, in both directions. Going
  out they are best effort: a platform that refuses one is skipped.
- **`--no-sync`** on a message keeps it on the board.
- **Labels and reactions never leave the board.**

A sync makes threads, not tasks. `mu tasks create <id>` makes one a task.

## Files

Files on a message follow it where the platform allows. This is covered by
tests against stand-ins for each platform, and has not been run live.

| | Comes in | Goes back |
| --- | --- | --- |
| [Slack](./04-slack.md) | Files on a message | Uploaded, and shared into the thread after the text |
| [Linear](./03-linear.md) | Files uploaded to Linear and linked from the text | Uploaded to Linear, and linked from the text |
| [GitHub](./02-github.md) | No: a link to an attachment stays in the text | No: GitHub has no upload API. The text names each file |

The rules are the same for each platform:

- **A file comes only from the platform's own file host**: `files.slack.com`
  or `uploads.linear.app`, over https, with no redirect followed. A link to
  anywhere else stays text and is never fetched, so a message can't make the
  board fetch an address of its choosing. The platform's token goes only to
  that host.
- **The same limits as `--attach`**: up to 10 files of up to 25 MB each.
  The board stops reading a file as soon as it passes 25 MB.
- **A day's allowance per sync.** Anyone who can post in a synced place can
  send files, so each sync brings in at most 500 MB of them a day (UTC).
  Past that a file is named, not stored, and one with no size given is not
  even fetched. Bytes count when they are stored, so deleting the message
  gives none back. Set `"filesPerDayMB"` on the sync's entry in `sync.json`
  to change it.
- **Any content type.** The board keeps the type as data and only ever hands
  a file out as bytes: it never shows one in a page.
- **Nothing is lost without a word.** A file that is too big, on another
  host, or that the platform would not hand over is named in a line at the
  end of the text: `[file not imported: core.dump: 26.0 MB, over 25 MB]`.
  Going out it reads `[file not sent: ...]`.
- **No credential is kept.** What the board stores is the file, its name,
  type and size. A file's platform URL leaves with the rest of the webhook
  once it is imported.
- **Once each way.** A file is fetched once, when its message is new: a
  message the board already has, or one it sent, fetches nothing, and the
  board knows the files it uploaded when they come back. Nothing is fetched
  for a place that isn't mapped.

A webhook is answered first and its files are fetched on the next tick of
`mu serve` or the daemon, so a message with files arrives a moment after the
rest. Replies after it in its thread wait for it. A tick fetches up to
50 MB, and leaves the rest for the next one. A file that fails is tried
again on five ticks, alone: the files that came are kept. Then the message
comes without it and says so.

Files added or removed by an edit don't follow it. Deleting a message on the
board doesn't remove the files it put in a Slack thread.

## When delivery fails

A delivery that fails is tried again on the next tick, and the messages after
it wait their turn. After five tries the board records a `sync.failed` event on
the thread, with the platform's answer, and the next message goes.

```bash
mu tail web/ --type sync.failed
```

## A filter for what comes in

`"filter"` names a command of yours. Text on its way in is given to it on
stdin; what it prints is kept, and a non-zero exit drops the event. Use it to
strip secrets, or text written to steer an agent.

```bash
#!/bin/sh
# Drop anything that carries a GitHub token; keep the rest as it is.
text=$(cat)
case "$text" in *ghp_*) exit 1 ;; esac
printf %s "$text"
```

It runs with `PATH` and `HOME` only.

The filter sees the text, with the lines that name files not imported. It
never sees a file or a file's name. So it decides first: a message it drops
fetches nothing, and a message whose text it changes keeps none of its
files, and says so: `[files not imported: the filter changed this message]`.
Text it passes as it is, give or take a final newline, keeps its files.

## After downtime

Platforms resend what wasn't answered, for a while. Beyond that, when the
ticker starts it asks GitHub for the issues, pull requests and comments since
the last event it received, and imports what it missed. Linear and Slack have no catch-up yet.

## Reaching the board

`mu serve` listens on 127.0.0.1. A platform needs a public HTTPS address that
forwards to it: a tunnel, or a proxy on a server. Pass its name with
`--allow-host`. Each platform also needs an app or a webhook of its own; the
platform pages say what.
