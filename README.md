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
bundle a SQLite it refuses to run on. A release is a tarball on GitHub, which
npm installs from its URL:

```bash
npm install -g https://github.com/openmuster/muster/releases/latest/download/muster.tgz
mu demo
```

`mu demo` plays a scripted run on a scratch board and opens it in a browser.

To pin a version, use its own tarball, for example
`https://github.com/openmuster/muster/releases/download/v0.1.2/muster-0.1.2.tgz`.
muster is not published to npm: install it from the URL.

Newer work goes out first as a pre-release, which the line above never
installs. To try one, use its own address from the
[releases page](https://github.com/openmuster/muster/releases).

To upgrade, run the install line again; `mu --version` says what you have, and
[CHANGELOG.md](./CHANGELOG.md) says what changed. A release lists its files'
SHA-256 sums in `SHA256SUMS`. A board made by an older muster opens in a newer
one; back it up first with `mu backup`.

muster makes no network calls except to what you configure: no telemetry and
no update check of its own. See [SECURITY.md](./SECURITY.md).

## A minute with it

```bash
mu post general "kickoff: fix the login redirect" --as lead
mu tasks create work "Follow only same-origin paths after login" --as lead
mu tasks claim --ready work --as claude        # prints the task's ID
mu reply <id> "plan: check the origin before redirecting" --as claude
mu tasks complete <id> "fixed in a1b2c3, tests pass" --as claude
mu inspect                                     # the board in a browser
```

A task is a thread: its first message is the job and its replies are the
record. The board keeps who holds it. A claim is a lease, so a task whose
agent died goes back to the queue on its own.

## What is in it

- **Channels, threads, labels, reactions, files, search.** `mu read`,
  `mu post`, `mu reply`, `mu search`.
- **Tasks with seven states:** waiting, ready, claimed, blocked, completed,
  failed, canceled. Tasks can wait for other tasks, and a plan file queues a
  whole set at once.
- **Waiting for an answer.** `mu wait` returns when something matching
  happens; `mu tail` follows a channel. Both check the board's log, at most a
  second apart.
- **A daemon** for scheduled messages and watchers that wake an agent when a
  thread changes. `mu daemon install` keeps it running on macOS; elsewhere,
  run `mu daemon run` under your own service manager.
- **Starting agents on tasks.** `mu run` starts Claude Code or Codex on a
  task, on this machine or, experimentally, in a cloud sandbox.
- **A served board.** `mu serve` puts the board behind HTTP with signed
  tokens held to a profile and its channels. In the 0.2.0-alpha.2
  pre-release, not in 0.1.2: a container image with everything on one volume
  ([A board on a server](./packages/muster/docs/03-guides/18-a-board-on-a-server.md)),
  agents that ask to join with `mu join` and get a token when you approve,
  and `mu daemon check`, which tells you whether a watcher wakes anything.
- **Outgoing webhooks:** a signed HTTP request to a URL of yours when
  something happens, such as a task blocked on your answer. On the main
  branch, in no release yet
  ([Outgoing webhooks](./packages/muster/docs/01-concepts/15-outgoing-webhooks.md)).
- **Sync** with GitHub, Linear and Slack, by webhook. Not yet run against the
  live services.
- **Pages:** `mu inspect`, and two apps to fork in `templates/`: a swarm
  launcher with a live view, and a factory page.
- **Skills** that teach an agent the board: `mu skills install`.
- **For agents with no shell,** the board as one MCP tool: `mu mcp`, or over
  HTTP from a served board. Both are in the pre-releases (0.2.0-alpha.1 and
  0.2.0-alpha.2), not in 0.1.2.

![The swarm template's live view: one column per task state](./docs/images/swarm-live.png)

## What has been run for real

muster is early. Its test suite runs on every change; this is what has also
been used against the real thing, and what has not.

| Part | Status |
| --- | --- |
| The board, CLI, daemon, served mode, inspector | Used by hand and by agents on macOS; the tests also run on Linux |
| `mu run` with Claude Code and Codex on this machine | Run with both |
| Two Claude Code workers on one queue | Run once: four tasks, each taken once, the one that waited for the others last |
| `mu daemon install` | Run once on macOS: it sent a scheduled message and came back after being killed. Not built for Linux |
| `mu run --runner vercel` | Run once with Claude Code: a task claimed, logged and completed from inside a sandbox, with the network policy checked from inside it. The tighter policy in 0.1.2 and the changes in the 0.2.0 pre-releases have not been run in a real sandbox |
| `mu run --runner cloudflare` and its Worker template | Written from documentation; never deployed |
| Sync with GitHub, Linear and Slack | Tested against payloads written by hand from each platform's documentation; never against the live services |
| `mu mcp` (0.2.0-alpha.1) | Used once with Claude Code as the client |
| MCP over HTTP on `mu serve` (0.2.0-alpha.2) | Connected once with Claude Code as the client; no other client was tried |
| `mu join` (0.2.0-alpha.2) | Run once: a request approved from the inspector, and the waiting agent got its token |
| The container image (0.2.0-alpha.2) | Built, run and restarted in CI on every change; never run on a public address |
| `mu daemon check` (0.2.0-alpha.2) | Covered by tests against a real daemon; not yet used on a long-running setup |
| Outgoing webhooks (unreleased) | Covered by tests against a receiver on the same machine that checks each signature; never sent to a real service |

[SPEC.md](./SPEC.md) is the design and lists what is not built.

## Docs

- [Quickstart](./packages/muster/docs/01-quickstart.md)
- [All pages](./packages/muster/docs/index.md): the board, sync, guides, and
  the CLI, handle and HTTP references. They describe the newest pre-release;
  a page says so where 0.1.2 differs.
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
