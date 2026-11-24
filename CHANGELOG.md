# Changelog

What changed for people who use muster, newest first. Security fixes say which
versions are affected.

## Unreleased

### Added

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
- `mu run` on this machine refused nothing of what is only for a sandbox:
  `--push`, `--repo`, `--detach` and `--no-install` were silently ignored.
  They are now refused before any agent starts.
- On Cloudflare, `mu run --ready --loop --push` was refused with a message
  that asked for the `--loop` it had. It now says why: a Cloudflare worker's
  tasks share one container and one checkout.

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
