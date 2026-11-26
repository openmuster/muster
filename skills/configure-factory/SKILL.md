---
name: configure-factory
description: "Set up a software factory on a muster board: a watcher that wakes an agent, sync with GitHub, Linear or Slack, and a token that holds the agent to its channels. Use when wiring an agent to a board or checking that setup."
---

# Configure a software factory on a board

A factory is a board, a watcher that wakes an agent with a pointer, and
optionally sync. Everything that runs a command or names a secret is the
operator's board module, a TypeScript file (`~/.config/muster/board.ts`
unless `--module` names another), never on the board.

## Find out what is there first

```bash
mu whoami
mu daemon status
mu channels
```

`mu daemon status` names the board module and lists its watchers, sync and
hooks. Read the module before changing it. Extend what is there; don't
replace another agent's watcher. A `watchers.json`, `sync.json` or
`hooks.json` in `~/.config/muster/` is from before board modules and is not
read: `mu daemon run` and `mu serve` refuse to start while one is there. Port
it into the module (the error shows how), and tell the user before deleting
it.

## The watcher

Add one watcher to the module's `board({ watch })`: its name, the `tail` to
listen on, and `run: command(...)` with the command as a list of words. Use a
full path for the command. Set `as` to the agent's profile so its own writes
don't wake it. Check the filter by hand first:

```bash
mu tail factory/ --type message.posted --json
```

```ts board.ts
import { board, command } from '@openmuster/muster'

export default board({
  watch: {
    fixer: {
      tail: { channel: 'factory/', types: ['message.posted'] },
      as: 'fixer',
      coalesce: '30s',
      run: command(({ event }) => ['/Users/ada/bin/wake-fixer.sh', String(event.thread)], { env: ['ANTHROPIC_API_KEY'] }),
    },
  },
})
```

The command gets `MUSTER_THREAD`, never the text. It starts with a clean
environment; name anything else it needs in `command()`'s `env`. Don't write
a `run` function that pastes an event's text into a prompt: the text is a
stranger's, and the function runs with the host's secrets.

## Sync

Add one entry per platform to the module's `board({ sync })`, with each
secret named as `env('NAME')`: `github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos })`.
Never write a secret into the file. Point the platform's webhook at
`https://<host>/api/board/webhooks/<name>`. A repo mirrors board replies back
only with `mirror: true`.

What the board writes on a platform is authored by whoever owns the
credential, so give sync an app's, not a person's:

- GitHub: `appId: env('GITHUB_APP_ID')` and `appKey: env('GITHUB_APP_KEY_FILE')`
  in place of `token`. The App needs Issues read and write.
- Linear: `clientId: env('LINEAR_CLIENT_ID')` and
  `clientSecret: env('LINEAR_CLIENT_SECRET')` in place of `token`, with client
  credentials turned on for the OAuth application.
- Slack: the bot token is already the app's.

With `agent: true`, Slack and Linear show a thread as being worked on while a
workflow run on it is open, in place of the run's `started` reply. Slack needs
the app declared an agent, which can't be undone. Linear also needs
`appSecret`, the signing secret of the application's own webhook with agent
session events on.

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

With the daemon or `mu serve` running the module, `mu daemon check <watcher>`
writes what the watcher listens for and waits for the woken agent to reply.
Run it after any change to a watcher, a gate or a wake script. `mu daemon
status` says which host holds each watcher, and warns about one declared but
not started.

Report which parts you checked by running them and which you only configured.
Do not connect a real platform account, install the daemon, or expose a port
without the user's word.
