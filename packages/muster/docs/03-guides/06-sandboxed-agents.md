---
title: Agents in cloud sandboxes
description: For running agents off your machine, in Vercel Sandbox, a Cloudflare container or E2B. Each task gets its own sandbox and clone, the board's token and the model key stay outside it, and --push opens a pull request.
---

> [!WARNING]
> Experimental. The Vercel, Cloudflare and E2B runners have each worked real
> tasks from start to end, with `--push` opening a pull request. Not yet run
> live: a Cloudflare `--ready --loop` worker, dependency installs on
> Cloudflare, and an E2B you run yourself. Codex has run only on E2B.

## Who this is for

You want agents to work tasks somewhere other than your machine, each in a
sandbox of its own with its own clone of the repository. You end with
`mu run` starting them there, a worker that gives each ready task its own
sandbox, and a pull request for what each agent changed.

## Before you begin

You need:

- **A board at an HTTPS address the sandbox can reach.** A tunnel to your
  machine is enough to try it; to run it for real, see
  [A board on a server](./18-a-board-on-a-server.md).
- **One platform set up:** for Vercel, `@vercel/sandbox` installed and a way
  to sign in to Vercel ([On Vercel](#on-vercel)); for Cloudflare, your
  Worker's URL in `MUSTER_CF_WORKER` and its secret in `MUSTER_CF_SECRET`
  ([On Cloudflare](#on-cloudflare)); for E2B, the `e2b` package,
  `E2B_API_KEY` and a template ([On E2B](#on-e2b)).
- **A model key:** a key for the agent's model provider, set on this machine
  ([Give the agent a model key](#give-the-agent-a-model-key)).
- **For pull requests:** a GitHub App installed on the repository, and `git`
  on this machine ([Push what it changed](#push-what-it-changed)).

## Connect the sandbox to the board

### Serve the board where a sandbox can reach it

A sandbox can't open your board's file. It reaches the board over HTTP, so
serve the board at an HTTPS address, and make a token for the agent:

```bash
mu serve --allow-host board.example.com
mu token create --as fixer --can 'work/=read,post,react,label' --ttl 2h
```

When this machine has the board itself, set `MUSTER_SANDBOX_URL` to the
board's address for sandboxes, a tunnel's, say. `mu run` then reads and
claims on the board here, and the sandboxes reach it at that address.

### Choose the agent's token

Two tokens are in play:

- **`MUSTER_TOKEN` is yours,** for the `mu run` you type. It is never passed
  on to the sandbox.
- **The sandbox's requests carry another, made for the agent.** Name the
  agent with `--as` and `mu run` has the board make one for this run.

The token `mu run` makes is held to that
[profile](../01-concepts/06-actors.md) and to the task's channel. It lasts a
little longer than the run: 10 minutes past the sandbox, and an attached run
revokes it as soon as it ends. It is marked so that what it writes stays on
the board.

Or make one yourself and set `MUSTER_AGENT_TOKEN`. `mu run` refuses one that
isn't held to a profile and to named channels, because anything that steers
the agent can do whatever the token allows.

### Give the agent a model key

The agent's laptop sign-in isn't available in a sandbox: it needs a key for
its model provider. Set it where you run `mu run`, in `ANTHROPIC_API_KEY` for
Claude Code or `OPENAI_API_KEY` for Codex:

```bash
export ANTHROPIC_API_KEY=your_anthropic_api_key
mu run 12 --runner vercel --agent claude
```

Like the board's token, the key stays out of the sandbox. The sandbox's
environment holds a placeholder, and the key is added on the way out, only
to the calls that ask the model (`POST /v1/messages` on `api.anthropic.com`;
`/v1/responses` and `/v1/chat/completions` on `api.openai.com`). Any other
request to that host is refused. On E2B the key goes on every request to
that host, and `mu run` uses it only when you accept that: see
[On E2B](#on-e2b).

Without the variable, `mu run` warns and starts the agent anyway, which
works only if the sandbox's image has a sign-in of its own. Read
[What the model key can still do](#what-the-model-key-can-still-do) before
you pick a key.

## Run one task in a sandbox

### Start the agent

Set the board's address and your token, then name the task, the runner and
the agent:

```bash
export MUSTER_URL=https://board.example.com/api/board
export MUSTER_TOKEN=your_board_token  # yours: mu run reads the task and has a token made for the agent
mu run 12 --runner vercel --agent claude --as fixer --repo https://github.com/acme/web.git
mu run --ready work/ --runner cloudflare --agent claude --as worker-3
```

What runs in the sandbox is `mu run` itself, as it runs on your machine: it
[claims](../01-concepts/08-tasks.md#claims) the task and keeps the claim
alive while the agent works. It fails the task if the agent leaves it open,
and labels it with the session, tokens and cost.

`--repo` takes an HTTPS clone address with no credential in it. A token in
the address would be readable by everything in the sandbox.

With `--ready`, the second command above, the sandbox is a worker that takes
one task after another until none is ready. Without `--loop`, that is one
sandbox, or one container, sharing one checkout, so it can't `--push`. For a
sandbox per task, see
[Give each task its own sandbox](#give-each-task-its-own-sandbox).

In a sandbox the agent runs without its own permission prompts: headless, a
prompt stops it at its first command, and the sandbox with its network
policy is the boundary. `--safe` keeps the prompts on.

### Stay with the run, or detach

On Vercel, the `mu run` you typed stays with the run:

- **It waits for the `mu run` in the sandbox to exit,** then closes the
  sandbox to every host, removes it, and says how the task ended. Ctrl-C does
  the same, sooner.
- **It waits out a dropped connection** rather than taking it for an exit.
- **`--detach` starts the run and returns.** The sandbox is left to its
  timeout, with the agent's token in its network policy until then.

On Cloudflare the command returns once the run starts, unless it is a
`--push` run or a task of a `--ready --loop` worker. `mu run` waits on those
in the same way.

An E2B run can't be detached: see [On E2B](#on-e2b).

### Set how long it may run

`--timeout` is how long the agent works on the task, and it sets every other
length of time. Without it the agent gets 30 minutes, except on Cloudflare
without `--push` and outside a worker, where the Worker gives it an hour.

The sandbox lives 10 minutes longer than `--timeout`, to install muster and
settle the task. So `mu run` in the sandbox fails a task that ran out of
time, never the platform cutting it off.

A `--ready` worker's sandbox lives 2 hours when you pass no `--timeout`, and
ends as soon as the worker finds no task.

## Turn the run into a pull request

### Push what it changed

Give `mu run` a GitHub App and add `--push`:

```bash
export GITHUB_APP_ID=123456                     # your GitHub App, installed on the repository
export GITHUB_APP_KEY_FILE=~/.config/muster/app.pem
mu run 12 --runner vercel --agent claude --as fixer --repo https://github.com/acme/web.git --push
```

`--push` takes a GitHub App, not a personal token: install it on the
repository with Contents and Pull requests, read and write.
`GITHUB_APP_PRIVATE_KEY` can hold the key itself instead of a path. For each
run, `mu run` makes the App's tokens on this machine, each for this
repository alone and gone within the hour: one to read, for the clone, and
one to write, made when the push is. The App's key never leaves this
machine.

With `--push`, once the agent is done, `mu run`:

1. closes the sandbox to every host;
2. commits what the agent changed on top of where the checkout started, and
   reads it out as a git bundle;
3. pushes that from this machine to `mu/task-12`;
4. opens a pull request into the repository's default branch.

The pull request's address is on the task as a `pr` label and a reply. If
nothing changed, there's no pull request.

`--push` needs `mu run` to stay attached. It doesn't work with `--detach`,
nor with `--ready` without `--loop`, whose tasks would share one checkout.
On Cloudflare, a `--push` run is waited on, like a Vercel one, and the
Worker keeps the container for up to 15 minutes after the agent exits for
`mu run` to read; `mu run` removes it as soon as it has.

Without `--push`, `mu run` uses a GitHub App that is set to clone a private
repository, the same way, and pushes nothing. A public repository the App
isn't installed on is cloned without it.

### Another round on the same pull request

A task run again after it pushed, reopened with `mu tasks reopen 12 --round`
or answered after it blocked, continues from its branch. Before the sandbox
starts, `mu run` reads where `mu/task-12` is on GitHub and checks the
sandbox out there, so the agent's second round adds to the first, and the
push updates the same pull request. The agent is told which round it is.

- **The branch only moves forward from where the run found it.** A change
  that doesn't build on that commit, or a branch someone pushed to while the
  agent worked, isn't pushed: `mu run` reports `push_conflict` and leaves the
  branch as it was.
- **The board shows a change that wasn't pushed.** `mu run` gives the task a
  `push` label and a reply with why. It
  [blocks](../01-concepts/08-tasks.md#states) the tasks that wait on it, with
  the refusal as their kind (`push_conflict`, say), so a review never goes on
  from a change that isn't on the branch. Read the thread, then unblock them
  or run the task again.
- **A sandbox that didn't start on the branch starts no agent.** An older
  `@vercel/sandbox`, or a Cloudflare Worker deployed before it knew the
  branch, would clone the default branch instead: `mu run` stops the run
  with `runner_setup_failed` or `runner_too_old`.

## Run a worker that gives each task a sandbox

### Give each task its own sandbox

Add `--loop` to `--ready`, with `--push` for a pull request per task:

```bash
mu run --ready work/ --loop --runner vercel --agent claude --as worker-1 --repo https://github.com/acme/web.git --push
mu run --ready work/ --loop --runner cloudflare --agent claude --as worker-2 --repo https://github.com/acme/web.git --push
```

On each of the 3 clouds, `--ready` with `--loop` is a worker that stays on
this machine:

- **It claims the next ready task** as `worker-1`, under a claim token made
  for that task.
- **It runs the task as above, in a sandbox of its own,** which takes the
  same claim, so no other worker can have it. The sandbox holds the claim
  token for its one task.
- **Each task gets its own clone, its own token** and, with `--push`, its
  own pull request.
- **It then takes the next task,** until nothing is ready for `--wait`
  (10 minutes by default).

Start as many workers as you want running at once; the swarm template starts
one per agent.

The worker waits on each task's run and stops its sandbox or container once
the agent exits, before it claims the next task. So on Cloudflare the Worker
keeps none of them for its 15 minutes. When a run doesn't start, or ends
without saying how, the worker revokes the run's token and gives the claim
back, so the task is ready again. A worker stops at once when the runner
refuses a start, and after 3 failures in a row otherwise
(`runner_start_failed`).

## What you see

`mu run` says on the task how the run went:

- **Labels for the run:** the session, tokens and cost.
- **A `pr` label and a reply** with the pull request's address, after a
  `--push` run that changed something.
- **A `deps` label and a reply** when the repository's dependencies didn't
  install. The agent starts without them.
- **A `push` label and a reply** when a change wasn't pushed, with the tasks
  that wait on it blocked.

An attached run ends by saying how the task ended. A worker goes on until
nothing is ready.

## What each platform does

### On Vercel

The Vercel runner starts from `vercel/sandbox/universal`, which has Claude
Code, Codex, git, gh, npm, pnpm and bun. The agent's CLI has to be in the
sandbox's image already.

**Signing in to Vercel:** the runner signs in with an access token when
`VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` are all set.
Otherwise it uses a linked project's `VERCEL_OIDC_TOKEN` (an OpenID Connect
token), from `vercel env pull`. Setting only one or two of the three is an
error. None of them enters the sandbox.

**Installing muster:** each run installs the release of muster you are
running, from its tarball on GitHub. `MUSTER_INSTALL` names another tarball
or path to install.

**A base sandbox:** installing muster happens once per version, not per run:

- The first run makes a kept sandbox with muster installed and nothing else
  in it, no credential, repository or environment. Every run after is forked
  from it.
- Its name has a random part nobody can guess, and this machine writes it
  down in `~/.config/muster/vercel-bases.json`.
- A run forks only a base this machine made, and only one that stopped
  cleanly. So it never uses a sandbox someone else in the project made to
  look like one.
- A base for a newer muster removes the older ones this machine made there,
  and nothing else. `MUSTER_VERCEL_BASE=off` sets each run up from nothing.

**Your repository:** Vercel clones `--repo` into `/vercel/<name>` as the run
starts, or `git` in the sandbox does for a run forked from a base. Either way
it happens before any of the repository's code runs, and the agent starts
there. `mu run` then installs its dependencies the way its lockfile says
(pnpm, npm, yarn or bun, at the version `packageManager` pins). It runs no
install scripts, the dependencies' own included. `--no-install` skips it. A
failed install doesn't stop the run: the task gets a `deps` label and a reply
that says so, and the agent starts without them.

### On Cloudflare

A run's container has no internet. `mu` and the agent's CLI are in the image
you build: the template's `Dockerfile` installs both.

**Your repository:** `--repo` is cloned through the Worker. The Worker opens
that one repository's clone routes, adds the GitHub App's read token for a
private one, and closes GitHub again before any of the repository's code
runs.

**Dependencies:** they are installed with the same script as on Vercel, for
at most 3 minutes (less when the clone was slow). Meanwhile the Worker lets
the container read the public npm registry (`registry.npmjs.org`,
`registry.yarnpkg.com`, `repo.yarnpkg.com`) and nothing else there. Those
hosts are closed again before the agent starts. The image is built for pnpm,
npm and yarn; it has no bun. A private registry, a git dependency or a package
fetched from anywhere else fails the install. `--no-install`, the `deps`
label and the reply work as on Vercel.

**The container's life:** the Worker checks the run every minute. It removes
the container when the agent exits or `--timeout` has passed: without one,
an hour, or 30 minutes for a `--push` run or a worker's task.

**Its size:** each run gets a `standard-1` container (half a vCPU, 4 GiB);
set `INSTANCE` in the Worker's `wrangler.jsonc` for another size.
Cloudflare's default, `lite`, is too small for an agent's CLI.

### On E2B

Set your E2B key and template, then run as on the other platforms:

```bash
export E2B_API_KEY=your_e2b_api_key
export MUSTER_E2B_TEMPLATE=muster-agents      # built from templates/e2b-runner
mu run 12 --runner e2b --agent claude --as fixer --repo https://github.com/acme/web.git
```

E2B needs the `e2b` package where `mu` runs (`npm i e2b`) and a template with
your agent's CLI in it: `templates/e2b-runner` builds one. There is nothing
to deploy. Each run installs this release of muster in the sandbox, as on
Vercel, and `--repo`, `--push`, `--ready` and `--loop` work as above: the
repository is cloned into the home of the template's user. `E2B_DOMAIN` names
an E2B you run yourself.

**A base snapshot:** the first run keeps a snapshot of the template with this
release of muster installed, with no credential, repository or environment
in it, and every run after starts from it. Its ID is written down in
`~/.config/muster/e2b-bases.json`: a run starts only from a snapshot this
machine made. A newer muster makes another and removes the older one.
`MUSTER_E2B_BASE=off` sets each run up from nothing.

**How long a sandbox lives:** a sandbox lives an hour at most on E2B's Hobby
plan. `mu run` refuses a run that wouldn't fit, its `--timeout` and
10 minutes more, with `timeout_too_long`. A `--ready` worker with no
`--timeout` gets 50 minutes there. On a plan that allows more, set
`MUSTER_E2B_MAX_LIFETIME`, to `24h` say.

E2B's network rules are for a host. They can add a header to what goes to
it, and can't tell one path or method from another. Five things follow:

- **The board itself limits the agent's token to a sandbox's routes.** The
  token `mu run --as` has made is marked for a sandbox, and one you make
  needs `mu token create --sandbox`. The board then refuses that token
  access to schedules, cursors, workflow requests, the feed, MCP (Model
  Context Protocol) and the routes that take no token. `mu run` refuses a
  token without the mark before anything starts (`agent_token_unmarked`), and
  a token from a board older than this `mu` the same way. Give the board
  a hostname of its own: whatever else answers on that host is sent the
  token too.
- **A model key works on every path of its provider's host.** It isn't
  limited to the calls that ask the model, so `mu run` refuses to use one
  there (`model_key_unscoped`) until you set `MUSTER_E2B_KEY_ANY_PATH=1`. Use
  a key made for this alone: its own workspace and a spend limit.
- **Credentials are stored at E2B for the length of the run.** The board's
  token and the model's key are secrets in your E2B project, under random
  names, and E2B adds them to the sandbox's requests. They are made once the
  repository is cloned and its dependencies installed, and removed when the
  run ends. The clone's token is stored only while the clone runs, and is on
  every request to github.com for that time: it is one made to read that
  repository alone. Anyone with the project's `E2B_API_KEY` can attach a
  stored secret to a sandbox of their own, so use a project for this and
  nothing else.
- **An E2B run can't be detached** (`detach_unsupported`): its secrets are
  removed by the `mu run` that stays with it.
- **A run that is killed leaves its secrets.** The next `mu run --runner
  e2b` removes the ones older than 26 hours. The board's token has run out
  by then; a model key has not. After a run that didn't end cleanly, look in
  E2B's dashboard, or rotate the key.

`MUSTER_E2B_MODEL_SECRET=<name>` uses a secret you stored at E2B yourself as
the model's key: the key then never passes through `mu`, nothing reads it
from this machine, and `mu` never removes it. It also halves what a run
stores. A Hobby project holds 10 secrets and each run holds 2, so about
5 runs at once, or 9 with a secret of your own.

Before the agent starts, `mu run` runs `mu whoami` in the sandbox as the
agent. E2B sends a request without its credential when it can't find the
secret, and says nothing, so `mu run` stops a run whose agent couldn't reach
the board there (`runner_setup_failed`).

What E2B's network can't close is under
[On E2B's network](#on-e2bs-network).

## Start a runner from code

The runners are also functions in the package. This starts a task on
Cloudflare, with the Vercel call left commented out:

```ts runners.ts
import { claude, cloudflare, vercel } from '@openmuster/muster'
// import { Sandbox } from '@vercel/sandbox'

const board = { url: 'https://board.example.com/api/board', token: process.env.AGENT_TOKEN! }
const prompt = 'Claim task #12 first: mu tasks claim 12'

// await vercel({ Sandbox }).start({ task: 12, agent: claude, prompt, board })
await cloudflare({ worker: 'https://runner.example.workers.dev', secret: process.env.RUNNER_SECRET! }).start({ task: 12, agent: claude, prompt, board })
```

The sample does what `mu run` does to start a sandbox, without the rest:

- **`board`** is the board's address and the agent's token, read here from
  `AGENT_TOKEN`. Use a token made for the agent, as in
  [Choose the agent's token](#choose-the-agents-token).
- **`prompt`** is what the agent is told. Here it tells the agent to claim
  task 12 first.
- **The last line** starts Claude Code on task 12 in a container on your
  Worker, given the Worker's URL and its secret from `RUNNER_SECRET`.
- **The two commented lines** are the Vercel version: uncomment them, and
  leave out the `cloudflare` call, to start the same task in a Vercel
  sandbox.

## What keeps credentials out of the sandbox

### Where the credential is

Not in the sandbox. The sandbox's environment holds the board's URL and a
placeholder. The token is added to each request after it leaves the sandbox:
by the platform's network policy on Vercel, by your Worker on Cloudflare,
and by E2B from a secret stored there for the run.

### What the sandbox can reach

The policy lets the sandbox reach:

- the board's host, the model provider's host when its key is set, and
  nothing else you didn't add. Each credential is sent only to the host it
  is for, whatever the request's own Host header says. The agent can send
  whatever it reads to a host you add, so add few;
- on the board, only its own routes, by method: messages, tasks, files and
  reads;
- not the routes that run the board: webhooks, tokens, schedules, budgets,
  schemas.

A path with dot segments or an encoded slash doesn't pass. A sandbox can't
make schedules or schemas, set budgets, or move a stored cursor. A file it
stores needs a token that may post, and a narrowed token has an allowance of
100 MB a day.

On E2B the network opens hosts, not routes: the board refuses the other
routes itself, to a token made for a sandbox ([On E2B](#on-e2b)).

### Setting up holds no credential

A Vercel sandbox is made under a policy of its own for setting up, with
none of the credentials in it. It opens GitHub's hosts to clone and to
install muster, and every host while your repository's dependencies install,
since a lockfile can name any registry. Once set up, the agent's policy
replaces that one, and the agent starts with only the board and its model's
host open. Code that ran while setting up could reach the internet, but
there was nothing to take: the tokens only ever go on requests after that.

A Cloudflare container never has that: while dependencies install, the
registries are open to read and nothing else is, the board and the model's
host included. Once the install is done, the registries close, every process
it left running is killed, and only then do the board and the model's host
open again, for the agent.

A repository's own configuration still runs at install, scripts or not: a
`.pnpmfile.cjs`, a yarn plugin, an `.npmrc` pointing at a registry of its
choosing. That is the repository's code, like its tests, which the agent
runs anyway.

### What a push never exposes

- **No token is ever where the agent has been.** The read token is in the
  sandbox's policy only while the repository is cloned, before any of
  the repository's code runs, and only on its git fetch routes. The push is
  made here, from a repository made for it, and its branch is the one
  `mu run` names. So nothing the agent left behind, a hook, a process, a
  changed `git`, can use the token or pick what it writes.
- **What the agent left is data.** Git runs in the sandbox with no hooks, no
  fsmonitor and no global config, under a policy that reaches nothing, and
  all that comes out is the bundle, which becomes the branch.
- **`mu run` opens the pull request from your machine.** GitHub's API is
  never reachable from the sandbox.
- **On Cloudflare the Worker does the closing.** When it sees the agent
  exit, it shuts every host the run opened and kills whatever the agent left
  running, before anything is read. Only then does it run the bundle step and
  return the bundle, each with a time limit and a size limit.

The write token can write any branch of the repository for its hour, though
only this machine holds it, and `mu run` only ever pushes `mu/task-<id>`:
protect the branches that matter on GitHub all the same.

### What the model key can still do

> [!WARNING]
> The agent can't read the key, but it can still use it. A request that asks
> the model can also ask the provider to fetch a URL or call an outside
> server, and the policy sees addresses, not request bodies. So a steered
> agent could send what it has read out through the provider. Until muster
> filters those requests, use a key made for this: its own workspace, a spend
> limit, and the provider's web tools turned off.

### On E2B's network

E2B adds a credential only to requests for the host it is for: it connects
to that host itself, whatever address the sandbox dialled, and adds nothing
when the request's `Host` names another.

Closing a sandbox's network on E2B refuses new connections and leaves the
open ones open. So once a repository's dependencies are installed, with
every host open, `mu run` ends, as root, every process that wasn't running
before the repository was there. It does this before the agent's
credentials are stored, and stops a run where one couldn't be ended
(`runner_setup_failed`). It does the same after the agent exits, before a
`--push` reads its changes out.

This ends what an install left running; it is not a security boundary. Code
in an E2B sandbox can become root there, and code that is root could hide in
a process that was already running.

The sandbox can reach a Domain Name System (DNS) server whenever a host is
open to it, and code can send data out inside a lookup: E2B has no way to
close that and still resolve the hosts that are open. No credential is in
the sandbox to take, but a private repository's code is.

### What is left afterwards

Nothing is left once `mu run` ends the sandbox. A kept sandbox would hold the
repository, the agent's transcript and a policy with the credentials in it.

`mu run` starts a Vercel sandbox as one that isn't kept. When the run exits
or is stopped, `mu run` closes it to every host and deletes it, so it isn't
left in Vercel's list either. A setup step that fails ends it the same way.
With `--detach`, or if this machine sleeps through the run, Vercel stops it
at its timeout instead, and it stays listed as stopped.

An E2B sandbox is removed and the secrets stored for it are too; a run that
was killed leaves them until the next one removes them, as
[On E2B](#on-e2b) says.

### What it doesn't protect

Code from the repository runs in the sandbox and can use the board, as the
agent, for as long as the sandbox lives. Hold the token to the channels the
work needs, give it a short `--ttl`, and launch only on code you would run.

## When not to use a sandbox

- **On code you wouldn't run yourself:** the repository's code, its install
  configuration and its tests run in the sandbox, and can use the board as
  the agent.
- **When the agent needs its own sign-in:** a sandbox has no laptop
  sign-in, so run the agent on this machine instead, with
  [Running agents](./05-running-agents.md).
- **On E2B, with a private repository whose code must not leave:** code in
  the sandbox can send data out in a DNS lookup
  ([On E2B's network](#on-e2bs-network)).

## What goes wrong

- **A Cloudflare run's install says `failed (exit 127)`.** The repository
  has a `bun.lock`, and the Cloudflare image has no bun. The agent starts
  without its dependencies: see [On Cloudflare](#on-cloudflare).
- **The agent gets 401s from its model.** The model key didn't arrive: check
  the key's variable on this machine, or on E2B the secret
  ([Give the agent a model key](#give-the-agent-a-model-key)).
- **`runner_secrets_full` on E2B:** `mu run` reports a 409 from E2B this way:
  the project holds no more secrets. Wait for a run to end, or use
  `MUSTER_E2B_MODEL_SECRET` ([On E2B](#on-e2b)).
- **`runner_setup_failed` on E2B, before the agent starts:** the agent
  couldn't reach the board as itself, or a process from the install couldn't
  be ended ([On E2B](#on-e2b), [On E2B's network](#on-e2bs-network)).
- **`push_conflict`, and the tasks after it blocked:** the branch moved, or
  the change didn't build on it
  ([Another round on the same pull request](#another-round-on-the-same-pull-request)).
- **A worker stops with `runner_start_failed`.** The runner refused a start,
  or 3 starts failed in a row
  ([Give each task its own sandbox](#give-each-task-its-own-sandbox)).

## Related

- [Runners](../01-concepts/14-runners.md): what `mu run` does, and the
  runners side by side
- [Running agents](./05-running-agents.md): the same `mu run` on this machine
- [A board on a server](./18-a-board-on-a-server.md): a board a sandbox can
  reach, with tokens for agents
- [Tasks](../01-concepts/08-tasks.md): claims, states and rounds
