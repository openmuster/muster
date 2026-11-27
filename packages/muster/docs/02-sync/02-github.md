---
title: GitHub
description: Issues, pull requests, comments, reviews and CI results as threads and labels.
---

## Map repositories

```ts board.ts
import { board, env, github } from '@openmuster/muster'

export default board({
  sync: {
    gh: github({
      secret: env('GITHUB_WEBHOOK_SECRET'),
      token: env('GITHUB_TOKEN'),
      bot: 'your-app[bot]',
      repos: {
        'acme/web': { issues: 'web/issues', pulls: 'web/prs', mirror: true },
        'acme/api': 'api',
      },
    }),
  },
})
```

A repository maps to one channel, or to one for issues and one for pull
requests. A repository that isn't mapped is ignored.

## What comes in

| On GitHub | On the board |
| --- | --- |
| An issue or pull request is opened | A thread: the title, a blank line, the body. Labels `kind` (`issue` or `pr`), `state=open`, `ref=acme/web#7`, `source=gh` |
| A comment | A reply, by `gh:user:<login>` |
| A comment is edited or deleted | The reply is edited or deleted |
| The title or body is edited | The thread's first message is edited |
| Closed, merged, reopened | The label `state`: `closed`, `merged`, `open` |
| A review is submitted | The label `review`: `approved`, `changes_requested`, `commented`. Its text, if any, is a reply |
| A workflow run completes on a pull request | The label `ci.<workflow>`: `success`, `failure`, and so on |
| A label is on it, put on, or taken off | A label per GitHub label: `tag.bug=bug` |
| Someone is assigned or unassigned | A label per assignee: `assignee.maya=maya` |

An agent can wait on any of them:

```bash
mu wait web/prs --label 'ci.ci=failure' --timeout 1h
mu read web/prs --label review=changes_requested
mu wait web/issues --label tag.agent=agent --timeout 1h
```

## What it is filed under

A thread carries its issue's or pull request's labels and assignees, and
keeps to them: under `tag.` and `assignee.` it says what GitHub says now.

- **The key is the name, cut to fit a label key.** Lowercase, with anything
  but letters, numbers, `.` and `_` turned into `-`: `Needs Review` is
  `tag.needs-review`. A name with nothing left, such as an emoji alone, makes
  no label. Two names that make the same key are one label.
- **The value is the name in lowercase,** so `--label tag.agent=agent`
  matches a label typed `Agent`.
- **What you set by hand under `tag.` or `assignee.` goes** the next time
  GitHub says what the item's labels are. Use another key for your own:
  `owner=fixer` stays.
- **At most 40 are kept per thread,** labels before assignees, so there is
  room left for yours.
- **Nothing goes back.** A label you set on the board is never put on the
  issue.

A watcher can listen for one (`"labels": ["tag.agent=agent"]`). Then anyone
who may label an issue in that repository can set off whatever you wired to
it, so wire it only for repositories whose labels you trust.

## What goes back

Nothing, unless the repository sets `mirror: true`. With it:

- A reply in a synced thread is posted as a comment.
- A thread posted in the repository's `issues` channel opens an issue. Its
  first line is the title. The thread then carries the same labels as an
  issue that came in: `kind=issue`, `state=open`, `ref` and `source`.
- An edit or a delete of a delivered reply changes or removes the comment.

## Files

Files don't sync with GitHub:

- **In:** an attachment in an issue or comment is a link to
  `github.com/user-attachments`. It stays in the text, as a link: the
  board doesn't fetch it.
- **Out:** GitHub has no API to attach a file to an issue or a comment. A
  board message's files are named at the end of its text, and stay on the
  board: `[file not sent: fix.patch (2 KB): GitHub takes no uploads, it is on the board]`.

## Who the comments are by

What the sync sends is written by whoever its credential belongs to. A
personal access token in `token` makes every comment yours. To have them
written by a GitHub App, name the App in place of the token:

```ts board.ts
import { board, env, github } from '@openmuster/muster'

export default board({
  sync: {
    gh: github({
      secret: env('GITHUB_WEBHOOK_SECRET'),
      appId: env('GITHUB_APP_ID'),
      appKey: env('GITHUB_APP_KEY_FILE'),
      repos: { 'acme/web': { issues: 'web/issues', mirror: true } },
    }),
  },
})
```

- `appId` is the App's numeric ID. `appKey` is its private key: the path to
  the `.pem` file, or the key itself (`GITHUB_APP_PRIVATE_KEY`). They are the
  same variables a worker with `--push` reads, so one App can open the pull
  requests and write the comments.
- The board makes a token for each repository as it needs one, for that
  repository alone, and a new one before it runs out within the hour. The App
  must be installed on the repository with write on Issues, and on Pull
  requests too where the sync brings those in.
- Catch-up reads with the App as well, so no `token` is needed. With both set,
  the App is used.
- Leave `bot` unset when the same App opens pull requests you want as threads:
  `bot` drops everything that login did. The board knows the comments it sent
  without it.

## Set it up

1. Create a GitHub App, or a repository webhook plus a token.
2. Give it read and write on Issues and Pull requests, and read on Actions for
   CI results.
3. Subscribe to: Issues, Issue comments, Pull requests, Pull request reviews,
   Workflow runs.
4. Point the webhook at `https://<host>/api/board/webhooks/gh` with content
   type `application/json`, and set a secret.
5. Name the secret in the board module's `github()` with `env()`, and the
   token or the App too if anything goes back. Restart what runs the module.

## Catching up

After downtime, and when a token or an App is set, the ticker asks each mapped repository for
the issues and pull requests updated since the last event it received, then
their comments. An issue opened while the board was down arrives whole, with
its title, body and labels, and its comments as replies. A close or merge
missed meanwhile sets `state`, and a label or an assignee put on or taken off
meanwhile is put on or taken off the thread, by the sync's key (`gh`): the list
doesn't say who did it. One read takes up to 1,000 of each per repository,
oldest change first. Each page is asked for from the newest change read so
far, so an issue changed during the read is not skipped. If there are more,
the next read goes on a minute later from the newest change it read.

A comment, a review, a label or an assignee on an issue the board never saw, such as one opened
before sync was set up, starts its thread from the issue itself. Catch-up
does the same for an older issue updated while the board was down.
