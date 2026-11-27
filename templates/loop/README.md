# loop

Feedback from anywhere becomes a card, an agent makes the change as a pull
request, and a comment on the card starts another round on the same pull
request. A report can come from a Slack thread, a Linear issue, a GitHub
issue, a Notion page, the inspector, or your own app. You hear about a card when it needs
your approval, when a task blocks on a decision of yours, and when a round
is done.

It is a board module for muster's own daemon and a workflow file. The guide
is [A feedback loop](../../packages/muster/docs/03-guides/20-a-feedback-loop.md),
and [Running the feedback loop](../../packages/muster/docs/03-guides/21-running-the-loop.md)
is the day-to-day: going live, approving, answering, and what to do when
something stops. The `loop-card` skill (`npx skills add openmuster/muster`) teaches an agent
each step.

| File | What it is |
| --- | --- |
| `board.ts` | Sync from Slack, Linear, GitHub and Notion, each into its own channel under `cards/`, and the watchers that move a card along: `intake`, `promote`, `approve`, `edited`, `stage`, `planned`, `plan-stopped`, `declined`, `round`, `settled`, `resume`, `needs-me` |
| `workflows.json` | `triage`, one step that turns a report into a card; `planning`, one step that shapes a report with you over rounds; and `card`, spec, work and review, with `--push` for the work step only |

```bash
cp workflows.json ~/.config/muster/
# then edit: your repository in workflows.json, your Slack channel ID, Linear team, GitHub repository and Notion database in board.ts
export LOOP_TRUSTED=slack:user:U0123,lin:user:3f2a...   # who may start work without your approval, and approve (not GitHub logins)
export NOTIFY_CMD=...                                    # optional: a command that gets one line to show you
mu serve --module "$PWD/board.ts" --allow-host <your host>   # with MUSTER_SANDBOX_URL, not MUSTER_URL
```

## A card's life

| Hold | What is going on |
| --- | --- |
| `backlog` | Parked: the source's status says so (Notion's Not started, Linear's Backlog), or someone trusted labelled it `stage=backlog`. Nothing runs until it is ready |
| `planning` | Notion's Planning, Linear's Triage, or `stage=planning`: the `planning` workflow's agent answers on the card with questions and a draft, and each trusted reply is its next round. Nothing is built until it is ready, and then the triage writes the spec from the plan |
| `triage` | The `triage` workflow's agent reads the report and the repository, and writes a card: a title on the first line, what to change and how to check it. Or it fails, with why, and the card stays as it is |
| `approval` | The card's spec is a reply on it, and the report's author isn't trusted. A trusted person labels it `approved=yes`: `mu label 12 approved=yes`, or in the inspector |
| `working` | The `card` workflow runs on that spec reply: spec, work, review. The work pushes `mu/task-<id>` and opens a pull request. Its screenshots are copied onto the card when the run ends |
| `duplicate` | The triage found the same request on another card, and named it. Its spec is on the card: someone trusted labels it `approved=yes` to work it anyway |
| `declined` | The triage made no card: nothing to change here, or its agent stopped, as its summary on the card says. Edit the report, or move it to ready again, to try again |
| `edited` | The report's author changed it. It is triaged again, from the new text, or parked again if it was parked |

The loop writes In progress back to Notion or Linear when the work starts,
and Done when the review approves it; then the card is completed. The stages
and the statuses are `SOURCES` in `board.ts`: see
[Stages](../../packages/muster/docs/03-guides/20-a-feedback-loop.md#stages).

A reply on the card by someone trusted, once the run has ended, is another
round: it goes to the work task, the work and its review are sent back, and
a worker takes them. The work starts from its branch, so the pull request is
the same one. A comment made while a round runs waits for it to end.

## Your app's feedback button

Make your app a token that can only post reports, and post with it from the
app's server, never from a browser:

```bash
mu token create --as pino-app --can 'cards/app=post' --ttl 90d
```

The app's reports are by `<your principal>+pino-app`. Add that to
`LOOP_TRUSTED` only if everyone who can use the app is someone you would let
start work.

## Write the project's spec for an agent

The workflows tell every agent to read `AGENTS.md` and the project's spec
first. Write them as a brief to an agent, not as a description for people:

- **Hard rules first:** what must never happen (real email sent in a test,
  a secret in a log), and what every pull request must have (tests passing,
  `pnpm typecheck`, screenshots).
- **Goals, numbered,** each with the section that details it.
- **A way for the agent to see its work:** a demo mode that runs in a plain
  browser with sample data, so the agent can build, test and screenshot it in
  a sandbox with no credentials.

## What a card can reach

A report is written by whoever filed it, and it steers agents that can push.
The triage agent changes nothing and pushes nothing. Work starts only on a
report whose author is in `LOOP_TRUSTED`, as first written, or once someone
in it approves; an author sync couldn't name is never trusted, nor a GitHub
author, whom sync names by a login that can change hands, so a GitHub issue
always waits for an approval. The run that does the work quotes the approved
spec alone, never the report, and the spec reaches the card's mirrors with
no mention, link or unfurl in it. The worker reads the work step's change
out of its sandbox, then pushes a branch and opens a pull request from its
own machine; the sandbox never holds the GitHub token. That pull request
runs your CI on the agent's code: keep secrets away from pull-request jobs. The rest is
in [A card queue](../../packages/muster/docs/03-guides/19-a-card-queue.md#what-a-card-can-reach),
which this template builds on.

Each change to a report is triaged again, and only the newest triage's spec
reaches the card, so an approval is always of the text as it stands. That
also means anyone who can file a report can start triage runs by editing it:
cap what they cost with a budget on the source channels (`mu budget`). Screenshots reach the card
only as real images (PNG, JPEG, GIF or WebP, by their bytes), up to 5 MB and
ten a round, from the card workflow's own workers.

Covered by tests (`packages/muster/test/loop.test.ts`), with the sandboxes as
stand-ins. Run live on 25 Nov 2026 from an app's token, a Linear team and the
inspector, through rounds on the same pull request and an approval; and on 26
Nov 2026 from Slack, with the thread shown as worked on, and with replies
written by a GitHub App and a Linear application. See "What has been run for real" in the
repository's README.
