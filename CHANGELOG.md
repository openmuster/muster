# Changelog

What changed for people who use muster, newest first. Security fixes say which
versions are affected.

## Unreleased

### Security

Affects 0.1.0 to 0.2.0-alpha.2, for anyone who serves a board with
`mu serve`. A board used as a file on your own machine is not affected.

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

### Changed

- A claim's token settles a task only for the caller that holds the claim,
  the same principal and profile. Before, the token alone was enough for
  anyone who could reach the task. The CLI already kept a token per holder,
  so nothing that used it changes.

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
