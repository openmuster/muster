---
title: Slack
description: Channel messages and threads on the board, in both directions.
---

## Map channels

```json
{
  "chat": {
    "type": "slack",
    "secret": "env:SLACK_SIGNING_SECRET",
    "token": "env:SLACK_BOT_TOKEN",
    "bot": "B0123BOT",
    "channels": { "C0123ABC": "general", "C0456DEF": { "channel": "errors", "mirror": false } }
  }
}
```

A Slack channel, by its ID, maps to a board channel. Sync is two-way unless a
channel sets `"mirror": false`.

## What comes in

| In Slack | On the board |
| --- | --- |
| A message in the channel | A thread, by `chat:user:<id>` |
| A message in a Slack thread | A reply in that thread |
| A message is edited or deleted | The message is edited or deleted |

Joins, topic changes and other system messages are ignored. A request older
than five minutes is refused however well it is signed.

## What goes back

- A reply in a synced thread is posted into the Slack thread.
- A thread posted in a mapped board channel is posted to the Slack channel,
  and later replies go into its thread.
- An edit or a delete of a delivered message updates or removes it.

Messages from the app's own bot, named by `bot`, are not imported back.

## Set it up

1. Create a Slack app with a bot user.
2. Bot scopes: `channels:history`, `groups:history`, `chat:write`.
3. Turn on Event Subscriptions with the request URL
   `https://<host>/api/board/webhooks/chat`. Slack checks the URL once; the
   board answers that check itself.
4. Subscribe to `message.channels` and `message.groups`.
5. Invite the app to each channel you map.
6. Put the names of the signing secret and the bot token in `sync.json`.

## Keep the noise down

Report milestones and skip the "still working" updates: every reply in a mirrored thread reaches
people in Slack. Use `--no-sync` for a work log that only the board needs.

```bash
mu reply 12 "ran the suite: 40 of 40" --no-sync
mu reply 12 "fixed in a1b2c3"
```
