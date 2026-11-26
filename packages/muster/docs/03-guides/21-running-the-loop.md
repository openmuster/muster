---
title: Running the feedback loop
description: "The day-to-day of templates/loop: going live, approving, answering, sending a card round again, and what to do when something stops."
---

## Who this is for

You set up [a feedback loop](./20-a-feedback-loop.md) and now run it: cards
come in from Slack, Linear, GitHub or your app, agents work them, and you
step in when a card needs you. This page is what you do then, in the order
it comes up.

**You need:** the loop's `board.ts` and `workflows.json` (in
`templates/loop`), a host the platforms and the sandboxes can reach, and the
keys the guide lists.

## Go live

1. **The board's address.** The platforms' webhooks and the sandboxes reach
   the board over HTTPS: a named tunnel or a proxy to `mu serve`'s port. Put
   the address in the environment as `MUSTER_SANDBOX_URL`, ending in
   `/api/board`.
2. **The workflows.** Copy `workflows.json` to `~/.config/muster/` and set
   `repo` in both workflows to your repository.
3. **Who is trusted.** Set `LOOP_TRUSTED` to the actor IDs who may start work
   without an approval and may approve: `slack:user:U0123`,
   `lin:user:<uuid>`, an app's `<your principal>+<profile>`. You, with no
   profile, always are. A GitHub author never is.
4. **Where you hear.** Set `NOTIFY_CMD` to a command that takes one line: a
   push to your phone, a message to yourself. Without it the loop tells you
   nothing, and you read the board.
5. **A budget.** Cap what the cards may cost, every run under them included:

```bash
mu budget cards 25
```

6. **Start it**, with the secrets `board.ts` names in its environment:

```bash
mu serve --module ~/loop/board.ts --allow-host board.example.com
```

7. **Point each platform at it**, at `https://<host>/api/board/webhooks/<key>`,
   where `<key>` is the sync's name in `board.ts`: `slack`, `lin`, `gh`,
   `nt`. Each platform's page says what to subscribe to and which scopes its
   token needs: [Slack](../02-sync/04-slack.md),
   [Linear](../02-sync/03-linear.md), [GitHub](../02-sync/02-github.md),
   [Notion](../02-sync/05-notion.md). Notion's webhook is verified once
   first: start with `NOTION_WEBHOOK_SECRET=pending`, and follow its page.
8. **Who the loop writes as.** What the loop says on a platform is written
   by an app of its own, not by you, once each platform has one:

   | Platform | What to set up | In the environment |
   | --- | --- | --- |
   | GitHub | The GitHub App your workers push with, with read and write on Issues added and accepted on the organization | `GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE` |
   | Linear | An OAuth application with client credentials tokens turned on. One made for the board: such a token replaces an installation of the same application made through the authorization page | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_APP_WEBHOOK_SECRET` with `agent: true` to show the issue being worked on |
   | Slack | The bot you already have. To show "is working" under a thread while a card is worked on, turn on the app's agent feature, reinstall it, and add `agent: true` to `slack()` in `board.ts`. Slack doesn't let an app stop being an agent | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
   | Notion | The integration's own token: it already writes as the integration | `NOTION_TOKEN`, `NOTION_WEBHOOK_SECRET` |

   Each sync page says more: [GitHub](../02-sync/02-github.md#who-the-comments-are-by),
   [Linear](../02-sync/03-linear.md#who-the-comments-are-by),
   [Slack](../02-sync/04-slack.md#show-a-thread-being-worked-on). To check,
   reply on a card from each source and look at who wrote the comment there.
   A reply by someone in `LOOP_TRUSTED` on a card held `working` starts
   another round, so check on a card that isn't being worked on.
9. **Your app's button.** Make it a token that can only post reports, and
   keep it on the app's server:

```bash
mu token create --as pino-app --can 'cards/app=post' --ttl 90d
```

Then file one report from each source and watch it go through: held
`triage`, a spec on the card, `working`, a pull request.

## What a card shows while it works

Each run on a card, triage and then the work, starts with one reply from the
daemon: `started card: 3 tasks in cards/slack/card-57`. That reply is edited
as the run goes, to say where each task is (`#58 completed, #59 claimed, #60
waiting`), so the thread on Slack, GitHub or Notion shows one comment that
changes. When the run ends, its summary is a new reply, with each task's
result and the pull request, so everyone following the thread is told.

On Slack, with `agent: true`, that reply isn't posted: the thread shows
"<app> is working" under it while a run is open, and the summary when it
ends. On Linear, with `agent: true`, the issue shows the application's agent
session working, with where the run is, and its last words as the session's
response. Without it, Linear gets the reply as first written, since edits
don't go to Linear.

## What you hear about

| The line | What to do |
| --- | --- |
| `card #12 needs your approval` | Read the spec on the card, then approve it or leave it |
| `task #31 is blocked` | An agent needs a decision: answer it |
| `card #12's change is done for now` | Review the pull request, and reply on the card if it needs another round |
| `card #12 has a plan to read` | Read the planner's answer on the card: reply to it, or move the card to ready |
| `card #12 looks like a duplicate of #9` | Read both. Cancel #12, or label it `approved=yes` to work it anyway |
| `card #12 was declined` | Read the triage's summary on the card: edit the report, move it to ready again, or cancel it |

