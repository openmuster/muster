# Changelog

What changed for people who use muster, newest first. Security fixes say which
versions are affected.

## Unreleased

### Added

- Another round on the same pull request: a `--push` task run again after it
  pushed, reopened with `--round` or answered after it blocked, starts its
  sandbox on `mu/task-<id>` and adds to it, so the pull request stays the
  same one, and the agent's prompt says which round it is. Before, each run
  started from the default branch and replaced what the last one pushed.
  See [Another round on the same pull request](./packages/muster/docs/03-guides/06-sandboxed-agents.md#another-round-on-the-same-pull-request).
  - The branch only moves forward from where the run found it: a branch
    someone pushed to meanwhile, or a change that doesn't build on it, is
    refused with `push_conflict` and left as it was.
  - A change that wasn't pushed is said on the task (a `push` label and a
    reply), and the tasks that wait on it are held, so a review never goes on
    from a change that isn't on the branch.
  - Pull requests open against the repository's default branch.
  - Cloudflare: deploy the current `templates/cloudflare-runner`. A Worker
    deployed before this clones the default branch, and a second round's
    run is stopped with `runner_too_old` rather than replace the first.
- `{on.text}` in a workflow step: the very message the run was asked on, a
  reply as often as not, quoted and fenced as `{thread.text}` is. A message
  deleted since, or edited after the request, starts no run
  (`asked_message_changed`).
- `workflowResult(team, id, owner)`: a workflow step's result for code that
  goes on from it, only when the daemon made the task and the run's own
  worker completed it.
- `templates/loop`: feedback from Slack, Linear, GitHub, the inspector or
  your own app becomes a card, triaged by an agent into a title and a spec;
  work starts on a trusted author's report, or once someone trusted approves;
  a trusted reply on the card starts another round on the same pull request,
  and each round's screenshots reach the card. See
  [A feedback loop](./packages/muster/docs/03-guides/20-a-feedback-loop.md).
  - A task of a run answered and unblocked after the run's workers stopped
    gets a worker of its own (`resume`).
  - [Running the feedback loop](./packages/muster/docs/03-guides/21-running-the-loop.md),
    the operator's day-to-day, and the `loop-card` skill for the agents.

## 0.3.1-alpha.1

### Added

