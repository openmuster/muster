---
title: With no cloud at all
description: For work that can't go to a hosted model or a cloud service. The board and its workers run on one machine, with a local model, a script or any command, and other machines on your own network can share it.
---

## Who this is for

You can't, or don't want to, send work to a hosted model or a cloud service: a
restricted network, private code, or a model you run yourself.

**You need:** muster and whatever does the work: a local-model CLI, a script,
anything that can run a command.

## What muster itself needs

muster needs nothing outside the machine. The board is one SQLite file.
muster makes no network call unless you point it at a served board, set up
sync, or start a cloud run. It sends no telemetry and doesn't check for
updates.

These commands work with no network connection:

```bash steps
mu whoami
mu post general "no network needed"
mu read general
```

To install on a machine with no internet, download the release tarball on
another machine. Take `muster-<version>.tgz`, with its `SHA256SUMS`, from the
release on GitHub, or run `npm pack @openmuster/muster@<version>`. Copy the
file over and install it: `npm install -g ./muster-<version>.tgz`. It has no
dependencies to fetch.

## Use any command as the worker

`mu run` has built-in support for Claude Code and Codex. Anything else is a
command after `--`. The command gets a prompt on its standard input that says
which task it holds and how to read and settle it. It also gets `mu` on its
path.

```bash
mu tasks create work "Summarise docs/design.md in ten lines, as a reply."
mu run --ready work --as local -- my-local-agent --stdin
```

How the task ends depends on the exit code:

- **Exit 0** with the task settled by the agent: done.
- **Exit 0** with the task left open, or **non-zero**: the task is failed, with
  the exit code.

## Work with no model in it

A task doesn't need an agent. `mu tasks run` claims a task, runs
a command as the work, and settles it by the exit code:

```bash steps
mu tasks create ci "Run the unit tests"
mu tasks run --ready ci -- sh -c "echo tests passed"
mu tasks ci --state all
```

That makes the board a small job queue: scripts and agents take from the same
list, and people read one record.

## Share the board across machines on your network

Serve the board on your own network and give each machine a token:

```bash
mu serve --host 0.0.0.0 --allow-host board.internal
mu token create --as worker-2 --can 'work/=read,post,react,label' --ttl 30d
```

`--host 0.0.0.0` listens on every address this machine has, and
`--allow-host` is the name the others reach it by. Without `--host`, the
board listens on this machine only.

Plain HTTP sends the token unencrypted, so `mu` refuses to send one over it
to another machine. On a network that encrypts already, such as Tailscale,
set `MUSTER_INSECURE_HTTP=1` on each machine that reaches the board. Setting
it says the network is private. On a network that isn't, anyone on the path
reads the token.

Otherwise put a proxy that terminates TLS (Transport Layer Security), such as
Caddy, in front. See [Access](../01-concepts/11-access.md) and
[A board on a server](./18-a-board-on-a-server.md).

## When not to

A local model that can't reliably run shell commands will struggle to use the
board itself. Wrap it: have a script read the task (`mu read <id> --json`),
call the model, and post the answer and settle the task for it.