## Start and park cards

A card from Notion or Linear follows its status: move the page to Ready or
the issue to Todo to start it, and to Not started or Backlog to park it. The
loop sets In progress and Done itself. A card from anywhere else is ready
when it comes in; park or start it with a label:

```bash
mu label 12 stage=backlog
mu label 12 stage=ready
```

## Plan a card

Move a card to planning (Notion's Planning, Linear's Triage, or
`stage=planning`) and an agent answers on it with questions and a draft. Reply
on the card to answer; each reply is its next round. Move it to ready when the
draft is right: the triage writes the spec from it.

## Approve a card

A report from someone not in `LOOP_TRUSTED` waits, held `approval`, with the
triage agent's spec as a reply on it. Read the spec, not only the report: the
spec is what the work will do.

```bash
mu read 12
mu label 12 approved=yes
```

The inspector's label does the same, from a phone on your tailnet. A label
from anyone not trusted does nothing. If the report changes after the spec
was written, it is triaged again, and you approve the new spec.

## Answer a blocked task

An agent that can't go on without a decision blocks its task with where
things stand, `->`, and what it needs. Answer in the task's thread, then
unblock it, as yourself:

```bash
mu tasks cards/ --state blocked
mu read 31
mu reply 31 "Keep the old heading."
mu tasks unblock 31
```

A worker takes it again: the run's own, if it is still waiting for work, or
one the loop starts for that run.

## Another round

Once a card's run has ended, a reply on the card by someone trusted sends the
work and its review back with that reply, and the work carries on from its
branch: the same pull request gets another commit. Reply where the card is:
in the Slack thread, on the Linear issue, on the GitHub issue, on the Notion
page, or on the board.

- **One round at a time.** A reply made while a round runs waits for it to
  end, and goes into the next.
- **Several replies** made between rounds go into one round together.
- **A review comment on the pull request** doesn't start one: reply on the
  card.

## When something stops

| What you see | Why | What to do |
| --- | --- | --- |
| A card held `declined` | The triage agent found nothing to change in this repository, or stopped; its summary on the card says which | Edit the report to say more, or move it to ready again (`mu label 12 stage=ready`, or the page's Status): it is triaged again. Or cancel it: `mu tasks cancel 12` |
| A card stays `approval` | Nobody trusted has approved it | Approve it, or cancel it |
| A task held `push_conflict`, a `push` label on the work | Someone pushed to `mu/task-<id>` while the agent worked; the branch was left as they left it | Read the branch. Then reply on the card: the next round starts from the branch as it is now |
| A task held `push_failed` | The push itself failed, often the GitHub App's permissions | Fix the App's Contents permission, then reply on the card |
| Workers stop with `over_budget`, and nothing is claimed | The cards have spent their budget | Raise it (`mu budget cards 50`), or wait |
| A card held `edited` for a moment | Its author changed the report | Nothing: it is triaged again, or parked again |
| A card stays `backlog` though its page says Ready | The status was set by someone other than the sync, or Notion's webhook didn't reach the board | Move it out of Ready and back in Notion; check the webhook's deliveries |
| `couldn't set its Notion status` on the card | The integration can't edit the page, or the database has no option by that name | Give the integration "Update content", or add the option, or change `write` in `LOOP_STAGES` |
| A card held `done` | The review approved it, but the card couldn't be completed (its budget is spent, say) | Nothing: a trusted reply starts another round as usual |
| No card for a report | The source isn't reaching the board | `mu daemon status` names the module's sync; check the platform's webhook deliveries |

## Rotate and stop

Replace an app's token by making a new one, giving it to the app, and
revoking the old:

```bash
mu token list
mu token revoke Xk3v9QmB2a1c
```

To stop the loop, stop `mu serve`. What the platforms send while it is down
doesn't reach it, and the board catches up on Linear, Slack, GitHub and Notion
when it starts again. To take a source out, remove its sync from `board.ts` and its
webhook from the platform.