- Sync in a board module: `board({ sync: { gh: github({ secret:
  env('GITHUB_WEBHOOK_SECRET'), repos }) } })`, in the shape of a `sync.json`
  entry, with a porting table in
  [Sync](./packages/muster/docs/02-sync/01-overview.md#in-a-board-module).
  `env('NAME')` reads nothing when the module is imported: the board reads
  it when it starts (`team.start()`, `mu serve`, `mu daemon run`) or takes its
  first request (`team.fetch`), and a variable that isn't set stops it, by
  name: `GITHUB_WEBHOOK_SECRET isn't set, and sync "gh" needs it.`
  - `mu serve` and `mu daemon run` run the module's sync: its webhooks,
    catch-up, files and what goes back, under the board's `sync` lease.
    `sync.json`'s sync now takes the same lease, and each message is claimed
    on the board before it goes, so an app host and a daemon on one board
    never send a reply twice.
  - A variable that isn't set, or is empty, stops `mu serve` (exit 1) and
    `mu daemon run` (exit 0). `team.fetch` keeps serving, answers webhooks
    with a plain 503 and `health` with 503, and says why only in its log.
  - `env()` is never text: turned into a string it throws, and a secret
    written as `"env:NAME"` is refused.
  - A module that declares `sync` beside a `sync.json` is refused: two places
    saying what a board syncs is one too many.
  - `mu daemon status` lists each sync, the variables it reads and the host
    that holds its lease. `team.sync` lists what a handle declares.
  - `filter` and `filesPerDayMB` are options of `github()`, `linear()` and
    `slack()`, as in `sync.json`.

- Outgoing webhooks in a board module: `board({ hooks: [{ name, url, secret:
  env('AUDIT_SECRET'), tail }] })`, shaped like a `hooks.json` entry, with a
  porting table on the outgoing webhooks page. The secret is named with the same
  `env()` as sync: `start()` reads it, and refuses to start without it, naming
  it. `mu daemon run`, `mu serve` and your own `team.start()` send
  them with the same signatures, tries and order, under one `hooks` lease, so
  two hosts on a board never both send. `mu daemon status` shows each hook's
  holder and lag, and `mu daemon check <hook>` pings one. A module with
  `hooks` beside a `hooks.json`, or a hook named like a watcher or a
  workflow, is refused.

### Removed

- `watchers.json`, `sync.json` and `hooks.json` are no longer read.
  Watchers, sync and outgoing webhooks are declared in a board module
  (`~/.config/muster/board.ts`, or `--module`): `board({ watch, sync, hooks })`.
  [Porting](./packages/muster/docs/04-reference/07-porting.md) shows a module
  for each file. `workflows.json` and `oidc.json` are read as before.
  - A `watchers.json`, `sync.json` or `hooks.json` left in
    `~/.config/muster/` makes `mu daemon run` and `mu serve` refuse to start
    with `config_retired`, showing a module that does what the file did.
    `mu daemon run` exits 0, so launchd leaves it stopped rather than
    restarting it. `mu daemon status` names the file.
  - `loadSync` is no longer exported. A sync is `github()`, `linear()` or
    `slack()` in `board({ sync })`, or given to `file({ sync })`.
  - `mu daemon check` takes a watcher or an outgoing webhook the board module
    declares. `no_ticker` and `sync_twice` are gone: a watcher nothing runs
    is `watcher_not_running`.
  - `mu daemon status` no longer has `watchers` and `hooks` lists in its
    `--json`: what a module declares is under `module`.

### Docs

- The docs, guides and skills declare watchers, sync and outgoing webhooks
  in a board module, and a new page,
  [The board module and hosts](./packages/muster/docs/01-concepts/17-board-module.md),
  says where a module is found and what runs it.
  [Porting](./packages/muster/docs/04-reference/07-porting.md) maps every
  field of `watchers.json`, `sync.json` and `hooks.json` to the module. Every
  TypeScript block the docs show is type-checked against muster, and every
  board module among them is loaded by `mu`, in a test.

### Changed

- A watcher in a board module whose runs keep failing, across threads, slows
  down: past five failures in a row its loop waits 2 seconds, then 4, and so
  on up to ten minutes, and says `slowed` in its log. One run that works puts
  it back to its usual pace. The JSON watchers did this; module watchers only
  backed off one thread at a time.

## 0.3.0

### Added

- Workflow steps can quote an earlier step's result with
  `{steps.<key>.result}`, fenced and defused as `{thread.text}` is. The
  worker that takes the task fills it in before its agent starts. A step may
  name only a step it `needs`, directly or through another, and
  `workflows.json` is refused otherwise. A missing result reads as a
  `(No result from step …)` note, and so does one that the run's own worker
  didn't complete, such as a step another agent of the run claimed and
  completed with its sandbox's token. A task whose text was edited since the
  daemon made it isn't filled, and is held as `workflow.edited`.
- A task claim says, in its `task.claimed` event, whether the claimer was a
  token held to channels (`narrowed: true`).
- A workflow step can set `push: true` or `push: false` to override
  `workers.push`. The worker, and `mu run <id> --push`, read it from how the
  daemon made the task, so a label set later by anyone else doesn't change
  whether a task is pushed.
- The card queue template uses both: the spec and review steps push nothing,
  and the work and review steps get the spec's result (and the review the
  work's summary) quoted, rather than being told to `mu read` it unfenced.
  `answer.sh` answers only a task held on a question (`needs_input`), and
  refuses one held because someone edited it.

- Parking work for later: `mu tasks create … --hold backlog --reason "…"`
  makes a task already blocked, in one write, so no `--ready` claim takes it
  before you unblock it. Any kind works; `backlog` is the convention.
- `--kind` on `mu wait` and `mu tail`, and `kinds` in a watcher's or
  webhook's filter: `--kind needs_input` keeps only blocks of that kind,
  `--kind '!backlog'` leaves parked work out and keeps everything else. A
  watcher on `task.blocked` no longer has to wake you for work nobody is
  asking about. Nothing new is stored: the kind is read from the event.
- `mu tasks block` and `mu tasks fail` take the reason as `--reason` too.
- The board skill tells an agent to read a task's thread after claiming it,
  and to reply what is done and what is next before releasing it. Run
  `mu skills install` again to get it.
- `team.fetch`: a board served from your own web app, as a web
  `Request → Response` handler (`export const GET = team.fetch, POST =
  team.fetch`). It answers what `mu serve` answers, from the same code: the
  routes, the live feed, `health`, and webhooks for the handle's `sync`, with
  every request held to a token signed with the key `mu serve` uses. It is
  mounted at `/api/board` unless `board({ serve: { base } })` says otherwise,
  and answers only for this machine and the names in `serve.hosts` (default
  `MUSTER_ALLOW_HOSTS`). MCP, `tokenExchange` and requests to join stay with
  `mu serve`. The factory template serves its board at `/api/board` this way.
  See [Mounting it in a web app](./packages/muster/docs/04-reference/02-handle.md#mounting-it-in-a-web-app).
- `mu serve` and `mu daemon run` run a board module: a `.ts` file whose
  default export (or `team`) is a `board({ watch })`. They start its watchers
  beside the ones in `watchers.json`, hooks and workflows. The module is
  `--module <file>`, else `MUSTER_MODULE` (an absolute path), else
  `~/.config/muster/board.ts` when nothing named a board (no `--dir`,
  `--board`, `--url`, `MUSTER_DIR`, `MUSTER_BOARD` or `MUSTER_URL`), so a
  daemon installed for a board keeps running that board. `--no-module` runs
  none. It needs no `package.json`: a global `mu` answers its
  `import 'muster'`. A project with its own muster runs on that install
  instead, in the same process. A module named on purpose says which board it
  is, so `--dir`, `--board`, `--url`, `--as` or `MUSTER_PROFILE` beside it is
  misuse.
  - A daemon on a module is named, logged and guarded for the board the
    module opens. While another process ticks, it runs the module's watchers
    and takes the tick over when that process stops.
  - A module that doesn't load (Node's message, and what to change) makes
    `mu daemon run` say so and exit 0, so launchd leaves it stopped. `mu serve`
    says so loudly and serves the board without it.
  - A module watcher named like a watcher, hook or workflow in the config
    files is refused when the module loads.
  - `mu daemon status` shows the module, and each of its watchers' filter,
    the host that holds it, and how far behind it is. It warns about any that
    are declared but not started.
  - `mu daemon check <name>` checks a module watcher.
  - `mu daemon install` records the module's absolute path and the folder it
    was installed from.
  - `team.watchers` lists what a handle declares.
  - With a module, `sync.json` isn't read: `mu` says so, and
    `mu daemon install` says to move its sync into the module.
- A card queue template, `templates/queue`. A Linear issue labelled `agent`,
  or a card posted with `--label tag.agent=agent --no-sync`, starts the
  `card` workflow once: a spec, the change as a pull request, and a review,
  each in a Vercel sandbox, with a reply on the card when it starts and a
  summary when it ends. A task that blocks pings you with its ID, and
  `answer.sh` replies, unblocks it and starts a worker on it. Covered by
  tests, not run live. See
  [A card queue](./packages/muster/docs/03-guides/19-a-card-queue.md).
- Watchers in code: `board({ watch: { name: { tail, run, as } } })`, beside
  the board. Declaring them opens nothing; `team.start()` runs each in a loop
  of its own, in the process you choose, and returns `{ stop, done }` at once.
  Never await `done` where a server starts up. Each watcher is held by one
  host at a time through a lease `watch:<name>` in the board's file, so two
  hosts on one board never both run it, and one takes over when the other
  stops. Each thread's events are delivered in order and each thread on its
  own: a failed run is tried again later without holding up other threads,
  tries are counted in the board's file so a restart or a crash never
  delivers a recorded event twice, and after 5 tries the watcher says so once
  on the thread. Each thread backs off on its own, so a failing thread never
  holds up a new one. A run has a `timeout` (60 seconds unless given) and a `signal`;
  past it the run is aborted and its writes refused. Its writes are keyed by
  the event, so a try after a throw doesn't write twice. `coalesce` gathers a
  thread's burst into one run, and the `event` a run gets is what
  `mu tail --json` prints. `command(argv, { env, gate })` is a `run` that
  wakes a command the way `watchers.json` does: a clean environment with a
  pointer to the event and the board, never its text. The run is over when
  the command exits, so an agent it starts in the background lives on; until
  then its process group is stopped at the timeout or the host's `stop()`. `await team.deliver()` runs them once, for tests. The watchers in
  `watchers.json` work as before.

- `--root` on `mu tail` and `mu wait`, and `root: true` in a filter: only what
  is about a thread's first message, leaving out replies and what is done to
  them.
- `idempotencyMatch: 'shape'` on a write with an `idempotencyKey`: a repeat is
  compared on what the write is and where it lands, not its text, so a retry
  that worded it differently gets the first answer and one that writes
  somewhere else is refused.

### Changed

- One process ticks a board by holding its `tick` lease, a row in the
  board's own file, instead of a lock file beside it. The holder renews it
  every 5 seconds; one that stops (killed, crashed) is replaced once its
  lease lapses, within 30 seconds. So a daemon restarted right after a crash
  waits out its old self's lease and takes over, rather than finding it held.
  Telling a live holder from a dead one no longer needs `ps`, which slim
  container images don't have, and a board kept in memory no longer writes a
  `:memory:.tick.lock` file into the folder it was started from.
- A board made by this version can't be opened by 0.2.1 or earlier: it has
  tables they don't know (store version 9). Boards from earlier versions are
  upgraded when opened.
- `mu daemon run` on a board at a URL (`--url`, `MUSTER_URL`) says the
  server ticks that board and exits 0. Before, it stayed up and every tick
  was refused.

- The factory and card queue templates are board modules: their watchers
  and their sync are in code, and `watchers.json`, `sync.json` and `wake.sh`
  are gone from both. The factory's `lib/board.ts` exports a module-scope
  `team` with its GitHub sync and the watcher `factory`. `pnpm host`
  (`host.ts`) runs both, holding the leases `watch:factory` and `sync`, and
  stops cleanly on SIGTERM or SIGINT. GitHub's webhook goes to the app's
  `/api/board/webhooks/gh` (the route is `export const GET = team.fetch`),
  and the page says who holds `tick`, `sync` and `watch:factory`.
  `lib/wake.ts` replaces `wake.sh`, and in a Vercel sandbox keys the wake's
  task by the event, so a retried wake makes no second task. An agent
  started on this machine gets only what any process needs, the pointer and
  `ANTHROPIC_API_KEY`; the Vercel and GitHub App settings reach the wake only
  with `FACTORY_RUNNER=vercel`, and then only `mu run`. The queue's
  `board.ts` declares its Linear sync with `env()` and runs `start.sh` and
  `notify.sh` with `command()`, by their full paths; run it with
  `mu serve --module`. If you copied either template's `watchers.json` or
  `sync.json` into `~/.config/muster/`, move what else they hold into a
  module and delete them: a watcher there and in a module under one name is
  refused, and so is a module's sync beside a `sync.json`.

### Fixed

- A feed (`GET /api/board/feed`) whose client left while it was still
  opening is now closed. Before, `mu serve` went on reading the board for it
  every half second until the client's token ran out.
- Linear: a webhook that arrives late no longer undoes a newer change. Sync
  applied issue updates in the order they arrived, so a removal Linear sent
  again after a failed delivery, landing after the label was put back, took
  `tag.agent` off an issue that has it, and its card never started. Each
  update now carries when Linear says the issue changed (`updatedAt`), and
  one no newer than the last applied to that issue is skipped, with a
  `skipped sync` line in the log. Catching up after downtime follows the
  same rule both ways, and so do comment edits. The board keeps what it
  applied in its file, so a restart doesn't forget it. Covered by tests, not
  run live. See
  [Linear](./packages/muster/docs/02-sync/03-linear.md#in-the-order-linear-made-them).
- Linear: a change to an issue made before sync was set up, such as the label
  `agent`, now starts its thread from the update, with the issue's title,
  description and labels, and then applies the change. Before, the webhook
  was dropped, so labelling an older issue did nothing and the card queue
  couldn't start a card from it. A comment on such an issue now starts its
  thread from the issue's title, with the comment as its first reply; before,
  the comment was both the thread's first message and a reply. Issues in
  unmapped teams still start nothing. Covered by tests, not run live. See
  [Linear](./packages/muster/docs/02-sync/03-linear.md#an-issue-from-before-sync).
- A registered workflow's run that was summed up as failed, and then went on
  after someone reopened its failed task (`mu tasks reopen`), now gets a new
  summary once it settles again, such as `implement finished (updated): 3
  completed, 0 failed, 0 canceled`. Before, the thread, and the Linear or
  Slack issue it syncs to, kept saying the run failed while its work was done
  and its pull request open. The update is said once per reopen, also across
  a daemon restart, and never while the run is still going; a reopened task
  nobody takes is summed up as it stands once the workflow's `timeout` has
  passed since the reopen. Runs reopened before upgrading aren't summed up
  again.
- `mu run` no longer fails a task over a session the agent doesn't have. A
  session remembered from the task's `session` label can live only where the
  agent last ran: a cloud sandbox that is gone, or a session deleted here.
  The agent now starts again fresh at once, under the same claim, and the
  task counts no failed attempt. Before, the run failed (`bad_resume`), and
  the failed run wrote the same session back to the label, so every retry
  failed the same way until the task ran out of attempts. A session named
  with `--resume` that the agent doesn't have still fails the run, and is no
  longer remembered.

## 0.2.1

### Added

- Files sync with Slack and Linear, both ways. A file on a Slack message, or
  uploaded to Linear and linked from an issue or comment, is fetched and
  attached to the board message; a board message's files are uploaded to
  Slack and shared into its thread, or uploaded to Linear and linked from the
  comment. Files are fetched only from `files.slack.com` and
  `uploads.linear.app`, over https, with no redirect followed, and the token
  goes nowhere else. The limits are those of `--attach`: 10 files of 25 MB,
  and each sync brings in at most 500 MB of files a day (`filesPerDayMB` in
  `sync.json`), counted when stored. A Linear upload is fetched only from
  the key's own workspace.
  A file that is too big or refused is named in a line at the end of the
  text, never dropped silently. The operator's filter decides before any
  file is fetched: a message it drops or changes keeps none of its files. GitHub has no upload API, so a board file is
  named in the comment instead. The Slack app needs `files:read` and
  `files:write`: add them and reinstall. Covered by tests only, not run live.
  See [Files](./packages/muster/docs/02-sync/01-overview.md#files).

- Sync brings in what an issue is filed under. A GitHub issue's or pull
  request's labels and assignees, and a Linear issue's labels, assignee,
  priority and project, arrive as labels on its thread: `tag.bug=bug`,
  `assignee.maya=maya`, `priority=high`, `project=<name>`. They follow the
  platform: one taken off there is taken off the thread, and catching up
  after downtime brings them up to date, for GitHub and for Linear. So `mu read`, `mu wait` and
  a watcher can filter on them (`--label tag.agent=agent`). These keys are now
  the platform's on a synced thread: a label you set by hand under `tag.` or
  `assignee.`, or as `priority` or `project` on a Linear thread, is replaced
  or taken off at the item's next update. Use other keys for your own.
  Nothing is written back to the platform. Not yet run against the live
  services.
- Labels that sync writes are now held to the rules for your own: a key or a
  value the board wouldn't take from `mu label` is left out, and a thread
  never gets more than a message holds.
- `mu run --runner cloudflare --repo` installs the repository's dependencies
  from its lockfile, with the same script as on Vercel: pnpm, npm or yarn,
  with no install scripts, for at most three minutes. The Worker opens the
  npm registry hosts to read, and nothing else, for the install alone: the
  board and the model are closed while it runs, since it runs the
  repository's own code. After it the registries close, whatever it left
  running is killed, and the agent starts. A start that would take longer
  than 4 minutes gives the install less time, or skips it with
  `failed (timeout)`, so the CLI always gets the run's ID. A failed install gets the `deps` label
  and a reply, and the agent starts. `--no-install` skips it. Redeploy
  `templates/cloudflare-runner` and rebuild its image to use it. Covered by
  tests, not run live.

- Linear sync catches up after downtime, as GitHub's does. When the ticker
  starts it asks Linear for the issues and comments in the mapped teams
  updated since the last event it received, and imports what the webhooks
  missed: new issues, new comments and state changes. What the board already
  has is not imported twice. Edits and removals made meanwhile are not read.
  A state change is put down to the sync (`lin`), since Linear's list doesn't
  say who made it. One start reads up to 500 of each, oldest first; the next
  goes on from there. Covered by tests against a faked Linear API only.
- Slack sync catches up after downtime too. The ticker reads each mapped
  channel's history, oldest first, and the new replies in threads started
  meanwhile, and imports what the webhooks missed, once. The app's own
  messages are skipped. A tick makes up to 24 requests and moves every channel
  on; the next goes on from there. A minute busier than a tick can read is
  gone past and logged as skipped. Replies in threads started before the
  downtime are read for up to two threads a channel. Edits and deletes made
  meanwhile are not read. Covered by tests against a faked Slack API only. See
  [Slack](./packages/muster/docs/02-sync/04-slack.md#after-downtime).
- The daemon stops crash-looping. If `mu daemon run` starts five times in ten
  minutes and none of those runs stayed up two minutes, the fifth start writes
  why to its log and stays up doing nothing, so launchd (or systemd) has
  nothing to restart. An hour later it tries again as a first start.
  `mu daemon status` shows it, `mu daemon check` says `daemon_stopped`, and
  `mu daemon reset` clears it so it starts now. Installing again clears it
  too. A clean stop never counts, a run that stays up clears the count, and a
  board at a URL that can't be reached yet is waited for, not counted.
- A watcher whose command keeps failing is slowed. After more failures in a
  row than one event is tried, each failure doubles the wait before its next
  run, up to ten minutes, and the daemon logs `slowed`. One run that works
  puts it back to `every`.

- `mu run --runner cloudflare --push`. The run is waited on. Once the agent
  exits, the Worker closes every host the run opened and stops what the agent
  left running. `mu run` then reads the agent's changes out as a git bundle,
  pushes them from this machine to `mu/task-<id>` and opens the pull request,
  as it does on Vercel. The GitHub write token never reaches the Worker or the
  container. The runner Worker gains a run's status and routes to close a run,
  run a command in it and read a file from it. The last two work only once the
  agent has exited and the run is closed. Redeploy
  `templates/cloudflare-runner` to use it.

- `mu run --ready <channel> --loop --runner cloudflare` is a worker on this
  machine, as on Vercel: it claims each ready task under a claim token made
  for it and starts a container of its own for that task. It waits for each
  run and stops it once the agent exits, so the Worker keeps none for its 15
  minutes. With `--push` each task gets its own pull request. `--ready`
  without `--loop` is still one container for every task, and can't `--push`.
  A registered workflow's `workers.runner` can be `cloudflare`, with `push`
  too; the workers read `MUSTER_CF_WORKER` and `MUSTER_CF_SECRET` from the
  daemon's environment. Both are covered by tests against a stand-in Worker
  only, not run live.

- `mu inbox` lists what is for you since you last asked: a message that
  mentions you, a task assigned to you, and a reply in a thread you wrote in,
  one line each, saying which. Your own writes aren't in it, except a reminder
  you scheduled. It keeps its place per profile; `--peek` reads without moving
  it, `--wait` blocks until something arrives, and `--json` prints one
  document. Deleted messages are left out, and an edit doesn't count as a new
  mention.
- `mu wait --for <profile>` and `mu tail --for <profile>` use the same filter,
  and a watcher can listen with `"tail": { "for": "<profile>" }` to wake an
  agent for what is its own. `mu daemon check` works for such a watcher.
  In code, `events` takes `filter.for`, and each event it returns says why.

- Registered workflows: you name a plan of tasks and a crew of workers once,
  in `~/.config/muster/workflows.json`, and someone you allow starts it on a
  thread with `mu workflow run <name> --on <id>`, with up to 10 `--arg k=v`
  pairs that fill the tasks' text. The daemon, or `mu serve`, makes the tasks,
  starts the workers, replies on the thread, and says how the run ended.
  Nothing written on a board can start one, and sandboxed agents can't ask.
  From code, `loadWorkflows`, `workflowsPath` and the `Workflow`,
  `WorkflowStep` and `Workers` types are exported from `muster`.
  See [Workflows](./packages/muster/docs/01-concepts/16-workflows.md).
- `--by <actor id>` on `mu tasks claim --ready` and `mu run --ready` (and
  `by` on `taskClaim`) takes only tasks that one actor created, profile and
  all. A workflow's workers use it to take only the daemon's own tasks.
- A CI job can sign in to a served board with the OIDC token its platform
  gives it, so there is no board token to store and rotate. The owner names
  the workloads in `~/.config/muster/oidc.json`: the issuer, an audience, the
  token's `sub` (exactly, or a prefix ending in `*` after a `:` or `/`), and
  the profile and channels the job gets. `mu token exchange` trades the
  platform's token for a board token that lives 15 minutes unless the trust
  says otherwise, an hour at most. Off unless that file names a workload.

### Security

Affects every release up to 0.2.0, wherever it has the part named. The first
three matter to anyone whose board or runner is reached over a network; the
rest to anyone who shares a machine, or whose server's output is kept.

- `mu` sent `MUSTER_TOKEN` over plain http to any host, and `mu join` took a
  new token back the same way. A token now goes over https, or to this
  machine, and a redirect is never followed with one (`insecure_url`). On a
  network that is private some other way, such as a tailnet, set
  `MUSTER_INSECURE_HTTP=1` on the machines that reach the board. The same
  holds for `http()` in code, which takes `insecure: true`.
- `mu run --runner cloudflare` sent the board token, the model's key and the
  repository's credential to whatever `MUSTER_CF_WORKER` named, over plain
  http if it said so, and followed redirects with them. It now needs https
  (or this machine) and follows none.
- `mu serve` printed a token that opens the whole board for 30 days on every
  start, wherever its output went. It now prints one only to a terminal. With
  the output piped or kept, none is made: use `mu token create`, or pass
  `--print-token` to have it printed anyway. **A script that reads the token
  from `mu serve`'s output needs `--print-token`.** If your server's logs
  hold one from before, `mu token list` shows it and `mu token revoke` stops
  it.
- The swarm and factory templates answered any request that reached them,
  whatever name it came for, so a page on another site could reach the
  launcher through your browser and start agents. They now answer only for
  this machine, or a name in `ALLOW_HOSTS`.
- An agent's run log, the board's file and a backup were readable by other
  users of the machine unless the folder above them said otherwise. They are
  now yours alone to read, wherever they are, and run logs older than 30 days
  are removed when a run starts.
- An error that wasn't the board's own answer reached the caller of a served
  board, and the inspector's page, with whatever it named: paths and the
  user's name. It is now in the board's output, and the caller is told only
  that the board failed. A workflow's reply on a thread says an error's code
  and not its text, since a reply is synced.
- A signed Linear webhook sent again under a new delivery ID was taken as
  new, and could set a thread's state back. A delivery is now known by what
  Linear signed.
- The board kept every imported webhook's content a second time, for good.
  It now keeps only that it took the delivery; what older versions kept is
  emptied when the board next imports.
- `mu run` started an agent without the opt-outs you had set for it
  (`DO_NOT_TRACK`, Claude Code's `DISABLE_TELEMETRY` and the like). They are
  passed on.
- The Cloudflare runner template logged the last 2000 bytes each run printed
  to the Worker's logs. It now logs why the run ended and its exit code;
  `LOG_TAIL` set to `"1"` brings the tail back. Redeploy the template.
- The runner template's image checks the release tarball against its
  checksum, both images are built on a base named by its digest, and the
  docs deploy no longer writes a preview's address into a script.

### Changed

- `mu token create` no longer makes a token that reaches every channel when
  `--can` is left out. Name the channels with `--can`, or pass `--all` for a
  token with your full access, as before; the two together are refused.
  **A script that runs `mu token create` with no `--can` needs `--all`.**
  `mu token list` shows such a token as `everything`. The token `mu serve`
  prints is unchanged.
- `mu tasks claim <id>`, `mu tasks run <id>` and `mu run <id>` refuse `--by`
  (`invalid_by`). It only narrows `--ready`, and was ignored with an ID.

- The board's file is at store version 7 (it notes deliveries waiting on a
  platform). A board made by an older muster is upgraded when opened, and
  can't then be opened by an older one. Back it up first with `mu backup`.

### Fixed

- `mu run --ready` on Cloudflare, or on Vercel without `--loop`, left
  `--label`, `--from` and `--by` out of the `mu run` it started in the
  sandbox, so the worker there took tasks they would have kept it from, and
  none of the owners `--from` named. They are now passed on.
- A workflow whose workers had started, and whose start then failed or was
  given up on, was answered `couldn't start` on its thread. It now says the
  workers started and that the run couldn't be confirmed.
- A `for` filter of `+<profile>`, an actor ID with nobody before the `+`,
  was taken and matched nothing. It is refused as `invalid_profile`.
- `mu run --ready <channel> --loop --runner cloudflare` started a new
  container each time the last one returned, which was at once, so it kept
  starting them until the board refused to make more tokens. It is now a
  worker with one container per task.
- A `mu run --ready --loop --push` worker with no `--repo`, a repository
  not on github.com, or no GitHub App set claimed each ready task and then
  failed it. It is now refused before it claims anything, on Vercel and on
  Cloudflare.
- A cloud worker (`--ready --loop`) whose run didn't start, or ended without
  saying how, left the task claimed and the agent's token live, and went on
  to claim the next. It now gives the claim back and revokes the token. It
  stops at once when the runner refuses the start (a wrong
  `MUSTER_CF_SECRET`, say) or the start's outcome is unknown, and after three
  failures in a row otherwise. Ctrl-C gives the claim back too, and a Ctrl-C
  right after a claim starts nothing. A run whose status never comes back is
  given up at its deadline. A Vercel SDK too old to be waited on stops the
  worker (`runner_too_old`) instead of starting a sandbox per ready task.
- A registered workflow with cloud workers checks the daemon's environment
  first, and says on the thread what is missing, such as `MUSTER_CF_SECRET`,
  instead of starting workers that exit at once.
- A catch-up that failed, for GitHub or Linear, no longer loses its place.
  The next start asked from the last event received, so a webhook that came
  in after the failure moved it past what was missed. It now asks again from
  where the failed one started. A webhook that arrives after a restart but
  before the first catch-up no longer moves it either.
- GitHub's catch-up put a close or merge it read down to whoever opened the
  issue. It is now put down to the sync (`gh`): GitHub's list doesn't say
  who did it.
- GitHub's catch-up read at most 100 issues and 100 comments per repository,
  and what was past that was never read. It now reads up to ten pages of
  each, oldest change first, and the next start goes on from where it
  stopped.
- Catch-up runs on every tick until a read gets to the end, not once per
  process. A `mu serve` restarted while the daemon kept running is now caught
  up on the daemon's next tick. A refused read waits five minutes, a deadline
  stored on the board. A read cut short goes on a minute later.
- Catch-up starts five minutes before the last event received, for a
  platform's clock that is behind the board's.
- A state read on catching up no longer replaces a newer one that a webhook
  brought while the read was out.
- More changes at one moment than a catch-up can read no longer stall it.
  It goes past that moment, and the daemon logs what may have been skipped.
- GitHub's catch-up asks for each page from the newest change read, so an
  issue changed during the read isn't skipped. An answer that isn't a list
  counts as a refusal.
- A watcher with no `as` profile was woken by its own note that it gave up on
  a thread, and so tried the same failing command five more times, then wrote
  another note, for ever. Its own notes no longer wake it.
- A daemon whose board couldn't be read logged the same error every second.
  It now logs it once and then at 2, 4, 8 failed ticks in a row, and waits up
  to 30 seconds between tries.
- `mu run` on this machine refused nothing of what is only for a sandbox:
  `--push`, `--repo`, `--detach` and `--no-install` were silently ignored.
  They are now refused before any agent starts.
- The Cloudflare runner template now runs. It was written from documentation
  and had never been deployed. On its first deploy:
  - its container stopped as soon as the Worker went idle;
  - its image had nothing to keep it running;
  - HTTPS through its gates failed because nothing trusted Cloudflare's
    certificate;
  - `--repo` couldn't be cloned, and a private repository's token never
    reached it;
  - a failed setup step went unnoticed;
  - its container got Cloudflare's default size, `lite` (256 MiB), in which
    Claude Code and `mu` ran out of memory and stalled without failing.

  It now has a `wrangler.jsonc`. The Worker owns each run until it ends,
  clones through a gate that is closed again before the agent starts, and
  removes the container when the agent exits or the run's time is up. Each
  run gets a `standard-1` container; `INSTANCE` in `wrangler.jsonc` changes it.

- Sync: what the board sent to a platform, a reply or a new thread, could
  come back as a second copy when the platform's webhook for it arrived
  before its answer to the board did. With no `bot` set, as with a Linear
  personal API key, nothing else stopped it. Webhooks for a platform now wait
  while a delivery to it is out, also when `mu daemon` delivers and `mu serve`
  takes the webhooks, and are imported as soon as it is recorded. A platform
  that doesn't answer within 30 seconds counts as a failed try.
- Linear sync: an OAuth access token is now sent as a bearer token, as Linear
  requires; before, only a personal API key worked. The Linear page says when
  to set `bot`: not with a personal API key, whose user is you.

## 0.2.0

The first release since 0.1.2 that the install line gives: everything that
went out in the 0.2.0-alpha.1 and 0.2.0-alpha.2 pre-releases, and what is
listed here. From now on there is one line of releases, and no 0.1.x: the
older releases have been removed, because every one of them has the faults
under Security below.

### Security

Affects 0.1.0 to 0.2.0-alpha.2, for anyone who serves a board with
`mu serve`. A board used as a file on your own machine is not affected,
except by the inspector and the swarm template, which are marked.

- A token held to `read` could delete messages, cancel schedules, and
  cancel, assign, unblock and reopen tasks. Every token speaks for the board's owner, and those
  changes asked only whose a thing was: a read-only token held to no profile,
  such as `--can '*=read'`, could change anything in the channels it read,
  and one held to a profile could change that profile's own. They now take
  `post`.
- A token held to channels could move the cursors the daemon keeps its place
  under (`watch:`, `hook:`, `sync:`). A cursor only moves forward, so that
  silenced a watcher for good, and would have done the same to an outgoing
  webhook, which no release has yet. It is now refused.
- The schedule list showed a schedule in a private channel, text included,
  to a token that held only the subtree above it.
- The feed still carried what a deleted message said: `mu tail --last`,
  `mu wait`, the HTTP feed and an outgoing webhook returned the original
  text, labels and files. They are now empty in every event of a deleted
  message, and a filter can't match on them. The board's file and its
  backups still hold the words: the log is never rewritten.
- 0.2.0-alpha.1 and alpha.2, where tokens can be revoked: the token
  `mu serve` prints had no ID, so it was in no list and could not be. It is now made like any other token. One printed by an earlier
  version works until its 30 days are up; deleting the board's key stops it
  sooner, along with every other token.
- 0.2.0-alpha.1 and alpha.2: a schedule went on posting after its token was
  revoked. In every version a token held to channels could make any number
  of schedules. A schedule is now
  canceled when it comes due after its token was revoked, a revoked token
  stays on record so that still holds later, and a token held to channels
  has 20 schedules going at most.
- A typed block reached `blocks` unchecked two ways: in a schedule's text,
  and in text a synced platform sent, such as an issue's body. A schedule is
  now checked when it is made, and `blocks` holds only what follows a schema
  the board has.
- The inspector (file boards too): its page carried the token that lets it
  act as you, and served that page to anything on the machine that asked,
  another user included. The token is now only in the link `mu inspect`
  prints, after the `#`.
- The swarm template (file boards too): the launcher started whatever
  command a request named as its agent. It now starts claude or codex only,
  and both templates' `pnpm dev` listens on 127.0.0.1.
- The Cloudflare runner template accepted `Bearer undefined` when deployed
  with no secret, and would then start a container for anyone. It now starts
  nothing until a secret of 16 characters or more is set.
- `mu download` wrote over a file of the same name in the folder it saved
  to. It now refuses (`exists`).
- The LaunchAgent file `mu daemon install --env` writes holds secrets and was
  left readable to whoever could reach the folder. It is now 0600.
- A GitHub delivery was known by a header GitHub doesn't sign, so a kept
  webhook sent again under a new ID could set a thread's labels back. It is
  now known by its signed body.
- Releases: every GitHub Action is pinned to a commit, the release jobs hold
  only the permission each needs, and a checkout no longer leaves the job's
  token where the install and the tests could read it.
- `mu serve` read up to 36 MB of a webhook's body before checking who sent
  it, with no token asked. A webhook body is now at most 1 MB.
- A file's name and type on a message, and the labels one change unsets,
  had no size limit, so a token that may post could store far more than a
  message's 10,000 characters. They are now held to 255 characters and 64
  labels.
- A `limit` below 1, or not a whole number, on the feed or a task list
  removed the 1,000 ceiling on what one read returns. It is now refused as
  `invalid_limit`.
- A live feed checked its token only when it opened. It now ends when the
  token is revoked or runs out.
- A narrowed token held to no profile got a new 100 MB file allowance for
  each profile name it asked to write as. The allowance is now counted
  against the token.

### Added

- Outgoing webhooks: the daemon and `mu serve` send a signed HTTP request to
  a URL of yours for each event a filter matches. They are set in
  `~/.config/muster/hooks.json`, never on a board, and the signing secret is
  named there and read from the environment. A delivery carries a pointer to
  the event unless the hook asks for the whole event. Every event is sent at
  least once and in order, with retries; redirects are not followed, and
  plain `http` is refused except to this machine.
- `mu daemon check <hook>` sends a signed ping to an outgoing webhook and
  prints what the receiver answered. `mu daemon status` lists hooks.
- `mu tasks --latest` and `taskList({ latest: true })` list the last active
  tasks, by the newest message in each thread, the latest last. A list is
  the first made first and holds at most 1,000, so on a long-lived board
  the newest were the ones left out.
- `mu read <channel> --mentions <who>` and `readChannel({ mentions })` list
  the threads where someone was mentioned, in the first message or any
  reply. Before, only `wait` and `tail` took `--mentions`, so a mention
  written before an agent started was found only by replaying events.
- `mu <command> --help` and `mu help <command>` print that command's own
  lines and what every command takes, where they printed the whole help.
  `mu tasks claim --help` prints one form of a command.
- A claim can carry a token its caller chose: `MUSTER_CLAIM_TOKEN` for the
  CLI, `taskClaim({ id, token })` from code. A run that keeps nothing
  between its processes (a serverless host, a CI job that retries elsewhere)
  derives the same secret in each, and claims, renews and settles under it.
  Claiming a task by ID that is already held under the token answers that
  claim.
- The board skill lists the limits the board enforces, with what to do at
  each, and has a page each for Claude Code and Codex that maps the
  runtime's own tools for other agents onto `mu` commands.
- The factory guide shows how to route by label: one watcher's agent sorts
  each question with a label, and a watcher per label wakes the agent that
  answers it. Nothing in muster changed; the guide's watchers are tested.

### Changed

- The guides say what a usage limit leaves behind: the task is `failed`, and
  `mu tasks reopen` readies it again.
- A claim's token settles a task only for the caller that holds the claim,
  the same principal and profile. Before, the token alone was enough for
  anyone who could reach the task. The CLI already kept a token per holder,
  so nothing that used it changes.

### Fixed

- A thread started on the board that opened a GitHub or Linear issue now
  gets the labels an issue that came in has: `kind`, `ref`, `state` and
  `source`. Before, it had none until the issue changed state, so
  `--label kind=issue` missed it and nothing said which issue it became.
  Found on the first run against a live GitHub repository.
- An issue opened on GitHub while the board was down arrived with no title,
  body or labels: its first comment became the thread's opening message and
  a reply as well. Catch-up now reads issues and pull requests before their
  comments, and a comment or review on an issue the board never saw starts
  the thread from the issue. A close or merge missed while down now sets
  `state`. Found on the same live run.

- A plan whose `needs` were written as bare keys or IDs (`"needs": ["wal"]`
  or `[12]`) ended in an internal error, a 500 from a served board. Both are
  now taken: a bare string is a key when the plan has that key, and otherwise
  a task's ID. A need that is neither, or a task that isn't an object or has
  no text, is refused as `invalid_plan` with the task's key and what a need
  looks like, before anything is written.

- Renewing, releasing, completing or failing a task with no claim held said
  "You no longer hold task N" and to stop, whatever state the task was in.
  It now says where the task stands: `task_ready` with the claim to run
  first, `task_blocked` with the kind of hold, `task_waiting`
  with what it waits for, or `task_finished`. `claim_lost` still means what
  it did for a claim that was held, and for a task someone else holds.
- `mu <unknown> --help` and `mu help <unknown>` printed the whole help and
  exited 0. They now fail as the bare command does, exit 2, and an unknown
  command names the one that was likely meant: `mu claim` says
  `mu tasks claim`, `mu serach` says `mu search`.
- `--help` and `--json` after `--` were taken as `mu`'s own, so
  `mu tasks run 5 -- npm test --help` printed muster's help and ran nothing.
  What follows `--` is now left to the command.
- `mu tasks create <channel> --file task.md` reads a plan of tasks, where
  `post` and `reply` read their text from `--file`. A file that isn't JSON
  now names the command that makes one task of it: the same one, with `-`
  as the text and the file on stdin, its options kept.
- `--label`, `--needs`, `--for`, `--claim` and `--no-sync` given with a plan
  file were dropped without a word. They are refused: a plan's tasks carry
  their own.
- The inspector and the swarm template's live view asked for the first
  1,000 tasks, so past that many they stopped showing new ones. They now ask
  for every open task and the last active of any state.
- `mu read <id>` ignored `--text`, `--before`, `--limit` and `--cursor`,
  which are for a channel's threads. It refuses them and says so.

## 0.2.0-alpha.2

A pre-release: it never becomes "latest". Install it by its own address, or
run its image, `ghcr.io/openmuster/muster:0.2.0-alpha.2`. It moves a board's
file to store version 6, which older versions can't open: run `mu backup`
first.

### Added

- A `Dockerfile` that runs `mu serve` with the board, its files, its key and
  its config on one volume, and a guide to running a board on a server.
  Releases publish the image to GitHub's container registry.
- `mu serve --host` listens beyond this machine, and refuses to without
  `--allow-host`. `--no-token` prints no token. `MUSTER_HOST` and
  `MUSTER_ALLOW_HOSTS` do the same from the environment.
- `GET /api/board/health` answers with no token, for health checks.
- An agent can ask to join a served board: `mu join <url> --as <name>`
  prints a code and waits; the owner runs `mu join approve <code> --can ...`
  and the agent gets a token held to that name and those channels. Off
  unless the board is served with `--allow-joins`.
- `mu daemon check <watcher>` writes a message the watcher listens for and
  waits for a reply, so you know the daemon, the filter, the gate and what
  the command wakes all work. It says when nothing is running the watchers,
  when the command keeps failing, and when nothing answered.
- `mu serve` answers MCP over HTTP at `/api/board/mcp`, so an agent on
  another machine or in a chat app can use the board with a token and no
  install. The tool does what the token may do, through the same checks as
  any client.

### Changed

- `mu backup` copies the board's files beside the database copy, so a
  backup's attachments open.
- The board's file is at store version 6 (it keeps requests to join). A
  board made by an older muster is upgraded when opened, and can't then be
  opened by an older one. Back it up first with `mu backup`.

### Fixed

- `mu help` lists flags that worked but were left out: `--type` on `wait` and
  `tail`, `--allow-host` on `serve`, and `--label`, `--from`, `--wait`,
  `--lease` and `--resume` on `run`.

## 0.2.0-alpha.1

A pre-release: it never becomes "latest". Install it by its own address.
What it adds for cloud sandbox runs has passed its tests against stand-ins for
the platforms and has not yet been run in a real sandbox.

### Added

- A cloud run is looked after the way a local one is: `mu run` itself runs in
  the sandbox, so the claim is renewed during long work, a task the agent
  leaves open is failed, and the session, tokens and cost are recorded.
- `mu token list` and `mu token revoke <id>`: the board keeps a list of the
  tokens it made, and can stop one.
- A cloud run names its agent with `--as` and gets a token made for that run:
  one profile, the task's channel, short-lived, and marked so what the agent
  writes is never mirrored to a synced platform. `--no-sync` on
  `mu token create` does the same for a token you make.
- `mu mcp`: the board as one tool for an agent that can't run shell commands,
  over MCP. It takes the arguments `mu` takes and gives no shell and no way
  to the machine's files.
- The docs have a Concepts section with diagrams, a quickstart that ends with
  an agent doing a task, and guides whose steps a test runs.

### Changed

- The board's file is at store version 5 (it keeps the list of tokens). A
  board made by an older muster is upgraded when opened, and can't then be
  opened by an older muster. Back it up first with `mu backup`.
- `mu token create --sub` is gone.

## 0.1.2

### Security

Affects 0.1.0 and 0.1.1, for anyone who started an agent in a cloud sandbox
(`mu run --runner vercel|cloudflare`). Local use is not affected.

- A cloud run with no `MUSTER_AGENT_TOKEN` handed the sandbox your own token.
  It now refuses to start, and refuses an agent token that isn't held to a
  profile and to named channels.
- On Vercel, the hosts opened to install muster stayed open to the agent, and
  the model provider's host took any request with your key added. Both are
  closed: the install hosts before the agent starts, and the model's host to
  everything but the calls that ask the model.
- A Vercel sandbox was kept after its run, with the repository and the
  credentials' policy in it. It is now removed.
- Credentials are sent only to the host they are for, whatever Host header the
  sandbox writes.
- A sandbox can no longer move a stored cursor, and reaches a named list of
  board routes instead of everything not excluded.
- Storing a file needs a token that may post; a narrowed token has a daily
  allowance. A process ID sent over HTTP is ignored.
- `--repo` refuses an address with a credential in it.

These changes to the Vercel runner pass their tests against a stand-in for the
platform, and have not yet been run in a real sandbox since they were made.
If a cloud run that worked on 0.1.1 fails on 0.1.2, please open an issue.

Still open: an agent can't read the model's key, but can use it to make the
provider fetch a URL. Use a key made for sandboxes, with a spend limit and
the provider's web tools off. See the sandbox guide.

### Fixed

- The stated minimum Node was wrong. muster needs Node 22.22.3 or later on the
  22 line, or 24.15 or later; older ones bundle a SQLite it refuses to run on,
  and failed on the first command.
- The licence file named the wrong copyright holder.
- On Node 22, every command printed a warning about SQLite on stderr, which
  broke `--json` for a program reading it.

### Added

- `SECURITY.md`: how to report a vulnerability, and what muster talks to.
- Releases carry a `SHA256SUMS` file, and their notes come from this file.

## 0.1.1

- The Vercel sandbox runner works against the real SDK: the network policy is
  in the shape it takes, the sandbox starts from an image that has the agents'
  CLIs, and the model's key is added to requests outside the sandbox.
- In a cloud sandbox the agent runs without its own permission prompts;
  `--safe` keeps them on.
- The quickstart named the wrong task ID.

## 0.1.0

- First release: the board, its CLI, the daemon, served mode, sync, runners,
  the inspector and the templates.
