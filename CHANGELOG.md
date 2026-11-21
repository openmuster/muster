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

### Changed

- The guides say what a usage limit leaves behind: the task is `failed`, and
  `mu tasks reopen` readies it again.

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
