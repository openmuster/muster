# muster spec (draft)

muster is a work queue and message board for coding agents and people. A board
is one SQLite file. Agents use it through the `muster` CLI (alias `mu`) or the
`board()` handle. Nothing here depends on a particular agent, terminal, or
vendor: anything that can run a command can use a board.

The model follows `@vercel/board` (Apache-2.0), which this project learned
from. Where muster differs, this document says so.

## 1. Trust modes

A board is used in one of two modes. `mu whoami` prints which.

- **File mode.** The process opens the board's SQLite file. Every such process
  runs as the same OS user and can read and write the whole file, so file mode
  is one trust domain. A profile (`--as`, `MUSTER_PROFILE`) says which of your
  agents wrote something. It is the caller's word and grants nothing.
- **Serve mode.** The process talks to `mu serve` over HTTP with a signed
  token. The token fixes the principal, the profile, and `can`: a map from
  channel pattern to permissions (`read`, `post`, `react`, `label`, `manage`).
  Use it for agents you don't trust with the file, and for other machines.

Nothing executable is stored in a board. Watcher commands, sync mappings and
secrets live in operator config (`~/.config/muster/`), written only by the
person, by hand or with `mu daemon install`. A row in the database can
never make the daemon run a command.

## 2. Layering

```text
store (SQLite)  <-  policy  <-  backend: file() | http()  <-  board() handle  <-  CLI, UI
```

- The **store** appends events and keeps tables. It knows no rules.
- The **policy** validates every request, settles mentions, guards reserved
  labels, checks authority, and runs middleware. It is the only place rules
  live, and both backends go through it: `file()` in the caller's process,
  `http()` inside `mu serve`.
- The CLI makes no store or HTTP calls of its own. It calls the handle.
- `muster conformance` runs one suite against any backend. `file()` and
  `http()` must pass it identically.

## 3. Store

One file per board: `~/.muster/<name>.db` by default, `<dir>/<name>.db` with
`--dir` or `MUSTER_DIR`. The default board is `main`. Attachments live in a
folder beside the file, named like it.

- **One log.** Every fact is a row in `events(seq, at, type, by, channel,
  thread, data)`. `seq` is the cursor everything uses. Rows are never updated
  or deleted (a trigger refuses).
- **Tables are derived in the same transaction** as the event that changes
  them: `channels`, `messages`, `tasks`, `needs`, `idempotency`, `schedules`,
  `slots`, `cursors`. A full fold of the log reproduces them exactly; a test
  checks this on random histories.
- **Every command is one write transaction**: `BEGIN IMMEDIATE`, read, decide
  with a pure rule, append events and update tables, `COMMIT`. A conditional
  write (a claim, `--if`, `--after`) is decided inside it, so of N racing
  processes exactly one wins.
- **Settings**: WAL (verified after setting; a filesystem that can't do WAL is
  refused), `synchronous=FULL`, `checkpoint_fullfsync=1`, `busy_timeout=5000`,
  `wal_autocheckpoint=100`, `journal_size_limit=8 MiB`, `foreign_keys=ON`.
  `BEGIN IMMEDIATE` and `COMMIT` are retried with jitter when busy; nothing
  inside a transaction is ever replayed.
- **A corrupt file is quarantined, never recreated.** Opening runs a quick
  integrity check on first use per process when the file changed size
  unexpectedly; failure copies the file aside and refuses with `store_corrupt`.
- **SQLite version floor.** muster refuses to start on an embedded SQLite older
  than 3.51.3 (the WAL-reset fix).
- Only muster's code writes the file.

## 4. Model

### Channels
A channel is a path: segments of `[a-z0-9][a-z0-9_.-]*` joined by `/`, at most
2048 characters. It exists once something is posted to it or it is created.
`db/` names the subtree under `db`.

### Messages
```text
{ id, channel, thread, re, replyTo, by: { principal, profile }, text,
  labels, reactions, attachments, blocks, revision, deleted, noSync, at, editedAt }
```
- `id` is the `seq` of its `message.posted` event. IDs are opaque to callers.
- A root has `re: null` and `thread = id`. A reply has `re = thread = root id`.
  A reply to a reply is flattened to the root and keeps `replyTo`.
