# factory

An agent that hears what happens on a board and answers what is for it:
issues, pull requests and chat come in by sync, a watcher wakes the agent with
a pointer to the thread, and the agent reads the thread and decides.

It is configuration for muster's own daemon, plus a small page: `pnpm dev`
shows what is set up and what isn't, the week's threads, and at `/board` every
thread, where you read and reply from a browser.

| File | What it is |
| --- | --- |
| `watchers.json` | Wake the agent on new activity under `factory/` |
| `sync.json` | GitHub issues and pull requests into `factory/` channels |
| `wake.sh` | Starts one agent session on one thread |
| `AGENT.md` | What the agent is told about working with people |

```bash
cp watchers.json sync.json ~/.config/muster/
# then edit watchers.json: make "./wake.sh" the full path of wake.sh in this folder
export GITHUB_WEBHOOK_SECRET=...        # named in sync.json, never written there
mu serve --allow-host <your host>        # takes the webhooks and runs the watcher
```

Point the GitHub App's webhook at `https://<your host>/api/board/webhooks/gh`.
`mu serve` listens on 127.0.0.1, so it needs a tunnel or a proxy with a public
HTTPS name, passed with `--allow-host <name>`.

As shipped, `sync.json` brings issues and pull requests in and sends nothing
back. For the agent's replies to be posted as comments, add
`"token": "env:GITHUB_TOKEN"` beside `secret` and `"mirror": true` to the
repository. Sync has not been run against GitHub yet.

The page has no sign-in, and its reply form writes as you: whoever can reach
it can. `pnpm dev` listens on 127.0.0.1 only, so that is this machine.

A watcher's command starts with a clean environment: `PATH`, `HOME`, and the
board's own variables. It does not get the secrets `sync.json` names. To pass
something on, list its name under `"env"` in the watcher.

Edit `wake.sh` to start your agent. As shipped it runs Claude Code headless in
the current folder with the pointer prompt; the agent's instructions are
`AGENT.md`.

## Outside this repository

Here the app uses the `muster` in this checkout (`workspace:*`). In a copy of
your own, point the dependency at a release instead:

```json
"muster": "https://github.com/openmuster/muster/releases/download/v0.2.0/muster-0.2.0.tgz"
```

## In a Vercel sandbox

By default `wake.sh` starts the agent on this machine. With
`FACTORY_RUNNER=vercel` each wake runs in a Vercel sandbox instead: the wake
becomes a task in `factory-runs` (outside `factory/`, so it wakes nothing),
and `mu run --runner vercel` works it there, with a token for `factory/` and
`factory-runs` that lasts an hour. `FACTORY_REPO` clones a repository into
the sandbox and installs its dependencies; `FACTORY_PUSH=1` opens a pull
request with what the agent changed, through your GitHub App. The daemon
then needs the board at a URL sandboxes reach (`MUSTER_URL`, or
`MUSTER_SANDBOX_URL`) and what `mu run --runner vercel` reads. See muster's
guide, Agents in cloud sandboxes.

In a sandbox the agent can't reach your machine, and it reaches no host but
the board and its model: it can read code, run tests and answer, not run
your app against your services.

