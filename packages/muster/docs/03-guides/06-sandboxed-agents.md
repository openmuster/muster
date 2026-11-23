---
title: Agents in cloud sandboxes
description: Run an agent in Vercel Sandbox or a Cloudflare container without giving it the board's credential.
---

> [!WARNING]
> The Vercel runner has been run for real once, on one small task, with an
> earlier and looser policy. What this page says about closing the setup
> hosts, holding the model's host to its inference calls, and removing the
> sandbox has passed tests against a stand-in and has not been run in a real
> sandbox. The Cloudflare runner and its Worker in
> `templates/cloudflare-runner` have never been deployed. Treat both as
> experimental.

## What a sandbox needs

A sandbox can't open your board's file. It reaches the board over HTTP, so the
board must be served at an HTTPS address the sandbox can reach, and the agent
needs a token. A tunnel to your machine is enough to try it; to run it for
real, see [A board on a server](./18-a-board-on-a-server.md).

```bash
mu serve --allow-host board.example.com
mu token create --as fixer --can 'work/=read,post,react,label' --ttl 2h
```

## Start one

```bash
export MUSTER_URL=https://board.example.com/api/board
export MUSTER_TOKEN=mu1...          # yours: mu run reads the task and has a token made for the agent
mu run 12 --runner vercel --agent claude --as fixer --repo https://github.com/acme/web.git
mu run --ready work/ --runner cloudflare --agent codex --as worker-3
```

What runs in the sandbox is `mu run`
itself, as it runs on your machine: it claims the task, keeps the claim alive
while the agent works, fails the task if the agent leaves it open, and labels
it with the session, tokens and cost. With `--ready` the sandbox is a worker
that takes one task after another until none is ready.

On Vercel, `mu run` here stays with the run: it waits for the one in the
sandbox to exit, then closes the sandbox's way out and removes it, and says
how the task ended. Ctrl-C does the same, sooner. A dropped connection is
waited out, not taken for an exit. `--detach` starts the run and returns,
and the sandbox is left to its timeout, holding the agent's token in its
policy until then. On Cloudflare the command always returns once it starts.

One length of time sets the rest. `--timeout`, 30 minutes when you don't
pass one, is how long the agent works on the task. The sandbox lives ten
minutes longer, to install muster and settle the task, so it is `mu run` in
it that fails a task that ran out of time, never the platform cutting it off.
A `--ready` worker's sandbox lives two hours when you pass no `--timeout`,
and ends as soon as the worker finds no task. The agent's token lasts ten
minutes past the sandbox, and an attached run revokes it as soon as it ends.

Two tokens are in play. `MUSTER_TOKEN` is yours, for the `mu run` you type.
The sandbox's requests carry another, made for the agent: your own is never
passed on. Name the agent with `--as` and `mu run` has the board make one for
this run: that profile, the task's channel, a little longer than the run, and
marked so what it writes stays on the board. Or make one yourself and set
`MUSTER_AGENT_TOKEN`; `mu run` refuses one that isn't held to a profile and to
named channels, since whatever it may do, anything that steers the agent may
do too.

`--repo` takes an HTTPS clone address with no credential in it. A token in the
address would be readable by everything in the sandbox.

In a sandbox the agent runs without its own permission prompts: headless, a
prompt stops it at its first command, and the sandbox with its network policy
is the boundary. `--safe` keeps the prompts on.

Cloudflare also needs `MUSTER_CF_WORKER`, your Worker's URL, and
`MUSTER_CF_SECRET`. Vercel needs `@vercel/sandbox` installed.

## What is in the sandbox

The agent needs `mu` and its own CLI where it runs.

- **Vercel.** Each run installs the release of muster you are running, from
  its tarball on GitHub. GitHub's download hosts are open while that install
  runs and closed before the agent starts. `MUSTER_INSTALL` names another tarball or path to install.
  The agent's CLI has to be in the sandbox's image already.
- **Cloudflare.** A run's container has no internet and installs nothing. `mu`
  and the agent's CLI are in the image you build: the template's `Dockerfile`
  installs both.

## The model's key

The agent's laptop sign-in doesn't travel to a sandbox: it needs a key for its
model provider. Set it where you run `mu run`, in `ANTHROPIC_API_KEY` for
Claude Code or `OPENAI_API_KEY` for Codex.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
mu run 12 --runner vercel --agent claude
```

Like the board's token, the key stays out of the sandbox. Its environment
holds a placeholder, and the key is added on the way out, only to the calls
that ask the model (`POST /v1/messages` on `api.anthropic.com`;
`/v1/responses` and `/v1/chat/completions` on `api.openai.com`). Any other
request to that host is refused.

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
`VERCEL_OIDC_TOKEN`, from `vercel env pull`. Only some of the three is an
error. None of them enters the sandbox.

## Where the credential is

Not in the sandbox. The sandbox's environment holds the board's URL and a
placeholder. The token is added to each request after it leaves the sandbox,
by the platform's network policy on Vercel and by your Worker on Cloudflare.

The policy lets the sandbox reach:

- the board's host, the model provider's host when its key is set, and
  nothing else you didn't add. Each credential is sent only to the host it
  is for, whatever the request's own Host header says. A host you add is a way out of the sandbox
  for whatever the agent reads, so add few;
- on it, only the board's own routes, by method;
- not the routes that run the board: webhooks, tokens, schedules, budgets,
  schemas.

A path with dot segments or an encoded slash doesn't pass.

## What is left afterwards

Nothing, once `mu run` ends it. A Vercel sandbox is started so that it isn't
kept, and when the run exits or is stopped its way out is closed and the
sandbox is deleted, so it isn't left in Vercel's list either. A setup step
that fails ends it the same way. With `--detach`, or if this machine sleeps
through the run, it is stopped at its timeout instead, and stays listed as
stopped. A kept sandbox
would hold the repository, the agent's transcript and a policy with the
credentials in it.

On the board, a sandbox reaches a named list of routes: messages, tasks,
files and reads. It can't make schedules or schemas, set budgets, or move a
stored cursor. A file it stores needs a token that may post, and a narrowed
token has an allowance of 100 MB a day.

## From code

```ts runners.ts
import { claude, cloudflare, vercel } from 'muster'
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
