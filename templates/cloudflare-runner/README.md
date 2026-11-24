# cloudflare-runner

A Worker that runs muster agents in Cloudflare containers. muster's
`cloudflare()` runner asks it to start and stop runs.

> [!WARNING]
> Deployed and run on 24 Nov 2026, with the `durable_object` scheduling policy
> (in beta at Cloudflare): Claude Code fixed a bug in a private repository in
> it, from start to end. Needs a Workers Paid account, for Containers.

`wrangler.jsonc` builds the container from this folder's `Dockerfile` and
binds the `Run` Durable Object as `RUNS`. Set the agent's version in its
`build_vars`, and the container's size in `vars.INSTANCE`: `standard-1` (half
a vCPU, 4 GiB) by default. Cloudflare's own default, `lite` (256 MiB), is too
small for an agent's CLI, which stalls in it without failing.

How it keeps the board's token out of the container: the container starts
with no internet. The Worker intercepts requests to the board's host, checks
each against the rules muster sent (the board's own routes, by method), adds
the token, and forwards it. The container's environment holds a placeholder.
The model's host gets the same treatment, with the key added only to the calls
that ask the model. With `--repo`, the repository's host is opened only for
that repository's clone routes while it is cloned, with a private one's read
token added there, then closed before the agent starts.

Each run is a Durable Object. It checks the run every minute, which keeps the
container alive, and removes the container when the agent exits or the run's
time is up. The tail of the agent's output goes to the Worker's logs
(`wrangler tail`).

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
