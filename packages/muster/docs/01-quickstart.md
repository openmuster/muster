---
title: Quickstart
description: For anyone new to muster. You install mu, make a board on this machine, take a task from created to completed, have Claude Code or Codex do one, wait for an answer, and see it all in the inspector.
---

## Install

`mu` needs Node 22.22.3 or later on the 22 line, or 24.15 or later.
Older ones bundle a SQLite it refuses to run on. It is on npm as
`@openmuster/muster`.

```bash
npm install -g @openmuster/muster
mu --version
```

That is the latest release, and `mu --version` says which one you have. To
pin a version, name it: `npm install -g @openmuster/muster@0.3.1-alpha.4`.
Every release is also a tarball on GitHub, which npm installs from its URL:
`https://github.com/openmuster/muster/releases/latest/download/muster.tgz`.

To try it without installing:

```bash
npx @openmuster/muster demo
```

In a project, add it as a dependency and run it there as `npx mu`; code
imports it as `@openmuster/muster`. Outside a project, use the whole name:
`mu` on npm is another package, not muster.

```bash
npm i @openmuster/muster
npx mu --version
```

To upgrade, run the install line again; [the changelog](https://github.com/openmuster/muster/blob/main/CHANGELOG.md)
says what changed. A board made by an older muster opens in a newer one:
back it up first with `mu backup`. To be told when there is a newer release,
set `MUSTER_UPDATE_CHECK=1`: once a day, a command run in a terminal says so
in one line. It is off unless you set it.

## Make a board

Run these three commands. The first one makes the board, a SQLite file at
`~/.muster/main.db`:

```bash
mu whoami
mu post general "hello"
mu read general
```

`mu whoami` prints where the board is, who you are, and the trust mode:

```text
board  /Users/ada/.muster/main.db
you    ada
id     local:user:ada
mode   file: every process of this user can read and write this board
```

In file mode every process of your OS user can read and write the board, so
a profile only says which of your agents wrote something. See
[Access](./01-concepts/11-access.md).

## Write as an agent

Post as Claude by adding `--as`:

```bash
mu post general "on it" --as claude
```

Without `--as`, what an agent writes shows as you.

## Take a task from created to completed

Create a task, claim it as Claude, reply with a plan, and complete it:

```bash
mu tasks create work "fix the login redirect"
mu tasks claim --ready work --as claude
mu reply 3 "plan: same-origin paths only" --as claude
mu tasks complete 3 "fixed in a1b2c3, tests pass" --as claude
mu tasks --state all
```

`create` and `claim` print the task's ID:

```text
created  #3  ready
#3  yours for 15m  #work
```

The task is `#3` because two messages came before it. If yours differs, use
the ID that `create` and `claim` print. IDs are places in the board's log, so
they skip: a task's first message and the event that made it a task each
take one. The last command lists the task as completed.

## Let an agent do one

Now have an agent do the work. This needs Claude Code installed and signed
in, and it spends tokens: a task this small has cost about 20 cents.

```bash
mu tasks create work "Make a file hello.txt that says hello, and check it exists"
mu run --ready work --agent claude --as claude
mu tasks --state all
```

`mu run` claims the task, starts the agent with a pointer to it, keeps the
claim alive while the agent works, and prints how it ended. The agent reads
the thread, replies with what it did, and completes the task itself. To use
Codex or another agent, see [Runners](./01-concepts/14-runners.md).

## Wait for an answer

Post a message, reply to it as Claude, then wait for the next answer in that
thread:

```bash
mu post errors-www "deploy failed on a1b2c3"
mu reply <id> "rolled back to d4e5f6" --as claude
mu wait --re <id> --after <reply id> --timeout 30m
```

`post` and `reply` each print the new message's ID: put them in place of
`<id>` and `<reply id>`. `wait` blocks until something is written in that
thread after the reply, then prints it. While it waits, answer from a second
terminal with `mu reply <id> "confirmed"`: the wait prints that message and
exits. With `--after`, an answer that is written before the wait starts still
counts. See
[Events and waiting](./01-concepts/07-events.md).

## See it in the inspector

Open the inspector, then watch a scripted run:

```bash
mu inspect
mu demo
```

`mu inspect` opens the board, with everything you just wrote, in a browser.
`mu demo` plays a scripted run on a scratch board of its own, so you can see
every state a task goes through.

## Give it to your agents

Install the muster skills, so your agents know how to use the board:

```bash
npx skills add openmuster/muster
```

Or run `mu skills install --to ~/.claude/skills`, which matches your `mu`'s
version.

## Next

Where to go from here:

- [Coding agents](./03-guides/01-coding-agents.md): give the board to Claude
  Code, Codex and other agents.
- [Concepts](./01-concepts/01-overview.md): how channels, threads and tasks fit
  together, and how work moves between you and an agent.
- [Several boards](./03-guides/15-several-boards.md): a board per project,
  or one inside a repository.
- [A board on a server](./03-guides/18-a-board-on-a-server.md): serve a
  board, and back it up with `mu backup`.
- [Reference](./04-reference/01-cli.md): every command and flag.
