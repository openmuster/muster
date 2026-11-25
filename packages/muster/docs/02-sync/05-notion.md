---
title: Notion
description: Pages of a database and their comments as threads, in both directions.
---

## Map databases

```ts board.ts
import { board, env, notion } from 'muster'

export default board({
  sync: {
    nt: notion({
      secret: env('NOTION_WEBHOOK_SECRET'),
      token: env('NOTION_TOKEN'),
      databases: { '1a2b3c4d00004000800000000000d00b': 'feedback' },
    }),
  },
})
```

A database maps to a channel, by its data source ID: on a workspace that
predates data sources, by the database's own ID. Either is taken with or
without dashes. Sync is two-way unless a database sets `mirror: false`.

`token` is the integration's secret (`ntn_…`). Share each mapped database
with the integration, and give it the capabilities to read content, read
comments and insert comments.

`secret` is the webhook subscription's verification token, which Notion
signs every delivery with. `bot` is optional: the integration's own user ID,
whose pages and comments are never imported.

## Set up the webhook

Notion sends its verification token once, to the webhook's URL, signed with
that same token, and it has to be pasted back into Notion before anything
else is sent:

1. Start the board with the sync in its module and `NOTION_WEBHOOK_SECRET`
   set to `pending`. Only then does the board take Notion's one unsigned
   request.
2. In the integration's settings, under Webhooks, subscribe
   `https://<your host>/api/board/webhooks/nt` to page and comment events.
3. The board writes the token Notion sent to `notion-verification-token`
   in muster's config folder (`~/.config/muster`, or `MUSTER_CONFIG`),
   readable by you alone. It is never logged or answered, and never
   written over: the first one stays.
4. Paste it into Notion's Verify. Anyone can send the board a token, so
   this is the check: one Notion didn't send fails there. If it fails,
   delete the file and have Notion send its token again. Then set
   `NOTION_WEBHOOK_SECRET` to it and start the board again.

From then on a delivery without Notion's signature for that token is
refused.

## What comes in

| In Notion | On the board |
| --- | --- |
| A page is made in a mapped database | A thread: its title, a blank line, its text as markdown. Labels `kind=page`, `ref` (its URL), `state`, `source=nt` |
| Its title or text changes | The thread's first message is edited |
| Its Status changes | The label `state`, in lowercase with dashes: `in-progress`. A select called Status counts too |
| A comment on the page | A reply, by `nt:user:<id>` |
| A comment is edited or deleted | The reply is edited or deleted |
| The page is deleted | The thread's first message is deleted |

Notion's webhooks say only what changed, not what it says now. The board
answers each at once and reads the page or comment from Notion's API on its
next tick, so what it imports is always what Notion says then, and a late
delivery brings nothing older. A read that fails is tried again on later
ticks, rather than import less than the page says. A page's text is cut at 9,000 characters,
with a link to the rest.

A page in a database the sync doesn't map is not brought in.

## What goes back

- **A reply** in a synced thread is a comment on the page, in pieces of
  2,000 characters, as Notion takes them. Editing or deleting it does the
  same on Notion.
- **A thread started on the board** in a mapped channel is a new page in the
  database: its first line the title, the rest the page's text.
- **Files** aren't sent yet: each is named in the comment, and stays on the
  board.

## Catching up

A board that was down asks Notion, when it starts, for the pages changed in
each mapped database since it last heard, oldest first, up to 1,000 a
database, and the comments made on them since. A comment on a page that
didn't otherwise change while the board was down isn't found this way.
