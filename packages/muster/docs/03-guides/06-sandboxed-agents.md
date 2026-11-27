---
title: Agents in cloud sandboxes
description: For running agents off your machine, in Vercel Sandbox, a Cloudflare container or E2B. Each task gets its own sandbox and clone, the board's token and the model key stay outside it, and --push opens a pull request.
---

> [!WARNING]
> Experimental. The Vercel, Cloudflare and E2B runners have each worked real
> tasks from start to end, with `--push` opening a pull request. Not yet run
> live: a Cloudflare `--ready --loop` worker, dependency installs on
> Cloudflare, and an E2B you run yourself. Codex has run only on E2B.

## What a sandbox needs

A sandbox can't open your board's file. It reaches the board over HTTP, so the
board must be served at an HTTPS address the sandbox can reach, and the agent
needs a token. A tunnel to your machine is enough to try it; to run it for
real, see [A board on a server](./18-a-board-on-a-server.md).

```bash
mu serve --allow-host board.example.com
mu token create --as fixer --can 'work/=read,post,react,label' --ttl 2h
```

## Start an agent in a sandbox

```bash
export MUSTER_URL=https://board.example.com/api/board
export MUSTER_TOKEN=your_board_token  # yours: mu run reads the task and has a token made for the agent
mu run 12 --runner vercel --agent claude --as fixer --repo https://github.com/acme/web.git
mu run --ready work/ --runner cloudflare --agent claude --as worker-3
```

