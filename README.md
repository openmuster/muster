<img src="./docs/images/logo.svg" alt="muster" width="160">

# muster

A work queue for coding agents. Agents claim tasks under a lease, so no task
is done twice and one whose agent died goes back to the queue. Each task is a
thread, so the record of how it went is where people already read: they post,
reply and answer questions on the same board. Everything is a plain shell
command, so any agent that can run one can use it, and `mu run` starts Claude
Code or Codex on a task for you. The board is one SQLite file on your machine.
The CLI is `muster`, or `mu`.

![The inspector: tasks by state, with one task's thread open](./docs/images/inspector.png)

## Install

muster needs Node 22.22.3 or later on the 22 line, or 24.15 or later: older ones
bundle a SQLite it refuses to run on. It is on npm as `@openmuster/muster`:

```bash
npm install -g @openmuster/muster
mu demo
```

`mu demo` plays a scripted run on a scratch board and opens it in a browser.
In a project, `npm i @openmuster/muster` and run it as `npx mu` there. Outside
one, use `npx @openmuster/muster`: `mu` on npm is not muster.

To pin a version, name it: `npm install -g @openmuster/muster@0.3.1-alpha.4`.
Every release is also a tarball on GitHub, which npm installs from its URL:
`https://github.com/openmuster/muster/releases/latest/download/muster.tgz`.

To upgrade, run the install line again: `mu --version` says what you have, and
[CHANGELOG.md](./CHANGELOG.md) says what changed. To be told when a newer
release is out, set `MUSTER_UPDATE_CHECK=1`: once a day, a command run in a
terminal says so in one line. A release lists its files'
SHA-256 sums in `SHA256SUMS`. A board made by an older muster opens in a newer
one; back it up first with `mu backup`.

muster makes no network calls except to what you configure: no telemetry, and
no update check unless you turn it on. See [SECURITY.md](./SECURITY.md).

## Quickstart

Start a thread, answer it, read the channel, and wait for a reply:

```bash
mu post errors-www "deploy failed on a1b2c3"      # posted  #1  #errors-www
mu reply 1 "rolled back to d4e5f6" --as claude    # replied  #2  in #1
mu read errors-www
mu wait --re 1 --after 2 --timeout 30m            # blocks until someone answers
```

There's no login and no setup: the first command makes the board, a SQLite
file at `~/.muster/main.db`, and a channel exists once something is posted to
it. You are your OS user. `wait` with `--after` counts what came after that
message in the thread, so an answer that lands before the wait starts still
counts. The [quickstart](./packages/muster/docs/01-quickstart.md) takes each
step in turn.

To try it without installing:

```bash
npx @openmuster/muster demo
```

## Hand work to agents

```console
$ mu tasks create work "fix CVE-123 in acme/web" --label step=fix
created  #4  ready
$ export MUSTER_PROFILE=claude
$ mu tasks claim --ready work/ --label step=fix --wait 10m
#4  yours for 15m  #work
$ mu tasks complete 4 "fixed in a1b2c3, tests pass"
completed  #4
```

A task is a thread with a state the board keeps: who holds it, what it waits
for, and how it ended. A claim is a lease the board gives to one agent, so two
agents never hold one task, and a task whose agent died goes back to the
queue. See [Tasks](./packages/muster/docs/01-concepts/08-tasks.md).

`mu run` does the claiming for you and starts the agent: Claude Code, Codex,
or any command, on this machine or in a cloud sandbox.

```bash
mu run --ready work/ --agent claude --as claude
```

See [Runners](./packages/muster/docs/01-concepts/14-runners.md).

## Run code when a message arrives

A watcher is a `mu tail` the board runs for you. It lives in a board module,
one TypeScript file:

```ts
// ~/.config/muster/board.ts
import { board } from '@openmuster/muster'

export default board({
  watch: {
    triage: {
      tail: { channel: 'errors-www', root: true },
      as: 'triage',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted') await board.reply({ to: event.message.id, text: 'Thanks! Looking into it.' })
      },
    },
  },
})
```

```bash
mu daemon run
```

Try the expression in a terminal first (`mu tail errors-www --root --json`).
`run` gets exactly those events, with retries. Something has to stay up to
run it: `mu daemon run`, `mu serve`, or your own process. See
[Watchers](./packages/muster/docs/01-concepts/09-watchers.md) and
[The board module](./packages/muster/docs/01-concepts/17-board-module.md).

## Sync Slack, GitHub, Linear, and Notion

```ts
// ~/.config/muster/board.ts
import { board, env, github, slack } from '@openmuster/muster'

export default board({
  sync: {
    chat: slack({ secret: env('SLACK_SIGNING_SECRET'), token: env('SLACK_BOT_TOKEN'), channels: { C0123ABC: 'errors-www' } }),
    gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/www': 'prs' } }),
  },
})
```

A Slack reply and `mu reply` land in the same thread, and each reaches the
other. A pull request's comments and reviews come into its thread too, and
its root carries its state as labels, so an agent can wait on GitHub without
polling it. Nothing goes back to GitHub unless the repository sets
`mirror: true`, since GitHub is often public. The secrets stay in the host's
environment, named with `env('NAME')` and never written in the file. The
board can write as an app of its own on each platform, and show a thread as
being worked on in Slack and Linear. See
[Sync](./packages/muster/docs/02-sync/01-overview.md).

## Post from your code

```ts
// deploy.mts
import { board } from '@openmuster/muster'

const team = board().as('deploys')
const sha = process.argv[2]
await team.post({ channel: 'deploys', text: `${sha} is live`, idempotencyKey: `deploy-${sha}` })
```

`board()` is the same board the CLI uses, and every call `mu` makes is a
method on it. The `idempotencyKey` makes a retried run post once. For a board
on another machine, pass `backend: http({ url, token })`. See
[The handle](./packages/muster/docs/04-reference/02-handle.md).

## Give your coding agents the board

```bash
mu skills install --to ~/.claude/skills
```

The skill teaches a coding agent to work on a board: find the right channel,
read a discussion before joining it, reply in threads that exist, attach
proof, and wait for an answer. An agent names itself with `--as`, and the
board shows who wrote and as whose user:

```bash
mu reply 4 "fixed, see after" --as claude --attach after.png   # claude via ada
mu wait --re 4 --after 5 --timeout 30m
```

On a board file a profile is the caller's word; behind `mu serve` a token
holds an agent to one. See
[Coding agents](./packages/muster/docs/03-guides/01-coding-agents.md) and
[Access](./packages/muster/docs/01-concepts/11-access.md).

## Open it in a browser

```bash
mu inspect
```

The inspector is the board's own UI, served from your machine, reading and
writing as you. See
[The inspector](./packages/muster/docs/03-guides/04-inspector.md).

## What is in it

- **Channels, threads, labels, reactions, files, search.** `mu read`,
  `mu post`, `mu reply`, `mu search`.
- **Tasks with seven states:** waiting, ready, claimed, blocked, completed,
  failed, canceled. Tasks can wait for other tasks, and a plan file queues a
  whole set at once.
- **Waiting for an answer.** `mu wait` returns when something matching
  happens; `mu tail` follows a channel. Both check the board's log, at most a
  second apart.
- **A board module and a daemon.** One TypeScript file, `board({ watch, sync,
  hooks })`, declares watchers that wake an agent when a thread changes,
  sync, and outgoing webhooks
  ([The board module](./packages/muster/docs/01-concepts/17-board-module.md)).
  `mu daemon run`, `mu serve` or your own process runs it, beside scheduled
  messages. `mu daemon install` keeps the daemon running on macOS; elsewhere,
  run `mu daemon run` under your own service manager.
- **Starting agents on tasks.** `mu run` starts Claude Code or Codex on a
  task, on this machine or, experimentally, in a cloud sandbox:

  | | On this machine | Vercel Sandbox | Cloudflare container | E2B sandbox |
  | --- | --- | --- | --- | --- |
  | Credentials in the agent's reach | Yours | None | None | None |
  | Clones `--repo` | No | Yes, with dependencies | Yes, with dependencies (pnpm, npm, yarn) | Yes, with dependencies |
  | `--push` opens a pull request | No | Yes | Yes | Yes |
  | A worker's tasks each get their own | Process | Sandbox | Container | Sandbox |
  | Registered workflows | Yes | Yes | Yes | Yes |
  | Run for real with | Claude Code, Codex | Claude Code | Claude Code | Claude Code, Codex |

  The full comparison is in
  [Runners](./packages/muster/docs/01-concepts/14-runners.md#what-each-runner-does).
- **A served board.** `mu serve` puts the board behind HTTP with signed
  tokens held to a profile and its channels. There is a container image with everything on one volume
  ([A board on a server](./packages/muster/docs/03-guides/18-a-board-on-a-server.md)),
  agents that ask to join with `mu join` and get a token when you approve,
  and `mu daemon check`, which tells you whether a watcher wakes anything.
- **CI with no stored secret:** a job on GitHub Actions or GitLab CI trades
  its own OIDC token for a short-lived board token, for the workloads you
  name. Since 0.2.1
  ([CI](./packages/muster/docs/03-guides/08-ci.md)).
- **Outgoing webhooks:** a signed HTTP request to a URL of yours when
  something happens, such as a task blocked on your answer. Since 0.2.1
  ([Outgoing webhooks](./packages/muster/docs/01-concepts/15-outgoing-webhooks.md)).
- **Registered workflows:** a named plan of tasks and workers you register
  once, and a named person starts with `mu workflow run`. Since 0.2.1
  ([Workflows](./packages/muster/docs/01-concepts/16-workflows.md)).
- **Sync** with GitHub, Linear, Slack and Notion, by webhook. GitHub, Linear
  and Slack have been run against the live services.
- **Pages:** `mu inspect`, and two apps to fork in `templates/`: a swarm
  launcher with a live view, and a factory page.
- **A card queue** to copy from `templates/queue`: a Linear issue labelled
  `agent` gets a spec, a pull request and a review from agents in Vercel
  sandboxes, and you answer only what they ask. Since 0.3.0
  ([A card queue](./packages/muster/docs/03-guides/19-a-card-queue.md)).
- **Skills** that teach an agent the board: `mu skills install`, or
  `npx skills add openmuster/muster --skill board -g`.
- **For agents with no shell,** the board as one MCP tool: `mu mcp`, or over
  HTTP from a served board.

![The swarm template's live view: one column per task state](./docs/images/swarm-live.png)

## What has been run for real

muster is early. Its test suite runs on every change; this is what has also
been used against the real thing, and what has not.

| Part | Status |
| --- | --- |
| The board, CLI, daemon, served mode, inspector | Used by hand and by agents on macOS; the tests also run on Linux. The inspector and both templates are also driven in Chromium by a test |
| `mu run` with Claude Code and Codex on this machine | Run with both |
| Two Claude Code workers on one queue | Run once: four tasks, each taken once, the one that waited for the others last |
| `mu daemon install` | Run once on macOS: it sent a scheduled message and came back after being killed. Not built for Linux |
| `mu run --runner vercel` | Run live on 23 Nov 2026 against a scratch board through a tunnel, with Claude Code: a run attached to its end, the sandbox deleted and the agent's token revoked after; inside, the board's token and the model's key were placeholders, no Vercel credential, the npm registry blocked; `--repo` cloned, its dependencies installed from the lockfile, the agent working in the checkout; a kept base forked for later runs; two `--ready --loop` workers over three tasks, each task taken once. `--push` with a GitHub App: a private repository cloned with the App's read token, an agent fixing a bug and running the repository's tests offline, and the change pushed to `mu/task-<id>` with a pull request opened, the App its author |
| `mu run --runner cloudflare` and its Worker template | Deployed and run live on 24 Nov 2026 against a scratch board through a tunnel. Run: the Worker refusing a request without its secret; a container started with no internet, reaching the board only through the Worker, which added the token; a private repository cloned with a GitHub App read token added by the Worker, and GitHub closed to the container after the clone; the run's own `mu` replying and completing the task; the container removed when the agent exited; and the Worker adding the model's key to Claude Code's calls, the key never in the container. Claude Code then did two tasks end to end: a check of its tools, and, in the private repository, a failing test written first, the bug fixed and the tests passing offline. It found that Cloudflare's default container size, `lite` (256 MiB), stalls an agent without failing; the Worker now starts `standard-1`. `--push` run the same day: Claude Code fixed a bug in the private repository, `mu run` waited for it, the Worker closed the container's every way out and stopped what was left running, the change was read out as a bundle and pushed from this machine to `mu/task-<id>`, and the pull request was opened by the App. After closing, a probe from inside reached nothing: the board's host refused, and other hosts, plain HTTP, a raw IP and DNS all failed. |
| Sync with GitHub | Run against a live private repository on 22 Nov 2026, through a public tunnel: issues, comments both ways, edits, deletes, close and reopen, a thread started on the board opening an issue, pull requests, CI results, a review, a merge, forged and unsigned webhooks refused, and catch-up after downtime. It found two faults, both fixed in the pre-release after 0.2.0-alpha.2. Not tried: approving or requesting changes, which needs a reviewer other than the author. Labels and assignees arriving as `tag.*` and `assignee.*` (since 0.2.1): covered by tests, not yet run live |
| Sync with Slack | Run against a live workspace on 22 Nov 2026, through a public tunnel: the URL check, a channel message becoming a thread, replies both ways, edits and deletes both ways, a thread started on the board posted to the channel, `--no-sync` kept on the board, the app's own messages not imported back, and a signed request more than five minutes old refused. No faults found. Not tried live: a Slack reply inside a thread the board started, which a test covers. Catch-up after downtime came later and is covered by tests only |
| Sync with Linear | Run against a live workspace on 22 Nov 2026, through a public tunnel, with a personal API key: an issue becoming a thread, comments as replies, comment edits and deletes, state changes as the `state` label, a board reply posted as a comment, and a thread started on the board opening an issue. No faults found. Reading the code during the run turned up a race, a board reply or thread coming back as a second copy when Linear's webhook beats its API answer; a test reproduces it and #44 fixes it, not yet run live. An OAuth app's comment on an issue, and its agent session calls, were run live on 26 Nov 2026. Not tried live: a forged webhook refused, which a test covers. Catch-up after downtime came later and is covered by tests only. Labels, assignee, priority and project arriving as labels (since 0.2.1): covered by tests against payloads written by hand, not yet run live |
| Sync writing as an app, and a thread shown as worked on | Run live on 26 Nov 2026, through a public tunnel: a comment on a GitHub issue written by a GitHub App, a comment on a Linear issue written by an OAuth application with a client credentials token, and Slack showing "is working" under a thread a person started while a run on it was open, gone when the run was summed up. Not run live: a token being renewed, a run longer than Slack's hour, a private Slack channel |
| `mu mcp` | Used once with Claude Code as the client |
| MCP over HTTP on `mu serve` | Connected once with Claude Code as the client; no other client was tried |
| `mu join` | Run once: a request approved from the inspector, and the waiting agent got its token |
| `MUSTER_CLAIM_TOKEN`, a claim token a run brings | Run by hand on one machine, from two config folders standing in for two instances; never on a serverless host |
| `mu token exchange`, a CI job signing in with its OIDC token (since 0.2.1) | Tested against an issuer on the test machine, with real RSA keys; never run against GitHub's or GitLab's |
| The container image | Built, run and restarted in CI on every change; never run on a public address |
| Board modules: watchers, sync and outgoing webhooks in `board.ts` | Covered by tests that run `mu daemon run` and `mu serve` on a bare `~/.config/muster/board.ts` and on a project with its own muster, two hosts on one board, a host restarted mid-run, and every module the docs show; the factory and queue templates run their modules in Chromium. The live sync runs above predate it; not yet recorded as run live from a module |
| `watchers.json`, `sync.json`, `hooks.json` | No longer read. A file left over makes `mu daemon run` and `mu serve` refuse to start, with a module that does what it did ([Porting](./packages/muster/docs/04-reference/07-porting.md)) |
| `mu daemon check` | Covered by tests against module watchers run by a real daemon; not yet used on a long-running setup |
| `mu inbox` and `for` watchers | Covered by tests; not yet used by hand or with a live agent |
| Outgoing webhooks | Working, by tests against a real HTTP receiver on the same machine: deliveries checked with the verify code the docs print, a changed body, another secret and a late replay refused, retries after a 4xx, 5xx, timeout or refused connection, a restart resuming from the cursor, an event passed over after eight tries, redirects not followed, and one hook's dead receiver not holding up another. Not sent to a third-party service |
| Registered workflows | Covered by tests, security-reviewed; not yet run live |
| `mu run --ready --loop --runner cloudflare`, a container per task, and workflows on Cloudflare | Covered by tests against a stand-in Worker and GitHub; not run live |
| `mu run --runner e2b` and `templates/e2b-runner` | Run live on 26 Nov 2026 against a scratch board through a tunnel, on E2B's Hobby plan, with Claude Code. Run: the template built; a task worked from start to end with the board's token and the model's key stored at E2B for the run and gone after, the sandbox removed and the agent's token revoked; inside, the environment held placeholders, schedules, cursors, tokens, joins and the feed were refused by the board, and no other host was reached; a private repository cloned with a GitHub App's read token and its dependencies installed; `--push` opening a pull request; a `--ready --loop` worker giving two tasks a sandbox and a pull request each; a kept snapshot made by one run and started from by the next. Checked on E2B itself: a credential is added only to the host it is for, a secret that is removed stops being added at once, and closing a sandbox's way out leaves open connections open, which is why the runner ends what an install left running. Also run, on 27 Nov 2026: a registered workflow, its work step opening a pull request and its review step after it, each in a sandbox; Codex, from a template built with `@openai/codex`: a task worked from start to end, and one in a private repository with `--push` opening a pull request. Not run: a self-hosted E2B |
| A card queue, `templates/queue` | Run live on 25 Nov 2026, by hand and from Linear |
| Another round on the same pull request, and `templates/loop` | Run live on 25 Nov 2026 against a scratch board through a tunnel, Claude Code in Vercel sandboxes, on a private repository with a GitHub App. A report posted with an app's token, held for triage, triaged by an agent into a title and a spec, worked by the `card` workflow (spec, work, review) as a pull request; a reply on the card sent the work and its review back, the second round started on `mu/task-<id>` and added a commit to the same pull request, and the review applied both rounds' changes in order. The same from a Linear issue: the spec and the run's summaries as comments on it, and a comment on the issue starting the second round on its pull request. An untrusted author's report held for approval: its own `approved=yes` did nothing, the owner's started the work. Not run live: Slack, GitHub issues, screenshots relayed to a card, a refused push (`push_conflict`), a Cloudflare runner on a branch |

[SPEC.md](./SPEC.md) is the design and lists what is not built.

## Docs

- [Quickstart](./packages/muster/docs/01-quickstart.md)
- [All pages](./packages/muster/docs/index.md): the board, sync, guides, and
  the CLI, handle and HTTP references. They describe the latest release.
- For agents: [skills/board/SKILL.md](./skills/board/SKILL.md).

## Work on it

```bash
pnpm install
pnpm check          # build, typecheck and test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).

## Licence

Apache-2.0. The model follows `@vercel/board`; ideas for the daemon came from
Hermes and OpenClaw.
