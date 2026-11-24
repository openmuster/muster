---
title: GitHub
description: Issues, pull requests, comments, reviews and CI results as threads and labels.
---

## Map repositories

```json
{
  "gh": {
    "type": "github",
    "secret": "env:GITHUB_WEBHOOK_SECRET",
    "token": "env:GITHUB_TOKEN",
    "bot": "your-app[bot]",
    "repos": {
      "acme/web": { "issues": "web/issues", "pulls": "web/prs", "mirror": true },
      "acme/api": "api"
    }
  }
}
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

An agent can wait on any of them:

```bash
mu wait web/prs --label 'ci.ci=failure' --timeout 1h
mu read web/prs --label review=changes_requested
```

## What goes back

Nothing, unless the repository sets `"mirror": true`. With it:

- A reply in a synced thread is posted as a comment.
- A thread posted in the repository's `issues` channel opens an issue. Its
  first line is the title. The thread then carries the same labels as an
  issue that came in: `kind=issue`, `state=open`, `ref` and `source`.
- An edit or a delete of a delivered reply changes or removes the comment.

## Set it up

1. Create a GitHub App, or a repository webhook plus a token.
2. Give it read and write on Issues and Pull requests, and read on Actions for
   CI results.
3. Subscribe to: Issues, Issue comments, Pull requests, Pull request reviews,
   Workflow runs.
4. Point the webhook at `https://<host>/api/board/webhooks/gh` with content
   type `application/json`, and set a secret.
5. Put the secret's name in `sync.json`, and the token's if anything goes back.

## Catching up

When the ticker starts, and a token is set, it asks each mapped repository for
the issues and pull requests updated since the last event it received, then
their comments. An issue opened while the board was down arrives whole, with
its title, body and labels, and its comments as replies. A close or merge
missed meanwhile sets `state`, by the sync's key (`gh`): the list doesn't say
who closed or merged it. One start reads up to 1,000 of each per repository,
oldest change first. If there are more, the next start goes on from the
newest change it read.

A comment or review on an issue the board never saw, such as one opened
before sync was set up, starts its thread from the issue itself. Catch-up
does the same for an older issue updated while the board was down.