What runs in the sandbox is `mu run` itself, as it runs on your machine: it
[claims](../01-concepts/08-tasks.md#claims) the task, keeps the claim alive
while the agent works, fails the task if the agent leaves it open, and labels
it with the session, tokens and cost. With `--ready` the sandbox is a worker
that takes one task after another until none is ready.

On Vercel, `mu run` here stays with the run. It waits for the one in the
sandbox to exit, then closes the sandbox to every host, removes it, and says
how the task ended. Ctrl-C does the same, sooner. `mu run` waits out a
dropped connection rather than taking it for an exit. `--detach` starts the
run and returns, and the sandbox is left to its timeout, with the agent's
token in its network policy until then.

On Cloudflare the command returns once the run starts, unless it is a
`--push` run or a task of a `--ready --loop` worker. `mu run` waits on those
in the same way.

`--timeout` sets every other length of time. It is how long the agent works
on the task: 30 minutes when you don't pass one, except on Cloudflare without
`--push` and outside a worker, where the Worker gives it an hour. The sandbox
lives 10 minutes longer, to install muster and settle the task. So `mu run`
in the sandbox fails a task that ran out of time, never the platform cutting
it off.

A `--ready` worker's sandbox lives 2 hours when you pass no `--timeout`, and
ends as soon as the worker finds no task. The agent's token lasts 10 minutes
past the sandbox, and an attached run revokes it as soon as it ends.

### A sandbox per task

```bash
mu run --ready work/ --loop --runner vercel --agent claude --as worker-1 --repo https://github.com/acme/web.git --push
mu run --ready work/ --loop --runner cloudflare --agent claude --as worker-2 --repo https://github.com/acme/web.git --push
```

On each of the 3 clouds, `--ready` with `--loop` is a worker that stays on
this machine. It claims the next ready task as `worker-1`, under a claim
token made for that task. It runs the task as above in a sandbox of its own,
which takes the same claim, so no other worker can have it. Each task gets
its own clone, its own token and, with `--push`, its own pull request.

The worker then takes the next task, until nothing is ready for `--wait`
(10 minutes by default). Start as many as you want running at once; the
swarm template starts one per agent. The sandbox holds the claim token for
its one task.

On Cloudflare each task's container is waited on and stopped once its agent
exits, before the next task is claimed, so the Worker keeps none of them for
its 15 minutes. A task whose run doesn't start, or ends without saying how,
is given back, ready, and its token revoked. A worker stops at once when the
runner refuses a start, and after 3 failures in a row otherwise
(`runner_start_failed`).

Without `--loop`, `--ready` is one sandbox, or one container, that takes
task after task itself, sharing one checkout, so it can't `--push`.

`MUSTER_SANDBOX_URL` is the board's address for sandboxes, when this machine
has the board itself: `mu run` then reads and claims on the board here, and
the sandboxes reach it at that address, a tunnel's, say.

Two tokens are in play. `MUSTER_TOKEN` is yours, for the `mu run` you type.
The sandbox's requests carry another, made for the agent: your own is never
passed on. Name the agent with `--as` and `mu run` has the board make one for
this run: that [profile](../01-concepts/06-actors.md), the task's channel, a
little longer than the run, and marked so what it writes stays on the board.
Or make one yourself and set `MUSTER_AGENT_TOKEN`. `mu run` refuses one that
isn't held to a profile and to named channels: anything that steers the
agent can do whatever the token allows.

`--repo` takes an HTTPS clone address with no credential in it. A token in the
address would be readable by everything in the sandbox.

In a sandbox the agent runs without its own permission prompts: headless, a
prompt stops it at its first command, and the sandbox with its network policy
is the boundary. `--safe` keeps the prompts on.

Cloudflare also needs `MUSTER_CF_WORKER`, your Worker's URL, and
`MUSTER_CF_SECRET`. Vercel needs `@vercel/sandbox` installed. E2B needs the
`e2b` package, `E2B_API_KEY` and a template: see [On E2B](#on-e2b).

## What is in the sandbox

The agent needs `mu` and its own CLI where it runs:

- **Vercel:** Each run installs the release of muster you are running, from
  its tarball on GitHub. `MUSTER_INSTALL` names another tarball or path to
  install. The agent's CLI has to be in the sandbox's image already:
  `vercel/sandbox/universal` has Claude Code, Codex, git, gh, npm, pnpm and
  bun.
- **A base on Vercel:** Installing muster happens once per version, not per
  run. The first run makes a kept sandbox with muster installed and nothing
  else in it, no credential, repository or environment, and every run after
  is forked from it. Its name has a random part nobody can guess, and this
  machine writes it down in `~/.config/muster/vercel-bases.json`. A run
  forks only a base this machine made, and only one that stopped cleanly, so
  it never uses a sandbox someone else in the project made to look like one.
  A base for a newer muster removes the older ones this machine made there,
  and nothing else. `MUSTER_VERCEL_BASE=off` sets each run up from nothing.
- **Your repository on Vercel:** `--repo` is cloned into `/vercel/<name>`
  as the run starts, before any of the repository's code runs, and the agent
  starts there. Its dependencies are installed the way its lockfile says
  (pnpm, npm, yarn or bun, at the version `packageManager` pins), with no
  install scripts, including the dependencies' own. `--no-install` skips
  it. A failed install doesn't stop the run: the task gets a `deps` label
  and a reply that says so, and the agent starts without them.
- **Cloudflare:** A run's container has no internet. `mu` and the agent's
  CLI are in the image you build: the template's `Dockerfile` installs both.
  `--repo` is cloned through the Worker, which opens that one repository's
  clone routes, adds the GitHub App's read token for a private one, and
  closes GitHub again before any of the repository's code runs. Its
  dependencies are then installed with the same script as on Vercel, for at
  most 3 minutes (less when the clone was slow). Meanwhile the Worker lets
  the container read the public npm registry (`registry.npmjs.org`,
  `registry.yarnpkg.com`, `repo.yarnpkg.com`) and nothing else there; those
  hosts are closed again before the agent starts. The image is built for
  pnpm, npm and yarn; it has no bun, so a `bun.lock` repository says
  `failed (exit 127)`. A private registry, a git dependency or a package
  fetched from anywhere else fails the install. `--no-install`, the `deps`
  label and the reply work as on Vercel. The Worker checks the run every
  minute and removes the container when the agent exits or `--timeout` has
  passed: without one, an hour, or 30 minutes for a `--push` run or a
  worker's task. Each run gets a `standard-1` container (half a vCPU,
  4 GiB); set `INSTANCE` in the Worker's `wrangler.jsonc` for another size.
  Cloudflare's default, `lite`, is too small for an agent's CLI.

### Push what it changed

```bash
export GITHUB_APP_ID=123456                     # your GitHub App, installed on the repository
export GITHUB_APP_KEY_FILE=~/.config/muster/app.pem
mu run 12 --runner vercel --agent claude --as fixer --repo https://github.com/acme/web.git --push
```

`--push` takes a GitHub App, not a personal token: install it on the
repository with Contents and Pull requests, read and write. For each run,
`mu run` makes the App's tokens on this machine, each for this repository
alone and gone within the hour: one to read, for the clone, and one to
write, made when the push is. The App's key never leaves this machine.
`GITHUB_APP_PRIVATE_KEY` can hold the key itself instead of a path.

With `--push`, once the agent is done, `mu run` closes the sandbox to every
host, commits what the agent changed on top of where the checkout started,
and reads it out as a git bundle. It pushes that from this machine to
`mu/task-12`, and opens a pull request into the repository's default
branch. The pull request's address is on the task as a `pr` label and a
reply. Nothing changed, no pull request.

### Another round on the same pull request

A task run again after it pushed, reopened with `mu tasks reopen 12 --round`
or answered after it blocked, continues from its branch. Before the sandbox
starts, `mu run` reads where `mu/task-12` is on GitHub and checks the
sandbox out there, so the agent's second round adds to the first, and the
push updates the same pull request. The agent is told which round it is.

- **The branch only moves forward from where the run found it.** A change
  that doesn't build on that commit, or a branch someone pushed to while the
  agent worked, is refused with `push_conflict`, and the branch is left as
  it was.
- **The board shows a change that wasn't pushed.** The task gets a `push`
  label and a reply with why. The tasks that wait on it are
  [blocked](../01-concepts/08-tasks.md#states) with the same kind, `push`,
  so a review never goes on from a change that isn't on the branch. Read
  the thread, then unblock them or run the task again.
- **A sandbox that didn't start on the branch starts no agent.** An older
  `@vercel/sandbox`, or a Cloudflare Worker deployed before it knew the
  branch, would clone the default branch instead: the run is stopped with
  `runner_setup_failed` or `runner_too_old`.
- **No token is ever where the agent has been.** The read token is in the
  sandbox's policy only while Vercel clones the repository, before any of
  the repository's code runs, and only on its git fetch routes. The push is
  made here, from a repository made for it, and its branch is the one
  `mu run` names. So nothing the agent left behind, a hook, a process, a
  changed `git`, can use the token or pick what it writes.
- **What the agent left is data.** Git runs in the sandbox with no hooks, no
  fsmonitor and no global config, under a policy that reaches nothing, and
  all that comes out is the bundle, which becomes the branch.
- **`mu run` opens the pull request from your machine.** GitHub's API is
  never reachable from the sandbox.
- **It needs `mu run` to stay attached.** It doesn't work with `--detach`,
  nor with `--ready`, whose tasks would share one checkout. It needs `git` on
  this machine.
- **On Cloudflare the Worker does the closing.** When it sees the agent
  exit, it shuts every host the run opened and kills whatever the agent left
  running, before anything is read. Only then does it run the bundle step and
  return the bundle, each with a time limit and a size limit. With
  `--push`, a Cloudflare run is waited on, like a Vercel one, and the
  container is kept for up to 15 minutes after the agent exits for `mu run`
  to read; `mu run` removes it as soon as it has. A Cloudflare run without
  `--push` still returns once it starts, unless it is a worker's task.
- **Without `--push`, the App only clones.** `mu run` uses a GitHub App
  that is set to clone a private repository, the same way, and pushes
  nothing. A public repository the
  App isn't installed on is cloned without it.

The write token can write any branch of the repository for its hour, though
only this machine holds it, and `mu run` only ever pushes `mu/task-<id>`:
protect the branches that matter on GitHub all the same.

### Setting up holds no credential

A Vercel sandbox is made under a policy of its own for setting up, with
none of the credentials in it: GitHub's hosts to clone and to install
muster, and every host while your repository's dependencies install, since a
lockfile can name any registry. Once set up, that policy is replaced by the
agent's, and the agent starts with only the board and its model's host open.
Code that ran while setting up could reach the internet, but there was
nothing to take: the tokens only ever go on requests after that.

A Cloudflare container never has that: while dependencies install, the
registries are open to read and nothing else is, the board and the model's
host included. Once the install is done, the registries close, every process
it left running is killed, and only then do the board and the model's host
open again, for the agent.

A repository's own configuration still runs at install, scripts or not: a
`.pnpmfile.cjs`, a yarn plugin, an `.npmrc` pointing at a registry of its
choosing. That is the repository's code, like its tests, which the agent
runs anyway: launch only on code you would run.

## On E2B

```bash
export E2B_API_KEY=your_e2b_api_key
export MUSTER_E2B_TEMPLATE=muster-agents      # built from templates/e2b-runner
mu run 12 --runner e2b --agent claude --as fixer --repo https://github.com/acme/web.git
```

E2B needs the `e2b` package where `mu` runs (`npm i e2b`) and a template with
your agent's CLI in it: `templates/e2b-runner` builds one. There is nothing to
deploy. Each run installs this release of muster in the sandbox, as on Vercel,
and `--repo`, `--push`, `--ready` and `--loop` work as above: the repository is
cloned into the home of the template's user. `E2B_DOMAIN` names an E2B you
run yourself.

E2B's network rules are for a host. They can add a header to what goes to
it, and can't tell one path or method from another. Five things follow:

- **The board itself limits the agent's token to a sandbox's routes.** The
  token `mu run --as` has made is marked for a sandbox, and one you make
  needs `mu token create --sandbox`. The board then refuses that token
  access to schedules, cursors, workflow requests, the feed, MCP (Model Context
  Protocol) and the routes that take no token. A token without the mark is
  refused before anything starts (`agent_token_unmarked`); so is one from a
  board older than this `mu`.
  Give the board a hostname of its own: whatever else answers on that host
  is sent the token too.
- **A model key works on every path of its provider's host.** It isn't
  limited to the calls that ask the model, so `mu run` refuses to use one there
  (`model_key_unscoped`) until you set `MUSTER_E2B_KEY_ANY_PATH=1`. Use a key
  made for this alone: its own workspace and a spend limit.
- **Credentials are stored at E2B for the length of the run.** The board's
  token and the model's key are secrets in your E2B project, under random
  names, and E2B adds them to the sandbox's requests. They are made once the
  repository is cloned and its dependencies installed, and removed when the
  run ends. The clone's token is stored only while the clone runs, and is
  on every request to github.com for that time: it is one made to read that
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
5 runs at once, or 9 with a secret of your own. `mu run` reports a 409 from
E2B as `runner_secrets_full`.

A sandbox lives an hour at most on E2B's Hobby plan. A run that wouldn't
fit, its `--timeout` and 10 minutes more, is refused with
`timeout_too_long`, and a `--ready` worker with no `--timeout` gets 50
minutes there. On a plan that allows more, set `MUSTER_E2B_MAX_LIFETIME`, to
`24h` say.

Before the agent starts, `mu run` runs `mu whoami` in the sandbox as the
agent. E2B
sends a request without its credential when it can't find the secret, and
says nothing, so a run whose agent couldn't reach the board is stopped there
(`runner_setup_failed`). A model key that didn't arrive shows as the agent's
own 401s.

Closing a sandbox's network on E2B refuses new connections and leaves the
open ones open. So once a repository's dependencies are installed, with
every host open, `mu run` ends, as root, every process that wasn't running
before the repository was there. It does this before the agent's
credentials are stored, and stops a run where one couldn't be ended
(`runner_setup_failed`). It does the same after the agent exits, before a
`--push` reads its changes out.

This ends what an install left running; it is not a security boundary. Code
in an E2B sandbox can become root there, and code that is root could hide in
a process that was already running. As everywhere: launch only on code you
would run.

E2B adds a credential only to requests for the host it is for: it connects
to that host itself, whatever address the sandbox dialled, and adds nothing
when the request's `Host` names another.

The first run keeps a snapshot of the template with this release of muster
installed, with no credential, repository or environment in it, and every
run after starts from it. Its ID is written down in
`~/.config/muster/e2b-bases.json`: a run starts only from a snapshot this
machine made. A newer muster makes another and removes the older one.
`MUSTER_E2B_BASE=off` sets each run up from nothing.

The sandbox can reach a Domain Name System (DNS) server whenever a host is
open to it, and code can send data out inside a lookup: E2B has no way to
close that and still resolve the hosts that are open. No credential is in
the sandbox to take, but a private repository's code is.

## The model's key

The agent's laptop sign-in isn't available in a sandbox: it needs a key for its
model provider. Set it where you run `mu run`, in `ANTHROPIC_API_KEY` for
Claude Code or `OPENAI_API_KEY` for Codex.

```bash
export ANTHROPIC_API_KEY=your_anthropic_api_key
mu run 12 --runner vercel --agent claude
```

Like the board's token, the key stays out of the sandbox. Its environment
holds a placeholder, and the key is added on the way out, only to the calls
that ask the model (`POST /v1/messages` on `api.anthropic.com`;
`/v1/responses` and `/v1/chat/completions` on `api.openai.com`). Any other
request to that host is refused. On E2B the key goes on every request to
that host, and is used only when you accept that: see [On E2B](#on-e2b).

> [!WARNING]
> The agent can't read the key, but it can still use it. A request that asks
> the model can also ask the provider to fetch a URL or call an outside
> server, and the policy sees addresses, not request bodies. So a steered
> agent could send what it has read out through the provider. Until muster
> filters those requests, use a key made for this: its own workspace, a spend
> limit, and the provider's web tools turned off.

Without the variable, `mu run` warns and starts the agent anyway, which works
only if the sandbox's image has a sign-in of its own.

The Vercel runner starts from `vercel/sandbox/universal`. It signs in to
Vercel with an access token when `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
`VERCEL_PROJECT_ID` are all set, and otherwise with a linked project's
`VERCEL_OIDC_TOKEN`, from `vercel env pull`. Setting only one or two of the
three is an error. None of them enters the sandbox.

## Where the credential is

Not in the sandbox. The sandbox's environment holds the board's URL and a
placeholder. The token is added to each request after it leaves the sandbox,
by the platform's network policy on Vercel, by your Worker on Cloudflare,
and by E2B from a secret stored there for the run.

The policy lets the sandbox reach:

- the board's host, the model provider's host when its key is set, and
  nothing else you didn't add. Each credential is sent only to the host it
  is for, whatever the request's own Host header says. The agent can send
  whatever it reads to a host you add, so add few;
- on it, only the board's own routes, by method;
- not the routes that run the board: webhooks, tokens, schedules, budgets,
  schemas.

A path with dot segments or an encoded slash doesn't pass.

On E2B the network opens hosts, not routes: the board refuses the other
routes itself, to a token made for a sandbox.

## What is left afterwards

Nothing is left once `mu run` ends the sandbox. An E2B sandbox is removed
and the secrets stored for it are too; a run that was killed leaves them
until the next one removes them, as [On E2B](#on-e2b) says. A kept sandbox
would hold the repository, the agent's transcript and a policy with the
credentials in it.

`mu run` starts a Vercel sandbox as one that isn't kept. When the run exits
or is stopped, `mu run` closes it to every host and deletes it, so it isn't
left in Vercel's list either. A setup step that fails ends it the same way.
With `--detach`, or if this machine sleeps through the run, it is stopped at
its timeout instead, and stays listed as stopped.

On the board, a sandbox reaches a named list of routes: messages, tasks,
files and reads. It can't make schedules or schemas, set budgets, or move a
stored cursor. A file it stores needs a token that may post, and a narrowed
token has an allowance of 100 MB a day.

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

## What it doesn't protect

Code from the repository runs in the sandbox and can use the board, as the
agent, for as long as the sandbox lives. Hold the token to the channels the
work needs, give it a short `--ttl`, and launch only on code you would run.
