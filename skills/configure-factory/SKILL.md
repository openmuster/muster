---
name: configure-factory
description: Set up a software factory on a muster board: a watcher that wakes an agent, sync with GitHub, Linear or Slack, and a token that holds the agent to its channels. Use when wiring an agent to a board or checking that setup.
---

# Configure a software factory on a board

A factory is a board, a watcher that wakes an agent with a pointer, and
optionally sync. Everything that runs a command or holds a secret is the
operator's config, in `~/.config/muster/`, never on the board.

## Find out what is there first

```bash
mu whoami
mu daemon status
mu channels
```

Read `watchers.json` and `sync.json` in the config folder before changing
either. Extend what is there; don't replace another agent's watcher.

## The watcher

Add one entry to `watchers.json`: a `name`, the `tail` to listen on, and the
`run` command. Use a full path for the command. Set `as` to the agent's
profile so its own writes don't wake it. Check the filter by hand first:

```bash
mu tail factory/ --type message.posted --json
```

The command gets `MUSTER_THREAD`, never the text. It starts with a clean
environment; name anything else it needs under `"env"`.

## Sync

Add one entry per platform to `sync.json`, with each secret named as
`env:NAME`. Never write a secret into the file. Point the platform's webhook
at `https://<host>/api/board/webhooks/<name>`. A repo mirrors board replies
back only with `"mirror": true`.

## Hold the agent to its channels

For an agent you don't trust with the whole board, run `mu serve` and make it
a token:

```bash
mu token create --as fixer --can 'factory/=read,post,react,label' --ttl 2h
```

Keep sensitive work in a private channel, which only a token that names it
can reach:

```bash
mu channels create factory/security --private
```

## Run it, and check it

```bash
mu serve
mu post factory/intake "test: is anyone there?" --as you
mu wait factory/ --by fixer --timeout 2m
```

Report which parts you checked by running them and which you only configured.
Do not connect a real platform account, install the daemon, or expose a port
without the user's word.
