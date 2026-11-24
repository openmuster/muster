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
token added there, then closed before anything of the repository runs.

When the CLI asks for its dependencies (`mu run --repo`, unless
`--no-install`), it sends the install script, and the Worker runs it in the
checkout. Only then are `registry.npmjs.org`,
`registry.yarnpkg.com` and `repo.yarnpkg.com` opened, for reading (`GET` and
`HEAD`), with nothing added, and the board's and the model's hosts are
closed: the install runs the repository's own code (a pnpmfile, a yarn
plugin). After it the registries are closed, every process it left running
is killed, the exit file it may have written is removed, and only then do the
board and the model get their gates back and the agent start. Until the agent
has started, that exit file means nothing. A run where any of that fails, or
that was stopped or timed out meanwhile, ends there and nothing is opened
again. A failed install doesn't stop the run: start answers `installed` with
`failed (exit n)`, and the agent starts without them.

The CLI waits for start's answer, and Node's fetch gives up after 5 minutes
without one, which would leave a run nobody can stop. So start keeps to 4
minutes: the clone gets what is left of them, and the install what is left
after the clone, 3 minutes at most. With less than 15 seconds left it doesn't
start, and says `failed (timeout)`. The image runs pnpm (through corepack, at the
version `packageManager` pins), npm and yarn; it has no bun. Covered by
tests of the gate, the order of these steps and the CLI, not run live. A Worker deployed before this
ignores the script and installs nothing: redeploy it and rebuild the image.

Each run is a Durable Object. It checks the run every minute, which keeps the
container alive, and removes the container when the agent exits or the run's
time is up. Why a run ended and its exit code go to the Worker's logs
(`wrangler tail`), and nothing the run printed: that can be anything the agent
read. To see why a run failed, set the `LOG_TAIL` variable to `"1"` in
`wrangler.jsonc` and deploy: the last 2000 bytes each run prints are then
logged too, and kept by Cloudflare as long as your logs are. Per-request logs
are off (`invocation_logs`), since every request carries the runner's secret.

A run started with `attach` (`mu run --push`) is kept after its agent exits,
for up to 15 minutes, so `mu run` can read what it changed. Each route takes
the run's ID:

| Route | What it does |
| --- | --- |
| `GET /runs/:id` | `running` or `exited`, with the exit code; 404 once it has ended |
| `POST /runs/:id/close` | Closes every host the run opened. The agent's exit already did this, and stopped what it left running |
| `POST /runs/:id/exec` | Runs one command in the checkout, after exit and close only, with a time limit and the first 64 KiB of its output |
| `GET /runs/:id/file?path=&max=` | A regular file no bigger than `max`, after exit and close only |
| `POST /runs/:id/stop` | Removes the container |

Give a deploy a minute before a `--push` run: for a short while after it,
Cloudflare can still send a run's requests to the previous version of the
Worker, which may not have these routes.

```bash
npx wrangler secret put RUNNER_SECRET    # what cloudflare({ secret }) sends: 16 characters or more
npx wrangler deploy
```

Whoever holds `RUNNER_SECRET` can start a container that runs a command of
their choosing, so make it long and random (`openssl rand -base64 32`). Until
one is set the Worker answers every request with an error and starts nothing.

The `Dockerfile` is the image a run starts from: Node, git, `mu` from its
release tarball, and Claude Code. They are installed once, when the image is
built; a run's container has no internet, and the only thing it installs is
the repository's dependencies, from the npm registry. It installs
one muster release and one version of the agent's CLI, by number, and the
build stops until you name the agent's:

```bash
docker build --build-arg AGENT_VERSION=<version> .   # npm view @anthropic-ai/claude-code version
```

`MUSTER_VERSION` (with `MUSTER_SHA256`, its tarball's checksum from that release's `SHA256SUMS`) and `AGENT_PACKAGE` are build arguments too: swap the agent's
CLI for the one you run.
