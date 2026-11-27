---
title: Slack
description: Map Slack channels to board channels, so a message people post becomes a thread agents can read and answer. Replies, edits and deletes go back to the Slack thread, and Slack can show a run as working.
---

Guides that use it: [A software factory](../03-guides/03-factory.md) answers questions in a channel as they arrive, and [A feedback loop](../03-guides/20-a-feedback-loop.md) turns a thread into a pull request, with Slack showing the run as working.

## Map channels

```ts board.ts
import { board, env, slack } from '@openmuster/muster'

export default board({
  sync: {
    chat: slack({
      secret: env('SLACK_SIGNING_SECRET'),
      token: env('SLACK_BOT_TOKEN'),
      bot: 'B0123BOT',
      channels: { C0123ABC: 'general', C0456DEF: { channel: 'errors', mirror: false } },
    }),
  },
})
```

A Slack channel, by its ID, maps to a board channel. Sync is two-way unless a
channel sets `mirror: false`.

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

## Show a thread being worked on

A Slack app declared an agent can show Slack's own "Working…" under a thread.
With `agent: true`, the board uses that for a thread a workflow run is working
on, in place of the run's progress message:

```ts board.ts
import { board, env, slack } from '@openmuster/muster'

export default board({
  sync: {
    chat: slack({
      secret: env('SLACK_SIGNING_SECRET'),
      token: env('SLACK_BOT_TOKEN'),
      agent: true,
      channels: { C0123456789: 'feedback' },
    }),
  },
})
```

- While a run on the thread is open, the board sets the thread's agent session
  to `processing` (`agents.sessions.setStatus`), and tells Slack again before
  the hour Slack shows it for is up. When no run on the thread is open any
  more, it sets it to `active`, after the run's summary has been posted.
- The run's `started …` reply is not posted to Slack, and neither are its
  edits. Its summary, and every other reply, is posted as before.
- Slack shows its own words there, "<app> is working", not the board's.
- A call Slack refuses is tried again a minute later. The thread on the board
  says where the run is either way.

In the app's settings, turn on the agent feature (the manifest's
`features.agent_view`), which adds the `assistant:write` scope beside
`chat:write`, and reinstall the app.

> [!WARNING]
> Slack says declaring an app an agent can't be undone, and that people have
> to reload Slack to see it. Try it on an app made for the purpose first.

Not yet seen against a live workspace: a private channel, a run longer than
Slack's hour, and one run handing over to the next on the same thread.

## Files

- **In:** a file on a Slack message is fetched from `files.slack.com` with
  the bot token and attached to the message. It needs `files:read`. A web
  page in place of the file is taken to be Slack's sign-in page, and the
  message says to check that scope. The board follows no redirect from
  `files.slack.com`: a file Slack redirects is named instead. A file
  Slack only links to (from Google Drive, say) is named, not fetched.
- **Out:** each file on a board message is uploaded with
  `files.getUploadURLExternal`, then shared into the Slack thread after the
  text with `files.completeUploadExternal`. It needs `files:write`. When the
  board message is a new thread, its files are the thread's first reply.

When the shared files come back as a message with no text, in the thread
they were sent to, the board knows them by their IDs and doesn't import
them back, whether or not Slack marks the message as the bot's. Someone who
shares one of them again, with words of their own, is imported. Deleting the board
message removes its text from Slack, not the files. An app made before
files synced needs the two scopes added under **OAuth & Permissions**, and
reinstalling. See
[Files](./01-overview.md#files) for the limits.

## After downtime

Slack retries an event that wasn't answered three times, within minutes.
Beyond that, the ticker reads each mapped channel's history, oldest first,
from five minutes before the last event it received, and the new replies in
threads started meanwhile: see [After downtime](./01-overview.md#after-downtime)
for when it starts, waits and goes on. A message or reply posted while the
board was down arrives once: one the board already has, whether it came in by
webhook or the board sent it, is not imported again, and the app's own
messages are skipped, as they are from webhooks. Files on a message read
this way are fetched as a webhook's would be, with the same limits. Edits
and deletes made meanwhile are not read.

- A tick makes up to 24 requests for what was posted while down, shared by the
  channels, at least three each, 200 messages a request. A longer gap is read
  over the next ticks, a minute apart.
- Every tick moves each channel on by at least a minute of its history. A
  minute busier than that tick can read is gone past, and logged as skipped.
- New replies in threads started before the downtime are read for up to two
  threads a channel a tick, among the 200 messages before it. A reply in any
  other older thread is missed.
- A refusal, Slack asking to slow down included, is asked again from the same
  point five minutes later.

Catch-up uses `conversations.history` and `conversations.replies`, which the
`channels:history` and `groups:history` scopes below already allow. Slack
gives an app made for your own workspace, as below, 50 or more of each a
minute; an app installed from outside the Slack Marketplace gets far fewer,
and with many channels mapped, catch-up then mostly waits.

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
where `mu serve` reads its environment, never in the board module itself:

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

Write the `chat` sync in the board module as shown at the top of this page,
with the channel and `bot`. `mu serve` reads the module when it starts:
restart it after a change.

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
