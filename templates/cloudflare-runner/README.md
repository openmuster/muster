# cloudflare-runner

A Worker that runs muster agents in Cloudflare containers. muster's
`cloudflare()` runner asks it to start and stop runs.

> [!WARNING]
> This template has not been deployed or run. It is written against
> Cloudflare's Containers documentation (outbound intercepts,
> `enableInternet: false`) and needs checking against the current API before
> use. It also needs a `wrangler.jsonc` with a container built from this
> folder's `Dockerfile` and a Durable Object binding named `RUNS` for the
> `Run` class.

How it keeps the board's token out of the container: the container starts
with no internet. The Worker intercepts requests to the board's host, checks
each against the rules muster sent (the board's own routes, by method), adds
the token, and forwards it. The container's environment holds a placeholder.

```bash
npx wrangler secret put RUNNER_SECRET    # what cloudflare({ secret }) sends: 16 characters or more
npx wrangler deploy
```

Whoever holds `RUNNER_SECRET` can start a container that runs a command of
their choosing, so make it long and random (`openssl rand -base64 32`). Until
one is set the Worker answers every request with an error and starts nothing.

The `Dockerfile` is the image a run starts from: Node, git, `mu` from its
release tarball, and Claude Code. They are installed once, when the image is
built; a run's container has no internet and installs nothing. It installs
one muster release and one version of the agent's CLI, by number, and the
build stops until you name the agent's:

```bash
docker build --build-arg AGENT_VERSION=<version> .   # npm view @anthropic-ai/claude-code version
```

`MUSTER_VERSION` and `AGENT_PACKAGE` are build arguments too: swap the agent's
CLI for the one you run.
