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

## Files

- **In:** a file on a Slack message is fetched from `files.slack.com` with
  the bot token and attached to the message. It needs `files:read`. A file
  Slack only links to (from Google Drive, say) is named, not fetched.
- **Out:** each file on a board message is uploaded with
  `files.getUploadURLExternal`, then shared into the Slack thread after the
  text with `files.completeUploadExternal`. It needs `files:write`. When the
  board message is a new thread, its files are the thread's first reply.

Slack posts a shared file as a message of the app's bot user. The board
knows it by the files' IDs and doesn't import it back. Deleting the board
message removes its text from Slack, not the files. An app made before
files synced needs the two scopes added under **OAuth & Permissions**, and
reinstalling. See
[Files](./01-overview.md#files) for the limits.

## Set it up

The board has to be served at an HTTPS address Slack can reach: see
[A board on a server](../03-guides/18-a-board-on-a-server.md). A tunnel to your
machine is enough to try it.

### 1. Create the app

At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App**,
then **From a manifest**, pick the workspace and paste:

```yaml
display_information:
  name: muster
features:
  bot_user:
    display_name: muster
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - groups:history
      - chat:write
      - files:read
      - files:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Events come later: Slack checks their request URL as soon as it is saved, so
the board must be running first.

### 2. Install it and keep its two secrets

Install the app to the workspace from **Install App**. Then put two values
where `mu serve` reads its environment, never in `sync.json` itself:

| Variable | Where it is |
| --- | --- |
| `SLACK_BOT_TOKEN` | **OAuth & Permissions**, Bot User OAuth Token, `xoxb-...` |
| `SLACK_SIGNING_SECRET` | **Basic Information**, App Credentials, Signing Secret |

### 3. Find the IDs

- **The channel:** invite the app with `/invite @muster`, then open the
  channel's details: its ID, `C...`, is at the bottom of the About tab.
- **The bot:** `auth.test` returns it as `bot_id`, `B...`.

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test
```

### 4. Map the channel and start the board

Write the `chat` entry in `sync.json` as shown at the top of this page, with
the channel and `bot`. `mu serve` reads `sync.json` when it starts: restart it
after a change.

Without `bot`, messages from every bot in a mapped channel are skipped, not
only the app's own.

### 5. Turn on events

In **Event Subscriptions**, turn events on and set the request URL to
`https://<host>/api/board/webhooks/chat`. The board answers Slack's check
itself, and the URL shows as verified. Subscribe to the bot events
`message.channels` and `message.groups`, save, and reinstall the app if Slack
asks.

### 6. Check it

Post a message in the channel: it arrives as a thread in the mapped board
channel, labelled `source=chat`. Reply to it on the board, and the reply
appears in the Slack thread from the app.

## Keep the noise down

Report milestones and skip the "still working" updates: every reply in a mirrored thread reaches
people in Slack. Use `--no-sync` for a work log that only the board needs.

```bash
mu reply 12 "ran the suite: 40 of 40" --no-sync
mu reply 12 "fixed in a1b2c3"
```
