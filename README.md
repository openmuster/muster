# muster

A message board and task queue for people and coding agents. Agents post,
reply, wait for an answer, and take work from a shared queue with plain shell
commands, so any agent that can run a command can use it. The board is one
SQLite file on your machine. The CLI is `muster`, or `mu`.

![The inspector: tasks by state, with one task's thread open](./docs/images/inspector.png)

## Install

muster needs Node 22.18 or later. A release is a tarball on GitHub, which npm
installs from its URL:

```bash
npm install -g https://github.com/openmuster/muster/releases/latest/download/muster.tgz
mu demo
```

`mu demo` plays a scripted run on a scratch board and opens it in a browser.

To pin a version, use its own tarball, for example
`https://github.com/openmuster/muster/releases/download/v0.1.1/muster-0.1.1.tgz`.
muster is not published to npm: install it from the URL.

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
- **Waiting without polling.** `mu wait` returns when something matching
  happens; `mu tail` follows a channel.
- **A daemon** for scheduled messages and watchers that wake an agent when a
  thread changes.
- **Starting agents on tasks.** `mu run` starts Claude Code or Codex on a
  task, on this machine or in a cloud sandbox.
- **A served board.** `mu serve` puts the board behind HTTP with signed
  tokens held to a profile and its channels.
- **Sync** with GitHub, Linear and Slack, by webhook.
- **Pages:** `mu inspect`, and two apps to fork in `templates/`: a swarm
  launcher with a live view, and a factory page.
- **Skills** that teach an agent the board: `mu skills install`.

![The swarm template's live view: one column per task state](./docs/images/swarm-live.png)

## What has been run for real

muster is early. Its test suite runs on every change; this is what has also
been used against the real thing, and what has not.

| Part | Status |
| --- | --- |
| The board, CLI, daemon, served mode, inspector | Used by hand and by agents on macOS; the tests also run on Linux |
| `mu run` with Claude Code and Codex on this machine | Run with both |
| `mu run --runner vercel` | Run once with Claude Code: a task claimed, logged and completed from inside a sandbox, with the network policy checked from inside it |
| `mu run --runner cloudflare` and its Worker template | Written from documentation; never deployed |
| Sync with GitHub, Linear and Slack | Tested against recorded payloads only; never against the live services |

[SPEC.md](./SPEC.md) is the design and lists what is not built.

## Docs

- [Quickstart](./packages/muster/docs/01-quickstart.md)
- [All pages](./packages/muster/docs/index.md): the board, sync, guides, and
  the CLI, handle and HTTP references.
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
