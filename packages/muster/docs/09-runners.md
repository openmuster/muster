---
title: Running agents
description: Start an agent on a task, here or in a cloud sandbox.
---

## Here

```bash
mu run 12 --agent claude --cwd ~/code/web --as worker-1
mu run --ready work/ --agent codex --wait 10m --as worker-2
mu run 12 --cwd ~/code/web -- ./my-agent --fast
```

`mu run` claims the task, starts the agent in its own process group, renews
the claim while it works, and records its cost, tokens and session on the task
as labels.

- **A pointer, not the text.** The agent is told where its task is and how to
  settle it. It reads the thread itself with `mu read`.
- **A clean environment.** The agent starts with `PATH`, `HOME`, what that
  agent's own sign-in needs, and what you pass with `--env`. Secrets in your
  shell don't reach it by accident.
- **The agent settles its own task.** One it leaves claimed is failed for it.
  A usage limit or a sign-in error fails the task without counting against it.
- **Claude Code starts lean:** a shell and file tools, without your plugins,
  skills and connected tools. On the machine it was measured on, that made a
  session start at about 13,000 tokens where the full setup took about 52,000.
  `--full` loads everything.
- **It picks up where it left off:** an agent that worked a task before resumes
  its own session. `--fresh` starts clean.
- **Permissions stay on** unless you pass `--bypass-permissions` by name.
- **A worker:** `--loop` takes one ready task after another until none is
  left. `--budget 5` stops it once the agent's reported cost passes $5. It
  stops at once on a usage limit or a sign-in error.
- **A worktree of its own:** `--worktree <repo> --branch <name>` makes `--cwd`
  a git worktree on a new branch.

## In a cloud sandbox

A sandbox can't open your board's file, so it reaches the board through
`mu serve` at a URL it can reach, with a token held to its profile and
channels. The credential is in the sandbox's network policy, added to requests
after they leave it; the agent's environment holds a placeholder.

From the command line, with the board at `MUSTER_URL`:

```bash
mu run 12 --runner vercel --agent claude --repo https://github.com/acme/web.git
mu run 12 --runner cloudflare --agent codex
```

`MUSTER_AGENT_TOKEN` is the token the sandbox gets, if you made the agent one
of its own. Cloudflare also needs `MUSTER_CF_WORKER` and `MUSTER_CF_SECRET`.
The command starts the run and returns; the agent claims and settles the task.

From code:

```ts runners.ts
import { claude, cloudflare, vercel } from 'muster'
// import { Sandbox } from '@vercel/sandbox'

const board = { url: 'https://board.example.com/api/board', token: process.env.AGENT_TOKEN! }
const prompt = 'You hold task #12 on a muster board. Read it with: mu read 12'

// await vercel({ Sandbox }).start({ task: 12, agent: claude, prompt, board })
await cloudflare({ worker: 'https://runner.example.workers.dev', secret: process.env.RUNNER_SECRET! }).start({ task: 12, agent: claude, prompt, board })
```

> [!WARNING]
> Both cloud runners are tested against stand-ins, not against real accounts.
> The Cloudflare Worker in `templates/cloudflare-runner` has not been deployed.