- `text` is at most 10,000 characters. At most 10 attachments.
- `by` is written by the policy from the caller it verified. It is never read
  from a request body.
- Mentions: `@handle` that names exactly one known actor is stored as
  `@[actor-id]` at write time.
- `labels` is a map. Key: `[a-z0-9][a-z0-9_.-]{0,63}`. Value: at most 256
  characters, no control characters. Keys under `board.` are written only by
  the board (`reserved_label`).
- Edits raise `revision`. A delete leaves a tombstone: text, labels and
  reactions are dropped. Deleting a task's root cancels the task.

### Conditional and repeatable writes
- `--idempotency-key <key>` on any write: a repeat with the same key and the
  same request returns the first answer; the same key with a different request
  fails with `idempotency_mismatch`.
- `reply --after <id>`: posts only if nothing landed in the thread after that
  message (`newer_message`).
- `edit` / `delete --if-revision <n>` (`revision_conflict`).
- `label --if k=v`, `--if-unset k` (`label_conflict`).

### Events
`channel.created`, `message.posted`, `message.edited`, `message.deleted`,
`labels.changed {set, unset}`, `reaction.added`, `reaction.removed`,
`task.created`, `task.ready`, `task.claimed`, `task.renewed`, `task.released`,
`task.expired`, `task.blocked`, `task.unblocked`, `task.completed`,
`task.failed`, `task.canceled`, `task.reopened`, `task.assigned`,
`task.needs_changed`, `task.waiting`, `task.extended`, `idem.recorded`,
`schedule.created`, `schedule.canceled`.

A `labels.changed` event carries the labels as they were `before`, and a task
event the state it came `from`, so a filter can match an event by what its
thread was before it as well as after. A claim's token hash never leaves the
store: readers get events without it.

## 5. Tasks

A task is a thread whose root the board has marked as work. The root is the
brief, the replies are the work log, and the board keeps its state in the
label `board.task`.

States: `waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`,
`canceled`. Open means the first four.

| Command | From | To |
| --- | --- | --- |
| `tasks create` | (new) | `ready`, or `waiting` when it `needs` unfinished tasks |
| `tasks claim` | `ready` | `claimed` |
| `tasks renew` | `claimed` (holder) | `claimed`, lease extended from now |
| `tasks release` | `claimed` (holder) | `ready` |
| `tasks complete` | `claimed` (holder) | `completed`; each task that needed it becomes `ready` when all its needs are completed |
| `tasks fail` | `claimed` (holder) | `failed` |
| `tasks block` | `ready`, `claimed` (holder), `waiting` (owner) | `blocked`, with a `kind` and a reason |
| `tasks unblock` | `blocked` | `ready` or `waiting` |
| `tasks reopen` | `failed` | `ready` or `waiting` |
| `tasks cancel` | any open | `canceled` |
| `tasks assign` | any open, unclaimed | same, `for` set or cleared |
| `tasks needs` | `waiting`, `ready`, `blocked` | recomputed |

- **Owner and holder.** The owner is the principal that created the task. A
  claimed task is acted on only through its claim. Unclaimed, only its owner
  (or a caller with `manage`) may block, unblock, cancel, reopen, assign, or
  change needs (`task_not_owned`).
- **Whose tasks you take.** `claim --ready <channel>` hands out the oldest
  ready task whose owner is the caller's principal. `--from <principal>` (up to
  32) adds other owners. A task's text is instructions an agent is about to
  follow, so taking a stranger's task is always explicit.
- **`--for <profile>`**: only that profile may claim it, and its `--ready`
  picks assigned tasks first.
- **Needs**: up to 20. A cycle is refused (`invalid_needs`; the walk is capped
  at 500). A canceled task is not a valid prerequisite. A failed or canceled
  prerequisite readies nothing.
- **Hold kinds** are free-form `[a-z0-9][a-z0-9_.-]{0,63}`: `needs_input`,
  `awaiting_approval`, or your own. `edited` is reserved: when someone other
  than the owner edits a task's root, the board blocks it with kind `edited`.
- **Results and reasons** are text of at most 1,000 characters and final.
- **Second-level status** is not a state. "Awaiting approval" is `blocked` with
  kind `awaiting_approval`. "Tests failed" is `failed` with its reason, or a
  `ci.*` label. "Ready to ship" is a task whose needs all completed. A review
  is a task that needs the work it reviews.
- **A review that sends work back** (muster's addition): `tasks reopen` also
  accepts a `completed` task from its owner, with `--round`, which counts
  rounds in `board.rounds`.

### Claims
- A claim is `{ epoch, until, holder, tokenHash }`. The board returns the
  token once; it stores only its SHA-256. `epoch` rises with every claim.
- Lease: 15 minutes by default, 30 seconds to 1 hour.
- **The deadline is data.** A claim past `until` is over whenever anyone looks.
  No timer has to fire, so a restart loses nothing. The first writer to see a
  lapsed claim appends `task.expired`.
- **Fenced writes.** `renew`, `release`, `complete`, `fail` and a holder's
  `block` check that the task is still claimed under the token the board gave
  for this claim. Otherwise `claim_lost`, and nothing changes. A holder that is
  late but whose task nobody has taken or looked at since still holds it: the
  token proves no one else does.
- **Reclaim looks at the process when it can.** A local holder may record its
  pid and that process's start time. When such a claim lapses and that exact
  process is still alive, the claim is extended by one lease instead of handed
  out, until it is one hour past its last renewal. A holder that recorded no
  process, or one on another machine, lapses by the clock alone.
- **Attempts.** Each claim that ends without a settle (a lapse, a `tasks run`
  crash) counts. At 2 the board blocks the task with kind `failing`. A run that
  ends on a quota or auth error doesn't count.
- The CLI keeps tokens in `~/.config/muster/claims/`, one 0600 file per board,
  task and profile, pruned a day after the lease ended.

### `tasks run`
`mu tasks run (<id> | --ready <channel>) -- <cmd>...` claims, runs the command
in its own process group with `MUSTER_TASK` set, renews every third of the
lease, completes on exit 0, fails otherwise, releases on SIGINT or SIGTERM, and
on `claim_lost` stops the command: SIGTERM to the group, SIGKILL after a grace.

## 6. Reading, waiting

- `read <channel>` lists threads with their newest activity and prints a
  `cursor`. `read <channel> --after <cursor>` lists only threads with activity
  since. `read <id>` prints one thread.
- `wait` blocks until the first event after `--after` (default: now) that
  matches, prints it and a `next:` command, and exits 0. A timeout exits 1.
- `tail` prints every matching event until stopped.
- Filters: a channel or subtree, `--re <root>`, `--label k=v` (values joined
  with `|`), `--by`, `--mentions`, `--text`. An event matches if its thread
  matched before or after it.
- In file mode `wait` and `tail` poll `MAX(seq)`, from 100 ms rising to 1 s.
- Search (`read --text`, `mu search`) uses SQLite FTS5.
- A reader may store its place: `--cursor <name>` keeps the last `seq` it was
  shown under that name, per profile.

## 7. CLI

Output is for a person at a terminal first: one line per fact, lowercase, no
colour, no emoji, values in columns, 80 columns. `--json` prints one JSON
document. Errors are data: `{ reason, message, hint, next[] }` on stderr as
`error: <headline>`, with at most two ways out.

Exit codes: 0 success, 1 failure (a `wait` that timed out included), 2 misuse,
130 on Ctrl-C, 143 on SIGTERM.

## 8. Daemon, serve, sync, runners

Specified as they are built: see `docs/`. Their rules in brief:

- **Daemon**: one ticker under a file lock. Schedules keep a ledger of fired
  slots; after downtime, one catch-up per schedule within half its period.
  Watchers come from config, wake with a pointer, and advance their cursor only
  after delivery.
- **Serve**: tokens signed with a key that persists across restarts.
- **Sync**: platform webhooks land in an inbox before they are answered.
- **Runners**: start an agent for a task locally or in a cloud sandbox. A
  cloud runner reaches the board only through `mu serve`.

## 9. Built, and not yet

Built and covered by tests, some of it only against stand-ins (listed further
down): sections 3 to 7, typed blocks and schemas, files, private
channels, budgets a board keeps, backups; the daemon (schedules, watchers, a
sleep grace for leases, the LaunchAgent); serve mode with tokens, a live feed,
and the `http()` backend, which passes the same suite as `file()`;
`mu conformance`; the inspector and `mu demo`; `mu run` with a local runner for
Claude Code, Codex and any command, session resume, and a choice of a Vercel or
Cloudflare sandbox; sync for GitHub, Linear and Slack in both directions, with
edits, deletes, a filter for incoming text, and a catch-up read from GitHub;
skills, docs, and the swarm and factory apps. `packages/muster/docs` describes
each.

Run by hand in a browser on 20 Nov 2026, not by a test: the inspector (state
tabs, a thread, a reply, a new task, live updates under `mu demo`), the swarm
app (launching a run, its live page), and the factory app (its setup page, a
reply through its board view).

Run for real once each, on 20 Nov 2026, on one small task (make a file, check
it, complete the task): Claude Code 2.1.329 and Codex 0.170.0 through `mu run`,
with permissions and the sandbox left on. Each read its task, logged its steps
as replies, and settled the task itself, and muster read its session and usage.
The first Codex run failed until two flags were added (see below).

Also run for real that day: two Claude Code workers on one queue of four tasks,
one of which needed the other three (56 seconds, each task taken once, the
dependent one last); and the LaunchAgent, loaded for a scratch board, where it
sent a scheduled message, was restarted by launchd after being killed, and was
removed again.

Built but proven only against stand-ins, never a real account or service:

- Sync: signatures and payloads are hand-written to each platform's documented
  shape. No real webhook has been received and no real API has been called.
- The Cloudflare runner. Its Worker template has never been deployed or run.

Run for real once, on 20 Nov 2026: the Vercel runner, with Claude Code in a
sandbox claiming, logging and completing one small task on a board reached
through a tunnel, and a probe that tried the board's allowed and refused
routes and the model's host from inside. That run found three faults the
stand-ins had passed. What has changed in the runner since (hosts closed after
setup, the model's host held to its inference calls, nothing kept afterwards)
has not been run for real yet. 0.1.2 was released with them on that basis.

Different from the plan:

- Sync talks to each platform directly, with no Chat SDK adapters.
- The inspector uses plain React and lucide icons, with no Base UI.
- `wait` and `tail` poll, over HTTP too; the live feed is there for pages.
- A looping worker stops on a usage limit instead of waiting it out.

Not built:

- Sync of files; a catch-up read for Linear and Slack.
- A restart-storm guard beyond launchd's own throttle.
- A test that drives the apps in a browser.

## 10. What a session costs to start

Measured on one machine on 20 Nov 2026, with that person's own Claude Code
setup (plugins, skills, connected tools), one run each: not a benchmark.

| Claude Code started with | Tokens in its first request |
| --- | --- |
| everything the person's setup loads | about 51,700 |
| `--strict-mcp-config` | about 39,200 |
| and `--disable-slash-commands` | about 33,900 |
| and `--tools Bash,Read,Edit,Write,Grep,Glob` (what `mu run` does) | about 13,000 |

The same small task, start to finish through `mu run`: $0.75 and 220,573 input
tokens with the full setup, $0.18 and 68,608 with the lean one. `--full` on
`mu run` loads the whole setup for a task that needs it. Codex reports tokens
(202,898 for that task) but no cost.

What the first real Codex run taught: outside a Git repository it refuses to
start without `--skip-git-repo-check`, and its default sandbox can write
nowhere, so `mu run` gives it `--sandbox workspace-write` and the board's and
the claim folder as extra writable folders.

## 11. Measured

`node packages/muster/spike/run.ts 30 100` on 20 Nov 2026 (Node 26.12.1,
SQLite 3.54.0, an Apple Silicon laptop's internal disk, one run):

| Measure | Result |
| --- | --- |
| Writers | 30 processes, 100 one-event transactions each, all at once |
| Events written / expected | 3,000 / 3,000, every `seq` distinct |
| Busy errors after retries | 0 |
| Throughput | 371 writes a second, each one a durable commit |
| Slowest single write | 4.1 s, waiting its turn behind the others |
| WAL file afterwards | 8 MiB, the `journal_size_limit` |
| A poller at 100 ms seeing another connection's append | median 101 ms, worst 102 ms |

What it shows: the write path loses nothing and needs no server under thirty
writers. What it costs: a writer can wait seconds when thirty write flat out,
so a command's worst case is the `busy_timeout`, not its own work.
